import { EventEmitter } from "node:events";
import { connect as netConnect } from "node:net";
import { decodeChunked, getHeader, parseRequestHead, parseResponseHead } from "./parse.ts";
import type { HeaderList, RequestHead, ResponseHead } from "./parse.ts";

/** Raw request bytes kept per record for replay. Larger requests are not replayable. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;
/** Body bytes shown in the inspector detail view. */
export const MAX_PREVIEW_BYTES = 16 * 1024;
/** Records kept in memory; the oldest are dropped first. */
export const DEFAULT_MAX_RECORDS = 200;
/** A replay that has not finished within this time is aborted. */
export const REPLAY_TIMEOUT_MS = 30_000;

export type RecordState = "pending" | "complete" | "error";

/** One request/response exchange, as shown in the inspector list. */
export interface RequestSummary {
  id: number;
  /** Tunnel stream that carried it; `null` for replays sent by the inspector. */
  streamId: number | null;
  /** Id of the record this one replayed. */
  replayOf: number | null;
  state: RecordState;
  method: string | null;
  path: string | null;
  status: number | null;
  statusText: string | null;
  startedAt: number;
  /** Time to the first response byte. */
  ttfbMs: number | null;
  /** Time until the stream closed. */
  durationMs: number | null;
  requestBytes: number;
  responseBytes: number;
  replayable: boolean;
  error: string | null;
}

export interface BodyPreview {
  /** UTF-8 text of the body, or `null` when the body is binary. */
  text: string | null;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** Full record, as returned by the detail API. */
export interface RequestDetail extends RequestSummary {
  requestHeaders: HeaderList;
  responseHeaders: HeaderList;
  requestBody: BodyPreview;
  responseBody: BodyPreview;
}

/** Hooks the tunnel client calls for one stream. */
export interface StreamObserver {
  /** Bytes received from the public side (request). */
  request(chunk: Buffer): void;
  /** Bytes sent back from the local app (response). */
  response(chunk: Buffer): void;
  /** The stream ended. `error` is set when it failed. */
  end(info?: { error?: string }): void;
}

export interface TunnelStatus {
  state: "connecting" | "online" | "reconnecting" | "offline";
  url: string | null;
  localPort: number | null;
  message: string | null;
}

export interface ReplayTarget {
  host: string;
  port: number;
}

export interface RequestStoreOptions {
  /** Where replays are sent (the local app). */
  target?: ReplayTarget;
  maxRecords?: number;
  /** Override the clock (tests). */
  now?: () => number;
}

interface Capture {
  summary: RequestSummary;
  request: Buffer[];
  requestLength: number;
  requestOverflow: boolean;
  response: Buffer[];
  responseLength: number;
  requestHead: RequestHead | null;
  responseHead: ResponseHead | null;
}

/**
 * In-memory log of requests that passed through the tunnel.
 *
 * Events:
 * - `upsert` `(summary: RequestSummary)` — a record was created or changed
 * - `clear`  `()`                        — all records were removed
 * - `status` `(status: TunnelStatus)`    — the tunnel status changed
 */
export class RequestStore extends EventEmitter {
  private readonly records = new Map<number, Capture>();
  private readonly maxRecords: number;
  private readonly now: () => number;
  private target: ReplayTarget | undefined;
  private nextId = 1;
  private currentStatus: TunnelStatus = { state: "offline", url: null, localPort: null, message: null };

  constructor(options: RequestStoreOptions = {}) {
    super();
    this.target = options.target;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.records.size;
  }

  get status(): TunnelStatus {
    return { ...this.currentStatus };
  }

  setStatus(status: Partial<TunnelStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...status };
    this.emit("status", this.status);
  }

  setTarget(target: ReplayTarget): void {
    this.target = target;
  }

  /** Summaries, newest first. */
  list(): RequestSummary[] {
    return [...this.records.values()].map((c) => ({ ...c.summary })).reverse();
  }

  get(id: number): RequestDetail | undefined {
    const capture = this.records.get(id);
    return capture ? toDetail(capture) : undefined;
  }

  clear(): void {
    this.records.clear();
    this.emit("clear");
  }

  /** Start recording a tunnel stream. */
  observe(streamId: number): StreamObserver {
    return this.start(streamId, null).observer;
  }

