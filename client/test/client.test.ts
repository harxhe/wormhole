import { afterEach, describe, expect, it } from "vitest";
import { createServer as createTlsServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { CONTROL_STREAM_ID, FrameDecoder, FrameType, encodeJsonFrame } from "@wormhole/protocol";
import { RequestStore } from "@wormhole/inspector";
import { Backoff, TunnelClient, TunnelError } from "../src/index.ts";
import type { TunnelClientOptions } from "../src/index.ts";
import { getTestCredentials } from "../../server/test/support/test-cert.ts";
import {
  TEST_TOKEN,
  cleanups,
  listen,
  publicRequest,
  runCleanups,
  sleep,
  startLocalApp,
  startRelay,
  waitFor
} from "./support/relay.ts";

afterEach(runCleanups);

function startClient(options: Partial<TunnelClientOptions> & { serverPort: number; localPort: number }): TunnelClient {
  const client = new TunnelClient({
    serverHost: "127.0.0.1",
    token: TEST_TOKEN,
    backoff: { initialDelayMs: 50, maxDelayMs: 400, jitter: 0 },
    ...options
  });
  cleanups.push(() => client.close());
  return client;
}

describe("connect and authenticate", () => {
  it("sends AUTH, receives ASSIGN and exposes the public URL", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "demo" });

    const assign = await client.start();
    expect(assign.subdomain).toBe("demo");
    expect(assign.url).toBe("http://demo.localhost:8080");
    expect(client.state).toBe("online");
    expect(relay.registry.has("demo")).toBe(true);
  });

  it("accepts a server-chosen subdomain when none is requested", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port });

    const assign = await client.start();
    expect(assign.subdomain).toMatch(/^[a-z0-9-]+$/);
    const response = await publicRequest(relay.publicPort, assign.subdomain, { path: "/x" });
    expect(response.text).toBe("echo GET /x body=");
  });

  it("fails without retrying on a bad token", async () => {
    const relay = await startRelay();
    const client = startClient({ serverPort: relay.controlPort, localPort: 1, token: "wrong" });
    const reconnects: unknown[] = [];
    client.on("reconnecting", (e) => reconnects.push(e));

    const err = await client.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).code).toBe("BAD_TOKEN");
    expect(client.state).toBe("closed");
    expect(reconnects).toHaveLength(0);
  });

  it("fails when the requested subdomain belongs to another tunnel", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    await startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "taken" }).start();

    const second = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "taken" });
    const err = (await second.start().catch((e: unknown) => e)) as TunnelError;
    expect(err.code).toBe("SUBDOMAIN_TAKEN");
  });

  it("retries while the relay is down, then connects", async () => {
    const relay = await startRelay();
    const port = relay.controlPort;
    await relay.stop();
    const app = await startLocalApp();
    const client = startClient({ serverPort: port, localPort: app.port, subdomain: "late" });
    const started = client.start();

    await waitFor(client, "reconnecting");
    await relay.restart();
    const assign = await started;
    expect(assign.subdomain).toBe("late");
  });
});

describe("streams", () => {
  it("relays a request body and the response", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "echo" });
    await client.start();

    const response = await publicRequest(relay.publicPort, "echo", { method: "POST", path: "/items", body: "hello" });
    expect(response.status).toBe(200);
    expect(response.text).toBe("echo POST /items body=hello");
  });

  it("handles 50 concurrent requests on one connection", async () => {
    const relay = await startRelay();
    const app = await startLocalApp((req, res) => {
      // Finish out of order so streams really interleave.
      setTimeout(() => res.end(`reply:${req.url}`), Math.floor(Math.random() * 40));
    });
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "busy" });
    await client.start();

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) => publicRequest(relay.publicPort, "busy", { path: `/r/${i}` }))
    );
    responses.forEach((response, i) => {
      expect(response.status).toBe(200);
      expect(response.text).toBe(`reply:/r/${i}`);
    });
    await sleep(50);
    expect(client.streamCount).toBe(0);
  });

  it("splits large bodies into 16 KB frames both ways", async () => {
    const relay = await startRelay();
    const big = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const app = await startLocalApp((_req, res, body) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "X-Request-Bytes": String(body.length) });
      res.end(big);
    });
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "big" });
    await client.start();

    const upload = Buffer.alloc(300 * 1024, 7);
    const response = await publicRequest(relay.publicPort, "big", { method: "POST", body: upload });
    expect(response.status).toBe(200);
    expect(response.headers).toContain(`X-Request-Bytes: ${upload.length}`);
    expect(response.body.equals(big)).toBe(true);
  });

  it("answers 502 when the local app is down and keeps the tunnel up", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const port = app.port;
    await app.close();

    const store = new RequestStore();
    const client = startClient({
      serverPort: relay.controlPort,
      localPort: port,
      subdomain: "down",
      observe: (id) => store.observe(id)
    });
    await client.start();

    const response = await publicRequest(relay.publicPort, "down", { path: "/missing" });
    expect(response.status).toBe(502);
    expect(response.text).toContain("could not reach the local app");
    expect(client.state).toBe("online");

    const [record] = store.list();
    expect(record).toMatchObject({ method: "GET", path: "/missing", status: 502, state: "error" });
    expect(record!.error).toContain("ECONNREFUSED");
  });

  it("records each stream for the inspector", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const store = new RequestStore();
    const client = startClient({
      serverPort: relay.controlPort,
      localPort: app.port,
      subdomain: "seen",
      observe: (id) => store.observe(id)
    });
    await client.start();

    await publicRequest(relay.publicPort, "seen", { method: "PUT", path: "/a?b=1", body: "xyz" });
    await sleep(20);
    const [record] = store.list();
    expect(record).toMatchObject({ method: "PUT", path: "/a?b=1", status: 200, state: "complete", replayable: true });
    expect(record!.streamId).toBe(1);
    expect(record!.durationMs).not.toBeNull();
    expect(store.get(record!.id)!.requestBody.text).toBe("xyz");
  });
});

