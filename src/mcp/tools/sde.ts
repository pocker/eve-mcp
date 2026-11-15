import { z } from "zod";
import { sql } from "../../db/db";
import { AppError } from "../../errors";
import { charGet } from "../../esi/character";
import { PRIMARY_ATTR, REQ_ATTRS, RANK_ATTR, SECONDARY_ATTR, ATTR_NAMES, fmtDuration, requiredLevels, stepsFor, type Attrs, type Have, type Req, type Step } from "../../sde/skills";
import { attributesOf, directRequirements, requireSde, resolveSkill, resolveType, sdeBuild, skillNodes, typeNames, type TypeRow } from "../../sde/query";
import { cap, characterTool, clip, defineTool } from "./util";
import { esiTypeInfo } from "./universe";

type Row = Record<string, any>; // Bun.sql rows
const SKILLS_SCOPE = "esi-skills.read_skills.v1";
const idOrName = z.union([z.string().min(1).max(100), z.number().int().positive()]);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// SDE text is CCP's, but still capped and returned only as data.
async function marketPath(id: number | null): Promise<string | null> {
  if (!id) return null;
  const rows = await sql`
    with recursive p as (select market_group_id, parent_id, name, 0 as d from sde_market_groups where market_group_id = ${id}
      union all select m.market_group_id, m.parent_id, m.name, p.d + 1 from sde_market_groups m join p on m.market_group_id = p.parent_id where p.d < 12)
    select name from p order by d desc`;
  return rows.map((r: Row) => r.name).join(" > ") || null;
}

const levelNames = (reqs: Req[], names: Map<number, string>) => reqs.map((r) => ({ skill: names.get(r.skill) ?? `#${r.skill}`, level: r.level }));

// --- ship summary: attribute IDs from dogmaAttributes.jsonl
const A = { hi: 14, mid: 13, low: 12, rig: 1137, turrets: 102, launchers: 101, cpu: 48, pg: 11, calibration: 1132, capacitor: 482, recharge: 55, shield: 263, armor: 265, hull: 9, speed: 37, agility: 70, targetRange: 76, scanRes: 564, sig: 552, locks: 192, drone: 283, bandwidth: 1271, tech: 422 };
const RES = {
  shield: { em: 271, thermal: 274, kinetic: 273, explosive: 272 },
  armor: { em: 267, thermal: 270, kinetic: 269, explosive: 268 },
  hull: { em: 113, thermal: 110, kinetic: 109, explosive: 111 },
};

function shipSummary(t: TypeRow, a: Map<number, number>) {
  const g = (id: number) => a.get(id);
  const res = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, id]) => [k, a.has(id) ? round((1 - a.get(id)!) * 100, 1) : null]));
  const agility = g(A.agility);
  return {
    tech_level: g(A.tech),
    slots: { high: g(A.hi), mid: g(A.mid), low: g(A.low), rig: g(A.rig), turret_hardpoints: g(A.turrets), launcher_hardpoints: g(A.launchers) },
    fitting: { cpu_tf: g(A.cpu), powergrid_mw: g(A.pg), calibration: g(A.calibration) },
    capacitor: { gj: g(A.capacitor), recharge_s: g(A.recharge) ? round(g(A.recharge)! / 1000, 1) : null },
    hp: { shield: g(A.shield), armor: g(A.armor), structure: g(A.hull) },
    resists_pct: { shield: res(RES.shield), armor: res(RES.armor), hull: res(RES.hull) },
    max_velocity_ms: g(A.speed),
    align_time_s: agility && t.mass ? round((-Math.log(0.25) * agility * t.mass) / 1e6, 1) : null,
    targeting: { range_m: g(A.targetRange), scan_resolution_mm: g(A.scanRes), signature_m: g(A.sig), max_locked_targets: g(A.locks) },
    cargo_m3: t.capacity,
    drones: { bay_m3: g(A.drone), bandwidth_mbit: g(A.bandwidth) },
  };
}

