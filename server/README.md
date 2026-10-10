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

## Try it locally

With the server running, start any local app on port 3000, then connect the
throwaway mock client (see `src/mock-client.ts`):

```sh
npm run mock-client --workspace @wormhole/server -- --port 3000 --subdomain demo
```

It prints the assigned public URL. Requests to the public listener are routed by
the `Host` header:

```sh
curl -H "Host: demo.localhost" http://localhost:8080/hello
```

Unknown subdomains return `404`; a tunnel whose local app is down returns `502`.

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
| `src/registry.ts` | Subdomain-to-tunnel registry |
| `src/hosts.ts` | Public host/URL and `Host` routing helpers |
| `src/control.ts` | TLS control listener (`AUTH` / `ASSIGN`) |
| `src/public.ts` | Public TCP listener with `Host` routing |
| `src/mock-client.ts` | Throwaway tunnel client for local verification |
| `src/scripts/mock-client.ts` | Mock client CLI |
| `src/index.ts` | Bootstrap and signal handling |

The stream multiplexer, HTTP/1.1 helpers, and logger live in the shared
[`@wormhole/transport`](../transport/README.md) package, which both the server
and the client depend on.
