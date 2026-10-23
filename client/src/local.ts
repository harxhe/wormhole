import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import { renderResponse, type Stream } from "@wormhole/transport";
import type { ErrorPayload } from "@wormhole/protocol";
import type { StreamObserver } from "@wormhole/inspector";

/** How long to wait for the local app to accept a connection. */
export const LOCAL_CONNECT_TIMEOUT_MS = 10_000;
/** After a failed local connect, how long to wait for the request bytes before answering 502. */
const REQUEST_WAIT_MS = 1000;

export interface LocalTarget {
  host: string;
  port: number;
}

export interface ProxyStreamOptions {
  stream: Stream;
  target: LocalTarget;
  /** Optional inspector hooks for this stream. */
  observer?: StreamObserver;
  connectTimeoutMs?: number;
  /**
   * Send a stream-level `ERROR` frame to the server. Used to report
   * `LOCAL_DOWN` (PROTOCOL.md) alongside the 502 page.
   */
  reportError?: (error: ErrorPayload) => void;
  /** Called once when the stream and its local socket are both done. */
  onDone?: () => void;
}

/**
 * Bridge one tunnel stream to a fresh TCP connection to the local app.
 *
 * - `DATA` that arrives before the local socket connects is queued, then
 *   flushed in order once it connects.
 * - Local bytes go back as `DATA` frames; `Stream.write` splits them into
 *   16 KB frames.
 * - If the local app cannot be reached, the server gets an `ERROR` frame
 *   `{ code: "LOCAL_DOWN" }` for the stream, then a `502 Bad Gateway` page as
 *   `DATA`, then `CLOSE`.
 * - Either side closing closes the other (`CLOSE` frame / socket destroy).
 * - Backpressure: a full local socket pauses the shared control socket, and a
 *   full control socket pauses the local socket (same rules as the server).
 */
