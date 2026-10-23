# Wormhole: Project Report

## Abstract

Wormhole is a self-hosted reverse tunnel in the spirit of ngrok. A client opens
one outbound TLS connection to a relay server; the relay assigns a public HTTP
subdomain or a public TCP port and multiplexes every incoming request or
connection over that single control connection using a custom binary protocol.
The system is implemented in TypeScript on Node.js and includes a CLI client, a
live request inspector, per-tunnel limits, Docker packaging, and a benchmark
harness.

## Architecture

```
client machine                     relay server                     internet
┌──────────────┐   one TLS conn   ┌──────────────────┐
│ wormhole     │◄────────────────►│ control listener │
│  http <port> │   framed streams │  :4443           │
│  tcp <port>  │                  │                  │
└──────┬───────┘                  │ public HTTP      │◄── :8080 ── HTTP clients
       │                          │  :8080           │
       ▼                          │ public TCP       │◄── 15000-15099 ── TCP clients
 localhost:PORT                   │  per tunnel      │
                                  └──────────────────┘
```

The client always dials out, so the local network needs no inbound port.
The relay creates one logical stream per public request or TCP connection and
routes frames by stream id over the shared TLS connection.

## Wire protocol

Every frame has a 9-byte header: type (1 byte), stream id (4 bytes, big-endian),
payload length (4 bytes, big-endian), followed by at most 16 KiB of payload.

| Type | Direction | Purpose |
|---|---|---|
| `AUTH` | client → server | Token, tunnel type (`http`/`tcp`), optional subdomain |
| `ASSIGN` | server → client | Public URL or TCP port |
| `OPEN` | server → client | Start a stream |
| `DATA` | both | Raw bytes |
| `CLOSE` | both | End a stream |
| `PING`/`PONG` | both | Heartbeat every 10 s, dead after 30 s |
| `ERROR` | both | Machine-readable code + message |

Control frames use stream id `0`; server-created streams use odd ids. The decoder
handles split and coalesced TCP chunks. Backpressure is connection-wide: a full
socket pauses the shared control socket and resumes on `drain`.

## Implementation

- **`protocol/`** — frame types, encoder, incremental decoder, tests.
- **`transport/`** — shared `Mux`/`Stream`, HTTP/1.1 helpers and logger.
- **`server/`** — config, TLS certificate, control listener, tunnel registry,
  public HTTP listener, per-tunnel TCP listeners, port allocator, limits.
- **`client/`** — CLI (`http` and `tcp`), TLS session, reconnect/backoff,
  HTTP and raw stream bridges, inspector integration.
- **`inspector/`** — in-memory request log, WebSocket live updates, replay.
- **`bench/`** — one-request-per-connection load generator, JSON/Markdown/SVG
  reports.
- **`deploy/`** — Dockerfile, compose, production config, Caddy wildcard TLS.

### Limits

Each tunnel enforces:

- maximum concurrent streams (HTTP requests or TCP connections),
- maximum new streams per minute,
- maximum active tunnels per token (registry-level).

HTTP limits return `429 Too Many Requests` with `Retry-After`; the tunnel
connection itself stays open. TCP limits refuse the public connection.

### HTTP and TCP paths

- **HTTP:** the public listener parses the request head, routes by the `Host`
  header, opens a stream, serializes the request with `Connection: close`, and
  streams the response back. A local-app failure returns `502`.
- **TCP:** the relay listens on a port from the configured range for each TCP
  tunnel and bridges bytes in both directions. A local-app failure closes the
  public connection and emits `LOCAL_DOWN`.

## Testing

- `npm test`: **133 tests** across protocol, transport, server, inspector and
  client, including end-to-end tests against the real relay.
- `npm run typecheck`: clean under strict TypeScript.
- Real-process smoke test: `npm run server`, `wormhole http`, `wormhole tcp`,
  HTTP request and raw TCP echo all succeed.
- Docker image builds and the relay starts in a container; an unknown host
  returns `404`.

Coverage highlights:

| Area | Tests |
|---|---|
| Frame round trips, partial/merged chunks | `protocol/test` |
| Mux, heartbeat, backpressure | `transport/test` |
| Config, registry, limits, ports, control, public HTTP/TCP | `server/test` |
| 50 concurrent requests, 2 MB responses, 300 KB uploads, reconnect | `client/test` |
| TCP relay, CLI TCP, local app down, disabled TCP | `client/test/tcp.test.ts` |
| 429 stream and rate limits, per-token cap | `client/test/limits.test.ts`, `server/test` |
| Inspector API, WebSocket, replay | `inspector/test` |

## Evaluation

Benchmarks run on loopback (Windows, Node 22, 3 s per measurement). Each request
uses a fresh connection because the tunnel forces `Connection: close`; the
direct baseline does the same.

| Scenario | Connections | Direct p50 | Tunnel p50 | Direct req/s | Tunnel req/s |
|---|---:|---:|---:|---:|---:|
| small (2 B) | 1 | 0.81 ms | 3.16 ms | 1063 | 294 |
| small (2 B) | 10 | 7.49 ms | 25.24 ms | 1239 | 379 |
| small (2 B) | 50 | 37.21 ms | 94.96 ms | 1345 | 523 |
| small (2 B) | 100 | 67.73 ms | 164.09 ms | 1441 | 609 |
| download 1 MiB | 1 | 3.67 ms | 15.50 ms | 235 | 59 |
| download 1 MiB | 10 | 30.91 ms | 134.73 ms | 309 | 74 |
| upload 300 KiB | 1 | 1.42 ms | 5.88 ms | 428 | 152 |
| upload 300 KiB | 10 | 13.54 ms | 50.62 ms | 693 | 195 |

Observations:

- At low concurrency the tunnel adds roughly 2–12 ms of p50 latency.
- Throughput is about 24–42 % of the direct loopback baseline.
- The gap grows at 100 concurrent requests because flow control is
  connection-wide; one slow stream can pause the shared control socket.
- Large transfers are limited by the 16 KiB frame size and per-frame header
  overhead, not by memory use.

Full results: [`bench/results/latest.md`](../bench/results/latest.md).

## Security and operations

- Tokens are static and configured server-side; replace the development token.
- TLS is used for the control connection; production must use a trusted
  certificate and clients should pass `--secure`.
- The public HTTP listener speaks HTTP; a reverse proxy (Caddy) terminates
  wildcard TLS in production.
- Request bodies are capped for inspector replay (1 MB), headers at 64 KB per
  request.
- Graceful shutdown stops listeners, closes tunnels and exits within 3 s.
- `WORMHOLE_TLS_KEYLOG` enables Wireshark decryption for debugging; treat the
  key log as a secret.

## Limitations and future work

- One HTTP request per stream; keep-alive and WebSocket upgrades are not
  supported through a single stream.
- Connection-wide backpressure is simple but not per-stream fair.
- TCP tunnels receive a new public port after reconnect.
- No persistent request history; the inspector is in-memory (last 200).
- Benchmark numbers are loopback only; a VPS run with `tc netem` would be the
  next evaluation step.

## Reproducing

```sh
npm install
npm test
npm run typecheck
npm run server
# in another terminal
npx wormhole http 3000 --token dev-token-please-change --subdomain demo
npm run bench
docker build -t wormhole-relay .
```
