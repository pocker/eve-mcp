import { z } from "zod";
import { charGet, charGetAll } from "../../esi/character";
import { esiGet } from "../../esi/client";
import { nameMap, nm } from "../../esi/names";
import { AppError } from "../../errors";
import { grantCharacters } from "../grant";
import { cap, characterTool, clip, defineTool } from "./util";

const S = {
  location: "esi-location.read_location.v1",
  ship: "esi-location.read_ship_type.v1",
  online: "esi-location.read_online.v1",
  skills: "esi-skills.read_skills.v1",
  queue: "esi-skills.read_skillqueue.v1",
  wallet: "esi-wallet.read_character_wallet.v1",
  assets: "esi-assets.read_assets.v1",
  orders: "esi-markets.read_character_orders.v1",
  jobs: "esi-industry.read_character_jobs.v1",
} as const;

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export const listCharacters = defineTool({
  name: "list_characters",
  description: "List the EVE characters this connection may access, with character_id, name and whether re-linking is needed. Call this first: every character tool needs a character_id from here.",
  input: {},
  run: async (_i, grant) =>
    (await grantCharacters(grant)).map((c) => ({ character_id: c.character_id, name: c.name, needs_relink: c.needs_reauth, scopes: c.scopes })),
});

export const characterOverview = characterTool({
  name: "character_overview",
  description: "Quick snapshot of one character: corporation, location, ship, online status, wallet balance (ISK) and the skill in training. Good first look; use the specific tools for detail. Parts the character did not grant are listed under unavailable.",
  input: {},
  run: async (_i, c) => {
    const id = c.character_id;
    const unavailable: Record<string, string> = {};
    const part = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof AppError && (e.code === "missing_scope" || e.code === "character_needs_reauth" || e.code.startsWith("esi_"))) {
          unavailable[label] = e.message;
          return undefined;
        }
        throw e;
      }
    };
    const [info, loc, ship, online, wallet, queue] = await Promise.all([
      part("info", () => esiGet(`/characters/${id}`) as Promise<Obj>),
      part("location", () => charGet(c, S.location, `/characters/${id}/location`) as Promise<Obj>),
      part("ship", () => charGet(c, S.ship, `/characters/${id}/ship`) as Promise<Obj>),
      part("online", () => charGet(c, S.online, `/characters/${id}/online`) as Promise<Obj>),
      part("wallet", () => charGet(c, S.wallet, `/characters/${id}/wallet`)),
      part("skill_queue", () => charGet(c, S.queue, `/characters/${id}/skillqueue`)),
    ]);
    const head = arr(queue)[0];
    const names = await nameMap([num(info?.corporation_id), num(info?.alliance_id), num(loc?.solar_system_id), num(loc?.station_id), num(ship?.ship_type_id), num(head?.skill_id)]);
    return {
      character_id: id,
      name: c.name,
      corporation: info ? nm(names, num(info.corporation_id)) : undefined,
      alliance: info ? nm(names, num(info.alliance_id)) : undefined,
      security_status: info?.security_status,
      location: loc && { system: nm(names, num(loc.solar_system_id)), station: nm(names, num(loc.station_id)), structure_id: loc.structure_id },
      ship: ship && { type: nm(names, num(ship.ship_type_id)), name: clip(ship.ship_name, 100) },
      online: online && { online: online.online, last_login: online.last_login, last_logout: online.last_logout },
      wallet_isk: wallet,
      training: head && { skill: nm(names, num(head.skill_id)), to_level: head.finished_level, finishes: head.finish_date },
      unavailable: Object.keys(unavailable).length ? unavailable : undefined,
    };
  },
});

export const getSkills = characterTool({
  name: "get_skills",
  description: "Skills the character has trained, with level (0-5) and skill points. Use for \"what does this pilot know\"; to check a ship or plan training use can_fly / skill_plan. filter is a case-insensitive part of the skill name.",
  input: { filter: z.string().max(100).optional().describe("Part of a skill name, e.g. 'gunnery'") },
  run: async (i, c) => {
    const r = (await charGet(c, S.skills, `/characters/${c.character_id}/skills`)) as Obj;
    const skills = arr(r.skills);
    const names = await nameMap(skills.map((s) => num(s.skill_id)));
    const f = i.filter?.toLowerCase();
    const rows = skills
      .map((s) => ({ skill: nm(names, num(s.skill_id)) ?? "", skill_id: s.skill_id, level: s.trained_skill_level, active_level: s.active_skill_level, sp: s.skillpoints_in_skill }))
      .filter((s) => !f || s.skill.toLowerCase().includes(f))
      .sort((a, b) => a.skill.localeCompare(b.skill));
    return { total_sp: r.total_sp, unallocated_sp: r.unallocated_sp, skill_count: rows.length, skills: cap(rows, 400) };
  },
});

export const getSkillQueue = characterTool({
  name: "get_skill_queue",
  description: "The character's skill training queue in order, with start and finish times (UTC). Only what is queued; not trained skills (get_skills).",
  input: {},
  run: async (_i, c) => {
    const q = arr(await charGet(c, S.queue, `/characters/${c.character_id}/skillqueue`));
    const names = await nameMap(q.map((s) => num(s.skill_id)));
    return cap(
      q.map((s) => ({ position: s.queue_position, skill: nm(names, num(s.skill_id)), to_level: s.finished_level, start: s.start_date, finish: s.finish_date })),
      100,
    );
  },
});

