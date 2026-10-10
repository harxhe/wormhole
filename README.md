# Wormhole

Wormhole is a self-hosted reverse tunnel (an ngrok alternative). A client opens
one outbound TLS connection to a public relay server, which assigns a subdomain
and forwards incoming requests through the tunnel. A custom binary protocol
multiplexes many concurrent requests over that single connection.

## Repository layout

```
wormhole/
├── protocol/    # frame encoder/decoder, constants, types
├── server/      # relay server
├── client/      # CLI client
├── inspector/   # dashboard (HTML/JS)
├── bench/       # benchmark scripts and graphs
├── docs/        # PROTOCOL.md, API.md, progress
└── package.json
```

## Status

The relay server and the client are functional: `wormhole http <port>` opens a
tunnel, prints a public URL, relays HTTP requests, reconnects automatically,
and shows every request in a live inspector on `localhost:4040`. See
[`progress.md`](./progress.md) for the current state and handoff notes.

## Quick start

```sh
npm install     # install workspaces
npm test        # run the test suite
npm run server  # start the relay server
```

### Defaults

| Setting | Value |
|---|---|
| Test token | `dev-token-please-change` |
| Control listener (TLS) | `localhost:4443` |
| Public listener (HTTP) | `localhost:8080` |
| Public host | `localhost` |
| Config file | `server/config.yaml` |

The server generates a self-signed certificate into `server/certs/` on first
run. See the [server README](./server/README.md) for all configuration options.

## Running the client

With the server running (`npm run server`), start any local app on port 3000,
then in another terminal:

```sh
npx wormhole http 3000 --token dev-token-please-change --subdomain demo
```

It prints the public URL and logs each request:

```
Status      online
Forwarding  http://demo.localhost:8080 -> http://localhost:3000
Inspector   http://127.0.0.1:4040
```

Send a request through the tunnel:

```sh
curl -H "Host: demo.localhost" http://localhost:8080/
```

Open <http://localhost:4040> to watch requests arrive live and replay them.

| Option | Default | Description |
|---|---|---|
| `-t, --token <token>` | `WORMHOLE_TOKEN` | Auth token (required) |
| `-s, --server <host:port>` | `localhost:4443` | Relay control server (`WORMHOLE_SERVER`) |
| `-n, --subdomain <name>` | random | Request a specific subdomain |
| `--local-host <host>` | `localhost` | Host of the local app |
| `--inspect-port <port>` | `4040` | Inspector port |
| `--no-inspect` | | Do not start the inspector |
| `--secure` / `--ca <file>` | off | Verify the relay's TLS certificate |
| `--no-reconnect` | | Exit instead of reconnecting |

`npm run client -- http 3000 --token …` works too. If the relay goes away the
client retries with backoff (1 s, 2 s, 4 s … 30 s) and gets the same subdomain
back. See [`client/README.md`](./client/README.md) and
[`docs/CLIENT.md`](./docs/CLIENT.md).

## Documentation

| Document | Contents |
|---|---|
| [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) | Wire format and frame semantics |
| [`docs/API.md`](./docs/API.md) | Internal module APIs |
| [`docs/CLIENT.md`](./docs/CLIENT.md) | Client and inspector design, known issues |
| [`docs/implementation.md`](./docs/implementation.md) | Phase plan |
| [`progress.md`](./progress.md) | Task progress and handoff notes |
