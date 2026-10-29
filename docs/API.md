# API Reference

Internal module APIs for Wormhole. This document is updated alongside the code.

## `@wormhole/protocol`

Binary frame codec for the tunnel protocol. Public entry point:
`protocol/src/index.ts`. Wire format is specified in
[`PROTOCOL.md`](./PROTOCOL.md).

### Constants

| Export | Value | Meaning |
|---|---|---|
| `FrameType` | object | `AUTH=1 ASSIGN=2 OPEN=3 DATA=4 CLOSE=5 PING=6 PONG=7 ERROR=8` |
| `HEADER_SIZE` | `9` | Bytes in every frame header |
| `MAX_PAYLOAD` | `16384` | Maximum payload bytes per frame |
| `CONTROL_STREAM_ID` | `0` | Stream ID for connection-level frames |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Heartbeat cadence |
| `HEARTBEAT_TIMEOUT_MS` | `30000` | Silence before a connection is dead |

### Functions

```ts
isFrameType(value: number): value is FrameType
frameTypeName(type: number): string
encodeFrame(type: FrameType, streamId: number, payload?: Buffer): Buffer
encodeJsonFrame(type: FrameType, streamId: number, value: unknown): Buffer
decodeJson<T>(frame: Frame): T
```

- `encodeFrame` builds `Type | StreamID | Length | Payload` (big-endian).
  Throws `ProtocolError("BAD_STREAM_ID")` or `ProtocolError("PAYLOAD_TOO_LARGE")`.
- `encodeJsonFrame` JSON-encodes `value` into the payload.
- `decodeJson` parses a control frame payload, throwing
  `ProtocolError("BAD_PAYLOAD")` on invalid JSON.

### `class FrameDecoder`

Incremental decoder that tolerates partial, merged, and split frames.

```ts
new FrameDecoder(options?: { maxPayload?: number })
decoder.push(chunk: Buffer): Frame[]
decoder.bufferedBytes: number      // getter
decoder.reset(): void
```

- `push` appends `chunk` to an internal buffer and returns every complete
  `Frame` available.
- Throws `ProtocolError("UNKNOWN_TYPE")` for an unrecognized frame type and
  `ProtocolError("PAYLOAD_TOO_LARGE")` when a declared length exceeds
  `maxPayload`.

### Types

```ts
interface Frame { type: FrameType; streamId: number; payload: Buffer }
type TunnelType = "http" | "tcp"
interface AuthPayload { token: string; type: TunnelType; subdomain?: string; port?: number }
interface AssignPayload { subdomain: string; url?: string; port?: number }
interface ErrorPayload { code: string; message: string }
```

### Errors

```ts
class ProtocolError extends Error {
  readonly code: string;
}
```

## `@wormhole/transport`

Shared socket runtime used by both the relay server and the client. Public entry
point: `transport/src/index.ts`. It depends only on `@wormhole/protocol`, so the
client never has to depend on the server package.

### `transport/src/mux.ts`

Multiplexes logical streams over one socket, following
[`PROTOCOL.md`](./PROTOCOL.md).

```ts
interface MuxOptions { heartbeatIntervalMs: number; heartbeatTimeoutMs: number }

class Mux extends EventEmitter {
  constructor(socket: Socket, options: MuxOptions)
  readonly isDestroyed: boolean
  readonly streamCount: number
  openStream(): Stream
  acceptStream(id: number): Stream
  sendFrame(type: FrameType, streamId: number, payload?: Buffer): boolean
  sendJsonFrame(type: FrameType, streamId: number, value: unknown): boolean
  pause(): void
  resume(): void
  destroy(reason?: Error): void
}
```

`openStream` allocates an odd id and sends `OPEN` (server side).
`acceptStream` registers a peer-initiated stream without sending a frame
(client side).

**Mux events**

| Event | Payload | Meaning |
|---|---|---|
| `control` | `Frame` | A stream-0 frame the mux does not handle (`AUTH`, `ASSIGN`, `ERROR`) |
| `open` | `number` | The peer opened a stream with this id |
| `close` | `reason?: Error` | The mux shut down |
| `error` | `Error` | Fatal protocol or socket error |

The mux handles `PING`/`PONG` heartbeats itself: it sends `PING` every
`heartbeatIntervalMs` and destroys the connection after `heartbeatTimeoutMs`
of silence. It allocates odd stream ids (starting at 1) for `openStream`.

