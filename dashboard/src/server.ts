import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { ReplayError } from "@wormhole/inspector";
import type { RequestSummary } from "@wormhole/inspector";
import {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_LOCAL_HOST,
  DEFAULT_PUBLIC_BASE,
  DEFAULT_SERVER,
  DEFAULT_TOKEN
} from "./config.ts";
import { DashboardError } from "./errors.ts";
import { TunnelManager } from "./manager.ts";
import type { CreateTunnelInput, ManagerDefaults, TunnelSnapshot } from "./manager.ts";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_BODY_BYTES = 64 * 1024;

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" }
};

/** Messages pushed to every open dashboard tab. */
export type DashboardMessage =
  | { type: "snapshot"; tunnels: TunnelSnapshot[] }
  | { type: "tunnel"; tunnel: TunnelSnapshot }
  | { type: "remove"; id: string }
  | { type: "request"; tunnelId: string; request: RequestSummary }
  | { type: "clear"; tunnelId: string };

export interface DashboardServerOptions {
  /** Port to listen on (default 4040; `0` picks a free port). */
  port?: number;
  /** Interface to bind (default `127.0.0.1`). */
  host?: string;
  /** Reuse a manager, mainly for tests. */
  manager?: TunnelManager;
  /** Defaults shown to the browser and used when a form leaves fields blank. */
  defaults?: Partial<ManagerDefaults>;
}

export interface DashboardServer {
  readonly port: number;
  readonly url: string;
  readonly manager: TunnelManager;
  close(): Promise<void>;
}

/**
 * Start the local dashboard: the static UI, a small REST API, and a WebSocket
 * that pushes tunnel and request changes to every open tab.
 *
 * | Method | Path | Purpose |
 * |---|---|---|
 * | GET | `/api/config` | Defaults, token presence and current tunnels |
 * | GET | `/api/tunnels` | Tunnel snapshots |
 * | POST | `/api/tunnels` | Start a tunnel |
 * | DELETE | `/api/tunnels/:id` | Stop a tunnel |
 * | GET | `/api/tunnels/:id` | One tunnel snapshot |
 * | GET | `/api/tunnels/:id/requests` | Captured HTTP requests |
 * | GET | `/api/tunnels/:id/requests/:rid` | One request with headers/bodies |
 * | POST | `/api/tunnels/:id/requests/:rid/replay` | Replay a request |
 * | DELETE | `/api/tunnels/:id/requests` | Clear the request log |
 * | WS | `/ws` | Snapshot, then live tunnel/request messages |
 */
