import { resolve } from "node:path";
import { startApp, startClient, startRelay } from "./relay.ts";
import { measure } from "./load.ts";
import { writeReport } from "./report.ts";
import type { BenchReport, Measurement, Target } from "./types.ts";

interface Scenario {
  name: string;
  responseBody: Buffer;
  requestBody?: Buffer;
  method?: "GET" | "POST";
  connections: number[];
}

const SCENARIOS: Scenario[] = [
  { name: "small", responseBody: Buffer.from("ok"), connections: [1, 10, 50, 100] },
  {
    name: "download-1mb",
    responseBody: Buffer.alloc(1024 * 1024, 97),
    connections: [1, 10]
  },
  {
    name: "upload-300kb",
    responseBody: Buffer.from("ok"),
    requestBody: Buffer.alloc(300 * 1024, 7),
    method: "POST",
    connections: [1, 10]
  }
];

interface CliOptions {
  durationSeconds: number;
  connections?: number[];
  outDir: string;
  warmup: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    durationSeconds: 4,
    outDir: resolve("bench", "results"),
    warmup: true
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--duration": {
        const value = Number(next());
        if (!Number.isFinite(value) || value <= 0) throw new Error("--duration must be a positive number");
        options.durationSeconds = value;
        break;
      }
      case "--connections": {
        options.connections = next()
          .split(",")
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0);
        if (options.connections.length === 0) throw new Error("--connections must be a comma-separated list");
        break;
      }
      case "--out":
        options.outDir = resolve(next());
        break;
      case "--no-warmup":
        options.warmup = false;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: npm run bench -- [options]",
            "",
            "  --duration <seconds>    per-measurement duration (default 4)",
            "  --connections <list>    override connections, e.g. 1,10,50 (default per scenario)",
            "  --out <dir>             output directory (default bench/results)",
            "  --no-warmup             skip the 1s warm-up pass"
          ].join("\n")
        );
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

async function measureTarget(
  scenario: Scenario,
  target: Target,
  options: {
    url: string;
    headers: Record<string, string>;
    connections: number;
    durationSeconds: number;
  }
): Promise<Measurement> {
  return measure({
    scenario: scenario.name,
    target,
    url: options.url,
    headers: options.headers,
    connections: options.connections,
    durationSeconds: options.durationSeconds,
    method: scenario.method,
    body: scenario.requestBody
  });
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const relay = await startRelay();
  const measurements: Measurement[] = [];
  const clients = [];

  try {
    for (const scenario of SCENARIOS) {
      const app = await startApp(scenario.responseBody);
      const subdomain = `bench-${scenario.name}`;
      const client = await startClient({
        controlPort: relay.controlPort,
        localPort: app.port,
        subdomain
      });
      clients.push(client);

      const direct = {
        url: `http://127.0.0.1:${app.port}/`,
        headers: {}
      };
      const tunnel = {
        url: `http://127.0.0.1:${relay.publicPort}/`,
        headers: { Host: `${subdomain}.localhost` }
      };
      const connections = options.connections ?? scenario.connections;

      if (options.warmup) {
        console.log(`warming up ${scenario.name}`);
        await measureTarget(scenario, "direct", { ...direct, connections: 1, durationSeconds: 1 });
        await measureTarget(scenario, "tunnel", { ...tunnel, connections: 1, durationSeconds: 1 });
      }

      for (const count of connections) {
        for (const target of ["direct", "tunnel"] as const) {
          const endpoint = target === "direct" ? direct : tunnel;
          process.stdout.write(`${scenario.name} · ${target} · ${count} conn ... `);
          const result = await measureTarget(scenario, target, {
            ...endpoint,
            connections: count,
            durationSeconds: options.durationSeconds
          });
          measurements.push(result);
          console.log(`${result.requestsPerSecond} req/s · p50 ${result.latencyP50Ms} ms`);
        }
      }

      client.close();
      await app.close();
      clients.splice(clients.indexOf(client), 1);
    }

    const report: BenchReport = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      durationSeconds: options.durationSeconds,
      measurements
    };
    writeReport(report, options.outDir);
    console.log(`wrote ${resolve(options.outDir, "latest.json")}`);
  } finally {
    for (const client of clients) client.close();
    await relay.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