```ts
class Stream extends EventEmitter {
  readonly id: number
  readonly isClosed: boolean
  write(chunk: Buffer): boolean   // false means backpressure; resume on "drain"
  close(): void
  pauseControl(): void            // pause the shared control socket
  resumeControl(): void
}
```

**Stream events**

| Event | Payload | Meaning |
|---|---|---|
| `data` | `Buffer` | Bytes from the peer |
| `close` | — | Stream ended for any reason |
| `drain` | — | Socket drained; safe to resume writing |
| `error` | `Error` | Stream aborted with a reason |

### `transport/src/http.ts`

Minimal HTTP/1.1 helpers shared by the server's public listener and the client's
502 page.

```ts
interface ParsedRequestHead { method: string; target: string; version: string; headers: [string, string][]; bodyOffset: number }

parseRequestHead(buffer: Buffer): ParsedRequestHead | null
getHeader(headers: [string, string][], name: string): string | undefined
serializeRequestHead(head: ParsedRequestHead): Buffer
renderResponse(status: number, title: string, message: string, headers?: Record<string, string>): Buffer
```

`parseRequestHead` returns `null` until the `\r\n\r\n` terminator is present or
if the request is malformed. `serializeRequestHead` forces `Connection: close`
so each stream carries exactly one request/response. `renderResponse` adds any
extra headers after the fixed ones (used for `Retry-After` on `429`).

### `transport/src/logger.ts`

```ts
type LogLevel = "debug" | "info" | "warn" | "error"
interface Logger { debug(msg, meta?); info(msg, meta?); warn(msg, meta?); error(msg, meta?) }
createLogger(scope: string): Logger
```

Level is controlled by the `WORMHOLE_LOG_LEVEL` environment variable
(default `info`).

## `@wormhole/server`

Relay server. Entry point: `server/src/index.ts`.

### `server/src/config.ts`

```ts
class ConfigError extends Error {}
interface CertConfig { dir: string; keyPath: string; certPath: string; commonName: string; altNames: string[]; days: number }
interface HeartbeatConfig { intervalMs: number; timeoutMs: number }
interface LimitsConfig { maxStreamsPerTunnel: number; maxTunnelsPerToken: number; requestsPerMinute: number }
interface TcpConfig { enabled: boolean; bindHost: string; portStart: number; portEnd: number }
type PublicScheme = "http" | "https"
interface Config {
  controlPort: number; httpPort: number; publicHost: string;
  publicScheme: PublicScheme; publicPort: number;
  tokens: Set<string>; heartbeat: HeartbeatConfig; limits: LimitsConfig;
  tcp: TcpConfig; cert: CertConfig;
}

parseConfig(raw: unknown, options: { baseDir: string }): Config
loadConfig(path: string): Config
```

- `loadConfig` reads YAML from `path` and validates it, throwing `ConfigError`
  with a descriptive message on any problem.
- `parseConfig` is the pure validator, useful in tests.
- Relative cert paths are resolved against `options.baseDir`.
- `limits` and `tcp` are optional in YAML and fall back to safe defaults. A
  limit of `0` disables that particular cap.
- `publicScheme`/`publicPort` control the URL sent in `ASSIGN`; use
  `https`/`443` when a reverse proxy terminates TLS.

### `server/src/paths.ts`

| Export | Meaning |
|---|---|
| `SERVER_ROOT` | Absolute path to the `server/` directory |
| `DEFAULT_CONFIG_PATH` | `<SERVER_ROOT>/config.yaml` |

### `server/src/certs.ts`

```ts
interface TlsCredentials { key: Buffer; cert: Buffer }

ensureCertificate(config: CertConfig): Promise<TlsCredentials>
generateCertificate(config: CertConfig): Promise<{ keyPath: string; certPath: string; created: boolean }>
```

Generates a self-signed certificate with `selfsigned` when the key/cert files
are missing, then returns them as buffers.

### `server/src/scripts/gen-cert.ts`

CLI (invoked by `npm run gen-cert`) that ensures the certificate exists.
Accepts an optional config path as the first argument.

### `server/src/limits.ts`

```ts
interface LimitDecision { allowed: boolean; retryAfterMs: number }
class SlidingWindowLimiter {
  constructor(limit: number, windowMs?: number)   // windowMs default 60000
  take(now?: number): LimitDecision
}

type TunnelLimitCode = "TOO_MANY_STREAMS" | "RATE_LIMITED" | "TOO_MANY_TUNNELS"
class TunnelLimitError extends Error {
  readonly code: TunnelLimitCode
  readonly retryAfterMs: number
}
```

