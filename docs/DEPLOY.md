# Deploying Day on this host

The deployed instance is:

```text
https://day.home.br11k.dev
```

Basic authentication is enabled. Credentials are in
`/home/br11k/git/konovalov-nk/day/.env` (`DAY_USER`, `DAY_PASSWORD`,
`DAY_READ_TOKEN`). The file is mode `0600` and ignored by Git.

## What runs where

```text
browser
  -> router / public edge
  -> Hetzner HAProxy (TLS passthrough, routes.yaml allowlist)
  -> WireGuard 10.8.0.2
  -> ArchVM Caddy (caddy-docker-proxy, :443)
  -> host.docker.internal:3037
  -> systemd user service day.service
  -> data/day.sqlite
```

- `day.service` runs the Node server on the host and restarts on failure.
- `day-proxy` is a label-only container on the `proxy` network. It exists so
  caddy-docker-proxy can generate the route without a second application
  runtime. It does not proxy traffic itself.
- The public edge allowlist lives in
  `../caddy-proxy-network/routes.yaml`; `home-domain ensure day` registered the
  route and reloaded HAProxy with a backup.

## Files

| File | Purpose |
| --- | --- |
| `deploy/day.service.example` | systemd user unit |
| `deploy/day-caddy.yml` | label-only caddy-docker-proxy container |
| `deploy/Caddyfile.example` | plain Caddy alternative |
| `.env` | host-specific address, credentials, network |

## Configuration used

```sh
DAY_HOST=0.0.0.0
DAY_PORT=3037
DAY_BASE_URL=https://day.home.br11k.dev
DAY_CADDY_NETWORK=proxy
```

`DAY_HOST=0.0.0.0` is required because Caddy reaches the app through the Docker
host gateway. `DAY_BASE_URL` makes CLI links and the tutorial point at HTTPS.

## Install

```sh
mkdir -p ~/.config/systemd/user
cp deploy/day.service.example ~/.config/systemd/user/day.service
systemctl --user daemon-reload
systemctl --user enable --now day.service
loginctl enable-linger "$USER"   # start at boot without an active login
```

Caddy route:

```sh
docker compose -f deploy/day-caddy.yml up -d
cd ../caddy-proxy-network
./scripts/home-domain ensure day --project day \
  --expected-status 401 --public-status 401
```

`home-domain` adds the public edge route before waiting for ACME. The
`--expected-status 401` is correct because the dashboard requires Basic auth;
the health endpoint itself returns 200.

## Verify

```sh
systemctl --user status day.service
docker ps --filter name=day-proxy
curl -fsS http://127.0.0.1:3037/health
curl -fsS https://day.home.br11k.dev/health
curl -u "$DAY_USER:$DAY_PASSWORD" -o /dev/null -w '%{http_code}\n' \
  https://day.home.br11k.dev/
openssl s_client -connect day.home.br11k.dev:443 \
  -servername day.home.br11k.dev </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

The current certificate is issued by Let's Encrypt for
`CN=day.home.br11k.dev`.

## Operations

```sh
systemctl --user restart day.service   # or: make stop && make start
systemctl --user stop day.service
journalctl --user -u day.service -f
```

`make start`, `make stop`, and `make status` detect the systemd unit and use it
instead of the detached-process fallback.

## Local DNS note

`home-domain check` reported that the router currently resolves
`*.home.br11k.dev` to the public edge IP instead of `192.168.50.67`. HTTPS still
works through the edge from this host. The router repository already contains
the intended wildcard:

```text
address=/home.br11k.dev/192.168.50.67
```

Applying it on the router is separate from this application deployment.
