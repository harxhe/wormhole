import { describe, it, expect } from "vitest";
import { parseConfig, ConfigError, loadConfig } from "../src/config.ts";
import { DEFAULT_CONFIG_PATH } from "../src/paths.ts";

const base = {
  controlPort: 4443,
  httpPort: 8080,
  publicHost: "localhost",
  tokens: ["abc"],
  heartbeat: { intervalMs: 10000, timeoutMs: 30000 },
  cert: { dir: "certs" }
};

describe("parseConfig", () => {
  it("parses a valid config and resolves the cert directory", () => {
    const config = parseConfig(base, { baseDir: "C:\\srv" });
    expect(config.controlPort).toBe(4443);
    expect(config.tokens.has("abc")).toBe(true);
    expect(config.cert.keyPath).toMatch(/server\.key$/);
  });

  it("rejects an empty token list", () => {
    expect(() => parseConfig({ ...base, tokens: [] }, { baseDir: "." })).toThrow(ConfigError);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseConfig({ ...base, httpPort: 70000 }, { baseDir: "." })).toThrow(ConfigError);
  });

  it("rejects a heartbeat timeout at or below the interval", () => {
    expect(() =>
      parseConfig({ ...base, heartbeat: { intervalMs: 10000, timeoutMs: 10000 } }, { baseDir: "." })
    ).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("loads the shipped config.yaml with the test token", () => {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    expect(config.tokens.has("dev-token-please-change")).toBe(true);
  });
});
