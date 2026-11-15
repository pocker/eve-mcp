# Plan

Each phase ends with something that runs and has tests. Tick items when done (same change).

## Phase 0 - Skeleton

- [x] Install Bun (`curl -fsSL https://bun.sh/install | bash`).
- [x] `bun add hono @modelcontextprotocol/server zod jose` and `bun add -d @types/bun typescript`.
- [x] `src/config.ts` (zod env parse, `*_FILE` secret files, fail fast), `src/index.ts` with `GET /health`.
- [x] `src/db/db.ts` (`Bun.sql` client) and `src/db/migrate.ts`: run `migrations/*.sql` in order under an advisory lock, track in `schema_migrations`.
- [x] Test helper: per-file schema on the local Postgres. (DB tests run green against Postgres 17 over an SSH tunnel)
- [x] `src/crypto.ts`: random token, sha256, AES-256-GCM with key ID. Tests.
- [x] Secure headers + request logger with redaction.

## Phase 1 - Users and characters (web)

- [ ] Register an EVE app (dev) at developers.eveonline.com, callback `${PUBLIC_URL}/auth/eve/callback`, scopes from `src/esi/scopes.ts`.
- [x] `auth/eve-sso.ts`: authorize URL with state, callback, code exchange, JWT verify via JWKS.
- [x] Login creates/finds user; "add character" links to current user; owner hash rule.
- [x] Sessions (`__Host-session`), logout.
- [x] Pages: `/`, `/characters` (list, add, remove), `/account` (delete).
- [x] Admin: `ADMIN_CHARACTER_IDS`, `/admin/users` list (character names), disable, delete user.
- [x] Tests: login new user, add second character, character moved to another user via owner hash, delete account.

## Phase 2 - ESI client + MCP tools (dev auth)

- [x] `esi/client.ts`: headers, cache with ETag/Expires, shared error-limit guard (`esi_status`), paging cap, token refresh under `pg_advisory_xact_lock(character_id)`, `needs_reauth`.
- [x] Test: two concurrent refreshes for one character call SSO once.
- [x] `esi/names.ts`: ID to name via `POST /universe/names`, cached.
- [x] `mcp/server.ts`: stateless Streamable HTTP on `/mcp`, server per request.
- [x] Dev-only bearer: `DEV_GRANT_TOKEN` env maps to a grant (disabled when `NODE_ENV=production`), so tools can be tried before OAuth exists.
- [x] Tools from the v1 table in ARCHITECTURE.md. Each with zod input, output cap, test with fake ESI, and a cross-user refusal test.
- [ ] Try with MCP Inspector (`bunx @modelcontextprotocol/inspector`). (Not done; a curl smoke of initialize, tools/list, tools/call and the full OAuth code + PKCE flow against a real Postgres passed.)

## Phase 3 - OAuth for MCP clients

- [x] Read the current MCP authorization spec; note the version in ARCHITECTURE.md.
- [x] Metadata endpoints (RFC 9728, RFC 8414).
- [x] Dynamic client registration (+ client ID metadata documents if the spec prefers them).
- [x] `/oauth/authorize` with SSO sign-in, consent page (pick characters / all), CSRF.
- [x] `/oauth/token`: code + PKCE S256, refresh rotation with reuse detection, resource binding.
- [x] `/oauth/revoke`, `/apps` page (list, manage, revoke).
- [x] `/mcp` bearer middleware with `WWW-Authenticate` on 401. Remove dev bearer from prod path.
- [ ] Test end to end with Claude (custom connector) and one other client.

## Phase 4 - More tools

- [x] Fittings: `get_fittings`, and `create_fitting` / `delete_fitting` (first write scope, opt-in per grant).
- [x] Contracts, clones/implants, killmails, wallet transactions, standings, loyalty points, mining ledger, planets, attributes.
- [x] Market: `hub_prices`, `price_history`, `appraise_assets`.
- [ ] Structures.
- [x] zKillboard tools: `zkill_stats`, `zkill_kills`, `killmail_detail` (with loss fit as EFT), prompt `pilot_check`.
- [x] Scope upgrade flow: tool says which scope is missing, `/characters` shows "Re-link" on every character (updates tokens and scopes in place, keeps app access).
- [x] Military campaigns: `military_campaigns` (public); `get_military_participation` is enabled with `esi-activities.read_character.v1`, pending a live check (an earlier live call got a 401 asking for `esi.activity.char:read`). Needs ESI compat date 2026-08-04 or later.
- [x] Live universe intel: `system_info`, `route_safety`, `incursions`, `sovereignty`, `faction_warfare` (ESI public + zKillboard, cached).

## Phase 5 - Go live (Docker Compose on the NAS)

- [x] Check `Containerfile` and `docker-compose.yml` against the real app; `docker compose up -d --build` on the NAS.
- [x] Secrets files in `./secrets`, `.env` written (see README).
- [ ] Reverse proxy on the NAS points at `APP_PORT`; app port closed to everything else; set `CLIENT_IP_HEADER`.
- [ ] Cloudflare: proxied DNS, WAF skip for MCP/OAuth paths, cache bypass.
- [ ] Off-NAS copy of `./backups`, tested restore.
- [ ] Production EVE app.
- [ ] Work through the checklist in docs/SECURITY.md.
- [ ] `/connect` page with setup steps per client.

## Phase 6 - Static data

- [x] SDE importer (`bun run sde:import`, background import at first start, daily build check), migration 0003, tests.
- [x] `get_type_info` from the SDE (ESI fallback), `skill_requirements`, `can_fly`, `skill_plan`, `blueprint_info`.
- [ ] Look at the skill queue in `skill_plan` (start after what is already queued).
- [ ] Replace the ESI region/constellation lookups in the intel tools with the SDE map tables (not imported yet).

## Not planned (say no unless asked)

Corporation/alliance data, write scopes other than fittings, mail, a SPA frontend, Redis, a
Postgres cluster.

- [x] AGPL-3.0-or-later licence, CCP notice, `/privacy` page, ESI `420` handling and per-route-group rate-limit buckets.

## Decisions

- SSO-only accounts (no password/email). Decided 2026-11-14.
- Postgres 17 via `Bun.sql`, Docker Compose on the owner's NAS behind their own reverse proxy (no Caddy, no Swarm), 1 app replica, code kept replica-safe. Decided 2026-11-14.
