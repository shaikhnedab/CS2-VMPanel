# CS2-VMPanel

Modern VIP & admin management panel for community game servers — dashboard, servers, VIPs, admins, bundles, Steam-player store with PayPal / PayU / Razorpay checkout, VIP gifting, Discord notifications, audit logs, and automatic VIP expiry.

![Login](Screen_Shots/01-login.png)
![Dashboard](Screen_Shots/02-dashboard.png)

> **Fork note:** this project is a modernized fork of [Summer-16/CSGO-VMPanel](https://github.com/Summer-16/CSGO-VMPanel) by Shivam Parashar (Summer Soldier), resecured and rebuilt (see [Credits](#credits)). The legacy `Server_Plugin/` (CS:GO SourceMod) and `Old_Content/` folders were removed in this fork — the panel manages all records in MySQL; point your game-server integration at the same database (schema in `app/db/migrations/`).

## Features

- **Dashboard** — servers, active VIPs/admins, sales & renewal counts, per-server VIP tables with expiry badges
- **VIPs** — add / extend / delete per server, Steam profile lookup, search, bulk-aware forms
- **Admins** — SourceMod flag management per server
- **Servers & bundles** — multi-server VIP packages, slot/pricing/flag control
- **Player store** — Steam login, owned-VIP status, buy/renew via PayPal, PayU, or Razorpay
- **VIP gifting** — gift to another user by Steam profile link with server-verified receiver preview
- **Payments** — server-side price/quote verification, order-replay protection, sale types (buy/renew/gift)
- **Discord** — sale notifications + scheduled VIP/admin listing digests
- **Audit logs & sales records** — super-admin only, paginated, quick-find filters
- **Automation** — cron expiry cleanup + Discord digests, one-click manual refresh
- **Security** — parameterized queries, transactional multi-server writes, CSRF tokens, RBAC-gated routes, rate-limited auth/payments, hardened sessions/cookies, safe error envelopes with request IDs, first-boot installer (no shipped credentials)
- **UI** — dark/light modes, 5 panel themes, responsive mobile drawer, command palette (`Ctrl/⌘+K`), keyboard-first, reduced-motion support

More screenshots: [`Screen_Shots/`](Screen_Shots/) (VIP management · settings · sales · mobile).

## Requirements

- Node.js 22+ (`engines` enforced)
- MySQL 8.0+ or MariaDB 10.6+
- Steam API key for player login ([get one](https://steamcommunity.com/dev))
- Optional: PayPal client ID, PayU merchant key/salt, Razorpay key ID/secret, Discord webhook URL

## Quick start — local

```bash
# 1. Database
sudo apt install mariadb-server mariadb-client
sudo service mariadb start
sudo mysql -e "CREATE DATABASE vmpanel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'vmpanel'@'localhost' IDENTIFIED BY 'pick-a-strong-password';
  GRANT ALL ON vmpanel.* TO 'vmpanel'@'localhost';"

# 2. Panel
npm install
cp .env.example .env   # then edit DB_* and secrets (min 32 chars)
npm run migrate        # apply schema migrations (indexes, gifting columns)
npm test               # smoke tests, no DB needed
node server.js         # http://localhost:3535
```

Default login is the admin account you create in the first-boot wizard below — there are no shipped credentials.

## Quick start — Docker (external MySQL, no bundled database)

The compose stack runs only the panel container using the prebuilt image from
GHCR (published by [`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml)
on every `main` push: `latest`, `main`, `sha-*`, plus `v*` version tags).
Provision MySQL/MariaDB yourself (any host reachable from the container:
managed DB, host package, or a separate container on your own network).

```bash
docker compose pull            # prebuilt ghcr.io/shaikhnedab/cs2-vmpanel:latest
docker compose up -d
docker compose logs -f panel
# → http://localhost:3535 (first visit redirects to the /install wizard)
```

Pin a version with `IMAGE_TAG` (e.g. `IMAGE_TAG=v2.0.0 docker compose up -d`).
Prefer building locally? Comment `image:` in `docker-compose.yml`, uncomment
`build: .`, then `docker compose up -d --build`. Either way you can skip
`.env` entirely — the wizard writes it on first boot, and the
`./.env:/app/.env` volume mount keeps it across restarts and rebuilds.

## Install guide (first boot)

Provision MySQL 8.0+ / MariaDB 10.6+ first and create an empty database plus a
user with full rights on it (see [Quick start — local](#quick-start--local)
for the SQL, or use your hoster's panel). The DB user needs `CREATE`/`ALTER`
rights on first run (tables + migrations); plain read/write is enough after.

Start the panel with **no `.env`** (or `SETUP_COMPLETE=false`):

![Install wizard](Screen_Shots/00-install.jpg)

1. Open `/install` — every other page redirects there until setup finishes.
2. Fill DB host/port/user/password/name and press **Test connection**
   (5s timeout; failures show a red banner with a generic message —
   no driver details leak):

   ![Install connection error](Screen_Shots/00-install-error.jpg)

3. Pick the super-admin username (3–32 chars) + password (min 8 chars,
   confirmed), add an optional Steam API key, and press
   **Install & continue**.
4. The panel re-tests the connection, writes `.env` (mode `0600`),
   creates tables, runs migrations, creates the super-admin (bcrypt cost 12),
   flips `SETUP_COMPLETE=true`, and redirects to `/login`.

After setup `/install*` returns `404` and never reopens — even if the
database later goes down (those requests fail with a generic error instead).
To re-run setup: stop the panel, delete `.env`, start again.

> Back up `.env` — it holds your DB password and signing secrets. It is
> gitignored and never committed. `npm run migrate` stays idempotent and
> no-ops (exit 0) until setup is complete.

Images are also built in CI: see [`.github/workflows/docker-build.yml`](.github/workflows/docker-build.yml) (publishes to GHCR on `main`/tags).

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | yes | MySQL/MariaDB connection (external host — the compose stack bundles no database) |
| `JWT_SECRET` `APP_SESSION_SECRET` | yes | Auth/session signing (≥32 random chars) |
| `STEAM_API_KEY` | for player login | Steam Web API key |
| `HOSTNAME` `SERVER_PORT` `APACHE_PROXY` | behind proxy | Set `APACHE_PROXY=true` behind nginx/Apache so cookies are `Secure` |
| `PAYPAL_CLIENT_ID` | for PayPal | PayPal REST client ID |
| `PAYU_ENABLED` `PAYU_ENV` `PAYU_MERCHANT_KEY` `PAYU_MERCHANT_SALT` | for PayU | PayU gateway |
| `RAZORPAY_ENABLED` `RAZORPAY_ENV` `RAZORPAY_KEY_ID` `RAZORPAY_KEY_SECRET` | for Razorpay | Razorpay gateway |
| `SCHEDULE_DELETE_HOURS` `SCHEDULE_NOTIF_HOURS` | no | Cron intervals for expiry cleanup / Discord digests |
| `LOG_LEVEL` | no | `INFO` (production) / `DEBUG` (request logging) |

Never commit `.env` or `config.json` — both are gitignored.

## Reverse proxy hosting

TLS should terminate at the proxy; always run the panel with `APACHE_PROXY=true` behind one.

**nginx** — [`deploy/nginx-vmPanel.conf`](deploy/nginx-vmPanel.conf) (validated with `nginx -t`):

```bash
sudo cp deploy/nginx-vmPanel.conf /etc/nginx/sites-available/vmpanel
sudo ln -s /etc/nginx/sites-available/vmpanel /etc/nginx/sites-enabled/
# add the limit_req_zone line to the http{} block (see comments in the file)
sudo certbot --nginx -d vip.example.com
sudo nginx -t && sudo systemctl reload nginx
```

**Apache** — [`deploy/apache-vmPanel.conf`](deploy/apache-vmPanel.conf):

```bash
sudo a2enmod proxy proxy_http headers rewrite ssl
sudo cp deploy/apache-vmPanel.conf /etc/apache2/sites-available/vmpanel.conf
sudo a2ensite vmpanel && sudo apache2ctl configtest && sudo systemctl reload apache2
```

## Docs & internals

- `app/db/migrations/` — versioned schema changes (`npm run migrate` is idempotent; it no-ops with exit 0 until setup is complete)
- `tests/smoke.js` + `tests/install.js` — `npm test`

## Credits

CS2-VMPanel is a fork of **[CSGO-VMPanel](https://github.com/Summer-16/CSGO-VMPanel)** by **Shivam Parashar (Summer Soldier)**, which created the original panel, plugin, and feature set. This fork modernized it: full security overhaul, hardened payments, VIP gifting, new Nova UI with dark/light modes, Docker support, and migrations — while keeping the plugin database contract intact. Licensed under [GPL-3.0-or-later](LICENSE), same as upstream.
