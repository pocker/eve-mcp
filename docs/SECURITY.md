# Security

The server is on the public internet and holds long-lived EVE refresh tokens for many people.
A leak means a stranger can read someone's assets, wallet and location. This file lists what we
protect, from whom, and how. Update it with every change to auth or exposed surface.

## Assets

1. EVE refresh tokens (high: long-lived access to a player's data).
2. Our OAuth access/refresh tokens and session cookies (high: same access through us).
3. Player data in the ESI cache (medium: location and assets are sensitive in EVE).
4. Service availability and our ESI error budget (medium: if we get banned by CCP, everyone loses).

## Threats and controls

| Threat | Control |
|---|---|
| User A reads user B's characters | `requireCharacter(grant, id)` in every character tool; cache keys include the character; a cross-user test per tool. |
| DB or backup stolen | EVE refresh and access tokens AES-256-GCM encrypted with `TOKEN_ENC_KEY` (a secret file, never in the DB or backups). Our tokens/sessions/codes stored as SHA-256 only. Postgres not published to the host. |
| SQL injection | Only `Bun.sql` tagged templates (parameterised). No string-built SQL. |
| Secrets in the image or env dump | Secrets come from files in `./secrets` (`chmod 600`, git-ignored) via `*_FILE`, never baked into the image or written in `docker-compose.yml`. |
| Key rotation | Ciphertext starts with a key ID byte; `TOKEN_ENC_KEY_OLD` decrypts, re-encrypt on next refresh. |
| Character sold to another player | `owner` hash check on every SSO callback and token refresh; mismatch unlinks, deletes tokens, revokes grants. |
| Stolen MCP access token | 1 h lifetime, audience-bound to `/mcp`, revocable on `/apps`. |
| Stolen refresh token | Rotation on every use; reuse of an old one revokes the grant. |
| Malicious MCP client registration | DCR rate limited per IP (5/min bucket, per replica); redirect URIs must be `https://` or loopback `http://` (`127.0.0.1`, `localhost`, `[::1]`); exact match at authorize; consent page leads with the redirect host in bold; DCR apps are labelled "Unverified app" with the name shown in quotes as "calls itself"; URL (CIMD) clients show the `client_id` host as the identity. Names are escaped, never blocked. Warning for localhost. Clients with no grant are pruned after 7 days. |
| Authorization code interception | PKCE `S256` required, codes single-use (reuse revokes the grant), 60 s lifetime, bound to client + redirect URI + resource; `iss` in the response (RFC 9207). |
| CSRF on pages / consent | Hono `csrf()` origin check, plus a header check on every non-GET/HEAD/OPTIONS request except `/mcp` and `/oauth/{token,register,revoke}`: 403 when `Sec-Fetch-Site` is present and not `same-origin`/`none`, or `Origin` is present and not `PUBLIC_URL`'s origin (covers POSTs with no form content type). `SameSite=Lax` cookie, consent requires a POST. |
| SSO login CSRF / mix-up | `state` random, single-use, 10 min, stored server side with purpose, and bound to the browser by a `__Host-sso` cookie (HttpOnly, Secure, Lax, 10 min) that must equal `state` (timing-safe) at the callback; it is deleted there. EVE JWTs must be RS256/ES256. EVE SSO calls have a 10 s timeout (502 `eve_unavailable`). |
| Stale admin flag | Admin is derived on every request: any linked character in `ADMIN_CHARACTER_IDS`. `users.is_admin` is never read. |
| Data kept after unlink / account delete | Unlinking a character or deleting the account deletes that character's authed `esi_cache` rows. |
| Dev bearer in production | Startup fails when `DEV_GRANT_TOKEN` is set and `PUBLIC_URL` is https. |
| OAuth code / refresh abuse | A reused code revokes the grant only when the client id matches and the PKCE verifier is right. A successful refresh revokes the grant's other live access tokens. |
| Clickjacking of consent | `frame-ancestors 'none'` + `X-Frame-Options: DENY`. |
| Referrer leakage / form POSTs | `Referrer-Policy: same-origin`: no referrer cross-site, and browsers send the real `Origin` on same-origin form POSTs. `no-referrer` makes them send `Origin: null`, which the CSRF checks (correctly) refuse and which would break every form. |
| XSS | JSX auto-escaping, strict CSP (`default-src 'self'`, no inline script). |
| DNS rebinding on `/mcp` | `Origin` checked against `ALLOWED_ORIGINS` when present. |
| SSRF via client metadata URL | HTTPS only, no port but 443, all resolved IPs must be public (rejects 0/8, `::/8` incl. IPv4-compatible and every `::ffff:` form, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`, `fc00::/7`, `fe80::/10`, `ff00::/8`, and the IPv4 private, loopback, link-local, CGNAT, documentation, multicast and reserved ranges), 5 s timeout, 64 KB cap, no redirects, document `client_id` must equal the URL, and the client must be able to use auth method `none` (we never check client secrets or signed keys, so other listed methods are ignored). Residual: fetch resolves DNS again after our check (rebinding race; Bun `fetch` cannot pin the resolved IP and a custom connector would need a dependency); the body is only parsed as JSON and never echoed. |
| Prompt injection via ESI text | Free text is returned as a field, capped in length, never merged into tool descriptions. The only write tools are fittings (see below), so injection can at worst create or delete fittings. |
| SDE import (CCP static data) | Fixed host `developers.eveonline.com` (build number from `latest.jsonl`, zip URL built from that integer; redirects off the host refused; 10 min timeout; 400 MB cap). The zip is never extracted to disk: `unzip -p` streams only named files, parsed line by line, English only. The import is one transaction with an advisory lock, so a bad or partial file changes nothing. SDE descriptions are capped (stored 1000, returned 600 characters) and returned as data fields; the SDE tools take no URL or path. |
| Prompt injection via EVE University wiki text | Wiki pages are user-editable. `wiki_search` / `wiki_page` return plain text (HTML stripped) as a data field with a source and license note, capped (snippet 300, page 12,000 characters), never merged into tool descriptions. Same residual as ESI text; see the write-tool rows below. |
| Outbound requests to user-chosen hosts (SSRF) | Tools only call fixed hosts: `esi.evetech.net`, `login.eveonline.com`, `wiki.eveuniversity.org`, `zkillboard.com`, `www.eveonline.com` (news RSS), `api.eve-scout.com`, plus `developers.eveonline.com` (SDE). The list is in `src/sources.ts` (shown on public `/features`; reads only our DB, no outbound call). Tool input is only ever a query-string value or a page title, never a URL or host. (Client metadata fetch is the one exception, with its own row above.) |
| Prompt injection via universe intel | `system_info`, `route_safety`, `incursions`, `sovereignty`, `faction_warfare`, `zkill_stats`, `zkill_kills`, `killmail_detail` are public tools. They return names (from ESI `/universe/names`, capped at 100 characters) and numbers as data fields. zKillboard supplies only numbers, a kill ID and a hash; the hash must be 40 hex characters before it goes into an ESI URL. No zKillboard free text is passed on (`zkill_stats` resolves top-list names from IDs through ESI). |
| Prompt injection via EVE-Scout data | `thera_connections` returns system and region names (capped at 60 characters), wormhole type, ship size and expiry as data fields. Scanner names and IDs are dropped before caching; signature IDs must match `ABC-123`. One shared request per 5 minutes (`esi_cache` key `evescout#signatures`), 10 s timeout, failures cached 2 minutes; no parameters are sent. EVE-Scout publishes no terms or rate limits. |
| zKillboard abuse / being banned | zKillboard asks for a descriptive `User-Agent` (with contact) and gzip, caching and no bursts. One request per system per 10 minutes (shared `esi_cache`, key `zkill#sys:<id>:<hours>`), at most 1 zKillboard request per `system_info`, `zkill_stats`, `zkill_kills` and `killmail_detail`, 3 per `route_safety` (riskiest systems only, off unless `recent_kills`). Every request goes through one process-wide queue, 1 s apart even across concurrent calls, 10 s timeout. Caches: stats 1 h, kill lists and `killID` lookups 5 min, system lists 10 min. A 403/429/error is cached for 2 minutes (longer if `Retry-After` says so, max 10) and shown as an `error` field; the tool still answers what it can. ESI killmail fetches are capped at 10 per call, 4 at a time. The gap is per process, not per replica. |
| Prompt injection makes the LLM create or delete fittings | Write tools exist only for grants where the user ticked the separate, unticked-by-default consent box (`grants.allow_write`); they are absent from `tools/list` otherwise and refuse at call time. `delete_fitting` has `destructiveHint: true` so clients ask the user. Every write is in `audit_log`. No other write scope is requested. Fittings are low value and the user can re-create them. |
| Someone else changes a grant | `GET/POST /apps/:id` need the signed-in owner of a non-revoked grant (else 404, no hint it exists), zod-validated body, CSRF as every POST. Ticked characters must be the user's own; empty "only ticked" is refused. Grant row and `grant_characters` change in one transaction; `grant_updated` is audited. Turning on `allow_write` needs its own explicit checkbox with the consent warning. Changes apply at once because every MCP request reads the grant from the database. |
| Write abused through a stolen MCP token | Same 1 h lifetime and revocation as reads; the write permission is per grant, so revoking the app on `/apps` ends it. |
| Public static routes | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/favicon.ico`, `/favicon.svg` need no login, read no DB and call no outbound host. Their content is fixed text built from `PUBLIC_URL`, the tool list in `src/features.ts` and two files in `src/web/static/`; no user data or request input is echoed. The CSP `img-src 'self'` already covers the favicon. |
| Brute force / abuse | Per-IP rate limits on `/oauth/*`, `/auth/*`; per-IP rate limit on `/mcp` before auth (300/min); per-grant rate limit on `/mcp`; body size cap in the app (1 MB); Cloudflare rate limiting rules as an outer layer. |
| Spoofed client IP (dodging rate limits) | `CLIENT_IP_HEADER` is set only when the app port is reachable only through the reverse proxy, and the proxy overwrites that header. If the port is open to others, leave it empty (socket address is used). |
| Direct access to the app port | The app port is reachable only from the reverse proxy (NAS firewall, or bind it to the proxy's network). |
| Plain HTTP between proxy and app | The app speaks HTTP; TLS and HSTS are the reverse proxy's and Cloudflare's job. Keep the proxy and the NAS on a trusted network. |
| ESI ban (error limit) | Error-limit guard, cache, real `User-Agent` contact. HTTP `420` and ungrouped `429` pause all ESI calls on every replica (`esi_status`). Grouped `429` and nearly empty buckets (under 5% left) refuse only that group and character (`esi_buckets`, in Postgres), without calling ESI. |
| Secrets in logs | Logger redacts `authorization`, `cookie`, `code`, `token`, `refresh_token`, `client_secret`, `password` (any key containing token, secret, cookie, authorization, password; nested). Never log ESI bodies of authed calls. |
| Account takeover by admin bug | Admin can list, disable and delete users and see no usage data, never their ESI data, tool arguments or tokens. Delete refuses self and other admins, needs a confirm checkbox, goes through the global CSRF/origin checks, and is audit-logged (`user_deleted`, under the admin's id since the deleted user's audit rows cascade). |
| Data retention | Account delete removes all rows and calls SSO revoke for each character. Audit log keeps no tokens. |

## Rules for adding things

- A new ESI scope: read-only only, add to `src/esi/scopes.ts`, ARCHITECTURE.md tool table and
  here if it is sensitive (mail, contacts, location history).
- A write scope (anything that changes game state): not allowed without a human decision written
  here (see "Decisions"), plus per-grant opt-in, the destructive annotation, and an audit event.
- A new public endpoint: add a rate limit and a row in the threat table.

## Decisions

- **2026-11-15: licence and notices.** Code is AGPL-3.0-or-later (`LICENSE`), so users of the hosted service can get the source. The CCP notice from EVE Developer License §7.1 is in the footer, README and `CCP_NOTICE`. EVE data and images are not under our licence. Wiki text is CC BY-SA 4.0 and tools return the licence URL.
- **2026-11-15: privacy.** The public `/privacy` page and the `/account` panel list what we store and for how long. We keep no usage tracking, analytics or ads. Audit rows are deleted with the account, except `client_registered` rows (app name and registering IP, no account): pruned after 90 days. Other audit rows have no prune timer; add one if the log grows. Keep the page true when storage changes.

- **2026-11-15: write scope `esi-fittings.write_fittings.v1` is allowed.** The user explicitly asked for write access.
  This is the first and only write scope. Controls: (1) separate opt-in per grant at consent, off by default
  (`grants.allow_write`), shown on `/apps`; (2) write tools are not registered for grants without it, and re-check at call time;
  (3) `create_fitting` is `destructiveHint: false`, `delete_fitting` is `destructiveHint: true`, descriptions say they change
  in-game data; (4) writes are never cached or retried, and audited (`fitting_created`, `fitting_deleted`: user, character,
  fitting, grant; never the EFT text); (5) the scope is limited to fittings: no other write scope may be added without a new
  entry here. ESI has no skill queue write endpoint, so that is not possible at all.

- **2026-11-15: read scopes added for Phase 4:** `esi-contracts.read_character_contracts.v1`, `esi-clones.read_clones.v1`,
  `esi-clones.read_implants.v1`, `esi-killmails.read_killmails.v1`, `esi-characters.read_standings.v1`,
  `esi-characters.read_loyalty.v1`, `esi-industry.read_character_mining.v1`, `esi-planets.manage_planets.v1`.
  The last one says "manage" but it is the only scope ESI offers for reading planetary colonies. We call only its GET
  endpoints (`/characters/{id}/planets` and `/planets/{planet_id}`); the code has no planet write call and `charWrite` is
  not used for it. A test pins the scope list: any other non-`read_` scope fails it.

- **2026-11-15: consent defaults to all characters.** An app is now granted all of the user's characters, including ones linked later, unless the user picks "Only the characters I tick". Trade-off: a newly linked character is shared with connected apps automatically (still read-only; fitting writes stay a separate, unticked opt-in). The user can revoke on `/apps` or reconnect with a specific list. Reason: removing and re-adding a character used to drop it from specific-character grants. Re-link now updates in place; remove still cascades. Owner-hash rule unchanged: a character that moves to another EVE account is unlinked first.
- **2026-11-15: military participation uses the v1 scope.** The routes are mapped to `esi.activity.char:read`; SSO rejects that name. `get_military_participation` is enabled with the read-only `esi-activities.read_character.v1`, pending a live check (an earlier live call got a 401 asking for `esi.activity.char:read`). `military_campaigns` is public and returns IDs, states and numbers only.

## Before going public (checklist)

- [ ] `bun test` green including the cross-user tests.
- [ ] `TOKEN_ENC_KEY`, `EVE_CLIENT_SECRET`, Postgres password are files in `./secrets` (`chmod 600`), not in the image, `.env` or compose file.
- [ ] TLS at the reverse proxy (valid cert), Cloudflare DNS proxied, "Always Use HTTPS" and HSTS on.
- [ ] The app port is reachable only from the reverse proxy (NAS firewall, or bind to the proxy's network).
- [ ] `CLIENT_IP_HEADER` is set only if the above holds, and to a header the proxy overwrites.
- [ ] Bot Fight Mode off, or a WAF skip rule for `/mcp`, `/oauth/*`, `/.well-known/*`. Test one
      MCP client end to end through Cloudflare.
- [ ] Postgres is not published to the host (only `app` publishes a port).
- [ ] Run the `security-audit` skill over the codebase.
- [ ] A `pg_dump` backup restored into a scratch database and checked.
- [ ] `./backups` copied off the NAS (the folder alone dies with the NAS).
- [ ] EVE app callback URL is the production one; dev app separate.
