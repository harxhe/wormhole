import {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_LOCAL_HOST,
  DEFAULT_PUBLIC_BASE,
  DEFAULT_SERVER,
  DEFAULT_TOKEN
} from "./config.ts";
import { isLoopback, openBrowser, parseServer } from "./helpers.ts";
import type { ManagerDefaults } from "./manager.ts";
import { startDashboardServer } from "./server.ts";

interface CliOptions {
  port: number;
  host: string;
  open: boolean;
  defaults: ManagerDefaults;
}

const HELP = `
wormhole dashboard

Start a local web dashboard for creating and inspecting tunnels.

Usage:
  wormhole-dashboard [options]
  npm run dashboard            # defaults (use the bin above for flags)

Options:
  -p, --port <port>        Dashboard port (default ${DEFAULT_DASHBOARD_PORT}, 0 picks a free port)
      --host <host>        Interface to bind (default 127.0.0.1)
      --server <host:port> Default relay control server (default ${DEFAULT_SERVER})
      --token <token>      Default auth token (default WORMHOLE_TOKEN or the dev token)
      --public-base <url>  Base URL used to preview public links (default ${DEFAULT_PUBLIC_BASE})
      --no-open            Do not open the browser
  -h, --help               Show this help
`.trim();

function readValue(argv: string[], index: number, inline: string | undefined, flag: string): string {
  if (inline !== undefined) return inline;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: DEFAULT_DASHBOARD_PORT,
    host: "127.0.0.1",
    open: true,
    defaults: {
      server: DEFAULT_SERVER,
      token: DEFAULT_TOKEN,
      localHost: DEFAULT_LOCAL_HOST,
      publicBase: DEFAULT_PUBLIC_BASE
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const [flag, inline] = raw.split("=", 2);

    switch (flag) {
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      case "-p":
      case "--port": {
        const value = readValue(argv, index, inline, flag);
        if (inline === undefined) index += 1;
        const port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
        options.port = port;
        break;
      }
      case "--host": {
        const value = readValue(argv, index, inline, flag);
        if (inline === undefined) index += 1;
        options.host = value.trim();
        if (!options.host) throw new Error("--host must not be empty");
        break;
      }
      case "--server": {
        const value = readValue(argv, index, inline, flag);
        if (inline === undefined) index += 1;
        parseServer(value);
        options.defaults.server = value.trim();
        break;
      }
      case "--token": {
        const value = readValue(argv, index, inline, flag);
        if (inline === undefined) index += 1;
        options.defaults.token = value.trim();
        break;
      }
      case "--public-base": {
        const value = readValue(argv, index, inline, flag);
        if (inline === undefined) index += 1;
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("--public-base must be an http or https URL");
        }
        options.defaults.publicBase = parsed.toString().replace(/\/$/, "");
        break;
      }
      case "--no-open":
        options.open = false;
        break;
      default:
        throw new Error(`unknown argument: ${raw}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!isLoopback(options.host)) {
    console.warn("! dashboard is reachable from the network; only do this on a trusted network");
  }

  const server = await startDashboardServer({
    port: options.port,
    host: options.host,
    defaults: options.defaults
  });

  console.log("");
  console.log("  wormhole dashboard");
  console.log("");
  console.log(`  Dashboard   ${server.url}`);
  console.log(`  Relay       ${options.defaults.server}`);
  console.log(`  Token       ${options.defaults.token ? "configured" : "missing"}`);
  console.log("");
  console.log("  Start a tunnel from the dashboard. Press Ctrl+C to stop.");
  console.log("");

  if (options.open) openBrowser(server.url);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nStopping tunnels…");
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(`dashboard: ${(err as Error).message}`);
  process.exit(1);
});
