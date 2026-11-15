import { esiGet, esiPost } from "../esi/client";
import { lookupIds, nameMap, nm } from "../esi/names";
import { AppError } from "../errors";
import { killUrl, zkillSystemKills } from "./zkill";

export type Obj = Record<string, unknown>;
export const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

// EVE shows security with one decimal; anything above 0 but below 0.05 shows as 0.1.
export function secDisplay(sec: number): number {
  const s = Math.max(-1, Math.min(1, sec));
  if (s > 0 && s < 0.05) return 0.1;
  return Math.round(s * 10) / 10;
}
export const secClass = (display: number) => (display >= 0.5 ? "highsec" : display > 0 ? "lowsec" : "nullsec");

const isSystemId = (n: number) => n >= 30_000_000 && n < 32_000_000;
const isRegionId = (n: number) => n >= 10_000_000 && n < 13_000_000;

// Names and IDs to system IDs in one /universe/ids call. A name that matches nothing is a clear error.
export async function resolveSystems(inputs: (string | number)[]): Promise<number[]> {
  const names = [...new Set(inputs.filter((x): x is string => typeof x === "string" && !/^\d+$/.test(x)))];
  const found = names.length ? (await lookupIds(names)).systems ?? [] : [];
  return inputs.map((v) => {
    if (typeof v === "number" || /^\d+$/.test(v)) {
      const n = Number(v);
      if (!isSystemId(n)) throw new AppError("bad_input", `${n} is not a solar system ID (they run from 30000000 to 31999999).`, 400);
      return n;
    }
    const hit = found.find((f) => f.name.toLowerCase() === v.toLowerCase());
    if (!hit) throw new AppError("not_found", `No solar system named "${v.slice(0, 60)}". Names must match exactly (e.g. "Jita", "J123456"); try resolve_names, or pass the system ID.`, 404);
    return hit.id;
  });
}

// A system or a region, by name or ID.
export async function resolveSystemOrRegion(v: string | number): Promise<{ kind: "system" | "region"; id: number }> {
  if (typeof v === "number" || /^\d+$/.test(v)) {
    const n = Number(v);
    if (isSystemId(n)) return { kind: "system", id: n };
    if (isRegionId(n)) return { kind: "region", id: n };
    throw new AppError("bad_input", `${n} is neither a solar system ID (30000000-31999999) nor a region ID (10000000-12999999).`, 400);
  }
  const r = await lookupIds([v]);
  const sys = r.systems?.[0];
  if (sys) return { kind: "system", id: sys.id };
  const reg = r.regions?.[0];
  if (reg) return { kind: "region", id: reg.id };
  throw new AppError("not_found", `No solar system or region named "${v.slice(0, 60)}". Names must match exactly; try resolve_names, or pass the ID.`, 404);
}

// shortcut: no SDE yet, so a region's systems cost one call per constellation (ESI-cached for a long time); use the SDE tables when they exist.
export async function regionSystems(regionId: number): Promise<Set<number>> {
  const region = (await esiGet(`/universe/regions/${regionId}`)) as Obj;
  const cons = await Promise.all(((region.constellations as number[]) ?? []).map((c) => esiGet(`/universe/constellations/${c}`) as Promise<Obj>));
  return new Set(cons.flatMap((c) => (c.systems as number[]) ?? []));
}

export type SystemRow = { id: number; sec: number; display: number; constellation_id: number };

export async function systemRow(id: number): Promise<SystemRow> {
  const s = (await esiGet(`/universe/systems/${id}`)) as Obj;
  const sec = Number(s.security_status);
  return { id, sec, display: secDisplay(sec), constellation_id: Number(s.constellation_id) };
}

// Hourly aggregates. Systems with no activity are missing from ESI's lists, so they count as zero.
export async function hourly(): Promise<{ kills: Map<number, Obj>; jumps: Map<number, number> }> {
  const [k, j] = await Promise.all([esiGet("/universe/system_kills"), esiGet("/universe/system_jumps")]);
  return { kills: new Map(arr(k).map((x) => [Number(x.system_id), x])), jumps: new Map(arr(j).map((x) => [Number(x.system_id), Number(x.ship_jumps)])) };
}

export type RecentKill = { time: unknown; ship_type_id: number | null; value: number; attackers: number; solo: boolean; url: string };

// zKill list, then ESI details for the newest `n`: zKill alone has no time, ship or attacker count.
export async function recentKills(systemId: number, n: number): Promise<RecentKill[]> {
  const kills = (await zkillSystemKills(systemId)).filter((k) => !k.npc).slice(0, n);
  return Promise.all(
    kills.map(async (k) => {
      const m = (await esiGet(`/killmails/${k.killmail_id}/${k.hash}`)) as Obj;
      const attackers = arr(m.attackers).length;
      return { time: m.killmail_time, ship_type_id: ((m.victim as Obj)?.ship_type_id as number) ?? null, value: k.value, attackers, solo: k.solo || attackers === 1, url: killUrl(k.killmail_id) };
    }),
  );
}

export const shapeKills = (rows: RecentKill[], names: Map<number, string>) => rows.map(({ ship_type_id, ...r }) => ({ ...r, ship: nm(names, ship_type_id) }));

const PREFERENCE = { shortest: "Shorter", secure: "Safer", insecure: "LessSecure" } as const;

// Gate route as a system ID list. ESI answers 404 when no route exists; that becomes an empty list.
// POST /route is not cached (shortcut: one ESI call per route, add a cache if it gets busy).
export async function gateRoute(from: number, to: number, preference: keyof typeof PREFERENCE, avoid: number[] = []): Promise<number[]> {
  try {
    const r = (await esiPost(`/route/${from}/${to}`, { preference: PREFERENCE[preference], ...(avoid.length ? { avoid_systems: avoid } : {}) })) as Obj;
    return Array.isArray(r?.route) ? (r.route as number[]) : [];
  } catch (e) {
    if (e instanceof AppError && e.code === "esi_not_found") return [];
    throw e;
  }
}

// /sovereignty/systems: every system with a claim of one kind: { alliance: {...} } | { faction: { faction_id } } | { unclaimed }.
export const sovSystems = async () => arr(((await esiGet("/sovereignty/systems")) as Obj | null)?.solar_systems);
export const claimOf = (x: Obj) => {
  const c = (x.claim ?? {}) as Obj;
  const a = c.alliance as Obj | undefined;
  return { alliance: a, allianceId: a?.alliance_id as number | undefined, factionId: (c.faction as Obj | undefined)?.faction_id as number | undefined };
};
