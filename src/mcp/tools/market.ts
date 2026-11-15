import { z } from "zod";
import { charGetAll } from "../../esi/character";
import { esiGet, esiGetAll } from "../../esi/client";
import { lookupIds, nameMap, nm } from "../../esi/names";
import { AppError } from "../../errors";
import { characterTool, defineTool } from "./util";

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

// Station IDs and region IDs checked against ESI (/universe/stations/{id}: system -> region).
const HUBS = {
  jita: { name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant", station: 60003760, region: 10000002, region_name: "The Forge" },
  amarr: { name: "Amarr VIII (Oris) - Emperor Family Academy", station: 60008494, region: 10000043, region_name: "Domain" },
  dodixie: { name: "Dodixie IX - Moon 20 - Federation Navy Assembly Plant", station: 60011866, region: 10000032, region_name: "Sinq Laison" },
  rens: { name: "Rens VI - Moon 8 - Brutor Tribe Treasury", station: 60004588, region: 10000030, region_name: "Heimatar" },
  hek: { name: "Hek VIII - Moon 12 - Boundless Creation Factory", station: 60005686, region: 10000042, region_name: "Metropolis" },
} as const;
type HubKey = keyof typeof HUBS;
const HUB_KEYS = Object.keys(HUBS) as [HubKey, ...HubKey[]];

const idOrName = z.union([z.string().min(1).max(100), z.number().int().positive()]);

async function toId(v: string | number, category: "inventory_types" | "regions"): Promise<number> {
  if (typeof v === "number") return v;
  if (/^\d+$/.test(v)) return Number(v);
  const hit = (await lookupIds([v]))[category]?.[0];
  if (!hit) throw new AppError("not_found", `No ${category.replaceAll("_", " ")} named "${v.slice(0, 60)}". Names must match exactly; try resolve_names.`, 404);
  return hit.id;
}

// Orders of one type at one station, best price first. A region query is paged; `truncated` says pages were left out.
async function stationBook(regionId: number, stationId: number, typeId: number, side: "buy" | "sell", maxPages?: number) {
  const r = await esiGetAll(`/markets/${regionId}/orders`, { query: { type_id: typeId, order_type: side } }, maxPages);
  const orders = (r.items as Obj[]).filter((o) => o.location_id === stationId && !!o.is_buy_order === (side === "buy"));
  orders.sort((a, b) => (side === "buy" ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price)));
  return { orders, truncated: r.truncated };
}

function best(orders: Obj[]) {
  const top = orders[0];
  if (!top) return null;
  const level = orders.filter((o) => o.price === top.price);
  return { price: top.price as number, volume_at_price: level.reduce((s, o) => s + (num(o.volume_remain) ?? 0), 0), orders_at_price: level.length };
}

export const hubPrices = defineTool({
  name: "hub_prices",
  description:
    "Current best sell (lowest) and best buy (highest) price in ISK at the five main trade hub stations (Jita, Amarr, Dodixie, Rens, Hek), with volume and order count at that price, and the spread. Only orders in the hub station itself count. For trends over time use price_history. PLEX does not trade on hub order books (it has its own global market), so hub_prices cannot price it.",
  input: {
    item: idOrName.describe("Item name or type ID"),
    hubs: z.array(z.enum(HUB_KEYS)).min(1).max(5).optional().describe("Default: all five"),
  },
  run: async (i) => {
    const typeId = await toId(i.item, "inventory_types");
    const keys = [...new Set(i.hubs ?? HUB_KEYS)];
    const rows = await Promise.all(
      keys.map(async (k) => {
        const h = HUBS[k];
        const [sell, buy] = await Promise.all([stationBook(h.region, h.station, typeId, "sell"), stationBook(h.region, h.station, typeId, "buy")]);
        const s = best(sell.orders);
        const b = best(buy.orders);
        return {
          hub: k,
          station: h.name,
          region: h.region_name,
          best_sell: s,
          best_buy: b,
          sell_orders: sell.orders.length,
          buy_orders: buy.orders.length,
          spread: s && b ? Math.round((s.price - b.price) * 100) / 100 : null,
          spread_pct: s && b && s.price > 0 ? Math.round(((s.price - b.price) / s.price) * 1000) / 10 : null,
          incomplete: sell.truncated || buy.truncated ? "ESI had more order pages than the paging cap; prices may be missing" : undefined,
        };
      }),
    );
    return { type: nm(await nameMap([typeId]), typeId), type_id: typeId, hubs: rows };
  },
});

