export { TunnelClient, TunnelError, DEFAULT_HANDSHAKE_TIMEOUT_MS } from "./client.ts";
export type { TunnelClientOptions, ClientState, StreamEntry } from "./client.ts";
export { proxyStream, LOCAL_CONNECT_TIMEOUT_MS } from "./local.ts";
export type { ProxyStreamOptions, LocalTarget } from "./local.ts";
export { Backoff } from "./backoff.ts";
export type { BackoffOptions } from "./backoff.ts";
