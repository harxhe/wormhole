import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestSummary } from "@wormhole/inspector";
import { DashboardError } from "../src/errors.ts";
import type { CreateTunnelInput, TunnelManager, TunnelSnapshot } from "../src/manager.ts";
import { startDashboardServer } from "../src/server.ts";
import type { DashboardServer } from "../src/server.ts";

class FakeTunnel {
  constructor(readonly value: TunnelSnapshot) {}

  snapshot(): TunnelSnapshot {
    return this.value;
  }

  requests(): RequestSummary[] {
    return [];
  }

  request(): undefined {
    return undefined;
  }

  clear(): void {
    // No-op for the API test.
  }
}

class FakeManager extends EventEmitter {
  private readonly tunnels = new Map<string, FakeTunnel>();
  private nextId = 1;

  get count(): number {
    return this.tunnels.size;
  }

  create(input: CreateTunnelInput): TunnelSnapshot {
    const id = `t${this.nextId++}`;
    const snapshot: TunnelSnapshot = {
      id,
      type: input.type === "tcp" ? "tcp" : "http",
      localHost: "localhost",
      localPort: Number(input.localPort),
      state: "starting",
      url: null,
      subdomain: null,
      message: null,
      createdAt: Date.now(),
      streamCount: 0,
      requestCount: 0,
      errorCount: 0
    };
    this.tunnels.set(id, new FakeTunnel(snapshot));
    this.emit("tunnel", snapshot);
    return snapshot;
  }

  list(): TunnelSnapshot[] {
    return [...this.tunnels.values()].map((tunnel) => tunnel.snapshot());
  }

  get(id: string): FakeTunnel {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) throw new DashboardError("NOT_FOUND", `no tunnel with id ${id}`);
    return tunnel;
  }

  stop(id: string): void {
    this.get(id);
    this.tunnels.delete(id);
    this.emit("remove", id);
  }

  requests(): RequestSummary[] {
    return [];
  }

  request(): undefined {
    return undefined;
  }

  replay(): Promise<RequestSummary> {
    throw new DashboardError("NO_INSPECTOR", "not implemented in this test");
  }

  clear(): void {
    // No-op for the API test.
  }

  closeAll(): void {
    this.tunnels.clear();
  }
}

async function call(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // The static HTML page is not JSON.
  }
  return { status: response.status, body, text };
}

describe("dashboard HTTP API", () => {
  let server: DashboardServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(): Promise<DashboardServer> {
    const manager = new FakeManager() as unknown as TunnelManager;
    server = await startDashboardServer({
      port: 0,
      manager,
      defaults: {
        server: "relay.example.com:4443",
        token: "test-token",
        localHost: "localhost",
        publicBase: "http://localhost:8080"
      }
    });
    return server;
  }

  it("serves the dashboard and its config", async () => {
    const dashboard = await start();
    const page = await call(`${dashboard.url}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Wormhole — Dashboard");

    const config = await call(`${dashboard.url}/api/config`);
    expect(config.status).toBe(200);
    expect(config.body.defaults.server).toBe("relay.example.com:4443");
    expect(config.body.defaults.tokenConfigured).toBe(true);
    expect(config.body.tunnels).toEqual([]);
  });

  it("creates, lists and stops a tunnel", async () => {
    const dashboard = await start();
    const created = await call(`${dashboard.url}/api/tunnels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "http", localPort: 3000 })
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("t1");
    expect(created.body.localPort).toBe(3000);

    const list = await call(`${dashboard.url}/api/tunnels`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const stopped = await call(`${dashboard.url}/api/tunnels/t1`, { method: "DELETE" });
    expect(stopped.status).toBe(200);

    const empty = await call(`${dashboard.url}/api/tunnels`);
    expect(empty.body).toEqual([]);
  });

  it("rejects malformed bodies and cross-origin writes", async () => {
    const dashboard = await start();
    const badBody = await call(`${dashboard.url}/api/tunnels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([1, 2])
    });
    expect(badBody.status).toBe(400);

    const crossOrigin = await call(`${dashboard.url}/api/tunnels`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ type: "http", localPort: 3000 })
    });
    expect(crossOrigin.status).toBe(403);

    const missing = await call(`${dashboard.url}/api/tunnels/t99`);
    expect(missing.status).toBe(404);
  });
});
