# eve-mcp

An [MCP](https://modelcontextprotocol.io) server for EVE Online. You sign in with EVE SSO, link one or more of your characters, and connect an AI assistant (Claude, ChatGPT, Cursor, ...). The assistant can then read your in-game data through the EVE ESI API, but only for the characters you allow.

- Read-only by default. The only thing it can change in game is your saved fittings (create, delete), and only for apps you allow to on the consent page.
- Also answers questions that need no login: static game data, market prices at the main trade hubs, route danger, sovereignty, incursions, zKillboard threat profiles, EVE-Scout Thera connections and [EVE University wiki](https://wiki.eveuniversity.org) guides.
- Tells the assistant how to use it: server instructions plus prompt templates (`plan_for_ship`, `check_fit`, `route_check`, `asset_overview`, `industry_check`, `pilot_check`).

Status: early, see [docs/PLAN.md](docs/PLAN.md).

## Use the hosted service

Live instance: **https://eve.dszendrei.hu**

1. Open the site and sign in with EVE Online. Link the characters you want to use.
2. Add a custom connector (remote MCP server) in your client, with this URL:
   `https://eve.dszendrei.hu/mcp`
   - **Claude**: Settings, Connectors, add custom connector.
   - **ChatGPT**: add it as a custom MCP connector (developer mode).
   - **Others** (Cursor, ...): any client that supports remote MCP over Streamable HTTP with OAuth works.
3. The client opens a consent page on the site. Pick which characters it may see and whether it may manage fittings. You can change or revoke this later on `/apps`.

Tools, grouped (the full, current list is on [/features](https://eve.dszendrei.hu/features); the `about_sources` tool returns the same to the assistant):

| Group | Tools |
|---|---|
| Your characters | `list_characters`, `character_overview`, `get_skills`, `get_skill_queue`, `get_attributes`, `get_clones`, `get_assets`, `get_wallet_journal`, `get_wallet_transactions`, `get_market_orders`, `get_industry_jobs`, `get_contracts`, `get_contract_items`, `get_killmails`, `get_standings`, `get_loyalty_points`, `get_mining_ledger`, `get_planets`, `get_military_participation`, `can_fly`, `skill_plan`, `appraise_assets` |
| Fittings (write, opt-in) | `get_fittings`, `create_fitting`, `delete_fitting` |
| Game data and market | `get_type_info`, `skill_requirements`, `blueprint_info`, `hub_prices`, `price_history`, `resolve_names` |
| Travel and intel | `plan_route`, `route_safety`, `system_info`, `incursions`, `sovereignty`, `faction_warfare`, `military_campaigns`, `thera_connections`, `get_server_status` |
| zKillboard | `zkill_stats`, `zkill_kills`, `killmail_detail` |
| News and wiki | `ccp_news`, `sde_changes`, `wiki_search`, `wiki_page` |

Privacy: see [/privacy](https://eve.dszendrei.hu/privacy) (what is stored, how long, how to delete your account).

## EVE permissions (scopes)

The server asks for these ESI scopes at every sign-in (the list is `EVE_SCOPES` in `src/esi/scopes.ts`).

| Scope | Used for |
|---|---|
| `esi-location.read_location.v1` | `character_overview` (system or station) |
| `esi-location.read_ship_type.v1` | `character_overview` (current ship) |
| `esi-location.read_online.v1` | `character_overview` (online status) |
| `esi-skills.read_skills.v1` | `get_skills`, `get_attributes`, `can_fly`, `skill_plan`, `fit_stats` (with a character) |
| `esi-skills.read_skillqueue.v1` | `get_skill_queue`, `character_overview` |
| `esi-wallet.read_character_wallet.v1` | `get_wallet_journal`, `get_wallet_transactions`, `character_overview` |
| `esi-assets.read_assets.v1` | `get_assets`, `appraise_assets` |
| `esi-markets.read_character_orders.v1` | `get_market_orders` |
| `esi-industry.read_character_jobs.v1` | `get_industry_jobs` |
| `esi-fittings.read_fittings.v1` | `get_fittings` |
| `esi-fittings.write_fittings.v1` | `create_fitting`, `delete_fitting` (only for apps where you opted in) |
| `esi-contracts.read_character_contracts.v1` | `get_contracts`, `get_contract_items` |
| `esi-clones.read_clones.v1` | `get_clones` |
| `esi-clones.read_implants.v1` | `get_clones` |
| `esi-killmails.read_killmails.v1` | `get_killmails` |
| `esi-characters.read_standings.v1` | `get_standings` |
| `esi-characters.read_loyalty.v1` | `get_loyalty_points` |
| `esi-industry.read_character_mining.v1` | `get_mining_ledger` |
| `esi-planets.manage_planets.v1` | `get_planets` |
| `esi.activity.char:read` | `get_military_participation` |

- **Read-only by default.** Every scope except the fittings write scope is a read scope.
- **Fittings write** is the only write permission. The fitting tools that change data are offered only to apps where you ticked the separate "may manage fittings" box on the consent page (unticked by default). Writes are audit-logged.
- **Planets "manage"**: CCP names the planets scope `manage_planets`, but it is the only scope that allows reading planets. The code only calls the GET endpoints.
- A character that was linked before a scope was added must re-link on `/characters`.

## Self-hosting

You can run your own copy. It needs an EVE application of your own, because the callback URL and keys belong to one app.

### What you need

- A domain with HTTPS, served by your own reverse proxy (the app speaks plain HTTP and does not do TLS).
- Docker with Compose, for the production setup. For development: [Bun](https://bun.sh) and Postgres 17 (`bun run db:up` starts one in Docker).
- An EVE developer account.

### 1. Create the EVE application

At https://developers.eveonline.com create an application:

- Callback URL: `${PUBLIC_URL}/auth/eve/callback` (for example `https://eve.example.com/auth/eve/callback`).
- Scopes: tick exactly the scopes in the table above. EVE SSO refuses the sign-in (`invalid_scope`) for any scope that is not assigned to the application, so a missing one breaks every login.
- Note the client ID and the client secret.

### 2. Settings

Put the non-secret settings in a `.env` file next to `docker-compose.yml`, and the secrets in files under `secrets/`. Any secret can come from a file by setting `NAME_FILE=/path` instead of `NAME`; the file wins and is trimmed. Compose does this for you.

| Variable | Required | Meaning |
|---|---|---|
| `PUBLIC_URL` | yes | Public base URL, no trailing slash. The MCP endpoint is `${PUBLIC_URL}/mcp`. |
| `EVE_CLIENT_ID` | yes | From your EVE application. |
| `EVE_CLIENT_SECRET` | yes (secret) | From your EVE application. Compose: `secrets/eve_client_secret`. |
| `TOKEN_ENC_KEY` | yes (secret) | 32 random bytes, base64. Encrypts EVE refresh tokens. Compose: `secrets/token_enc_key`. |
| `ESI_CONTACT` | yes | Email or URL for the ESI `User-Agent`. CCP requires a way to contact you. |
| `DATABASE_URL` | yes, or the next two | Postgres URL. Compose builds it from `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_DB` and `POSTGRES_PASSWORD(_FILE)` instead. |
| `ESI_COMPAT_DATE` | no | ESI `X-Compatibility-Date` (YYYY-MM-DD). Default in `src/config.ts`; check CCP's ESI docs for the current one. |
| `ADMIN_CHARACTER_IDS` | no | Comma-separated EVE character IDs. Users who link one of them get the `/admin` page. Empty means no admins. |
| `CLIENT_IP_HEADER` | no | Header with the real client IP from your proxy, for the rate limits. See below. |
| `ALLOWED_ORIGINS` | no | Comma-separated origins allowed to call `/mcp` from a browser. Empty means none. |
| `APP_PORT` | no | Compose only: host port for the app, default `38080`. |
| `PORT` | no | Port inside the container, default `3000`. |
| `DB_POOL_MAX` | no | Max Postgres connections per app process, default `20`. |
| `TOKEN_ENC_KEY_OLD` | no (secret) | Previous key while rotating `TOKEN_ENC_KEY`. |
| `IMAGE`, `IMAGE_TAG` | no | Compose only: name and tag of the built image. |
| `DEV_GRANT_TOKEN`, `DEV_USER_ID` | dev only | Static dev bearer for `/mcp`. Ignored in production; startup fails if it is set with an https `PUBLIC_URL`. |

[.env.example](.env.example) has every variable with comments.

### 3. Create the files and start

```sh
mkdir secrets backups && chmod 700 secrets
openssl rand -base64 32 > secrets/token_enc_key      # TOKEN_ENC_KEY
openssl rand -base64 24 > secrets/postgres_password
printf '%s' '<EVE client secret>' > secrets/eve_client_secret
chmod 600 secrets/*

cat > .env <<'EOF2'
PUBLIC_URL=https://eve.example.com
EVE_CLIENT_ID=<id>
ESI_CONTACT=<your email or url>
ADMIN_CHARACTER_IDS=<your character id>
APP_PORT=38080
CLIENT_IP_HEADER=
EOF2

docker compose up -d --build
```

Migrations run at start (under a Postgres lock). On the first start the app also imports CCP's static data in the background; that takes about a minute and needs outbound HTTPS to `developers.eveonline.com`. `GET /health` answers when the app and database are up.

Back up `secrets/token_enc_key`. If you lose it, every character must re-link.

### Reverse proxy and TLS

- Point your proxy at `http://<host>:${APP_PORT}`. TLS and HSTS are the proxy's job.
- **Only the proxy may reach the app port** (firewall it, or bind it to the proxy's network). The app trusts what arrives there.
- Set `CLIENT_IP_HEADER` (for example `CF-Connecting-IP` for Cloudflare, or `X-Real-IP`) only when the proxy overwrites that header on every request and the port is not reachable any other way. Otherwise any client can send the header and dodge the rate limits. Leave it empty if unsure; the app then uses the socket address.
- Behind Cloudflare: turn off Bot Fight Mode and "Block AI bots" for `/mcp`, `/oauth/*` and `/.well-known/*` (MCP clients are not browsers), and bypass the cache. More in the "Deployment" section of [ARCHITECTURE.md](ARCHITECTURE.md).

### Backups

The `backup` service in `docker-compose.yml` runs `pg_dump` every 6 hours into `./backups` and keeps the newest 28 files. That folder lives on the same disk, so copy it somewhere else too. Restore steps are in ARCHITECTURE.md.

### Updating

```sh
git pull
docker compose up -d --build
```

### Optional: deploy script

`scripts/deploy.sh` ships the committed `HEAD` to a remote Docker host over ssh, rebuilds and polls `/health`. It needs `DEPLOY_HOST` (ssh host) and `DEPLOY_URL` (the app URL as your machine reaches it), from the environment or from a git-ignored `.deploy.env` file in the repo root. Commit first; uncommitted changes are not deployed. Skip it if you update by hand.

### If you host it for others: EVE Developer License

Running a public copy means you accept CCP's EVE Developer License (linked from developers.eveonline.com). The main points:

- Non-commercial only. No ads, paywalls or paid features.
- Keep the CCP copyright notice (below) visible. The site footer already shows it.
- Donations are fine only if voluntary and if they unlock nothing (§4.4b).
- Use ESI politely: a real contact in `ESI_CONTACT`, caching and the error limit. The code already does this; do not remove it.

Read the licence itself; this list is not legal advice.

## Development

```sh
bun install
bun run db:up      # local Postgres 17 (Docker), localhost:5432
cp .env.example .env   # fill in EVE_CLIENT_ID, EVE_CLIENT_SECRET, TOKEN_ENC_KEY, ESI_CONTACT
bun run dev        # http://localhost:3000, runs migrations at start
bun test           # needs Postgres; each test file uses its own schema
bun run typecheck
```

For the dev EVE app, use callback `http://localhost:3000/auth/eve/callback`. To test against another Postgres, set `TEST_DATABASE_URL` in `.env.test` (git-ignored). Tests never call the real ESI.

Docs: [ARCHITECTURE.md](ARCHITECTURE.md) (how it works), [docs/SECURITY.md](docs/SECURITY.md) (threat model and rules), [docs/PLAN.md](docs/PLAN.md) (roadmap), [AGENT.md](AGENT.md) (rules for AI agents working on this repo).

## Support

If you find the hosted service useful, you can [buy me a coffee](https://ko-fi.com/pamera). It is voluntary, helps cover hosting and unlocks nothing (EVE Developer License §4.4b).

## License

The code is licensed under AGPL-3.0-or-later (see [LICENSE](LICENSE)). If you run a modified copy as a public service, you must offer its users the source of your version. The site footer links to the source of the hosted one.

Ship fit simulation (`fit_stats`) uses the npm package [eve-fit-engine](https://github.com/capsuleers-app/capsuleers.fitting-engine), licensed GPL-3.0-or-later, which is compatible with AGPL-3.0-or-later. It brings its own copy of CCP static data.

EVE Online data, names and images belong to CCP hf. and are not covered by this licence. Wiki text returned by the wiki tools is from the EVE University Wiki, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf. This project is not affiliated with CCP.
