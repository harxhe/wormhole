# Benchmarks

Wormhole benchmarks measure end-to-end HTTP latency and throughput against a
local app, both directly and through the relay.

## Run

```sh
npm run bench          # full suite, 4s per measurement
npm run bench:smoke    # quick 1s / 1-connection smoke run
```

Options (pass them directly to `tsx` on PowerShell, where `npm run --` can
swallow flags):

```sh
npx tsx bench/src/run.ts --duration 5
npx tsx bench/src/run.ts --connections 1,10,50,100
npx tsx bench/src/run.ts --out bench/results
npx tsx bench/src/run.ts --no-warmup
```

Results are written to `bench/results/`:

- `latest.json` — raw measurements
- `latest.md` — markdown tables
- `latency-p50.svg`, `throughput.svg` — charts

## Scenarios

| Scenario | Request | Response | Connections |
|---|---|---|---|
| `small` | `GET /` | 2 B | 1, 10, 50, 100 |
| `download-1mb` | `GET /` | 1 MiB | 1, 10 |
| `upload-300kb` | `POST /` with 300 KiB | 2 B | 1, 10 |

Each run starts the relay and the real `TunnelClient` in-process on loopback,
then measures both `direct` (local app) and `tunnel` (public listener) with the
same one-request-per-connection load. The tunnel forces `Connection: close`, so
the direct baseline does the same. This keeps the comparison fair; generic
keep-alive load tools report misleading latency for the tunnel.

## Latest results

See [`results/latest.md`](./results/latest.md). On the development machine
(Windows, Node 22, loopback):

- Small response, 1 connection: p50 `0.81 ms` direct vs `3.16 ms` tunnel
- Small response, 100 connections: `1441 req/s` direct vs `609 req/s` tunnel
- 1 MiB download, 1 connection: `235 req/s` direct vs `59 req/s` tunnel
- 300 KiB upload, 1 connection: `428 req/s` direct vs `152 req/s` tunnel

The tunnel adds roughly 2–12 ms of p50 latency at low concurrency; the gap grows
at high concurrency because the current protocol is connection-wide
backpressure-friendly but not per-stream fair.

## Network impairment

On Linux, `bench/netem.sh` adds delay and loss to the loopback interface. Run
the benchmark once before, once with netem, and compare:

```sh
sudo ./bench/netem.sh add 50 1     # 50 ms delay, 1% loss
npm run bench
sudo ./bench/netem.sh del
```

## Packet captures

See [`docs/CAPTURE.md`](../docs/CAPTURE.md) and the helper scripts:

- `node bench/capture-docker.mjs` — reproducible Linux capture via Docker
- `bench/capture.ps1` (Windows, requires Wireshark/dumpcap)
- `bench/capture.sh` (Linux/macOS, requires tcpdump/tshark)

A sample capture with its TLS key log is committed in
[`results/`](./results/README.md).

## Notes

- All tests run on loopback, so absolute numbers are optimistic. Compare the
  `direct` and `tunnel` rows rather than treating the values as VPS capacity.
- The client runs with the inspector disabled for benchmarks.
- `tc netem` and packet capture need elevated privileges and are not part of
  `npm test`.
