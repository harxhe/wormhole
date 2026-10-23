import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TunnelRegistry, Tunnel, isValidSubdomain, type TunnelSession } from "../src/registry.ts";
import { TunnelLimitError } from "../src/limits.ts";

function fakeTunnel(subdomain: string, token = "token"): TunnelSession {
  return {
    subdomain,
    type: "http",
    token,
    streamCount: 0,
    openStream: () => ({}) as never,
    close: () => {}
  };
}

function fakeStream(): EventEmitter {
  return new EventEmitter();
}

const limits = { maxStreamsPerTunnel: 0, maxTunnelsPerToken: 0, requestsPerMinute: 0 };

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

  it("enforces the per-token tunnel cap", () => {
    const registry = new TunnelRegistry({ maxTunnelsPerToken: 1 });
    registry.add(fakeTunnel("one", "token-a"));
    expect(() => registry.add(fakeTunnel("two", "token-a"))).toThrowError(TunnelLimitError);
    expect(() => registry.add(fakeTunnel("three", "token-b"))).not.toThrow();
  });

  it("closes a tunnel when it is removed and when the registry is drained", async () => {
    const registry = new TunnelRegistry();
    const close = vi.fn();
    registry.add({ ...fakeTunnel("one"), close });
    registry.remove("one");
    expect(close).toHaveBeenCalledOnce();

    const second = vi.fn();
    registry.add({ ...fakeTunnel("two"), close: second });
    await registry.closeAll();
    expect(second).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });
});

describe("Tunnel limits", () => {
  it("caps concurrent streams", () => {
    const tunnel = new Tunnel({
      subdomain: "limited",
      type: "http",
      token: "token",
      limits: { ...limits, maxStreamsPerTunnel: 1 },
      openStream: () => fakeStream() as never
    });

    const stream = tunnel.openStream();
    expect(tunnel.streamCount).toBe(1);
    expect(() => tunnel.openStream()).toThrowError(TunnelLimitError);
    stream.emit("close");
    expect(tunnel.streamCount).toBe(0);
    expect(() => tunnel.openStream()).not.toThrow();
  });

  it("rate limits new streams", () => {
    const tunnel = new Tunnel({
      subdomain: "rate",
      type: "http",
      token: "token",
      limits: { ...limits, requestsPerMinute: 1 },
      openStream: () => fakeStream() as never
    });

    tunnel.openStream().emit("close");
    expect(() => tunnel.openStream()).toThrowError(TunnelLimitError);
  });

  it("refuses new streams after close", async () => {
    const close = vi.fn();
    const tunnel = new Tunnel({
      subdomain: "closing",
      type: "http",
      token: "token",
      limits,
      openStream: () => fakeStream() as never,
      close
    });
    await tunnel.close();
    expect(close).toHaveBeenCalledOnce();
    expect(() => tunnel.openStream()).toThrowError(TunnelLimitError);
  });
});
