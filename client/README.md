# @wormhole/client

The Wormhole tunnel client and `wormhole` CLI. Opens one TLS connection to the
relay, authenticates, and proxies every public request (HTTP) or connection
(TCP) to a local port.

See [`docs/CLIENT.md`](../docs/CLIENT.md) for the design and
[`docs/API.md`](../docs/API.md#wormholeclient) for the module API.

## Run

```sh
npx wormhole http 3000 --token dev-token-please-change            # from the repo root
npx wormhole http 3000 --token dev-token-please-change --subdomain demo
npx wormhole http 3000 --server relay.example.com:4443 --secure   # real certificate

npx wormhole tcp 5432 --token dev-token-please-change             # raw TCP tunnel
npx wormhole tcp 5432 --token dev-token-please-change --subdomain db
```

`npm run client -- http 3000 --token …` is equivalent. Run
`npx wormhole http --help` or `npx wormhole tcp --help` for every option.

## What it does

| Step | Behaviour |
|---|---|
| Connect | TLS to `--server` (default `localhost:4443`) |
| Authenticate | `AUTH { token, type: "http"|"tcp", subdomain? }` |
| HTTP assign | `ASSIGN { subdomain, url }`; prints `http://…` |
| TCP assign | `ASSIGN { subdomain, port, url }`; prints `tcp://…` |
| HTTP requests | Each `OPEN` dials `localhost:<port>`; bytes flow both ways as `DATA` |
| TCP connections | Each `OPEN` dials `localhost:<port>`; raw bytes flow both ways |
| Local app down | HTTP: `ERROR LOCAL_DOWN` + `502` page. TCP: `ERROR LOCAL_DOWN` + close |
| Heartbeat | Replies `PONG`; 30 s of silence means the connection is dead |
| Connection lost | Reconnects after 1 s, 2 s, 4 s … 30 s with the same subdomain |
| Inspector | Live HTTP request log and replay at <http://localhost:4040> |

## Layout

| File | Responsibility |
|---|---|
| `bin/wormhole.js` | Executable; runs `src/cli.ts` through `tsx` |
| `src/cli.ts` | Command-line interface (commander), `http` and `tcp` commands |
| `src/client.ts` | `TunnelClient`: connection, auth, reconnect |
| `src/local.ts` | `proxyStream` / `proxyRawStream`: one stream ↔ one local socket |
| `src/backoff.ts` | Exponential backoff |
| `src/index.ts` | Library exports |
| `test/` | End-to-end tests against the real relay server |

Framing and the stream multiplexer come from the shared
[`@wormhole/transport`](../transport/README.md) package; the client does not
depend on the server package.

For production, pass `--secure` once the relay has a trusted certificate. See
[`deploy/README.md`](../deploy/README.md).
