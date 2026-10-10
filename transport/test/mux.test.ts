import { afterEach, describe, expect, it } from "vitest";
import { createServer, connect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server, Socket } from "node:net";
import { FrameDecoder, FrameType, MAX_PAYLOAD, encodeFrame, encodeJsonFrame, frameTypeName } from "@wormhole/protocol";
import type { Frame } from "@wormhole/protocol";
import { Mux, type MuxOptions } from "../src/mux.ts";

interface Harness {
  mux: Mux;
  client: Socket;
  frames: Frame[];
  waitForFrame(type: FrameType, timeoutMs?: number): Promise<Frame>;
  waitFor(condition: () => boolean, label: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function createHarness(muxOptions: Partial<MuxOptions> = {}): Promise<Harness> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    const frames: Frame[] = [];
    const decoder = new FrameDecoder();
    const waiters: Array<{ type: FrameType; resolve: (frame: Frame) => void }> = [];
    let client!: Socket;

    const notify = (frame: Frame): void => {
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === frame.type) {
          waiters.splice(i, 1)[0]!.resolve(frame);
        }
      }
    };

    server.on("connection", (socket) => {
      const mux = new Mux(socket, {
        heartbeatIntervalMs: 10_000,
        heartbeatTimeoutMs: 30_000,
        ...muxOptions
      });
      mux.on("error", () => {});

      const harness: Harness = {
        mux,
        get client() {
          return client;
        },
        frames,
        waitForFrame(type, timeoutMs = 1000) {
          const existing = frames.find((f) => f.type === type);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(`timeout waiting for ${frameTypeName(type)}`)), timeoutMs);
            waiters.push({
              type,
              resolve: (frame) => {
                clearTimeout(timer);
                res(frame);
              }
            });
          });
        },
        waitFor(condition, label, timeoutMs = 1000) {
          return new Promise((res, rej) => {
            const started = Date.now();
            const tick = (): void => {
              if (condition()) return res();
              if (Date.now() - started > timeoutMs) return rej(new Error(`timeout waiting for ${label}`));
              setTimeout(tick, 5);
            };
            tick();
          });
        },
        close() {
          mux.destroy();
          client?.destroy();
          server.close();
        }
      };
      cleanups.push(harness.close);
      resolve(harness);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      client = connect(port, "127.0.0.1");
      client.on("error", () => {});
      client.on("data", (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) notify(frame);
      });
    });
  });
}

describe("Mux", () => {
  it("opens streams with increasing odd ids and sends OPEN", async () => {
    const h = await createHarness();
    const first = h.mux.openStream();
    const second = h.mux.openStream();

    expect(first.id).toBe(1);
    expect(second.id).toBe(3);
    expect(h.mux.streamCount).toBe(2);

    await h.waitFor(() => h.frames.filter((f) => f.type === FrameType.OPEN).length === 2, "two OPEN frames");
    const opens = h.frames.filter((f) => f.type === FrameType.OPEN);
    expect(opens.map((f) => f.streamId)).toEqual([1, 3]);
  });

  it("splits writes into MAX_PAYLOAD-sized DATA frames", async () => {
    const h = await createHarness();
    const stream = h.mux.openStream();
    stream.write(Buffer.alloc(MAX_PAYLOAD + 100, 0x61));

    await h.waitFor(() => h.frames.filter((f) => f.type === FrameType.DATA).length === 2, "two DATA frames");
    const data = h.frames.filter((f) => f.type === FrameType.DATA);
    expect(data[0]!.payload.length).toBe(MAX_PAYLOAD);
    expect(data[1]!.payload.length).toBe(100);
  });

  it("delivers peer DATA to the stream", async () => {
    const h = await createHarness();
    const stream = h.mux.openStream();

    const received: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => received.push(chunk));

    h.client.write(encodeFrame(FrameType.DATA, stream.id, Buffer.from("ping")));
    await h.waitFor(() => received.length === 1, "stream data");
    expect(received[0]!.toString()).toBe("ping");
  });

  it("emits close when the peer sends CLOSE", async () => {
    const h = await createHarness();
    const stream = h.mux.openStream();
    const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));

    h.client.write(encodeFrame(FrameType.CLOSE, stream.id));
    await closed;
    expect(stream.isClosed).toBe(true);
    expect(h.mux.streamCount).toBe(0);
  });

  it("replies PONG to PING", async () => {
    const h = await createHarness();
    h.client.write(encodeFrame(FrameType.PING, 0));
    const pong = await h.waitForFrame(FrameType.PONG);
    expect(pong.streamId).toBe(0);
  });

  it("surfaces control frames to listeners", async () => {
    const h = await createHarness();
    const control = new Promise<Frame>((resolve) => h.mux.once("control", resolve));

    h.client.write(encodeJsonFrame(FrameType.AUTH, 0, { token: "abc", type: "http" }));
    const frame = await control;
    expect(frame.type).toBe(FrameType.AUTH);
    expect(frame.streamId).toBe(0);
  });

  it("destroys the connection after a heartbeat timeout", async () => {
    const h = await createHarness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
    await new Promise<void>((resolve) => h.mux.on("close", () => resolve()));
    expect(h.mux.isDestroyed).toBe(true);
  });

  it("aborts streams when destroyed", async () => {
    const h = await createHarness();
    const stream = h.mux.openStream();
    const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));
    h.mux.destroy();
    await closed;
    expect(stream.isClosed).toBe(true);
  });
});
