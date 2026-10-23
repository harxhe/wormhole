import { EventEmitter } from "node:events";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import {
  CONTROL_STREAM_ID,
  FrameType,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  decodeJson
} from "@wormhole/protocol";
import type { AssignPayload, AuthPayload, ErrorPayload, Frame, TunnelType } from "@wormhole/protocol";
import { Mux } from "@wormhole/transport";
import type { StreamObserver } from "@wormhole/inspector";
import { Backoff } from "./backoff.ts";
import type { BackoffOptions } from "./backoff.ts";
import { proxyRawStream, proxyStream } from "./local.ts";

/** Time allowed between TLS connect and `ASSIGN` before the attempt is dropped. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Server `ERROR` codes that retrying cannot fix. Any other failure (network
 * error, heartbeat timeout, server restart) triggers a reconnect.
 */
const FATAL_SERVER_CODES = new Set(["BAD_TOKEN", "BAD_AUTH", "UNSUPPORTED", "BAD_SUBDOMAIN"]);

/** TLS verification failures are configuration problems, not transient ones. */
const FATAL_TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);

export type ClientState = "idle" | "connecting" | "online" | "reconnecting" | "closed";

export interface TunnelClientOptions {
  /** Relay server host (control listener). */
  serverHost: string;
  /** Relay server TLS control port. */
  serverPort: number;
  token: string;
  /** Tunnel protocol. HTTP is the default; TCP exposed raw connections. */
  type?: TunnelType;
  /** Local app to expose. */
  localPort: number;
  /** Host of the local app (default `localhost`, as in the implementation plan). */
  localHost?: string;
  /** Requested subdomain; the server picks one when omitted. */
  subdomain?: string;
  /** Verify the server certificate (default `false`: the dev server is self-signed). */
  verifyCertificate?: boolean;
  /** Extra CA certificate(s) to trust when verifying (e.g. the server's self-signed cert). */
  ca?: Buffer | string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Reconnect automatically after a lost connection (default `true`). */
  reconnect?: boolean;
  backoff?: BackoffOptions;
  /** Inspector hook: return an observer to record a stream. */
  observe?: (streamId: number) => StreamObserver | undefined;
}

/** One row of the client's stream table. */
export interface StreamEntry {
  id: number;
  openedAt: number;
}

export class TunnelError extends Error {
  /** Server `ERROR` code or socket error code. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
  }
}

/**
 * Wormhole tunnel client. Opens one TLS connection to the relay, authenticates,
 * and proxies every stream the server opens to the local app.
 *
 * Events:
 * - `connecting`   `({ attempt })`                — dialing the relay
 * - `assigned`     `(assign, { reconnected })`    — tunnel is live
 * - `disconnected` `({ reason })`                 — the connection was lost
 * - `reconnecting` `({ attempt, delayMs, reason })` — next attempt is scheduled
 * - `fatal`        `(err: TunnelError)`           — gave up; the client is closed
 * - `closed`       `()`                           — `close()` finished
 */
export class TunnelClient extends EventEmitter {
  private readonly options: TunnelClientOptions;
  private readonly backoff: Backoff;
  private socket: TLSSocket | undefined;
  private mux: Mux | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private currentState: ClientState = "idle";
  private assignment: AssignPayload | undefined;
  /** Subdomain to ask for: the user's choice, then whatever we were given. */
  private subdomain: string | undefined;
  private everAssigned = false;
  private attempt = 0;
  /** Stream table: one entry per stream the server has opened and not yet closed. */
  private readonly streamTable = new Map<number, StreamEntry>();
  private startPromise: Promise<AssignPayload> | undefined;
  private resolveStart: ((assign: AssignPayload) => void) | undefined;
  private rejectStart: ((err: Error) => void) | undefined;

  constructor(options: TunnelClientOptions) {
    super();
    this.options = options;
    this.subdomain = options.subdomain;
    this.backoff = new Backoff(options.backoff);
  }

