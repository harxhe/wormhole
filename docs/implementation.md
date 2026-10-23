# Wormhole: Implementation Plan

Wormhole is a self-hosted reverse tunnel (an ngrok alternative) built with Node.js and TypeScript. A client opens one outbound TLS connection to a public relay server, which assigns a subdomain and forwards incoming requests through the tunnel. A custom binary protocol multiplexes many concurrent requests over that single connection.

**Flow:** Phase 0 (setup + server) → Phase 1 (client + inspector) → Phase 2 (finish + ship)

**Owners:** P1 owns Phase 0 and Phase 2. P2 owns Phase 1.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript, npm workspaces |
| Tunnel / public listener | `net`, `tls` (raw sockets, custom framing) |
| CLI | `commander` |
| Inspector | `ws` + plain HTML/JS |
| Testing | `vitest` |
| Benchmarks | `autocannon`, `tc netem`, Wireshark, matplotlib |
| Deployment | VPS, wildcard DNS, Let's Encrypt, Docker |

## Repo Structure

```
wormhole/
├── protocol/    # frame encoder/decoder, constants, types
├── transport/   # shared socket runtime: mux, HTTP helpers, logger
├── server/      # relay server
├── client/      # CLI client
├── inspector/   # dashboard (HTML/JS)
├── bench/       # benchmark scripts and graphs
├── docs/        # PROTOCOL.md, report, diagrams
└── package.json
```

## Protocol Summary

Frame header (big-endian): `Type (1B) | StreamID (4B) | Length (4B) | Payload`

| Type | Direction | Payload |
|---|---|---|
| `AUTH` | client → server | JSON: token, tunnel type (`http` / `tcp`) |
| `ASSIGN` | server → client | JSON: public URL or port |
| `OPEN` | server → client | Empty (new stream) |
| `DATA` | both | Raw bytes, max 16 KB |
| `CLOSE` | both | Empty |
| `PING` / `PONG` | both | Empty (heartbeat every 10s, dead after 30s) |
| `ERROR` | both | JSON: code, message |

Rules: control frames use StreamID `0`, server-created streams use odd IDs, and `socket.write()` returning `false` pauses the public sockets until `drain` (simple flow control).

---

## Phase 0: Foundation and Server Core (P1)

| Task | Output |
|---|---|
| Monorepo setup (npm workspaces, TypeScript, vitest) and folders | Repo skeleton |
| Protocol: frame format, `encodeFrame`, `FrameDecoder`, round-trip tests (partial and merged chunks) | `/protocol` module + `PROTOCOL.md` |
| TLS control listener, `AUTH` with static tokens, `ASSIGN` random subdomain | Clients can connect and authenticate |
| Tunnel registry, public listener, `Host` header routing, 404/502 pages | Requests reach the right tunnel |
| Multiplexer: stream IDs, `OPEN`, `DATA` both ways, `CLOSE`, backpressure | Server relays real traffic |
| Self-signed cert and `config.yaml` with a test token | Runs locally with one command |

### Handoff checklist (before starting Phase 1)

- [x] Server starts with `npm run server`, and the README says how
- [x] `PROTOCOL.md` is complete and protocol tests pass
- [x] A sample `curl` command proves routing works
- [x] README lists the test token, ports, and config
- [x] Everything is committed to `main`, with empty `client/` and `inspector/` folders ready

---

## Phase 1: Client and Inspector (P2)

| Task | Notes |
|---|---|
| CLI: `wormhole http 3000`, `--token`, `--server` | `commander` |
| TLS connect, send `AUTH`, parse `ASSIGN`, print the public URL | Uses the running server from Phase 0 |
| Handle `OPEN`: dial `localhost:PORT`, queue `DATA` until connected | One entry per stream |
| Stream table: local data to `DATA` frames (16 KB chunks), `CLOSE`, 502 if local app is down | Test with 50 concurrent requests |
| Heartbeat: reply `PONG`, detect 30s silence | |
| Auto-reconnect with exponential backoff, same subdomain on retry | Test by restarting the server |
| Inspector on `:4040`: method, path, status, timing, live updates over `ws`, replay button | Plain HTML/JS |

### Handoff back (before starting Phase 2)

- [x] Branch merged to `main`, with a README section on running the client
- [x] List of known bugs or unfinished items
- [x] Short note on client design in `docs/` (reusable in the report)

---

## Phase 2: Finish, Ship, Evaluate (P1)

| Task | Notes |
|---|---|
| Server-side heartbeat and dead-session cleanup | Close all streams, free subdomain and port |
| Raw TCP tunnels and rate limits | Public port per tunnel, max streams per tunnel |
| Deploy to VPS | Docker, wildcard cert, logging, graceful shutdown |
| Integration test with the real client and fix bugs | Coordinate with P2 for client fixes |
| Benchmarks | Latency overhead, throughput, 1/10/50/100 streams, `tc netem` loss and delay, comparison with ngrok |
| Wireshark captures and graphs | Handshake, multiplexed frames, heartbeat, reconnect |
| Demo recording and README | |
| Merge report sections and slides | Include P2's client and inspector part |
| Final run-through | |

### Completion status

- [x] Server-side heartbeat and dead-session cleanup
- [x] Raw TCP tunnels and rate limits
- [~] Deploy to VPS — Docker image, compose, production config and Caddy wildcard
  TLS guide are ready; an actual VPS/DNS run is environment-dependent
- [x] Integration test with the real client
- [x] Benchmarks (loopback; `tc netem` helper included)
- [x] Wireshark captures — scripts, TLS key-log support, guide and a sample
  `bench/results/wormhole.pcap` are included
- [x] Demo script and README (video recording is environment-dependent)
- [x] Report sections and slides (`docs/REPORT.md`, `docs/SLIDES.md`)
- [x] Final run-through

---

## Rules and Risks

- **Keep `/protocol` frozen** once Phase 1 starts. If a change is needed, agree on it first and update `PROTOCOL.md`.
- **Phase 0 is the crunch.** If the server core runs late, hand off a minimal version (auth, routing, relay) and finish cleanup and TCP tunnels in Phase 2.
- **Serial dependency risk:** if Phase 1 slips, there is no buffer. Cut order: replay button, reconnect polish, raw TCP tunnels, rate limiting.
- **DNS or cert trouble:** demo over plain HTTP with a hosts file.
- **No VPS:** run the relay on a lab machine or laptop and use a second device for the demo.
- **Node pitfalls:** attach `error` handlers on every socket, respect backpressure, and buffer partial frames in `FrameDecoder`.