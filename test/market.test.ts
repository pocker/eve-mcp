import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { setEsiFetch } from "../src/esi/client";
import type { Grant } from "../src/mcp/grant";
import { tools } from "../src/mcp/tools";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, seedCharacter, seedUser, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => setEsiFetch(undefined));

const tool = (name: string) => tools.find((t) => t.name === name)!;
const call = (name: string, input: object, grant: Grant) => tool(name).run(z.object(tool(name).input).parse(input) as never, grant) as Promise<any>;

const JITA = 60003760;
const o = (price: number, vol: number, buy: boolean, loc = JITA) => ({ order_id: Math.random(), price, volume_remain: vol, is_buy_order: buy, location_id: loc, type_id: 44992 });
const NAMES: Routes = { "POST /universe/names": (c) => (c.body as number[]).map((id) => ({ id, name: `Name${id}`, category: "x" })) };

let A: { user: number; char: number; grant: Grant };
let B: number;

beforeAll(async () => {
  if (!dbAvailable) return;
  const ua = await seedUser();
  A = { user: ua, char: await seedCharacter(ua, "Alice"), grant: { id: 0, userId: ua, clientId: "t", allCharacters: true, allowWrite: false } };
  B = await seedCharacter(await seedUser(), "Bob");
});
beforeEach(async () => {
  if (dbAvailable) await resetEsi();
});

