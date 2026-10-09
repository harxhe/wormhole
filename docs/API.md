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
  sendFrame(type: FrameType, streamId: number, payload?: Buffer): boolean
  sendJsonFrame(type: FrameType, streamId: number, value: unknown): boolean
  pause(): void
  resume(): void
  destroy(reason?: Error): void
}
```

**Mux events**

| Event | Payload | Meaning |
|---|---|---|
| `control` | `Frame` | A stream-0 frame the mux does not handle (`AUTH`, `ASSIGN`, `ERROR`) |
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

_Control listener, registry, and public listener: not implemented yet._
