# Candidate data sources (research, 2026-11-15)

A web scan for EVE content that could feed new MCP tools. [V] = read on the source page,
[S] = search snippet only, [U] = not verified. Re-check before building on anything here.

## Top 5 (built 2026-11-15)

1. **ESI Military Campaigns** [V] (done: `military_campaigns`; `get_military_participation` is enabled with the v1 scope, pending a live check, see below; SDE names not imported): `/military-campaigns`, `/military-campaigns/{uuid}` and objectives
   (public, Aug 2026); definitions in the SDE (`militaryCampaigns`, `militaryCampaignObjectives`).
   Character participation is mapped to `esi.activity.char:read`, which SSO rejects; the tool is enabled with the v1 alias `esi-activities.read_character.v1`, pending a live check (an earlier live call got a 401 asking for the other name). Fractured Skies (24.02,
   2026-11-10) is a campaign phase.
2. **Longer price history** [V] (done: `price_history` takes `days` up to 365; EVE Ref not needed): ESI `/markets/{region}/history` already returns about a year;
   `price_history` cut it to 30 days. EVE Ref daily dumps (data.everef.net/market-history, 2003 to
   today) only if more is needed.
3. **EVE-Scout Thera/Turnur** [V] (DONE: `thera_connections`): `GET https://api.eve-scout.com/v2/public/signatures`, public JSON
   (systems, class, wormhole type, max ship size, hours left). No terms or rate limits published (the API sends `cache-control: max-age=300`); we cache 5 minutes and send a contact User-Agent. Credit EVE-Scout.
4. (done) **ESI Sovereignty Systems + Equinox structures** [V]: CCP recommends the new route over
   `/sovereignty/map` and `/sovereignty/structures`; adds skyhooks, raidable skyhooks, mercenary dens,
   activity defense multipliers.
5. **CCP news RSS + SDE change lists** [V] (done: `ccp_news`, `sde_changes`): https://www.eveonline.com/rss (patch notes, Monthly
   Economic Report); SDE `changes/<build>.jsonl` and `schema-changelog.yaml`.

## Worth considering

- **EVE Ref Industry Cost API** [V] `api.everef.net/v1/industry/cost`: manufacturing, invention,
  copying, reactions. No research jobs or T3 yet. Self-hostable.
- **EVE-KILL API** [V] `api.eve-kill.com/api`: no key; battles, wars, pilot intel, common fits per hull,
  EFT per killmail. Open source. Fallback for zKillboard.
- **eve-fit-engine** (npm) [V]: DPS, EHP, cap from EFT, matches Pyfa on 99.2% of fits. **GPL-3.0**:
  needs a licence decision.
- **Fuzzwork aggregates** [V] `market.fuzzwork.co.uk/api`: percentile prices. Asks for caching.
- **Adam4EVE** [V] `api.adam4eve.eu`: traded-volume estimates. 1 request / 5 s, contact User-Agent required.
- **MutaMarket** [V]: abyssal module listings and roll stats, public JSON.
- **Image server** [V] `images.evetech.net`: portraits, logos, renders, icons; CCP allows CDN use.
- **ESI public extras** [U]: `/loyalty/stores/{corp}/offers`, `/insurance/prices`, `/wars`.

## Skip

- Evepraisal: retired 2023 [S]. zKillboard RedisQ: sunset 2026-05-31, use R2Z2 from one worker only [V].
- Janice: key via Discord, status unclear [S]. EVE Tycoon: docs not verified [S].
- Dotlan, anoik.is, EVE Workbench: no public API found [U]. EVE Who: site returned 503 [S].

## Warnings

- EVE Developer License: non-profit only; donations allowed if no feature is gated; keep the CCP notice [V]. Handled: exact §7.1 notice in footer, README and `CCP_NOTICE`; Ko-fi gates nothing.
- ESI rate limits are now per route group and per user (429 + `Retry-After`, `X-Ratelimit-*`); a 4xx
  costs more tokens than a 2xx [V]. Handled: grouped 429 pauses one bucket, low buckets are refused before calling, 420 is treated like 429 (ARCHITECTURE.md, "ESI client"). `/markets/{region}/orders` has its own group since 2026-02-24.
- Removed ESI paths: legacy swagger specs, `/status.json`, `/diff`, `/versions`, `/headers`
  (2026-03-24), `/latest/swagger.json` (2026-08-11), `/verify` redirect (2026-04-28) [V].
- Compatibility dates advance with each new-route release; new routes need a newer
  `X-Compatibility-Date`. Spec: `https://esi.evetech.net/meta/openapi.json` [V].
- Most community APIs state no terms: cache hard and send a contact User-Agent.
