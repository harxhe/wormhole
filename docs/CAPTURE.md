# Packet captures

Wireshark is the easiest way to show the Wormhole handshake, multiplexed frames,
heartbeats and reconnect behaviour. The control connection is TLS, so decrypt it
with a TLS key log.

## 1. Enable the key log

Both the server and the client write the TLS secrets when
`WORMHOLE_TLS_KEYLOG` is set. Use a throwaway file and never commit it.

```sh
export WORMHOLE_TLS_KEYLOG="$PWD/bench/results/tls-keys.log"
npm run server
# in another terminal, with the same variable set:
npm run client -- http 3000 --token dev-token-please-change --subdomain demo
```

On PowerShell:

```powershell
$env:WORMHOLE_TLS_KEYLOG = "$PWD\bench\results\tls-keys.log"
npm run server
```

## 2. Capture traffic

The simplest reproducible option is Docker: build the image, then run the
capture script. It starts the relay, HTTP and TCP clients inside a container,
generates traffic, and writes `wormhole.pcap` plus a key log to
`bench/results/`.

```sh
docker build -t wormhole-relay:test .
node bench/capture-docker.mjs
```

Windows (Administrator PowerShell, Wireshark/Npcap installed):

```powershell
./bench/capture.ps1 -Interface "Adapter for loopback traffic capture" -Seconds 20
```

Linux/macOS (root):

```sh
sudo ./bench/capture.sh 20 lo bench/results/wormhole.pcap
```

The default filter is:

```
tcp port 4443 or tcp port 8080 or (tcp portrange 15000-15099)
```

## 3. Decrypt in Wireshark

1. Open `bench/results/wormhole.pcap`.
2. **Edit → Preferences → Protocols → TLS**.
3. Set **Pre-Master-Secret log filename** to `bench/results/tls-keys.log`.
4. Apply the display filter `tls` or `tcp.port == 4443`.

## Useful display filters

| What | Filter |
|---|---|
| Control connection | `tcp.port == 4443` |
| Public HTTP listener | `tcp.port == 8080` |
| Raw TCP tunnel | `tcp.port >= 15000 && tcp.port <= 15099` |
| TLS handshake | `tls.handshake` |
| Application data after decryption | `tls.app_data` |
| A single stream | `tcp.stream eq 0` |
| Retransmits | `tcp.analysis.retransmission` |

## What to look for

- **Handshake**: TLS ClientHello/ServerHello on `:4443`, then a small
  client→server frame (`AUTH`) and a server→client frame (`ASSIGN`).
- **Multiplexing**: several interleaved `OPEN`/`DATA`/`CLOSE` sequences on the
  same TCP connection after concurrent requests. Each 16 KiB `DATA` frame has a
  9-byte header: type, stream id, length.
- **Heartbeat**: `PING`/`PONG` roughly every 10 seconds with stream id `0`.
- **Reconnect**: after stopping the relay, the client opens a new TLS
  connection and sends `AUTH` with the previous subdomain.
- **Raw TCP tunnel**: a second connection on a port in the `15000–15099` range,
  bridged byte-for-byte through the control connection.

Keep captures small (10–20 seconds) and avoid capturing unrelated traffic from a
shared machine.