export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServer> {
  const defaults: ManagerDefaults = {
    server: options.defaults?.server ?? DEFAULT_SERVER,
    token: options.defaults?.token ?? DEFAULT_TOKEN,
    localHost: options.defaults?.localHost ?? DEFAULT_LOCAL_HOST,
    publicBase: options.defaults?.publicBase ?? DEFAULT_PUBLIC_BASE
  };
  const manager = options.manager ?? new TunnelManager(defaults);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;

  const http = createServer((req, res) => {
    handle(req, res, manager, defaults).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof DashboardError) {
        sendJson(res, statusForCode(err.code), { error: err.message, code: err.code });
        return;
      }
      console.error(`dashboard error: ${(err as Error).message}`);
      sendJson(res, 500, { error: "internal dashboard error" });
    });
  });

  // Lazy import keeps the manager usable without binding a socket (tests).
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    verifyClient: ({ req }: { req: IncomingMessage }) => isSameOrigin(req)
  });

  wss.on("error", () => {
    // Re-emitted HTTP server errors; listen failures are reported below.
  });
  http.on("clientError", (_err, socket) => socket.destroy());

  const broadcast = (message: DashboardMessage): void => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  const onTunnel = (tunnel: TunnelSnapshot): void => broadcast({ type: "tunnel", tunnel });
  const onRemove = (id: string): void => broadcast({ type: "remove", id });
  const onRequest = (tunnelId: string, request: RequestSummary): void =>
    broadcast({ type: "request", tunnelId, request });
  const onClear = (tunnelId: string): void => broadcast({ type: "clear", tunnelId });

  manager.on("tunnel", onTunnel);
  manager.on("remove", onRemove);
  manager.on("request", onRequest);
  manager.on("clear", onClear);

  wss.on("connection", (socket: WebSocket) => {
    socket.on("error", () => socket.terminate());
    const snapshot: DashboardMessage = { type: "snapshot", tunnels: manager.list() };
    socket.send(JSON.stringify(snapshot));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      http.removeListener("error", onError);
      reject(
        err.code === "EADDRINUSE"
          ? new DashboardError("PORT_IN_USE", `port ${port} is already in use; try --port ${port + 1}`)
          : err
      );
    };
    http.once("error", onError);
    http.listen(port, host, () => {
      http.removeListener("error", onError);
      resolve();
    });
  });

  http.on("error", (err: Error) => console.error(`dashboard error: ${err.message}`));

  const boundPort = (http.address() as AddressInfo).port;
  const urlHost =
    host === "0.0.0.0" || host === "::"
      ? "localhost"
      : host.includes(":") && !host.startsWith("[")
        ? `[${host}]`
        : host;

  return {
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    manager,
    close: () =>
      new Promise<void>((resolve) => {
        manager.off("tunnel", onTunnel);
        manager.off("remove", onRemove);
        manager.off("request", onRequest);
        manager.off("clear", onClear);
        manager.closeAll();
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      })
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  manager: TunnelManager,
  defaults: ManagerDefaults
): Promise<void> {
  applySecurityHeaders(res);

  const url = new URL(req.url ?? "/", "http://dashboard.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Writes are only accepted from the dashboard itself, so another website
  // open in the browser cannot start or stop tunnels.
  if (method !== "GET" && method !== "HEAD" && !isSameOrigin(req)) {
    sendJson(res, 403, { error: "cross-origin request rejected" });
    return;
  }

  if (method === "GET" && STATIC_FILES[path]) {
    const { file, type } = STATIC_FILES[path]!;
    try {
      const body = await readFile(join(PUBLIC_DIR, file));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
    return;
  }

  if (path === "/api/health" && method === "GET") {
    sendJson(res, 200, { ok: true, tunnels: manager.count });
    return;
  }

  if (path === "/api/config" && method === "GET") {
    sendJson(res, 200, {
      defaults: {
        server: defaults.server,
        localHost: defaults.localHost,
        publicBase: defaults.publicBase,
        tokenConfigured: Boolean(defaults.token)
      },
      tunnels: manager.list(),
      version: "0.1.0"
    });
    return;
  }

  if (path === "/api/tunnels") {
    if (method === "GET") {
      sendJson(res, 200, manager.list());
      return;
    }
    if (method === "POST") {
      const body = await readJson(req);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new DashboardError("BAD_BODY", "request body must be a JSON object");
      }
      const tunnel = manager.create(body as CreateTunnelInput);
      sendJson(res, 201, tunnel);
      return;
    }
  }

  const tunnelMatch = /^\/api\/tunnels\/([^/]+)$/.exec(path);
  if (tunnelMatch) {
    const id = tunnelMatch[1]!;
    if (method === "GET") {
      sendJson(res, 200, manager.get(id).snapshot());
      return;
    }
    if (method === "DELETE") {
      manager.stop(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const requestsMatch = /^\/api\/tunnels\/([^/]+)\/requests$/.exec(path);
  if (requestsMatch) {
    const id = requestsMatch[1]!;
    if (method === "GET") {
      sendJson(res, 200, manager.requests(id));
      return;
    }
    if (method === "DELETE") {
      manager.clear(id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const requestMatch = /^\/api\/tunnels\/([^/]+)\/requests\/(\d+)$/.exec(path);
  if (requestMatch && method === "GET") {
    const detail = manager.request(requestMatch[1]!, Number(requestMatch[2]));
    if (detail) sendJson(res, 200, detail);
    else sendJson(res, 404, { error: "request not found", code: "NOT_FOUND" });
    return;
  }

  const replayMatch = /^\/api\/tunnels\/([^/]+)\/requests\/(\d+)\/replay$/.exec(path);
  if (replayMatch && method === "POST") {
    try {
      const replayed = await manager.replay(replayMatch[1]!, Number(replayMatch[2]));
      sendJson(res, 200, replayed);
    } catch (err) {
      if (err instanceof ReplayError) {
        sendJson(res, err.code === "NOT_FOUND" ? 404 : 409, { error: err.message, code: err.code });
        return;
      }
      throw err;
    }
    return;
  }

  sendJson(res, 404, { error: "not found", code: "NOT_FOUND" });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new DashboardError("BODY_TOO_LARGE", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DashboardError("BAD_JSON", "request body must be valid JSON");
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self' ws: wss:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and other non-browser clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function statusForCode(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "BODY_TOO_LARGE") return 413;
  if (code === "NO_INSPECTOR") return 409;
  return 400;
}
