import { afterEach, describe, expect, it } from "vitest";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import type { AddressInfo, Server } from "node:net";
import type { TLSSocket } from "node:tls";
import { FrameDecoder, FrameType, encodeFrame, encodeJsonFrame } from "@wormhole/protocol";
import type { AssignPayload } from "@wormhole/protocol";
import { createControlServer } from "../src/control.ts";
import { createPublicServer } from "../src/public.ts";
import { parseConfig } from "../src/config.ts";
import { TunnelRegistry } from "../src/registry.ts";
import { getTestCredentials } from "./support/test-cert.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const baseConfig = {
  controlPort: 4443,
  httpPort: 8080,
  publicHost: "localhost",
  tokens: ["test-token"],
  heartbeat: { intervalMs: 10000, timeoutMs: 30000 },
  cert: { dir: "certs" }
};

interface Stack {
  controlPort: number;
  publicPort: number;
  registry: TunnelRegistry;
}

async function startStack(): Promise<Stack> {
  const credentials = await getTestCredentials();
  const registry = new TunnelRegistry();
  const config = parseConfig(baseConfig, { baseDir: "." });

  const controlServer = createControlServer({ config, credentials, registry });
  const publicServer = createPublicServer({ config, registry });

  const listen = (server: Server): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });

  const controlPort = await listen(controlServer);
  const publicPort = await listen(publicServer);
  cleanups.push(() => {
    controlServer.close();
    publicServer.close();
  });

  return { controlPort, publicPort, registry };
}

type Responder = (requestText: string) => string | null;

function connectTunnel(controlPort: number, subdomain: string, respond: Responder): Promise<{ assign: Promise<AssignPayload> }> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({ port: controlPort, host: "127.0.0.1", rejectUnauthorized: false });
    const decoder = new FrameDecoder();
    let assignResolve!: (payload: AssignPayload) => void;
    const assign = new Promise<AssignPayload>((res) => {
      assignResolve = res;
    });

    let streamId = 0;
    let requestBuffer = Buffer.alloc(0);
    let responded = false;

    socket.on("error", reject);
    socket.on("secureConnect", () => {
      socket.removeListener("error", reject);
      socket.on("error", () => {});
      socket.write(encodeJsonFrame(FrameType.AUTH, 0, { token: "test-token", type: "http", subdomain }));
      cleanups.push(() => socket.destroy());
      resolve({ assign });
    });
    socket.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === FrameType.ASSIGN) {
          assignResolve(JSON.parse(frame.payload.toString("utf8")) as AssignPayload);
        } else if (frame.type === FrameType.OPEN) {
          streamId = frame.streamId;
          requestBuffer = Buffer.alloc(0);
          responded = false;
        } else if (frame.type === FrameType.DATA) {
          requestBuffer = Buffer.concat([requestBuffer, frame.payload]);
          if (!responded && requestBuffer.includes(Buffer.from("\r\n\r\n"))) {
            responded = true;
            const body = respond(requestBuffer.toString("latin1"));
            if (body === null) {
              socket.write(encodeFrame(FrameType.CLOSE, streamId));
            } else {
              socket.write(encodeFrame(FrameType.DATA, streamId, Buffer.from(body)));
              socket.write(encodeFrame(FrameType.CLOSE, streamId));
            }
          }
        }
      }
    });
  });
}

function httpGet(port: number, headers: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => {
      socket.write(`GET / HTTP/1.1\r\n${headers}\r\n\r\n`);
    });
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
    });
    socket.on("end", () => resolve(data.toString("utf8")));
    socket.on("error", reject);
  });
}

const OK_RESPONSE = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello";

describe("createPublicServer", () => {
  it("relays a request to the tunnel and returns its response", async () => {
    const { controlPort, publicPort } = await startStack();
    const seen: string[] = [];
    const tunnel = await connectTunnel(controlPort, "app", (requestText) => {
      seen.push(requestText);
      return OK_RESPONSE;
    });
    await tunnel.assign;

    const response = await httpGet(publicPort, "Host: app.localhost\r\nConnection: close");
    expect(response).toContain("200 OK");
    expect(response).toContain("hello");
    expect(seen[0]).toContain("Connection: close");
  });

  it("returns 404 for an unknown subdomain", async () => {
    const { publicPort } = await startStack();
    const response = await httpGet(publicPort, "Host: nobody.localhost\r\nConnection: close");
    expect(response.startsWith("HTTP/1.1 404")).toBe(true);
  });

  it("returns 404 when no Host header is present", async () => {
    const { publicPort } = await startStack();
    const response = await httpGet(publicPort, "Connection: close");
    expect(response.startsWith("HTTP/1.1 404")).toBe(true);
  });

  it("returns 502 when the tunnel closes without responding", async () => {
    const { controlPort, publicPort } = await startStack();
    const tunnel = await connectTunnel(controlPort, "down", () => null);
    await tunnel.assign;

    const response = await httpGet(publicPort, "Host: down.localhost\r\nConnection: close");
    expect(response.startsWith("HTTP/1.1 502")).toBe(true);
  });
});
