import { randomBytes } from "node:crypto";
import type { TunnelType } from "@wormhole/protocol";
import type { Stream } from "@wormhole/transport";
import type { LimitsConfig } from "./config.ts";
import { SlidingWindowLimiter, TunnelLimitError } from "./limits.ts";

/** An authenticated tunnel that can open streams on its control connection. */
export interface TunnelSession {
  readonly subdomain: string;
  readonly type: TunnelType;
  /** Token that authenticated this tunnel, used for per-token caps. */
  readonly token: string;
  /** Public streams (HTTP requests or TCP connections) currently open. */
  readonly streamCount: number;
  openStream(): Stream;
  /** Release listener/port resources owned by this tunnel. */
  close(): void | Promise<void>;
}

export interface TunnelOptions {
  subdomain: string;
  type: TunnelType;
  token: string;
  limits: LimitsConfig;
  openStream: () => Stream;
  close?: () => void | Promise<void>;
}

/**
 * A registered tunnel. Enforces the per-tunnel concurrency and request-rate
 * caps before delegating to the underlying multiplexer.
 */
export class Tunnel implements TunnelSession {
  readonly subdomain: string;
  readonly type: TunnelType;
  readonly token: string;

  private readonly limits: LimitsConfig;
  private readonly openStreamImpl: () => Stream;
  private readonly closeImpl: (() => void | Promise<void>) | undefined;
  private readonly limiter: SlidingWindowLimiter;
  private activeStreams = 0;
  private closed = false;

  constructor(options: TunnelOptions) {
    this.subdomain = options.subdomain;
    this.type = options.type;
    this.token = options.token;
    this.limits = options.limits;
    this.openStreamImpl = options.openStream;
    this.closeImpl = options.close;
    this.limiter = new SlidingWindowLimiter(options.limits.requestsPerMinute);
  }

  get streamCount(): number {
    return this.activeStreams;
  }

  openStream(): Stream {
    if (this.closed) {
      throw new TunnelLimitError("TOO_MANY_STREAMS", `tunnel "${this.subdomain}" is closing`, 1000);
    }
    const max = this.limits.maxStreamsPerTunnel;
    if (max > 0 && this.activeStreams >= max) {
      throw new TunnelLimitError(
        "TOO_MANY_STREAMS",
        `tunnel "${this.subdomain}" has reached its limit of ${max} concurrent streams`,
        1000
      );
    }

    const decision = this.limiter.take();
    if (!decision.allowed) {
      throw new TunnelLimitError(
        "RATE_LIMITED",
        `tunnel "${this.subdomain}" is over its request rate limit`,
        decision.retryAfterMs
      );
    }

    const stream = this.openStreamImpl();
    this.activeStreams += 1;
    stream.once("close", () => {
      this.activeStreams = Math.max(0, this.activeStreams - 1);
    });
    return stream;
  }

  close(): void | Promise<void> {
    if (this.closed) return;
    this.closed = true;
    return this.closeImpl?.();
  }
}

const ADJECTIVES = [
  "swift",
  "brave",
  "calm",
  "bold",
  "lucky",
  "quiet",
  "witty",
  "vivid",
  "sunny",
  "cosmic",
  "rapid",
  "clever",
  "gentle",
  "noble",
  "frosty",
  "amber",
  "zesty",
  "mellow"
];

const NOUNS = [
  "fox",
  "otter",
  "panda",
  "lynx",
  "hawk",
  "willow",
  "river",
  "comet",
  "ember",
  "cedar",
  "maple",
  "falcon",
  "badger",
  "heron",
  "raven",
  "pebble",
  "aurora",
  "quartz"
];

const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Validate a DNS label suitable for use as a tunnel subdomain. */
export function isValidSubdomain(value: string): boolean {
  return value.length >= 1 && value.length <= 63 && SUBDOMAIN_PATTERN.test(value);
}

function pick<T>(items: readonly T[]): T {
  return items[randomBytes(1)[0]! % items.length]!;
}

export interface RegistryOptions {
  /** Maximum active tunnels per token; `0` disables the cap. */
  maxTunnelsPerToken?: number;
}

/** Maps assigned subdomains to the tunnels that own them. */
export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelSession>();
  private readonly maxTunnelsPerToken: number;

  constructor(options: RegistryOptions = {}) {
    this.maxTunnelsPerToken = options.maxTunnelsPerToken ?? 0;
  }

  get size(): number {
    return this.tunnels.size;
  }

  has(subdomain: string): boolean {
    return this.tunnels.has(subdomain);
  }

  get(subdomain: string): TunnelSession | undefined {
    return this.tunnels.get(subdomain);
  }

  countForToken(token: string): number {
    let count = 0;
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.token === token) count += 1;
    }
    return count;
  }

  /** Register a tunnel. Throws if the subdomain or token cap is exhausted. */
  add(tunnel: TunnelSession): void {
    if (this.tunnels.has(tunnel.subdomain)) {
      throw new Error(`subdomain already registered: ${tunnel.subdomain}`);
    }
    if (this.maxTunnelsPerToken > 0 && this.countForToken(tunnel.token) >= this.maxTunnelsPerToken) {
      throw new TunnelLimitError(
        "TOO_MANY_TUNNELS",
        `token already owns ${this.maxTunnelsPerToken} active tunnels`,
        0
      );
    }
    this.tunnels.set(tunnel.subdomain, tunnel);
  }

  remove(subdomain: string): void {
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;
    this.tunnels.delete(subdomain);
    void tunnel.close();
  }

  /** Remove every tunnel and release their resources (graceful shutdown). */
  async closeAll(): Promise<void> {
    const tunnels = [...this.tunnels.values()];
    this.tunnels.clear();
    await Promise.allSettled(tunnels.map((tunnel) => tunnel.close()));
  }

  subdomains(): string[] {
    return [...this.tunnels.keys()];
  }

  /** Generate an unused, human-friendly subdomain. */
  generateSubdomain(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
      if (!this.tunnels.has(candidate)) return candidate;
    }
    let candidate: string;
    do {
      candidate = `${pick(ADJECTIVES)}-${pick(NOUNS)}-${randomBytes(2).toString("hex")}`;
    } while (this.tunnels.has(candidate));
    return candidate;
  }
}