  get state(): ClientState {
    return this.currentState;
  }

  /** The current assignment (subdomain and public URL), once online. */
  get assigned(): AssignPayload | undefined {
    return this.assignment;
  }

  /** Streams currently being proxied. */
  get streamCount(): number {
    return this.streamTable.size;
  }

  /** Snapshot of the stream table. */
  get streams(): StreamEntry[] {
    return [...this.streamTable.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Connect and authenticate. Resolves with the first `ASSIGN`. Rejects only on
   * a fatal error (bad token, subdomain taken, certificate failure); network
   * failures are retried with backoff.
   */
  start(): Promise<AssignPayload> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<AssignPayload>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.connect();
    return this.startPromise;
  }

  /** Close the tunnel and every stream. No reconnect follows. */
  close(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    this.clearTimers();
    this.teardown();
    this.rejectStart?.(new TunnelError("CLOSED", "client closed"));
    this.emit("closed");
  }

  private connect(): void {
    if (this.currentState === "closed") return;
    this.attempt += 1;
    this.currentState = this.everAssigned || this.attempt > 1 ? "reconnecting" : "connecting";
    this.emit("connecting", { attempt: this.attempt });

    const host = this.options.serverHost;
    const socket = tlsConnect({
      host,
      port: this.options.serverPort,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: this.options.verifyCertificate ?? false,
      ca: this.options.ca
    });
    this.socket = socket;

    let lastError: TunnelError | undefined;
    let handled = false;

    // A failure at any point (TLS, AUTH rejected, heartbeat timeout, server
    // gone) ends up here exactly once per attempt.
    const onLost = (reason: TunnelError): void => {
      if (handled) return;
      handled = true;
      this.clearHandshakeTimer();
      this.mux = undefined;
      this.socket = undefined;
      if (this.currentState === "closed") return;
      const err = lastError ?? reason;
      const wasOnline = this.currentState === "online";
      this.assignment = undefined;
      if (wasOnline) this.emit("disconnected", { reason: err.message });

      if (this.isFatal(err) || this.options.reconnect === false) {
        this.fail(err);
        return;
      }
      this.scheduleReconnect(err);
    };

    socket.on("error", (err: NodeJS.ErrnoException) => {
      lastError ??= new TunnelError(err.code ?? "SOCKET_ERROR", describeSocketError(err, this.options));
      if (!this.mux) onLost(lastError);
    });
    socket.on("close", () => {
      if (!this.mux) onLost(lastError ?? new TunnelError("CONNECTION_CLOSED", "connection closed"));
    });

    socket.once("secureConnect", () => {
      if (this.currentState === "closed") {
        socket.destroy();
        return;
      }
      const mux = new Mux(socket, {
        heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
        heartbeatTimeoutMs: this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
      });
      this.mux = mux;

      mux.on("error", (err: Error) => {
        lastError ??= new TunnelError(
          err.message === "heartbeat timeout" ? "HEARTBEAT_TIMEOUT" : "CONNECTION_ERROR",
          err.message === "heartbeat timeout" ? "no traffic from the server for too long" : err.message
        );
      });
      mux.on("close", () => onLost(lastError ?? new TunnelError("CONNECTION_CLOSED", "server closed the connection")));

      mux.on("control", (frame: Frame) => {
        if (frame.type === FrameType.ASSIGN) {
          this.onAssign(frame);
        } else if (frame.type === FrameType.ERROR && frame.streamId === CONTROL_STREAM_ID) {
          const payload = safeDecode<ErrorPayload>(frame);
          const code = payload?.code ?? "SERVER_ERROR";
          lastError = new TunnelError(code, payload?.message ?? "server reported an error");
        }
      });

      mux.on("open", (streamId: number) => this.onOpen(mux, streamId));

      this.handshakeTimer = setTimeout(() => {
        lastError ??= new TunnelError("HANDSHAKE_TIMEOUT", "server did not answer AUTH");
        mux.destroy();
      }, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
      this.handshakeTimer.unref();

      const auth: AuthPayload = { token: this.options.token, type: this.options.type ?? "http" };
      if (this.subdomain) auth.subdomain = this.subdomain;
      if (this.options.localPort) auth.port = this.options.localPort;
      mux.sendJsonFrame(FrameType.AUTH, CONTROL_STREAM_ID, auth);
    });
  }

  private onAssign(frame: Frame): void {
    this.clearHandshakeTimer();
    const assign = decodeJson<AssignPayload>(frame);
    const reconnected = this.everAssigned;
    this.assignment = assign;
    this.subdomain = assign.subdomain;
    this.everAssigned = true;
    this.currentState = "online";
    this.attempt = 0;
    this.backoff.reset();
    this.emit("assigned", assign, { reconnected });
    this.resolveStart?.(assign);
  }

  private onOpen(mux: Mux, streamId: number): void {
    const stream = mux.acceptStream(streamId);
    if (this.currentState !== "online") {
      // OPEN before ASSIGN is a server bug; refuse the stream instead of leaving it hanging.
      stream.close();
      return;
    }
    this.streamTable.set(streamId, { id: streamId, openedAt: Date.now() });
    const proxyOptions = {
      stream,
      target: { host: this.options.localHost ?? "localhost", port: this.options.localPort },
      observer: this.options.observe?.(streamId),
      reportError: (error: { code: string; message: string }) =>
        mux.sendJsonFrame(FrameType.ERROR, streamId, error),
      onDone: () => {
        this.streamTable.delete(streamId);
      }
    };
    if ((this.options.type ?? "http") === "tcp") proxyRawStream(proxyOptions);
    else proxyStream(proxyOptions);
  }

  private isFatal(err: TunnelError): boolean {
    if (FATAL_SERVER_CODES.has(err.code) || FATAL_TLS_CODES.has(err.code)) return true;
    // A name we asked for and never got is someone else's. After we have held
    // it, SUBDOMAIN_TAKEN usually means the server has not yet noticed our old
    // connection died, so keep retrying until it frees the name.
    if (err.code === "SUBDOMAIN_TAKEN") return !this.everAssigned;
    return false;
  }

  private scheduleReconnect(reason: TunnelError): void {
    this.currentState = "reconnecting";
    const delayMs = this.backoff.next();
    this.emit("reconnecting", { attempt: this.backoff.attempts, delayMs, reason: reason.message });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delayMs);
  }

  private fail(err: TunnelError): void {
    this.currentState = "closed";
    this.clearTimers();
    this.teardown();
    this.emit("fatal", err);
    this.rejectStart?.(err);
  }

  private teardown(): void {
    const mux = this.mux;
    const socket = this.socket;
    this.mux = undefined;
    this.socket = undefined;
    this.assignment = undefined;
    if (mux) mux.destroy();
    else socket?.destroy();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearHandshakeTimer();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}

function safeDecode<T>(frame: Frame): T | undefined {
  try {
    return decodeJson<T>(frame);
  } catch {
    return undefined;
  }
}

function describeSocketError(err: NodeJS.ErrnoException, options: TunnelClientOptions): string {
  const where = `${options.serverHost}:${options.serverPort}`;
  switch (err.code) {
    case "ECONNREFUSED":
      return `relay server refused the connection at ${where}`;
    case "ENOTFOUND":
      return `relay host not found: ${options.serverHost}`;
    case "ETIMEDOUT":
      return `timed out connecting to ${where}`;
    case "ECONNRESET":
      return "connection reset by the relay server";
    default:
      return FATAL_TLS_CODES.has(err.code ?? "")
        ? `certificate check failed (${err.code}); pass --ca <cert> or drop --secure for a self-signed dev server`
        : err.message;
  }
}
