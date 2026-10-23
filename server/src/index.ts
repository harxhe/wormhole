import type { Server, Socket } from "node:net";
import { loadConfig } from "./config.ts";
import { DEFAULT_CONFIG_PATH } from "./paths.ts";
import { ensureCertificate } from "./certs.ts";
import { TunnelRegistry } from "./registry.ts";
import { createControlServer } from "./control.ts";
import { createPublicServer } from "./public.ts";
import { createLogger } from "@wormhole/transport";

const log = createLogger("server");

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  const configPath = process.env.WORMHOLE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const credentials = await ensureCertificate(config.cert);
  const registry = new TunnelRegistry({ maxTunnelsPerToken: config.limits.maxTunnelsPerToken });

  const controlServer = createControlServer({ config, credentials, registry });
  const publicServer = createPublicServer({ config, registry });

  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  controlServer.on("secureConnection", track);
  publicServer.on("connection", track);

  await listen(controlServer, config.controlPort);
  await listen(publicServer, config.httpPort);

  const [firstToken] = config.tokens;
  log.info(`control listener  tls://localhost:${config.controlPort}`);
  log.info(`public listener   ${config.publicScheme}://localhost:${config.httpPort}`);
  log.info(`public host       ${config.publicHost}`);
  log.info(`tcp tunnels       ${config.tcp.enabled ? `${config.tcp.bindHost}:${config.tcp.portStart}-${config.tcp.portEnd}` : "disabled"}`);
  log.info(`limits            ${config.limits.maxStreamsPerTunnel} streams/tunnel, ${config.limits.maxTunnelsPerToken} tunnels/token, ${config.limits.requestsPerMinute} req/min`);
  log.info(`test token        ${firstToken}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);

    const closing = [close(controlServer), close(publicServer)];
    await registry.closeAll();
    for (const socket of sockets) socket.destroy();
    sockets.clear();

    await Promise.race([
      Promise.all(closing),
      new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error(`failed to start: ${(err as Error).message}`);
  process.exit(1);
});
