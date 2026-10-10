import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  MAX_CAPTURE_BYTES,
  RequestStore,
  decodeChunked,
  parseRequestHead,
  parseResponseHead,
  startInspectorServer
} from "../src/index.ts";
import type { InspectorMessage } from "../src/index.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REQUEST = Buffer.from("POST /api/items?x=1 HTTP/1.1\r\nHost: demo.localhost\r\nContent-Length: 7\r\nConnection: close\r\n\r\n{\"a\":1}");
const RESPONSE = Buffer.from("HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n");

function record(store: RequestStore, request = REQUEST, response = RESPONSE): void {
  const observer = store.observe(1);
  // Deliver in awkward pieces, as frames would.
  observer.request(request.subarray(0, 10));
  observer.request(request.subarray(10));
  observer.response(response.subarray(0, 5));
  observer.response(response.subarray(5));
  observer.end();
}

async function startLocalApp(): Promise<number> {
  const app = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => res.end(`replayed ${req.method} ${req.url} ${body}`));
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    app.closeAllConnections();
    app.close();
  });
  return (app.address() as AddressInfo).port;
}

describe("parse", () => {
  it("parses request and response heads only once complete", () => {
    expect(parseRequestHead(REQUEST.subarray(0, 20))).toBeNull();
    const request = parseRequestHead(REQUEST)!;
    expect(request).toMatchObject({ method: "POST", path: "/api/items?x=1", version: "HTTP/1.1" });
    expect(REQUEST.subarray(request.bodyOffset).toString()).toBe('{"a":1}');

    const response = parseResponseHead(RESPONSE)!;
    expect(response).toMatchObject({ status: 201, statusText: "Created" });
    expect(response.headers).toContainEqual(["Content-Type", "application/json"]);
  });

  it("rejects malformed heads", () => {
    expect(parseRequestHead(Buffer.from("garbage\r\n\r\n"))).toBeNull();
    expect(parseResponseHead(Buffer.from("HTTP/1.1 abc\r\n\r\n"))).toBeNull();
  });

  it("decodes chunked bodies", () => {
    expect(decodeChunked(Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"))!.toString()).toBe("hello world");
    expect(decodeChunked(Buffer.from("5\r\nhel"))).toBeNull();
  });
});

describe("RequestStore", () => {
  it("records method, path, status, timing and bodies", () => {
    let now = 1000;
    const store = new RequestStore({ now: () => now });
    const observer = store.observe(7);
    observer.request(REQUEST);
    now = 1012;
    observer.response(RESPONSE);
    now = 1030;
    observer.end();

    const [summary] = store.list();
    expect(summary).toMatchObject({
      streamId: 7,
      method: "POST",
      path: "/api/items?x=1",
      status: 201,
      state: "complete",
      ttfbMs: 12,
      durationMs: 30,
      requestBytes: REQUEST.length,
      responseBytes: RESPONSE.length,
      replayable: true
    });
    const detail = store.get(summary!.id)!;
    expect(detail.requestBody.text).toBe('{"a":1}');
    expect(detail.responseBody.text).toBe('{"ok":1}\n');
  });

  it("emits upserts as a request progresses", () => {
    const store = new RequestStore();
    const states: string[] = [];
    store.on("upsert", (s: { state: string; method: string | null }) => states.push(`${s.state}:${s.method}`));
    record(store);
    expect(states[0]).toBe("pending:null");
    expect(states.at(-1)).toBe("complete:POST");
  });

  it("shows chunked responses decoded and binary bodies as binary", () => {
    const store = new RequestStore();
    record(store, REQUEST, Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n"));
    expect(store.get(1)!.responseBody.text).toBe("abc");

    record(store, REQUEST, Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), Buffer.from([0, 1, 2])]));
    expect(store.get(2)!.responseBody).toMatchObject({ binary: true, text: null, size: 3 });
  });

  it("marks requests over 1 MB as not replayable", () => {
    const store = new RequestStore();
    const observer = store.observe(1);
    observer.request(REQUEST);
    observer.request(Buffer.alloc(MAX_CAPTURE_BYTES));
    observer.response(RESPONSE);
    observer.end();
    expect(store.list()[0]!.replayable).toBe(false);
  });

  it("marks a stream without a response as an error", () => {
    const store = new RequestStore();
    const observer = store.observe(1);
    observer.request(REQUEST);
    observer.end({ error: "local app unreachable (ECONNREFUSED)" });
    expect(store.list()[0]).toMatchObject({ state: "error", error: "local app unreachable (ECONNREFUSED)" });
  });

  it("keeps only the newest records", () => {
    const store = new RequestStore({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) record(store);
    expect(store.list().map((r) => r.id)).toEqual([5, 4, 3]);
  });

  it("replays a request against the local app as a new record", async () => {
    const port = await startLocalApp();
    const store = new RequestStore({ target: { host: "127.0.0.1", port } });
    record(store);

    const replayed = await store.replay(1);
    expect(replayed).toMatchObject({ id: 2, replayOf: 1, streamId: null, status: 200, state: "complete" });
    expect(store.get(2)!.responseBody.text).toBe('replayed POST /api/items?x=1 {"a":1}');
  });

  it("records a failed replay when the local app is down", async () => {
    const store = new RequestStore({ target: { host: "127.0.0.1", port: 1 } });
    record(store);
    const replayed = await store.replay(1);
    expect(replayed.state).toBe("error");
    expect(replayed.error).toContain("ECONNREFUSED");
  });
});

describe("inspector server", () => {
  async function start(store: RequestStore) {
    const server = await startInspectorServer({ store, port: 0 });
    cleanups.push(() => server.close());
    return server;
  }

  it("serves the dashboard and the JSON API", async () => {
    const store = new RequestStore();
    record(store);
    const server = await start(store);

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Wormhole Inspector");
    expect((await fetch(`${server.url}/app.js`)).status).toBe(200);

    const list = (await (await fetch(`${server.url}/api/requests`)).json()) as Array<{ id: number; method: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.method).toBe("POST");

    const detail = (await (await fetch(`${server.url}/api/requests/1`)).json()) as { requestHeaders: unknown[] };
    expect(detail.requestHeaders).toContainEqual(["Host", "demo.localhost"]);
    expect((await fetch(`${server.url}/api/requests/99`)).status).toBe(404);
  });

  it("pushes a snapshot and live updates over the WebSocket", async () => {
    const store = new RequestStore();
    store.setStatus({ state: "online", url: "http://demo.localhost:8080", localPort: 3000 });
    const server = await start(store);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanups.push(() => socket.terminate());
    const messages: InspectorMessage[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data)) as InspectorMessage));
    await new Promise((resolve) => socket.once("open", resolve));
    await waitUntil(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ type: "snapshot", requests: [], status: { state: "online" } });

    record(store);
    await waitUntil(() => messages.some((m) => m.type === "upsert" && m.request.state === "complete"));
    const last = messages.filter((m) => m.type === "upsert").at(-1)!;
    expect(last).toMatchObject({ type: "upsert", request: { method: "POST", status: 201 } });
  });

  it("replays through the API", async () => {
    const port = await startLocalApp();
    const store = new RequestStore({ target: { host: "127.0.0.1", port } });
    record(store);
    const server = await start(store);

    const response = await fetch(`${server.url}/api/requests/1/replay`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayOf: 1, status: 200 });
  });

  it("rejects cross-origin writes", async () => {
    const store = new RequestStore();
    record(store);
    const server = await start(store);

    const response = await fetch(`${server.url}/api/requests/1/replay`, {
      method: "POST",
      headers: { Origin: "https://evil.example" }
    });
    expect(response.status).toBe(403);
    const clear = await fetch(`${server.url}/api/requests`, { method: "DELETE", headers: { Origin: server.url } });
    expect(clear.status).toBe(200);
    expect(store.size).toBe(0);
  });
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
