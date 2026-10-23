# Benchmark and capture artifacts

| File | Description |
|---|---|
| `latest.json` | Raw benchmark measurements |
| `latest.md` | Markdown tables and overhead summary |
| `latency-p50.svg`, `throughput.svg` | Charts |
| `wormhole.pcap` | Sample packet capture of the HTTP + TCP tunnel |
| `wormhole-tls-keys.log` | TLS secrets for decrypting the sample capture |

## Opening the sample capture

The capture was generated inside a Linux container (`bench/capture-docker.mjs`)
with the dev token and a throwaway TLS key log. In Wireshark:

1. Open `wormhole.pcap`.
2. **Edit → Preferences → Protocols → TLS → Pre-Master-Secret log filename**
   and select `wormhole-tls-keys.log`.
3. Right-click a packet on port 4443 and choose **Decode As → TLS** if needed.
4. Filter with `tcp.port == 4443` to see the control connection.

The key log is only for this local demonstration capture. Never reuse it or
commit a key log from a real deployment.

## Regenerating

```sh
docker build -t wormhole-relay:test .
node bench/capture-docker.mjs
npm run bench
```
