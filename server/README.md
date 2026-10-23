# @wormhole/server

The Wormhole relay server. Accepts outbound TLS control connections from tunnel
clients and forwards public HTTP requests or raw TCP connections to them over a
multiplexed protocol.

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
A tunnel that exceeds its limits returns `429`.

For a raw TCP tunnel, the real client prints a public port:

```sh
npm run client -- tcp 5432 --token dev-token-please-change --subdomain db
```

## Configuration (`config.yaml`)

| Key | Default | Description |
|---|---|---|
| `controlPort` | `4443` | TLS port clients connect to |
| `httpPort` | `8080` | Public HTTP listener port |
| `publicHost` | `localhost` | Host used to build assigned public URLs |
| `publicScheme` | `http` | Scheme advertised to clients (`http`/`https`) |
| `publicPort` | `httpPort` | Port advertised in public URLs |
| `tokens` | — | Static tokens accepted from clients |
| `limits.maxStreamsPerTunnel` | `50` | Concurrent HTTP requests/TCP connections per tunnel (`0` = off) |
| `limits.maxTunnelsPerToken` | `5` | Active tunnels per token (`0` = off) |
| `limits.requestsPerMinute` | `600` | New streams per tunnel per minute (`0` = off) |
| `tcp.enabled` | `true` | Enable raw TCP tunnels |
| `tcp.bindHost` | `0.0.0.0` | Interface for per-tunnel TCP listeners |
| `tcp.portStart` / `tcp.portEnd` | `15000` / `15999` | Inclusive public TCP port range |
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
| `src/limits.ts` | Sliding-window request limiter and limit errors |
| `src/ports.ts` | Public TCP port allocator |
| `src/registry.ts` | Subdomain-to-tunnel registry and per-tunnel caps |
| `src/hosts.ts` | Public host/URL and `Host` routing helpers |
| `src/control.ts` | TLS control listener (`AUTH` / `ASSIGN`) |
| `src/public.ts` | Public HTTP listener with `Host` routing |
| `src/public-tcp.ts` | Per-tunnel public TCP listener and raw bridge |
| `src/mock-client.ts` | Throwaway tunnel client for local verification |
| `src/scripts/mock-client.ts` | Mock client CLI |
| `src/index.ts` | Bootstrap, connection tracking and graceful shutdown |

The stream multiplexer, HTTP/1.1 helpers, and logger live in the shared
[`@wormhole/transport`](../transport/README.md) package, which both the server
and the client depend on.

Deployment instructions live in [`deploy/README.md`](../deploy/README.md).
