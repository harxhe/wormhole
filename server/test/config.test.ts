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

  it("applies safe defaults for limits, tcp and public urls", () => {
    const config = parseConfig(base, { baseDir: "." });
    expect(config.limits).toEqual({
      maxStreamsPerTunnel: 50,
      maxTunnelsPerToken: 5,
      requestsPerMinute: 600
    });
    expect(config.tcp).toEqual({
      enabled: true,
      bindHost: "0.0.0.0",
      portStart: 15000,
      portEnd: 15999
    });
    expect(config.publicScheme).toBe("http");
    expect(config.publicPort).toBe(8080);
  });

  it("accepts https public URLs and an explicit advertised port", () => {
    const config = parseConfig({ ...base, publicScheme: "https", publicPort: 443 }, { baseDir: "." });
    expect(config.publicScheme).toBe("https");
    expect(config.publicPort).toBe(443);
  });

  it("accepts custom limits and a tcp port range", () => {
    const config = parseConfig(
      {
        ...base,
        limits: { maxStreamsPerTunnel: 4, maxTunnelsPerToken: 2, requestsPerMinute: 60 },
        tcp: { enabled: false, bindHost: "127.0.0.1", portStart: 20000, portEnd: 20010 }
      },
      { baseDir: "." }
    );
    expect(config.limits.maxStreamsPerTunnel).toBe(4);
    expect(config.tcp).toMatchObject({ enabled: false, bindHost: "127.0.0.1", portStart: 20000, portEnd: 20010 });
  });

  it("rejects an empty token list", () => {
    expect(() => parseConfig({ ...base, tokens: [] }, { baseDir: "." })).toThrow(ConfigError);
  });

  it("rejects an out-of-range port", () => {
    expect(() => parseConfig({ ...base, httpPort: 70000 }, { baseDir: "." })).toThrow(ConfigError);
  });

  it("rejects an invalid public scheme", () => {
    expect(() => parseConfig({ ...base, publicScheme: "ftp" }, { baseDir: "." })).toThrow(ConfigError);
  });

  it("rejects a reversed tcp port range", () => {
    expect(() =>
      parseConfig({ ...base, tcp: { portStart: 20010, portEnd: 20000 } }, { baseDir: "." })
    ).toThrow(ConfigError);
  });

  it("rejects a negative limit", () => {
    expect(() => parseConfig({ ...base, limits: { maxStreamsPerTunnel: -1 } }, { baseDir: "." })).toThrow(ConfigError);
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
    expect(config.tcp.enabled).toBe(true);
    expect(config.limits.maxStreamsPerTunnel).toBeGreaterThan(0);
  });
});
