import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createServer as createTlsServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { CONTROL_STREAM_ID, FrameDecoder, FrameType, encodeFrame, encodeJsonFrame } from "@wormhole/protocol";
import type { ErrorPayload, Frame } from "@wormhole/protocol";
import type { Stream } from "@wormhole/transport";
import { TunnelClient, proxyStream } from "../src/index.ts";
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
    backoff: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    ...options
  });
  cleanups.push(() => client.close());
  return client;
}

/** A raw TLS server that records frames and lets the test script the replies. */
async function startFakeRelay(onFrame: (frame: Frame, socket: TLSSocket) => void) {
  const credentials = await getTestCredentials();
  const sockets: TLSSocket[] = [];
  const frames: Frame[] = [];
  const server = createTlsServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        frames.push(frame);
        onFrame(frame, socket);
      }
    });
  });
  const port = await listen(server);
  cleanups.push(() => {
    sockets.forEach((s) => s.destroy());
    server.close();
  });
  return { port, frames, sockets };
}

/** Stand-in for a mux `Stream` that records what proxyStream does with it. */
class FakeStream extends EventEmitter {
  readonly id = 1;
  readonly calls: string[] = [];
  readonly written: Buffer[] = [];
  write(chunk: Buffer): boolean {
    this.calls.push("DATA");
    this.written.push(chunk);
    return true;
  }
  close(): void {
    this.calls.push("CLOSE");
    this.emit("close");
  }
  pauseControl(): void {}
  resumeControl(): void {}
}

describe("local app down (PROTOCOL.md: ERROR LOCAL_DOWN)", () => {
  it("sends ERROR LOCAL_DOWN, then the 502 page as DATA, then CLOSE", async () => {
    const stream = new FakeStream();
    const errors: ErrorPayload[] = [];
    let done = false;
    proxyStream({
      stream: stream as unknown as Stream,
      target: { host: "127.0.0.1", port: 1 },
      reportError: (error) => {
        stream.calls.push("ERROR");
        errors.push(error);
      },
      onDone: () => (done = true)
    });
    stream.emit("data", Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));

    for (let i = 0; i < 100 && !done; i++) await sleep(10);
    expect(stream.calls).toEqual(["ERROR", "DATA", "CLOSE"]);
    expect(errors[0]!.code).toBe("LOCAL_DOWN");
    expect(stream.written[0]!.toString()).toMatch(/^HTTP\/1\.1 502 Bad Gateway/);
  });
});

describe("stream table and OPEN handling", () => {
  it("keeps one entry per open stream and removes it on CLOSE", async () => {
    const relay = await startRelay();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = await startLocalApp((_req, res) => {
      void gate.then(() => res.end("done"));
    });
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "table" });
    await client.start();

    const pending = Promise.all([1, 2, 3].map((i) => publicRequest(relay.publicPort, "table", { path: `/${i}` })));
    for (let i = 0; i < 100 && client.streamCount < 3; i++) await sleep(10);
    expect(client.streams.map((s) => s.id)).toEqual([1, 3, 5]);

    release();
    await pending;
    for (let i = 0; i < 100 && client.streamCount > 0; i++) await sleep(10);
    expect(client.streams).toEqual([]);
  });

  it("refuses an OPEN that arrives before ASSIGN with CLOSE", async () => {
    const fake = await startFakeRelay((frame, socket) => {
      if (frame.type === FrameType.AUTH) {
        socket.write(encodeFrame(FrameType.OPEN, 1));
        socket.write(encodeJsonFrame(FrameType.ASSIGN, CONTROL_STREAM_ID, { subdomain: "early", url: "http://early" }));
      }
    });
    const client = startClient({ serverPort: fake.port, localPort: 1 });
    await client.start();
    for (let i = 0; i < 100 && !fake.frames.some((f) => f.type === FrameType.CLOSE); i++) await sleep(10);
    expect(fake.frames.find((f) => f.type === FrameType.CLOSE)?.streamId).toBe(1);
    expect(client.streamCount).toBe(0);
  });

  it("sends a stream-level ERROR LOCAL_DOWN to the relay", async () => {
    const fake = await startFakeRelay((frame, socket) => {
      if (frame.type === FrameType.AUTH) {
        socket.write(encodeJsonFrame(FrameType.ASSIGN, CONTROL_STREAM_ID, { subdomain: "x", url: "http://x" }));
        socket.write(encodeFrame(FrameType.OPEN, 1));
        socket.write(encodeFrame(FrameType.DATA, 1, Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\n")));
      }
    });
    const client = startClient({ serverPort: fake.port, localPort: 1 });
    await client.start();
    for (let i = 0; i < 200 && !fake.frames.some((f) => f.type === FrameType.CLOSE); i++) await sleep(10);

    const types = fake.frames.filter((f) => f.streamId === 1).map((f) => f.type);
    expect(types).toEqual([FrameType.ERROR, FrameType.DATA, FrameType.CLOSE]);
    const error = JSON.parse(fake.frames.find((f) => f.type === FrameType.ERROR)!.payload.toString()) as ErrorPayload;
    expect(error.code).toBe("LOCAL_DOWN");
  });
});

describe("reconnect edge cases", () => {
  it("retries SUBDOMAIN_TAKEN after it held the name, until the server frees it", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "held" });
    await client.start();

    // Simulate a server that has not noticed the old connection died yet.
    await relay.stop();
    await sleep(20);
    relay.registry.add({
      subdomain: "held",
      type: "http",
      token: TEST_TOKEN,
      streamCount: 0,
      openStream: () => {
        throw new Error("stale");
      },
      close: () => {}
    });
    await relay.restart();

    const [, info] = await waitFor<{ reason: string }>(client, "reconnecting", 3000);
    void info;
    const fatal: unknown[] = [];
    client.on("fatal", (e) => fatal.push(e));
    await sleep(300);
    expect(fatal).toEqual([]);
    expect(client.state).toBe("reconnecting");

    relay.registry.remove("held");
    const [assign] = await waitFor<{ subdomain: string }>(client, "assigned", 3000);
    expect(assign!.subdomain).toBe("held");
  });

  it("drops an attempt when the server never answers AUTH, and retries", async () => {
    const fake = await startFakeRelay(() => {});
    const client = startClient({ serverPort: fake.port, localPort: 1, handshakeTimeoutMs: 150 });
    void client.start().catch(() => {});
    const [event] = await waitFor<{ reason: string }>(client, "reconnecting", 3000);
    expect(event!.reason).toContain("did not answer AUTH");
  });
});

describe("TLS verification (--secure / --ca)", () => {
  it("is fatal when --secure is set and the relay cert is self-signed", async () => {
    const relay = await startRelay();
    const client = startClient({ serverPort: relay.controlPort, localPort: 1, serverHost: "localhost", verifyCertificate: true });
    const err = (await client.start().catch((e: unknown) => e)) as { code: string };
    expect(err.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
  });

  it("connects when the relay cert is passed with --ca", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const { cert } = await getTestCredentials();
    const client = startClient({
      serverPort: relay.controlPort,
      localPort: app.port,
      serverHost: "localhost",
      verifyCertificate: true,
      ca: cert,
      subdomain: "verified"
    });
    expect((await client.start()).subdomain).toBe("verified");
  });
});
