# Client and Inspector Design

Phase 1 of [`implementation.md`](./implementation.md): the tunnel client
(`/client`) and the request inspector (`/inspector`). Wire format is unchanged
and follows [`PROTOCOL.md`](./PROTOCOL.md).

## Overview

```
public request ──► relay server ══ one TLS connection ══► client ──► localhost:PORT
                                   (many streams)            │
                                                             └──► inspector :4040 (ws)
```

The client dials **out** to the relay, so the local machine needs no open
inbound port. Every public request becomes one stream on that connection.

## Modules

| File | Responsibility |
|---|---|
| `client/src/cli.ts` | `wormhole http <port>` (commander), banner, request log |
| `client/src/client.ts` | `TunnelClient`: TLS connect, `AUTH`/`ASSIGN`, stream dispatch, reconnect |
| `client/src/local.ts` | `proxyStream`: bridges one stream to one local TCP socket |
| `client/src/backoff.ts` | Exponential backoff with jitter |
| `inspector/src/store.ts` | `RequestStore`: records each stream, replay |
| `inspector/src/parse.ts` | HTTP/1.1 head and chunked-body parsing from raw bytes |
| `inspector/src/server.ts` | Dashboard: static files, JSON API, WebSocket at `/ws` |
| `inspector/public/` | Plain HTML/JS/CSS dashboard |

The client reuses the server's `Mux` (`server/src/mux.ts`) instead of copying
it, so framing, the 16 KB split, `PING`/`PONG` and backpressure behave
identically on both ends. `/protocol` is untouched.

## Session lifecycle

1. **Connect.** TLS to `--server` (default `localhost:4443`). Certificates are
   not verified by default because the dev relay is self-signed; `--secure` or
   `--ca <file>` turns verification on.
2. **Authenticate.** First frame is `AUTH { token, type: "http", subdomain? }`.
   If no `ASSIGN` arrives within 10 s the attempt is dropped and retried.
3. **Assigned.** `ASSIGN { subdomain, url }` is printed and the client goes
   `online`. The assigned subdomain is remembered for reconnects.
4. **Streams.** Each `OPEN` from the server creates one stream (see below).
5. **Lost.** Socket error, server close, or heartbeat timeout ends the
   session; every open stream is closed with it.

## Stream table

The `Mux` keeps the `streamId → Stream` map; `proxyStream` owns one local socket
per stream:

| Event | Action |
|---|---|
| `OPEN n` | `acceptStream(n)`, dial `localhost:PORT` |
| `DATA` before the local socket connects | Queued, flushed in order on connect |
| `DATA` after connect | Written to the local socket |
| Local socket data | `stream.write()` → `DATA` frames of at most 16 KB |
| Local socket ends | `CLOSE n` |
| `CLOSE n` from server | Local socket destroyed |
| Local connect fails (`ECONNREFUSED`, timeout) | `502 Bad Gateway` page as `DATA`, then `CLOSE` |

**502 detail.** `OPEN` can arrive a moment before the request's first `DATA`.
If the local connect fails first, the client waits up to 1 s for the request
bytes before sending the 502, so the inspector logs it against the right
method and path.

**Backpressure** follows the server's rules (`PROTOCOL.md`): if the local
socket is full, the shared control socket is paused; if the control socket is
full, the local socket is paused until `drain`.

## Heartbeat

Provided by `Mux`: the client replies `PONG` to every `PING`, sends its own
`PING` every 10 s, and treats 30 s without any incoming traffic as a dead
connection. That triggers a reconnect.

## Auto-reconnect

- Any non-fatal loss schedules a retry: **1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s…**
  (factor 2, capped at 30 s, ±20 % jitter). Backoff resets after a successful
  `ASSIGN`.
- Retries send the **previously assigned subdomain**, so the public URL stays
  the same.
- **Fatal, no retry:** `BAD_TOKEN`, `BAD_AUTH`, `UNSUPPORTED`, `BAD_SUBDOMAIN`,
  TLS certificate failures, and `SUBDOMAIN_TAKEN` on the *first* connection (the
  name belongs to someone else).
- `SUBDOMAIN_TAKEN` *after* we held the name is retried: it means the server has
  not yet noticed our old connection is dead and still reserves the name.
- `--no-reconnect` turns retries off.

## Inspector

Runs on `127.0.0.1:4040` (`--inspect-port`, `--no-inspect`).

- **Capture.** The client gives the inspector every byte of each stream. The
  inspector parses the request line, status line and headers itself, and
  records time to first byte and total time.
- **Live updates.** A WebSocket at `/ws` sends a snapshot on connect, then an
  `upsert` message whenever a request starts, gets its head, or finishes.
- **Replay.** `POST /api/requests/:id/replay` re-sends the captured raw request
  directly to the local app (not through the relay) and records the result as a
  new entry tagged `replay`.
- **Limits.** Last 200 requests, in memory. Requests over 1 MB are not
  replayable. Body previews show the first 16 KB; chunked bodies are decoded.
- **Safety.** Bound to localhost only; `POST`/`DELETE` and WebSocket connections
  from other origins are rejected, so another site open in the browser cannot
  trigger replays.

## Testing

`npm test` runs the client and inspector suites against the **real** Phase 0
server in-process:

| Requirement (implementation.md) | Test |
|---|---|
| CLI, URL printed | `client/test/cli.test.ts` |
| TLS + `AUTH` + `ASSIGN` | `client.test.ts` › connect and authenticate |
| 50 concurrent requests | `client.test.ts` › handles 50 concurrent requests |
| 16 KB chunking | 2 MB response / 300 KB upload test |
| 502 when local app is down | `client.test.ts` › answers 502 … |
| Heartbeat reply and 30 s silence | `client.test.ts` › heartbeat (shortened timers) |
| Reconnect, same subdomain, server restart | `client.test.ts` › auto-reconnect |
| Inspector API, WebSocket, replay | `inspector/test/inspector.test.ts` |

## Known issues and unfinished items

- **Cross-package import.** The client imports `Mux` and `renderResponse` from
  `server/src`. Moving `Mux` into `/protocol` would be cleaner but touches the
  frozen package, so it needs P1's agreement.
- **Reconnect can wait up to ~30 s for the same URL** after an abrupt network
  loss (Wi-Fi drop), because the server only frees the name when its own
  heartbeat times out. Clean server restarts reconnect in about a second.
  Server-side dead-session cleanup is a Phase 2 task.
- **TLS verification is off by default** (self-signed dev relay). Use `--secure`
  once the relay has a real certificate (Phase 2).
- **HTTP only.** `wormhole tcp` is not implemented; the server rejects `tcp`
  tunnels (Phase 2).
- **One request per stream.** The server forces `Connection: close`, so
  keep-alive and WebSocket upgrades to the local app are not supported.
- **Connection-wide backpressure** (inherited): one slow local socket pauses all
  streams.
- **Inspector UI** has API and WebSocket tests but no automated browser tests.