// Modules and everything else: the attributes CCP publishes (shown in-game), zeroes dropped, converted to display units.
async function genericAttributes(typeId: number) {
  const rows = await sql`
    select d.name, d.display_name, d.unit_id, u.display_name as unit, a.value
    from sde_type_attributes a join sde_dogma_attributes d using (attribute_id) left join sde_units u using (unit_id)
    where a.type_id = ${typeId} and d.published and d.display_name is not null and a.value <> 0 and coalesce(d.unit_id, 0) <> all(array[115, 116, 119]) and a.attribute_id <> all(${sql.array(REQ_ATTRS.flat(), "INTEGER")})
    order by d.attribute_id`;
  const out = rows.map((r: Row) => {
    let v = Number(r.value);
    let unit: string | null = r.unit && !["None", "typeID", "attributeID", "groupID"].includes(r.unit) && !String(r.unit).startsWith("1=") ? r.unit : null;
    switch (r.unit_id) {
      case 101: v /= 1000; break;
      case 105: v *= 100; break;
      case 108: case 111: v = (1 - v) * 100; break;
      case 109: v = (v - 1) * 100; break;
    }
    return { name: clip(r.display_name, 60), value: round(v, 3), unit };
  });
  return cap(out, 40);
}

async function typeInfo(i: { type_id?: number; name?: string }) {
  if (!i.type_id && !i.name) throw new AppError("bad_input", "Give type_id or name", 400);
  const t = await resolveType(i.type_id ?? i.name!);
  const [reqs, attrs, path, build] = await Promise.all([directRequirements(t.type_id), attributesOf(t.type_id), marketPath(t.market_group_id), sdeBuild()]);
  const names = await typeNames(reqs.map((r) => r.skill));
  const isShip = t.category_id === 6;
  const out: Record<string, unknown> = {
    type_id: t.type_id,
    name: clip(t.name, 100),
    category: t.category,
    group: t.group,
    market_group: path,
    volume_m3: t.volume,
    packaged_volume_m3: t.packaged_volume,
    mass_kg: t.mass,
    description: clip(t.description, 600),
    required_skills: levelNames(reqs, names),
  };
  if (isShip) {
    out.ship = shipSummary(t, attrs);
    const m = await sql`select m.level, c.name from sde_masteries m join sde_certificates c using (cert_id) where m.type_id = ${t.type_id} order by m.level, c.name`;
    if (m.length) {
      // each mastery level includes the one before it: list only what a level adds
      const by: Record<string, string[]> = {};
      const seen = new Set<string>();
      for (const r of m) {
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        (by[["I", "II", "III", "IV", "V"][r.level - 1]!] ??= []).push(clip(r.name, 80)!);
      }
      out.mastery_certificates = by;
    }
  } else {
    out.attributes = await genericAttributes(t.type_id);
    if (t.category_id === 16) {
      out.skill = { rank: attrs.get(RANK_ATTR), primary: ATTR_NAMES[attrs.get(PRIMARY_ATTR) ?? 0], secondary: ATTR_NAMES[attrs.get(SECONDARY_ATTR) ?? 0] };
    }
  }
  out.source = `CCP SDE build ${build}`;
  return out;
}

export const getTypeInfo = defineTool({
  name: "get_type_info",
  description:
    "Static game facts about an item type (CCP static data, not live): category, group, market group, volume, mass, description, direct required skills. Ships: slots, fitting, HP, resists, speed, align time, cargo, drones, mastery certificates. Other items: their published attributes (CPU/PG need, stats). Give type_id or a name (exact, or a unique part of it). For the full skill tree use skill_requirements; for a pilot's ability use can_fly.",
  input: { type_id: z.number().int().positive().optional(), name: z.string().min(1).max(100).optional() },
  run: async (i) => ((await sdeBuild()) === null ? esiTypeInfo(i) : typeInfo(i)),
});

// --- skills

function treeFor(reqs: Req[]) {
  return skillNodes(reqs.map((r) => r.skill)).then((nodes) => ({ nodes, need: requiredLevels(reqs, nodes) }));
}