export const priceHistory = defineTool({
  name: "price_history",
  description:
    "Price trend of an item over the last `days` days (7 to 365, default 30; ESI keeps about a year) in a region (default The Forge): volume-weighted average, low, high, total and daily volume, trend (last quarter of the window, at least 7 days, against the rest), and CCP's universe-wide average and adjusted price. Use it for trends and typical prices; for what orders exist now use hub_prices. daily=true adds the daily rows (up to 30 days), or weekly (up to 120 days) or monthly (longer) summaries for longer windows.",
  input: {
    item: idOrName.describe("Item name or type ID"),
    region: idOrName.optional().describe("Region name or ID, default The Forge"),
    days: z.number().int().min(7).max(365).default(30).describe("Window length in days, 7 to 365"),
    daily: z.boolean().default(false).describe("Also return the daily rows (date, average, lowest, highest, volume, orders); weekly or monthly buckets when days is over 30"),
  },
  run: async (i) => {
    const typeId = await toId(i.item, "inventory_types");
    const regionId = await toId(i.region ?? 10000002, "regions");
    const h = arr(await esiGet(`/markets/${regionId}/history`, { query: { type_id: typeId } })).slice(-i.days);
    const names = await nameMap([typeId, regionId]);
    const ccp = arr(await esiGet("/markets/prices")).find((x) => x.type_id === typeId);
    const base = { type: nm(names, typeId), type_id: typeId, region: nm(names, regionId), region_id: regionId, ccp_average_price: ccp?.average_price ?? null, ccp_adjusted_price: ccp?.adjusted_price ?? null };
    if (h.length === 0) return { ...base, days: 0 };
    const avg = (d: Obj[]) => {
      const v = d.reduce((s, x) => s + (num(x.volume) ?? 0), 0);
      return v ? d.reduce((s, x) => s + (num(x.average) ?? 0) * (num(x.volume) ?? 0), 0) / v : 0;
    };
    const volume = h.reduce((s, x) => s + (num(x.volume) ?? 0), 0);
    const q = Math.max(7, Math.round(h.length / 4));
    const recent = avg(h.slice(-q));
    const before = avg(h.slice(0, -q));
    const change = before > 0 && h.length > q ? ((recent - before) / before) * 100 : null;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // Long windows come back as weekly (up to 120 days) or 30-day buckets so the reply stays small.
    const size = h.length <= 30 ? 1 : h.length <= 120 ? 7 : 30;
    const rows =
      size === 1
        ? h.map((d) => ({ date: d.date, average: d.average, lowest: d.lowest, highest: d.highest, volume: d.volume, orders: d.order_count }))
        : Array.from({ length: Math.ceil(h.length / size) }, (_, k) => {
            const g = h.slice(k * size, (k + 1) * size);
            return { date: g[0]!.date, to: g[g.length - 1]!.date, days: g.length, average: r2(avg(g)), lowest: Math.min(...g.map((x) => num(x.lowest) ?? Infinity)), highest: Math.max(...g.map((x) => num(x.highest) ?? 0)), volume: g.reduce((a, x) => a + (num(x.volume) ?? 0), 0) };
          });
    return {
      ...base,
      days: h.length,
      from: h[0]!.date,
      to: h[h.length - 1]!.date,
      average_price: r2(avg(h)),
      lowest: Math.min(...h.map((x) => num(x.lowest) ?? Infinity)),
      highest: Math.max(...h.map((x) => num(x.highest) ?? 0)),
      total_volume: volume,
      avg_daily_volume: Math.round(volume / h.length),
      trend: change === null ? "unknown" : change > 2 ? "up" : change < -2 ? "down" : "flat",
      trend_pct: change === null ? null : r2(change),
      ...(i.daily ? { daily: rows, ...(size > 1 ? { daily_bucket_days: size } : {}) } : {}),
    };
  },
});

