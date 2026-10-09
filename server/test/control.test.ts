import { afterEach, describe, expect, it } from "vitest";
import { connect } from "node:tls";
import type { AddressInfo } from "node:net";
import type { Server, TLSSocket } from "node:tls";
import { generate } from "selfsigned";
import { FrameDecoder, FrameType, encodeJsonFrame, frameTypeName } from "@wormhole/protocol";
import type { AssignPayload, ErrorPayload, Frame } from "@wormhole/protocol";
import { createControlServer } from "../src/control.ts";
import { parseConfig } from "../src/config.ts";
import { TunnelRegistry } from "../src/registry.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

let credentialsPromise: Promise<{ key: Buffer; cert: Buffer }> | undefined;
function getCredentials(): Promise<{ key: Buffer; cert: Buffer }> {
  credentialsPromise ??= generate([{ name: "commonName", value: "localhost" }], {
    algorithm: "sha256",
    keySize: 2048
  }).then((pems) => ({ key: Buffer.from(pems.private), cert: Buffer.from(pems.cert) }));
  return credentialsPromise;
}

const baseConfig = {
  controlPort: 4443,
  httpPort: 8080,
  publicHost: "localhost",
  tokens: ["test-token"],
  heartbeat: { intervalMs: 10000, timeoutMs: 30000 },
  cert: { dir: "certs" }
};

interface ControlClient {
  socket: TLSSocket;
  sendAuth(payload: unknown): void;
  waitForFrame(type: FrameType, timeoutMs?: number): Promise<Frame>;
  closed(): Promise<void>;
}

async function startServer(authTimeoutMs = 500): Promise<{ server: Server; port: number; registry: TunnelRegistry }> {
  const credentials = await getCredentials();
  const registry = new TunnelRegistry();
  const config = parseConfig(baseConfig, { baseDir: "." });
  const server = createControlServer({ config, credentials, registry, authTimeoutMs });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return { server, port: (server.address() as AddressInfo).port, registry };
}

function connectClient(port: number): Promise<ControlClient> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
    const decoder = new FrameDecoder();
    const frames: Frame[] = [];
    const waiters: Array<{ type: FrameType; resolve: (frame: Frame) => void }> = [];
    let closedResolve: (() => void) | undefined;
    const closedPromise = new Promise<void>((res) => {
      closedResolve = res;
    });

    const notify = (frame: Frame): void => {
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === frame.type) waiters.splice(i, 1)[0]!.resolve(frame);
      }
    };

    socket.on("error", reject);
    socket.on("close", () => closedResolve?.());
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) notify(frame);
    });
    socket.on("secureConnect", () => {
      socket.removeListener("error", reject);
      socket.on("error", () => {});
      cleanups.push(() => socket.destroy());
      resolve({
        socket,
        sendAuth(payload: unknown) {
          socket.write(encodeJsonFrame(FrameType.AUTH, 0, payload));
        },
        waitForFrame(type: FrameType, timeoutMs = 1500) {
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
        closed() {
          return closedPromise;
        }
      });
    });
  });
}

function json<T>(frame: Frame): T {
  return JSON.parse(frame.payload.toString("utf8")) as T;
}

describe("createControlServer", () => {
  it("assigns a random subdomain for a valid token", async () => {
    const { port, registry } = await startServer();
    const client = await connectClient(port);
    client.sendAuth({ token: "test-token", type: "http" });

    const assign = json<AssignPayload>(await client.waitForFrame(FrameType.ASSIGN));
    expect(assign.subdomain).toMatch(/^[a-z0-9-]+$/);
    expect(assign.url).toBe(`http://${assign.subdomain}.localhost:8080`);
    expect(registry.has(assign.subdomain)).toBe(true);
  });

  it("honours a requested subdomain", async () => {
    const { port, registry } = await startServer();
    const client = await connectClient(port);
    client.sendAuth({ token: "test-token", type: "http", subdomain: "my-app" });

    const assign = json<AssignPayload>(await client.waitForFrame(FrameType.ASSIGN));
    expect(assign.subdomain).toBe("my-app");
    expect(registry.has("my-app")).toBe(true);
  });

  it("rejects an unknown token", async () => {
    const { port, registry } = await startServer();
    const client = await connectClient(port);
    client.sendAuth({ token: "wrong", type: "http" });

    const error = json<ErrorPayload>(await client.waitForFrame(FrameType.ERROR));
    expect(error.code).toBe("BAD_TOKEN");
    expect(registry.size).toBe(0);
  });

  it("rejects a subdomain that is already taken", async () => {
    const { port } = await startServer();
    const first = await connectClient(port);
    first.sendAuth({ token: "test-token", type: "http", subdomain: "taken" });
    await first.waitForFrame(FrameType.ASSIGN);

    const second = await connectClient(port);
    second.sendAuth({ token: "test-token", type: "http", subdomain: "taken" });
    const error = json<ErrorPayload>(await second.waitForFrame(FrameType.ERROR));
    expect(error.code).toBe("SUBDOMAIN_TAKEN");
  });

  it("closes the connection when no AUTH arrives", async () => {
    const { port } = await startServer(80);
    const client = await connectClient(port);
    const error = json<ErrorPayload>(await client.waitForFrame(FrameType.ERROR));
    expect(error.code).toBe("AUTH_TIMEOUT");
    await client.closed();
  });

  it("frees the subdomain when the client disconnects", async () => {
    const { port, registry } = await startServer();
    const client = await connectClient(port);
    client.sendAuth({ token: "test-token", type: "http", subdomain: "gone" });
    await client.waitForFrame(FrameType.ASSIGN);

    client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(registry.has("gone")).toBe(false);
  });
});
