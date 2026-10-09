import { ProtocolError } from "./errors.ts";
import type { Frame } from "./types.ts";

/** Parse a JSON payload carried by a control frame. */
export function decodeJson<T>(frame: Frame): T {
  try {
    return JSON.parse(frame.payload.toString("utf8")) as T;
  } catch {
    throw new ProtocolError("BAD_PAYLOAD", `Frame payload is not valid JSON: ${frame.payload.toString("utf8")}`);
  }
}
