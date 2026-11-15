import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/db/db";
import { setEsiFetch } from "../src/esi/client";
import type { Grant } from "../src/mcp/grant";
import { tools } from "../src/mcp/tools";
import { adjustedQuantity } from "../src/mcp/tools/sde";
import { importSde, loadedBuild, refreshSde, setSdeLatest, setSdeSource } from "../src/sde/import";
import { fmtDuration, requiredLevels, spForLevel, stepsFor, type SkillNode } from "../src/sde/skills";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, seedCharacter, seedUser, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => {
  setEsiFetch(undefined);
  setSdeSource(undefined);
  setSdeLatest(undefined);
});

const tool = (name: string) => tools.find((t) => t.name === name)!;
const call = (name: string, input: object, grant: Grant) => tool(name).run(z.object(tool(name).input).parse(input) as never, grant);
const fixture = (name: string, build = 111) => async () => ({ build, zip: new URL(`./fixtures/${name}`, import.meta.url).pathname });

describe("skill math", () => {
  test("SP per level: 250 * rank * 32^((L-1)/2), rounded up", () => {
    expect([1, 2, 3, 4, 5].map((l) => spForLevel(1, l))).toEqual([250, 1415, 8000, 45255, 256000]);
    expect(spForLevel(5, 3)).toBe(40000);
    expect(spForLevel(3, 0)).toBe(0);
  });
  test("duration text", () => {
    expect(fmtDuration(90_061)).toBe("1d 1h 1m");
    expect(fmtDuration(3600)).toBe("1h 0m");
    expect(fmtDuration(0)).toBe("0m");
  });
  test("prerequisite tree: recursive, deduped, max level, prerequisites first", () => {
    const node = (id: number, reqs: [number, number][]): SkillNode => ({ id, name: `S${id}`, rank: 1, primary: 167, secondary: 168, reqs: reqs.map(([skill, level]) => ({ skill, level })) });
    const nodes = new Map([node(1, []), node(2, [[1, 2]]), node(3, [[2, 3], [1, 4]])].map((n) => [n.id, n]));
    const need = requiredLevels([{ skill: 3, level: 2 }, { skill: 1, level: 1 }], nodes);
    expect([...need]).toEqual([[1, 4], [2, 3], [3, 2]]);
  });
  test("steps: SP missing uses the SP already in the skill; time uses primary + secondary/2", () => {
    const node: SkillNode = { id: 1, name: "S1", rank: 2, primary: 167, secondary: 168, reqs: [] };
    const steps = stepsFor(new Map([[1, 3]]), new Map([[1, node]]), new Map([[1, { level: 2, sp: 3000 }]]), { perception: 20, willpower: 10 });
    // rank 2 level 3 = 16000 SP, 13000 missing at 25 SP/min
    expect(steps).toEqual([{ skill_id: 1, skill: "S1", from: 2, to: 3, sp: 13000, seconds: 31200 }]);
  });
  test("ME rule: per job, ceil of the 2-decimal rounding, at least 1 per run", () => {
    expect(adjustedQuantity(100, 1, 10)).toBe(90);
    expect(adjustedQuantity(1, 5, 10)).toBe(5);
    expect(adjustedQuantity(3, 10, 10)).toBe(27);
    expect(adjustedQuantity(11, 1, 5)).toBe(11); // 10.45 -> 11
    expect(adjustedQuantity(100, 1, 0)).toBe(100);
  });
});

let A: { user: number; char: number; grant: Grant };
let B: { char: number };
let routes: Routes;

beforeAll(async () => {
  if (!dbAvailable) return;
  const ua = await seedUser();
  const ub = await seedUser();
  const ca = await seedCharacter(ua, "Alice", { id: 92000001 });
  const cb = await seedCharacter(ub, "Bob", { id: 92000002 });
  A = { user: ua, char: ca, grant: { id: 0, userId: ua, clientId: "t", allCharacters: true, allowWrite: false } };
  B = { char: cb };
  routes = {
    "GET /universe/types/34": () => ({ name: "Tritanium", group_id: 18, volume: 0.01, description: "ore" }),
    "GET /universe/groups/18": () => ({ name: "Mineral" }),
    [`GET /characters/${ca}/skills`]: () => ({ total_sp: 8000, unallocated_sp: 0, skills: [{ skill_id: 3300, trained_skill_level: 3, active_skill_level: 3, skillpoints_in_skill: 8000 }] }),
    [`GET /characters/${ca}/attributes`]: () => ({ perception: 20, willpower: 20, intelligence: 20, memory: 20, charisma: 20 }),
  };
});
beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  setEsiFetch(fakeEsi(routes).fetch);
});

