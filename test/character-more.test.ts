import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/db/db";
import { setEsiFetch } from "../src/esi/client";
import type { Grant } from "../src/mcp/grant";
import { tools } from "../src/mcp/tools";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, seedCharacter, seedUser, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => setEsiFetch(undefined));

const tool = (name: string) => tools.find((t) => t.name === name)!;
const call = (name: string, input: object, grant: Grant) => tool(name).run(z.object(tool(name).input).parse(input) as never, grant) as Promise<any>;

// tool -> scope it needs
const SCOPE: Record<string, string> = {
  get_contracts: "esi-contracts.read_character_contracts.v1",
  get_contract_items: "esi-contracts.read_character_contracts.v1",
  get_clones: "esi-clones.read_clones.v1",
  get_killmails: "esi-killmails.read_killmails.v1",
  get_wallet_transactions: "esi-wallet.read_character_wallet.v1",
  get_standings: "esi-characters.read_standings.v1",
  get_loyalty_points: "esi-characters.read_loyalty.v1",
  get_mining_ledger: "esi-industry.read_character_mining.v1",
  get_planets: "esi-planets.manage_planets.v1",
  get_attributes: "esi-skills.read_skills.v1",
  get_military_participation: "esi.activity.char:read",
};

let A: { user: number; char: number; grant: Grant };
let B: number;
let fake: ReturnType<typeof fakeEsi>;

beforeAll(async () => {
  if (!dbAvailable) return;
  const ua = await seedUser();
  A = { user: ua, char: await seedCharacter(ua, "Alice", { id: 91000011 }), grant: { id: 0, userId: ua, clientId: "t", allCharacters: true, allowWrite: false } };
  B = await seedCharacter(await seedUser(), "Bob", { id: 91000012 });
});
beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  await sql`delete from esi_cache`;
  const p = `/characters/${A.char}`;
  const routes: Routes = {
    "POST /universe/names": (c) => (c.body as number[]).map((id) => ({ id, name: `Name${id}`, category: "x" })),
    [`GET ${p}/contracts`]: () => [
      { contract_id: 1, type: "courier", status: "outstanding", title: "t".repeat(500), issuer_id: 7, date_issued: "2030-01-01", start_location_id: 60003760, end_location_id: 60003760 },
      { contract_id: 2, type: "item_exchange", status: "finished", date_issued: "2030-02-01" },
    ],
    [`GET ${p}/contracts/1/items`]: () => [{ type_id: 34, quantity: 5, is_included: true, is_singleton: false }],
    [`GET ${p}/clones`]: () => ({ home_location: { location_id: 60003760, location_type: "station" }, jump_clones: [{ jump_clone_id: 1, location_id: 60003760, location_type: "station", implants: [9899], name: "n" }], last_clone_jump_date: "2030-01-01" }),
    [`GET ${p}/implants`]: () => [9899, 9900],
    [`GET ${p}/killmails/recent`]: () => [{ killmail_id: 11, killmail_hash: "h1" }, { killmail_id: 12, killmail_hash: "h2" }],
    "GET /killmails/11/h1": () => ({ killmail_time: "2030-01-01", solar_system_id: 30000142, victim: { character_id: A.char, ship_type_id: 587, damage_taken: 5 }, attackers: [{ final_blow: true, character_id: 5, ship_type_id: 600 }, {}] }),
    "GET /killmails/12/h2": () => ({ killmail_time: "2030-01-02", solar_system_id: 30000142, victim: { character_id: 99, ship_type_id: 587 }, attackers: [{ final_blow: true, character_id: A.char }] }),
    [`GET ${p}/wallet/transactions`]: () => [{ transaction_id: 1, date: "d", is_buy: true, type_id: 34, quantity: 2, unit_price: 5, client_id: 3, location_id: 60003760 }],
    [`GET ${p}/standings`]: () => [{ from_id: 1, from_type: "npc_corp", standing: 1 }, { from_id: 2, from_type: "agent", standing: 5 }],
    [`GET ${p}/loyalty/points`]: () => [{ corporation_id: 1, loyalty_points: 10 }, { corporation_id: 2, loyalty_points: 99 }],
    [`GET ${p}/mining`]: () => [
      { date: "2030-01-01", quantity: 10, solar_system_id: 30000142, type_id: 1230 },
      { date: "2030-01-01", quantity: 5, solar_system_id: 30000142, type_id: 1230 },
      { date: "2030-01-02", quantity: 1, solar_system_id: 30000142, type_id: 1231 },
    ],
    [`GET ${p}/planets`]: () => [{ planet_id: 40000001, planet_type: "lava", solar_system_id: 30000142, upgrade_level: 4, num_pins: 2, last_update: "x" }],
    [`GET ${p}/planets/40000001`]: () => ({
      pins: [{ pin_id: 1, type_id: 2848, extractor_details: { product_type_id: 2268, qty_per_cycle: 100, cycle_time: 3600, heads: [{}, {}] }, expiry_time: "2030-03-01" }, { pin_id: 2, type_id: 2469, factory_details: { schematic_id: 1 }, contents: [{ type_id: 2268, amount: 7 }] }],
      links: [{}],
      routes: [],
    }),
    [`GET ${p}/military-campaigns/objectives`]: () => ({ objectives: [{ id: "o1", campaign_id: "c1", is_committed: true, contributed: 42, last_modified: "2030-01-01T00:00:00Z" }] }),
    [`GET ${p}/attributes`]: () => ({ intelligence: 20, memory: 21, perception: 22, willpower: 23, charisma: 19, bonus_remaps: 0, accrued_remap_cooldown_date: "2999-01-01", last_remap_date: "2020-01-01" }),
  };
  fake = fakeEsi(routes);
  setEsiFetch(fake.fetch);
});

