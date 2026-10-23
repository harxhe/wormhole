---
marp: true
title: Wormhole
paginate: true
theme: default
---

# Wormhole

### A self-hosted reverse tunnel with a custom multiplexing protocol

One outbound TLS connection · HTTP and raw TCP · TypeScript

---

## Problem

- Expose a local service to the internet without opening an inbound port
- ngrok is convenient but hosted and rate-limited
- We want a small, self-hosted alternative with a protocol we control

---

## Architecture

```
client ── one TLS connection ──► relay ──► internet
  │                                │
  └── localhost:PORT               ├── public HTTP :8080
                                   └── public TCP 15000-15099
```

- Client dials **out**; no inbound port on the local machine
- Every public request/connection becomes a stream
- All streams share one TLS connection

---

## Protocol

9-byte header: `Type | StreamID | Length | Payload` (max 16 KiB)

| Frame | Purpose |
|---|---|
| `AUTH` / `ASSIGN` | Token, tunnel type, public endpoint |
| `OPEN` / `DATA` / `CLOSE` | One logical stream |
| `PING` / `PONG` | Heartbeat: 10 s interval, 30 s timeout |
| `ERROR` | Machine-readable failure |

Odd stream ids for server-created streams; control frames use id `0`.

---

## Implementation

- `protocol/` — encoder, incremental decoder
- `transport/` — `Mux`, `Stream`, HTTP helpers, logger
- `server/` — TLS control, registry, public HTTP/TCP, limits, ports
- `client/` — CLI, reconnect/backoff, HTTP/TCP bridges
- `inspector/` — live request log and replay
- `bench/` — load generator and charts
- `deploy/` — Docker + Caddy wildcard TLS

---

## HTTP path

1. Public listener parses the request head and reads `Host`
2. Looks up the tunnel by subdomain
3. Opens a stream and forwards the request as raw HTTP/1.1
4. Client dials `localhost:PORT` and relays bytes back
5. Local app down → `502`, tunnel stays up

---

## Raw TCP path

1. Each TCP tunnel gets a public port from the configured range
2. Relay accepts a connection and opens a stream
3. Client bridges bytes to `localhost:PORT`
4. Local app down → connection closes, `LOCAL_DOWN` frame

Use cases: databases, SSH, custom protocols.

---

## Reliability

- Heartbeats detect dead connections; the relay frees the subdomain
- Client reconnects with 1→2→4→…→30 s backoff and jitter
- HTTP reconnect keeps the same public URL
- Fatal errors (bad token, bad subdomain, TLS failure) do not retry
- Graceful shutdown drains tunnels and exits within 3 s

---

## Limits and safety

- `maxStreamsPerTunnel` (default 50)
- `maxTunnelsPerToken` (default 5)
- `requestsPerMinute` (default 600)
- HTTP cap → `429` + `Retry-After`; tunnel stays connected
- Inspector bound to localhost; cross-origin replay rejected
- 64 KB header cap; 1 MB replay cap

---

## Inspector

- `http://localhost:4040`
- Method, path, status, TTFB, total time
- Live updates over WebSocket
- Request/response headers and bodies (16 KB preview)
- Replay a captured request directly to the local app

---

## Testing

- **133 automated tests**, 16 files
- Protocol round trips with split/merged chunks
- Mux, heartbeat, backpressure
- 50 concurrent requests, 2 MB down / 300 KB up
- Reconnect and same-subdomain tests
- HTTP/TCP tunnels, limits, inspector API/replay
- Strict `tsc --noEmit` clean

---

## Benchmarks (loopback)

| Scenario | Conn | Direct p50 | Tunnel p50 | Tunnel req/s |
|---|---:|---:|---:|---:|
| small | 1 | 0.81 ms | 3.16 ms | 294 |
| small | 10 | 7.49 ms | 25.24 ms | 379 |
| small | 100 | 67.73 ms | 164.09 ms | 609 |
| 1 MiB down | 1 | 3.67 ms | 15.50 ms | 59 |
| 300 KiB up | 1 | 1.42 ms | 5.88 ms | 152 |

Overhead is low at low concurrency; connection-wide flow control is the main
high-concurrency limit.

---

## Deployment

- Docker image + compose
- Caddy wildcard TLS for `*.tunnel.example.com`
- Real certificate for the control listener
- Ports: 80/443 (proxy), 4443 (control), TCP range
- Limits, logs, healthcheck, graceful stop

See `deploy/README.md`.

---

## What we learned

- Framing and stream ids are simple; backpressure is the hard part
- One request per stream keeps the model simple but rules out keep-alive
- Connection-wide flow control is easy to reason about, but not fair
- Testing against the real relay catches ordering and timing bugs

---

## Future work

- Per-stream flow-control windows
- HTTP keep-alive / WebSocket upgrades
- Stable public port across TCP reconnects
- Persistent inspector history
- VPS benchmark run with `tc netem` and an ngrok comparison

---

# Questions?

```sh
npm run server
npx wormhole http 3000 --token dev-token-please-change
```
