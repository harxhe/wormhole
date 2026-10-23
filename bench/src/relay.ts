import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo, Server as NetServer } from "node:net";
import { createControlServer } from "../../server/src/control.ts";
import { createPublicServer } from "../../server/src/public.ts";
import { parseConfig } from "../../server/src/config.ts";
import { TunnelRegistry } from "../../server/src/registry.ts";
import { getTestCredentials } from "../../server/test/support/test-cert.ts";
import { TunnelClient } from "../../client/src/client.ts";

export const BENCH_TOKEN = "bench-token";

export interface BenchRelay {
  controlPort: number;
  publicPort: number;
  close(): Promise<void>;
}

function listen(server: NetServer | HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function startRelay(): Promise<BenchRelay> {
  const credentials = await getTestCredentials();
  const config = parseConfig(
    {
      controlPort: 4443,
      httpPort: 8080,
      publicHost: "localhost",
      tokens: [BENCH_TOKEN],
      heartbeat: { intervalMs: 10_000, timeoutMs: 30_000 },
      limits: { maxStreamsPerTunnel: 0, maxTunnelsPerToken: 0, requestsPerMinute: 0 },
      tcp: { enabled: false },
      cert: { dir: "certs" }
    },
    { baseDir: "." }
  );

  const registry = new TunnelRegistry();
  const controlServer = createControlServer({ config, credentials, registry });
  const publicServer = createPublicServer({ config, registry });
  const controlPort = await listen(controlServer);
  const publicPort = await listen(publicServer);

  return {
    controlPort,
    publicPort,
    close: async () => {
      await registry.closeAll();
      await Promise.all([
        new Promise<void>((resolve) => controlServer.close(() => resolve())),
        new Promise<void>((resolve) => publicServer.close(() => resolve()))
      ]);
    }
  };
}

export interface BenchApp {
  port: number;
  close(): Promise<void>;
}

/** A local app that consumes the request body and replies with a fixed body. */
export async function startApp(body: Buffer): Promise<BenchApp> {
  const app = createHttpServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length
      });
      res.end(body);
    });
  });
  const port = await listen(app);
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        app.closeAllConnections();
        app.close(() => resolve());
      })
  };
}

export async function startClient(options: {
  controlPort: number;
  localPort: number;
  subdomain: string;
}): Promise<TunnelClient> {
  const client = new TunnelClient({
    serverHost: "127.0.0.1",
    serverPort: options.controlPort,
    token: BENCH_TOKEN,
    localPort: options.localPort,
    subdomain: options.subdomain,
    reconnect: false,
    backoff: { initialDelayMs: 10, maxDelayMs: 100, jitter: 0 }
  });
  await client.start();
  return client;
}
