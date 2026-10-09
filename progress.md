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
- [ ] TLS control listener
- [ ] `AUTH` with static tokens
- [ ] `ASSIGN` random subdomain
- [ ] Tunnel registry
- [ ] Public HTTP listener with `Host` routing
- [ ] 404 / 502 pages
- [ ] Multiplexer (stream IDs, `OPEN`/`DATA`/`CLOSE`)
- [ ] Backpressure handling
- [ ] Mock client for end-to-end verification

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

## Handoff notes

_None yet._
