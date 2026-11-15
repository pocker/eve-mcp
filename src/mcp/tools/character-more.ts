import { z } from "zod";
import { charGet, charGetAll } from "../../esi/character";
import { killSummary } from "../../intel/killmail";
import { nameMap, nm } from "../../esi/names";
import { cap, characterTool, clip } from "./util";

const S = {
  contracts: "esi-contracts.read_character_contracts.v1",
  clones: "esi-clones.read_clones.v1",
  implants: "esi-clones.read_implants.v1",
  killmails: "esi-killmails.read_killmails.v1",
  wallet: "esi-wallet.read_character_wallet.v1",
  standings: "esi-characters.read_standings.v1",
  loyalty: "esi-characters.read_loyalty.v1",
  mining: "esi-industry.read_character_mining.v1",
  planets: "esi-planets.manage_planets.v1", // GET endpoints only, see docs/SECURITY.md
  skills: "esi-skills.read_skills.v1",
  activity: "esi.activity.char:read",
} as const;

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
// Only stations and systems resolve through /universe/names; structures stay as IDs.
const placeId = (t: unknown, id: unknown) => (t === "station" || t === "solar_system" ? num(id) : undefined);

const STATUSES = ["outstanding", "in_progress", "finished_issuer", "finished_contractor", "finished", "cancelled", "rejected", "failed", "deleted", "reversed"] as const;

export const getContracts = characterTool({
  name: "get_contracts",
  description: "The character's contracts (item exchange, auction, courier, loan), newest first, optionally only one status. Items inside one contract: get_contract_items.",
  input: { status: z.enum(STATUSES).optional().describe("Only contracts with this status") },
  run: async (i, c) => {
    const { items, truncated } = await charGetAll(c, S.contracts, `/characters/${c.character_id}/contracts`);
    const rows = (items as Obj[])
      .filter((r) => !i.status || r.status === i.status)
      .sort((a, b) => String(b.date_issued).localeCompare(String(a.date_issued)))
      .slice(0, 100);
    const names = await nameMap(rows.flatMap((r) => [num(r.issuer_id), num(r.assignee_id), num(r.acceptor_id), num(r.start_location_id), num(r.end_location_id)]));
    return {
      ...cap(
        rows.map((r) => ({
          contract_id: r.contract_id,
          type: r.type,
          status: r.status,
          title: clip(r.title, 100),
          issuer: nm(names, num(r.issuer_id)),
          assignee: nm(names, num(r.assignee_id)),
          acceptor: nm(names, num(r.acceptor_id)),
          from: nm(names, num(r.start_location_id)),
          to: nm(names, num(r.end_location_id)),
          price: r.price,
          reward: r.reward,
          collateral: r.collateral,
          buyout: r.buyout,
          volume: r.volume,
          issued: r.date_issued,
          expires: r.date_expired,
          completed: r.date_completed,
        })),
        100,
      ),
      note: truncated ? "ESI had more pages than were read; older contracts are missing." : undefined,
    };
  },
});

export const getContractItems = characterTool({
  name: "get_contract_items",
  description: "Items in one of the character's contracts. contract_id comes from get_contracts.",
  input: { contract_id: z.number().int().positive().describe("Contract ID from get_contracts") },
  run: async (i, c) => {
    const items = arr(await charGet(c, S.contracts, `/characters/${c.character_id}/contracts/${i.contract_id}/items`));
    const names = await nameMap(items.map((r) => num(r.type_id)));
    return cap(items.map((r) => ({ type: nm(names, num(r.type_id)), type_id: r.type_id, quantity: r.quantity, offered: r.is_included, singleton: r.is_singleton })), 200);
  },
});

export const getClones = characterTool({
  name: "get_clones",
  description: "Jump clones with location and implants, the home station, last clone jump, and the implants plugged in now. Use for implant and clone questions.",
  input: {},
  run: async (_i, c) => {
    const cl = (await charGet(c, S.clones, `/characters/${c.character_id}/clones`)) as Obj;
    const active = (await charGet(c, S.implants, `/characters/${c.character_id}/implants`)) as unknown[];
    const jumps = arr(cl.jump_clones);
    const home = (cl.home_location ?? {}) as Obj;
    const ids = [...jumps.flatMap((j) => (Array.isArray(j.implants) ? (j.implants as number[]) : [])), ...(Array.isArray(active) ? active : []).map(Number)];
    const names = await nameMap([...ids, placeId(home.location_type, home.location_id), ...jumps.map((j) => placeId(j.location_type, j.location_id))]);
    const imps = (l: unknown) => (Array.isArray(l) ? l : []).map((id) => nm(names, Number(id)));
    return {
      home: { location: nm(names, placeId(home.location_type, home.location_id)), location_id: home.location_id, location_type: home.location_type },
      last_clone_jump: cl.last_clone_jump_date,
      last_station_change: cl.last_station_change_date,
      active_implants: imps(active),
      jump_clones: cap(
        jumps.map((j) => ({ clone_id: j.jump_clone_id, name: clip(j.name, 100), location: nm(names, placeId(j.location_type, j.location_id)), location_id: j.location_id, location_type: j.location_type, implants: imps(j.implants) })),
        50,
      ),
    };
  },
});

