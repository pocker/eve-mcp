# Architecture

## Big picture

```
 Browser (user)                LLM client (Claude, ChatGPT, ...)
      |  HTML pages, cookie session      |  MCP over Streamable HTTP, Bearer token
      v                                  v
 +---------------- Cloudflare (proxied DNS, edge TLS, WAF) ----------------------+
                         |  HTTPS
 +---------------- your reverse proxy on the NAS (terminates TLS) ---------------+
                         |  HTTP to <nas>:${APP_PORT}
 +------------- eve-mcp app (Compose service "app", 1 container) ----------------+
 |  web/      pages: login, characters, connected apps, account                |
 |  auth/     EVE SSO login + "add character", sessions                        |
 |  oauth/    OAuth 2.1 authorization server for MCP clients                   |
 |  mcp/      MCP server + tools  --->  grants (which characters a client sees) |
 |  esi/      ESI client: token refresh, cache, error limit                     |
 |  db/       Bun.sql (Postgres), SQL migrations                               |
 +------------------------------------------------------------------------------+
      |                    |                      |
      v                    v                      v
 Postgres (service   login.eveonline.com     esi.evetech.net (ESI)
 "postgres") <--- "backup" (pg_dump loop)    (SSO v2)
```

The app is stateless: all shared state is in Postgres, so it is safe to run as several replicas
(Compose runs one). TLS and HSTS are the reverse proxy's and Cloudflare's job; the app speaks
plain HTTP. No queue, no cron, no Redis: tokens are refreshed when a tool needs them, under a
Postgres lock.

## Identity model

- A **user** is an account in this app. It has no password and no email.
- A **character** is an EVE character linked to exactly one user. A user can link many.
- You sign in with **EVE SSO**: sign in with any linked character and you get that character's
  user. Signing in with an unknown character creates a new user. "Add character" while signed in
  links the new character to the current user.
- Every SSO flow asks for the same fixed list of scopes (`src/esi/scopes.ts`): all read scopes plus one write
  scope, `esi-fittings.write_fittings.v1` (decision in docs/SECURITY.md); `esi-planets.manage_planets.v1` is named "manage" but is used for GET reads only. Signing in also refreshes that character's
  tokens. Characters linked before a scope was added lack it; the tool says "re-link this character".
- **Owner hash:** EVE's JWT has an `owner` claim. If it changes, the character changed EVE
  account. We unlink it from the old user, delete its tokens and revoke grants that named it,
  then treat it as a new character.
- **Sign-in rules:** `sso_states` rows are single use (deleted on callback) and last 10 minutes. `return_to` must be a local path. Adding a character that belongs to another user is refused. A disabled user cannot sign in. Login destroys any old session before creating one. `/auth/login` also sets a `__Host-sso` cookie equal to the state; the callback refuses unless it matches. Unlinking a character or deleting an account deletes that character's authed `esi_cache` rows.
- **Admins:** character IDs in `ADMIN_CHARACTER_IDS` make their user an admin. This is computed per request in `sessionMiddleware` (the `users.is_admin` column is unused). Admins can list,
  disable and delete users (not themselves, not other admins, and only with a confirm checkbox). That is the whole of "user management" beyond self-service.

Why no password login: SSO-only means we store no passwords, no email, no reset flow. Every
user has an EVE account anyway. Upgrade path if needed later: add a `credentials` table.

## MCP client authorization (OAuth 2.1)

LLM clients connect with the MCP authorization spec. This server is both the **authorization
server** and the **protected resource**. Check the current MCP spec version before building
phase 3. Implemented against **MCP spec 2026-07-28** (`basic/authorization`); the parts we use:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (and `/mcp` suffix) | RFC 9728. Points clients to our auth server. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `POST /oauth/register` | RFC 7591 dynamic client registration (public clients). Rate limited. |
| `GET /oauth/authorize` | Signs the user in (EVE SSO if needed), shows the consent page. |
| `POST /oauth/authorize` | Consent form submit (CSRF protected). Issues a code. The consent page has a separate, unticked box "Allow this app to create and delete fittings"; ticking it stores `grants.allow_write`. |
| `POST /oauth/token` | `authorization_code` (PKCE `S256` required) and `refresh_token`. |
| `POST /oauth/revoke` | RFC 7009. |

- Client ID Metadata Documents (an https URL with a path as `client_id`) are supported and
  advertised (`client_id_metadata_document_supported`). The spec says SHOULD for these and calls
  DCR deprecated, so DCR stays only for clients that still use it. Fetch: HTTPS only, DNS must
  resolve to public IPs only, 5 s timeout, 64 KB cap, no redirects; document `client_id` must equal
  the URL. Cached in `oauth_clients` for 1 h (`created_at` is the fetch time for URL clients).
  Auth method rule: the document is accepted only if the client can use `none` (public client with
  PKCE). We read `token_endpoint_auth_methods_supported` if present, else
  `token_endpoint_auth_method` (absent means `none`). Other methods in the list, like
  `private_key_jwt`, are ignored, never used.
- Redirect URIs (DCR and CIMD): `https://`, or `http://` on `127.0.0.1`/`localhost`/`[::1]` with
  any port. No custom schemes (the spec only allows localhost or HTTPS). Exact match at authorize.
- Responses carry `iss` (RFC 9207) and the metadata sets `authorization_response_iss_parameter_supported`.
- Scope: one value, `eve:read`, accepted and ignored; what a client can see is decided by the grant.
- Deviation: the consent POST answers with a small page (meta refresh + link) instead of a 302, because
  the `form-action 'self'` CSP blocks a form-post redirect to the client's callback in Chrome.
- **Consent page:** two radio choices. Default (checked): "All my characters, including ones I link later" (`grants.all_characters = true`).
  Secondary: "Only the characters I tick" (grant_characters rows; the server refuses an empty pick). The write opt-in is a separate, unticked box. The result is a **grant** row.
- **Manage a grant:** `GET /apps/:id` shows the same character and write fields (shared `GrantFields` in `src/oauth/pages.tsx`), pre-filled; `POST /apps/:id` saves (zod body, CSRF as every POST) and redirects to `/apps?saved=<id>`. Only the owner of a non-revoked grant; anything else is 404. Ticked characters must all belong to the user. "Only ticked" with none ticked is refused (same as consent). One transaction updates `grants` and replaces `grant_characters`; `grant_updated` goes to `audit_log` (grant, all_characters, allow_write, character ids). It takes effect on the next request: `mcpAuth` reads the grant row on every call, `requireCharacter` and `tools/list` use it per request, so issued tokens keep working with the new rules and write tools vanish and refuse at once when `allow_write` is turned off.
  Why all by default: a specific-characters grant lost access when a character was removed and re-added (the delete cascades to `grant_characters`).
- **Military participation:** `get_military_participation` (`src/mcp/tools/character-more.ts`) is enabled with `esi-activities.read_character.v1`, pending a live check. Its routes are mapped to `esi.activity.char:read` in ESI's spec; SSO rejects that name and an earlier live call with the v1 alias got a 401 asking for it (2026-11-15), so the tool may still fail until CCP fixes the scope.
- **Tokens:** opaque random 32 bytes, base64url. Access token lives 1 hour, refresh token 30 days
  and rotates on every use (reuse of an old refresh token revokes the whole grant).
