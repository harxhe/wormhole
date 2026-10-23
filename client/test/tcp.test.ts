import { afterEach, describe, expect, it } from "vitest";
import { connect as netConnect } from "node:net";
import { TunnelClient, TunnelError } from "../src/index.ts";
import type { TunnelClientOptions } from "../src/index.ts";
import {
  TEST_TOKEN,
  cleanups,
  runCleanups,
  sleep,
  startRelay,
  startTcpEchoApp
} from "./support/relay.ts";

afterEach(runCleanups);

function startClient(options: Partial<TunnelClientOptions> & { serverPort: number; localPort: number }): TunnelClient {
  const client = new TunnelClient({
    serverHost: "127.0.0.1",
    token: TEST_TOKEN,
    type: "tcp",
    backoff: { initialDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    ...options
  });
  cleanups.push(() => client.close());
  return client;
}

function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length >= payload.length) {
        socket.end();
        resolve(data);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
}

describe("raw tcp tunnels", () => {
  it("assigns a public port and relays bytes to the local app", async () => {
    const relay = await startRelay();
    const app = await startTcpEchoApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "tcp-echo" });

    const assign = await client.start();
    expect(assign.port).toBeTypeOf("number");
    expect(assign.url).toBe(`tcp://localhost:${assign.port}`);

    expect(await roundTrip(assign.port!, "hello tunnel")).toBe("hello tunnel");
  });

  it("handles many concurrent tcp connections on one tunnel", async () => {
    const relay = await startRelay();
    const app = await startTcpEchoApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "tcp-busy" });
    const assign = await client.start();

    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => roundTrip(assign.port!, `message-${i}`))
    );
    expect(replies).toEqual(Array.from({ length: 20 }, (_, i) => `message-${i}`));
  });

  it("closes a public connection when the local app is down", async () => {
    const relay = await startRelay();
    const client = startClient({ serverPort: relay.controlPort, localPort: 1, subdomain: "tcp-dead" });
    const assign = await client.start();

    const result = await new Promise<string>((resolve, reject) => {
      const socket = netConnect(assign.port!, "127.0.0.1", () => socket.write("ping"));
      let data = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (data += chunk));
      socket.on("error", reject);
      socket.on("end", () => resolve(data));
    });
    expect(result).toBe("");
    expect(client.state).toBe("online");
  });

  it("rejects tcp tunnels when they are disabled", async () => {
    const relay = await startRelay(undefined, { tcp: { enabled: false } });
    const app = await startTcpEchoApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port });

    const err = (await client.start().catch((e: unknown) => e)) as TunnelError;
    expect(err).toBeInstanceOf(TunnelError);
    expect(err.code).toBe("UNSUPPORTED");
  });

  it("keeps the tunnel alive when a tcp stream closes", async () => {
    const relay = await startRelay();
    const app = await startTcpEchoApp();
    const client = startClient({ serverPort: relay.controlPort, localPort: app.port, subdomain: "tcp-again" });
    const assign = await client.start();

    expect(await roundTrip(assign.port!, "one")).toBe("one");
    await sleep(20);
    expect(await roundTrip(assign.port!, "two")).toBe("two");
    expect(client.state).toBe("online");
  });
});
