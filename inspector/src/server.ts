import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { ReplayError } from "./store.ts";
import type { RequestStore, RequestSummary, TunnelStatus } from "./store.ts";

/** Default inspector port, as in the implementation plan. */
export const DEFAULT_INSPECTOR_PORT = 4040;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

/** Messages pushed to the dashboard over the WebSocket. */
export type InspectorMessage =
  | { type: "snapshot"; requests: RequestSummary[]; status: TunnelStatus }
  | { type: "upsert"; request: RequestSummary }
  | { type: "clear" }
  | { type: "status"; status: TunnelStatus };

export interface InspectorServerOptions {
  store: RequestStore;
  /** Port to listen on (default 4040; `0` picks a free port). */
  port?: number;
  /** Interface to bind (default `127.0.0.1`, never exposed publicly). */
  host?: string;
}

export interface InspectorServer {
  /** The port actually bound. */
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Start the inspector dashboard: static HTML/JS, a small JSON API, and a
 * WebSocket at `/ws` that pushes every request change live.
 *
 * | Method | Path | Purpose |
 * |---|---|---|
 * | GET | `/api/requests` | Summaries, newest first |
 * | GET | `/api/requests/:id` | Headers and body previews |
 * | POST | `/api/requests/:id/replay` | Re-send the request to the local app |
 * | DELETE | `/api/requests` | Clear the log |
 * | GET | `/api/status` | Tunnel status |
 */
export async function startInspectorServer(options: InspectorServerOptions): Promise<InspectorServer> {
  const { store } = options;
  const host = options.host ?? "127.0.0.1";

  const http = createServer((req, res) => {
    handle(req, res, store).catch((err: Error) => sendJson(res, 500, { error: err.message }));
  });

  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    verifyClient: ({ req }: { req: IncomingMessage }) => isSameOrigin(req)
  });

  const broadcast = (message: InspectorMessage): void => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  const onUpsert = (request: RequestSummary): void => broadcast({ type: "upsert", request });
  const onClear = (): void => broadcast({ type: "clear" });
  const onStatus = (status: TunnelStatus): void => broadcast({ type: "status", status });
  store.on("upsert", onUpsert);
  store.on("clear", onClear);
  store.on("status", onStatus);

  wss.on("connection", (socket: WebSocket) => {
    socket.on("error", () => socket.terminate());
    const snapshot: InspectorMessage = { type: "snapshot", requests: store.list(), status: store.status };
    socket.send(JSON.stringify(snapshot));
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? DEFAULT_INSPECTOR_PORT, host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  const port = (http.address() as AddressInfo).port;

  return {
    port,
    url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        store.off("upsert", onUpsert);
        store.off("clear", onClear);
        store.off("status", onStatus);
        for (const client of wss.clients) client.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      })
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, store: RequestStore): Promise<void> {
  const url = new URL(req.url ?? "/", "http://inspector.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Writes are only accepted from the dashboard itself, so another website open
  // in the browser cannot trigger replays against the local app.
  if (method !== "GET" && method !== "HEAD" && !isSameOrigin(req)) {
    sendJson(res, 403, { error: "cross-origin request rejected" });
    return;
  }

  if (method === "GET" && STATIC_FILES[path]) {
    const { file, type } = STATIC_FILES[path]!;
    const body = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
    return;
  }

  if (path === "/api/status" && method === "GET") {
    sendJson(res, 200, store.status);
    return;
  }

  if (path === "/api/requests") {
    if (method === "GET") {
      sendJson(res, 200, store.list());
      return;
    }
    if (method === "DELETE") {
      store.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const match = /^\/api\/requests\/(\d+)(\/replay)?$/.exec(path);
  if (match) {
    const id = Number(match[1]);
    if (!match[2] && method === "GET") {
      const detail = store.get(id);
      if (detail) sendJson(res, 200, detail);
      else sendJson(res, 404, { error: `no request with id ${id}` });
      return;
    }
    if (match[2] && method === "POST") {
      try {
        const replayed = await store.replay(id);
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
  }

  sendJson(res, 404, { error: "not found" });
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
