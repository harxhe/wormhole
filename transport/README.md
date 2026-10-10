# @wormhole/transport

Shared socket runtime used by both the relay server and the tunnel client:

- `Mux` / `Stream` — the stream multiplexer (framing, `OPEN`/`DATA`/`CLOSE`,
  heartbeat, backpressure) from [`PROTOCOL.md`](../docs/PROTOCOL.md)
- HTTP/1.1 helpers — `parseRequestHead`, `serializeRequestHead`,
  `renderResponse` for the raw public listener and the client's 502 page
- `createLogger` — a small scoped logger

It depends only on `@wormhole/protocol`. Keeping this here (instead of in
`server/`) means the client never depends on the server package.

See [`docs/API.md`](../docs/API.md) for the module API.

## Develop

```sh
npm install     # from the repo root
npm test        # from the repo root
```
