import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../db/db";
import { log } from "../log";

// Fixed host, never user input. latest.jsonl is a 79-byte file with the current build number.
const HOST = "https://developers.eveonline.com";
const LATEST_URL = `${HOST}/static-data/tranquility/latest.jsonl`;
const zipUrl = (build: number) => `${HOST}/static-data/tranquility/eve-online-static-data-${build}-jsonl.zip`;
const LOCK_ID = 727003;
const MAX_ZIP_BYTES = 400 * 1024 * 1024; // the zip was ~100 MB in 2026
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DESCRIPTION = 1000;

type Row = Record<string, unknown>;
type Obj = Record<string, any>; // JSON edge: CCP's JSONL, read defensively below
const en = (v: unknown): string | null => (v && typeof v === "object" && typeof (v as Obj).en === "string" ? (v as Obj).en : null);

// Injectable for tests: a local zip instead of the download. Returns the build number.
let sourceOverride: (() => Promise<{ build: number; zip: string; cleanup?: () => Promise<void> }>) | undefined;
export const setSdeSource = (f: typeof sourceOverride) => void (sourceOverride = f);

let latestOverride: (() => Promise<number>) | undefined;
export const setSdeLatest = (f: typeof latestOverride) => void (latestOverride = f);

export async function latestBuild(): Promise<number> {
  if (latestOverride) return latestOverride();
  const r = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!r.ok) throw new Error(`SDE latest.jsonl: HTTP ${r.status}`);
  const build = JSON.parse((await r.text()).slice(0, 1000)).buildNumber;
  if (!Number.isInteger(build) || build <= 0) throw new Error("SDE latest.jsonl: no build number");
  return build;
}

