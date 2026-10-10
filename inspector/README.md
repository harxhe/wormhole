# @wormhole/inspector

Local request inspector for the Wormhole client, served at
<http://localhost:4040> while `wormhole http` runs.

- Lists every request: method, path, status, time to first byte, total time,
  size.
- Updates live over a WebSocket (`/ws`).
- Shows request and response headers and bodies (first 16 KB, chunked bodies
  decoded, JSON pretty-printed).
- **Replay** re-sends a captured request to the local app.

Plain HTML/JS in `public/`; no build step. See
[`docs/API.md`](../docs/API.md#wormholeinspector) for the HTTP and WebSocket API.

## Layout

| File | Responsibility |
|---|---|
| `src/store.ts` | `RequestStore`: capture, records, replay |
| `src/parse.ts` | HTTP/1.1 head and chunked-body parsing |
| `src/server.ts` | HTTP server, JSON API, WebSocket |
| `public/index.html`, `app.js`, `style.css` | Dashboard |
| `test/` | Parsing, store, API, WebSocket and replay tests |
