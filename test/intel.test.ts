import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { setEsiFetch } from "../src/esi/client";
import { secDisplay } from "../src/intel/intel";
import { setZkillFetch } from "../src/intel/zkill";
import { tools } from "../src/mcp/tools";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => {
  setEsiFetch(undefined);
  setZkillFetch(undefined);
});

const grant = { id: 0, userId: 1, clientId: "t", allCharacters: true, allowWrite: false };
const run = (name: string, input: object) => {
  const t = tools.find((x) => x.name === name)!;
  return t.run(z.object(t.input).parse(input) as never, grant) as Promise<Record<string, any>>;
};

const HASH = "a".repeat(40);
// 30000142 high (0.95), 30000144 high, 30000200 low, 30000300 null with a camp, 30000400 high with traffic only.
const SEC: Record<number, number> = { 30000142: 0.9459, 30000144: 0.8, 30000200: 0.3, 30000300: -0.2, 30000400: 0.04 };
const NAMES: Record<string, number> = { Jita: 30000142, Amarr: 30000400, Camp: 30000300 };
let esi: ReturnType<typeof fakeEsi>;
let zk: ReturnType<typeof fakeEsi>;
let zkReply: (c: any) => unknown;

const routes = (): Routes => ({
  "POST /universe/ids": (c) => ({ systems: (c.body as string[]).filter((n) => NAMES[n]).map((n) => ({ id: NAMES[n], name: n })) }),
  "POST /universe/names": (c) => (c.body as number[]).map((id) => ({ id, name: `N${id}`, category: "x" })),
  ...Object.fromEntries(Object.entries(SEC).map(([id, s]) => [`GET /universe/systems/${id}`, () => ({ security_status: s, constellation_id: 20000020 })])),
  "GET /universe/constellations/20000020": () => ({ region_id: 10000002, systems: [30000142, 30000144, 30000200] }),
  "GET /universe/regions/10000002": () => ({ constellations: [20000020] }),
  "POST /route/30000142/30000400": (c) => ({ route: (c.body as any).preference === "Safer" ? [30000142, 30000144, 30000400] : [30000142, 30000144, 30000200, 30000300, 30000400] }),
  "GET /universe/system_kills": () => [
    { system_id: 30000142, ship_kills: 2, pod_kills: 0, npc_kills: 50 },
    { system_id: 30000300, ship_kills: 5, pod_kills: 3, npc_kills: 0 },
    { system_id: 30000200, ship_kills: 1, pod_kills: 0, npc_kills: 0 },
  ],
  "GET /universe/system_jumps": () => [
    { system_id: 30000142, ship_jumps: 900 },
    { system_id: 30000300, ship_jumps: 20 },
    { system_id: 30000400, ship_jumps: 10 },
  ],
  "GET /sovereignty/systems": () => ({
    solar_systems: [
      { solar_system_id: 30000142, claim: { alliance: { alliance_id: 111, corporation_id: 1, claimed_since: "2030-01-01T00:00:00Z", is_capital_system: true, development: { military_level: 3, industrial_level: 2, strategic_level: 1, activity_defense_multiplier: 2.5 }, sovereignty_hub: { id: 9, vulnerability_window: { start: "2030-02-01T18:00:00Z", end: "2030-02-01T20:00:00Z" } } } } },
      { solar_system_id: 30000144, claim: { alliance: { alliance_id: 111 } } },
      { solar_system_id: 30000200, claim: { faction: { faction_id: 500001 } } },
      { solar_system_id: 30000300, claim: { unclaimed: true } },
      { solar_system_id: 39999999, claim: { alliance: { alliance_id: 222 } } },
    ],
  }),
  "GET /skyhooks/raidable": () => ({
    skyhooks: [
      { solar_system_id: 30000144, planet_id: 40000001, theft_vulnerability: { start: "2030-02-01T00:00:00Z", end: "2030-02-01T02:00:00Z" } },
      { solar_system_id: 39999999, planet_id: 40000002, theft_vulnerability: { start: "2030-02-01T00:00:00Z", end: "2030-02-01T02:00:00Z" } },
    ],
  }),
  "GET /sovereignty/campaigns": () => [{ solar_system_id: 30000144, event_type: "tcu_defense", defender_id: 111, defender_score: 0.6, attackers_score: 0.4, start_time: "2030-01-01T00:00:00Z" }],
  "GET /fw/systems": () => [
    { solar_system_id: 30000142, contested: "contested", occupier_faction_id: 500001, owner_faction_id: 500002, victory_points: 3000, victory_points_threshold: 6000 },
    { solar_system_id: 30000144, contested: "uncontested", occupier_faction_id: 500002, owner_faction_id: 500002, victory_points: 0, victory_points_threshold: 6000 },
  ],
  "GET /military-campaigns": () => ({ campaigns: [{ id: "3868eaed-8278-4cb7-9709-7d7de9c20dc7", state: "Active", progress: 50, started: "2030-01-01T00:00:00Z" }] }),
  "GET /military-campaigns/3868eaed-8278-4cb7-9709-7d7de9c20dc7": () => ({ id: "3868eaed-8278-4cb7-9709-7d7de9c20dc7", state: "Active", progress: 50 }),
  "GET /military-campaigns/3868eaed-8278-4cb7-9709-7d7de9c20dc7/objectives": () => ({ objectives: [{ id: "o1".repeat(40), state: "Active", progress: 7, last_modified: "2030-01-02T00:00:00Z", participants: { total: 4, committed: 1, contributors: 2 } }] }),
  "GET /incursions": () => [{ constellation_id: 20000020, faction_id: 500019, has_boss: true, infested_solar_systems: [30000142, 30000144], influence: 0.5, staging_solar_system_id: 30000144, state: "established", type: "Incursion" }],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`GET /killmails/${n}/${HASH}`, () => ({ killmail_time: `2030-01-01T00:0${n}:00Z`, victim: { ship_type_id: 587 }, attackers: Array.from({ length: n === 1 ? 1 : 4 }, () => ({})) })])),
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  esi = fakeEsi(routes());
  setEsiFetch(esi.fetch);
  zkReply = () => [1, 2, 3, 4, 5, 6, 7].map((n) => ({ killmail_id: n, zkb: { hash: HASH, totalValue: 1_000_000 * n, solo: n === 1, npc: false } }));
  zk = fakeEsi({ "GET /api/kills/solarSystemID/30000142/pastSeconds/86400/": (c) => zkReply(c), "GET /api/kills/solarSystemID/30000300/pastSeconds/86400/": (c) => zkReply(c), "GET /api/kills/solarSystemID/30000200/pastSeconds/86400/": (c) => zkReply(c), "GET /api/kills/solarSystemID/30000400/pastSeconds/86400/": (c) => zkReply(c) });
  setZkillFetch(zk.fetch, 0);
});