A sliding-window limiter with bounded memory (`limit <= 0` disables it) and the
error type used by the registry/public listeners.

### `server/src/ports.ts`

```ts
class PortPool {
  constructor(start: number, end: number)
  readonly size: number
  readonly inUse: number
  acquire(): number | undefined
  release(port: number): void
}
```

Hands out public TCP ports from an inclusive range and reuses released ports.

### `server/src/registry.ts`

```ts
interface TunnelSession {
  subdomain: string; type: TunnelType; token: string;
  readonly streamCount: number;
  openStream(): Stream;
  close(): void | Promise<void>;
}

interface TunnelOptions {
  subdomain: string; type: TunnelType; token: string;
  limits: LimitsConfig; openStream: () => Stream;
  close?: () => void | Promise<void>;
}

class Tunnel implements TunnelSession {
  constructor(options: TunnelOptions)
  readonly streamCount: number
  openStream(): Stream     // throws TunnelLimitError at the stream/rate cap
  close(): void
}

interface RegistryOptions { maxTunnelsPerToken?: number }

class TunnelRegistry {
  constructor(options?: RegistryOptions)
  readonly size: number
  has(subdomain: string): boolean
  get(subdomain: string): TunnelSession | undefined
  countForToken(token: string): number
  add(tunnel: TunnelSession): void        // throws if taken or token cap reached
  remove(subdomain: string): void         // also closes the tunnel
  closeAll(): Promise<void>               // graceful shutdown
  subdomains(): string[]
  generateSubdomain(): string
}

isValidSubdomain(value: string): boolean
```

### `server/src/hosts.ts`

Pure helpers for public-host routing.

```ts
stripPort(host: string): string
publicHostname(subdomain: string, config: { publicHost: string }): string
publicUrl(subdomain: string, config: { publicHost: string; publicScheme?: "http" | "https"; publicPort?: number; httpPort?: number }): string
publicTcpUrl(port: number, config: { publicHost: string }): string
subdomainFromHost(hostHeader: string | undefined, publicHost: string): string | null
```

`subdomainFromHost` returns `null` for the bare public host or an unrelated
host, and validates that the extracted label is a legal subdomain. `publicUrl`
omits the port for `http:80` and `https:443`; `publicTcpUrl` returns
`tcp://host:port`.

### `server/src/control.ts`

```ts
interface ControlServerOptions {
  config: Config
  credentials: TlsCredentials
  registry: TunnelRegistry
  authTimeoutMs?: number   // default 10000
}
createControlServer(options: ControlServerOptions): Server
```

Creates the TLS control listener. Each connection is wrapped in a `Mux`. The
first frame must be `AUTH`; on success the server registers the tunnel and
replies `ASSIGN` with `{ subdomain, url }` for HTTP or
`{ subdomain, port, url }` for TCP. Failures send an `ERROR` frame with one of
these codes:

| Code | Cause |
|---|---|
| `AUTH_TIMEOUT` | No `AUTH` within `authTimeoutMs` |
| `BAD_AUTH` | Malformed `AUTH` payload |
| `BAD_TOKEN` | Token not in `config.tokens` |
| `UNSUPPORTED` | TCP tunnel requested while `tcp.enabled` is false |
| `BAD_SUBDOMAIN` | Invalid requested subdomain |
| `SUBDOMAIN_TAKEN` | Requested subdomain already in use |
| `TOO_MANY_TUNNELS` | The token owns its configured number of tunnels |
| `TUNNEL_UNAVAILABLE` | A TCP listener could not be created (e.g. port range exhausted) |
| `ALREADY_AUTH` | A second `AUTH` was sent |

The tunnel is unregistered from the registry when the connection closes. TCP
tunnels also close their public listener and release their port.

### `server/src/public.ts`

```ts
interface PublicServerOptions { config: Config; registry: TunnelRegistry }
createPublicServer(options: PublicServerOptions): Server
```

Creates the raw TCP public listener. For each connection it parses the request
head, routes by the `Host` header, opens a stream, and forwards the request as
raw HTTP/1.1 bytes. Responses stream back to the public socket.

| Situation | Response |
|---|---|
| No matching subdomain / bare host | `404` |
| Registered tunnel missing | `404` |
| Tunnel cannot open a stream | `502` |
| Tunnel stream/rate cap reached | `429` with `Retry-After` |
| Stream closes without any data | `502` |
| Headers exceed 64 KB | `400` |

### `server/src/public-tcp.ts`