  /**
   * Re-send a recorded request to the local app and record the result as a new
   * entry. Resolves with the new record once the local app has answered.
   */
  async replay(id: number): Promise<RequestSummary> {
    const original = this.records.get(id);
    if (!original) throw new ReplayError("NOT_FOUND", `no request with id ${id}`);
    if (!original.summary.replayable) throw new ReplayError("NOT_REPLAYABLE", "request was not fully captured");
    if (!this.target) throw new ReplayError("NO_TARGET", "no local app to replay to");

    const raw = Buffer.concat(original.request, original.requestLength);
    const { capture, observer } = this.start(null, id);
    const { host, port } = this.target;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (error?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        observer.end(error ? { error } : undefined);
        resolve();
      };
      const socket = netConnect(port, host, () => {
        observer.request(raw);
        socket.write(raw);
      });
      const timer = setTimeout(() => finish("replay timed out"), REPLAY_TIMEOUT_MS);
      timer.unref();
      socket.on("data", (chunk: Buffer) => observer.response(chunk));
      socket.on("end", () => finish());
      socket.on("error", (err: NodeJS.ErrnoException) => finish(`local app unreachable (${err.code ?? err.message})`));
      socket.on("close", () => finish());
    });

    return { ...capture.summary };
  }

  private start(streamId: number | null, replayOf: number | null): { capture: Capture; observer: StreamObserver } {
    const id = this.nextId++;
    const capture: Capture = {
      summary: {
        id,
        streamId,
        replayOf,
        state: "pending",
        method: null,
        path: null,
        status: null,
        statusText: null,
        startedAt: this.now(),
        ttfbMs: null,
        durationMs: null,
        requestBytes: 0,
        responseBytes: 0,
        replayable: false,
        error: null
      },
      request: [],
      requestLength: 0,
      requestOverflow: false,
      response: [],
      responseLength: 0,
      requestHead: null,
      responseHead: null
    };
    this.records.set(id, capture);
    this.trim();

    let ended = false;
    const touch = (): void => {
      if (this.records.has(id)) this.emit("upsert", { ...capture.summary });
    };

    touch();

    const observer: StreamObserver = {
      request: (chunk: Buffer) => {
        if (ended) return;
        capture.summary.requestBytes += chunk.length;
        if (capture.requestLength + chunk.length <= MAX_CAPTURE_BYTES) {
          capture.request.push(chunk);
          capture.requestLength += chunk.length;
        } else {
          capture.requestOverflow = true;
        }
        if (!capture.requestHead) {
          const head = parseRequestHead(Buffer.concat(capture.request, capture.requestLength));
          if (head) {
            capture.requestHead = head;
            capture.summary.method = head.method;
            capture.summary.path = head.path;
            touch();
          }
        }
      },
      response: (chunk: Buffer) => {
        if (ended) return;
        if (capture.summary.ttfbMs === null) capture.summary.ttfbMs = this.now() - capture.summary.startedAt;
        capture.summary.responseBytes += chunk.length;
        if (capture.responseLength < MAX_CAPTURE_BYTES) {
          capture.response.push(chunk);
          capture.responseLength += chunk.length;
        }
        if (!capture.responseHead) {
          const head = parseResponseHead(Buffer.concat(capture.response, capture.responseLength));
          if (head) {
            capture.responseHead = head;
            capture.summary.status = head.status;
            capture.summary.statusText = head.statusText;
            touch();
          }
        }
      },
      end: (info?: { error?: string }) => {
        if (ended) return;
        ended = true;
        capture.summary.durationMs = this.now() - capture.summary.startedAt;
        capture.summary.replayable = capture.requestHead !== null && !capture.requestOverflow;
        if (info?.error) {
          capture.summary.state = "error";
          capture.summary.error = info.error;
        } else {
          capture.summary.state = capture.responseHead ? "complete" : "error";
          if (!capture.responseHead) capture.summary.error = "no response";
        }
        touch();
      }
    };
    return { capture, observer };
  }

  private trim(): void {
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}

export class ReplayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReplayError";
    this.code = code;
  }
}

function toDetail(capture: Capture): RequestDetail {
  const request = Buffer.concat(capture.request, capture.requestLength);
  const response = Buffer.concat(capture.response, capture.responseLength);
  return {
    ...capture.summary,
    requestHeaders: capture.requestHead?.headers ?? [],
    responseHeaders: capture.responseHead?.headers ?? [],
    requestBody: preview(capture.requestHead ? request.subarray(capture.requestHead.bodyOffset) : Buffer.alloc(0), capture.requestHead?.headers, capture.requestOverflow),
    responseBody: preview(
      capture.responseHead ? response.subarray(capture.responseHead.bodyOffset) : Buffer.alloc(0),
      capture.responseHead?.headers,
      capture.summary.responseBytes > capture.responseLength
    )
  };
}

function preview(body: Buffer, headers: HeaderList | undefined, overflow: boolean): BodyPreview {
  let bytes = body;
  if (headers && getHeader(headers, "transfer-encoding")?.toLowerCase().includes("chunked")) {
    bytes = decodeChunked(body) ?? body;
  }
  const truncated = overflow || bytes.length > MAX_PREVIEW_BYTES;
  const shown = bytes.subarray(0, MAX_PREVIEW_BYTES);
  const binary = shown.includes(0);
  return { text: binary ? null : shown.toString("utf8"), size: bytes.length, truncated, binary };
}