export const getWalletJournal = characterTool({
  name: "get_wallet_journal",
  description: "Wallet journal (ISK in and out: bounties, taxes, trades, transfers), newest first, 50 entries shown per call. Use page for older ones. For buy/sell trades by item use get_wallet_transactions.",
  input: { page: z.number().int().min(1).max(50).default(1).describe("ESI page number, starting at 1") },
  run: async (i, c) => {
    const rows = arr(await charGet(c, S.wallet, `/characters/${c.character_id}/wallet/journal`, { page: i.page }));
    const shown = rows.slice(0, 50);
    const names = await nameMap(shown.flatMap((r) => [num(r.first_party_id), num(r.second_party_id)]));
    return {
      page: i.page,
      entries_on_page: rows.length,
      entries: shown.map((r) => ({
        date: r.date,
        type: r.ref_type,
        amount: r.amount,
        balance: r.balance,
        from: nm(names, num(r.first_party_id)),
        to: nm(names, num(r.second_party_id)),
        reason: clip(r.reason, 100),
        description: clip(r.description, 150),
      })),
      note: rows.length > 50 ? "Only the first 50 entries of this page are shown." : undefined,
    };
  },
});

const MAX_ASSET_ROWS = 300;

export const getAssets = characterTool({
  name: "get_assets",
  description: "Where a character's items are: grouped by item type and location, with quantities. Filter by type and/or location (case-insensitive parts of the name). Large inventories are truncated, so filter. For total value use appraise_assets.",
  input: {
    type: z.string().max(100).optional().describe("Part of an item name, e.g. 'tritanium'"),
    location: z.string().max(100).optional().describe("Part of a station or system name"),
  },
  run: async (i, c) => {
    const { items, truncated, totalPages } = await charGetAll(c, S.assets, `/characters/${c.character_id}/assets`);
    const groups = new Map<string, { type_id: number; location_id: number; location_type: string; quantity: number }>();
    for (const a of items as Obj[]) {
      const k = `${a.type_id}:${a.location_id}`;
      const g = groups.get(k) ?? { type_id: Number(a.type_id), location_id: Number(a.location_id), location_type: String(a.location_type), quantity: 0 };
      g.quantity += num(a.quantity) ?? 1;
      groups.set(k, g);
    }
    const all = [...groups.values()];
    // Only stations and systems resolve through /universe/names; structures and containers stay as IDs.
    const names = await nameMap([...all.map((g) => g.type_id), ...all.filter((g) => g.location_type === "station" || g.location_type === "solar_system").map((g) => g.location_id)]);
    const t = i.type?.toLowerCase();
    const l = i.location?.toLowerCase();
    const rows = all
      .map((g) => ({ type: nm(names, g.type_id) ?? "", type_id: g.type_id, location: nm(names, g.location_id) ?? "", location_id: g.location_id, quantity: g.quantity }))
      .filter((r) => (!t || r.type.toLowerCase().includes(t)) && (!l || r.location.toLowerCase().includes(l)))
      .sort((a, b) => a.location.localeCompare(b.location) || a.type.localeCompare(b.type));
    return {
      distinct_rows: rows.length,
      assets: cap(rows, MAX_ASSET_ROWS),
      note: truncated ? `Only the first ${items.length} assets were read (ESI has ${totalPages} pages); the list is incomplete.` : undefined,
    };
  },
});

export const getMarketOrders = characterTool({
  name: "get_market_orders",
  description: "The character's own open market orders (buy and sell): price (ISK), remaining volume and location. Not the public order book; for that use hub_prices.",
  input: {},
  run: async (_i, c) => {
    const o = arr(await charGet(c, S.orders, `/characters/${c.character_id}/orders`));
    const names = await nameMap(o.flatMap((r) => [num(r.type_id), num(r.location_id), num(r.region_id)]));
    return cap(
      o.map((r) => ({
        order_id: r.order_id,
        side: r.is_buy_order ? "buy" : "sell",
        type: nm(names, num(r.type_id)),
        price: r.price,
        volume_remaining: r.volume_remain,
        volume_total: r.volume_total,
        location: nm(names, num(r.location_id)),
        region: nm(names, num(r.region_id)),
        issued: r.issued,
        duration_days: r.duration,
      })),
      200,
    );
  },
});

const ACTIVITY: Record<number, string> = { 1: "manufacturing", 3: "te_research", 4: "me_research", 5: "copying", 7: "reverse_engineering", 8: "invention", 9: "reactions" };

export const getIndustryJobs = characterTool({
  name: "get_industry_jobs",
  description: "The character's active industry jobs (manufacturing, research, copying, invention, reactions) with product and end time (UTC).",
  input: {},
  run: async (_i, c) => {
    const j = arr(await charGet(c, S.jobs, `/characters/${c.character_id}/industry/jobs`));
    const names = await nameMap(j.flatMap((r) => [num(r.blueprint_type_id), num(r.product_type_id), num(r.facility_id)]));
    return cap(
      j.map((r) => ({
        job_id: r.job_id,
        activity: ACTIVITY[Number(r.activity_id)] ?? `activity_${r.activity_id}`,
        status: r.status,
        blueprint: nm(names, num(r.blueprint_type_id)),
        product: nm(names, num(r.product_type_id)),
        runs: r.runs,
        facility: nm(names, num(r.facility_id)),
        start: r.start_date,
        end: r.end_date,
      })),
      200,
    );
  },
});
