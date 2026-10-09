import { describe, expect, it } from "vitest";
import { TunnelRegistry, isValidSubdomain, type TunnelSession } from "../src/registry.ts";

function fakeTunnel(subdomain: string): TunnelSession {
  return { subdomain, type: "http", openStream: () => ({}) as never };
}

describe("isValidSubdomain", () => {
  it("accepts lowercase alphanumeric labels with internal hyphens", () => {
    expect(isValidSubdomain("swift-fox")).toBe(true);
    expect(isValidSubdomain("a")).toBe(true);
    expect(isValidSubdomain("team1")).toBe(true);
  });

  it("rejects bad labels", () => {
    expect(isValidSubdomain("")).toBe(false);
    expect(isValidSubdomain("-leading")).toBe(false);
    expect(isValidSubdomain("trailing-")).toBe(false);
    expect(isValidSubdomain("UPPER")).toBe(false);
    expect(isValidSubdomain("has.dot")).toBe(false);
    expect(isValidSubdomain("x".repeat(64))).toBe(false);
  });
});

describe("TunnelRegistry", () => {
  it("adds, gets, and removes tunnels", () => {
    const registry = new TunnelRegistry();
    const tunnel = fakeTunnel("swift-fox");

    registry.add(tunnel);
    expect(registry.has("swift-fox")).toBe(true);
    expect(registry.get("swift-fox")).toBe(tunnel);
    expect(registry.size).toBe(1);

    registry.remove("swift-fox");
    expect(registry.has("swift-fox")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("throws when a subdomain is already taken", () => {
    const registry = new TunnelRegistry();
    registry.add(fakeTunnel("swift-fox"));
    expect(() => registry.add(fakeTunnel("swift-fox"))).toThrow();
  });

  it("generates valid, unique subdomains", () => {
    const registry = new TunnelRegistry();
    const seen = new Set<string>();

    for (let i = 0; i < 200; i++) {
      const name = registry.generateSubdomain();
      expect(isValidSubdomain(name)).toBe(true);
      expect(seen.has(name)).toBe(false);
      seen.add(name);
      registry.add(fakeTunnel(name));
    }
  });
});
