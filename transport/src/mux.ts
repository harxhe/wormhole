import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import {
  CONTROL_STREAM_ID,
  FrameDecoder,
  FrameType,
  MAX_PAYLOAD,
  encodeFrame
} from "@wormhole/protocol";
import type { Frame } from "@wormhole/protocol";
import { createLogger } from "./logger.ts";

const log = createLogger("mux");

/**
 * A single logical stream carried over a {@link Mux}. Created by the server via
 * {@link Mux.openStream}.
 *
 * Events:
 * - `data`  `(chunk: Buffer)` — bytes arrived from the peer
 * - `close` `()`              — the stream ended (peer closed, local close, or teardown)
 * - `drain` `()`              — the underlying socket drained; resume writing
 * - `error` `(err: Error)`    — the stream failed
 */
export class Stream extends EventEmitter {
  readonly id: number;
  private readonly mux: Mux;
  private closed = false;

  constructor(mux: Mux, id: number) {
    super();
    this.mux = mux;
    this.id = id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Send bytes to the peer, split into `MAX_PAYLOAD`-sized `DATA` frames.
   * Returns `false` when the socket is backed up; callers should pause their
   * source and resume on the `drain` event.
   */
  write(chunk: Buffer): boolean {
    if (this.closed) return false;
    let accepted = true;
    for (let offset = 0; offset < chunk.length; offset += MAX_PAYLOAD) {
      const end = Math.min(offset + MAX_PAYLOAD, chunk.length);
      if (!this.mux.sendStreamFrame(FrameType.DATA, this.id, chunk.subarray(offset, end))) {
        accepted = false;
      }
    }
    return accepted;
  }

  /** Close this stream, sending a `CLOSE` frame to the peer. */
  close(): void {
    if (this.closed) return;
    this.mux.sendStreamFrame(FrameType.CLOSE, this.id);
    this.finish();
  }

  /**
   * Pause the shared control socket. Used when a public socket is backed up so
   * the client stops sending data for all streams (connection-wide flow control).
   */
  pauseControl(): void {
    this.mux.pause();
  }

  /** Resume the shared control socket. */
  resumeControl(): void {
    this.mux.resume();
  }

  /** @internal Called by the mux when the peer sends `CLOSE`. */
  _receiveClose(): void {
    this.finish();
  }

  /** @internal Called by the mux when the peer sends `DATA`. */
  _receiveData(chunk: Buffer): void {
    if (this.closed) return;
    this.emit("data", chunk);
  }

  /** @internal Called by the mux when the socket drains. */
  _emitDrain(): void {
    if (this.closed) return;
    this.emit("drain");
  }

  /** @internal Tear down the stream without emitting a frame. */
  _abort(reason?: Error): void {
    if (this.closed) return;
    if (reason) this.emit("error", reason);
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.mux.removeStream(this.id);
    this.emit("close");
  }
}

export interface MuxOptions {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

/**
 * Multiplexes many logical streams over one socket. Emits:
 * - `control` `(frame: Frame)` — a stream-0 frame the mux does not handle itself
 *   (`AUTH`, `ASSIGN`, `ERROR`), for the caller to process
 * - `close`   `(reason?: Error)` — the mux shut down
 * - `error`   `(err: Error)`     — a fatal protocol/socket error
 */
export class Mux extends EventEmitter {
  private readonly socket: Socket;
  private readonly options: MuxOptions;
  private readonly decoder = new FrameDecoder();
  private readonly streams = new Map<number, Stream>();
  private nextStreamId = 1;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastReceivedAt = Date.now();
  private destroyed = false;

  constructor(socket: Socket, options: MuxOptions) {
    super();
    this.socket = socket;
    this.options = options;

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("drain", () => this.onDrain());
    socket.on("error", (err: Error) => this.destroy(err));
    socket.on("close", () => this.destroy());

    this.startHeartbeat();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Number of live streams. */
  get streamCount(): number {
    return this.streams.size;
  }

  /** Allocate an odd stream id and open it, sending an `OPEN` frame. */
  openStream(): Stream {
    if (this.destroyed) throw new Error("cannot open a stream on a closed mux");
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = new Stream(this, id);
    this.streams.set(id, stream);
    this.sendFrame(FrameType.OPEN, id);
    return stream;
  }

  /**
   * Register a peer-initiated stream (one announced by an incoming `OPEN`).
   * Does not send a frame.
   */
  acceptStream(id: number): Stream {
    if (this.destroyed) throw new Error("cannot accept a stream on a closed mux");
    const existing = this.streams.get(id);
    if (existing) return existing;
    const stream = new Stream(this, id);
    this.streams.set(id, stream);
    return stream;
  }

  /** Send a frame on the control socket. Returns `false` on backpressure. */
  sendFrame(type: FrameType, streamId: number, payload: Buffer = Buffer.alloc(0)): boolean {
    if (this.destroyed) return false;
    try {
      return this.socket.write(encodeFrame(type, streamId, payload));
    } catch (err) {
      this.destroy(err as Error);
      return false;
    }
  }

  /** Send a JSON control frame. */
  sendJsonFrame(type: FrameType, streamId: number, value: unknown): boolean {
    return this.sendFrame(type, streamId, Buffer.from(JSON.stringify(value), "utf8"));
  }

  /** @internal Used by {@link Stream} to send a frame. */
  sendStreamFrame(type: FrameType, streamId: number, payload: Buffer = Buffer.alloc(0)): boolean {
    return this.sendFrame(type, streamId, payload);
  }

  /** @internal Used by {@link Stream} when it finishes. */
  removeStream(id: number): void {
    this.streams.delete(id);
  }

  /**
   * Pause reading from the control socket. Used when a public socket is backed
   * up so the client stops sending (simple, connection-wide flow control).
   */
  pause(): void {
    this.socket.pause();
  }

  /** Resume reading from the control socket. */
  resume(): void {
    this.socket.resume();
  }

  /** Shut down the mux and all of its streams. */
  destroy(reason?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const stream of [...this.streams.values()]) {
      stream._abort(reason);
    }
    this.streams.clear();
    if (reason) this.emit("error", reason);
    this.emit("close", reason);
    if (!this.socket.destroyed) this.socket.end();
  }

  private onData(chunk: Buffer): void {
    this.lastReceivedAt = Date.now();
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.destroy(err as Error);
      return;
    }
    for (const frame of frames) {
      if (this.destroyed) return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case FrameType.DATA: {
        const stream = this.streams.get(frame.streamId);
        if (stream) stream._receiveData(frame.payload);
        else log.debug(`DATA for unknown stream ${frame.streamId}`);
        break;
      }
      case FrameType.CLOSE: {
        const stream = this.streams.get(frame.streamId);
        if (stream) stream._receiveClose();
        else log.debug(`CLOSE for unknown stream ${frame.streamId}`);
        break;
      }
      case FrameType.PING:
        this.sendFrame(FrameType.PONG, CONTROL_STREAM_ID);
        break;
      case FrameType.PONG:
        break;
      case FrameType.OPEN:
        log.debug(`peer opened stream ${frame.streamId}`);
        this.emit("open", frame.streamId);
        break;
      default:
        this.emit("control", frame);
        break;
    }
  }

  private onDrain(): void {
    for (const stream of [...this.streams.values()]) {
      stream._emitDrain();
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > this.options.heartbeatTimeoutMs) {
        this.destroy(new Error("heartbeat timeout"));
        return;
      }
      this.sendFrame(FrameType.PING, CONTROL_STREAM_ID);
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }
}
