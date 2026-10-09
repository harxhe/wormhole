import type { FrameType } from "./constants.ts";

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Buffer;
}

export type TunnelType = "http" | "tcp";

export interface AuthPayload {
  token: string;
  type: TunnelType;
  /** Requested subdomain. Omitted to let the server assign a random one. */
  subdomain?: string;
  /** Local port the client proxies to. Informational for the server. */
  port?: number;
}

export interface AssignPayload {
  subdomain: string;
  /** Public URL for an HTTP tunnel. */
  url?: string;
  /** Public port for a TCP tunnel. */
  port?: number;
}

export interface ErrorPayload {
  code: string;
  message: string;
}
