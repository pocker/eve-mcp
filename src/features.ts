import { prompts } from "./mcp/prompts";
import { tools } from "./mcp/tools";
import { sources } from "./sources";

// User-facing summary and category per tool. A test pins this to the registered tools, so it cannot drift.
export const CATEGORIES = ["Your characters", "Fittings (write, opt-in)", "Static game data", "Patches and news", "Market", "Travel and intel", "zKillboard", "EVE University wiki", "About"] as const;
type Category = (typeof CATEGORIES)[number];

export const toolInfo: Record<string, [Category, string]> = {
  list_characters: ["Your characters", "The characters you linked and allowed for this app."],
  character_overview: ["Your characters", "Location, ship, online state, wallet and skill queue head."],
  get_skills: ["Your characters", "Trained skills and skill points."],
  get_skill_queue: ["Your characters", "What is training now and what is queued."],
  get_attributes: ["Your characters", "Attributes, implants bonus and remap availability."],
  get_clones: ["Your characters", "Jump clones and implants."],
  get_assets: ["Your characters", "Items you own, by location."],
  get_wallet_journal: ["Your characters", "Wallet history."],
  get_wallet_transactions: ["Your characters", "Market buy and sell transactions."],
  get_market_orders: ["Your characters", "Your open market orders."],
  get_industry_jobs: ["Your characters", "Manufacturing, research and other industry jobs."],
  get_contracts: ["Your characters", "Your contracts."],
  get_contract_items: ["Your characters", "The items in one contract."],
  get_killmails: ["Your characters", "Your recent kills and losses."],
  get_standings: ["Your characters", "Standings with agents, corporations and factions."],
  get_loyalty_points: ["Your characters", "Loyalty points per corporation."],
  get_mining_ledger: ["Your characters", "Mining totals per ore and day."],
  get_planets: ["Your characters", "Your planetary colonies."],
  get_military_participation: ["Your characters", "Military campaign objectives you took part in."],
  can_fly: ["Your characters", "Whether a character can use a ship or module, and what is missing."],
  skill_plan: ["Your characters", "Ordered training plan with times for chosen skills or a ship."],
  appraise_assets: ["Your characters", "Rough value of your assets."],
  get_fittings: ["Fittings (write, opt-in)", "Your saved ship fittings."],
  create_fitting: ["Fittings (write, opt-in)", "Save a fitting to your character. Only if you allowed writes."],
  delete_fitting: ["Fittings (write, opt-in)", "Delete a saved fitting. Only if you allowed writes."],
  fit_stats: ["Static game data", "Simulate a ship fit from EFT: DPS, EHP, resists, cap, speed, with All-V or your skills."],
  get_type_info: ["Static game data", "Stats, attributes and masteries of any ship, module or item."],
  skill_requirements: ["Static game data", "Skills an item needs, and a skill's prerequisites."],
  blueprint_info: ["Static game data", "Materials, time and skills for a blueprint."],
  ccp_news: ["Patches and news", "Recent CCP news: patch notes, expansions, economic reports."],
  sde_changes: ["Patches and news", "What changed in a static data build: types added, removed or changed."],
  resolve_names: ["Static game data", "Look up IDs for names of systems, items and more."],
  hub_prices: ["Market", "Best buy and sell prices in the five trade hubs."],
  price_history: ["Market", "Price trend (up to a year, default 30 days) for an item in a region."],
  plan_route: ["Travel and intel", "Gate route between two systems."],
  thera_connections: ["Travel and intel", "Current Thera and Turnur wormhole connections (EVE-Scout)."],
  route_safety: ["Travel and intel", "A route with a danger check per system."],
  system_info: ["Travel and intel", "Security, sovereignty, kills, jumps and incursions for a system."],
  incursions: ["Travel and intel", "Active incursions."],
  sovereignty: ["Travel and intel", "Who holds which systems, development levels and raidable Skyhooks."],
  military_campaigns: ["Travel and intel", "Active military campaigns, their progress and objectives."],
  faction_warfare: ["Travel and intel", "Faction warfare contest state."],
  get_server_status: ["Travel and intel", "Whether Tranquility is up, and the player count."],
  zkill_stats: ["zKillboard", "Threat profile of a pilot, corporation or alliance."],
  zkill_kills: ["zKillboard", "Recent kills or losses of a pilot, system, ship or region."],
  killmail_detail: ["zKillboard", "One loss with its fit as EFT."],
  wiki_search: ["EVE University wiki", "Search guides and mechanics."],
  wiki_page: ["EVE University wiki", "Read a wiki page or section."],
  about_sources: ["About", "Which systems this server talks to, and their status."],
};

export const features = () => ({
  groups: CATEGORIES.map((category) => ({
    category,
    tools: tools
      .filter((t) => toolInfo[t.name]?.[0] === category)
      .map((t) => ({
        name: t.name,
        summary: toolInfo[t.name]![1],
        needs_character: "character_id" in t.input,
        changes_game_data: t.write,
        sources: sources.filter((s) => s.tools.includes(t.name)).map((s) => s.name),
      })),
  })).filter((g) => g.tools.length > 0),
  prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: Object.keys(p.args) })),
});

export const EXAMPLES = [
  "Can my main fly a Tengu, and what should I train first?",
  "What is my total asset value, and where is it?",
  "Is Jita to Amarr safe right now?",
  "What does a Drake sell for in Jita, and how has it moved this month?",
  "How dangerous is this pilot? (name a character, corporation or alliance)",
  "How do wormhole mass limits work?",
];