- Tokens are bound to the `resource` (RFC 8707) = `${PUBLIC_URL}/mcp`. The MCP endpoint rejects
  tokens for any other audience.
- A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="..."` so clients can
  discover the flow.

## MCP server

- Endpoint: `POST /mcp` (and `GET`/`DELETE` as the transport needs). Streamable HTTP, stateless
  mode: one `McpServer` per request, built for the grant of the bearer token. No server-side MCP
  session state, so restarts and future scaling are free.
- SDK: `@modelcontextprotocol/server` 2.4.0 (the 2.x split of `@modelcontextprotocol/sdk`; `McpServer` and
  `registerTool` come from it, tool inputs are wrapped in `z.object(...)`, zod v4). Protocol versions: 2026-07-28
  (`server/discover`, per-request `_meta` envelope) plus 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07.
- Routing in `handleMcp`: `isLegacyRequest` splits traffic. 2026-07-28 requests go to `createMcpHandler(..., { legacy: "reject" })`
  (JSON for a plain answer). Everything else (`initialize` and the 2025 era) goes to
  `WebStandardStreamableHTTPServerTransport` (takes a `Request`, returns a `Response`, no Node shims): no
  `sessionIdGenerator` (stateless) and `enableJsonResponse: true`, so every answer is one plain JSON body (no stream
  to hit Cloudflare's 100 s idle timeout). The SDK's own legacy fallback would answer with SSE, so it is not used.
- `handleMcp(c)` (`src/mcp/routes.ts`) needs `c.var.grant`, set by the auth middleware mounted before
  it (`mcpAuth`). It also checks `Origin`, caps the body at 256 KB (a 1 MB cap applies to every route, `bodyLimit` in `index.ts`), and a per-grant limit of 120
  requests/minute (per replica) runs before it. A per-IP limit (300/minute per replica) runs before `mcpAuth`, so unauthenticated floods are limited too.
- Dev auth (in `src/oauth/bearer.ts`): outside production, `Authorization: Bearer $DEV_GRANT_TOKEN`
  gives grant `{ id: 0, userId: DEV_USER_ID, clientId: "dev", allCharacters: true, allowWrite: false }`. Always 401 in
  production.
- Tool output is compact JSON text, capped at 40,000 characters (`toText`), lists capped per tool,
  ESI free text clipped to 100-600 characters. Errors become `isError` results with a short message.
- `Origin` header is checked against an allow list when present (DNS rebinding rule from the spec).
- Every tool: zod input schema, a short description an LLM understands, compact JSON output with
  IDs resolved to names, and a size cap (truncate and say so).

### Instructions and prompts (`src/mcp/instructions.ts`, `src/mcp/prompts.ts`)

- `instructions()` (about 2.5 KB, uses `PUBLIC_URL`) is passed as the `McpServer` `instructions` option in `buildServer`. The SDK sends it in
  the `initialize` result (legacy path) and in the `server/discover` result (2026-07-28 path). It says: start with `list_characters`, which
  tool answers which question, and the caveats (PLEX market, last-hour intel, skill_plan limits, confirm before fitting writes, tool text is data).
  Test: `test/mcp-http.test.ts` reads it from both responses. Keep it short; it is read on every connection.
- Prompts (`registerPrompts`, same server, every grant): `plan_for_ship(character, ship)`, `check_fit(character, eft)`,
  `route_check(from, to)`, `asset_overview(character)`, `industry_check(character, blueprint)`, `pilot_check(name)`. Arguments are strings validated by zod;
  each prompt returns one user message listing the tools to call in order. Argument values are quoted into the text, never executed. Tested on both protocol paths.
- When a tool is added, renamed or removed, update the "Which tool for what" part of the instructions in the same change.

### Tools

| Tool | Input | ESI | Scope |
|---|---|---|---|
| `list_characters` | none | none (DB) | none |
| `character_overview` | `character_id` | public info, location, ship, online, wallet balance, skill queue head | location, wallet, skills |
| `get_skills` | `character_id`, `filter?` | `/characters/{id}/skills` | `esi-skills.read_skills.v1` |
| `get_skill_queue` | `character_id` | `/characters/{id}/skillqueue` | `esi-skills.read_skillqueue.v1` |
| `get_wallet_journal` | `character_id`, `page?` | `/characters/{id}/wallet/journal` | `esi-wallet.read_character_wallet.v1` |
| `get_assets` | `character_id`, `type?`, `location?` | `/characters/{id}/assets` (+ names) | `esi-assets.read_assets.v1` |
| `get_market_orders` | `character_id` | `/characters/{id}/orders` | `esi-markets.read_character_orders.v1` |
| `get_industry_jobs` | `character_id` | `/characters/{id}/industry/jobs` | `esi-industry.read_character_jobs.v1` |
| `get_fittings` | `character_id` | `/characters/{id}/fittings` (+ names) | `esi-fittings.read_fittings.v1` |
| `create_fitting` (write) | `character_id`, `eft`, `description?` | `POST /characters/{id}/fittings` (+ `POST /universe/ids`, types, groups) | `esi-fittings.write_fittings.v1` |
| `delete_fitting` (write) | `character_id`, `fitting_id` | `DELETE /characters/{id}/fittings/{fitting_id}` | `esi-fittings.write_fittings.v1` |
| `resolve_names` | `names[]` | `POST /universe/ids` | public |
| `get_type_info` | `type_id` or `name` | none (SDE tables); ESI `/universe/types/{id}` until the SDE is imported | public |
| `skill_requirements` | `name_or_id` | none (SDE) | public |
| `can_fly` | `character_id`, `ship_or_module` | `/characters/{id}/skills`, `/characters/{id}/attributes` (+ SDE) | `esi-skills.read_skills.v1` |
| `skill_plan` | `character_id`, `targets?` (`{skill, level}`) or `for_type?` | same as `can_fly` | `esi-skills.read_skills.v1` |
| `blueprint_info` | `name_or_id`, `me?`, `runs?` | none (SDE) | public |
| `plan_route` | `from`, `to`, `flag?` | `/route/{from}/{to}` | public |
| `get_server_status` | none | `/status` | public |
| `hub_prices` | `item`, `hubs?` | `/markets/{region}/orders?type_id=&order_type=` (paged, capped at 10 pages) filtered to the hub station (Jita 60003760/The Forge, Amarr 60008494/Domain, Dodixie 60011866/Sinq Laison, Rens 60004588/Heimatar, Hek 60005686/Metropolis) | public |
| `price_history` | `item`, `region?`, `days?` (7 to 365, default 30), `daily?` | `/markets/{region}/history`, summarised (average, low, high, volume, trend of the last quarter of the window against the rest; `daily` adds raw rows up to 30 days, weekly buckets up to 120, monthly beyond), plus CCP average/adjusted price from `/markets/prices` | public |
| `appraise_assets` | `character_id`, `location?`, `jita_best_buy?` | `/characters/{id}/assets`, `/markets/prices` (average, else adjusted price; blueprint copies skipped); with `jita_best_buy` up to 20 Jita order queries | `esi-assets.read_assets.v1` |
| `get_contracts` | `character_id`, `status?` | `/characters/{id}/contracts` | `esi-contracts.read_character_contracts.v1` |
| `get_contract_items` | `character_id`, `contract_id` | `/characters/{id}/contracts/{contract_id}/items` | `esi-contracts.read_character_contracts.v1` |
| `get_clones` | `character_id` | `/characters/{id}/clones`, `/characters/{id}/implants` | `esi-clones.read_clones.v1`, `esi-clones.read_implants.v1` |
| `get_killmails` | `character_id`, `limit?` (max 20) | `/characters/{id}/killmails/recent`, public `/killmails/{id}/{hash}` (slim summary cached for good under `killmail#<id>`) | `esi-killmails.read_killmails.v1` |
| `get_wallet_transactions` | `character_id`, `from_id?` | `/characters/{id}/wallet/transactions` | `esi-wallet.read_character_wallet.v1` |
| `get_standings` | `character_id` | `/characters/{id}/standings` | `esi-characters.read_standings.v1` |
| `get_loyalty_points` | `character_id` | `/characters/{id}/loyalty/points` | `esi-characters.read_loyalty.v1` |
| `get_mining_ledger` | `character_id` | `/characters/{id}/mining`, summed per ore and day | `esi-industry.read_character_mining.v1` |
| `get_planets` | `character_id` | `/characters/{id}/planets`, `/characters/{id}/planets/{planet_id}` (GET only) | `esi-planets.manage_planets.v1` |
| `get_attributes` | `character_id` | `/characters/{id}/attributes` (remap availability computed) | `esi-skills.read_skills.v1` |
| `ccp_news` | `keyword?`, `limit?` | none (CCP news RSS, `https://www.eveonline.com/rss`, cached 1 h) | public |
| `sde_changes` | `build?` | none (CCP `changes/<build>.jsonl`, cached 24 h; names from our `sde_types`) | public |
| `wiki_search` | `query`, `limit?` | none (EVE University wiki `list=search`) | public |
| `wiki_page` | `title`, `section?` | none (EVE University wiki `prop=extracts`) | public |
| `about_sources` | none | none (our DB: `sde_meta`, `esi_status`); returns `src/sources.ts` + status + `/features` URL | public, `openWorldHint: false` |
| `system_info` | `system` | `/universe/systems/{id}`, `/universe/constellations/{id}`, `/universe/system_kills`, `/universe/system_jumps`, `/sovereignty/systems`, `/fw/systems`, `/incursions`, `/killmails/{id}/{hash}` (5); zKillboard `kills/solarSystemID/{id}/pastSeconds/86400/` (1) | public |
| `route_safety` | `from`, `to`, `preference?`, `avoid?[]`, `recent_kills?` | `POST /route/{from}/{to}` (body `preference`, `avoid_systems`), `/universe/systems/{id}` per system, `/universe/system_kills`, `/universe/system_jumps`; with `recent_kills`: zKillboard for the 3 riskiest | public |
| `thera_connections` | `hub?`, `region?`, `min_ship_size?` | none; EVE-Scout `GET /v2/public/signatures` (1 per 5 min for the whole server, cached) | public |
| `zkill_stats` | `name`, `kind?` | `/universe/ids`, `/universe/names`; zKillboard `stats/{character,corporation,alliance}ID/{id}/kills/` (1, cached 1 h) | public |
| `zkill_kills` | `filter` (exactly one of character, corporation, alliance, ship_type, system, region), `side?`, `past_hours?`, `limit?` (max 10) | `/universe/ids`, `/universe/names`, `/universe/systems/{id}`, `/killmails/{id}/{hash}` (max 10, 4 at a time, summary cached for good as `killmail#<id>`); zKillboard `{kills,losses}/<filter>ID/{id}/[pastSeconds/s/]` (1, cached 5 min) | public |
| `killmail_detail` | `killmail_id`, `hash?` | `/killmails/{id}/{hash}`, names; zKillboard `killID/{id}/` only when no hash (1, cached 5 min) | public |
| `incursions` | none | `/incursions` | public |
| `sovereignty` | `region_or_system` | `/sovereignty/systems` (holder, capital, development levels, Activity Defense Multiplier, sov hub vulnerability window), `/sovereignty/campaigns`, `/skyhooks/raidable` (max 20 shown), region/constellation lookups | public |
| `faction_warfare` | `system_or_region?` | `/fw/systems`, region/constellation lookups | public |
| `military_campaigns` | `campaign_id?` (UUID) | `/military-campaigns`; with id: `/military-campaigns/{id}`, `/military-campaigns/{id}/objectives`. IDs only, no names (SDE `militaryCampaigns` not imported yet). These routes need `X-Compatibility-Date` 2026-08-04 or later | public |

