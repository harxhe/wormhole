import { describe, expect, it } from "vitest";
import { DashboardError } from "../src/errors.ts";
import { isLoopback, normalizeSubdomain, parseLocalPort, parseServer } from "../src/helpers.ts";

describe("parseServer", () => {
  it("defaults to port 4443", () => {
    expect(parseServer("localhost")).toEqual({ host: "localhost", port: 4443 });
  });

  it("accepts tls:// and bracketed IPv6", () => {
    expect(parseServer("tls://relay.example.com:8443")).toEqual({ host: "relay.example.com", port: 8443 });
    expect(parseServer("[::1]:4443")).toEqual({ host: "::1", port: 4443 });
  });

  it("rejects malformed values", () => {
    expect(() => parseServer("")).toThrow(DashboardError);
    expect(() => parseServer("host:not-a-port")).toThrow(DashboardError);
    expect(() => parseServer("host:0")).toThrow(DashboardError);
    expect(() => parseServer("host:70000")).toThrow(DashboardError);
  });
});

describe("parseLocalPort", () => {
  it("accepts strings and numbers in range", () => {
    expect(parseLocalPort("3000")).toBe(3000);
    expect(parseLocalPort(5432)).toBe(5432);
  });

  it("rejects out-of-range and fractional ports", () => {
    expect(() => parseLocalPort(0)).toThrow(DashboardError);
    expect(() => parseLocalPort(65536)).toThrow(DashboardError);
    expect(() => parseLocalPort(3000.5)).toThrow(DashboardError);
    expect(() => parseLocalPort("nope")).toThrow(DashboardError);
  });
});

describe("normalizeSubdomain", () => {
  it("trims and lowercases a name", () => {
    expect(normalizeSubdomain("  Demo-1 ")).toBe("demo-1");
  });

  it("treats blank values as unspecified", () => {
    expect(normalizeSubdomain("")).toBeUndefined();
    expect(normalizeSubdomain(undefined)).toBeUndefined();
  });

  it("rejects names the relay would reject", () => {
    expect(() => normalizeSubdomain("-demo")).toThrow(DashboardError);
    expect(() => normalizeSubdomain("demo_")).toThrow(DashboardError);
    expect(() => normalizeSubdomain("a".repeat(64))).toThrow(DashboardError);
  });
});

describe("isLoopback", () => {
  it("recognises local binds", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.2")).toBe(false);
  });
});
