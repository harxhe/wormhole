import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo, Server as NetServer, Socket } from "node:net";
import { createControlServer } from "../../../server/src/control.ts";
import { createPublicServer } from "../../../server/src/public.ts";
import { parseConfig } from "../../../server/src/config.ts";
import { TunnelRegistry } from "../../../server/src/registry.ts";
import { getTestCredentials } from "../../../server/test/support/test-cert.ts";

export const TEST_TOKEN = "test-token";

/** Cleanup callbacks, run by each test file's `afterEach`. */
export const cleanups: Array<() => unknown> = [];

export async function runCleanups(): Promise<void> {
  while (cleanups.length) await cleanups.pop()!();
}

export function listen(server: NetServer | HttpServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export interface Relay {
  controlPort: number;
  publicPort: number;
  registry: TunnelRegistry;
  /** Kill the control listener and every tunnel connection (a server crash). */
  stop(): Promise<void>;
  /** Start a fresh control listener on the same port (a server restart). */
  restart(): Promise<void>;
}

/** The real Phase 0 relay server, running in-process on random ports. */
export async function startRelay(heartbeat = { intervalMs: 10_000, timeoutMs: 30_000 }): Promise<Relay> {
  const credentials = await getTestCredentials();
  const config = parseConfig(
    {
      controlPort: 4443,
      httpPort: 8080,
      publicHost: "localhost",
      tokens: [TEST_TOKEN],
      heartbeat,
      cert: { dir: "certs" }
    },
    { baseDir: "." }
  );

  // One registry for the relay's lifetime: when the control listener is killed,
  // each dropped connection unregisters its tunnel, as in a real restart.
  const registry = new TunnelRegistry();
  const publicServer = createPublicServer({ config, registry });
  const publicPort = await listen(publicServer);

  let controlServer: NetServer | undefined;
  let controlSockets = new Set<Socket>();
  let controlPort = 0;

  const startControl = async (): Promise<void> => {
    const server = createControlServer({ config, credentials, registry });
    const sockets = new Set<Socket>();
    server.on("secureConnection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    controlPort = await listen(server, controlPort);
    controlServer = server;
    controlSockets = sockets;
  };

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      for (const socket of controlSockets) socket.destroy();
      if (!controlServer) return resolve();
      const server = controlServer;
      controlServer = undefined;
      server.close(() => resolve());
    });

  await startControl();

  const relay: Relay = {
    get controlPort() {
      return controlPort;
    },
    publicPort,
    registry,
    stop,
    restart: async () => {
      await stop();
      await startControl();
    }
  };

  cleanups.push(async () => {
    await stop();
    publicServer.close();
  });
  return relay;
}

export interface LocalApp {
  port: number;
  close(): Promise<void>;
}

/** A local HTTP app that echoes method, path and body. */
export async function startLocalApp(
  handler?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void
): Promise<LocalApp> {
  const app = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (handler) {
        handler(req, res, body);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`echo ${req.method} ${req.url} body=${body.toString("utf8")}`);
    });
  });
  const port = await listen(app);
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      app.closeAllConnections();
      app.close(() => resolve());
    });
  cleanups.push(close);
  return { port, close };
}

export interface RawResponse {
  status: number;
  headers: string;
  body: Buffer;
  text: string;
}

/** Send a raw HTTP/1.1 request to the public listener for `subdomain`. */
export function publicRequest(
  publicPort: number,
  subdomain: string,
  options: { method?: string; path?: string; body?: Buffer | string } = {}
): Promise<RawResponse> {
  const method = options.method ?? "GET";
  const path = options.path ?? "/";
  const body = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const head =
    `${method} ${path} HTTP/1.1\r\nHost: ${subdomain}.localhost\r\nConnection: close\r\n` +
    (body.length ? `Content-Length: ${body.length}\r\n` : "") +
    "\r\n";

  return new Promise((resolve, reject) => {
    const socket = netConnect(publicPort, "127.0.0.1", () => {
      socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      const headers = raw.subarray(0, split).toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1] ?? 0);
      let payload: Buffer = raw.subarray(split + 4);
      if (/transfer-encoding:\s*chunked/i.test(headers)) payload = dechunk(payload);
      resolve({ status, headers, body: payload, text: payload.toString("utf8") });
    });
  });
}

function dechunk(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = body.indexOf("\r\n", offset);
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1"), 16);
    if (!size) return Buffer.concat(parts);
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
}

export function waitFor<T>(emitter: NodeJS.EventEmitter, event: string, timeoutMs = 10_000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (...args: T[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