Write tools (`write: {...}` in `defineTool`/`characterTool`) are listed in `tools/list` only when `grant.allowWrite`
is true, and each refuses at call time (`write_not_allowed`) without it. Annotations: `get_fittings` read-only;
`create_fitting` `readOnlyHint: false, destructiveHint: false`; `delete_fitting` `readOnlyHint: false, destructiveHint: true`.
Write ESI calls (`charWrite`) are never cached and never retried; after a write the cached fittings GET is deleted, and
`fitting_created` / `fitting_deleted` go to `audit_log` (user, character, fitting, grant; never the EFT text).
ESI has no update endpoint for fittings (create a new one, delete the old).

`create_fitting` EFT rules (`src/mcp/tools/eft.ts`): header `[Ship, Name]`; blank-line sections low, mid, high, rig, then subsystems
(only if no line ends in `xN`), then drones and cargo. `[Empty ... slot]` lines keep the slot index. `Module, Charge`:
the charge is ignored. `Item xN` lines go to `DroneBay` (category 18), `FighterBay` (87) or `Cargo`. Names resolve with
`POST /universe/ids`; unknown names fail the whole call before anything is written. Name 1-50 chars, description up to 500, up to 512 items.

**Skill queue writes are impossible:** ESI has no endpoint to change the skill queue. Do not try to add one.

Phase 4 adds: contracts, clones/implants, killmails, wallet transactions, structures.
Mail stays out until there is a clear need (privacy and prompt-injection risk).

### Character tool rule

```ts
// characterTool() (src/mcp/tools/util.ts) does this before every character tool's run(), so it cannot be forgotten
const character = await requireCharacter(grant, input.character_id); // 403 character_not_allowed if not in grant
const data = await charGet(character, scope, path);                  // scope check, accessToken (refresh), cache
```

### Universe intel (`src/intel/`, `src/mcp/tools/intel.ts`)

