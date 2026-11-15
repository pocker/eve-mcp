import { AppError } from "../../errors";

// EFT text <-> ESI fitting items. Flag names are the enum in the ESI OpenAPI schema.
const SECTIONS = [
  { prefix: "LoSlot", label: "Low", max: 8 },
  { prefix: "MedSlot", label: "Mid", max: 8 },
  { prefix: "HiSlot", label: "High", max: 8 },
  { prefix: "RigSlot", label: "Rig", max: 3 },
  { prefix: "SubSystemSlot", label: "Subsystem", max: 4 },
] as const;

export const MAX_ITEMS = 512; // ESI limit
const MAX_QTY = 1_000_000_000;

export type EftSlot = { flag: string; name: string };
export type EftBulk = { name: string; quantity: number };
export type Eft = { ship: string; name: string; slots: EftSlot[]; bulk: EftBulk[] };

const bad = (m: string) => new AppError("bad_eft", `EFT text: ${m}`, 400);
const QTY = /^(.+?)\s+x(\d+)$/i;

// Sections are blocks separated by blank lines: low, mid, high, rig, then subsystems (only if no line has "xN"), then drones and cargo.
// shortcut: a missing section without its "[Empty ... slot]" placeholder shifts the others; EFT exports always have placeholders.
// Charges ("Module, Charge") are ignored: ESI fittings only need the module, and the charge is cheap to reload in game.
export function parseEft(text: string): Eft {
  const lines = text.replaceAll("\r", "").split("\n").map((l) => l.trim());
  while (lines[0] === "") lines.shift();
  const head = lines.shift()?.match(/^\[([^,\]]+),\s*(.+)\]$/);
  if (!head) throw bad("the first line must look like [Ship Type, Fitting Name]");
  const ship = head[1]!.trim();
  const name = head[2]!.trim();

  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);

  const slots: EftSlot[] = [];
  const bulk: EftBulk[] = [];
  blocks.forEach((b, n) => {
    const sec = SECTIONS[n];
    if (sec && (n < 4 || !b.some((l) => QTY.test(l)))) {
      if (b.length > sec.max) throw bad(`${b.length} lines in the ${sec.label.toLowerCase()} slot section, at most ${sec.max}`);
      b.forEach((l, i) => {
        if (/^\[empty .*\]$/i.test(l)) return;
        const module = l.split(", ")[0]!.replace(/\s*\/offline$/i, "").trim();
        slots.push({ flag: `${sec.prefix}${i}`, name: module });
      });
    } else {
      for (const l of b) {
        if (/^\[empty .*\]$/i.test(l)) continue;
        const m = l.match(QTY);
        const quantity = m ? Number(m[2]) : 1;
        if (quantity < 1 || quantity > MAX_QTY) throw bad(`quantity out of range in "${l.slice(0, 60)}"`);
        bulk.push({ name: (m ? m[1]! : l).trim(), quantity });
      }
    }
  });
  if (slots.length + bulk.length === 0) throw bad("no items found");
  if (slots.length + bulk.length > MAX_ITEMS) throw bad(`more than ${MAX_ITEMS} items`);
  return { ship, name, slots, bulk };
}

type Item = { type_id: number; flag: string; quantity: number };

// ESI items -> EFT text. Several items on one slot flag (module + charge) print as "A, B".
export function toEft(ship: string, name: string, items: Item[], nameOf: (id: number) => string): string {
  const out: string[] = [`[${ship}, ${name}]`];
  SECTIONS.forEach((sec, n) => {
    const slots = new Map<number, string[]>();
    for (const it of items) {
      const m = it.flag.startsWith(sec.prefix) ? it.flag.slice(sec.prefix.length) : "";
      if (/^\d+$/.test(m)) slots.set(Number(m), [...(slots.get(Number(m)) ?? []), nameOf(it.type_id)]);
    }
    if (n === 4 && slots.size === 0) return;
    const lines: string[] = [];
    for (let i = 0; i <= Math.max(-1, ...slots.keys()); i++) lines.push(slots.get(i)?.join(", ") ?? `[Empty ${sec.label} slot]`);
    out.push("", ...(lines.length ? lines : [`[Empty ${sec.label} slot]`]));
  });
  for (const flags of [["DroneBay", "FighterBay"], ["Cargo"]]) {
    const rows = items.filter((it) => flags.includes(it.flag));
    if (rows.length) out.push("", ...rows.map((it) => `${nameOf(it.type_id)} x${it.quantity}`));
  }
  return out.join("\n");
}
