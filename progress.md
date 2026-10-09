# Progress

Current state of the Wormhole implementation.

## Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` done

## Foundation

- [x] Monorepo skeleton (npm workspaces, TypeScript, vitest)

## Protocol

- [ ] Frame constants and types
- [ ] `encodeFrame`
- [ ] `FrameDecoder` (partial and merged chunks)
- [ ] Round-trip tests
- [ ] `docs/PROTOCOL.md`

## Server core

- [ ] Config loader (`config.yaml`)
- [ ] Self-signed certificate generation
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