Live, public, last-hour data: `system_info`, `route_safety`, `incursions`, `sovereignty`, `faction_warfare`. All go through
`esiGet`, so ESI `Expires` caching and the error-limit guard apply (`system_kills` / `system_jumps` are hourly, so a second call
costs no request). Systems missing from those lists had no activity and count as zero. Names (alliance, faction, system, ship
type) are resolved in one batched `nameMap` call. A system input is a name (one `POST /universe/ids`, exact match; a miss
says so and points to `resolve_names`) or an ID in 30000000-31999999.

- Security is shown as EVE does: one decimal, anything above 0 and below 0.05 shows as 0.1 (`security`), the raw value is `true_security`.
- `route_safety`: ESI `POST /route/{from}/{to}` (`preference` Shorter/Safer/LessSecure, `avoid_systems`; not cached; 404 means no route), then per system security, ship+pod kills, jumps. Flags: `lowsec`, `nullsec`,
  `kills_last_hour`, `camp_like` (kills+pods at least 15% of jumps, or at least 3 kills and 2 pods at 5% of jumps, never below 3 total).
  Riskiest 3 = highest score (3 per kill or pod, +10 camp_like, +2 lowsec, +4 nullsec). The data is a last-hour aggregate, not a guarantee; each answer says so.
- zKillboard (`src/intel/zkill.ts`, host `zkillboard.com`, `/api/kills/solarSystemID/<id>/pastSeconds/86400/`, trailing slash required):
  `User-Agent: eve-mcp/<version> (+<PUBLIC_URL>; <ESI_CONTACT>)`, `Accept-Encoding: gzip`. It returns only kill ID + hash + value + solo flag, so the
  time, ship and attacker count come from ESI `/killmails/{id}/{hash}` (newest 5, or 3 per risky system). Policy: cached 10 min per system in
  `esi_cache` (`zkill#sys:<id>:<hours>`, only the newest 10 kept), never a fan-out; failures cached 2 min (a `Retry-After` can stretch it to 10) and
  reported as `recent_kills_error`.
- EVE-Scout (`src/intel/evescout.ts`, host `api.eve-scout.com`, `GET /v2/public/signatures`, public JSON, no key, no published terms or limits): one request per 5 minutes for the whole server, cached in `esi_cache` (`evescout#signatures`), failures 2 min, 10 s timeout, contact User-Agent. Only hub, connected system, space class, region, wormhole type, max ship size, expiry and signature IDs are kept; scanner names are dropped. `thera_connections` filters that list; it gives no jump distance (the SDE has no gate graph), so the LLM compares with `plan_route`. Fetch is injectable (`setEveScoutFetch`).
- All zKillboard calls go through `zkillGet` (cache, error cache, UA, gzip, 10 s timeout) and one process-wide queue that keeps 1 s between any two requests,
  even for concurrent tool calls. Used by `system_info`, `route_safety`, `zkill_stats`, `zkill_kills`, `killmail_detail` (at most 1 request per call, except `route_safety`: 3).
  The current API (`zkillboard.com/api/docs`) now also returns the ESI killmail inline; we still read only ID, hash and `zkb` values and fetch details from ESI, which keeps the `killmail#<id>` cache shared with `get_killmails`.
- `zkill_stats` reads `/api/stats/<kind>ID/<id>/kills/` (the bare path redirects, which would be a second request) and caches only numbers and IDs (`zkill#stats:<kind>:<id>`, 1 h). Names in top lists are resolved from IDs by ESI, never taken from zKillboard text.
  Efficiency = ISK destroyed / (destroyed + lost). Busiest hours and weekdays are sums of zKillboard's `activity` grid (UTC).
- `killmail_detail` builds the victim's fit as EFT with `toEft` (`src/mcp/tools/eft.ts`). ESI killmails use numeric flags: 11-18 low, 19-26 mid, 27-34 high, 92-94 rig, 125-128 subsystem, 87 drone bay, 158 fighter bay, 5 cargo (source: esi/eve-glue `location_flag.py`); other flags (implants 89, other holds) are left out. A charge shares its module's flag and prints as `Module, Charge`. It is the loss fit as recorded and may miss destroyed charges.
- Prompt `pilot_check(name)`: `zkill_stats` plus recent `zkill_kills` (kills and losses) into a threat summary.
- Region scope (`sovereignty`, `faction_warfare`) needs the region's systems: one ESI call per constellation, cached by ESI.
  // shortcut: replace with the SDE tables once they exist.

### Static data (SDE) (`src/sde/`, `src/mcp/tools/sde.ts`)

- Source: CCP's Static Data Export, JSONL build (about 100 MB zip, 580 MB unpacked, all languages). `GET https://developers.eveonline.com/static-data/tranquility/latest.jsonl`
  (79 bytes, `{"buildNumber": N}`) tells the current build; the zip is `.../eve-online-static-data-<N>-jsonl.zip`. The host is fixed in code, redirects off it are refused, the download has a 10 minute timeout and a 400 MB cap.
- Import (`src/sde/import.ts`, `bun run sde:import`): downloads the zip to a temp dir, then streams each file out of it with the `unzip` binary (`unzip -p`, one line = one JSON object, nothing held whole in memory;
  the image installs `unzip` in the Containerfile because Bun has no unzip). Only English text and published types are kept. All tables are rebuilt as `<table>_new` and swapped in
  (`drop` + `rename`) at the end of ONE transaction with the build number in `sde_meta`, so a failed import changes nothing and readers see old or new data, never half.
  Runs under `pg_try_advisory_lock(727003)`: one replica imports, the others skip.
- Refresh: the app starts `startSdeRefresh()` in the background: import when `sde_meta` is empty, then once a day compare `latest.jsonl` with the stored build and re-import on a change.
  Failures are logged and retried the next day. The app serves requests while it imports.
- Files used: `types`, `groups`, `categories`, `marketGroups`, `typeDogma`, `dogmaAttributes`, `dogmaUnits`, `blueprints`, `certificates`, `masteries`, `_sde` (build).
- Tables (migration 0003): `sde_meta`, `sde_types`, `sde_groups`, `sde_categories`, `sde_market_groups`, `sde_dogma_attributes`, `sde_units`, `sde_type_attributes` (type, attribute, value; published types only),
  `sde_blueprints`, `sde_blueprint_activities` / `_materials` / `_products` / `_skills` (per activity), `sde_certificates`, `sde_masteries` (ship, level 1-5, certificate).
  A full 2026 build is about 27,500 types, 187,000 attribute rows, 37 MB in Postgres, and imports in under 10 seconds on the dev box (download included).
- Skills: required skills are dogma attributes 182-184, 1285, 1289, 1290 with levels 277-279, 1286-1288; rank is 275; primary and secondary attribute are 180 and 181 (IDs 164-168 =
  charisma, intelligence, memory, perception, willpower). SP to reach level L is `ceil(250 * rank * 32^((L-1)/2))` (cumulative), training speed is `primary + secondary / 2` SP per minute,
  with the attributes from ESI `/characters/{id}/attributes`. The plan ignores the skill queue, implants and boosters beyond what ESI reports.