describe.skipIf(!dbAvailable)("more character tools (needs Postgres)", () => {
  test("get_contracts and get_contract_items", async () => {
    const r = await call("get_contracts", { character_id: A.char }, A.grant);
    expect(r.items.map((x: any) => x.contract_id)).toEqual([2, 1]);
    expect(r.items[1]).toMatchObject({ issuer: "Name7", from: "Name60003760" });
    expect(r.items[1].title.length).toBe(100);
    expect((await call("get_contracts", { character_id: A.char, status: "outstanding" }, A.grant)).items).toHaveLength(1);
    expect((await call("get_contract_items", { character_id: A.char, contract_id: 1 }, A.grant)).items[0]).toMatchObject({ type: "Name34", quantity: 5 });
  });

  test("get_clones", async () => {
    const r = await call("get_clones", { character_id: A.char }, A.grant);
    expect(r.active_implants).toEqual(["Name9899", "Name9900"]);
    expect(r.home.location).toBe("Name60003760");
    expect(r.jump_clones.items[0]).toMatchObject({ implants: ["Name9899"], location: "Name60003760" });
  });

  test("get_killmails marks kills and losses, caches killmails forever", async () => {
    const r = await call("get_killmails", { character_id: A.char }, A.grant);
    expect(r.map((k: any) => k.result)).toEqual(["loss", "kill"]);
    expect(r[0]).toMatchObject({ victim_ship: "Name587", attackers: 2, final_blow_by: "Name5", system: "Name30000142" });
    // Even after the plain ESI cache is gone, details come from our permanent entry.
    await sql`delete from esi_cache where key not like 'killmail#%' and key not like 'name#%'`;
    const before = fake.calls.filter((c) => c.path.startsWith("/killmails/")).length;
    await call("get_killmails", { character_id: A.char, limit: 2 }, A.grant);
    expect(fake.calls.filter((c) => c.path.startsWith("/killmails/")).length).toBe(before);
    expect(before).toBe(2);
    const limited = await call("get_killmails", { character_id: A.char, limit: 1 }, A.grant);
    expect(limited).toHaveLength(1);
  });

  test("get_wallet_transactions, standings, loyalty", async () => {
    expect((await call("get_wallet_transactions", { character_id: A.char }, A.grant)).transactions[0]).toMatchObject({ side: "buy", type: "Name34", client: "Name3" });
    expect((await call("get_standings", { character_id: A.char }, A.grant)).items[0]).toMatchObject({ from: "Name2", standing: 5 });
    expect((await call("get_loyalty_points", { character_id: A.char }, A.grant)).items[0]).toMatchObject({ corporation: "Name2", loyalty_points: 99 });
  });

  test("get_mining_ledger sums per ore and day", async () => {
    const r = await call("get_mining_ledger", { character_id: A.char }, A.grant);
    expect(r.totals_per_ore[0]).toEqual({ ore: "Name1230", quantity: 15 });
    expect(r.per_day.items).toHaveLength(2);
    expect(r.per_day.items[1]).toMatchObject({ date: "2030-01-01", quantity: 15 });
  });

  test("get_planets summarises extractors and only does GETs", async () => {
    const r = await call("get_planets", { character_id: A.char }, A.grant);
    expect(r[0]).toMatchObject({ planet: "Name40000001", type: "lava", pins: 2, factories: 1, links: 1 });
    expect(r[0].extractors[0]).toMatchObject({ product: "Name2268", heads: 2, expires: "2030-03-01" });
    expect(r[0].stored[0]).toEqual({ type: "Name2268", amount: 7 });
    expect(fake.calls.filter((c) => c.path.includes("/planets")).every((c) => c.method === "GET")).toBe(true);
  });

  test("get_military_participation", async () => {
    const r = await call("get_military_participation", { character_id: A.char }, A.grant);
    expect(r.items[0]).toEqual({ objective_id: "o1", campaign_id: "c1", committed: true, contributed: 42, last_modified: "2030-01-01T00:00:00Z" });
  });

  test("get_attributes says when a remap is available", async () => {
    const r = await call("get_attributes", { character_id: A.char }, A.grant);
    expect(r).toMatchObject({ intelligence: 20, remap_available: false, next_free_remap: "2999-01-01" });
  });

  test("every new tool refuses another user's character and names the missing scope", async () => {
    const limited = await seedCharacter(A.user, "Limited", { scopes: ["esi-location.read_online.v1"] });
    for (const [name, scope] of Object.entries(SCOPE)) {
      const extra = { contract_id: 1 };
      await expect(call(name, { character_id: B, ...extra }, A.grant)).rejects.toMatchObject({ code: "character_not_allowed" });
      await expect(call(name, { character_id: limited, ...extra }, A.grant)).rejects.toThrow(scope);
    }
    // get_clones needs both of its scopes
    const half = await seedCharacter(A.user, "Half", { scopes: ["esi-clones.read_clones.v1"] });
    setEsiFetch(fakeEsi({ [`GET /characters/${half}/clones`]: () => ({}) }).fetch);
    await expect(call("get_clones", { character_id: half }, A.grant)).rejects.toThrow("esi-clones.read_implants.v1");
  });

  test("scope names are all in EVE_SCOPES", async () => {
    const { EVE_SCOPES } = await import("../src/esi/scopes");
    for (const s of Object.values(SCOPE)) expect(EVE_SCOPES).toContain(s);
  });
});
