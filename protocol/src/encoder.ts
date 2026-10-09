import { FrameType, HEADER_SIZE, MAX_PAYLOAD } from "./constants.ts";
import { ProtocolError } from "./errors.ts";

/**
 * Encode a single frame: `Type (1B) | StreamID (4B) | Length (4B) | Payload`.
 * Integers are big-endian. `payload` defaults to an empty buffer.
 */
export function encodeFrame(type: FrameType, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new ProtocolError("BAD_STREAM_ID", `Invalid stream id: ${streamId}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new ProtocolError("PAYLOAD_TOO_LARGE", `Payload of ${payload.length} exceeds ${MAX_PAYLOAD} bytes`);
  }
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(streamId, 1);
  frame.writeUInt32BE(payload.length, 5);
  payload.copy(frame, HEADER_SIZE);
  return frame;
}

/** Encode a control frame whose payload is a JSON value. */
export function encodeJsonFrame(type: FrameType, streamId: number, value: unknown): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(value), "utf8"));
}
