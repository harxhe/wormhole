import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchReport, Measurement } from "./types.ts";
import { barChart } from "./svg.ts";

function find(measurements: Measurement[], scenario: string, connections: number, target: string): Measurement | undefined {
  return measurements.find(
    (item) => item.scenario === scenario && item.connections === connections && item.target === target
  );
}

function markdownTable(report: BenchReport): string {
  const rows = [...report.measurements].sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      a.connections - b.connections ||
      a.target.localeCompare(b.target)
  );
  const lines = [
    "| Scenario | Target | Connections | Req/s | p50 | p99 | Max | MB/s | Errors |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|"
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.scenario} | ${row.target} | ${row.connections} | ${row.requestsPerSecond} | ${row.latencyP50Ms} ms | ${row.latencyP99Ms} ms | ${row.latencyMaxMs} ms | ${row.throughputMbPerSecond} | ${row.errors + row.timeouts + row.non2xx} |`
    );
  }
  return lines.join("\n");
}

function overheadTable(report: BenchReport): string {
  const lines = [
    "| Scenario | Connections | Direct p50 | Tunnel p50 | Added latency | Throughput ratio |",
    "|---|---:|---:|---:|---:|---:|"
  ];
  const keys = new Set(
    report.measurements.map((item) => `${item.scenario}::${item.connections}`)
  );
  for (const key of keys) {
    const [scenario, connectionsText] = key.split("::");
    const connections = Number(connectionsText);
    const direct = find(report.measurements, scenario!, connections, "direct");
    const tunnel = find(report.measurements, scenario!, connections, "tunnel");
    if (!direct || !tunnel) continue;
    const added = tunnel.latencyP50Ms - direct.latencyP50Ms;
    const ratio = direct.requestsPerSecond === 0 ? 0 : tunnel.requestsPerSecond / direct.requestsPerSecond;
    lines.push(
      `| ${scenario} | ${connections} | ${direct.latencyP50Ms} ms | ${tunnel.latencyP50Ms} ms | ${added.toFixed(2)} ms | ${(ratio * 100).toFixed(1)}% |`
    );
  }
  return lines.join("\n");
}

function chartFor(report: BenchReport, scenario: string, metric: "latencyP50Ms" | "throughputMbPerSecond"): string {
  const items = report.measurements.filter((item) => item.scenario === scenario);
  const connections = [...new Set(items.map((item) => item.connections))].sort((a, b) => a - b);
  return barChart({
    title: scenario === "small" ? "HTTP tunnel latency (small response)" : `${scenario} throughput`,
    unit: metric === "latencyP50Ms" ? "p50 latency in milliseconds, lower is better" : "MB/s, higher is better",
    series: [
      { name: "direct", color: "#64748b" },
      { name: "tunnel", color: "#0ea5e9" }
    ],
    groups: connections.map((count) => ({
      label: `${count} conn`,
      values: [
        find(items, scenario, count, "direct")?.[metric] ?? 0,
        find(items, scenario, count, "tunnel")?.[metric] ?? 0
      ]
    }))
  });
}

export function writeReport(report: BenchReport, outDir: string): void {
  mkdirSync(outDir, { recursive: true });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(outDir, "latest.json"), json);

  const markdown = [
    "# Wormhole benchmark results",
    "",
    `Generated ${report.generatedAt} on ${report.platform}, Node ${report.node}.`,
    `Each measurement ran for ${report.durationSeconds}s with one-request-per-connection HTTP load.`,
    "",
    "## Results",
    "",
    markdownTable(report),
    "",
    "## Tunnel overhead",
    "",
    overheadTable(report),
    "",
    "## Charts",
    "",
    "![Latency](latency-p50.svg)",
    "",
    "![Throughput](throughput.svg)",
    ""
  ].join("\n");
  writeFileSync(join(outDir, "latest.md"), markdown);

  writeFileSync(join(outDir, "latency-p50.svg"), chartFor(report, "small", "latencyP50Ms"));
  writeFileSync(join(outDir, "throughput.svg"), chartFor(report, "small", "throughputMbPerSecond"));
}
