# Client and Inspector Design

The tunnel client (`/client`) and the request inspector (`/inspector`). Wire
format is unchanged and follows [`PROTOCOL.md`](./PROTOCOL.md). The client
supports HTTP and raw TCP tunnels.

## Overview

```
public request ──► relay server ══ one TLS connection ══► client ──► localhost:PORT
                                   (many streams)            │
                                                             └──► inspector :4040 (ws, HTTP only)
```

The client dials **out** to the relay, so the local machine needs no open
inbound port. Every public request (HTTP) or connection (TCP) becomes one stream
on that connection.

## Modules

| File | Responsibility |
|---|---|
| `client/src/cli.ts` | `wormhole http|tcp <port>` (commander), banner, request log |
| `client/src/client.ts` | `TunnelClient`: TLS connect, `AUTH`/`ASSIGN`, stream dispatch, reconnect |
| `client/src/local.ts` | `proxyStream` (HTTP) and `proxyRawStream` (TCP) bridge one stream to one local socket |
| `client/src/backoff.ts` | Exponential backoff with jitter |
| `inspector/src/store.ts` | `RequestStore`: records each stream, replay |
| `inspector/src/parse.ts` | HTTP/1.1 head and chunked-body parsing from raw bytes |
| `inspector/src/server.ts` | Dashboard: static files, JSON API, WebSocket at `/ws` |
| `inspector/public/` | Plain HTML/JS/CSS dashboard |

The client and server share `Mux` and the HTTP helpers through
`@wormhole/transport`, so framing, the 16 KB split, `PING`/`PONG` and
backpressure behave identically on both ends. `/protocol` is untouched and the
client does not depend on the server package.

## Session lifecycle

1. **Connect.** TLS to `--server` (default `localhost:4443`). Certificates are
   not verified by default because the dev relay is self-signed; `--secure` or
   `--ca <file>` turns verification on.
2. **Authenticate.** First frame is
   `AUTH { token, type: "http"|"tcp", subdomain?, port }`. If no `ASSIGN`
   arrives within 10 s the attempt is dropped and retried.
3. **Assigned.** `ASSIGN { subdomain, url }` for HTTP, or
   `{ subdomain, port, url }` for TCP, is printed and the client goes `online`.
   The assigned subdomain is remembered for reconnects.
4. **Streams.** Each `OPEN` from the server creates one stream (see below).
5. **Lost.** Socket error, server close, or heartbeat timeout ends the
   session; every open stream is closed with it.

## Stream table

`TunnelClient` keeps a stream table (`streamId → { id, openedAt }`, exposed as
`client.streams`), one entry per open stream. The `Mux` routes frames by stream
id, and the local bridge owns one local socket per stream:

| Event | HTTP mode | TCP mode |
|---|---|---|
| `OPEN n` | Add stream entry, dial `localhost:PORT` | Add stream entry, dial `localhost:PORT` |
| `OPEN` before `ASSIGN` | Refused with `CLOSE` (server bug guard) | Refused with `CLOSE` |
| `DATA` before local connect | Queued, flushed in order | Queued, flushed in order |
| Local connect fails | `ERROR LOCAL_DOWN`, `502` page as `DATA`, `CLOSE` | `ERROR LOCAL_DOWN`, `CLOSE` |
| Local socket data | `DATA` frames of at most 16 KB | `DATA` frames of at most 16 KB |
| Either side closes | Close the other side | Close the other side |

**Local host.** The client dials `localhost` (as in the plan), not
`127.0.0.1`, so apps that bind only to IPv6 `::1` (Vite's default on many
machines) are reachable too. `--local-host` overrides it.

**502 detail.** For HTTP, `OPEN` can arrive a moment before the request's first
`DATA`. If the local connect fails first, the client waits up to 1 s for the
request bytes before sending the 502, so the inspector logs it against the right
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
- Retries send the **previously assigned subdomain**, so the HTTP public URL
  stays the same.
- **Fatal, no retry:** `BAD_TOKEN`, `BAD_AUTH`, `UNSUPPORTED`, `BAD_SUBDOMAIN`,
  TLS certificate failures, `TOO_MANY_TUNNELS`, and `SUBDOMAIN_TAKEN` on the
  *first* connection (the name belongs to someone else).
- `SUBDOMAIN_TAKEN` *after* we held the name is retried: it means the server has
  not yet noticed our old connection is dead and still reserves the name.
- A TCP tunnel gets a fresh public port after a reconnect because the server
  allocates a port when the session is created. The client prints the new
  endpoint.
- `--no-reconnect` turns retries off.

## Inspector

Runs on `127.0.0.1:4040` (`--inspect-port`, `--no-inspect`). It is HTTP-only;
`wormhole tcp` does not start it.

- **Capture.** The client gives the inspector every byte of each HTTP stream.
  The inspector parses the request line, status line and headers itself, and
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

`npm test` runs the client and inspector suites against the **real** relay
server in-process:

| Requirement | Test |
|---|---|
| CLI, URL printed | `client/test/cli.test.ts` |
| TCP CLI, public port printed, raw echo | `client/test/cli.test.ts`, `tcp.test.ts` |
| TLS + `AUTH` + `ASSIGN` | `client.test.ts` › connect and authenticate |
| 50 concurrent requests | `client.test.ts` › handles 50 concurrent requests |
| 16 KB chunking | 2 MB response / 300 KB upload test |
| 502 when local app is down | `client.test.ts`; `audit.test.ts` › `ERROR LOCAL_DOWN` frame order |
| Stream table, one entry per stream | `audit.test.ts` › stream table |
| `SUBDOMAIN_TAKEN` retry, handshake timeout, `--secure`/`--ca` | `audit.test.ts` |
| Heartbeat reply and 30 s silence | `client.test.ts` › heartbeat (shortened timers) |
| Reconnect, same subdomain, server restart | `client.test.ts` › auto-reconnect |
| Per-tunnel stream/rate limits (429) | `limits.test.ts` |
| Raw TCP relay, concurrency, local down, disabled | `tcp.test.ts` |
| Inspector API, WebSocket, replay | `inspector/test/inspector.test.ts` |

## Known issues and unfinished items

- **TLS verification is off by default** (self-signed dev relay). Use `--secure`
  once the relay has a real certificate. Production deployments should always
  run with a trusted certificate.
- **HTTP is one request per stream.** The public listener forces
  `Connection: close`, so keep-alive and WebSocket upgrades to the local app are
  not supported on a single stream.
- **Connection-wide backpressure** (inherited): one slow local socket pauses all
  streams.
- **TCP reconnect changes the public port**, as described above.
- **Inspector UI** has API and WebSocket tests but no automated browser tests.
