import type { Config, PublicScheme } from "./config.ts";
import { isValidSubdomain } from "./registry.ts";

/** Remove a trailing `:port` from a Host header value. */
export function stripPort(host: string): string {
  const index = host.lastIndexOf(":");
  if (index === -1) return host;
  return /^\d+$/.test(host.slice(index + 1)) ? host.slice(0, index) : host;
}

/** Fully-qualified public hostname for a tunnel, e.g. `swift-fox.localhost`. */
export function publicHostname(subdomain: string, config: Pick<Config, "publicHost">): string {
  return `${subdomain}.${config.publicHost}`;
}

export interface PublicUrlConfig {
  publicHost: string;
  /** Defaults to `http` for callers that predate HTTPS support. */
  publicScheme?: PublicScheme;
  /** Advertised port; falls back to `httpPort`. */
  publicPort?: number;
  httpPort?: number;
}

function isDefaultPort(scheme: PublicScheme, port: number): boolean {
  return (scheme === "http" && port === 80) || (scheme === "https" && port === 443);
}

/** Public URL advertised to a client in an `ASSIGN` frame. */
export function publicUrl(subdomain: string, config: PublicUrlConfig): string {
  const scheme = config.publicScheme ?? "http";
  const port = config.publicPort ?? config.httpPort ?? (scheme === "https" ? 443 : 80);
  const portSuffix = isDefaultPort(scheme, port) ? "" : `:${port}`;
  return `${scheme}://${publicHostname(subdomain, config)}${portSuffix}`;
}

/** Public endpoint advertised for a raw TCP tunnel. */
export function publicTcpUrl(port: number, config: Pick<Config, "publicHost">): string {
  return `tcp://${config.publicHost}:${port}`;
}

/**
 * Extract the tunnel subdomain from an incoming `Host` header, or `null` when
 * the request targets the bare public host or an unrelated host.
 */
export function subdomainFromHost(hostHeader: string | undefined, publicHost: string): string | null {
  if (!hostHeader) return null;
  const host = stripPort(hostHeader.trim().toLowerCase());
  const base = publicHost.trim().toLowerCase();
  if (host === base) return null;
  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) return null;
  const subdomain = host.slice(0, host.length - suffix.length);
  return isValidSubdomain(subdomain) ? subdomain : null;
}
