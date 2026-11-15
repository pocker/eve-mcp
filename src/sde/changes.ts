import pkg from "../../package.json";
import { cacheGet, cachePut } from "../esi/cache";
import { config } from "../config";
import { AppError } from "../errors";
import { latestBuild, loadedBuild } from "./import";

// Same fixed CCP host as the importer. One small JSONL file per build (about 0.5 KB to 100 KB).
const HOST = "https://developers.eveonline.com";
const changesUrl = (build: number) => `${HOST}/static-data/tranquility/changes/${build}.jsonl`;
const TTL_MS = 24 * 3600_000; // a published build's change list never changes
const MAX_BYTES = 5_000_000;
const MAX_IDS = 500;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setChangesFetch = (f: Fetch | undefined) => void (doFetch = f ?? ((url, init) => fetch(url, init)));

export type FileChange = { file: string; added: number; removed: number; changed: number; changed_localization: number; schema_changed: boolean };
export type Changes = {
  build: number;
  previous_build: number | null;
  release_date: string | null;
  files: FileChange[];
  types: { added: number[]; removed: number[]; changed: number[] }; // ids, capped at MAX_IDS each; totals are in the "types" and "typeDogma" file rows
};

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : []);

export function parseChanges(text: string, build: number): Changes {
  const out: Changes = { build, previous_build: null, release_date: null, files: [], types: { added: [], removed: [], changed: [] } };
  const changed = new Set<number>();
  for (const line of text.split("\n")) {
    let d: Record<string, any>; // JSON edge
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d._key === "_meta") {
      out.previous_build = Number.isInteger(d.lastBuildNumber) ? d.lastBuildNumber : null;
      out.release_date = typeof d.releaseDate === "string" ? d.releaseDate.slice(0, 30) : null;
      continue;
    }
    if (typeof d._key !== "string") continue;
    out.files.push({ file: d._key.slice(0, 60), added: ids(d.added).length, removed: ids(d.removed).length, changed: ids(d.changed).length, changed_localization: ids(d.changedLocalization).length, schema_changed: d.schemaChanged === true });
    if (d._key === "types") {
      out.types.added = ids(d.added).slice(0, MAX_IDS);
      out.types.removed = ids(d.removed).slice(0, MAX_IDS);
    }
    if (d._key === "types" || d._key === "typeDogma") for (const i of ids(d.changed)) changed.add(i);
  }
  out.types.changed = [...changed].slice(0, MAX_IDS);
  return out;
}

// The build to look at: the one in our SDE tables, else CCP's latest.
export const currentBuild = async () => (await loadedBuild()) ?? (await latestBuild());

export async function sdeChanges(build: number): Promise<Changes> {
  const key = `sde#changes:${build}`;
  const hit = await cacheGet(key);
  if (hit?.fresh) return hit.data as Changes;
  let text: string;
  try {
    const res = await doFetch(changesUrl(build), {
      method: "GET",
      headers: { "User-Agent": `eve-mcp/${pkg.version} (+${config.publicUrl}; ${config.esiContact})` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 403) throw new AppError("not_found", `CCP has no SDE change list for build ${build}.`, 404);
    if (!res.ok) throw new Error(String(res.status));
    text = await res.text();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("sde_changes_unreachable", "The CCP static data host did not answer. Try again shortly.", 502);
  }
  if (text.length > MAX_BYTES) throw new AppError("sde_changes_error", "The change list was too large.", 502);
  const c = parseChanges(text, build);
  await cachePut(key, null, new Date(Date.now() + TTL_MS), c, 1);
  return c;
}