export const skillRequirements = defineTool({
  name: "skill_requirements",
  description: "Full skill prerequisite tree to use a ship, module or other item (or to train a skill): every skill once with the highest level needed, in training order (prerequisites first), with rank. Not specific to a character; for one pilot use can_fly.",
  input: { name_or_id: idOrName.describe("Item or skill name, or type ID") },
  run: async (i) => {
    await requireSde();
    const t = await resolveType(i.name_or_id);
    const direct = t.category_id === 16 ? [{ skill: t.type_id, level: 5 }] : await directRequirements(t.type_id);
    const { nodes, need } = await treeFor(direct);
    // for a skill, "requires" means what you need to train it, not the skill itself
    if (t.category_id === 16) need.delete(t.type_id);
    const skills = [...need].map(([id, level]) => {
      const n = nodes.get(id)!;
      return { skill: clip(n?.name, 100) ?? `#${id}`, level, rank: n?.rank, prerequisites: (n?.reqs ?? []).map((r) => `${nodes.get(r.skill)?.name ?? r.skill} ${r.level}`) };
    });
    return { type: clip(t.name, 100), type_id: t.type_id, direct: levelNames(direct, new Map([...nodes].map(([id, n]) => [id, n.name]))), skills: cap(skills, 80) };
  },
});

async function characterSkills(c: Parameters<typeof charGet>[0]): Promise<Have> {
  const r = (await charGet(c, SKILLS_SCOPE, `/characters/${c.character_id}/skills`)) as Row;
  const have: Have = new Map();
  for (const s of Array.isArray(r.skills) ? r.skills : []) have.set(Number(s.skill_id), { level: Number(s.trained_skill_level) || 0, sp: Number(s.skillpoints_in_skill) || 0 });
  return have;
}

async function characterAttributes(c: Parameters<typeof charGet>[0]): Promise<Attrs> {
  return (await charGet(c, SKILLS_SCOPE, `/characters/${c.character_id}/attributes`)) as Attrs;
}

const stepOut = (s: Step) => ({ skill: clip(s.skill, 100), from_level: s.from, to_level: s.to, sp: s.sp, time: fmtDuration(s.seconds) });
const totals = (steps: Step[]) => {
  const sp = steps.reduce((a, s) => a + s.sp, 0);
  const seconds = steps.reduce((a, s) => a + s.seconds, 0);
  return { total_sp: sp, total_seconds: seconds, total_time: fmtDuration(seconds) };
};
const NOTE = "Ignores the skill queue, implants and boosters beyond the attributes ESI reports.";

export const canFly = characterTool({
  name: "can_fly",
  description: "Can this character fly a ship or use a module? Compares trained skills with the full prerequisite tree. If not: missing skills (have vs need), skill points missing and training time with the character's attributes (implants ignored). For an ordered training plan use skill_plan.",
  input: { ship_or_module: idOrName.describe("Ship or module name, or type ID") },
  run: async (i, c) => {
    await requireSde();
    const t = await resolveType(i.ship_or_module);
    const direct = await directRequirements(t.type_id);
    const { nodes, need } = await treeFor(direct);
    const have = await characterSkills(c);
    const missing = [...need].filter(([id, level]) => (have.get(id)?.level ?? 0) < level);
    const base = { character: clip(c.name, 100), type: clip(t.name, 100), type_id: t.type_id, can_fly: missing.length === 0 };
    if (!missing.length) return base;
    const steps = stepsFor(need, nodes, have, await characterAttributes(c));
    return { ...base, missing: steps.map((s) => ({ ...stepOut(s), have_level: s.from, need_level: s.to })), ...totals(steps), note: NOTE };
  },
});

export const skillPlan = characterTool({
  name: "skill_plan",
  description: "Ordered skill training plan for one character, prerequisites first, from current skills and attributes (the skill queue and implants are ignored): per skill the levels, skill points and time, plus the total. Give either targets (skill + level 1-5) or for_type (a ship or module to be able to use).",
  input: {
    targets: z.array(z.object({ skill: idOrName, level: z.number().int().min(1).max(5) })).min(1).max(30).optional(),
    for_type: idOrName.optional().describe("Ship or module name, or type ID"),
  },
  run: async (i, c) => {
    if (!i.targets === !i.for_type) throw new AppError("bad_input", "Give either targets or for_type", 400);
    await requireSde();
    let roots: Req[];
    if (i.targets) roots = await Promise.all(i.targets.map(async (x) => ({ skill: (await resolveSkill(x.skill)).type_id, level: x.level })));
    else roots = await directRequirements((await resolveType(i.for_type!)).type_id);
    const nodes = await skillNodes(roots.map((r) => r.skill));
    const need = requiredLevels(roots, nodes);
    const have = await characterSkills(c);
    const pending = [...need].filter(([id, level]) => (have.get(id)?.level ?? 0) < level);
    if (!pending.length) return { character: clip(c.name, 100), steps: [], total_sp: 0, total_time: "0m", note: "Nothing to train: all requirements are met." };
    const steps = stepsFor(need, nodes, have, await characterAttributes(c));
    return { character: clip(c.name, 100), steps: cap(steps.map(stepOut), 80), ...totals(steps), note: NOTE };
  },
});

