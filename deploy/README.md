# Deploying Wormhole on a VPS

The relay is one Node.js process. The recommended layout is:

```
internet ──443──► Caddy (wildcard TLS) ──8080──► Wormhole relay
internet ──4443───────────────────────────────► Wormhole relay (TLS control)
internet ──15000-15099────────────────────────► Wormhole relay (raw TCP tunnels)
```

## 1. DNS

Create these records for your domain (examples use `example.com`):

| Record | Value |
|---|---|
| `A relay.example.com` | VPS IPv4 |
| `A tunnel.example.com` | VPS IPv4 |
| `A *.tunnel.example.com` | VPS IPv4 |

`relay.example.com` is the control endpoint; `tunnel.example.com` is the base
for HTTP tunnel URLs; the wildcard covers every assigned subdomain.

## 2. Firewall

Open:

- `80/tcp` and `443/tcp` for Caddy/ACME
- `4443/tcp` for the TLS control listener
- the configured TCP tunnel range, e.g. `15000-15099/tcp`
- SSH from your own address only

## 3. Tokens and configuration

Generate a token:

```sh
openssl rand -hex 32
```

Copy [`config.production.yaml`](./config.production.yaml) to
`server/config.yaml` (or mount it separately) and replace the token and domain
values. Important fields:

- `publicHost`: the wildcard base, e.g. `tunnel.example.com`
- `publicScheme: https` and `publicPort: 443`: what clients see in `ASSIGN`
- `httpPort: 8080`: where the relay itself listens behind Caddy
- `tcp.portStart`/`tcp.portEnd`: must match the published Docker port range
- `limits`: per-tunnel concurrency, per-token tunnels and request rate

## 4. Control-listener certificate

Clients verify the control connection with `--secure`/`--ca`. Give the relay a
real certificate for `relay.example.com`:

```sh
sudo certbot certonly --standalone -d relay.example.com
sudo cp /etc/letsencrypt/live/relay.example.com/privkey.pem server/certs/relay.key
sudo cp /etc/letsencrypt/live/relay.example.com/fullchain.pem server/certs/relay.crt
```

Then point `cert.keyFile`/`cert.certFile` at those files (see the production
config). Renewal: rerun `certbot renew` and restart the relay.

For a quick lab setup you may keep the generated self-signed certificate and
run the client with `--secure` plus `--ca server/certs/server.crt`.

## 5. Public wildcard TLS with Caddy

Choose one of two approaches.

### A. Caddy obtains the wildcard certificate (DNS challenge)

Install a Caddy build with your DNS provider module, e.g. Cloudflare:

```sh
xcaddy build --with github.com/caddy-dns/cloudflare
```

Set `WORMHOLE_DOMAIN=tunnel.example.com`, `ACME_EMAIL=you@example.com` and
`CF_API_TOKEN=...`, then run Caddy with [`Caddyfile`](./Caddyfile). Caddy
obtains one wildcard certificate and proxies every tunnel subdomain. The
example upstream is `relay:8080` for running Caddy in the same compose network;
change it to `127.0.0.1:8080` when Caddy runs on the host.

### B. Use a certificate obtained with certbot

Obtain a wildcard certificate with your DNS provider's certbot plugin, then use
[`Caddyfile.cert`](./Caddyfile.cert):

```sh
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d "*.tunnel.example.com" -d tunnel.example.com

WORMHOLE_DOMAIN=tunnel.example.com \
WORMHOLE_CERT_DIR=/etc/letsencrypt/live/tunnel.example.com \
caddy run --config deploy/Caddyfile.cert --adapter caddyfile
```

This avoids building a custom Caddy image. Renewal: `certbot renew` and reload
Caddy.

## 6. Start the relay

```sh
docker compose up -d --build
docker compose logs -f relay
```

The compose file publishes:

- `4443` for the control listener
- `127.0.0.1:8080` for the HTTP listener (only the local reverse proxy can reach it)
- `15000-15099` for raw TCP tunnels

`server/certs/` is bind-mounted into the container, so the real control
certificate copied in step 4 is visible to the relay. Edit the port range in
both `docker-compose.yml` and `server/config.yaml` if you need more or fewer TCP
tunnels.

## 7. Smoke test

```sh
# HTTP
curl -H "Host: demo.tunnel.example.com" http://127.0.0.1:8080/

# From a laptop
npx wormhole http 3000 --server relay.example.com:4443 \
  --secure --subdomain demo --token "$WORMHOLE_TOKEN"
curl https://demo.tunnel.example.com/

# Raw TCP (the assigned port is printed by the client)
npx wormhole tcp 5432 --server relay.example.com:4443 \
  --secure --subdomain db --token "$WORMHOLE_TOKEN"
```

## 8. Operations

- **Logs**: `docker compose logs -f relay`; set `WORMHOLE_LOG_LEVEL=debug` for
  per-frame diagnostics.
- **Graceful shutdown**: `docker compose stop relay` sends `SIGTERM`. The server
  stops accepting new connections, closes every tunnel and listener, then exits
  (bounded by a 3 s timer).
- **Restart**: `docker compose restart relay`. Clients reconnect automatically
  and request their previous HTTP subdomain.
- **Resource limits**: set `limits.maxStreamsPerTunnel` and
  `limits.maxTunnelsPerToken` before exposing the relay to untrusted users.

## systemd alternative

If you prefer no Docker:

```ini
[Unit]
Description=Wormhole relay
After=network.target

[Service]
WorkingDirectory=/opt/wormhole
Environment=WORMHOLE_CONFIG=/opt/wormhole/server/config.yaml
ExecStart=/usr/bin/npm run server
Restart=on-failure
User=wormhole

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now wormhole`.
