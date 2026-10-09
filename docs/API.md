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

## `@wormhole/server`

Relay server. Entry point: `server/src/index.ts`.

### `server/src/config.ts`

```ts
class ConfigError extends Error {}
interface CertConfig { dir: string; keyPath: string; certPath: string; commonName: string; altNames: string[]; days: number }
interface HeartbeatConfig { intervalMs: number; timeoutMs: number }
interface Config { controlPort: number; httpPort: number; publicHost: string; tokens: Set<string>; heartbeat: HeartbeatConfig; cert: CertConfig }

parseConfig(raw: unknown, options: { baseDir: string }): Config
loadConfig(path: string): Config
```

- `loadConfig` reads YAML from `path` and validates it, throwing `ConfigError`
  with a descriptive message on any problem.
- `parseConfig` is the pure validator, useful in tests.
- Relative cert paths are resolved against `options.baseDir`.

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

### `server/src/logger.ts`

```ts
type LogLevel = "debug" | "info" | "warn" | "error"
interface Logger { debug(msg, meta?); info(msg, meta?); warn(msg, meta?); error(msg, meta?) }
createLogger(scope: string): Logger
```

Level is controlled by the `WORMHOLE_LOG_LEVEL` environment variable
(default `info`).

### `server/src/mux.ts`

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
}
```

**Stream events**

| Event | Payload | Meaning |
|---|---|---|
| `data` | `Buffer` | Bytes from the peer |
| `close` | — | Stream ended for any reason |
| `drain` | — | Socket drained; safe to resume writing |
| `error` | `Error` | Stream aborted with a reason |

### `server/src/registry.ts`

```ts
interface TunnelSession { subdomain: string; type: TunnelType; openStream(): Stream }

class TunnelRegistry {
  readonly size: number
  has(subdomain: string): boolean
  get(subdomain: string): TunnelSession | undefined
  add(tunnel: TunnelSession): void        // throws if the subdomain is taken
  remove(subdomain: string): void
  subdomains(): string[]
  generateSubdomain(): string             // unused, human-friendly name
}

isValidSubdomain(value: string): boolean
```

### `server/src/hosts.ts`

Pure helpers for public-host routing.

```ts
stripPort(host: string): string
publicHostname(subdomain: string, config: { publicHost: string }): string
publicUrl(subdomain: string, config: { publicHost: string; httpPort: number }): string
subdomainFromHost(hostHeader: string | undefined, publicHost: string): string | null
```

`subdomainFromHost` returns `null` for the bare public host or an unrelated
host, and validates that the extracted label is a legal subdomain.

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
replies `ASSIGN` with `{ subdomain, url }`. Failures send an `ERROR` frame with
one of these codes:

| Code | Cause |
|---|---|
| `AUTH_TIMEOUT` | No `AUTH` within `authTimeoutMs` |
| `BAD_AUTH` | Malformed `AUTH` payload |
| `BAD_TOKEN` | Token not in `config.tokens` |
| `UNSUPPORTED` | Non-HTTP tunnel type |
| `BAD_SUBDOMAIN` | Invalid requested subdomain |
| `SUBDOMAIN_TAKEN` | Requested subdomain already in use |
| `ALREADY_AUTH` | A second `AUTH` was sent |

The tunnel is unregistered from the registry when the connection closes.

### `server/src/http.ts`

Minimal HTTP/1.1 helpers for the raw public listener.

```ts
interface ParsedRequestHead { method: string; target: string; version: string; headers: [string, string][]; bodyOffset: number }

parseRequestHead(buffer: Buffer): ParsedRequestHead | null
getHeader(headers: [string, string][], name: string): string | undefined
serializeRequestHead(head: ParsedRequestHead): Buffer
renderResponse(status: number, title: string, message: string): Buffer
```

`parseRequestHead` returns `null` until the `\r\n\r\n` terminator is present or
if the request is malformed. `serializeRequestHead` forces `Connection: close`
so each stream carries exactly one request/response.

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
| Stream closes without any data | `502` |
| Headers exceed 64 KB | `400` |

### `server/src/mock-client.ts`

A throwaway tunnel client used to exercise the server end to end before the real
CLI exists. It connects over TLS, authenticates, and proxies each stream to a
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
listeners, and handles `SIGINT`/`SIGTERM`. Config path override:
`WORMHOLE_CONFIG`.
