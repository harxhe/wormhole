import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CertConfig {
  dir: string;
  keyPath: string;
  certPath: string;
  commonName: string;
  altNames: string[];
  days: number;
}

export interface HeartbeatConfig {
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Per-tunnel safety limits. A value of `0` disables that particular limit.
 */
export interface LimitsConfig {
  /** Maximum concurrent public streams (requests or TCP connections) per tunnel. */
  maxStreamsPerTunnel: number;
  /** Maximum active tunnels that one token may own. */
  maxTunnelsPerToken: number;
  /** Maximum new streams a single tunnel may open in a minute. */
  requestsPerMinute: number;
}

export interface TcpConfig {
  enabled: boolean;
  /** Interface the per-tunnel TCP listeners bind to. */
  bindHost: string;
  /** Inclusive range of public ports handed out to TCP tunnels. */
  portStart: number;
  portEnd: number;
}

export type PublicScheme = "http" | "https";

export interface Config {
  controlPort: number;
  httpPort: number;
  publicHost: string;
  /** Scheme advertised to clients; use `https` when a reverse proxy terminates TLS. */
  publicScheme: PublicScheme;
  /** Port advertised in public URLs; defaults to `httpPort`. */
  publicPort: number;
  tokens: Set<string>;
  heartbeat: HeartbeatConfig;
  limits: LimitsConfig;
  tcp: TcpConfig;
  cert: CertConfig;
}

const DEFAULT_LIMITS: LimitsConfig = {
  maxStreamsPerTunnel: 50,
  maxTunnelsPerToken: 5,
  requestsPerMinute: 600
};

const DEFAULT_TCP: TcpConfig = {
  enabled: true,
  bindHost: "0.0.0.0",
  portStart: 15000,
  portEnd: 15999
};

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${field}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalInt(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return requireInt(value, field, min, max);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return requireString(value, field);
}

function requireBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`"${field}" must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    throw new ConfigError(`"${field}" must be a non-empty array of strings`);
  }
  return value as string[];
}

function optionalMapping(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`"${field}" must be a mapping`);
  }
  return value as Record<string, unknown>;
}

export interface LoadConfigOptions {
  /** Directory used to resolve relative paths (e.g. the cert directory). */
  baseDir: string;
}

export function parseConfig(raw: unknown, options: LoadConfigOptions): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("Config root must be a mapping");
  }
  const obj = raw as Record<string, unknown>;

  const publicHost = requireString(obj.publicHost, "publicHost");
  const tokens = new Set(requireStringArray(obj.tokens, "tokens"));

  const heartbeatObj = optionalMapping(obj.heartbeat, "heartbeat");
  const heartbeat: HeartbeatConfig = {
    intervalMs: optionalInt(heartbeatObj.intervalMs, "heartbeat.intervalMs", 1, 3_600_000, 10000),
    timeoutMs: optionalInt(heartbeatObj.timeoutMs, "heartbeat.timeoutMs", 1, 3_600_000, 30000)
  };
  if (heartbeat.timeoutMs <= heartbeat.intervalMs) {
    throw new ConfigError('"heartbeat.timeoutMs" must be greater than "heartbeat.intervalMs"');
  }

  const limitsObj = optionalMapping(obj.limits, "limits");
  const limits: LimitsConfig = {
    maxStreamsPerTunnel: optionalInt(
      limitsObj.maxStreamsPerTunnel,
      "limits.maxStreamsPerTunnel",
      0,
      1_000_000,
      DEFAULT_LIMITS.maxStreamsPerTunnel
    ),
    maxTunnelsPerToken: optionalInt(
      limitsObj.maxTunnelsPerToken,
      "limits.maxTunnelsPerToken",
      0,
      1_000_000,
      DEFAULT_LIMITS.maxTunnelsPerToken
    ),
    requestsPerMinute: optionalInt(
      limitsObj.requestsPerMinute,
      "limits.requestsPerMinute",
      0,
      10_000_000,
      DEFAULT_LIMITS.requestsPerMinute
    )
  };

  const tcpObj = optionalMapping(obj.tcp, "tcp");
  const tcp: TcpConfig = {
    enabled: requireBoolean(tcpObj.enabled, "tcp.enabled", DEFAULT_TCP.enabled),
    bindHost: optionalString(tcpObj.bindHost, "tcp.bindHost", DEFAULT_TCP.bindHost),
    portStart: optionalInt(tcpObj.portStart, "tcp.portStart", 1, 65535, DEFAULT_TCP.portStart),
    portEnd: optionalInt(tcpObj.portEnd, "tcp.portEnd", 1, 65535, DEFAULT_TCP.portEnd)
  };
  if (tcp.portStart > tcp.portEnd) {
    throw new ConfigError('"tcp.portStart" must be less than or equal to "tcp.portEnd"');
  }

  const httpPort = requireInt(obj.httpPort, "httpPort", 1, 65535);
  const schemeValue = obj.publicScheme;
  if (schemeValue !== undefined && schemeValue !== "http" && schemeValue !== "https") {
    throw new ConfigError('"publicScheme" must be "http" or "https"');
  }
  const publicScheme: PublicScheme = schemeValue ?? "http";
  const publicPort = optionalInt(obj.publicPort, "publicPort", 1, 65535, httpPort);

  const certObj = optionalMapping(obj.cert, "cert");
  const certDir = typeof certObj.dir === "string" ? certObj.dir : "certs";
  const certDirResolved = isAbsolute(certDir) ? certDir : resolve(options.baseDir, certDir);
  const keyFile = typeof certObj.keyFile === "string" ? certObj.keyFile : "server.key";
  const certFile = typeof certObj.certFile === "string" ? certObj.certFile : "server.crt";

  const cert: CertConfig = {
    dir: certDirResolved,
    keyPath: resolve(certDirResolved, keyFile),
    certPath: resolve(certDirResolved, certFile),
    commonName: typeof certObj.commonName === "string" ? certObj.commonName : "localhost",
    altNames: Array.isArray(certObj.altNames) ? (certObj.altNames as string[]) : [publicHost],
    days: optionalInt(certObj.days, "cert.days", 1, 36500, 365)
  };

  return {
    controlPort: requireInt(obj.controlPort, "controlPort", 1, 65535),
    httpPort,
    publicHost,
    publicScheme,
    publicPort,
    tokens,
    heartbeat,
    limits,
    tcp,
    cert
  };
}

export function loadConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Unable to read config file "${path}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in "${path}": ${(err as Error).message}`);
  }
  return parseConfig(raw, { baseDir: resolve(path, "..") });
}
