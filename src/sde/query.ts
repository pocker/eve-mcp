import { AppError } from "../errors";
import { sql } from "../db/db";
import { PRIMARY_ATTR, RANK_ATTR, REQ_ATTRS, SECONDARY_ATTR, type Req, type SkillNode } from "./skills";

type Row = Record<string, any>; // Bun.sql rows

export async function sdeBuild(): Promise<number | null> {
  const [r] = await sql`select build_number from sde_meta limit 1`;
  return r ? Number(r.build_number) : null;
}

export async function requireSde(): Promise<void> {
  if ((await sdeBuild()) === null) throw new AppError("sde_not_loaded", "Static game data is still being imported (first start takes a few minutes). Try again in a minute; meanwhile get_type_info and wiki_search still work.", 503);
}

export type TypeRow = { type_id: number; name: string; group_id: number; description: string | null; market_group_id: number | null; volume: number | null; packaged_volume: number | null; mass: number | null; capacity: number | null; group: string; category_id: number; category: string };

const typeSql = () => sql`
  select t.*, g.name as "group", g.category_id, c.name as category
  from sde_types t join sde_groups g using (group_id) join sde_categories c using (category_id)`;

function norm(r: Row): TypeRow {
  return { ...(r as TypeRow), type_id: Number(r.type_id) };
}

export async function typeById(id: number): Promise<TypeRow | undefined> {
  const [r] = await sql`${typeSql()} where t.type_id = ${id}`;
  return r ? norm(r) : undefined;
}

// Exact name (any case) first, then a unique substring match; otherwise a not_found error with a few suggestions.
export async function resolveType(q: string | number): Promise<TypeRow> {
  if (typeof q === "number" || /^\d+$/.test(q)) {
    const t = await typeById(Number(q));
    if (!t) throw new AppError("not_found", `No item type with ID ${q}.`, 404);
    return t;
  }
  const exact = await sql`${typeSql()} where lower(t.name) = lower(${q}) order by t.type_id limit 1`;
  if (exact[0]) return norm(exact[0]);
  const like = `%${q.replace(/[\\%_]/g, "\\$&").toLowerCase()}%`;
  const hits = await sql`${typeSql()} where lower(t.name) like ${like} order by length(t.name), t.name limit 6`;
  if (hits.length === 1) return norm(hits[0]!);
  const hint = hits.length ? ` Did you mean: ${hits.map((h: Row) => h.name).join(", ")}?` : "";
  throw new AppError("not_found", `No item named "${q.slice(0, 60)}".${hint}`, 404);
}

function reqsFrom(vals: Map<number, number>): Req[] {
  const out: Req[] = [];
  for (const [s, l] of REQ_ATTRS) {
    const skill = vals.get(s);
    const level = vals.get(l);
    if (skill && level) out.push({ skill, level });
  }
  return out;
}

// Direct skill requirements of an item (ships, modules, ...). Skills themselves use skillNodes().
export async function directRequirements(typeId: number): Promise<Req[]> {
  const rows = await sql`select attribute_id, value from sde_type_attributes where type_id = ${typeId} and attribute_id = any(${sql.array(REQ_ATTRS.flat(), "INTEGER")})`;
  return reqsFrom(new Map(rows.map((r: Row) => [Number(r.attribute_id), Number(r.value)])));
}

// Loads the skills and, level by level, all their prerequisites.
export async function skillNodes(ids: number[]): Promise<Map<number, SkillNode>> {
  const nodes = new Map<number, SkillNode>();
  let todo = [...new Set(ids)];
  const attrIds = sql.array([...REQ_ATTRS.flat(), RANK_ATTR, PRIMARY_ATTR, SECONDARY_ATTR], "INTEGER");
  while (todo.length) {
    const rows = await sql`
      select t.type_id, t.name, a.attribute_id, a.value from sde_types t
      left join sde_type_attributes a on a.type_id = t.type_id and a.attribute_id = any(${attrIds})
      where t.type_id = any(${sql.array(todo, "BIGINT")})`;
    const by = new Map<number, { name: string; vals: Map<number, number> }>();
    for (const r of rows) {
      const e = by.get(Number(r.type_id)) ?? { name: r.name, vals: new Map() };
      if (r.attribute_id !== null) e.vals.set(Number(r.attribute_id), Number(r.value));
      by.set(Number(r.type_id), e);
    }
    todo = [];
    for (const [id, e] of by) {
      const reqs = reqsFrom(e.vals);
      nodes.set(id, { id, name: e.name, rank: e.vals.get(RANK_ATTR) ?? 1, primary: e.vals.get(PRIMARY_ATTR) ?? null, secondary: e.vals.get(SECONDARY_ATTR) ?? null, reqs });
      for (const r of reqs) if (!nodes.has(r.skill) && !todo.includes(r.skill)) todo.push(r.skill);
    }
  }
  return nodes;
}

export async function resolveSkill(q: string | number): Promise<TypeRow> {
  const t = await resolveType(q);
  if (t.category_id !== 16) throw new AppError("not_a_skill", `"${t.name}" is not a skill.`, 400);
  return t;
}

export async function typeNames(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await sql`select type_id, name from sde_types where type_id = any(${sql.array([...new Set(ids)], "BIGINT")})`;
  return new Map(rows.map((r: Row) => [Number(r.type_id), String(r.name)]));
}

export async function attributesOf(typeId: number): Promise<Map<number, number>> {
  const rows = await sql`select attribute_id, value from sde_type_attributes where type_id = ${typeId}`;
  return new Map(rows.map((r: Row) => [Number(r.attribute_id), Number(r.value)]));
}