- `get_type_info` uses the SDE once loaded and falls back to the old ESI lookup until then; the other SDE tools answer `sde_not_loaded` (503) until the first import is done.
- `blueprint_info` ME rule: `max(runs, ceil(round(base * runs * (1 - ME/100), 2)))` per job (EVE University wiki confirms per-job rounding and the minimum of one per run; the 2-decimal rounding is the community-documented form).
  Structure and rig bonuses are not applied.
- Names are resolved exactly (any case), then by a unique substring; otherwise the error lists up to 6 candidates. SDE descriptions are CCP text but are still capped (stored 1000, returned 600 characters) and returned as data fields.

### CCP news and SDE changes (`src/news/client.ts`, `src/sde/changes.ts`, `src/mcp/tools/news.ts`)

- `ccp_news`: `GET https://www.eveonline.com/rss` (RSS 2.0, about 95 KB, 8 items: title, link, `pubDate`, `category`, and the whole article as escaped HTML in `description`).
  Parsed with a small regex (no dependency), HTML stripped, title 200 / description 300 characters, links must start with `https://www.eveonline.com/`. Cache: `esi_cache` key `news#rss`, 1 h.
  `keyword` matches title, category (hyphens as spaces, so "patch notes" finds `patch-notes`) and the short description. Timeout 10 s, no redirects, 2 MB cap.
- `sde_changes`: `GET https://developers.eveonline.com/static-data/tranquility/changes/<build>.jsonl` (same fixed CCP host as the SDE import). Lines: `_meta` (`buildNumber`, `lastBuildNumber`, `releaseDate`),
  then one line per data file with `added`, `removed`, `changed`, `changedLocalization` (ID lists) or `schemaChanged`. Default build is the one in `sde_meta` (else CCP `latest.jsonl`).
  We keep per-file counts and, for `types` (and `typeDogma` changes), the IDs (500 max each); the tool names up to 25 per list from `sde_types`. Cache: `esi_cache` key `sde#changes:<build>`, 24 h
  (a published build never changes). Unknown build: 404 `not_found`. Fetch is injectable (`setNewsFetch`, `setChangesFetch`) for tests.

### EVE University wiki (`src/wiki/client.ts`, `src/mcp/tools/wiki.ts`)

- `https://wiki.eveuniversity.org/api.php` (MediaWiki 1.43, `format=json&formatversion=2&maxlag=5`). Search is `generator=search&redirects=1` with intro extracts (a redirect hit shows its target page, `redirected_from` lists the old titles);
  a page is one `prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1` call, split into sections on the
  `== Heading ==` lines (a section includes its subsections, headings match case-insensitively). `wiki_page` without
  `section` returns the page start capped at 12,000 characters plus the heading list; with `section` only that section.
- Cache: the shared `esi_cache` table, keys `wiki#search:<limit>:<query>` and `wiki#page:<title>`, 24 h; missing pages 1 h.
  The keys never end in `#<characterId>`, so the character purge does not touch them. Timeout 10 s, `User-Agent:
  eve-mcp/<version> (+<PUBLIC_URL>; <ESI_CONTACT>)`, one retry on 5xx or maxlag. Fetch is injectable (`setWikiFetch`) for tests.
- Every result carries `source: "EVE University Wiki"`, `license: "CC BY-SA 4.0"` and the page `url`; the tool descriptions
  ask the LLM to cite the url. Wiki text is user-editable: plain text only (HTML stripped), capped, a data field, never in descriptions.

## ESI client (`src/esi/`)

- Base `https://esi.evetech.net`. Headers on every call: `User-Agent: eve-mcp/<version> (<ESI_CONTACT>)`,
  `X-Compatibility-Date: <ESI_COMPAT_DATE>`, `Accept: application/json`. Default `ESI_COMPAT_DATE` is 2026-08-18. Breaking changes since 2025-08-26 that we handle: `GET /route` became `POST /route` (2025-09-30); `/sovereignty/map` and `/sovereignty/structures` were replaced by `/sovereignty/systems` (2026-05-19); `/characters/{id}` renamed `title` to `corporation_title` (2026-06-09, unused by us). Raise the date only after diffing `https://esi.evetech.net/meta/openapi.json` (send `X-Compatibility-Date`) for the routes in `src/`. Public routes for sov hubs, dens and MTOs do not exist (they need corporation or character tokens), so only `/skyhooks/raidable` is exposed.
- **Cache:** `esi_cache` table (`UNLOGGED`, shared by all replicas) keyed by method + path +
  query + character. Store body, `ETag`, `Expires`. Serve from cache until `Expires`; then send
  `If-None-Match`. Public data is shared across users; authed data is keyed per character.
- **Error limit (legacy, global):** read `X-ESI-Error-Limit-Remain` / `-Reset`. Below 20 remaining, refuse new
  calls until reset with a clear tool error. The budget is per source IP, so all replicas share it: the last seen
  values go in the `esi_status` row, not only in memory. Within one reset window the stored `remain` only goes down (replies can arrive out of order).
  HTTP `420` (the legacy error limit hit) and a `429` on a route without `X-Ratelimit-Group` both wait for `Retry-After`, else `X-ESI-Error-Limit-Reset`, else 60 s (clamped 1 to 3600 s), record `remain = 0` in `esi_status` so every replica pauses, and throw `esi_rate_limited`.
- **Rate-limit buckets (per route group):** ESI also limits per route group, per app and character (token buckets; headers `X-Ratelimit-Group`, `-Limit` like `150/15m`, `-Remaining`, `-Used`; docs: developers.eveonline.com/docs/services/esi/rate-limiting/). A `429` on a grouped route pauses only that bucket, `<group>#<character_id>` or `<group>#public`, until `Retry-After`; other characters, groups and public calls keep working and `esi_status` is not touched. Before a call (after the cache check) the client refuses with `esi_rate_limited` and the wait in the message, without calling ESI, if that bucket is paused or its last seen `remaining` is below 5% of the limit and its window (the period in `-Limit`) is still open. State is table `esi_buckets` (`UNLOGGED`, shared by replicas). How the group is known before the call: ESI names it only in the response, so every grouped response stores a route row `route:<METHOD> <path with numeric segments as {id}>` -> group; the next call joins that row to the bucket row in one query. A route never seen has no row and goes through once. Writes stay low: a route row only when the mapping is new or changed (a per-process map avoids repeats), a bucket row only on a 429 or when remaining is low. Within a window the stored remaining only goes down. A route without `X-Ratelimit-Group` keeps the legacy global behaviour. Bucket rows unused for a day are pruned; route rows stay (few, and replicas do not rewrite them). Shortcut: the low-remaining refusal lasts until the window ends, although the bucket refills gradually.
- **404s:** a 404 on a public (non-authed) GET is cached for 1 hour as a `{notFound}` marker and answered as `esi_not_found` without a request (404s count against the error budget). Authed 404s are not cached.
- **Paging:** follow `X-Pages` up to a cap (assets can be big), then summarise.
- **Tokens:** the access token is stored encrypted in `characters` with its expiry, so every
  replica can use it. On expiry, refresh inside a transaction that holds
  `pg_advisory_xact_lock(character_id)`, re-read the row (another replica may have refreshed
  already), call `POST https://login.eveonline.com/v2/oauth/token`, store the new access token
  and the (possibly new) refresh token encrypted. The lock matters: two replicas refreshing at
  once could burn a rotated refresh token. The wait for the lock is bounded by `set local lock_timeout = '15s'`; on timeout the tool says "token refresh busy, try again" (`token_refresh_busy`, 503). `invalid_grant` marks the character `needs_reauth`
  and tools say "re-link this character at <PUBLIC_URL>/characters". If the refreshed owner hash
  differs, the character is unlinked (`owner_changed`) and the call refused (`src/esi/token.ts`).
