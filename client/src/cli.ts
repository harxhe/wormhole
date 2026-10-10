import { readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import { DEFAULT_INSPECTOR_PORT, RequestStore, startInspectorServer } from "@wormhole/inspector";
import type { InspectorServer, RequestSummary } from "@wormhole/inspector";
import { TunnelClient } from "./client.ts";
import type { TunnelError } from "./client.ts";

const DEFAULT_SERVER = "localhost:4443";

interface HttpCommandOptions {
  token?: string;
  server: string;
  subdomain?: string;
  localHost: string;
  inspect: boolean;
  inspectPort: number;
  secure: boolean;
  ca?: string;
  reconnect: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("must be a port number (0-65535)");
  }
  return port;
}

function parseServer(value: string): { host: string; port: number } {
  const trimmed = value.replace(/^tls:\/\//, "");
  const colon = trimmed.lastIndexOf(":");
  const host = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const portText = colon === -1 ? "4443" : trimmed.slice(colon + 1);
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new InvalidArgumentError(`invalid server "${value}", expected host:port`);
  }
  return { host: host.replace(/^\[|\]$/g, ""), port };
}

const program = new Command();

program
  .name("wormhole")
  .description("Expose a local server through a Wormhole relay")
  .showHelpAfterError();

program
  .command("http")
  .description("Tunnel public HTTP traffic to a local port")
  .argument("<port>", "local port to expose", parsePort)
  .addOption(new Option("-t, --token <token>", "auth token").env("WORMHOLE_TOKEN"))
  .addOption(new Option("-s, --server <host:port>", "relay control server").default(DEFAULT_SERVER).env("WORMHOLE_SERVER"))
  .option("-n, --subdomain <name>", "request a specific subdomain")
  .option("--local-host <host>", "host of the local app", "127.0.0.1")
  .option("--inspect-port <port>", "inspector dashboard port", parsePort, DEFAULT_INSPECTOR_PORT)
  .option("--no-inspect", "do not start the inspector dashboard")
  .option("--secure", "verify the relay's TLS certificate", false)
  .option("--ca <file>", "trust this CA/certificate when verifying (implies --secure)")
  .option("--no-reconnect", "exit instead of reconnecting when the connection drops")
  .action(async (port: number, opts: HttpCommandOptions) => {
    await runHttp(port, opts);
  });

async function runHttp(localPort: number, opts: HttpCommandOptions): Promise<void> {
  if (!opts.token) {
    fail("a token is required: pass --token <token> or set WORMHOLE_TOKEN");
  }
  let server: { host: string; port: number };
  try {
    server = parseServer(opts.server);
  } catch (err) {
    fail((err as Error).message);
  }

  let ca: Buffer | undefined;
  if (opts.ca) {
    try {
      ca = readFileSync(opts.ca);
    } catch (err) {
      fail(`cannot read --ca file: ${(err as Error).message}`);
    }
  }

  const store = new RequestStore({ target: { host: opts.localHost, port: localPort } });
  store.setStatus({ state: "connecting", localPort });

  let inspector: InspectorServer | undefined;
  if (opts.inspect) {
    try {
      inspector = await startInspectorServer({ store, port: opts.inspectPort });
    } catch (err) {
      warn(`inspector not started: ${(err as NodeJS.ErrnoException).code === "EADDRINUSE" ? `port ${opts.inspectPort} is in use (try --inspect-port)` : (err as Error).message}`);
    }
  }

  const client = new TunnelClient({
    serverHost: server.host,
    serverPort: server.port,
    token: opts.token,
    localPort,
    localHost: opts.localHost,
    subdomain: opts.subdomain,
    verifyCertificate: opts.secure || ca !== undefined,
    ca,
    reconnect: opts.reconnect,
    observe: (streamId) => store.observe(streamId)
  });

  logRequests(store);

  client.once("connecting", () => info(`connecting to ${server.host}:${server.port} …`));

  client.on("assigned", (assign: { subdomain: string; url?: string }, { reconnected }: { reconnected: boolean }) => {
    const url = assign.url ?? assign.subdomain;
    store.setStatus({ state: "online", url, message: null });
    if (reconnected) {
      info(`reconnected · ${url}`);
      return;
    }
    printBanner(url, opts.localHost, localPort, inspector);
  });

  client.on("disconnected", ({ reason }: { reason: string }) => {
    store.setStatus({ state: "reconnecting", message: reason });
    warn(`connection lost: ${reason}`);
  });

  client.on("reconnecting", ({ delayMs, reason }: { delayMs: number; reason: string }) => {
    store.setStatus({ state: "reconnecting", message: reason });
    warn(`${reason} · retrying in ${(delayMs / 1000).toFixed(1)}s`);
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      client.close();
      await inspector?.close();
    }
    process.exit(code);
  };

  client.on("fatal", (err: TunnelError) => {
    store.setStatus({ state: "offline", url: null, message: err.message });
    console.error(`\nerror: ${err.message}${err.code ? ` [${err.code}]` : ""}`);
    void shutdown(1);
  });

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  client.start().catch(() => {
    // Reported by the `fatal` handler above.
  });
}

function printBanner(url: string, localHost: string, localPort: number, inspector: InspectorServer | undefined): void {
  const rows: [string, string][] = [
    ["Status", "online"],
    ["Forwarding", `${url} -> http://${localHost}:${localPort}`],
    ["Inspector", inspector ? inspector.url : "disabled"]
  ];
  const curl = curlHint(url);
  if (curl) rows.push(["Try", curl]);

  console.log("");
  console.log("wormhole");
  console.log("");
  for (const [label, value] of rows) console.log(`${label.padEnd(12)}${value}`);
  console.log("");
  console.log("Requests                                   (Ctrl+C to quit)");
  console.log("--------");
}

/**
 * `*.localhost` names do not resolve everywhere, so for a local relay show a
 * curl command that sets the Host header explicitly.
 */
function curlHint(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith(".localhost")) return undefined;
    return `curl -H "Host: ${parsed.host}" http://localhost:${parsed.port || 80}/`;
  } catch {
    return undefined;
  }
}

/** Print one line per finished request, like `GET /api 200 OK 12 ms`. */
function logRequests(store: RequestStore): void {
  store.on("upsert", (request: RequestSummary) => {
    if (request.state === "pending") return;
    const method = (request.method ?? "?").padEnd(7);
    const path = (request.path ?? "?").length > 48 ? `${request.path!.slice(0, 45)}...` : (request.path ?? "?");
    const status = request.status !== null ? `${request.status} ${request.statusText ?? ""}`.trim() : "ERR";
    const time = request.durationMs !== null ? `${request.durationMs} ms` : "";
    const replay = request.replayOf !== null ? " (replay)" : "";
    const error = request.state === "error" && request.error ? `  ${request.error}` : "";
    console.log(`${method}${path.padEnd(49)}${status.padEnd(26)}${time.padStart(8)}${replay}${error}`);
  });
}

function info(message: string): void {
  console.log(message);
}

function warn(message: string): void {
  console.error(`! ${message}`);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

await program.parseAsync(process.argv);