describe("secDisplay", () => {
  test("EVE rounding", () => {
    expect(secDisplay(0.9459)).toBe(0.9);
    expect(secDisplay(0.96)).toBe(1);
    expect(secDisplay(0.04)).toBe(0.1);
    expect(secDisplay(0.45)).toBe(0.5);
    expect(secDisplay(0)).toBe(0);
    expect(secDisplay(-0.2)).toBe(-0.2);
  });
});

describe.skipIf(!dbAvailable)("intel tools (needs Postgres)", () => {
  test("system_info shapes everything and uses zKill politely", async () => {
    const r = await run("system_info", { system: "Jita" });
    expect(r).toMatchObject({ system_id: 30000142, security: 0.9, true_security: 0.946, class: "highsec", region: "N10000002", constellation: "N20000020" });
    expect(r.sovereignty).toEqual({ alliance: "N111", faction: null });
    expect(r.faction_warfare).toMatchObject({ occupier: "N500001", contest_percent: 50 });
    expect(r.incursion).toEqual({ state: "established", faction: "N500019" });
    expect(r.last_hour).toEqual({ ship_kills: 2, pod_kills: 0, npc_kills: 50, jumps: 900 });
    expect(r.recent_kills).toHaveLength(5);
    expect(r.recent_kills[0]).toEqual({ time: "2030-01-01T00:01:00Z", value: 1_000_000, attackers: 1, solo: true, url: "https://zkillboard.com/kill/1/", ship: "N587" });
    expect(zk.calls).toHaveLength(1);
    const h = zk.calls[0]!.headers;
    expect(h.get("user-agent")).toMatch(/^eve-mcp\/\S+ \(\+http:\/\/localhost:3000; test@example.com\)$/);
    expect(h.get("accept-encoding")).toBe("gzip");
    // second call: zKill, ESI hourly data and killmails all cached
    const before = esi.calls.length;
    await run("system_info", { system: "Jita" });
    expect(zk.calls).toHaveLength(1);
    expect(esi.calls.slice(before).filter((c) => c.path.startsWith("/universe/system_") || c.path.startsWith("/killmails"))).toHaveLength(0);
  });

  test("zKill rate limit degrades to an error field and is not retried at once", async () => {
    zkReply = () => new Response("slow down", { status: 429 });
    const r = await run("system_info", { system: 30000142 });
    expect(r.recent_kills).toBeNull();
    expect(r.recent_kills_error).toMatch(/rate limiting/);
    expect(r.security).toBe(0.9);
    await run("system_info", { system: 30000142 });
    expect(zk.calls).toHaveLength(1);
  });

  test("a bad system name is a clear error", async () => {
    await expect(run("system_info", { system: "Jitaa" })).rejects.toThrow(/No solar system named "Jitaa".*resolve_names/);
    await expect(run("system_info", { system: 5 })).rejects.toThrow(/not a solar system ID/);
  });

  test("route_safety flags, ranks, batches names, skips zKill by default", async () => {
    const r = await run("route_safety", { from: "Jita", to: "Amarr" });
    expect(r).toMatchObject({ jumps: 4, min_security: -0.2, total_kills_last_hour: 11, flagged: 4 });
    const camp = r.systems[3];
    expect(camp).toMatchObject({ system: "N30000300", security: -0.2, ship_kills: 5, pod_kills: 3, jumps: 20 });
    expect(camp.flags).toEqual(["nullsec", "kills_last_hour", "camp_like"]);
    expect(r.systems[4].flags).toEqual(["lowsec"]); // true 0.04 shows as 0.1
    expect(r.systems[4].security).toBe(0.1);
    expect(r.riskiest.map((s: any) => s.system)).toEqual(["N30000300", "N30000142", "N30000200"]);
    expect(zk.calls).toHaveLength(0);
    expect(esi.calls.filter((c) => c.path === "/universe/names")).toHaveLength(1);
    expect(esi.calls.filter((c) => c.path === "/universe/ids")).toHaveLength(1);
    const rc = esi.calls.find((c) => c.path.startsWith("/route"))!;
    expect(rc.method).toBe("POST");
    expect(rc.body).toEqual({ preference: "Shorter" });
  });

  test("route_safety recent_kills asks zKill for the riskiest 3 only, once", async () => {
    const r = await run("route_safety", { from: "Jita", to: "Amarr", recent_kills: true });
    expect(zk.calls.map((c) => c.path).sort()).toEqual([30000142, 30000200, 30000300].map((id) => `/api/kills/solarSystemID/${id}/pastSeconds/86400/`));
    expect(r.riskiest[0].recent_kills).toHaveLength(3);
    await run("route_safety", { from: "Jita", to: "Amarr", recent_kills: true });
    expect(zk.calls).toHaveLength(3);
  });

  test("route_safety passes preference and avoid", async () => {
    const r = await run("route_safety", { from: "Jita", to: "Amarr", preference: "secure", avoid: ["Camp"] });
    expect(r.jumps).toBe(2);
    const c = esi.calls.find((x) => x.path.startsWith("/route"))!;
    expect(c.body).toEqual({ preference: "Safer", avoid_systems: [30000300] });
  });

  test("incursions", async () => {
    const r = await run("incursions", {});
    expect(r.items).toEqual([{ constellation: "N20000020", staging_system: "N30000144", faction: "N500019", state: "established", influence: 0.5, has_boss: true, infested_systems: 2 }]);
  });

  test("military_campaigns lists, then shows one with objectives", async () => {
    const l = await run("military_campaigns", {});
    expect(l.items).toEqual([{ id: "3868eaed-8278-4cb7-9709-7d7de9c20dc7", state: "Active", progress: 50, started: "2030-01-01T00:00:00Z", finished: null }]);
    const d = await run("military_campaigns", { campaign_id: "3868eaed-8278-4cb7-9709-7d7de9c20dc7" });
    expect(d.campaign).toMatchObject({ state: "Active", progress: 50 });
    expect(d.objectives.items[0]).toMatchObject({ progress: 7, participants: { total: 4, committed: 1, contributors: 2 } });
    expect(d.objectives.items[0].id.length).toBe(40);
    expect(z.object(tools.find((t) => t.name === "military_campaigns")!.input).safeParse({ campaign_id: "../x" }).success).toBe(false);
  });

  test("sovereignty for a system and a region", async () => {
    const s = await run("sovereignty", { region_or_system: "Jita" });
    expect(s).toMatchObject({
      system: "N30000142",
      holder: { alliance: "N111", faction: null },
      is_capital: true,
      development: { military: 3, industrial: 2, strategic: 1, activity_defense_multiplier: 2.5 },
      hub_vulnerability: { start: "2030-02-01T18:00:00Z", end: "2030-02-01T20:00:00Z" },
      campaigns: [],
      raidable_skyhooks: [],
    });
    const r = await run("sovereignty", { region_or_system: 10000002 });
    expect(r).toMatchObject({ region: "N10000002", systems_in_region: 3, systems_with_sovereignty: 3 });
    expect(r.holders).toEqual([{ alliance: "N111", systems: 2 }, { faction: "N500001", systems: 1 }]);
    expect(r.raidable_skyhooks).toEqual([{ system: "N30000144", planet_id: 40000001, theft_vulnerable_from: "2030-02-01T00:00:00Z", theft_vulnerable_until: "2030-02-01T02:00:00Z" }]);
    expect(r.campaigns[0]).toMatchObject({ system: "N30000144", type: "tcu_defense", defender: "N111", defender_score: 0.6 });
  });

  test("faction_warfare lists contested systems, or one system", async () => {
    const all = await run("faction_warfare", {});
    expect(all.systems).toEqual([{ system: "N30000142", contested: "contested", occupier: "N500001", owner: "N500002", contest_percent: 50 }]);
    const one = await run("faction_warfare", { system_or_region: 30000144 });
    expect(one.systems[0]).toMatchObject({ contested: "uncontested", contest_percent: 0 });
  });

  test("intel tools are public and read-only", () => {
    for (const n of ["system_info", "route_safety", "incursions", "sovereignty", "faction_warfare"]) {
      const t = tools.find((x) => x.name === n)!;
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });
});
