import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TunnelClient } from "@wormhole/client";
import type { TunnelClientOptions, TunnelError } from "@wormhole/client";
import { RequestStore } from "@wormhole/inspector";
import type { RequestDetail, RequestSummary } from "@wormhole/inspector";
import type { AssignPayload, TunnelType } from "@wormhole/protocol";
import { DashboardError } from "./errors.ts";
import { normalizeSubdomain, parseLocalPort, parseServer } from "./helpers.ts";
import type { ServerAddress } from "./helpers.ts";

/** Lifecycle shown on a tunnel card. */
export type TunnelState = "starting" | "online" | "reconnecting" | "offline";

/** The public, secret-free view of one tunnel. */
export interface TunnelSnapshot {
  id: string;
  type: TunnelType;
  localHost: string;
  localPort: number;
  state: TunnelState;
  url: string | null;
  subdomain: string | null;
  message: string | null;
  createdAt: number;
  streamCount: number;
  requestCount: number;
  errorCount: number;
}

/** Untrusted JSON from the dashboard. Everything is validated below. */
export interface CreateTunnelInput {
  type?: unknown;
  localPort?: unknown;
  localHost?: unknown;
  subdomain?: unknown;
  server?: unknown;
  token?: unknown;
  secure?: unknown;
  caPath?: unknown;
}

export interface ManagerDefaults {
  server: string;
  token: string;
  localHost: string;
  publicBase: string;
}

interface NormalizedTunnel {
  type: TunnelType;
  localPort: number;
  localHost: string;
  subdomain: string | undefined;
  server: ServerAddress;
  token: string;
  verifyCertificate: boolean;
  ca: Buffer | undefined;
}

interface ManagedTunnelCallbacks {
  update: (snapshot: TunnelSnapshot) => void;
  request: (summary: RequestSummary) => void;
  clear: () => void;
}

