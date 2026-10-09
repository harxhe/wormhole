import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo, Server as NetServer } from "node:net";
import { createControlServer } from "../src/control.ts";
import { createPublicServer } from "../src/public.ts";
import { parseConfig } from "../src/config.ts";
import { TunnelRegistry } from "../src/registry.ts";
import { startMockClient } from "../src/mock-client.ts";
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

function listen(server: NetServer | HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function startLocalApp(): Promise<{ port: number; close: () => void }> {
  const app = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`hello from local app: ${req.method} ${req.url} body=${body}`);
    });
  });
  return listen(app).then((port) => {
    const close = (): void => {
      app.close();
    };
    cleanups.push(close);
    return { port, close };
  });
}

function request(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(raw));
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
    });
    socket.on("end", () => resolve(data.toString("utf8")));
    socket.on("error", reject);
  });
}

async function startRelay() {
  const credentials = await getTestCredentials();
  const registry = new TunnelRegistry();
  const config = parseConfig(baseConfig, { baseDir: "." });
  const controlServer = createControlServer({ config, credentials, registry });
  const publicServer = createPublicServer({ config, registry });
  const controlPort = await listen(controlServer);
  const publicPort = await listen(publicServer);
  cleanups.push(() => {
    controlServer.close();
    publicServer.close();
  });
  return { controlPort, publicPort };
}

describe("end to end", () => {
  it("proxies a GET request through the tunnel to the local app", async () => {
    const { controlPort, publicPort } = await startRelay();
    const app = await startLocalApp();
    const client = startMockClient({
      serverHost: "127.0.0.1",
      serverPort: controlPort,
      token: "test-token",
      localPort: app.port,
      subdomain: "demo"
    });
    cleanups.push(() => client.close());
    await client.assigned;

    const response = await request(publicPort, "GET /hello HTTP/1.1\r\nHost: demo.localhost\r\nConnection: close\r\n\r\n");
    expect(response).toContain("200 OK");
    expect(response).toContain("hello from local app: GET /hello body=");
  });

  it("relays a request body", async () => {
    const { controlPort, publicPort } = await startRelay();
    const app = await startLocalApp();
    const client = startMockClient({
      serverHost: "127.0.0.1",
      serverPort: controlPort,
      token: "test-token",
      localPort: app.port,
      subdomain: "echo"
    });
    cleanups.push(() => client.close());
    await client.assigned;

    const body = "ping-payload";
    const response = await request(
      publicPort,
      `POST /echo HTTP/1.1\r\nHost: echo.localhost\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
    );
    expect(response).toContain("200 OK");
    expect(response).toContain(`body=${body}`);
  });

  it("returns 502 when the local app is not listening", async () => {
    const { controlPort, publicPort } = await startRelay();
    const client = startMockClient({
      serverHost: "127.0.0.1",
      serverPort: controlPort,
      token: "test-token",
      localPort: 9,
      subdomain: "dead"
    });
    cleanups.push(() => client.close());
    await client.assigned;

    const response = await request(publicPort, "GET / HTTP/1.1\r\nHost: dead.localhost\r\nConnection: close\r\n\r\n");
    expect(response.startsWith("HTTP/1.1 502")).toBe(true);
  });
});
