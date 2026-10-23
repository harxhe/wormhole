import { afterEach, describe, expect, it } from "vitest";
import { TunnelClient } from "../src/index.ts";
import type { TunnelClientOptions } from "../src/index.ts";
import { TEST_TOKEN, cleanups, publicRequest, runCleanups, sleep, startLocalApp, startRelay } from "./support/relay.ts";

afterEach(runCleanups);

function startClient(options: Partial<TunnelClientOptions> & { serverPort: number; localPort: number }): TunnelClient {
  const client = new TunnelClient({
    serverHost: "127.0.0.1",
    token: TEST_TOKEN,
    backoff: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    ...options
  });
  cleanups.push(() => client.close());
  return client;
}


describe("per-tunnel limits", () => {
  it("returns 429 while the concurrent stream cap is reached", async () => {
    const relay = await startRelay(undefined, {
      limits: { maxStreamsPerTunnel: 1, requestsPerMinute: 0 }
    });
    const app = await startLocalApp((_req, _res) => {
      // Hold the request open so the first stream stays active.
    });
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "one" });
    await client.start();

    const pending = publicRequest(relay.publicPort, "one", { path: "/first" });
    pending.catch(() => {});
    for (let i = 0; i < 100 && client.streamCount < 1; i++) await sleep(10);
    expect(client.streamCount).toBe(1);

    const second = await publicRequest(relay.publicPort, "one", { path: "/second" });
    expect(second.status).toBe(429);
    expect(second.headers).toContain("Retry-After:");
    expect(second.text).toContain("concurrent streams");
  });

  it("returns 429 after the per-minute request limit is exceeded", async () => {
    const relay = await startRelay(undefined, {
      limits: { maxStreamsPerTunnel: 0, requestsPerMinute: 1 }
    });
    const app = await startLocalApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "rate" });
    await client.start();

    expect((await publicRequest(relay.publicPort, "rate")).status).toBe(200);
    const second = await publicRequest(relay.publicPort, "rate");
    expect(second.status).toBe(429);
    expect(second.text).toContain("rate limit");
  });
});
