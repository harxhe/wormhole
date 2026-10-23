import { describe, expect, it } from "vitest";
import { PortPool } from "../src/ports.ts";

describe("PortPool", () => {
  it("hands out every port in the range exactly once", () => {
    const pool = new PortPool(20000, 20002);
    expect(pool.size).toBe(3);
    const ports = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(new Set(ports)).toEqual(new Set([20000, 20001, 20002]));
    expect(pool.acquire()).toBeUndefined();
    expect(pool.inUse).toBe(3);
  });

  it("reuses a released port", () => {
    const pool = new PortPool(20000, 20001);
    const first = pool.acquire()!;
    pool.acquire();
    expect(pool.acquire()).toBeUndefined();
    pool.release(first);
    expect(pool.acquire()).toBe(first);
  });

  it("wraps around the range", () => {
    const pool = new PortPool(20000, 20001);
    expect(pool.acquire()).toBe(20000);
    expect(pool.acquire()).toBe(20001);
    pool.release(20000);
    expect(pool.acquire()).toBe(20000);
  });

  it("rejects invalid ranges", () => {
    expect(() => new PortPool(20001, 20000)).toThrow(RangeError);
    expect(() => new PortPool(0, 10)).toThrow(RangeError);
  });
});
