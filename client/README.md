# @wormhole/client

The Wormhole tunnel client and `wormhole` CLI. Opens one TLS connection to the
relay, authenticates, and proxies every public request to a local port.

See [`docs/CLIENT.md`](../docs/CLIENT.md) for the design and
[`docs/API.md`](../docs/API.md#wormholeclient) for the module API.

## Run

```sh
npx wormhole http 3000 --token dev-token-please-change            # from the repo root
npx wormhole http 3000 --token dev-token-please-change --subdomain demo
npx wormhole http 3000 --server relay.example.com:4443 --secure   # real certificate
```

`npm run client -- http 3000 --token …` is equivalent. Run
`npx wormhole http --help` for every option.

## What it does

| Step | Behaviour |
|---|---|
| Connect | TLS to `--server` (default `localhost:4443`) |
| Authenticate | `AUTH { token, type: "http", subdomain? }` → `ASSIGN { subdomain, url }` |
| Requests | Each `OPEN` dials `localhost:<port>`; bytes flow both ways as `DATA` |
| Local app down | `ERROR LOCAL_DOWN` on the stream, then a `502 Bad Gateway` page |
| Heartbeat | Replies `PONG`; 30 s of silence means the connection is dead |
| Connection lost | Reconnects after 1 s, 2 s, 4 s … 30 s with the same subdomain |
| Inspector | Live request log and replay at <http://localhost:4040> |

## Layout

| File | Responsibility |
|---|---|
| `bin/wormhole.js` | Executable; runs `src/cli.ts` through `tsx` |
| `src/cli.ts` | Command-line interface (commander) |
| `src/client.ts` | `TunnelClient`: connection, auth, reconnect |
| `src/local.ts` | `proxyStream`: one stream ↔ one local socket |
| `src/backoff.ts` | Exponential backoff |
| `src/index.ts` | Library exports |
| `test/` | End-to-end tests against the real relay server |
