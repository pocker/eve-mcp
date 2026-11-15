import { z } from "zod";
import { AppError } from "../../errors";
import { cacheDelete } from "../../esi/cache";
import { charGet, charWrite } from "../../esi/character";
import { cacheKey, esiGet } from "../../esi/client";
import { lookupIds, nameMap, nm } from "../../esi/names";
import { audit } from "../../oauth/grants";
import { MAX_ITEMS, parseEft, toEft } from "./eft";
import { cap, characterTool, clip } from "./util";

const READ = "esi-fittings.read_fittings.v1";
const WRITE = "esi-fittings.write_fittings.v1";
const MAX_SHOWN = 50;
const DRONE = 18;
const FIGHTER = 87;

type Obj = Record<string, unknown>;

export const getFittings = characterTool({
  name: "get_fittings",
  description: "The character's saved ship fittings: id, name, ship and the fitting as EFT text (slots in order, then drones and cargo). Use it to see what the player already flies and fits.",
  input: {},
  run: async (_i, c) => {
    const raw = await charGet(c, READ, `/characters/${c.character_id}/fittings`);
    const all = (Array.isArray(raw) ? raw : []) as Obj[];
    const shown = all.slice(0, MAX_SHOWN);
    const itemsOf = (f: Obj) => (Array.isArray(f.items) ? (f.items as { type_id: number; flag: string; quantity: number }[]) : []);
    const names = await nameMap(shown.flatMap((f) => [Number(f.ship_type_id), ...itemsOf(f).map((i) => i.type_id)]));
    const rows = shown.map((f) => {
      const ship = nm(names, Number(f.ship_type_id)) ?? "";
      const name = clip(f.name, 100) ?? "";
      return {
        fitting_id: f.fitting_id,
        name,
        ship,
        description: clip(f.description, 300),
        eft: toEft(ship, name, itemsOf(f), (id) => nm(names, id) ?? `#${id}`),
      };
    });
    return { total: all.length, fittings: cap(rows, MAX_SHOWN), note: all.length > MAX_SHOWN ? `Only the first ${MAX_SHOWN} fittings are shown.` : undefined };
  },
});

// Exact names (case-insensitive) -> type IDs, or an error listing every name ESI does not know.
async function typeIds(names: string[]): Promise<Map<string, number>> {
  const uniq = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
  const long = uniq.filter((n) => n.length > 100);
  if (long.length) throw new AppError("bad_eft", "EFT text: an item name is longer than 100 characters", 400);
  const found = new Map<string, number>();
  for (let i = 0; i < uniq.length; i += 500) {
    const r = await lookupIds(uniq.slice(i, i + 500));
    for (const t of r.inventory_types ?? []) found.set(t.name.toLowerCase(), t.id);
  }
  const unknown = uniq.filter((n) => !found.has(n.toLowerCase()));
  if (unknown.length) throw new AppError("unknown_items", `Nothing was created. Unknown item names (must match in-game names exactly): ${unknown.slice(0, 20).map((n) => `"${n.slice(0, 60)}"`).join(", ")}${unknown.length > 20 ? `, and ${unknown.length - 20} more` : ""}`, 400);
  return found;
}

const isDroneLike = async (typeId: number) => {
  const t = (await esiGet(`/universe/types/${typeId}`)) as Obj;
  const g = (await esiGet(`/universe/groups/${t.group_id}`)) as Obj;
  return g.category_id === DRONE || g.category_id === FIGHTER ? (g.category_id as number) : 0;
};

export const createFitting = characterTool({
  name: "create_fitting",
  description:
    "CHANGES IN-GAME DATA: saves a new ship fitting on the character from EFT text (the format of the in-game Copy to clipboard). First line [Ship Type, Fitting Name] (name 1-50 characters), then blank-line separated sections: low, mid, high, rig, optional subsystems, then drones and cargo as 'Item x5'. Charges after a comma are ignored. All names must be exact in-game names; if any is unknown nothing is created. Returns the new fitting_id. Cannot edit: create a new one and delete the old. Ask the user before calling.",
  input: {
    eft: z.string().min(1).max(20_000).describe("The fitting in EFT format"),
    description: z.string().max(500).default("").describe("Optional fitting description, up to 500 characters"),
  },
  write: { destructive: false },
  run: async (i, c, grant) => {
    const eft = parseEft(i.eft);
    if (eft.name.length < 1 || eft.name.length > 50) throw new AppError("bad_eft", "EFT text: the fitting name must be 1 to 50 characters", 400);
    const ids = await typeIds([eft.ship, ...eft.slots.map((s) => s.name), ...eft.bulk.map((b) => b.name)]);
    const id = (n: string) => ids.get(n.toLowerCase())!;
    const items = eft.slots.map((s) => ({ type_id: id(s.name), flag: s.flag, quantity: 1 }));
    const bulk = new Map<string, (typeof items)[number]>(); // the same item listed twice becomes one row
    for (const b of eft.bulk) {
      const kind = await isDroneLike(id(b.name));
      const flag = kind === DRONE ? "DroneBay" : kind === FIGHTER ? "FighterBay" : "Cargo";
      const row = bulk.get(`${id(b.name)}:${flag}`) ?? { type_id: id(b.name), flag, quantity: 0 };
      row.quantity += b.quantity;
      bulk.set(`${id(b.name)}:${flag}`, row);
    }
    items.push(...bulk.values());
    if (items.length > MAX_ITEMS) throw new AppError("bad_eft", `EFT text: more than ${MAX_ITEMS} items`, 400);

    const r = (await charWrite(c, WRITE, "POST", `/characters/${c.character_id}/fittings`, {
      name: eft.name,
      description: i.description,
      ship_type_id: id(eft.ship),
      items,
    })) as Obj;
    await cacheDelete(cacheKey("GET", `/characters/${c.character_id}/fittings`, { characterId: c.character_id }));
    await audit(grant.userId, "fitting_created", { character_id: c.character_id, fitting_id: r.fitting_id, grant_id: grant.id });
    return { fitting_id: r.fitting_id, name: eft.name, ship: eft.ship, items: items.length };
  },
});

export const deleteFitting = characterTool({
  name: "delete_fitting",
  description: "CHANGES IN-GAME DATA, CANNOT BE UNDONE: permanently deletes one saved fitting from the character. Get fitting_id from get_fittings. Ask the user before calling.",
  input: { fitting_id: z.number().int().positive().describe("Fitting ID from get_fittings") },
  write: { destructive: true },
  run: async (i, c, grant) => {
    await charWrite(c, WRITE, "DELETE", `/characters/${c.character_id}/fittings/${i.fitting_id}`);
    await cacheDelete(cacheKey("GET", `/characters/${c.character_id}/fittings`, { characterId: c.character_id }));
    await audit(grant.userId, "fitting_deleted", { character_id: c.character_id, fitting_id: i.fitting_id, grant_id: grant.id });
    return { deleted: i.fitting_id };
  },
});