const ASSETS = "esi-assets.read_assets.v1";
const TOP = 20;
const JITA = HUBS.jita;

export const appraiseAssets = characterTool({
  name: "appraise_assets",
  description:
    "Estimated ISK value of a character's assets plus the 20 most valuable stacks. Basis: CCP's universe average price (adjusted when there is no average): a rough figure, not what it would sell for. jita_best_buy re-prices the top 20 at the Jita 4-4 best buy order (slower). Blueprint copies are not valued. Where items are: get_assets.",
  input: {
    location: z.string().max(100).optional().describe("Part of a station or system name"),
    jita_best_buy: z.boolean().default(false).describe("Also price the top 20 stacks at Jita best buy (20 extra order queries)"),
  },
  run: async (i, c) => {
    const { items, truncated, totalPages } = await charGetAll(c, ASSETS, `/characters/${c.character_id}/assets`);
    const prices = new Map<number, number>();
    for (const p of arr(await esiGet("/markets/prices"))) {
      const v = num(p.average_price) ?? num(p.adjusted_price);
      if (v !== undefined && typeof p.type_id === "number") prices.set(p.type_id, v);
    }
    const stacks = new Map<number, number>();
    const locOf = new Map<number, string>();
    let skippedBpc = 0;
    for (const a of items as Obj[]) {
      if (a.is_blueprint_copy === true) {
        skippedBpc++;
        continue;
      }
      const id = Number(a.type_id);
      stacks.set(id, (stacks.get(id) ?? 0) + (num(a.quantity) ?? 1));
      locOf.set(Number(a.location_id), String(a.location_type));
    }
    let rows = [...stacks.entries()].map(([type_id, quantity]) => ({ type_id, quantity, unit: prices.get(type_id) ?? 0 }));
    if (i.location) {
      // Location filter works on names, so re-group by station/system rows like get_assets does.
      const l = i.location.toLowerCase();
      const named = await nameMap([...locOf.entries()].filter(([, t]) => t === "station" || t === "solar_system").map(([id]) => id));
      const ok = new Set([...locOf.keys()].filter((id) => (named.get(id) ?? "").toLowerCase().includes(l)));
      const q = new Map<number, number>();
      for (const a of items as Obj[]) if (a.is_blueprint_copy !== true && ok.has(Number(a.location_id))) q.set(Number(a.type_id), (q.get(Number(a.type_id)) ?? 0) + (num(a.quantity) ?? 1));
      rows = rows.filter((r) => q.has(r.type_id)).map((r) => ({ ...r, quantity: q.get(r.type_id)! }));
    }
    const valued = rows.map((r) => ({ ...r, value: r.quantity * r.unit })).sort((a, b) => b.value - a.value);
    const total = valued.reduce((s, r) => s + r.value, 0);
    const top = valued.slice(0, TOP);
    const jita = new Map<number, number | null>();
    if (i.jita_best_buy) {
      await Promise.all(
        top.map(async (r) => {
          const b = best((await stationBook(JITA.region, JITA.station, r.type_id, "buy", 5)).orders);
          jita.set(r.type_id, b?.price ?? null);
        }),
      );
    }
    const names = await nameMap(top.map((r) => r.type_id));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      price_basis: "CCP average_price (adjusted_price if there is no average)",
      total_value_isk: r2(total),
      distinct_types: valued.length,
      unpriced_types: valued.filter((r) => r.unit === 0).length,
      blueprint_copies_skipped: skippedBpc,
      top_stacks: top.map((r) => ({
        type: nm(names, r.type_id),
        type_id: r.type_id,
        quantity: r.quantity,
        unit_price: r2(r.unit),
        value_isk: r2(r.value),
        ...(i.jita_best_buy ? { jita_best_buy: jita.get(r.type_id) ?? null, jita_buy_value_isk: jita.get(r.type_id) != null ? r2(jita.get(r.type_id)! * r.quantity) : null } : {}),
      })),
      note: truncated ? `Only the first ${items.length} assets were read (ESI has ${totalPages} pages); the total is incomplete.` : undefined,
    };
  },
});
