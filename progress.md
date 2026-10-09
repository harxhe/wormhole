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

## Client

- [ ] CLI
- [ ] TLS connect and authentication
- [ ] Stream handling
- [ ] Heartbeat
- [ ] Auto-reconnect
- [ ] Inspector dashboard

## Deployment and evaluation

- [ ] Docker deployment
- [ ] Benchmarks
- [ ] Packet captures

## Handoff checklist

- [x] Server starts with `npm run server` (documented in the README)
- [x] `docs/PROTOCOL.md` complete and protocol tests pass
- [x] A sample `curl` command proves routing works
- [x] README lists the test token, ports, and config
- [x] Committed to `main`, with empty `client/` and `inspector/` folders ready

## Handoff notes

- The protocol is frozen; coordinate any change before editing
  [`docs/PROTOCOL.md`](./docs/PROTOCOL.md).
- The public listener speaks **raw HTTP/1.1** and forces `Connection: close`, so
  each stream is exactly one request/response. Keep-alive is out of scope.
- `server/src/mock-client.ts` is a throwaway client for local verification only;
  it is not the deliverable CLI.
- Backpressure is connection-wide: a single slow public socket pauses the shared
  control socket for all streams (simple flow control, acceptable for now).
