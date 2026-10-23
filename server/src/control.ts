import { createServer } from "node:tls";
import { appendFileSync } from "node:fs";
import type { Server, TLSSocket } from "node:tls";
import {
  CONTROL_STREAM_ID,
  FrameType,
  decodeJson,
  frameTypeName
} from "@wormhole/protocol";
import type { AssignPayload, AuthPayload, ErrorPayload, Frame } from "@wormhole/protocol";
import type { Config } from "./config.ts";
import type { TlsCredentials } from "./certs.ts";
import { Mux, createLogger } from "@wormhole/transport";
import { isValidSubdomain, Tunnel, type TunnelRegistry, type TunnelSession } from "./registry.ts";
import { TunnelLimitError } from "./limits.ts";
import { PortPool } from "./ports.ts";
import { listenTcpTunnel, type TcpTunnel } from "./public-tcp.ts";
import { publicTcpUrl, publicUrl } from "./hosts.ts";

const log = createLogger("control");

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export interface ControlServerOptions {
  config: Config;
  credentials: TlsCredentials;
  registry: TunnelRegistry;
  /** Time a client has to send `AUTH` before the connection is dropped. */
  authTimeoutMs?: number;
}

/**
 * Create the TLS control listener. Clients connect, send an `AUTH` frame, and
 * receive an `ASSIGN` frame with their public URL or TCP port.
 */
export function createControlServer(options: ControlServerOptions): Server {
  const { config, credentials, registry } = options;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const ports = new PortPool(config.tcp.portStart, config.tcp.portEnd);

  const server = createServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
    handleConnection(socket, config, registry, ports, authTimeoutMs);
  });

  server.on("tlsClientError", (err) => log.debug(`TLS handshake failed: ${err.message}`));

  const keylogPath = process.env.WORMHOLE_TLS_KEYLOG;
  if (keylogPath) {
    server.on("keylog", (line) => {
      try {
        appendFileSync(keylogPath, line);
      } catch (err) {
        log.debug(`cannot write TLS key log: ${(err as Error).message}`);
      }
    });
  }

  return server;
}

type AuthState = "none" | "pending" | "done";

function handleConnection(
  socket: TLSSocket,
  config: Config,
  registry: TunnelRegistry,
  ports: PortPool,
  authTimeoutMs: number
): void {
  const mux = new Mux(socket, {
    heartbeatIntervalMs: config.heartbeat.intervalMs,
    heartbeatTimeoutMs: config.heartbeat.timeoutMs
  });

  let session: TunnelSession | undefined;
  let authState: AuthState = "none";

  const sendError = (code: string, message: string): void => {
    mux.sendJsonFrame(FrameType.ERROR, CONTROL_STREAM_ID, { code, message } satisfies ErrorPayload);
  };

  const authTimer = setTimeout(() => {
    if (authState !== "none") return;
    sendError("AUTH_TIMEOUT", "no AUTH frame received");
    mux.destroy();
  }, authTimeoutMs);
  authTimer.unref();

  mux.on("error", (err) => log.debug(`connection error: ${err.message}`));
  mux.on("close", () => {
    clearTimeout(authTimer);
    if (session) {
      registry.remove(session.subdomain);
      log.info(`tunnel ${session.subdomain} disconnected`);
    }
  });

  mux.on("control", (frame: Frame) => {
    if (frame.type === FrameType.AUTH) {
      void handleAuth(frame).catch((err: unknown) => {
        sendError("BAD_FRAME", (err as Error).message);
        mux.destroy();
      });
      return;
    }
    try {
      if (frame.type === FrameType.ERROR) {
        const payload = safeDecode<ErrorPayload>(frame);
        log.warn(`client reported error ${payload?.code}: ${payload?.message}`);
      } else {
        log.debug(`ignoring control frame ${frameTypeName(frame.type)}`);
      }
    } catch (err) {
      sendError("BAD_FRAME", (err as Error).message);
      mux.destroy();
    }
  });

  async function handleAuth(frame: Frame): Promise<void> {
    if (authState !== "none") {
      sendError("ALREADY_AUTH", "AUTH already received");
      return;
    }
    authState = "pending";

    const auth = decodeJson<AuthPayload>(frame);
    if (!auth || typeof auth.token !== "string" || (auth.type !== "http" && auth.type !== "tcp")) {
      sendError("BAD_AUTH", "invalid AUTH payload");
      mux.destroy();
      return;
    }
    if (!config.tokens.has(auth.token)) {
      sendError("BAD_TOKEN", "unknown token");
      mux.destroy();
      return;
    }
    if (auth.type === "tcp" && !config.tcp.enabled) {
      sendError("UNSUPPORTED", "TCP tunnels are disabled on this relay");
      mux.destroy();
      return;
    }

    const requested = auth.subdomain;
    if (requested !== undefined && !isValidSubdomain(requested)) {
      sendError("BAD_SUBDOMAIN", `invalid subdomain "${requested}"`);
      mux.destroy();
      return;
    }
    if (requested !== undefined && registry.has(requested)) {
      sendError("SUBDOMAIN_TAKEN", `subdomain "${requested}" is already in use`);
      mux.destroy();
      return;
    }

    const subdomain = requested ?? registry.generateSubdomain();
    authState = "done";
    clearTimeout(authTimer);

    let assign: AssignPayload;
    let created: Tunnel | undefined;
    let tcp: { listener: TcpTunnel; port: number } | undefined;

    try {
      if (auth.type === "tcp") {
        tcp = await openTcpTunnel(config, ports, () => {
          if (!created) throw new Error("tunnel is not ready");
          return created.openStream();
        });
        if (mux.isDestroyed) {
          ports.release(tcp.port);
          await tcp.listener.close();
          return;
        }
        created = new Tunnel({
          subdomain,
          type: "tcp",
          token: auth.token,
          limits: config.limits,
          openStream: () => mux.openStream(),
          close: async () => {
            ports.release(tcp!.port);
            await tcp!.listener.close();
          }
        });
        assign = { subdomain, port: tcp.port, url: publicTcpUrl(tcp.port, config) };
      } else {
        created = new Tunnel({
          subdomain,
          type: "http",
          token: auth.token,
          limits: config.limits,
          openStream: () => mux.openStream()
        });
        assign = { subdomain, url: publicUrl(subdomain, config) };
      }

      registry.add(created);
      session = created;
    } catch (err) {
      if (tcp) {
        ports.release(tcp.port);
        await tcp.listener.close();
      }
      if (err instanceof TunnelLimitError) {
        sendError(err.code, err.message);
      } else {
        sendError("TUNNEL_UNAVAILABLE", (err as Error).message);
      }
      mux.destroy();
      return;
    }

    mux.sendJsonFrame(FrameType.ASSIGN, CONTROL_STREAM_ID, assign);
    log.info(`tunnel assigned ${assign.url ?? `${assign.subdomain}:${assign.port}`}`);
  }
}

async function openTcpTunnel(
  config: Config,
  ports: PortPool,
  openStream: () => ReturnType<Mux["openStream"]>
): Promise<{ listener: TcpTunnel; port: number }> {
  const attempts = ports.size;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = ports.acquire();
    if (port === undefined) break;
    try {
      const listener = await listenTcpTunnel({
        bindHost: config.tcp.bindHost,
        port,
        openStream
      });
      return { listener, port: listener.port };
    } catch (err) {
      ports.release(port);
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("no free public TCP port in the configured range");
}

function safeDecode<T>(frame: Frame): T | undefined {
  try {
    return decodeJson<T>(frame);
  } catch {
    return undefined;
  }
}