function requireString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new DashboardError("BAD_INPUT", `${field} must be a string`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeInput(input: CreateTunnelInput, defaults: ManagerDefaults): NormalizedTunnel {
  const typeValue = input.type ?? "http";
  if (typeValue !== "http" && typeValue !== "tcp") {
    throw new DashboardError("BAD_TYPE", 'tunnel type must be "http" or "tcp"');
  }

  const localPort = parseLocalPort(input.localPort);
  const localHost = requireString(input.localHost, "local host") ?? defaults.localHost;
  if (/\s/.test(localHost)) throw new DashboardError("BAD_LOCAL_HOST", "local host must not contain spaces");

  const serverValue = requireString(input.server, "relay server") ?? defaults.server;
  const server = parseServer(serverValue);

  const token = requireString(input.token, "token") ?? defaults.token;
  if (!token) throw new DashboardError("BAD_TOKEN", "an auth token is required");

  const caPath = requireString(input.caPath, "CA path");
  let ca: Buffer | undefined;
  if (caPath) {
    try {
      ca = readFileSync(resolve(caPath));
    } catch (err) {
      throw new DashboardError("BAD_CA", `cannot read CA file: ${(err as Error).message}`);
    }
  }

  return {
    type: typeValue,
    localPort,
    localHost,
    subdomain: normalizeSubdomain(input.subdomain),
    server,
    token,
    verifyCertificate: input.secure === true || ca !== undefined,
    ca
  };
}

class ManagedTunnel {
  readonly id: string;
  readonly type: TunnelType;
  readonly localHost: string;
  readonly localPort: number;
  readonly createdAt = Date.now();

  private readonly input: NormalizedTunnel;
  private readonly callbacks: ManagedTunnelCallbacks;
  private readonly server: ServerAddress;
  private readonly store: RequestStore | undefined;
  private client: TunnelClient | undefined;
  private statsTimer: NodeJS.Timeout | undefined;
  private lastStreamCount = 0;
  private state: TunnelState = "starting";
  private url: string | null = null;
  private subdomain: string | null = null;
  private message: string | null = null;
  private everOnline = false;
  private stopped = false;

  constructor(id: string, input: NormalizedTunnel, callbacks: ManagedTunnelCallbacks) {
    this.id = id;
    this.input = input;
    this.callbacks = callbacks;
    this.type = input.type;
    this.localHost = input.localHost;
    this.localPort = input.localPort;
    this.server = input.server;
    this.subdomain = input.subdomain ?? null;

    if (input.type === "http") {
      this.store = new RequestStore({ target: { host: input.localHost, port: input.localPort } });
      this.store.on("upsert", (summary: RequestSummary) => this.callbacks.request(summary));
      this.store.on("clear", () => this.callbacks.clear());
    }
  }

  /** Start connecting. Status updates are pushed through `callbacks.update`. */
  start(): void {
    const options: TunnelClientOptions = {
      serverHost: this.input.server.host,
      serverPort: this.input.server.port,
      token: this.input.token,
      type: this.input.type,
      localPort: this.input.localPort,
      localHost: this.input.localHost,
      subdomain: this.input.subdomain,
      verifyCertificate: this.input.verifyCertificate,
      ca: this.input.ca,
      reconnect: true
    };
    if (this.store) options.observe = (streamId) => this.store!.observe(streamId);

    const client = new TunnelClient(options);
    this.client = client;

    // TCP tunnels have no request store, so poll the client's stream table to
    // keep the "active connections" count on the card fresh.
    if (this.input.type === "tcp") {
      this.statsTimer = setInterval(() => {
        const count = this.client?.streamCount ?? 0;
        if (count !== this.lastStreamCount) {
          this.lastStreamCount = count;
          this.publish();
        }
      }, 1500);
      this.statsTimer.unref();
    }

    client.on("connecting", ({ attempt }: { attempt: number }) => {
      this.state = this.everOnline || attempt > 1 ? "reconnecting" : "starting";
      this.message = this.state === "reconnecting" ? "Reconnecting to the relay…" : "Connecting to the relay…";
      this.publish();
    });

    client.on("assigned", (assign: AssignPayload) => {
      this.everOnline = true;
      this.state = "online";
      this.subdomain = assign.subdomain;
      this.url =
        assign.url ??
        (this.type === "tcp" && assign.port !== undefined
          ? `tcp://${this.server.host}:${assign.port}`
          : assign.subdomain);
      this.message = null;
      this.publish();
    });

    client.on("disconnected", ({ reason }: { reason: string }) => {
      this.state = "reconnecting";
      this.message = reason;
      this.publish();
    });

    client.on("reconnecting", ({ delayMs, reason }: { delayMs: number; reason: string }) => {
      this.state = "reconnecting";
      this.message = `${reason} · retrying in ${(delayMs / 1000).toFixed(1)}s`;
      this.publish();
    });

    client.on("fatal", (err: TunnelError) => {
      this.clearStatsTimer();
      this.state = "offline";
      this.message = err.message;
      this.publish();
    });

    client.on("closed", () => {
      if (this.stopped) return;
      this.state = "offline";
      this.message = "Tunnel closed";
      this.publish();
    });

    // Fatal errors are surfaced through the event above. Network errors retry
    // forever, so there is nothing useful to do with this rejection.
    client.start().catch(() => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearStatsTimer();
    this.client?.close();
  }

  snapshot(): TunnelSnapshot {
    return {
      id: this.id,
      type: this.type,
      localHost: this.localHost,
      localPort: this.localPort,
      state: this.state,
      url: this.url,
      subdomain: this.subdomain,
      message: this.message,
      createdAt: this.createdAt,
      streamCount: this.client?.streamCount ?? 0,
      requestCount: this.store?.size ?? 0,
      errorCount: this.errorCount()
    };
  }

  requests(): RequestSummary[] {
    return this.store?.list() ?? [];
  }

  request(requestId: number): RequestDetail | undefined {
    return this.store?.get(requestId);
  }

  replay(requestId: number): Promise<RequestSummary> {
    if (!this.store) {
      throw new DashboardError("NO_INSPECTOR", "TCP tunnels do not capture HTTP requests");
    }
    return this.store.replay(requestId);
  }

  clear(): void {
    this.store?.clear();
  }

  private errorCount(): number {
    if (!this.store) return 0;
    return this.store.list().filter((request) => request.state === "error" || (request.status ?? 0) >= 500).length;
  }

  private clearStatsTimer(): void {
    if (!this.statsTimer) return;
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  private publish(): void {
    this.callbacks.update(this.snapshot());
  }
}

/**
 * Owns every tunnel started from the dashboard. Each tunnel is an independent
 * `TunnelClient` (and, for HTTP, its own `RequestStore`), so the browser is
 * only a view over long-lived server-side connections.
 *
 * Events:
 * - `tunnel` `(snapshot)`          — created or changed
 * - `remove` `(id)`                — stopped
 * - `request` `(id, summary)`      — a captured request changed
 * - `clear` `(id)`                 — request log cleared
 */
export class TunnelManager extends EventEmitter {
  private readonly tunnels = new Map<string, ManagedTunnel>();
  private nextId = 1;

  constructor(readonly defaults: ManagerDefaults) {
    super();
  }

  get count(): number {
    return this.tunnels.size;
  }

  create(input: CreateTunnelInput): TunnelSnapshot {
    const normalized = normalizeInput(input, this.defaults);
    const id = `t${this.nextId++}`;
    const tunnel = new ManagedTunnel(id, normalized, {
      update: (snapshot) => this.emit("tunnel", snapshot),
      request: (summary) => this.emit("request", id, summary),
      clear: () => this.emit("clear", id)
    });

    this.tunnels.set(id, tunnel);
    tunnel.start();

    const snapshot = tunnel.snapshot();
    this.emit("tunnel", snapshot);
    return snapshot;
  }

  list(): TunnelSnapshot[] {
    return [...this.tunnels.values()].map((tunnel) => tunnel.snapshot());
  }

  get(id: string): ManagedTunnel {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) throw new DashboardError("NOT_FOUND", `no tunnel with id ${id}`);
    return tunnel;
  }

  stop(id: string): void {
    const tunnel = this.get(id);
    tunnel.stop();
    this.tunnels.delete(id);
    this.emit("remove", id);
  }

  requests(id: string): RequestSummary[] {
    return this.get(id).requests();
  }

  request(id: string, requestId: number): RequestDetail | undefined {
    return this.get(id).request(requestId);
  }

  replay(id: string, requestId: number): Promise<RequestSummary> {
    return this.get(id).replay(requestId);
  }

  clear(id: string): void {
    this.get(id).clear();
  }

  closeAll(): void {
    const tunnels = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const tunnel of tunnels) tunnel.stop();
  }
}