const MAX_KILLS = 20;

export const getKillmails = characterTool({
  name: "get_killmails",
  description: "The character's most recent kills and losses (max 20) with time, system, victim, ship and final blow. For danger in a system use system_info instead.",
  input: { limit: z.number().int().min(1).max(MAX_KILLS).default(10).describe("How many, newest first (max 20)") },
  run: async (i, c) => {
    const recent = arr(await charGet(c, S.killmails, `/characters/${c.character_id}/killmails/recent`)).slice(0, i.limit);
    const kms = await Promise.all(recent.map((r) => killSummary(Number(r.killmail_id), String(r.killmail_hash))));
    const g = (o: unknown, k: string) => num((o as Obj | undefined)?.[k]);
    const names = await nameMap(kms.flatMap((k) => [num(k.system_id), g(k.victim, "character_id"), g(k.victim, "corporation_id"), g(k.victim, "alliance_id"), g(k.victim, "ship_type_id"), g(k.final_blow, "character_id"), g(k.final_blow, "ship_type_id")]));
    return kms.map((k) => ({
      killmail_id: k.killmail_id,
      time: k.time,
      result: g(k.victim, "character_id") === c.character_id ? "loss" : "kill",
      system: nm(names, num(k.system_id)),
      victim: nm(names, g(k.victim, "character_id")),
      victim_corporation: nm(names, g(k.victim, "corporation_id")),
      victim_alliance: nm(names, g(k.victim, "alliance_id")),
      victim_ship: nm(names, g(k.victim, "ship_type_id")),
      damage_taken: g(k.victim, "damage_taken"),
      attackers: k.attackers,
      final_blow_by: nm(names, g(k.final_blow, "character_id")),
      final_blow_ship: nm(names, g(k.final_blow, "ship_type_id")),
    }));
  },
});

export const getWalletTransactions = characterTool({
  name: "get_wallet_transactions",
  description: "The character's market buys and sells by item (unit price, quantity, ISK), newest first, 50 shown. Pass from_id (a transaction_id) for older ones. ISK flow overall: get_wallet_journal.",
  input: { from_id: z.number().int().positive().optional().describe("Only transactions older than this transaction_id") },
  run: async (i, c) => {
    const rows = arr(await charGet(c, S.wallet, `/characters/${c.character_id}/wallet/transactions`, { from_id: i.from_id }));
    const shown = rows.slice(0, 50);
    const names = await nameMap(shown.flatMap((r) => [num(r.type_id), num(r.client_id), num(r.location_id)]));
    return {
      transactions_returned: rows.length,
      transactions: shown.map((r) => ({
        transaction_id: r.transaction_id,
        date: r.date,
        side: r.is_buy ? "buy" : "sell",
        type: nm(names, num(r.type_id)),
        quantity: r.quantity,
        unit_price: r.unit_price,
        client: nm(names, num(r.client_id)),
        location: nm(names, num(r.location_id)),
      })),
      note: rows.length > 50 ? "Only the first 50 are shown; pass from_id of the last one for more." : undefined,
    };
  },
});

export const getStandings = characterTool({
  name: "get_standings",
  description: "The character's standings (-10 to 10) towards agents, NPC corporations and factions, highest first.",
  input: {},
  run: async (_i, c) => {
    const rows = arr(await charGet(c, S.standings, `/characters/${c.character_id}/standings`)).sort((a, b) => Number(b.standing) - Number(a.standing));
    const names = await nameMap(rows.slice(0, 300).map((r) => num(r.from_id)));
    return cap(rows.map((r) => ({ from: nm(names, num(r.from_id)), type: r.from_type, standing: r.standing })), 300);
  },
});

export const getLoyaltyPoints = characterTool({
  name: "get_loyalty_points",
  description: "The character's loyalty points (LP) per NPC corporation, highest first.",
  input: {},
  run: async (_i, c) => {
    const rows = arr(await charGet(c, S.loyalty, `/characters/${c.character_id}/loyalty/points`)).sort((a, b) => Number(b.loyalty_points) - Number(a.loyalty_points));
    const names = await nameMap(rows.map((r) => num(r.corporation_id)));
    return cap(rows.map((r) => ({ corporation: nm(names, num(r.corporation_id)), loyalty_points: r.loyalty_points })), 200);
  },
});