- **Scopes:** `charGet` / `charGetAll` (`src/esi/character.ts`) check the character's stored scopes
  first and name the missing scope in the error. `character_overview` lists such parts under
  `unavailable` instead of failing.
- **Names:** `src/esi/names.ts` resolves IDs with `POST /universe/names` (1 day cache in
  `esi_cache`, read and written in one query each; batches with unknown IDs are split and the unresolvable IDs are cached as unknown for a day; at most 500 IDs per call, the rest show as `#id`), and names to IDs with `POST /universe/ids`.
- Paging cap is 10 pages (`esiGetAll`); tools report when the list is incomplete. Request timeout 15 s.
- EVE access tokens are JWTs: verify signature with EVE's JWKS (`jose`), `iss`, `aud` (our client
  ID and `"EVE Online"`), `exp`. `sub` is `CHARACTER:EVE:<id>`.

## Web pages (`src/web/`)

Server-rendered Hono JSX, no SPA, no client JS needed. Design system: tokens (light and dark via `prefers-color-scheme`), components and layout all live in `src/web/app.css` (system fonts, inline SVG mark, no JS, no inline styles, so the CSP stays `'self'`). The stylesheet is linked as `/static/app.css?v=<10-char content hash>` and served `immutable` for a year, so a deploy busts Cloudflare's cache. Pages:

- `/` landing + "Sign in with EVE Online".
- `/characters` list, add, re-link, remove. Every row has "Re-link": it runs the add-character SSO flow, and when the callback returns a character already on the same user it updates tokens, scopes and `needs_reauth=false` in place (no delete, so `grant_characters` stays). A character on another user is refused (409); a changed owner hash unlinks it first (hard rule 7). Remove deletes the row, so it also removes the character from every connected app, and also revokes EVE tokens via SSO revoke). Each row shows the 64 px portrait from `images.evetech.net` (the CSP allows only that host for images); the consent page does the same.
- `/features` (public; `/sources` redirects here) "What's available", server-side tabs as plain links (`?tab=systems|tools|prompts|examples`, zod-validated, unknown values fall back to `systems`; `aria-current="page"` on the active one; no JS). `systems` (default, highlighted): status strip (SDE build, ESI error budget; DB only, no outbound call on page load) over the source cards. `tools`: one panel per category. `prompts`, `examples`. Generated from the real registries: `src/features.ts` (category + summary per tool, pinned to the registered tools by a test; prompts from `src/mcp/prompts.ts`) and `src/sources.ts` (the single list of external systems, pinned by a test). When a tool is added, add its `toolInfo` entry; when a new external system is called, add it to `src/sources.ts` and the fixed host list in docs/SECURITY.md.
- `/robots.txt`, `/sitemap.xml`, `/llms.txt` (public, no DB, no outbound call, built from `PUBLIC_URL`, `Cache-Control: public, max-age=3600`): robots disallows the private areas and points to the sitemap; the sitemap lists `/`, `/connect`, `/features`, `/privacy`; `llms.txt` is the llms.txt-convention summary (endpoint, connect steps, tool list generated from `src/features.ts`, links, CCP notice). When a page becomes public or private, update `PUBLIC_PAGES` and the robots list in `src/web/routes.tsx`.
- `/.well-known/security.txt` (RFC 9116, public, no DB): contact is the repo's private security advisory form, `Expires` is 180 days from the request, plus `Canonical` from `PUBLIC_URL` and a `Policy` link to docs/SECURITY.md. No email address. It is served by `src/web/routes.tsx`, so the shared page rate limit applies; the OAuth `/.well-known/*` routes are separate exact paths.
- Trust parts: `SCOPE_INFO` in `src/esi/scopes.ts` gives each EVE scope a plain name and reason (a test pins its keys to `EVE_SCOPES`). The `ScopeDetails` component (`src/web/ui.tsx`) renders it as a `<details>` block on the signed-out home page, on `/characters` and open on `/privacy`, so people see what EVE's consent page will ask before they go there. The home page also links the source and the README self-hosting section, `/privacy` links CCP's Authorized Apps page and docs/SECURITY.md, `/characters` links the Authorized Apps page. The footer shows the running commit (see Deployment).
- `/favicon.svg`, `/favicon.ico`: our own ring mark in the accent colour (`src/web/static/`), served with `Cache-Control: public, max-age=2592000` and linked in the layout `<head>`. The ico holds 16, 32 and 48 px renders of the SVG (`rsvg-convert` each size, then `magick` to combine); regenerate it when the SVG changes.
- `/connect` how to add the server URL to Claude, ChatGPT, etc.
- `/apps` connected MCP clients (grants): name, characters, access ("read only" or "can write fittings"), last used, manage (change characters and the fitting-write box, `/apps/:id`), revoke.
- `/account`: a short Privacy panel and delete account (deletes everything, revokes all tokens).
- `/privacy` (public, linked from the footer): plain-English list of what we store, how long (numbers come from `src/db/prune.ts`, `src/auth/session.ts`, `src/oauth/routes.tsx`), no usage tracking, analytics or ads, and what delete does. Keep it in step with the code; audit rows go with the account; `client_registered` rows (app name and registering IP) are pruned after 90 days.
- `/admin/users` admin only: user table (id, characters, created, status pill, admin badge, fixed actions column; cards on phones) with disable/enable; `GET /admin/users/:id/delete` is a no-JS confirm page (refuses self and admins) and `POST /admin/users/:id/delete` (needs `confirm=yes`; refuses self and admins; same `deleteUser` as `/account/delete`; the `user_deleted` audit row is written under the admin's id because audit rows cascade with the deleted user). CSRF checks are the global ones in `src/index.ts`.

UI conventions (shared parts in `src/web/ui.tsx`, styles in `app.css`; pages use them instead of hand-written markup):

- Buttons: `primary` (filled, the one main action), `secondary` (default, quiet), `danger` (red, always for destructive actions), `link` (Cancel, Log out). One size; `small` only inside table rows.
- Placement: the page's primary action sits top-right in `PageHeader` (title and subtitle left). A form's submit sits bottom-left in `ActionRow` with Cancel next to it. Per-row actions go in `RowActions`: two fixed right-aligned slots, safe action first, danger last. Destructive actions are red and, for account and user deletion, go through a confirm step.
- One box: `Panel` (tones accent, warn, danger; fieldsets and `Notice` use it). One list style: the `table-wrap` table (characters, apps, users), which stacks into blocks on phones using `data-label`.
- Spacing comes from tokens `--s1`..`--s6`; `main` is a column of blocks with one gap. The nav and the features tabs are the same control and wrap on phones.

The shared footer (`layout.tsx`) shows the CCP notice (`CCP_NOTICE` in `src/sources.ts`, the exact text from EVE Developer License §7.1), a link to `/privacy`, a "Source" link to the GitHub repository (AGPL §13), and a small "Buy me a coffee" button (our own CSS, plain outbound link, no Ko-fi script or image) to ko-fi.com/pamera, also shown in the `/features` header. It is voluntary, only offsets hosting costs and unlocks nothing: no feature, limit or priority depends on donating (EVE Developer License §4.4b). It is a normal outbound link, not a call we make.

Licence: the code is AGPL-3.0-or-later (`LICENSE`, `package.json`, README "License"). EVE data, names and images are CCP's and not covered; wiki text is CC BY-SA 4.0 (the wiki tools return `license_url` and tell the LLM to keep the page URL when citing).

Static files: `/static/app.css` (hashed, immutable) and the favicons above (`src/web/static/`, 30 days); everything else is `Cache-Control: no-store`. Strict CSP, no inline script or style.

Sessions: random 32-byte ID in cookie `__Host-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`),
SHA-256 in `sessions` table, 30 days sliding. CSRF: Hono `csrf()` origin check on every POST, a `Sec-Fetch-Site`/`Origin` header check on every non-safe request (except `/mcp` and the token, register, revoke endpoints), plus
`SameSite=Lax`.