describe("heartbeat", () => {
  it("answers PING so the server keeps the tunnel alive", async () => {
    const relay = await startRelay({ intervalMs: 40, timeoutMs: 150 });
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "alive" });
    const disconnects: unknown[] = [];
    client.on("disconnected", (e) => disconnects.push(e));
    await client.start();

    await sleep(600);
    expect(disconnects).toHaveLength(0);
    expect((await publicRequest(relay.publicPort, "alive")).status).toBe(200);
  });

  it("drops a silent connection after the timeout and reconnects", async () => {
    // A fake relay that assigns a tunnel and then never answers anything.
    const credentials = await getTestCredentials();
    const sockets: TLSSocket[] = [];
    const silent = createTlsServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      const decoder = new FrameDecoder();
      socket.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.type === FrameType.AUTH) {
            socket.write(encodeJsonFrame(FrameType.ASSIGN, CONTROL_STREAM_ID, { subdomain: "quiet", url: "http://quiet" }));
          }
        }
      });
    });
    const port = await listen(silent);
    cleanups.push(() => {
      sockets.forEach((s) => s.destroy());
      silent.close();
    });

    const client = startClient({
      serverPort: port,
      localPort: 1,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 200
    });
    await client.start();
    const [lost] = await waitFor<{ reason: string }>(client, "disconnected", 3000);
    expect(lost!.reason).toContain("no traffic");
    const [, info] = await waitFor<{ reconnected: boolean }>(client, "assigned", 3000);
    expect(info!.reconnected).toBe(true);
  });
});

describe("auto-reconnect", () => {
  it("reconnects after a server restart and keeps the same subdomain", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "sticky" });
    const first = await client.start();

    const events: string[] = [];
    client.on("disconnected", () => events.push("disconnected"));
    client.on("reconnecting", () => events.push("reconnecting"));

    await relay.stop();
    await waitFor(client, "reconnecting");
    await sleep(150);
    await relay.restart();

    const [assign, info] = await waitFor<{ subdomain: string; reconnected: boolean }>(client, "assigned", 5000);
    expect(assign!.subdomain).toBe(first.subdomain);
    expect((info as unknown as { reconnected: boolean }).reconnected).toBe(true);
    expect(events[0]).toBe("disconnected");
    expect(events).toContain("reconnecting");

    const response = await publicRequest(relay.publicPort, "sticky", { path: "/again" });
    expect(response.text).toBe("echo GET /again body=");
  });

  it("keeps the random subdomain it was given across reconnects", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port });
    const first = await client.start();

    await relay.restart();
    const [assign] = await waitFor<{ subdomain: string }>(client, "assigned", 5000);
    expect(assign!.subdomain).toBe(first.subdomain);
  });

  it("does not reconnect after close()", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port });
    await client.start();
    const reconnects: unknown[] = [];
    client.on("reconnecting", (e) => reconnects.push(e));

    client.close();
    await sleep(300);
    expect(client.state).toBe("closed");
    expect(reconnects).toHaveLength(0);
    expect(relay.registry.size).toBe(0);
  });

  it("exits instead of reconnecting when reconnect is off", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, reconnect: false });
    await client.start();

    const fatal = waitFor<TunnelError>(client, "fatal");
    await relay.stop();
    const [err] = await fatal;
    expect(err).toBeInstanceOf(TunnelError);
    expect(client.state).toBe("closed");
  });
});

describe("Backoff", () => {
  it("doubles from 1s and caps at 30s", () => {
    const backoff = new Backoff({ jitter: 0 });
    const delays = Array.from({ length: 8 }, () => backoff.next());
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    backoff.reset();
    expect(backoff.next()).toBe(1000);
  });

  it("applies bounded jitter", () => {
    const backoff = new Backoff({ initialDelayMs: 1000, jitter: 0.2 });
    expect(backoff.next(() => 0)).toBe(800);
    expect(backoff.next(() => 1)).toBe(2400);
  });
});