// --- blueprints

// EVE rule: rounding is per job, never below 1 per run. (Structure and rig bonuses are not applied.)
export const adjustedQuantity = (base: number, runs: number, me: number) => Math.max(runs, Math.ceil(Math.round(base * runs * (1 - me / 100) * 100) / 100));

export const blueprintInfo = defineTool({
  name: "blueprint_info",
  description: "Industry data for a blueprint, or for an item (finds its blueprint): manufacturing materials and time, products, required skills, invention and reaction data when present. With me (0-10) and runs, material quantities are adjusted for material efficiency; structure and rig bonuses are not applied. Price materials and product with hub_prices.",
  input: {
    name_or_id: idOrName.describe("Blueprint or product name, or type ID"),
    me: z.number().int().min(0).max(10).optional().describe("Material efficiency of the blueprint"),
    runs: z.number().int().min(1).max(1_000_000).default(1),
  },
  run: async (i) => {
    await requireSde();
    const t = await resolveType(i.name_or_id);
    const [bp] = await sql`
      select blueprint_id from sde_blueprints where blueprint_id = ${t.type_id}
      union all select blueprint_id from sde_blueprint_products where type_id = ${t.type_id} and activity in ('manufacturing', 'reaction')
      limit 1`;
    if (!bp) throw new AppError("not_found", `"${t.name}" is not a blueprint and no blueprint produces it.`, 404);
    const id = Number(bp.blueprint_id);
    const [acts, mats, prods, skills, [meta]] = await Promise.all([
      sql`select activity, time_seconds from sde_blueprint_activities where blueprint_id = ${id}`,
      sql`select activity, type_id, quantity from sde_blueprint_materials where blueprint_id = ${id} order by type_id`,
      sql`select activity, type_id, quantity, probability from sde_blueprint_products where blueprint_id = ${id} order by type_id`,
      sql`select activity, skill_id, level from sde_blueprint_skills where blueprint_id = ${id}`,
      sql`select max_production_limit from sde_blueprints where blueprint_id = ${id}`,
    ]);
    const names = await typeNames([id, ...mats.map((r: Row) => Number(r.type_id)), ...prods.map((r: Row) => Number(r.type_id)), ...skills.map((r: Row) => Number(r.skill_id))]);
    const nm = (x: unknown) => clip(names.get(Number(x)), 100) ?? `#${x}`;
    const activities: Record<string, unknown> = {};
    for (const a of acts) {
      const adjust = a.activity === "manufacturing" && i.me !== undefined;
      activities[a.activity] = {
        time: fmtDuration(a.time_seconds),
        time_seconds: a.time_seconds,
        materials: cap(
          mats.filter((m: Row) => m.activity === a.activity).map((m: Row) => ({ item: nm(m.type_id), quantity: adjust ? adjustedQuantity(m.quantity, i.runs, i.me!) : m.quantity, ...(adjust ? { base_quantity: m.quantity } : {}) })),
          60,
        ),
        products: prods.filter((p: Row) => p.activity === a.activity).map((p: Row) => ({ item: nm(p.type_id), quantity: p.quantity, ...(p.probability !== null ? { probability: p.probability } : {}) })),
        skills: skills.filter((s: Row) => s.activity === a.activity).map((s: Row) => ({ skill: nm(s.skill_id), level: s.level })),
      };
    }
    return { blueprint: nm(id), blueprint_id: id, max_runs: meta?.max_production_limit ?? null, ...(i.me !== undefined ? { me: i.me, runs: i.runs, note: "Quantities are for the whole job: max(runs, ceil(round(base * runs * (1 - ME/100), 2)))." } : {}), activities };
  },
});
