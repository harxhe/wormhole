import { randomBytes } from "node:crypto";
import type { TunnelType } from "@wormhole/protocol";
import type { Stream } from "./mux.ts";

/** An authenticated tunnel that can open streams on its control connection. */
export interface TunnelSession {
  readonly subdomain: string;
  readonly type: TunnelType;
  openStream(): Stream;
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

/** Maps assigned subdomains to the tunnels that own them. */
export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelSession>();

  get size(): number {
    return this.tunnels.size;
  }

  has(subdomain: string): boolean {
    return this.tunnels.has(subdomain);
  }

  get(subdomain: string): TunnelSession | undefined {
    return this.tunnels.get(subdomain);
  }

  /** Register a tunnel. Throws if the subdomain is already taken. */
  add(tunnel: TunnelSession): void {
    if (this.tunnels.has(tunnel.subdomain)) {
      throw new Error(`subdomain already registered: ${tunnel.subdomain}`);
    }
    this.tunnels.set(tunnel.subdomain, tunnel);
  }

  remove(subdomain: string): void {
    this.tunnels.delete(subdomain);
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
