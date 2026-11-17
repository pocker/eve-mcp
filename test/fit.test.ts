import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/db/db";
import { setEsiFetch } from "../src/esi/client";
import type { Grant } from "../src/mcp/grant";
import { tools } from "../src/mcp/tools";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, seedCharacter, seedUser, type Call, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => setEsiFetch(undefined));

const RIFTER = `[Rifter, Test]
Damage Control II
Small Armor Repairer II
200mm Steel Plates II

1MN Afterburner II
Warp Scrambler II
Stasis Webifier II

200mm AutoCannon II, EMP S
200mm AutoCannon II, EMP S
200mm AutoCannon II, EMP S

Small Core Defense Field Extender I
`;

let A: { user: number; char: number; grant: Grant };
let B: { char: number };
let calls: Call[];
let skills: unknown[] = [];

const tool = tools.find((t) => t.name === "fit_stats")!;
const call = (input: object, grant: Grant) => tool.run(z.object(tool.input).parse(input) as never, grant) as Promise<any>;

beforeAll(async () => {
  if (!dbAvailable) return;
  const ua = await seedUser();
  const ub = await seedUser();
  A = { user: ua, char: await seedCharacter(ua, "Alice", { id: 93000001 }), grant: { id: 7, userId: ua, clientId: "t", allCharacters: true, allowWrite: false } };
  B = { char: await seedCharacter(ub, "Bob", { id: 93000002 }) };
});
beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  const routes: Routes = { [`GET /characters/${A.char}/skills`]: () => ({ total_sp: 0, unallocated_sp: 0, skills }) };
  const esi = fakeEsi(routes);
  calls = esi.calls;
  setEsiFetch(esi.fetch);
});

test("fit_stats is a read-only tool", () => {
  expect(tool.annotations.readOnlyHint).toBe(true);
  expect(tool.write).toBe(false);
});

describe("fit_stats without a character (All V, no DB needed for the call itself)", () => {
  test("a Rifter fit returns sane numbers and makes no ESI call", async () => {
    const r = await call({ eft: RIFTER }, { id: 1, userId: 1, clientId: "t", allCharacters: true, allowWrite: false });
    expect(r.ship).toBe("Rifter");
    expect(r.skills).toBe("All V");
    expect(r.offense.dps).toBeGreaterThan(50);
    expect(r.offense.alpha).toBeGreaterThan(0);
    expect(r.offense.weapons.items[0]).toMatchObject({ weapon: "200mm AutoCannon II", count: 3 });
    expect(r.defense.ehp_total_uniform_damage).toBeGreaterThan(1000);
    expect(r.defense.armor.resists_percent.em).toBeGreaterThan(30);
    expect(r.navigation.max_velocity_ms).toBeGreaterThan(500);
    expect(r.capacitor.capacity).toBeGreaterThan(100);
    expect(r.fitting.cpu.max).toBeGreaterThan(100);
    expect(r.warnings.items).toEqual([]);
    expect(JSON.stringify(r).length).toBeLessThan(6000);
  });

  test("bad EFT is a bad_eft error; unknown items are warnings, not a crash", async () => {
    const g = { id: 1, userId: 1, clientId: "t", allCharacters: true, allowWrite: false };
    await expect(call({ eft: "garbage" }, g)).rejects.toMatchObject({ code: "bad_eft", status: 400 });
    await expect(call({ eft: "[No Such Ship, x]\nFoo" }, g)).rejects.toMatchObject({ code: "bad_eft" });
    const r = await call({ eft: "[Rifter, x]\n\n\n200mm AutoCannon II\nTotally Fake Module" }, g);
    expect(r.warnings.items[0].text).toContain("Totally Fake Module");
    expect(() => z.object(tool.input).parse({ eft: "x".repeat(20_001) })).toThrow();
  });
});

describe.skipIf(!dbAvailable)("fit_stats with a character (needs Postgres)", () => {
  test("uses the character's skills from ESI and lists what it cannot use", async () => {
    skills = [{ skill_id: 3300, trained_skill_level: 1, active_skill_level: 1, skillpoints_in_skill: 250 }];
    const allV = await call({ eft: RIFTER }, A.grant);
    const mine = await call({ eft: RIFTER, character_id: A.char }, A.grant);
    expect(calls.filter((c) => c.path === `/characters/${A.char}/skills`).length).toBe(1);
    expect(mine.skills).toBe("Alice's trained skills");
    expect(mine.offense.dps).toBeLessThan(allV.offense.dps);
    expect(mine.unmet_skills.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine.unmet_skills)).toContain("200mm AutoCannon II");
  });

  test("another user's character, and a character outside a limited grant, are refused before any ESI call", async () => {
    await expect(call({ eft: RIFTER, character_id: B.char }, A.grant)).rejects.toMatchObject({ code: "character_not_allowed" });
    await sql`insert into oauth_clients (client_id, name, redirect_uris) values ('c1', 'c', ${sql.array(["http://x/cb"], "TEXT")}) on conflict do nothing`;
    const [g] = await sql`insert into grants (user_id, client_id, all_characters) values (${A.user}, 'c1', false) returning id`;
    const limited: Grant = { id: Number(g!.id), userId: A.user, clientId: "c1", allCharacters: false, allowWrite: false };
    await expect(call({ eft: RIFTER, character_id: A.char }, limited)).rejects.toMatchObject({ code: "character_not_allowed" });
    expect(calls.length).toBe(0);
  });

  test("a character without the skills scope gets the usual re-link error", async () => {
    const id = await seedCharacter(A.user, "Limited", { scopes: ["esi-wallet.read_character_wallet.v1"] });
    await expect(call({ eft: RIFTER, character_id: id }, A.grant)).rejects.toThrow(/esi-skills\.read_skills/);
  });
});
