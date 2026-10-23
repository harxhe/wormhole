# Wormhole Protocol

Version 1. A custom binary framing protocol that multiplexes many logical
streams over a single TLS connection between a tunnel client and the relay
server.

## Transport

- The client dials the relay server over **TLS** (the control connection).
- All frames for all streams share this one connection.
- Frames may be split across TCP segments or coalesced; the decoder must handle
  both.

## Frame format

Every frame starts with a fixed **9-byte header**, followed by a payload of
`Length` bytes:

```
 0        1                              5                              9
 +--------+------------------------------+------------------------------+---------+
 | Type   |          StreamID            |           Length             | Payload |
 | 1 byte |          4 bytes             |          4 bytes             | N bytes |
 +--------+------------------------------+------------------------------+---------+
```

All multi-byte integers are **big-endian** (network byte order).

| Field | Size | Description |
|---|---|---|
| `Type` | 1 | Frame type (see below) |
| `StreamID` | 4 | Logical stream this frame belongs to |
| `Length` | 4 | Payload length in bytes (`0` for control frames without a body) |
| `Payload` | `Length` | Raw bytes; JSON for control frames that carry metadata |

The maximum payload is **16 KB (16384 bytes)**. A `DATA` frame never exceeds
this; senders split larger byte streams into multiple frames.

## Frame types

| Value | Name | Direction | StreamID | Payload |
|---|---|---|---|---|
| `1` | `AUTH` | client → server | `0` | JSON `{ token, type, subdomain?, port? }` |
| `2` | `ASSIGN` | server → client | `0` | JSON `{ subdomain, url?, port? }` |
| `3` | `OPEN` | server → client | stream | empty |
| `4` | `DATA` | both | stream | raw bytes |
| `5` | `CLOSE` | both | stream | empty |
| `6` | `PING` | both | `0` | empty |
| `7` | `PONG` | both | `0` | empty |
| `8` | `ERROR` | both | `0` or stream | JSON `{ code, message }` |

### `AUTH`

The first frame the client sends after connecting. `type` is `"http"` or `"tcp"`.
`token` is validated by the server against its configured tokens; an unknown
token yields an `ERROR` frame followed by connection close. `subdomain` is an
optional requested name; when omitted the server assigns a random one. `port` is
the client's local port and is informational only.

For `"tcp"` tunnels the server creates a public TCP listener on a free port from
its configured range and returns that port in `ASSIGN`.

### `ASSIGN`

The server's reply to a valid `AUTH`. For HTTP tunnels the payload is
`{ subdomain, url }`; for TCP tunnels it is `{ subdomain, port, url }`, where
`url` looks like `tcp://relay.example.com:15001`.

### `OPEN`

Sent by the server to announce a new stream before any `DATA` for it. Because
the server originates public traffic, it also allocates stream IDs.

### `DATA`

Carries raw bytes for one stream. The protocol is transport-agnostic: HTTP
tunnels put a serialized HTTP/1.1 request or response on the stream, while TCP
tunnels put arbitrary bytes on it.

### `CLOSE`

Half/full close of a stream. Each side must accept `CLOSE` for either a stream
it opened or received. After sending or receiving `CLOSE`, no further `DATA` is
valid for that stream.

### `PING` / `PONG`

Heartbeat. Either side sends `PING` roughly every **10 seconds**; the peer
replies `PONG`. A connection with **no traffic for 30 seconds** is considered
dead and is closed, along with all its streams.

### `ERROR`

Reports a connection- or stream-level failure. `code` is a short machine
identifier (e.g. `BAD_TOKEN`, `NO_TUNNEL`, `LOCAL_DOWN`, `TOO_MANY_TUNNELS`),
and `message` is human readable.

The relay may reject an `AUTH` with `TOO_MANY_TUNNELS` when one token already
owns its configured number of tunnels. Per-tunnel stream and request-rate caps
are enforced by the public listener and surface to HTTP clients as `429 Too Many
Requests`; the tunnel connection stays open.

## Stream IDs

| Range | Owner |
|---|---|
| `0` | Connection-level control frames (`AUTH`, `ASSIGN`, `PING`, `PONG`) |
| odd (`1, 3, 5, …`) | Server-created streams |
| even (`2, 4, 6, …`) | Reserved for client-created streams (future) |

Stream IDs are unique for the lifetime of a connection and are not reused.

## Backpressure

Senders respect socket backpressure: when `socket.write()` returns `false`, the
writer pauses the source feeding that socket, and resumes when the socket emits
`drain`. Combined with the 16 KB payload limit, this bounds memory use.

## Error handling

- Receivers must attach `error` handlers to every socket.
- An unrecognized frame type or an oversized declared length is a fatal
  protocol error; close the connection.
- Buffering partial frames is required; see `FrameDecoder` in
  [`../protocol/src/decoder.ts`](../protocol/src/decoder.ts).

## Session flow

```
Client                                   Server
  |                                        |
  |--- TLS connect ----------------------->|
  |--- AUTH {token,type:http} ------------->|
  |<-- ASSIGN {subdomain,url} --------------|
  |                                        |
  |        ... public request arrives ...  |
  |<-- OPEN  (stream 1) --------------------|
  |<-- DATA  (stream 1) --------------------|
  |--- DATA  (stream 1) ------------------->|
  |<-- CLOSE (stream 1) --------------------|
  |                                        |
  |<-- PING ------ every 10s -------------->|
  |--- PONG ------------------------------>|
```
