import { spawn } from "node:child_process";
import { DashboardError } from "./errors.ts";

export interface ServerAddress {
  host: string;
  port: number;
}

/** Parse `host:port`, accepting an optional `tls://` prefix and bracketed IPv6. */
export function parseServer(value: string): ServerAddress {
  const trimmed = value.trim().replace(/^tls:\/\//, "");
  if (!trimmed) throw new DashboardError("BAD_SERVER", "relay server is required");

  const colon = trimmed.lastIndexOf(":");
  const host = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const portText = colon === -1 ? "4443" : trimmed.slice(colon + 1);
  const port = Number(portText);

  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DashboardError("BAD_SERVER", `invalid relay server "${value}", expected host:port`);
  }
  return { host: host.replace(/^\[|\]$/g, ""), port };
}

/** Validate a local port from a JSON payload. */
export function parseLocalPort(value: unknown): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DashboardError("BAD_PORT", "local port must be an integer between 1 and 65535");
  }
  return port;
}

/** Normalise a requested subdomain; an empty value means "let the relay pick". */
export function normalizeSubdomain(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new DashboardError("BAD_SUBDOMAIN", "subdomain must be a string");
  }
  const subdomain = value.trim().toLowerCase();
  if (!subdomain) return undefined;
  if (subdomain.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    throw new DashboardError(
      "BAD_SUBDOMAIN",
      "public name must use lowercase letters, numbers and hyphens, and start/end with a letter or number"
    );
  }
  return subdomain;
}

/** True for addresses that keep the dashboard on this machine. */
export function isLoopback(host: string): boolean {
  const value = host.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

/** Open a URL in the user's default browser. Failures are best-effort. */
export function openBrowser(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {
      // The URL is printed by the CLI; opening it is only a convenience.
    });
    child.unref();
  } catch {
    // Ignore: the user can open the printed URL manually.
  }
}
