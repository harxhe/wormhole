# @wormhole/server

The Wormhole relay server. Accepts outbound TLS control connections from tunnel
clients and forwards public HTTP traffic to them over a multiplexed protocol.

See [`docs/API.md`](../docs/API.md) for the module API and
[`config.yaml`](./config.yaml) for all settings.

## Run

```sh
npm run server     # from the repo root
npm run gen-cert   # regenerate the self-signed control-listener certificate
```

On first start the server generates a self-signed certificate into `certs/`
(git-ignored) for the TLS control listener.

## Configuration (`config.yaml`)

| Key | Default | Description |
|---|---|---|
| `controlPort` | `4443` | TLS port clients connect to |
| `httpPort` | `8080` | Public HTTP listener port |
| `publicHost` | `localhost` | Host used to build assigned public URLs |
| `tokens` | — | Static tokens accepted from clients |
| `cert.dir` | `certs` | Certificate directory (relative to `server/`) |
| `cert.commonName` | `localhost` | Certificate common name |
| `cert.altNames` | `[publicHost]` | Subject alternative names |
| `cert.days` | `365` | Certificate validity |
| `heartbeat.intervalMs` | `10000` | Heartbeat cadence |
| `heartbeat.timeoutMs` | `30000` | Dead-connection timeout |

## Layout

| File | Responsibility |
|---|---|
| `src/config.ts` | Load and validate `config.yaml` |
| `src/paths.ts` | Resolve default paths |
| `src/certs.ts` | Self-signed certificate generation |
| `src/scripts/gen-cert.ts` | Certificate CLI |

_Control listener, registry, multiplexer, and public listener: under construction._
