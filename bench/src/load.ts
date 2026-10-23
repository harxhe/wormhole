import { request } from "node:http";
import type { Measurement, Target } from "./types.ts";

export interface LoadOptions {
  scenario: string;
  target: Target;
  url: string;
  headers: Record<string, string>;
  connections: number;
  durationSeconds: number;
  method?: "GET" | "POST";
  body?: Buffer;
}

interface OneResult {
  latencyMs: number;
  bytes: number;
  status: number;
  error: boolean;
  timeout: boolean;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

function requestOnce(options: LoadOptions): Promise<OneResult> {
  const url = new URL(options.url);
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let settled = false;
    let bytes = 0;

    const finish = (result: OneResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = request(
      {
        host: url.hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
        // One request per connection: the tunnel's public listener forces
        // `Connection: close`, so the direct baseline does the same.
        agent: false
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
          finish({ latencyMs, bytes, status: res.statusCode ?? 0, error: false, timeout: false });
        });
        res.on("error", () => {
          finish({ latencyMs: 0, bytes, status: 0, error: true, timeout: false });
        });
      }
    );

    req.setTimeout(10_000, () => {
      req.destroy();
      finish({ latencyMs: 0, bytes, status: 0, error: true, timeout: true });
    });
    req.on("error", () => finish({ latencyMs: 0, bytes, status: 0, error: true, timeout: false }));

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Small HTTP/1.1 load generator. Autocannon's keep-alive pipelining does not
 * model Wormhole's one-request-per-connection public listener, so this harness
 * opens one connection per request for both the direct and tunnel targets.
 */
export async function measure(options: LoadOptions): Promise<Measurement> {
  const deadline = performance.now() + options.durationSeconds * 1000;
  const startedAt = performance.now();
  const latencies: number[] = [];
  let requests = 0;
  let bytes = 0;
  let errors = 0;
  let timeouts = 0;
  let non2xx = 0;

  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const result = await requestOnce(options);
      if (result.error) {
        errors += 1;
        if (result.timeout) timeouts += 1;
        continue;
      }
      requests += 1;
      bytes += result.bytes;
      latencies.push(result.latencyMs);
      if (result.status >= 400) non2xx += 1;
    }
  };

  await Promise.all(Array.from({ length: options.connections }, worker));

  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const sorted = latencies.sort((a, b) => a - b);
  return {
    scenario: options.scenario,
    target: options.target,
    connections: options.connections,
    requestsPerSecond: round(requests / elapsedSeconds),
    latencyP50Ms: round(percentile(sorted, 0.5)),
    latencyP99Ms: round(percentile(sorted, 0.99)),
    latencyMaxMs: round(sorted[sorted.length - 1] ?? 0),
    throughputMbPerSecond: round(bytes / elapsedSeconds / (1024 * 1024)),
    errors,
    timeouts,
    non2xx
  };
}
