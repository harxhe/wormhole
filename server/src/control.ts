import { createServer } from "node:tls";
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
import { isValidSubdomain, type TunnelRegistry, type TunnelSession } from "./registry.ts";
import { publicUrl } from "./hosts.ts";

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
 * receive an `ASSIGN` frame with their public URL.
 */
export function createControlServer(options: ControlServerOptions): Server {
  const { config, credentials, registry } = options;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

  const server = createServer({ key: credentials.key, cert: credentials.cert }, (socket) => {
    handleConnection(socket, config, registry, authTimeoutMs);
  });

  server.on("tlsClientError", (err) => log.debug(`TLS handshake failed: ${err.message}`));

  return server;
}

function handleConnection(socket: TLSSocket, config: Config, registry: TunnelRegistry, authTimeoutMs: number): void {
  const mux = new Mux(socket, {
    heartbeatIntervalMs: config.heartbeat.intervalMs,
    heartbeatTimeoutMs: config.heartbeat.timeoutMs
  });

  let session: TunnelSession | undefined;
  let authed = false;

  const sendError = (code: string, message: string): void => {
    mux.sendJsonFrame(FrameType.ERROR, CONTROL_STREAM_ID, { code, message } satisfies ErrorPayload);
  };

  const authTimer = setTimeout(() => {
    if (authed) return;
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
    try {
      if (frame.type === FrameType.AUTH) {
        handleAuth(frame);
      } else if (frame.type === FrameType.ERROR) {
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

  function handleAuth(frame: Frame): void {
    if (authed) {
      sendError("ALREADY_AUTH", "AUTH already received");
      return;
    }

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
    if (auth.type !== "http") {
      sendError("UNSUPPORTED", `tunnel type "${auth.type}" is not supported yet`);
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
    session = { subdomain, type: auth.type, openStream: () => mux.openStream() };
    registry.add(session);
    authed = true;
    clearTimeout(authTimer);

    const assign: AssignPayload = { subdomain, url: publicUrl(subdomain, config) };
    mux.sendJsonFrame(FrameType.ASSIGN, CONTROL_STREAM_ID, assign);
    log.info(`tunnel assigned ${assign.url}`);
  }
}

function safeDecode<T>(frame: Frame): T | undefined {
  try {
    return decodeJson<T>(frame);
  } catch {
    return undefined;
  }
}