export function proxyStream(options: ProxyStreamOptions): void {
  const { stream, target, observer } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? LOCAL_CONNECT_TIMEOUT_MS;

  const local: Socket = netConnect({ host: target.host, port: target.port });
  local.setNoDelay(true);

  const pending: Buffer[] = [];
  let connected = false;
  let responded = false;
  let finished = false;
  let controlPaused = false;
  let receivedRequest = false;
  let failure: string | undefined;
  let waitTimer: NodeJS.Timeout | undefined;

  const send502 = (): void => {
    if (finished || responded || failure === undefined) return;
    const page = renderResponse(
      502,
      "Bad Gateway",
      `Wormhole could not reach the local app at <code>${target.host}:${target.port}</code> (${escapeHtml(failure)}).`
    );
    responded = true;
    options.reportError?.({
      code: "LOCAL_DOWN",
      message: `local app at ${target.host}:${target.port} is unreachable (${failure})`
    });
    observer?.response(page);
    stream.write(page);
    finish(`local app unreachable (${failure})`);
  };

  const connectTimer = setTimeout(() => {
    if (connected) return;
    const err = Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" });
    local.destroy(err);
  }, connectTimeoutMs);
  connectTimer.unref();

  const finish = (error?: string): void => {
    if (finished) return;
    finished = true;
    clearTimeout(connectTimer);
    if (waitTimer) clearTimeout(waitTimer);
    if (controlPaused) {
      controlPaused = false;
      stream.resumeControl();
    }
    local.destroy();
    stream.close();
    observer?.end(error ? { error } : undefined);
    options.onDone?.();
  };

  const writeToLocal = (chunk: Buffer): void => {
    if (!local.write(chunk) && !controlPaused) {
      controlPaused = true;
      stream.pauseControl();
    }
  };

  // Public request bytes, relayed by the server.
  stream.on("data", (chunk: Buffer) => {
    observer?.request(chunk);
    receivedRequest = true;
    if (failure !== undefined) send502();
    else if (connected) writeToLocal(chunk);
    else pending.push(chunk);
  });
  stream.on("drain", () => local.resume());
  stream.on("error", () => {
    // The mux tore the stream down (connection lost); `close` follows.
  });
  stream.on("close", () => finish(responded ? undefined : "stream closed before the local app responded"));

  local.on("connect", () => {
    connected = true;
    clearTimeout(connectTimer);
    for (const chunk of pending) writeToLocal(chunk);
    pending.length = 0;
  });

  // Response bytes from the local app.
  local.on("data", (chunk: Buffer) => {
    responded = true;
    observer?.response(chunk);
    if (!stream.write(chunk)) local.pause();
  });

  local.on("drain", () => {
    if (controlPaused) {
      controlPaused = false;
      stream.resumeControl();
    }
  });

  local.on("end", () => finish());

  local.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    const reason = err.code ?? err.message;
    if (responded) {
      finish(`local app connection failed (${reason})`);
      return;
    }
    failure = reason;
    // The OPEN frame can arrive a moment before the request's DATA frames. Wait
    // briefly for the request so the 502 is logged against the right request.
    if (receivedRequest) send502();
    else waitTimer = setTimeout(send502, REQUEST_WAIT_MS);
  });

  local.on("close", () => {
    if (failure === undefined) finish();
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Bridge one raw TCP tunnel stream to the local app. Unlike {@link proxyStream}
 * it never speaks HTTP: if the local app is down it reports `LOCAL_DOWN` and
 * closes the stream.
 */
export function proxyRawStream(options: ProxyStreamOptions): void {
  const { stream, target } = options;
  const connectTimeoutMs = options.connectTimeoutMs ?? LOCAL_CONNECT_TIMEOUT_MS;

  const local: Socket = netConnect({ host: target.host, port: target.port });
  local.setNoDelay(true);

  const pending: Buffer[] = [];
  let connected = false;
  let finished = false;
  let controlPaused = false;
  let connectTimer: NodeJS.Timeout | undefined;

  const finish = (error?: string): void => {
    if (finished) return;
    finished = true;
    if (connectTimer) clearTimeout(connectTimer);
    if (controlPaused) {
      controlPaused = false;
      stream.resumeControl();
    }
    local.destroy();
    stream.close();
    options.observer?.end(error ? { error } : undefined);
    options.onDone?.();
  };

  connectTimer = setTimeout(() => {
    if (connected) return;
    const err = Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" });
    local.destroy(err);
  }, connectTimeoutMs);
  connectTimer.unref();

  // Public bytes -> local app.
  stream.on("data", (chunk: Buffer) => {
    options.observer?.request(chunk);
    if (connected) {
      if (!local.write(chunk) && !controlPaused) {
        controlPaused = true;
        stream.pauseControl();
      }
    } else {
      pending.push(chunk);
    }
  });
  stream.on("drain", () => local.resume());
  stream.on("close", () => finish());
  stream.on("error", () => {
    // `close` follows.
  });

  local.on("connect", () => {
    connected = true;
    clearTimeout(connectTimer);
    for (const chunk of pending) {
      if (!local.write(chunk) && !controlPaused) {
        controlPaused = true;
        stream.pauseControl();
      }
    }
    pending.length = 0;
  });

  // Local app bytes -> public stream.
  local.on("data", (chunk: Buffer) => {
    options.observer?.response(chunk);
    if (!stream.write(chunk)) local.pause();
  });
  local.on("drain", () => {
    if (controlPaused) {
      controlPaused = false;
      stream.resumeControl();
    }
  });
  local.on("end", () => finish());
  local.on("close", () => finish());
  local.on("error", (err: NodeJS.ErrnoException) => {
    if (finished) return;
    if (!connected) {
      const reason = err.code ?? err.message;
      options.reportError?.({
        code: "LOCAL_DOWN",
        message: `local app at ${target.host}:${target.port} is unreachable (${reason})`
      });
      finish(`local app unreachable (${reason})`);
      return;
    }
    finish(`local app connection failed (${err.code ?? err.message})`);
  });
}

