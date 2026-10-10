# Progress

Current state of the Wormhole implementation.

## Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Foundation

- [x] Monorepo skeleton (npm workspaces, TypeScript, vitest)

## Protocol

- [x] Frame constants and types
- [x] `encodeFrame`
- [x] `FrameDecoder` (partial and merged chunks)
- [x] Round-trip tests (13 passing)
- [x] `docs/PROTOCOL.md`

## Server core

- [x] Config loader (`config.yaml`)
- [x] Self-signed certificate generation
- [x] TLS control listener
- [x] `AUTH` with static tokens
- [x] `ASSIGN` random subdomain
- [x] Tunnel registry
- [x] Public HTTP listener with `Host` routing
- [x] 404 / 502 pages
- [x] Multiplexer (stream IDs, `OPEN`/`DATA`/`CLOSE`)
- [x] Backpressure handling
- [x] Mock client for end-to-end verification

### Verification

- [x] `npm test` — 61 tests passing (protocol, config, mux, registry, hosts, http, control, public, e2e)
- [x] `npx tsc --noEmit` — clean
- [x] `curl -H "Host: demo.localhost" http://localhost:8080/` returns the local app's response
- [x] Unknown host returns `404`

## Client (Phase 1)

- [x] CLI: `wormhole http <port>`, `--token`, `--server` (commander)
- [x] TLS connect, `AUTH`, parse `ASSIGN`, print the public URL
- [x] Handle `OPEN`: dial `localhost:PORT`, queue `DATA` until connected
- [x] Stream table (one entry per stream): local data to 16 KB `DATA` frames, `CLOSE`, `502` + `ERROR LOCAL_DOWN` if the local app is down
- [x] Heartbeat: reply `PONG`, detect 30 s silence
- [x] Auto-reconnect with exponential backoff, same subdomain on retry
- [x] Inspector on `:4040`: method, path, status, timing, live updates over `ws`, replay button

### Verification

- [x] `npm test` — 105 tests passing (61 server/protocol + 44 client/inspector)
- [x] 50 concurrent requests over one tunnel connection
- [x] 2 MB response and 300 KB upload split into 16 KB frames
- [x] `502` when the local app is down; tunnel stays up
- [x] Reconnect after a server restart keeps the same subdomain
- [x] `npx tsc --noEmit` — clean for root and every workspace

## Deployment and evaluation

- [ ] Docker deployment
- [ ] Benchmarks
- [ ] Packet captures

## Handoff checklist (Phase 0 → Phase 1)

- [x] Server starts with `npm run server` (documented in the README)
- [x] `docs/PROTOCOL.md` complete and protocol tests pass
- [x] A sample `curl` command proves routing works
- [x] README lists the test token, ports, and config
- [x] Committed to `main`, with empty `client/` and `inspector/` folders ready

## Handoff back checklist (Phase 1 → Phase 2)

- [x] Branch merged to `main` (PR #1, README section on running the client: done)
- [x] List of known bugs or unfinished items ([`docs/CLIENT.md`](./docs/CLIENT.md#known-issues-and-unfinished-items))
- [x] Short note on client design in `docs/` ([`docs/CLIENT.md`](./docs/CLIENT.md))

## Handoff notes

- The protocol is frozen; coordinate any change before editing
  [`docs/PROTOCOL.md`](./docs/PROTOCOL.md).
- The public listener speaks **raw HTTP/1.1** and forces `Connection: close`, so
  each stream is exactly one request/response. Keep-alive is out of scope.
- `server/src/mock-client.ts` is a throwaway client for local verification only;
  it is not the deliverable CLI.
- Backpressure is connection-wide: a single slow public socket pauses the shared
  control socket for all streams (simple flow control, acceptable for now).

### Phase 1 notes

- `/protocol` is unchanged. The client and server share `Mux`, the HTTP helpers
  and the logger through the new [`@wormhole/transport`](./transport/README.md)
  package; the client no longer depends on `@wormhole/server`.
- `server/src/mock-client.ts` is superseded by the real client and can be
  removed in Phase 2 (the server e2e tests still use it).
- Phase 2 server-side dead-session cleanup also speeds up reconnects: after an
  abrupt network loss the client keeps retrying on `SUBDOMAIN_TAKEN` until the
  server frees its old name (up to the 30 s heartbeat timeout).
- For the benchmarks: run the client with `--no-inspect` to measure the tunnel
  alone.

### Post-merge cleanup (resolved review items)

- Extracted `@wormhole/transport` (`Mux`, `Stream`, HTTP helpers, logger) so the
  client no longer reaches into `server/src`; dependency direction is now
  `protocol ← transport ← {server, client}`.
- Declared `tsx` as a dependency of the client (its `bin` runs TS directly).
- `ws` is imported lazily by the inspector, so `--no-inspect` no longer loads it.
