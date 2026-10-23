# Wormhole

Wormhole is a self-hosted reverse tunnel (an ngrok alternative). A client opens
one outbound TLS connection to a public relay server, which assigns a public
endpoint and forwards incoming traffic through the tunnel. A custom binary
protocol multiplexes many concurrent streams over that single connection.

It supports **HTTP** tunnels (`http://demo.tunnel.example.com`) and **raw TCP**
tunnels (`tcp://relay.example.com:15001`).

## Repository layout

```
wormhole/
├── protocol/    # frame encoder/decoder, constants, types
├── transport/   # shared socket runtime: mux, HTTP helpers, logger
├── server/      # relay server + public HTTP/TCP listeners
├── client/      # CLI client
├── inspector/   # HTTP request dashboard
├── bench/       # benchmark harness, results and charts
├── deploy/      # Docker/Caddy production configuration
├── docs/        # protocol, API, client, capture, report, demo
└── package.json
```

## Status

The relay and client are functional end to end:

- HTTP and raw TCP tunnels
- one outbound TLS connection multiplexed into many streams
- per-tunnel stream caps, per-token tunnel caps and request-rate limits
- automatic reconnect with the same HTTP subdomain
- live inspector with request replay
- Docker image and a Caddy-based wildcard-TLS deployment guide
- benchmark harness with latency/throughput results and charts
- 134 automated tests

See [`progress.md`](./progress.md) for the current checklist and handoff notes.

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
| Public HTTP listener | `localhost:8080` |
| Public host | `localhost` |
| Raw TCP port range | `15000-15099` |
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

### Raw TCP

Expose a database, SSH server or any other TCP service:

```sh
npx wormhole tcp 5432 --token dev-token-please-change --subdomain db
```

The client prints the assigned public port, for example:

```
Status      online
Forwarding  tcp://localhost:15000 -> tcp://localhost:5432
```

Connect to `localhost:15000` with any TCP client.

### CLI options

| Option | Default | Description |
|---|---|---|
| `-t, --token <token>` | `WORMHOLE_TOKEN` | Auth token (required) |
| `-s, --server <host:port>` | `localhost:4443` | Relay control server (`WORMHOLE_SERVER`) |
| `-n, --subdomain <name>` | random | Request a specific subdomain |
| `--local-host <host>` | `localhost` | Host of the local app |
| `--inspect-port <port>` | `4040` | Inspector port (HTTP only) |
| `--no-inspect` | | Do not start the inspector (HTTP only) |
| `--secure` / `--ca <file>` | off | Verify the relay's TLS certificate |
| `--no-reconnect` | | Exit instead of reconnecting |

`npm run client -- http 3000 --token …` works too. If the relay goes away the
client retries with backoff (1 s, 2 s, 4 s … 30 s) and gets the same HTTP
subdomain back. See [`client/README.md`](./client/README.md) and
[`docs/CLIENT.md`](./docs/CLIENT.md).

## Limits

`server/config.yaml` enforces per-tunnel safeguards:

| Key | Default | Meaning |
|---|---|---|
| `limits.maxStreamsPerTunnel` | 50 | Concurrent HTTP requests/TCP connections |
| `limits.maxTunnelsPerToken` | 5 | Active tunnels per token |
| `limits.requestsPerMinute` | 600 | New streams per tunnel per minute |
| `tcp.portStart` / `tcp.portEnd` | 15000 / 15999 | Public TCP port range |

Set a limit to `0` to disable it. HTTP clients receive `429 Too Many Requests`
with `Retry-After` when a cap is reached.

## Deployment

The relay runs as one Node process. For production, use Docker and a reverse
proxy for wildcard HTTPS:

```sh
docker compose up -d --build
```

See [`deploy/README.md`](./deploy/README.md) for DNS, Let's Encrypt, the Caddy
wildcard configuration, firewall ports, certificates and operations.

## Benchmarks

```sh
npm run bench          # full suite, writes bench/results/
npm run bench:smoke    # quick single-connection run
```

See [`bench/README.md`](./bench/README.md) and
[`bench/results/latest.md`](./bench/results/latest.md).

## Documentation

| Document | Contents |
|---|---|
| [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) | Wire format and frame semantics |
| [`docs/API.md`](./docs/API.md) | Internal module APIs |
| [`docs/CLIENT.md`](./docs/CLIENT.md) | Client and inspector design, known issues |
| [`docs/CAPTURE.md`](./docs/CAPTURE.md) | Wireshark capture and TLS decryption |
| [`docs/REPORT.md`](./docs/REPORT.md) | Project report and evaluation |
| [`docs/DEMO.md`](./docs/DEMO.md) | Demo script |
| [`docs/SLIDES.md`](./docs/SLIDES.md) | Presentation outline |
| [`deploy/README.md`](./deploy/README.md) | Production deployment |
| [`docs/implementation.md`](./docs/implementation.md) | Phase plan |
| [`progress.md`](./progress.md) | Task progress and handoff notes |