Key rotation detail: ciphertext byte 0 is the key ID (1 = `TOKEN_ENC_KEY`, 0 = `TOKEN_ENC_KEY_OLD`). After a
rotation, old rows still say 1, so `decrypt` tries the named key and then the other one.

## Data model (`src/db/migrations/*.sql`)

Postgres 17 through `Bun.sql` (built into Bun, no driver dependency). IDs are `bigint` (EVE IDs
do not fit in `int`), times are `timestamptz`, lists are `text[]`, blobs are `bytea`.

Migrations: plain numbered SQL files, applied by `src/db/migrate.ts` in one transaction each,
tracked in `schema_migrations`. The app runs them at startup while holding
`pg_advisory_lock(<constant>)`, so two replicas starting together never race.

| Table | Key columns |
|---|---|
| `users` | `id`, `created_at`, `disabled_at`, `is_admin` |
| `characters` | `character_id` (PK, EVE ID), `user_id`, `name`, `owner_hash`, `scopes`, `refresh_token_enc`, `access_token_enc`, `access_expires_at`, `needs_reauth`, `linked_at` |
| `sessions` | `id_hash`, `user_id`, `expires_at` |
| `sso_states` | `state`, `purpose` (`login`/`add`/`oauth`), `user_id?`, `return_to`, `expires_at` |
| `oauth_clients` | `client_id`, `name`, `redirect_uris`, `created_at` |
| `oauth_codes` | `code_hash`, `client_id`, `grant_id`, `redirect_uri`, `code_challenge`, `resource`, `expires_at`, `used_at` |
| `grants` | `id`, `user_id`, `client_id`, `all_characters`, `allow_write` (default false, migration 0002), `created_at`, `last_used_at`, `revoked_at` |
| `grant_characters` | `grant_id`, `character_id` |
| `oauth_tokens` | `token_hash`, `kind` (`access`/`refresh`), `grant_id`, `resource`, `expires_at`, `revoked_at`, `replaced_by` |
| `esi_cache` (`UNLOGGED`) | `key`, `etag`, `expires_at`, `body` (`jsonb`) |
| `esi_status` | single row: `error_limit_remain`, `error_limit_reset_at` |
| `esi_buckets` (`UNLOGGED`) | per route group limits: bucket `<group>#<character_id or public>` (`remaining`, `lim`, `reset_at`, `paused_until`) and route rows `route:<METHOD> <template>` (`grp`). Migration `0006_esi_buckets.sql` |
| `audit_log` | `id`, `at`, `user_id`, `event`, `detail` (no secrets) |
| `sde_*` (migration 0003) | CCP static data, see "Static data (SDE)"; replaced as a whole by the importer, never written by tools |

User and grant IDs are `int`; EVE IDs are `bigint`. `Bun.sql` returns `bigint` columns as strings, so wrap
them in `Number()` (EVE IDs fit in a double). `ON DELETE CASCADE` from `users`. Expired rows are pruned every hour (`esi_cache` rows only once expired for more than 1 day, so ETag revalidation still works; `oauth_clients` with no grants after 7 days) by a `setInterval` in each
replica; it runs only when `pg_try_advisory_lock` succeeds, so one replica does the work (no cron).

## Layout

```
src/
  index.ts          Bun.serve + Hono app wiring
  config.ts         env parsing (zod), fails fast
  crypto.ts         AES-GCM encrypt/decrypt, random tokens, sha256
  errors.ts         AppError
  log.ts            JSON line logger, redaction, request logger middleware
  types.ts          AppEnv (Hono context variables), used by every router
  sde/              import.ts (download, stream, swap, daily refresh), skills.ts (SP math, prerequisite trees), query.ts (type lookup, skill nodes)
  db/               db.ts (Bun.sql client), migrate.ts, prune.ts (hourly cleanup), migrations/*.sql, queries per table
  auth/             routes.tsx (/auth/login, /auth/eve/callback, /auth/logout), eve-sso.ts (authorize URL, token exchange/refresh/revoke, JWT verify),
                    characters.ts (unlinkCharacter), session.ts
  oauth/            routes.tsx (metadata, register, authorize, token, revoke, /apps), clients.ts (redirect rules, CIMD fetch + SSRF guard), grants.ts (audit, revokeGrant), pages.tsx, bearer.ts (mcpAuth)
  mcp/              routes.ts (handleMcp, /mcp route), server.ts (builds McpServer per grant), instructions.ts, prompts.ts, tools/ (index.ts, util.ts, character.ts, character-more.ts, market.ts, universe.ts, fittings.ts, eft.ts), grant.ts (Grant, requireCharacter)
  esi/              client.ts (calls, guard, paging), cache.ts, token.ts (accessToken, refresh), character.ts (scope check + authed calls), scopes.ts, names.ts (ID -> name, cached)
  sources.ts, features.ts  single lists behind /features and about_sources (external systems; tool categories and summaries)
  web/              routes.tsx, pages.tsx (message page), layout.tsx, ui.tsx (Button, PageHeader, Panel, Notice, ActionRow, RowActions, Empty), app.css (served at /static/app.css, so the CSP needs no inline style), static/ (favicon.svg, favicon.ico)
  ratelimit.ts      in-memory token bucket (per replica), clientIp()
test/               bun test against a real Postgres, fake fetch for ESI and SSO
  setup.ts          preload (bunfig.toml): fake env so tests need no .env
  helpers/db.ts     per-file schema from TEST_DATABASE_URL (setup.ts also uses it as DATABASE_URL; `.env.test` is loaded by bun test); DB tests skip if Postgres is down
Containerfile       app image
docker-compose.yml  production stack: app, postgres, backup
docker-compose-dev.yml  local Postgres only
```

