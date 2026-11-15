import { cacheGet, cachePut } from "../esi/cache";
import { esiGet } from "../esi/client";
import { toEft } from "../mcp/tools/eft";

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const FOREVER = new Date("9999-01-01T00:00:00Z");
export const MAX_KILLMAILS = 10; // ESI killmail fetches per tool call
const CONCURRENCY = 4;

// Ordered results, at most `n` running at once.
export async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]!); } }));
  return out;
}

// Killmails never change, so the slim summary is cached for good (the plain ESI cache key would expire).
// Entries written before `top_ships` existed are rebuilt.
export async function killSummary(id: number, hash: string): Promise<Obj> {
  const key = `killmail#${id}`;
  const hit = await cacheGet(key);
  if (hit?.fresh && "top_ships" in (hit.data as Obj)) return hit.data as Obj;
  const k = (await esiGet(`/killmails/${id}/${hash}`)) as Obj;
  const v = (k.victim ?? {}) as Obj;
  const att = arr(k.attackers);
  const fb = att.find((a) => a.final_blow === true);
  const ships = new Map<number, number>();
  for (const a of att) if (typeof a.ship_type_id === "number") ships.set(a.ship_type_id, (ships.get(a.ship_type_id) ?? 0) + 1);
  const slim = {
    killmail_id: id,
    time: k.killmail_time,
    system_id: k.solar_system_id,
    victim: { character_id: v.character_id, corporation_id: v.corporation_id, alliance_id: v.alliance_id, ship_type_id: v.ship_type_id, damage_taken: v.damage_taken },
    attackers: att.length,
    final_blow: fb && { character_id: fb.character_id, corporation_id: fb.corporation_id, alliance_id: fb.alliance_id, ship_type_id: fb.ship_type_id },
    top_ships: [...ships].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ship_type_id, count]) => ({ ship_type_id, count })),
  };
  await cachePut(key, null, FOREVER, slim, 1);
  return slim;
}

// Numeric inventory flags of fitted items (ESI killmails use numbers, fittings use names). Source: esi/eve-glue location_flag.py.
const FLAG_NAMES = new Map<number, string>([[5, "Cargo"], [87, "DroneBay"], [158, "FighterBay"]]);
for (const [first, prefix, n] of [[11, "LoSlot", 8], [19, "MedSlot", 8], [27, "HiSlot", 8], [92, "RigSlot", 3], [125, "SubSystemSlot", 4]] as const) for (let i = 0; i < n; i++) FLAG_NAMES.set(first + i, `${prefix}${i}`);

export type KmItem = { type_id: number; flag: number; destroyed: number; dropped: number };

export const kmItems = (victim: Obj): KmItem[] =>
  arr(victim.items).map((i) => ({ type_id: Number(i.item_type_id), flag: Number(i.flag), destroyed: Number(i.quantity_destroyed) || 0, dropped: Number(i.quantity_dropped) || 0 }));

// Slots, drones, fighters and cargo only (implants and other holds are left out). Same type on the same flag (a dropped and a destroyed one) merges.
export function lossFit(ship: string, id: number, items: KmItem[], nameOf: (id: number) => string): string | null {
  const merged = new Map<string, { type_id: number; flag: string; quantity: number }>();
  for (const it of items) {
    const flag = FLAG_NAMES.get(it.flag);
    if (!flag) continue;
    const k = `${flag}:${it.type_id}`;
    const e = merged.get(k) ?? { type_id: it.type_id, flag, quantity: 0 };
    e.quantity += it.destroyed + it.dropped;
    merged.set(k, e);
  }
  return merged.size === 0 ? null : toEft(ship, `Loss ${id}`, [...merged.values()], nameOf);
}
