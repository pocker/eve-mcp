import { AppError } from "../errors";
import { cacheGetMany, cachePutMany } from "./cache";
import { esiPost } from "./client";

const DAY = 24 * 3600_000;
const MAX_IDS = 500; // per call; ESI takes 1000, the rest of a long list shows as "#id"

type NameRow = { id: number; name: string; category: string };

const key = (id: number) => `name#${id}`;
const clip = (s: string) => s.slice(0, 100);

// `bad` collects IDs ESI says do not exist.
async function fetchNames(ids: number[], bad: number[]): Promise<NameRow[]> {
  if (ids.length === 0) return [];
  try {
    const rows = (await esiPost("/universe/names", ids)) as NameRow[];
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    // ESI answers 404 for the whole batch if one ID is unknown (e.g. a structure): split to find the good ones.
    if (!(e instanceof AppError) || e.code !== "esi_not_found") throw e;
    if (ids.length === 1) {
      bad.push(ids[0]!);
      return [];
    }
    const mid = ids.length >> 1;
    return [...(await fetchNames(ids.slice(0, mid), bad)), ...(await fetchNames(ids.slice(mid), bad))];
  }
}

// ID -> name. Unknown IDs are simply missing from the map; use nm() to print them.
export async function nameMap(ids: Iterable<number | null | undefined>): Promise<Map<number, string>> {
  const want = [...new Set([...ids].filter((x): x is number => typeof x === "number" && x > 0))].slice(0, MAX_IDS);
  const out = new Map<number, string>();
  const missing: number[] = [];
  const cached = await cacheGetMany(want.map(key));
  for (const id of want) {
    const c = cached.get(key(id));
    if (!c?.fresh) missing.push(id);
    else if ((c.data as { n: string | null }).n != null) out.set(id, (c.data as { n: string }).n);
  }
  const bad: number[] = [];
  const rows = await fetchNames(missing, bad);
  for (const r of rows) out.set(r.id, clip(r.name));
  await cachePutMany(rows.map((r) => [key(r.id), { n: clip(r.name), c: r.category }]), new Date(Date.now() + DAY));
  // Unresolvable IDs (e.g. structures) are cached as unknown so the next call does not pay the 404s again.
  await cachePutMany(bad.map((id) => [key(id), { n: null }]), new Date(Date.now() + DAY));
  return out;
}

export const nm = (m: Map<number, string>, id: number | null | undefined) => (id == null ? null : (m.get(id) ?? `#${id}`));

export type IdLookup = Record<string, { id: number; name: string }[]>;

// Names -> IDs by category (characters, solar systems, inventory types, ...). ESI matches exact names.
export async function lookupIds(names: string[]): Promise<IdLookup> {
  const r = (await esiPost("/universe/ids", names)) as Record<string, { id: number; name: string }[]>;
  return r && typeof r === "object" ? r : {};
}