```ts
interface TcpTunnelOptions { bindHost: string; port: number; openStream: () => Stream }
interface TcpTunnel { readonly port: number; close(): Promise<void> }
listenTcpTunnel(options: TcpTunnelOptions): Promise<TcpTunnel>
```

Creates one public TCP listener per tunnel. Every accepted connection opens a
stream and bridges bytes in both directions, with the same connection-wide
backpressure rules as HTTP streams. The caller allocates the port and releases
it when the tunnel closes.

### `server/src/mock-client.ts`

A throwaway tunnel client used to exercise the server end to end before the real
CLI existed; superseded by [`@wormhole/client`](#wormholeclient) and kept for the
server's own e2e tests. It connects over TLS, authenticates, and proxies each stream to a
local TCP port.

```ts
interface MockClientOptions {
  serverHost: string
  serverPort: number
  token: string
  localPort: number
  subdomain?: string
  insecure?: boolean
  onAssigned?: (assign: AssignPayload) => void
}
interface MockClient { assigned: Promise<AssignPayload>; close(): void }
startMockClient(options: MockClientOptions): MockClient
```

### `server/src/scripts/mock-client.ts`

CLI wrapper around `startMockClient` (`npm run mock-client --workspace @wormhole/server`).

### `server/src/index.ts`

Bootstrap. Loads config, ensures the certificate, starts the control and public
listeners, tracks active sockets, and handles `SIGINT`/`SIGTERM` by draining
tunnels and closing listeners (bounded by a 3 s timer). Config path override:
`WORMHOLE_CONFIG`. Set `WORMHOLE_TLS_KEYLOG` to append TLS secrets for Wireshark.

## `@wormhole/client`

Tunnel client and CLI. Entry points: `client/src/index.ts` (library) and
`client/src/cli.ts` (CLI, run via `client/bin/wormhole.js`). Design notes:
[`CLIENT.md`](./CLIENT.md).

### `client/src/cli.ts`

```
wormhole http <port> [options]
wormhole tcp <port> [options]

-t, --token <token>       auth token (env: WORMHOLE_TOKEN)            required
-s, --server <host:port>  relay control server (env: WORMHOLE_SERVER)  default localhost:4443
-n, --subdomain <name>    request a specific subdomain
    --local-host <host>   host of the local app                        default localhost
    --inspect-port <port> inspector dashboard port (http only)         default 4040
    --no-inspect          do not start the inspector (http only)
    --secure              verify the relay's TLS certificate
    --ca <file>           trust this certificate (implies --secure)
    --no-reconnect        exit instead of reconnecting
```

`http` prints a public URL and starts the inspector; `tcp` prints a public
`tcp://host:port` endpoint and bridges raw connections. Exit code `0` on
Ctrl+C, `1` on a fatal error (bad token, subdomain taken, certificate failure).

### `client/src/client.ts`

```ts
interface TunnelClientOptions {
  serverHost: string; serverPort: number; token: string;
  type?: "http" | "tcp";                          // default http
  localPort: number; localHost?: string;          // default localhost
  subdomain?: string;
  verifyCertificate?: boolean;                    // default false (self-signed dev relay)
  ca?: Buffer | string;
  heartbeatIntervalMs?: number;                   // default 10000
  heartbeatTimeoutMs?: number;                    // default 30000
  handshakeTimeoutMs?: number;                    // default 10000
  reconnect?: boolean;                            // default true
  backoff?: BackoffOptions;
  observe?: (streamId: number) => StreamObserver | undefined;
}

type ClientState = "idle" | "connecting" | "online" | "reconnecting" | "closed"

class TunnelClient extends EventEmitter {
  constructor(options: TunnelClientOptions)
  readonly state: ClientState
  readonly assigned: AssignPayload | undefined
  readonly streamCount: number
  readonly streams: StreamEntry[]   // stream table snapshot: { id, openedAt }
  start(): Promise<AssignPayload>   // resolves on first ASSIGN, rejects only on a fatal error
  close(): void                     // closes all streams; no reconnect
}

class TunnelError extends Error { readonly code: string }
```

**TunnelClient events**

| Event | Payload | Meaning |
|---|---|---|
| `connecting` | `{ attempt }` | Dialing the relay |
| `assigned` | `AssignPayload, { reconnected }` | Tunnel is live |
| `disconnected` | `{ reason }` | An online connection was lost |
| `reconnecting` | `{ attempt, delayMs, reason }` | Next attempt scheduled |
| `fatal` | `TunnelError` | Gave up; the client is closed |
| `closed` | — | `close()` finished |

Fatal codes: `BAD_TOKEN`, `BAD_AUTH`, `UNSUPPORTED`, `BAD_SUBDOMAIN`, TLS
certificate errors, and `SUBDOMAIN_TAKEN` before the first `ASSIGN`. Everything
else is retried.

### `client/src/local.ts`

```ts
interface LocalTarget { host: string; port: number }
interface ProxyStreamOptions {
  stream: Stream; target: LocalTarget; observer?: StreamObserver;
  connectTimeoutMs?: number;   // default 10000
  reportError?: (error: ErrorPayload) => void;   // stream-level ERROR to the server
  onDone?: () => void;
}
proxyStream(options: ProxyStreamOptions): void
proxyRawStream(options: ProxyStreamOptions): void
```

`proxyStream` bridges one stream to one local TCP connection for HTTP: queues
`DATA` until connected, and if the local app is unreachable sends
`ERROR { code: "LOCAL_DOWN" }` on the stream, a `502 Bad Gateway` page as
`DATA`, then `CLOSE`. Closes each side when the other closes and applies
backpressure both ways. `proxyRawStream` is the TCP variant: no HTTP parsing or
502 page, just raw bytes and `LOCAL_DOWN` + `CLOSE` on failure.

### `client/src/backoff.ts`

```ts
interface BackoffOptions { initialDelayMs?: number; maxDelayMs?: number; factor?: number; jitter?: number }
class Backoff {
  constructor(options?: BackoffOptions)   // defaults 1000, 30000, 2, 0.2
  readonly attempts: number
  next(random?: () => number): number
  reset(): void
}
```

## `@wormhole/inspector`

Request log and dashboard used by the client. Entry point:
`inspector/src/index.ts`.

### `inspector/src/store.ts`

```ts
interface StreamObserver {
  request(chunk: Buffer): void    // bytes from the public side
  response(chunk: Buffer): void   // bytes from the local app
  end(info?: { error?: string }): void
}

interface RequestSummary {
  id: number; streamId: number | null; replayOf: number | null;
  state: "pending" | "complete" | "error";
  method: string | null; path: string | null;
  status: number | null; statusText: string | null;
  startedAt: number; ttfbMs: number | null; durationMs: number | null;
  requestBytes: number; responseBytes: number;
  replayable: boolean; error: string | null;
}

interface RequestDetail extends RequestSummary {
  requestHeaders: [string, string][]; responseHeaders: [string, string][];
  requestBody: BodyPreview; responseBody: BodyPreview;
}
interface BodyPreview { text: string | null; size: number; truncated: boolean; binary: boolean }

interface TunnelStatus {
  state: "connecting" | "online" | "reconnecting" | "offline";
  url: string | null; localPort: number | null; message: string | null;
}

class RequestStore extends EventEmitter {
  constructor(options?: { target?: { host: string; port: number }; maxRecords?: number; now?: () => number })
  readonly size: number
  readonly status: TunnelStatus
  setStatus(status: Partial<TunnelStatus>): void
  setTarget(target: { host: string; port: number }): void
  observe(streamId: number): StreamObserver
  list(): RequestSummary[]                  // newest first
  get(id: number): RequestDetail | undefined
  replay(id: number): Promise<RequestSummary>
  clear(): void
}
```

Events: `upsert (RequestSummary)`, `clear ()`, `status (TunnelStatus)`.
`replay` throws `ReplayError` with code `NOT_FOUND`, `NOT_REPLAYABLE` or
`NO_TARGET`.

| Constant | Value |
|---|---|
| `MAX_CAPTURE_BYTES` | 1 MB per request kept for replay |
| `MAX_PREVIEW_BYTES` | 16 KB of body shown |
| `DEFAULT_MAX_RECORDS` | 200 |
| `REPLAY_TIMEOUT_MS` | 30000 |

### `inspector/src/server.ts`

```ts
startInspectorServer(options: { store: RequestStore; port?: number; host?: string }): Promise<InspectorServer>
interface InspectorServer { readonly port: number; readonly url: string; close(): Promise<void> }
```

Binds `127.0.0.1:4040` by default.

| Method | Path | Response |
|---|---|---|
| GET | `/` | Dashboard (`inspector/public/`) |
| GET | `/api/status` | `TunnelStatus` |
| GET | `/api/requests` | `RequestSummary[]` |
| GET | `/api/requests/:id` | `RequestDetail` or `404` |
| POST | `/api/requests/:id/replay` | New `RequestSummary`; `409` if not replayable |
| DELETE | `/api/requests` | Clears the log |
| WS | `/ws` | `snapshot`, then `upsert` / `clear` / `status` messages |

Cross-origin `POST`, `DELETE` and WebSocket connections are rejected (`403`).

### `inspector/src/parse.ts`

```ts
parseRequestHead(buffer: Buffer): RequestHead | null
parseResponseHead(buffer: Buffer): ResponseHead | null
getHeader(headers: [string, string][], name: string): string | undefined
decodeChunked(body: Buffer): Buffer | null
```

## `@wormhole/dashboard`

Local web dashboard for creating and inspecting tunnels. Entry point:
`dashboard/src/index.ts`. It depends on `@wormhole/client` and
`@wormhole/inspector`; the relay and protocol are unchanged.

### `dashboard/src/manager.ts`

```ts
interface TunnelSnapshot {
  id: string; type: "http" | "tcp";
  localHost: string; localPort: number;
  state: "starting" | "online" | "reconnecting" | "offline";
  url: string | null; subdomain: string | null; message: string | null;
  createdAt: number; streamCount: number; requestCount: number; errorCount: number;
}

interface CreateTunnelInput {
  type?: "http" | "tcp"; localPort: number; localHost?: string;
  subdomain?: string; server?: string; token?: string;
  secure?: boolean; caPath?: string;
}

class TunnelManager extends EventEmitter {
  constructor(defaults: ManagerDefaults)
  readonly count: number
  create(input: CreateTunnelInput): TunnelSnapshot
  list(): TunnelSnapshot[]
  get(id: string): ManagedTunnel
  stop(id: string): void
  requests(id: string): RequestSummary[]
  request(id: string, requestId: number): RequestDetail | undefined
  replay(id: string, requestId: number): Promise<RequestSummary>
  clear(id: string): void
  closeAll(): void
}
```

Every tunnel owns one `TunnelClient`; every HTTP tunnel also owns one
`RequestStore`. Events: `tunnel (snapshot)`, `remove (id)`,
`request (id, summary)`, `clear (id)`.

### `dashboard/src/server.ts`

```ts
startDashboardServer(options?: {
  port?: number; host?: string;
  manager?: TunnelManager;
  defaults?: Partial<ManagerDefaults>;
}): Promise<DashboardServer>

interface DashboardServer {
  readonly port: number; readonly url: string;
  readonly manager: TunnelManager;
  close(): Promise<void>;
}
```

Binds `127.0.0.1:4040` by default. Routes:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Defaults and current tunnels |
| GET/POST | `/api/tunnels` | List or start tunnels |
| GET/DELETE | `/api/tunnels/:id` | Snapshot or stop a tunnel |
| GET/DELETE | `/api/tunnels/:id/requests` | List or clear requests |
| GET | `/api/tunnels/:id/requests/:rid` | Request detail |
| POST | `/api/tunnels/:id/requests/:rid/replay` | Replay a request |
| GET | `/api/health` | Liveness |
| WS | `/ws` | Snapshot and live tunnel/request messages |

Writes are same-origin only. The dashboard serves a strict CSP and never sends
the relay token to the browser; the optional per-browser token override is sent
only when starting a tunnel.

## `@wormhole/bench`

Benchmark harness. Entry point: `bench/src/run.ts` (`npm run bench`).

### `bench/src/load.ts`

```ts
interface LoadOptions {
  scenario: string; target: "direct" | "tunnel";
  url: string; headers: Record<string, string>;
  connections: number; durationSeconds: number;
  method?: "GET" | "POST"; body?: Buffer;
}
measure(options: LoadOptions): Promise<Measurement>
```

Runs `connections` workers for `durationSeconds`. Every request opens a new
connection (`agent: false`) because the tunnel's public listener forces
`Connection: close`; the direct baseline does the same for a fair comparison.
Reports requests/second, p50/p99/max latency, MB/s, errors, timeouts and
non-2xx responses.

### `bench/src/relay.ts`

```ts
startRelay(): Promise<BenchRelay>       // control + public listeners, limits off
startApp(body: Buffer): Promise<BenchApp>
startClient(options: { controlPort; localPort; subdomain }): Promise<TunnelClient>
```

### `bench/src/report.ts` / `bench/src/svg.ts`

`writeReport(report, outDir)` writes `latest.json`, `latest.md` and the SVG
charts. `barChart({ title, unit, series, groups })` is a dependency-free grouped
bar chart renderer.