describe.skipIf(!dbAvailable)("SDE (needs Postgres)", () => {
  test("tools are registered", () => {
    const names = tools.map((t) => t.name);
    for (const n of ["get_type_info", "skill_requirements", "can_fly", "skill_plan", "blueprint_info"]) expect(names).toContain(n);
    expect(names.filter((n) => n === "get_type_info").length).toBe(1);
  });

  test("before any import: get_type_info falls back to ESI, the other tools say the data is loading", async () => {
    expect(await loadedBuild()).toBeNull();
    const r = (await call("get_type_info", { type_id: 34 }, A.grant)) as any;
    expect(r.name).toBe("Tritanium");
    expect(r.group).toBe("Mineral");
    await expect(call("skill_requirements", { name_or_id: "Testship" }, A.grant)).rejects.toThrow(/still being imported/);
    await expect(call("can_fly", { character_id: A.char, ship_or_module: "Testship" }, A.grant)).rejects.toThrow(/still being imported/);
  });

  test("a failing import changes nothing and leaves no half-built tables", async () => {
    setSdeSource(fixture("sde-broken.zip", 5));
    await expect(importSde()).rejects.toThrow();
    expect(await loadedBuild()).toBeNull();
    const left = await sql`select table_name from information_schema.tables where table_schema = current_schema() and table_name like 'sde\\_%\\_new'`;
    expect(left.length).toBe(0);
    expect((await sql`select count(*)::int as n from sde_types`)[0]!.n).toBe(0);
  });

  test("import fills the tables, English only, published types only, records the build", async () => {
    setSdeSource(fixture("sde-mini.zip"));
    const r = await importSde();
    if (r === "busy") throw new Error("busy");
    expect(r.build).toBe(111);
    expect(r.rows.sde_types).toBe(8); // the unpublished type is skipped
    expect(r.rows.sde_blueprint_materials).toBe(3);
    expect(await loadedBuild()).toBe(111);
    const [t] = await sql`select name, description from sde_types where type_id = 100001`;
    expect(t!.name).toBe("Testship");
    expect(t!.description.length).toBe(1000);
    expect((await sql`select count(*)::int as n from sde_type_attributes where type_id = 999`)[0]!.n).toBe(0);
    expect((await sql`select level, cert_id from sde_masteries order by level`).map((m: any) => m.level)).toEqual([1, 2]);
  });

  test("importing again replaces the data (swap works twice) and updates the build", async () => {
    setSdeSource(fixture("sde-mini.zip", 222));
    await importSde();
    expect((await sql`select count(*)::int as n from sde_types`)[0]!.n).toBe(8);
    expect((await sql`select count(*)::int as n from sde_meta`)[0]!.n).toBe(1);
  });

  test("refreshSde imports only when the CCP build differs", async () => {
    let imports = 0;
    setSdeSource(async () => (imports++, fixture("sde-mini.zip", 333)()));
    setSdeLatest(async () => 111); // the loaded build comes from the zip's _sde.jsonl
    await refreshSde();
    expect(imports).toBe(0);
    setSdeLatest(async () => 222);
    await refreshSde();
    expect(imports).toBe(1);
  });

  test("get_type_info: ship summary, module attributes, name matching", async () => {
    const s = (await call("get_type_info", { name: "testship" }, A.grant)) as any;
    expect(s.category).toBe("Ship");
    expect(s.market_group).toBe("Ships > Cruisers");
    expect(s.description.length).toBe(600);
    expect(s.ship.slots).toMatchObject({ high: 5, mid: 3, low: 4, rig: 3 });
    expect(s.ship.resists_pct.shield).toMatchObject({ em: 50, thermal: 80 });
    expect(s.ship.align_time_s).toBe(41.6); // -ln(0.25) * 3.0 * 1e7 / 1e6
    expect(s.ship.cargo_m3).toBe(450);
    expect(s.required_skills).toEqual([{ skill: "Medium Hybrid Turret", level: 2 }, { skill: "Gunnery", level: 4 }]);
    expect(s.mastery_certificates).toEqual({ I: ["Test Certificate"] }) // level II has the same certificate, so it adds nothing;
    const m = (await call("get_type_info", { name: "Test Module" }, A.grant)) as any;
    expect(m.attributes.items).toEqual([{ name: "Powergrid Usage", value: 10, unit: "MW" }, { name: "CPU usage", value: 30, unit: "tf" }, { name: "Rate of fire", value: 2, unit: "s" }]);
    expect((await call("get_type_info", { name: "Medium Hybrid" }, A.grant) as any).type_id).toBe(3302); // unique substring
    await expect(call("get_type_info", { name: "Hybrid Turret" }, A.grant)).rejects.toThrow(/Did you mean/); // two matches
    await expect(call("get_type_info", { name: "Hidden Ship" }, A.grant)).rejects.toThrow(/No item named/);
  });

  test("skill_requirements: deduped tree, max level, prerequisites first", async () => {
    const r = (await call("skill_requirements", { name_or_id: "Testship" }, A.grant)) as any;
    expect(r.skills.items.map((s: any) => [s.skill, s.level])).toEqual([["Gunnery", 4], ["Small Hybrid Turret", 3], ["Medium Hybrid Turret", 2]]);
    expect(r.skills.items[2].prerequisites).toEqual(["Small Hybrid Turret 3"]);
    const sk = (await call("skill_requirements", { name_or_id: 3302 }, A.grant)) as any; // a skill: what it takes to train it
    expect(sk.skills.items.map((s: any) => s.skill)).toEqual(["Gunnery", "Small Hybrid Turret"]);
  });

  test("can_fly: missing skills with SP and time from the character's attributes", async () => {
    const r = (await call("can_fly", { character_id: A.char, ship_or_module: "Testship" }, A.grant)) as any;
    expect(r.can_fly).toBe(false);
    // 30 SP/min (20 + 20/2). Gunnery 3 -> 4: 45255-8000; Small 0 -> 3: 8000; Medium (rank 3) 0 -> 2: 4243
    expect(r.missing.map((m: any) => [m.skill, m.have_level, m.need_level, m.sp])).toEqual([["Gunnery", 3, 4, 37255], ["Small Hybrid Turret", 0, 3, 8000], ["Medium Hybrid Turret", 0, 2, 4243]]);
    expect(r.total_sp).toBe(49498);
    expect(r.total_seconds).toBe(98996);
    expect(r.total_time).toBe("1d 3h 29m");
    const ok = (await call("can_fly", { character_id: A.char, ship_or_module: "Test Module" }, A.grant)) as any;
    expect(ok.can_fly).toBe(false); // needs Small Hybrid Turret 1
    routes[`GET /characters/${A.char}/skills`] = () => ({ skills: [{ skill_id: 3300, trained_skill_level: 5, skillpoints_in_skill: 256000 }, { skill_id: 3301, trained_skill_level: 3, skillpoints_in_skill: 8000 }, { skill_id: 3302, trained_skill_level: 2, skillpoints_in_skill: 4243 }] });
    setEsiFetch(fakeEsi(routes).fetch);
    await resetEsi();
    expect(await call("can_fly", { character_id: A.char, ship_or_module: "Testship" }, A.grant)).toMatchObject({ can_fly: true });
  });

  test("skill_plan: ordered steps, totals, input rules", async () => {
    routes[`GET /characters/${A.char}/skills`] = () => ({ skills: [{ skill_id: 3300, trained_skill_level: 3, skillpoints_in_skill: 8000 }] });
    setEsiFetch(fakeEsi(routes).fetch);
    await resetEsi();
    const r = (await call("skill_plan", { character_id: A.char, targets: [{ skill: "Medium Hybrid Turret", level: 3 }] }, A.grant)) as any;
    // Gunnery is trained to III already (Small needs II): no step. Small to III, then Medium (rank 3) to III = 24000.
    expect(r.steps.items.map((s: any) => [s.skill, s.from_level, s.to_level, s.sp])).toEqual([["Small Hybrid Turret", 0, 3, 8000], ["Medium Hybrid Turret", 0, 3, 24000]]);
    expect(r.total_sp).toBe(32000);
    const t = (await call("skill_plan", { character_id: A.char, for_type: "Testship" }, A.grant)) as any;
    expect(t.steps.items.map((s: any) => s.skill)).toEqual(["Gunnery", "Small Hybrid Turret", "Medium Hybrid Turret"]);
    await expect(call("skill_plan", { character_id: A.char }, A.grant)).rejects.toThrow(/either targets or for_type/);
    await expect(call("skill_plan", { character_id: A.char, targets: [{ skill: "Testship", level: 1 }] }, A.grant)).rejects.toThrow(/not a skill/);
  });

  test("character tools refuse another user's character", async () => {
    await expect(call("can_fly", { character_id: B.char, ship_or_module: "Testship" }, A.grant)).rejects.toThrow(/not available/);
    await expect(call("skill_plan", { character_id: B.char, for_type: "Testship" }, A.grant)).rejects.toThrow(/not available/);
  });

  test("blueprint_info: found by product name, ME-adjusted quantities, invention", async () => {
    const r = (await call("blueprint_info", { name_or_id: "Test Module", me: 10, runs: 10 }, A.grant)) as any;
    expect(r.blueprint).toBe("Test Module Blueprint");
    expect(r.max_runs).toBe(300);
    const m = r.activities.manufacturing;
    expect(m.time_seconds).toBe(600);
    expect(m.materials.items).toEqual([{ item: "Tritanium", quantity: 900, base_quantity: 100 }, { item: "Pyerite", quantity: 10, base_quantity: 1 }]); // 1 * 10 runs at ME 10 is 9, floor of 1 per run
    expect(m.products).toEqual([{ item: "Test Module", quantity: 1 }]);
    expect(m.skills).toEqual([{ skill: "Gunnery", level: 1 }]);
    expect(r.activities.invention.products).toEqual([{ item: "Test Module Blueprint", quantity: 1, probability: 0.3 }]);
    const plain = (await call("blueprint_info", { name_or_id: "Test Module Blueprint" }, A.grant)) as any;
    expect(plain.activities.manufacturing.materials.items[0]).toEqual({ item: "Tritanium", quantity: 100 });
    await expect(call("blueprint_info", { name_or_id: "Tritanium" }, A.grant)).rejects.toThrow(/not a blueprint/);
  });
});