describe.skipIf(!dbAvailable)("market tools (needs Postgres)", () => {
  test("hub_prices filters by station, picks best buy/sell and sums the best level", async () => {
    const fake = fakeEsi({
      ...NAMES,
      "GET /markets/10000002/orders": (c) =>
        c.query.get("order_type") === "sell"
          ? [o(5, 10, false), o(4, 3, false), o(4, 2, false), o(1, 99, false, 60000001)]
          : [o(2, 7, true), o(3, 1, true), o(9, 50, true, 60000001)],
    });
    setEsiFetch(fake.fetch);
    const r = await call("hub_prices", { item: 44992, hubs: ["jita"] }, A.grant);
    expect(r.hubs).toHaveLength(1);
    expect(r.hubs[0]).toMatchObject({ hub: "jita", best_sell: { price: 4, volume_at_price: 5, orders_at_price: 2 }, best_buy: { price: 3, volume_at_price: 1, orders_at_price: 1 }, sell_orders: 4 - 1, buy_orders: 2, spread: 1, spread_pct: 25 });
    expect(fake.calls.filter((c) => c.path.startsWith("/markets/")).every((c) => c.query.get("type_id") === "44992")).toBe(true);
  });

  test("hub_prices: all five hubs by default, empty book gives nulls, paging is capped", async () => {
    const fake = fakeEsi({
      ...NAMES,
      "GET /markets/10000002/orders": () => new Response(JSON.stringify([o(5, 1, false)]), { headers: { "x-pages": "50", expires: new Date(Date.now() + 300_000).toUTCString() } }),
      "GET /markets/10000043/orders": () => [],
      "GET /markets/10000032/orders": () => [],
      "GET /markets/10000030/orders": () => [],
      "GET /markets/10000042/orders": () => [],
    });
    setEsiFetch(fake.fetch);
    const r = await call("hub_prices", { item: 44992 }, A.grant);
    expect(r.hubs.map((h: any) => h.hub)).toEqual(["jita", "amarr", "dodixie", "rens", "hek"]);
    expect(r.hubs[1]).toMatchObject({ best_sell: null, best_buy: null, spread: null });
    expect(r.hubs[0].incomplete).toBeDefined();
    // 10 pages max per side for Jita
    expect(fake.calls.filter((c) => c.path === "/markets/10000002/orders" && c.query.get("order_type") === "sell").length).toBe(10);
  });

  test("hub_prices resolves an item name and caches by Expires", async () => {
    const fake = fakeEsi({ ...NAMES, "POST /universe/ids": () => ({ inventory_types: [{ id: 44992, name: "PLEX" }] }), "GET /markets/10000002/orders": () => [o(5, 1, false)] });
    setEsiFetch(fake.fetch);
    await call("hub_prices", { item: "PLEX", hubs: ["jita"] }, A.grant);
    const n = fake.calls.length;
    await call("hub_prices", { item: 44992, hubs: ["jita"] }, A.grant);
    expect(fake.calls.length).toBe(n);
  });

  test("price_history summarises 30 days and the trend", async () => {
    const days = Array.from({ length: 40 }, (_, i) => ({ date: `d${i}`, average: i < 33 ? 10 : 20, lowest: 9, highest: 25, volume: 100, order_count: 1 }));
    setEsiFetch(fakeEsi({ ...NAMES, "GET /markets/10000002/history": () => days, "GET /markets/prices": () => [{ type_id: 34, average_price: 5, adjusted_price: 6 }] }).fetch);
    const r = await call("price_history", { item: 34 }, A.grant);
    expect(r).toMatchObject({ days: 30, from: "d10", to: "d39", lowest: 9, highest: 25, total_volume: 3000, avg_daily_volume: 100, trend: "up", ccp_average_price: 5, ccp_adjusted_price: 6 });
    expect(r.daily).toBeUndefined();
    expect((await call("price_history", { item: 34, daily: true }, A.grant)).daily).toHaveLength(30);
  });

  test("price_history takes a longer window and buckets daily rows", async () => {
    const days = Array.from({ length: 400 }, (_, i) => ({ date: `d${i}`, average: i < 300 ? 10 : 20, lowest: 9, highest: 25, volume: 100, order_count: 1 }));
    setEsiFetch(fakeEsi({ ...NAMES, "GET /markets/10000002/history": () => days, "GET /markets/prices": () => [] }).fetch);
    const r = await call("price_history", { item: 34, days: 365, daily: true }, A.grant);
    expect(r).toMatchObject({ days: 365, from: "d35", to: "d399", total_volume: 36500, trend: "up", daily_bucket_days: 30 });
    expect(r.daily).toHaveLength(13);
    expect(r.daily[0]).toMatchObject({ date: "d35", days: 30, volume: 3000 });
    const w = await call("price_history", { item: 34, days: 60, daily: true }, A.grant);
    expect(w).toMatchObject({ days: 60, daily_bucket_days: 7 });
    expect(w.daily).toHaveLength(9);
    expect(() => call("price_history", { item: 34, days: 400 }, A.grant)).toThrow();
  });

  test("appraise_assets totals, top 20, skips BPCs, optional Jita best buy", async () => {
    const assets = [
      ...Array.from({ length: 25 }, (_, i) => ({ item_id: i, type_id: 1000 + i, quantity: 2, location_id: JITA, location_type: "station" })),
      { item_id: 100, type_id: 1000, quantity: 3, location_id: JITA, location_type: "station" },
      { item_id: 101, type_id: 1001, quantity: 1, location_id: JITA, location_type: "station", is_blueprint_copy: true },
    ];
    const prices = Array.from({ length: 25 }, (_, i) => ({ type_id: 1000 + i, average_price: 10 + i, adjusted_price: 1 }));
    const fake = fakeEsi({
      ...NAMES,
      [`GET /characters/${A.char}/assets`]: () => assets,
      "GET /markets/prices": () => prices,
      "GET /markets/10000002/orders": (c) => [o(Number(c.query.get("type_id")) - 900, 1, true), o(1, 5, true, 60000001)],
    });
    setEsiFetch(fake.fetch);
    const r = await call("appraise_assets", { character_id: A.char }, A.grant);
    // sum over i of 2*(10+i) = 2*(250+300) = 1100, plus 3 more of type 1000 at 10, BPC skipped
    expect(r.total_value_isk).toBe(1100 + 30);
    expect(r.blueprint_copies_skipped).toBe(1);
    expect(r.top_stacks).toHaveLength(20);
    expect(r.top_stacks[0]).toMatchObject({ type_id: 1024, value_isk: 68 });
    expect(r.price_basis).toContain("average_price");
    expect(fake.calls.filter((c) => c.path === "/markets/10000002/orders").length).toBe(0);
    const j = await call("appraise_assets", { character_id: A.char, jita_best_buy: true }, A.grant);
    expect(fake.calls.filter((c) => c.path === "/markets/10000002/orders").length).toBe(20);
    expect(j.top_stacks[0]).toMatchObject({ type_id: 1024, jita_best_buy: 124, jita_buy_value_isk: 248 });
    const f = await call("appraise_assets", { character_id: A.char, location: "nomatch" }, A.grant);
    expect(f.total_value_isk).toBe(0);
  });

  test("appraise_assets: cross-user refusal and missing scope", async () => {
    await expect(call("appraise_assets", { character_id: B }, A.grant)).rejects.toMatchObject({ code: "character_not_allowed" });
    const id = await seedCharacter(A.user, "Limited", { scopes: ["esi-skills.read_skills.v1"] });
    await expect(call("appraise_assets", { character_id: id }, A.grant)).rejects.toThrow("esi-assets.read_assets.v1");
  });
});
