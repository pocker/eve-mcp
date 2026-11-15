import { sql } from "./db/db";
import { MIN_ERROR_BUDGET } from "./esi/client";

// The single list of external systems we talk to. Used by /sources and the about_sources tool.
// Add a source here and in docs/SECURITY.md (fixed outbound hosts) when code starts calling a new host.
export type Source = {
  id: "sso" | "esi" | "sde" | "news" | "wiki" | "zkill" | "evescout";
  name: string;
  host: string;
  url: string;
  purpose: string;
  provides: string[];
  freshness: string;
  sends: string;
  credit: string;
  tools: string[];
};

export const CCP_NOTICE = '© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.';

const ESI_CHARACTER_TOOLS = [
  "character_overview", "get_skills", "get_skill_queue", "get_attributes", "get_clones", "get_assets", "get_wallet_journal", "get_wallet_transactions",
  "get_market_orders", "get_industry_jobs", "get_contracts", "get_contract_items", "get_killmails", "get_standings", "get_loyalty_points",
  "get_mining_ledger", "get_planets", "get_military_participation", "get_fittings", "create_fitting", "delete_fitting", "can_fly", "skill_plan", "appraise_assets",
];

export const sources: Source[] = [
  {
    id: "sso",
    name: "EVE Online SSO",
    host: "login.eveonline.com",
    url: "https://login.eveonline.com",
    purpose: "Sign-in and character authorization.",
    provides: ["Your character identity", "Permission (scopes) for us to read your character data"],
    freshness: "Only when you sign in, link a character, or we refresh a token",
    sends: "The authorization code and refresh token exchange only. Tokens are stored encrypted.",
    credit: "© CCP hf.",
    tools: [],
  },
  {
    id: "esi",
    name: "ESI (EVE Swagger Interface)",
    host: "esi.evetech.net",
    url: "https://esi.evetech.net",
    purpose: "Live data for your characters and the game universe.",
    provides: [
      "Skills, skill queue, attributes, clones", "Assets, wallet, market orders", "Industry jobs, contracts, mining, planets, military campaigns", "Killmails, standings, loyalty points",
      "Fittings (read, and create or delete only when you allow it)", "Universe, route, status and market data",
    ],
    freshness: "Live, cached per ESI cache headers (seconds to 1 hour)",
    sends: "Your character access token for character data. Public universe and market calls carry no token.",
    credit: "© CCP hf.",
    tools: [...ESI_CHARACTER_TOOLS, "resolve_names", "plan_route", "get_server_status", "system_info", "route_safety", "incursions", "sovereignty", "faction_warfare", "military_campaigns", "hub_prices", "price_history", "get_type_info"],
  },
  {
    id: "sde",
    name: "EVE Static Data Export (SDE)",
    host: "developers.eveonline.com",
    url: "https://developers.eveonline.com/static-data",
    purpose: "Ship and module stats, skill requirements, blueprints and masteries.",
    provides: ["Item and ship attributes", "Skill requirements and training math", "Blueprint materials and times", "What changed in each build"],
    freshness: "Checked daily, re-imported when CCP publishes a new build",
    sends: "Nothing personal. We only download the published data.",
    credit: "© CCP hf.",
    tools: ["get_type_info", "skill_requirements", "can_fly", "skill_plan", "blueprint_info", "sde_changes"],
  },
  {
    id: "news",
    name: "EVE Online news",
    host: "www.eveonline.com",
    url: "https://www.eveonline.com/news",
    purpose: "Official patch notes, expansions and dev news.",
    provides: ["Recent news titles, dates, links and short descriptions"],
    freshness: "Cached for 1 hour",
    sends: "Nothing. We only download the public news feed.",
    credit: "© CCP hf.",
    tools: ["ccp_news"],
  },
  {
    id: "wiki",
    name: "EVE University Wiki",
    host: "wiki.eveuniversity.org",
    url: "https://wiki.eveuniversity.org",
    purpose: "Guides and game mechanics.",
    provides: ["Page text and section lists", "Search results"],
    freshness: "Cached for 24 hours",
    sends: "Search terms and page titles only.",
    credit: "Text is community-written, licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Attribution: EVE University Wiki.",
    tools: ["wiki_search", "wiki_page"],
  },
  {
    id: "zkill",
    name: "zKillboard",
    host: "zkillboard.com",
    url: "https://zkillboard.com",
    purpose: "Kill statistics and recent kills.",
    provides: ["Pilot, corporation and alliance statistics", "Recent kills and losses", "Latest kills in a system"],
    freshness: "Cached 5 minutes to 1 hour",
    sends: "Public IDs only (character, corporation, alliance, system, ship type). Never tokens.",
    credit: "Data from zKillboard (zkillboard.com).",
    tools: ["zkill_stats", "zkill_kills", "killmail_detail", "system_info", "route_safety"],
  },
  {
    id: "evescout",
    name: "EVE-Scout",
    host: "api.eve-scout.com",
    url: "https://www.eve-scout.com",
    purpose: "Current Thera and Turnur wormhole connections.",
    provides: ["Connected systems, wormhole type, max ship size, expiry"],
    freshness: "Cached 5 minutes",
    sends: "Nothing: one public request without parameters.",
    credit: "Data from EVE-Scout (Signal Cartel), eve-scout.com.",
    tools: ["thera_connections"],
  },
];

export const NEVER_SENT = "Your EVE tokens only ever go to EVE SSO and ESI. Every other system gets public IDs or search text, nothing that identifies you.";

export type SourceStatus = {
  sde: { loaded: boolean; build_number: number | null; imported_at: string | null };
  esi: { state: "ok" | "limited"; errors_remaining: number | null; resets_in_seconds: number | null };
};

// Our own DB only: no outbound calls.
export async function sourceStatus(): Promise<SourceStatus> {
  const [sde] = await sql`select build_number, imported_at from sde_meta limit 1`;
  const [esi] = await sql`select error_limit_remain as remain, extract(epoch from error_limit_reset_at - now()) as secs from esi_status where id = 1`;
  const active = esi?.remain != null && Number(esi.secs) > 0;
  return {
    sde: { loaded: !!sde, build_number: sde ? Number(sde.build_number) : null, imported_at: sde ? new Date(sde.imported_at).toISOString() : null },
    esi: {
      state: active && Number(esi.remain) < MIN_ERROR_BUDGET ? "limited" : "ok",
      errors_remaining: active ? Number(esi.remain) : null,
      resets_in_seconds: active ? Math.ceil(Number(esi.secs)) : null,
    },
  };
}
