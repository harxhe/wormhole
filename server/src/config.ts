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

export interface Config {
  controlPort: number;
  httpPort: number;
  publicHost: string;
  tokens: Set<string>;
  heartbeat: HeartbeatConfig;
  cert: CertConfig;
}

function requireInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${field}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    throw new ConfigError(`"${field}" must be a non-empty array of strings`);
  }
  return value as string[];
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

  const heartbeatRaw = obj.heartbeat === undefined ? {} : obj.heartbeat;
  if (typeof heartbeatRaw !== "object" || heartbeatRaw === null) {
    throw new ConfigError('"heartbeat" must be a mapping');
  }
  const heartbeatObj = heartbeatRaw as Record<string, unknown>;
  const heartbeat: HeartbeatConfig = {
    intervalMs: requireInt(heartbeatObj.intervalMs ?? 10000, "heartbeat.intervalMs", 1, 3_600_000),
    timeoutMs: requireInt(heartbeatObj.timeoutMs ?? 30000, "heartbeat.timeoutMs", 1, 3_600_000)
  };
  if (heartbeat.timeoutMs <= heartbeat.intervalMs) {
    throw new ConfigError('"heartbeat.timeoutMs" must be greater than "heartbeat.intervalMs"');
  }

  const certRaw = (obj.cert ?? {}) as Record<string, unknown>;
  const certDir = typeof certRaw.dir === "string" ? certRaw.dir : "certs";
  const certDirResolved = isAbsolute(certDir) ? certDir : resolve(options.baseDir, certDir);
  const keyFile = typeof certRaw.keyFile === "string" ? certRaw.keyFile : "server.key";
  const certFile = typeof certRaw.certFile === "string" ? certRaw.certFile : "server.crt";

  const cert: CertConfig = {
    dir: certDirResolved,
    keyPath: resolve(certDirResolved, keyFile),
    certPath: resolve(certDirResolved, certFile),
    commonName: typeof certRaw.commonName === "string" ? certRaw.commonName : "localhost",
    altNames: Array.isArray(certRaw.altNames) ? (certRaw.altNames as string[]) : [publicHost],
    days: requireInt(certRaw.days ?? 365, "cert.days", 1, 36500)
  };

  return {
    controlPort: requireInt(obj.controlPort, "controlPort", 1, 65535),
    httpPort: requireInt(obj.httpPort, "httpPort", 1, 65535),
    publicHost,
    tokens,
    heartbeat,
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
