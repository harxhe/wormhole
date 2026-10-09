export const FrameType = {
  AUTH: 1,
  ASSIGN: 2,
  OPEN: 3,
  DATA: 4,
  CLOSE: 5,
  PING: 6,
  PONG: 7,
  ERROR: 8
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_VALUES = new Set<number>(Object.values(FrameType));

export function isFrameType(value: number): value is FrameType {
  return FRAME_TYPE_VALUES.has(value);
}

export function frameTypeName(type: number): string {
  for (const [name, value] of Object.entries(FrameType)) {
    if (value === type) return name;
  }
  return `UNKNOWN(${type})`;
}

/** Header is `Type (1B) | StreamID (4B) | Length (4B)`, big-endian. */
export const HEADER_SIZE = 9;

/** Maximum payload carried by a single DATA frame. */
export const MAX_PAYLOAD = 16 * 1024;

/** Stream ID reserved for connection-level control frames. */
export const CONTROL_STREAM_ID = 0;

/** Heartbeat cadence and timeout, in milliseconds. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