## Config (env)

See `.env.example`. Required: `PUBLIC_URL`, `DATABASE_URL` (or `POSTGRES_HOST` +
`POSTGRES_PASSWORD_FILE`), `EVE_CLIENT_ID`, `EVE_CLIENT_SECRET`, `TOKEN_ENC_KEY` (32 bytes
base64), `ESI_CONTACT`. Optional: `PORT` (3000), `ESI_COMPAT_DATE`, `ADMIN_CHARACTER_IDS`,
`ALLOWED_ORIGINS`, `CLIENT_IP_HEADER` (header with the real client IP, e.g. `CF-Connecting-IP`; empty = socket address; see Deployment).

Also: `DB_POOL_MAX` (Postgres pool size, default 20), `TEST_DATABASE_URL` (tests), `DEV_GRANT_TOKEN` and `DEV_USER_ID` (dev only, the user the dev bearer acts as, default 1; startup fails if `DEV_GRANT_TOKEN` is set with an https `PUBLIC_URL`). The database URL can be built from
`POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD[_FILE]` (password is URL-encoded).

Every secret can also come from a file: `X_FILE=/run/secrets/x` wins over `X` (`config.ts` reads
it). That is how the Compose secret files reach the app.

The EVE app (developers.eveonline.com) callback URL is `${PUBLIC_URL}/auth/eve/callback`. One
callback serves login, add character and OAuth consent; `sso_states.purpose` tells them apart.

## Deployment (Docker Compose on a NAS)

`docker compose up -d --build` in the repo folder. Settings come from `.env` next to
`docker-compose.yml` (`PUBLIC_URL`, `EVE_CLIENT_ID`, `ESI_CONTACT`, `ADMIN_CHARACTER_IDS`,
`CLIENT_IP_HEADER`, `APP_PORT`, `IMAGE`, `IMAGE_TAG`; see `.env.example`).

| Service | Image | Notes |
|---|---|---|
| `app` | `${IMAGE:-eve-mcp}:${IMAGE_TAG:-latest}`, built from `Containerfile` (`oven/bun`, non-root) | Publishes host port `${APP_PORT:-38080}` -> container 3000. Waits for a healthy `postgres`. Runs migrations at start under an advisory lock. `restart: unless-stopped`. |
| `postgres` | `postgres:17-alpine` | Volume `pg_data`. Not published to the host. Healthcheck `pg_isready`. |
| `backup` | `postgres:17-alpine` | Loop: `pg_dump -Fc` every 6 h into `./backups`, keeps 28 files. |

- **Replicas:** Compose runs 1 app replica. The code is still safe with several (advisory locks,
  shared state in Postgres), but `docker compose up -d --scale app=2` is not used: the fixed host
  port allows only one container.
- **Secrets:** files in `./secrets/` (`postgres_password`, `eve_client_secret`, `token_enc_key`),
  `chmod 600`, git-ignored. Compose mounts them at `/run/secrets/*`; the app reads them through the `*_FILE` env vars.
- **TLS and HSTS:** done by your reverse proxy and Cloudflare, not by the app. The proxy
  forwards to `<nas>:${APP_PORT}`. The app port must be reachable only from the proxy (NAS firewall,
  or bind it to the proxy's network).
- **Client IP:** the rate limits need the real client IP. Set `CLIENT_IP_HEADER` to the header
  your proxy or Cloudflare provides (`CF-Connecting-IP`, or `X-Real-IP` if the proxy sets it).
  Empty means the socket address (the proxy's IP). Only set it when the app port is reachable only
  through the proxy, and the proxy overwrites that header: otherwise any client can spoof it.
- **Body size:** the app caps every request body at 1 MB (`bodyLimit`); `/mcp` at 256 KB.
- **Rate limits:** per IP on `/auth/*` and `/oauth/*` (per route), on `/mcp` (300/min per IP, then 120/min per grant), and one shared 120/min per IP on everything else (pages, forms, `/.well-known/*`, `index.ts`). `/health` has none. All are in-memory per replica (`src/ratelimit.ts`).
- **Static data (SDE):** the first start imports CCP's static data in the background (under 1 minute on a fast link; needs about 100 MB of temp space in the container's `/tmp` and 40 MB of Postgres). Until it is done `get_type_info` uses ESI and the other SDE tools say it is still loading. Force an import with `docker compose -p eve-mcp exec app bun run sde:import`. The image needs the `unzip` package (Containerfile installs it); the app container needs outbound HTTPS to `developers.eveonline.com`.
- **Health:** `GET /health` checks Postgres with `select 1`, no ESI call.
- **Cloudflare in front:** DNS record proxied (orange cloud). The SSL mode must match what your
  proxy serves (use "Full (strict)" with a valid cert).
- **Cloudflare settings that matter for MCP:**
  - Bot Fight Mode and "Block AI bots" block MCP clients and OAuth token calls (no browser).
    Turn them off, or add a WAF skip rule for `/mcp`, `/oauth/*` and `/.well-known/*`.
  - Proxied requests time out after 100 s without a byte (error 524). Tools must answer well
    inside that; an SSE stream must send a keep-alive comment at least every 30 s.
  - Do not cache anything: add a Cache Rule "bypass" for the whole host. The app sends
    `Cache-Control: no-store` on every authed response anyway.
  - Cloudflare rate limiting rules on `/oauth/*` and `/auth/*` are a cheap extra layer on top of
    the per-replica limits.
- **Backups:** `./backups` is on the NAS disk; copy it off the NAS too.
- **Restore:** `docker compose exec backup sh -c 'PGPASSWORD=$(cat /run/secrets/postgres_password) pg_restore --clean --if-exists -d eve_mcp /backups/<file>'`
  (stop `app` first for a full restore: `docker compose stop app`).
- **Scaling limits:** rate limits and the in-memory part of the ESI client are per replica
  (`shortcut:` limits are N times looser with N replicas; move them to Postgres or Redis if abuse
  shows up). Postgres is a single instance; managed Postgres is the upgrade path.

`scripts/deploy.sh` is an optional helper: it ships the committed `HEAD` (`git archive` over ssh) to `~/eve-mcp` on a Docker host, runs `docker compose -p eve-mcp up -d --build` there and polls `${DEPLOY_URL}/health`. It needs `DEPLOY_HOST` (ssh host) and `DEPLOY_URL` from the environment or from a git-ignored `.deploy.env` in the repo root, and fails if either is missing. No host or address is stored in the repo. The footer shows the deployed commit: `src/version.txt` holds `$Format:%H$` and `.gitattributes` marks it `export-subst`, so `git archive` writes the real commit hash into it. Anything that still holds `$Format` (local dev, tests) shows "dev" without a link.

Local dev: `bun run db:up` starts Postgres from `docker-compose-dev.yml` on `localhost:5432`, then
`bun run dev`.
