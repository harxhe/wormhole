# Progress

Current state of the Wormhole implementation.

## Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Foundation

- [x] Monorepo skeleton (npm workspaces, TypeScript, vitest)
- [x] Shared `@wormhole/transport` package (mux, HTTP helpers, logger)

## Protocol

- [x] Frame constants and types
- [x] `encodeFrame`
- [x] `FrameDecoder` (partial and merged chunks)
- [x] Round-trip tests
- [x] `docs/PROTOCOL.md`
- [x] HTTP and raw TCP tunnel semantics documented

## Server core

- [x] Config loader (`config.yaml`) with defaults and validation
- [x] Self-signed certificate generation
- [x] TLS control listener
- [x] `AUTH` with static tokens
- [x] `ASSIGN` random/requested subdomain
- [x] Tunnel registry
- [x] Public HTTP listener with `Host` routing
- [x] 404 / 429 / 502 pages
- [x] Multiplexer (stream IDs, `OPEN`/`DATA`/`CLOSE`)
- [x] Backpressure handling
- [x] Heartbeat and dead-session cleanup
- [x] Graceful shutdown with socket tracking
- [x] Mock client for end-to-end verification

## Limits and raw TCP

- [x] Per-tunnel concurrent stream cap
- [x] Per-tunnel request-rate limit (sliding window)
- [x] Per-token active-tunnel cap
- [x] `429 Too Many Requests` with `Retry-After`
- [x] Raw TCP tunnel type in `AUTH`/`ASSIGN`
- [x] Per-tunnel public TCP listeners
- [x] Public TCP port allocator with reuse
- [x] `wormhole tcp <port>` CLI
- [x] Raw stream bridge with `LOCAL_DOWN` handling

## Client

- [x] CLI: `wormhole http <port>`, `wormhole tcp <port>`, `--token`, `--server`
- [x] TLS connect, `AUTH`, parse `ASSIGN`, print the public endpoint
- [x] Handle `OPEN`: dial `localhost:PORT`, queue `DATA` until connected
- [x] Stream table (one entry per stream)
- [x] 16 KB `DATA` frames, `CLOSE`, HTTP `502`, TCP `LOCAL_DOWN`
- [x] Heartbeat: reply `PONG`, detect 30 s silence
- [x] Auto-reconnect with exponential backoff, same subdomain on retry
- [x] Inspector on `:4040`: method, path, status, timing, live updates, replay

## Deployment

- [x] Dockerfile and `.dockerignore`
- [x] `docker-compose.yml` with healthcheck and persistent cert volume
- [x] Production config example (`deploy/config.production.yaml`)
- [x] Caddy wildcard-TLS example (`deploy/Caddyfile`)
- [x] Deployment guide: DNS, Let's Encrypt, firewall, control certificate,
  operations (`deploy/README.md`)
- [x] HTTP public URL scheme/port override for reverse-proxy TLS
- [x] TLS key log support for Wireshark (`WORMHOLE_TLS_KEYLOG`)

## Evaluation

- [x] Benchmark harness (`bench/`)
- [x] Latency/throughput for 1/10/50/100 connections
- [x] 1 MiB download and 300 KiB upload scenarios
- [x] JSON, Markdown and SVG chart output
- [x] `tc netem` helper script
- [x] Wireshark capture scripts and guide (`docs/CAPTURE.md`)
- [x] Sample capture and TLS key log (`bench/results/wormhole.pcap`)
- [x] Report (`docs/REPORT.md`), demo script (`docs/DEMO.md`), slides
  (`docs/SLIDES.md`)

## Verification

- [x] `npm test` — **134 tests passing** across 16 files
- [x] `npm run typecheck` — clean
- [x] Real-process smoke test: server + HTTP client + TCP client
- [x] Docker image builds and the relay starts in a container
- [x] Unknown host returns `404`
- [x] Benchmark results written to `bench/results/`

## Known limitations

- One HTTP request per stream; no keep-alive or WebSocket upgrade through a
  single stream.
- Backpressure is connection-wide, so one slow stream pauses all streams.
- TCP tunnels receive a new public port after a reconnect.
- TLS verification is off by default for the self-signed development relay.
- The inspector keeps the last 200 requests in memory and has no automated
  browser tests.
- Benchmarks run on loopback; a VPS run with `tc netem` and an ngrok comparison
  is still future work.

## Handoff notes

- The protocol is documented in [`docs/PROTOCOL.md`](./docs/PROTOCOL.md);
  coordinate any wire change there first.
- The public HTTP listener speaks **raw HTTP/1.1** and forces
  `Connection: close`, so each stream is exactly one request/response.
- `server/src/mock-client.ts` is a throwaway client used by server tests; the
  real deliverable is `@wormhole/client`.
- Backpressure is connection-wide: a single slow public socket pauses the shared
  control socket for all streams.
- For benchmarks, run the client with the inspector disabled; the harness does
  this automatically.
- `WORMHOLE_TLS_KEYLOG` writes TLS secrets for packet capture. Never commit the
  key log.
