import { z } from "zod";
import { esiGet } from "../../esi/client";
import { lookupIds, nameMap, nm } from "../../esi/names";
import { AppError } from "../../errors";
import { gateRoute } from "../../intel/intel";
import { cap, clip, defineTool } from "./util";

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

// "Jita" or 30000142 -> ID. Throws a clear error when the name matches nothing.
async function toId(v: string | number, category: string): Promise<number> {
  if (typeof v === "number") return v;
  if (/^\d+$/.test(v)) return Number(v);
  const hit = (await lookupIds([v]))[category]?.[0];
  if (!hit) throw new AppError("not_found", `No ${category.replaceAll("_", " ")} named "${v.slice(0, 60)}". Names must match exactly; try resolve_names.`, 404);
  return hit.id;
}

const idOrName = z.union([z.string().min(1).max(100), z.number().int().positive()]);

export const resolveNames = defineTool({
  name: "resolve_names",
  description: "Turn exact EVE names (characters, systems, stations, regions, item types, corporations...) into IDs, grouped by category. Case does not matter, spelling must be exact. Most other tools already accept names, so use this only for ambiguous or unknown names.",
  input: { names: z.array(z.string().min(1).max(100)).min(1).max(100).describe("Exact names, up to 100") },
  run: async (i) => {
    const r = await lookupIds(i.names);
    return Object.fromEntries(Object.entries(r).map(([cat, rows]) => [cat, cap(rows.map((x) => ({ id: x.id, name: clip(x.name, 100) })), 100)]));
  },
});

// ESI fallback for get_type_info (src/mcp/tools/sde.ts) while the SDE is not imported yet.
export async function esiTypeInfo(i: { type_id?: number; name?: string }) {
  if (!i.type_id && !i.name) throw new AppError("bad_input", "Give type_id or name", 400);
  const id = i.type_id ?? (await toId(i.name!, "inventory_types"));
  const t = (await esiGet(`/universe/types/${id}`)) as Obj;
  const group = t.group_id ? ((await esiGet(`/universe/groups/${t.group_id}`).catch(() => ({}))) as Obj) : {};
  return {
    type_id: id,
    name: clip(t.name, 100),
    group: clip(group.name, 100),
    group_id: t.group_id,
    market_group_id: t.market_group_id,
    volume: t.volume,
    packaged_volume: t.packaged_volume,
    mass: t.mass,
    capacity: t.capacity,
    published: t.published,
    description: clip(t.description, 600),
  };
}

export const planRoute = defineTool({
  name: "plan_route",
  description: "Gate route between two solar systems (names or IDs): jump count and system list. flag: shortest (default), secure (high-sec preferred) or insecure. Wormholes (Thera, Turnur) and jump bridges are not used; for wormhole shortcuts see thera_connections. For danger on the way use route_safety.",
  input: { from: idOrName.describe("Start system name or ID"), to: idOrName.describe("Destination system name or ID"), flag: z.enum(["shortest", "secure", "insecure"]).default("shortest") },
  run: async (i) => {
    const [from, to] = await Promise.all([toId(i.from, "systems"), toId(i.to, "systems")]);
    const route = await gateRoute(from, to, i.flag);
    if (route.length === 0) throw new AppError("not_found", "No gate route between those systems.", 404);
    const names = await nameMap(route);
    return { jumps: Math.max(0, route.length - 1), systems: cap(route.map((id) => nm(names, id)), 150) };
  },
});

export const getServerStatus = defineTool({
  name: "get_server_status",
  description: "Whether Tranquility (the live server) is up, the player count and server version.",
  input: {},
  run: async () => {
    const s = (await esiGet("/status")) as Obj;
    return { players: s.players, server_version: s.server_version, started: s.start_time, vip_mode: s.vip };
  },
});