export const getMiningLedger = characterTool({
  name: "get_mining_ledger",
  description: "Mining ledger of the last 30 days: units mined per ore per day, with a total per ore.",
  input: {},
  run: async (_i, c) => {
    const { items, truncated } = await charGetAll(c, S.mining, `/characters/${c.character_id}/mining`);
    const rows = items as Obj[];
    const days = new Map<string, { date: string; type_id: number; system_id: number; quantity: number }>();
    const ores = new Map<number, number>();
    for (const r of rows) {
      const k = `${r.date}:${r.type_id}:${r.solar_system_id}`;
      const d = days.get(k) ?? { date: String(r.date), type_id: Number(r.type_id), system_id: Number(r.solar_system_id), quantity: 0 };
      d.quantity += num(r.quantity) ?? 0;
      days.set(k, d);
      ores.set(Number(r.type_id), (ores.get(Number(r.type_id)) ?? 0) + (num(r.quantity) ?? 0));
    }
    const list = [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
    const names = await nameMap([...ores.keys(), ...list.slice(0, 200).map((d) => d.system_id)]);
    return {
      totals_per_ore: [...ores.entries()].sort((a, b) => b[1] - a[1]).map(([id, q]) => ({ ore: nm(names, id), quantity: q })),
      per_day: cap(list.map((d) => ({ date: d.date, ore: nm(names, d.type_id), system: nm(names, d.system_id), quantity: d.quantity })), 200),
      note: truncated ? "ESI had more pages than were read." : undefined,
    };
  },
});

export const getPlanets = characterTool({
  name: "get_planets",
  description: "The character's planetary colonies with a layout summary per planet: pin counts, extractors (product, cycle, expiry) and what the storage holds. Read only.",
  input: {},
  run: async (_i, c) => {
    const planets = arr(await charGet(c, S.planets, `/characters/${c.character_id}/planets`)).slice(0, 20);
    const details = await Promise.all(planets.map(async (p) => ((await charGet(c, S.planets, `/characters/${c.character_id}/planets/${p.planet_id}`)) ?? {}) as Obj));
    const pins = details.map((d) => arr(d.pins));
    const names = await nameMap([
      ...planets.flatMap((p) => [num(p.planet_id), num(p.solar_system_id)]),
      ...pins.flat().flatMap((p) => [num((p.extractor_details as Obj | undefined)?.product_type_id), num(p.type_id), ...arr(p.contents).map((x) => num(x.type_id))]),
    ]);
    return planets.map((p, n) => {
      const ps = pins[n]!;
      const ext = ps.filter((x) => x.extractor_details);
      return {
        planet: nm(names, num(p.planet_id)),
        type: p.planet_type,
        system: nm(names, num(p.solar_system_id)),
        upgrade_level: p.upgrade_level,
        last_update: p.last_update,
        pins: ps.length,
        factories: ps.filter((x) => x.factory_details).length,
        links: arr(details[n]!.links).length,
        routes: arr(details[n]!.routes).length,
        extractors: ext.map((x) => {
          const e = x.extractor_details as Obj;
          return { product: nm(names, num(e.product_type_id)), qty_per_cycle: e.qty_per_cycle, cycle_seconds: e.cycle_time, heads: arr(e.heads).length, expires: x.expiry_time };
        }),
        stored: ps.flatMap((x) => arr(x.contents).map((ct) => ({ type: nm(names, num(ct.type_id)), amount: ct.amount }))).slice(0, 30),
      };
    });
  },
});

export const getAttributes = characterTool({
  name: "get_attributes",
  description: "The character's attributes (intelligence, memory, perception, willpower, charisma) and whether a neural remap is available now. Implants are in get_clones.",
  input: {},
  run: async (_i, c) => {
    const a = (await charGet(c, S.skills, `/characters/${c.character_id}/attributes`)) as Obj;
    const cooldown = typeof a.accrued_remap_cooldown_date === "string" ? a.accrued_remap_cooldown_date : null;
    const bonus = num(a.bonus_remaps) ?? 0;
    const free = !cooldown || new Date(cooldown).getTime() <= Date.now();
    return {
      intelligence: a.intelligence,
      memory: a.memory,
      perception: a.perception,
      willpower: a.willpower,
      charisma: a.charisma,
      last_remap: a.last_remap_date ?? null,
      bonus_remaps: bonus,
      remap_available: bonus > 0 || free,
      next_free_remap: free ? null : cooldown,
    };
  },
});

export const getMilitaryParticipation = characterTool({
  name: "get_military_participation",
  description: "Military campaign objectives this character took part in: whether still committed, cumulative contribution and last change (newest page, up to 50). Campaign and objective IDs: see military_campaigns.",
  input: {},
  run: async (_i, c) => {
    const r = (await charGet(c, S.activity, `/characters/${c.character_id}/military-campaigns/objectives`, { limit: 50 })) as Obj;
    return cap(
      arr(r.objectives).map((x) => ({ objective_id: clip(x.id, 40), campaign_id: clip(x.campaign_id, 40), committed: x.is_committed === true, contributed: num(x.contributed), last_modified: clip(x.last_modified, 30) })),
      50,
    );
  },
});
