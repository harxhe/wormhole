import { HEADER_SIZE, MAX_PAYLOAD, isFrameType, frameTypeName } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import type { Frame } from "./types.ts";

export interface FrameDecoderOptions {
  /** Reject frames whose declared payload exceeds this size. Defaults to `MAX_PAYLOAD`. */
  maxPayload?: number;
}

/**
 * Incremental frame decoder. Feed it arbitrary chunks (partial, merged, or both)
 * via {@link push}; it returns every complete frame currently available and
 * buffers the remainder until more data arrives.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxPayload: number;

  constructor(options: FrameDecoderOptions = {}) {
    this.maxPayload = options.maxPayload ?? MAX_PAYLOAD;
  }

  /** Number of bytes buffered awaiting more data. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Drop any buffered bytes, e.g. after a protocol error. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk: Buffer): Frame[] {
    if (chunk.length === 0) return [];

    const buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    let offset = 0;

    while (buffer.length - offset >= HEADER_SIZE) {
      const type = buffer.readUInt8(offset);
      const streamId = buffer.readUInt32BE(offset + 1);
      const length = buffer.readUInt32BE(offset + 5);

      if (!isFrameType(type)) {
        throw new ProtocolError("UNKNOWN_TYPE", `Unknown frame type ${frameTypeName(type)}`);
      }
      if (length > this.maxPayload) {
        throw new ProtocolError("PAYLOAD_TOO_LARGE", `Frame payload of ${length} exceeds ${this.maxPayload} bytes`);
      }
      if (buffer.length - offset < HEADER_SIZE + length) break;

      const start = offset + HEADER_SIZE;
      frames.push({ type, streamId, payload: buffer.subarray(start, start + length) });
      offset = start + length;
    }

    this.buffer = offset === 0 ? buffer : buffer.subarray(offset);
    return frames;
  }
}
