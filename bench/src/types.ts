export type Target = "direct" | "tunnel";

export interface Measurement {
  scenario: string;
  target: Target;
  connections: number;
  requestsPerSecond: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
  latencyMaxMs: number;
  throughputMbPerSecond: number;
  errors: number;
  timeouts: number;
  non2xx: number;
}

export interface BenchReport {
  generatedAt: string;
  node: string;
  platform: string;
  durationSeconds: number;
  measurements: Measurement[];
}
