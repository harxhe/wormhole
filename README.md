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

The relay server is functional: clients can authenticate, receive a public
subdomain, and relay HTTP requests. See [`progress.md`](./progress.md) for the
current state and handoff notes.

## Quick start

```sh
npm install     # install workspaces
npm test        # run the test suite
npm run server  # start the relay server
```

With the server running, start a local app on port 3000 and connect the
throwaway mock client (the real CLI arrives with the client work):

```sh
npm run mock-client --workspace @wormhole/server -- --port 3000 --subdomain demo
curl -H "Host: demo.localhost" http://localhost:8080/
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

## Documentation

| Document | Contents |
|---|---|
| [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) | Wire format and frame semantics |
| [`docs/API.md`](./docs/API.md) | Internal module APIs |
| [`progress.md`](./progress.md) | Task progress and handoff notes |
