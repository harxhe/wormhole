import type { Server } from "node:net";
import { loadConfig } from "./config.ts";
import { DEFAULT_CONFIG_PATH } from "./paths.ts";
import { ensureCertificate } from "./certs.ts";
import { TunnelRegistry } from "./registry.ts";
import { createControlServer } from "./control.ts";
import { createPublicServer } from "./public.ts";
import { createLogger } from "./logger.ts";

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

async function main(): Promise<void> {
  const configPath = process.env.WORMHOLE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const config = loadConfig(configPath);
  const credentials = await ensureCertificate(config.cert);
  const registry = new TunnelRegistry();

  const controlServer = createControlServer({ config, credentials, registry });
  const publicServer = createPublicServer({ config, registry });

  await listen(controlServer, config.controlPort);
  await listen(publicServer, config.httpPort);

  const [firstToken] = config.tokens;
  log.info(`control listener  tls://localhost:${config.controlPort}`);
  log.info(`public listener   http://localhost:${config.httpPort}`);
  log.info(`test token        ${firstToken}`);
  log.info(`public host       ${config.publicHost}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    controlServer.close();
    publicServer.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error(`failed to start: ${(err as Error).message}`);
  process.exit(1);
});
