# Demo script

A 5–7 minute walkthrough. Everything runs locally; no DNS or VPS required.

## 0. Setup

Three terminals in the repo root:

```sh
npm install
npm test            # optional: 133 tests
npm run server      # terminal 1
```

Terminal 2: a local app.

```sh
python -m http.server 3000
# or: npx serve -l 3000 .
```

Terminal 3: the client.

```sh
npx wormhole http 3000 --token dev-token-please-change --subdomain demo
```

Show the banner: status, public URL, inspector URL.

## 1. HTTP request through the tunnel

```sh
curl -H "Host: demo.localhost" http://localhost:8080/
```

Point out the request line printed by the client. Open
<http://localhost:4040>, refresh the request, and click **Replay**. Show status,
timing and headers.

## 2. Multiplexing

Run several requests at once:

```sh
# PowerShell
1..10 | ForEach-Object -Parallel { curl.exe -s -H "Host: demo.localhost" http://localhost:8080/ }
```

Or use the benchmark client. The inspector fills with overlapping requests,
showing that many streams share one TLS connection.

## 3. HTTP tunnel failure

Stop the local app (Ctrl+C in terminal 2) and request again:

```sh
curl -i -H "Host: demo.localhost" http://localhost:8080/
```

Show `502 Bad Gateway`; the tunnel stays online. Restart the app and show the
next request succeeds without reconnecting.

## 4. Raw TCP tunnel

Start a TCP echo service or a database. A tiny echo server:

```sh
# terminal 2, after Ctrl+C on the HTTP app
node -e "require('net').createServer(s=>s.pipe(s)).listen(4000,()=>console.log('tcp echo :4000'))"
```

```sh
# terminal 3
npx wormhole tcp 4000 --token dev-token-please-change --subdomain echo
```

It prints `tcp://localhost:15000` (the port is from the config range). In
another terminal:

```sh
node -e "const s=require('net').connect(15000,'127.0.0.1',()=>s.write('hello'));s.on('data',d=>{console.log(d.toString());s.end()})"
```

Show the echo. Optionally connect a real Postgres/SSH client instead.

## 5. Reconnect

Stop the relay (Ctrl+C in terminal 1) and watch the client print backoff
messages. Start the relay again:

```sh
npm run server
```

The client reconnects and keeps `demo.localhost`. Send another request to prove
the same URL works.

## 6. Limits

Show the configured limits in `server/config.yaml`. With
`maxStreamsPerTunnel: 1` and a slow local app, a second request returns `429`
with `Retry-After`; restore the value afterwards. The test suite covers this in
`client/test/limits.test.ts`.

## 7. Deployment (optional)

```sh
docker build -t wormhole-relay .
docker run --rm -p 4443:4443 -p 8080:8080 wormhole-relay
```

Then repeat step 1. For wildcard HTTPS and a VPS, show
`deploy/README.md` and `deploy/Caddyfile`.

## 8. Wrap-up

- One outbound TLS connection, many multiplexed streams
- HTTP + raw TCP
- Reconnect with stable HTTP subdomain
- Limits and graceful shutdown
- Benchmarks: `bench/results/latest.md`
- 133 tests, strict TypeScript, Docker image
