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

See [`progress.md`](./progress.md) for the current state of the work.

## Quick start

```sh
npm install     # install workspaces
npm test        # run the test suite
npm run server  # start the relay server
```

The server reads its configuration from `server/config.yaml`. See the
[server README](./server/README.md) for configuration details and a sample
`curl` command once the server is running.

## Documentation

| Document | Contents |
|---|---|
| [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) | Wire format and frame semantics |
| [`docs/API.md`](./docs/API.md) | Internal module APIs |
| [`progress.md`](./progress.md) | Task progress and handoff notes |
