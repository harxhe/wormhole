import { loadConfig } from "../config.ts";
import { DEFAULT_CONFIG_PATH } from "../paths.ts";
import { startMockClient } from "../mock-client.ts";

interface CliArgs {
  localPort?: number;
  token?: string;
  server?: string;
  subdomain?: string;
  config: string;
  insecure: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { config: DEFAULT_CONFIG_PATH, insecure: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case "--port":
      case "-p":
        args.localPort = Number(next());
        break;
      case "--token":
      case "-t":
        args.token = next();
        break;
      case "--server":
      case "-s":
        args.server = next();
        break;
      case "--subdomain":
      case "-n":
        args.subdomain = next();
        break;
      case "--config":
      case "-c":
        args.config = next();
        break;
      case "--secure":
        args.insecure = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function usage(): void {
  console.log(`Usage: mock-client --port <localPort> [options]

Options:
  -p, --port <n>         Local port to proxy to (required)
  -t, --token <token>    Auth token (default: first token in config)
  -s, --server <host:port>  Control server (default: localhost:<controlPort>)
  -n, --subdomain <name> Request a specific subdomain
  -c, --config <path>    Config file (default: server/config.yaml)
      --secure           Verify the server certificate
  -h, --help             Show this help`);
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    usage();
    process.exit(1);
    return;
  }

  if (args.help) {
    usage();
    return;
  }
  if (args.localPort === undefined || Number.isNaN(args.localPort)) {
    console.error("error: --port is required");
    usage();
    process.exit(1);
    return;
  }

  const config = loadConfig(args.config);
  const [host, portText] = (args.server ?? `localhost:${config.controlPort}`).split(":");
  const token = args.token ?? [...config.tokens][0];
  if (!token) {
    console.error("error: no token provided and none configured");
    process.exit(1);
    return;
  }

  const client = startMockClient({
    serverHost: host || "localhost",
    serverPort: Number(portText) || config.controlPort,
    token,
    localPort: args.localPort,
    subdomain: args.subdomain,
    insecure: args.insecure
  });

  client.assigned
    .then((assign) => {
      const hostHeader = `${assign.subdomain}.${config.publicHost}`;
      console.log("");
      console.log(`Public URL: ${assign.url}`);
      console.log(`Test:       curl -H "Host: ${hostHeader}" http://localhost:${config.httpPort}/`);
      console.log("Press Ctrl+C to stop.");
      console.log("");
    })
    .catch((err: Error) => {
      console.error(`failed to establish tunnel: ${err.message}`);
      process.exit(1);
    });

  const stop = (): void => {
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
