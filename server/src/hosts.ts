import type { Config } from "./config.ts";
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

/** Public URL advertised to a client in an `ASSIGN` frame. */
export function publicUrl(subdomain: string, config: Pick<Config, "publicHost" | "httpPort">): string {
  const port = config.httpPort === 80 ? "" : `:${config.httpPort}`;
  return `http://${publicHostname(subdomain, config)}${port}`;
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