async function download(): Promise<{ build: number; zip: string; cleanup: () => Promise<void> }> {
  const build = await latestBuild();
  const dir = await mkdtemp(join(tmpdir(), "sde-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const url = zipUrl(build);
    const r = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!r.ok || !r.body) throw new Error(`SDE download: HTTP ${r.status}`);
    if (new URL(r.url).origin !== HOST) throw new Error("SDE download redirected off the CCP host");
    if (Number(r.headers.get("content-length") ?? 0) > MAX_ZIP_BYTES) throw new Error("SDE download too large");
    const zip = join(dir, "sde.zip");
    const out = Bun.file(zip).writer();
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > MAX_ZIP_BYTES) throw new Error("SDE download too large");
      out.write(chunk);
    }
    await out.end();
    return { build, zip, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// One JSON object per line, streamed out of the zip by `unzip -p` (nothing is extracted or held whole in memory).
async function* jsonl(zip: string, file: string): AsyncGenerator<Obj> {
  const p = Bun.spawn(["unzip", "-p", zip, file], { stdout: "pipe", stderr: "ignore" });
  try {
    const dec = new TextDecoder();
    let rest = "";
    for await (const chunk of p.stdout) {
      const lines = (rest + dec.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop()!;
      for (const l of lines) if (l) yield JSON.parse(l);
    }
    rest += dec.decode();
    if (rest.trim()) yield JSON.parse(rest);
    if ((await p.exited) !== 0) throw new Error(`unzip failed for ${file}`);
  } finally {
    p.kill();
  }
}

// Bun.sql allows 65535 parameters per statement.
type Tx = typeof sql;
function sink(tx: Tx, table: string, cols: number) {
  const size = Math.floor(30000 / cols);
  let buf: Row[] = [];
  let count = 0;
  const flush = async () => {
    if (!buf.length) return;
    await tx`insert into ${tx(table + "_new")} ${tx(buf)}`;
    count += buf.length;
    buf = [];
  };
  return {
    add: async (r: Row) => {
      buf.push(r);
      if (buf.length >= size) await flush();
    },
    done: async () => (await flush(), count),
  };
}

const TABLES = ["sde_types", "sde_groups", "sde_categories", "sde_market_groups", "sde_dogma_attributes", "sde_units", "sde_type_attributes", "sde_blueprints", "sde_blueprint_activities", "sde_blueprint_materials", "sde_blueprint_products", "sde_blueprint_skills", "sde_certificates", "sde_masteries"];

async function load(zip: string, tx: Tx) {
  for (const t of TABLES) await tx.unsafe(`create table ${t}_new (like ${t} including all)`); // constant names, no input
  const counts: Record<string, number> = {};
  const fill = async (table: string, cols: number, file: string, map: (d: Obj, add: (r: Row) => Promise<void>) => Promise<void>) => {
    const s = sink(tx, table, cols);
    for await (const d of jsonl(zip, file)) await map(d, s.add);
    counts[table] = await s.done();
  };

  const published = new Set<number>();
  await fill("sde_types", 10, "types.jsonl", async (d, add) => {
    const name = en(d.name);
    if (!d.published || !name) return;
    published.add(d._key);
    await add({
      type_id: d._key, group_id: d.groupID, name, description: en(d.description)?.slice(0, MAX_DESCRIPTION) ?? null, market_group_id: d.marketGroupID ?? null,
      volume: d.volume ?? null, packaged_volume: d.packagedVolume ?? null, mass: d.mass ?? null, capacity: d.capacity ?? null, portion_size: d.portionSize ?? null,
    });
  });
  await fill("sde_groups", 3, "groups.jsonl", (d, add) => add({ group_id: d._key, category_id: d.categoryID, name: en(d.name) ?? `#${d._key}` }));
  await fill("sde_categories", 2, "categories.jsonl", (d, add) => add({ category_id: d._key, name: en(d.name) ?? `#${d._key}` }));
  await fill("sde_market_groups", 3, "marketGroups.jsonl", (d, add) => add({ market_group_id: d._key, parent_id: d.parentGroupID ?? null, name: en(d.name) ?? `#${d._key}` }));
  await fill("sde_dogma_attributes", 5, "dogmaAttributes.jsonl", (d, add) =>
    add({ attribute_id: d._key, name: String(d.name ?? d._key), display_name: en(d.displayName), unit_id: d.unitID ?? null, published: !!d.published }));
  await fill("sde_units", 2, "dogmaUnits.jsonl", (d, add) => add({ unit_id: d._key, display_name: en(d.displayName) }));
  await fill("sde_type_attributes", 3, "typeDogma.jsonl", async (d, add) => {
    if (!published.has(d._key)) return;
    for (const a of d.dogmaAttributes ?? []) await add({ type_id: d._key, attribute_id: a.attributeID, value: a.value });
  });

  // Blueprints: four tables from one file, so it has its own sinks.
  const bp = { b: sink(tx, "sde_blueprints", 2), a: sink(tx, "sde_blueprint_activities", 3), m: sink(tx, "sde_blueprint_materials", 4), p: sink(tx, "sde_blueprint_products", 5), s: sink(tx, "sde_blueprint_skills", 4) };
  for await (const d of jsonl(zip, "blueprints.jsonl")) {
    if (!published.has(d._key)) continue;
    await bp.b.add({ blueprint_id: d._key, max_production_limit: d.maxProductionLimit ?? null });
    for (const [activity, v] of Object.entries<Obj>(d.activities ?? {})) {
      await bp.a.add({ blueprint_id: d._key, activity, time_seconds: v.time ?? 0 });
      for (const m of v.materials ?? []) await bp.m.add({ blueprint_id: d._key, activity, type_id: m.typeID, quantity: m.quantity });
      for (const x of v.products ?? []) await bp.p.add({ blueprint_id: d._key, activity, type_id: x.typeID, quantity: x.quantity, probability: x.probability ?? null });
      for (const k of v.skills ?? []) await bp.s.add({ blueprint_id: d._key, activity, skill_id: k.typeID, level: k.level });
    }
  }
  counts.sde_blueprints = await bp.b.done();
  counts.sde_blueprint_activities = await bp.a.done();
  counts.sde_blueprint_materials = await bp.m.done();
  counts.sde_blueprint_products = await bp.p.done();
  counts.sde_blueprint_skills = await bp.s.done();

  await fill("sde_certificates", 2, "certificates.jsonl", (d, add) => add({ cert_id: d._key, name: en(d.name) ?? `#${d._key}` }));
  await fill("sde_masteries", 3, "masteries.jsonl", async (d, add) => {
    for (const lvl of d._value ?? []) for (const cert of lvl._value ?? []) await add({ type_id: d._key, level: lvl._key + 1, cert_id: cert });
  });
  return counts;
}

export type ImportResult = { build: number; seconds: number; rows: Record<string, number> } | "busy";

// One replica at a time (advisory lock). All or nothing: new tables are filled as *_new and swapped in at the end of one transaction.
export async function importSde(): Promise<ImportResult> {
  const lock = await sql.reserve();
  try {
    const [l] = await lock`select pg_try_advisory_lock(${LOCK_ID}) as ok`;
    if (!l?.ok) return "busy";
    const t0 = Date.now();
    const src = await (sourceOverride ?? download)();
    try {
      let build = src.build;
      for await (const d of jsonl(src.zip, "_sde.jsonl")) build = d.buildNumber ?? build;
      const rows = await sql.begin(async (tx) => {
        const counts = await load(src.zip, tx);
        if (!counts.sde_types) throw new Error("SDE has no types, refusing to swap");
        await tx`set local lock_timeout = '30s'`;
        for (const t of TABLES) {
          await tx.unsafe(`drop table ${t}`);
          await tx.unsafe(`alter table ${t}_new rename to ${t}`);
        }
        await tx`delete from sde_meta`;
        await tx`insert into sde_meta (build_number) values (${build})`;
        return counts;
      });
      const seconds = Math.round((Date.now() - t0) / 1000);
      log("info", "sde imported", { build, seconds, rows });
      return { build, seconds, rows };
    } finally {
      await src.cleanup?.();
    }
  } finally {
    await lock`select pg_advisory_unlock(${LOCK_ID})`;
    lock.release();
  }
}

export async function loadedBuild(): Promise<number | null> {
  const [r] = await sql`select build_number from sde_meta limit 1`;
  return r ? Number(r.build_number) : null;
}

// Startup and daily: import when nothing is loaded or CCP has a newer build. Never throws.
export async function refreshSde() {
  try {
    const have = await loadedBuild();
    if (have !== null && (await latestBuild()) === have) return;
    await importSde();
  } catch (e) {
    log("error", "sde refresh failed", { err: e });
  }
}

export function startSdeRefresh() {
  void refreshSde();
  setInterval(() => void refreshSde(), 24 * 60 * 60 * 1000).unref();
}

if (import.meta.main) {
  const { migrate } = await import("../db/migrate");
  await migrate();
  const r = await importSde();
  console.log(r === "busy" ? "another import is running" : JSON.stringify(r));
  await sql.close();
}
