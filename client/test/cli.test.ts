import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_TOKEN, cleanups, publicRequest, runCleanups, startLocalApp, startRelay } from "./support/relay.ts";

afterEach(runCleanups);

const BIN = fileURLToPath(new URL("../bin/wormhole.js", import.meta.url));

interface Cli {
  child: ChildProcess;
  output: () => string;
  waitForOutput: (text: string, timeoutMs?: number) => Promise<string>;
  exited: Promise<number | null>;
}

function runCli(args: string[]): Cli {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, WORMHOLE_TOKEN: "", WORMHOLE_SERVER: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  cleanups.push(() => child.kill("SIGKILL"));

  const waitForOutput = (text: string, timeoutMs = 10_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = (): void => {
        if (output.includes(text)) resolve(output);
        else if (Date.now() > deadline) reject(new Error(`CLI never printed "${text}". Output:\n${output}`));
        else setTimeout(check, 25);
      };
      check();
    });

  return { child, output: () => output, waitForOutput, exited };
}

describe("wormhole http <port>", () => {
  it("prints the public URL, logs requests, and exits cleanly on Ctrl+C", async () => {
    const relay = await startRelay();
    const app = await startLocalApp();
    const cli = runCli([
      "http",
      String(app.port),
      "--token",
      TEST_TOKEN,
      "--server",
      `127.0.0.1:${relay.controlPort}`,
      "--subdomain",
      "cli",
      "--inspect-port",
      "0"
    ]);

    const banner = await cli.waitForOutput("Forwarding");
    expect(banner).toContain(`http://cli.localhost:8080 -> http://127.0.0.1:${app.port}`);
    expect(banner).toMatch(/Inspector\s+http:\/\/127\.0\.0\.1:\d+/);

    const response = await publicRequest(relay.publicPort, "cli", { path: "/from-cli" });
    expect(response.text).toBe("echo GET /from-cli body=");
    await cli.waitForOutput("/from-cli");
    expect(cli.output()).toMatch(/GET\s+\/from-cli\s+200 OK/);

    cli.child.kill("SIGINT");
    expect(await cli.exited).toBe(0);
  });

  it("exits with an error on a bad token", async () => {
    const relay = await startRelay();
    const cli = runCli(["http", "3000", "--token", "nope", "--server", `127.0.0.1:${relay.controlPort}`, "--no-inspect"]);
    expect(await cli.exited).toBe(1);
    expect(cli.output()).toContain("BAD_TOKEN");
  });

  it("requires a token", async () => {
    const cli = runCli(["http", "3000", "--no-inspect"]);
    expect(await cli.exited).toBe(1);
    expect(cli.output()).toContain("a token is required");
  });
});
