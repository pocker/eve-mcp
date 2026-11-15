import pkg from "../../package.json";
import { cacheGet, cachePut } from "../esi/cache";
import { config } from "../config";
import { AppError } from "../errors";

const HOST = "https://zkillboard.com";
const TTL_MS = 10 * 60_000; // zKillboard is strict on rate limits: one request per system per 10 minutes
const FAIL_TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const KEEP = 10;
const MAX_FAIL_MS = 10 * 60_000;
let gapMs = 1000; // pause between two zKill requests

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setZkillFetch = (f: Fetch | undefined, gap = 1000) => {
  doFetch = f ?? ((url, init) => fetch(url, init));
  gapMs = gap;
};

export const killUrl = (id: number) => `${HOST}/kill/${id}/`;

export type ZkKill = { killmail_id: number; hash: string; value: number; solo: boolean; npc: boolean };

let last = 0;
let gate: Promise<void> = Promise.resolve();

// One queue for the whole process: concurrent tool calls still leave `gapMs` between two zKill requests.
// shortcut: per process, not per cluster; with several replicas use a Postgres advisory lock for the gap.
function slot(): Promise<void> {
  const p = gate.then(async () => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
  });
  gate = p;
  return p;
}

// The one place that talks to zKillboard: cache (also of failures), global gap, UA with contact, gzip, timeout.
// `path` is built by the callers from integers only. `shape` turns the body into the small value that is cached, or throws.
export async function zkillGet<T>(key: string, path: string, ttlMs: number, shape: (body: unknown) => T): Promise<T> {
  const hit = await cacheGet(key);
  if (hit?.fresh) {
    const d = hit.data as { failed?: string; v?: T };
    if (d.failed) throw new AppError("zkill_unavailable", d.failed, 502);
    if (d.v !== undefined) return d.v; // an entry from before the {v} format refetches
  }
  const fail = async (msg: string, ms = FAIL_TTL_MS): Promise<never> => {
    await cachePut(key, null, new Date(Date.now() + ms), { failed: msg }, 1);
    throw new AppError("zkill_unavailable", msg, 502);
  };
  await slot();
  let res: Response;
  try {
    res = await doFetch(`${HOST}${path}`, {
      method: "GET",
      headers: { "User-Agent": `eve-mcp/${pkg.version} (+${config.publicUrl}; ${config.esiContact})`, "Accept-Encoding": "gzip", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail("zKillboard did not answer in time.");
  }
  if (res.status === 429 || res.status === 403) {
    const retry = Number(res.headers.get("retry-after")) * 1000;
    return fail("zKillboard is rate limiting this server. Its data is unavailable for a few minutes.", Math.min(MAX_FAIL_MS, Math.max(FAIL_TTL_MS, retry || 0)));
  }
  if (!res.ok) return fail(`zKillboard returned ${res.status}.`);
  let v: T;
  try {
    v = shape(await res.json());
  } catch {
    // Old endpoints may answer 200 with an error object, or with something that is not JSON.
    return fail("zKillboard returned an error or a body this server cannot read.");
  }
  await cachePut(key, null, new Date(Date.now() + ttlMs), { v }, 1);
  return v;
}

// A kill list as zKillboard sends it: ID and hash only matter, the rest comes from ESI.
export function shapeKills(body: unknown): ZkKill[] {
  if (!Array.isArray(body)) throw new Error("not a list");
  const kills: ZkKill[] = [];
  for (const k of body as { killmail_id?: unknown; zkb?: { hash?: unknown; totalValue?: unknown; solo?: unknown; npc?: unknown } }[]) {
    // The hash goes into an ESI URL later: accept nothing but 40 hex characters.
    if (!Number.isInteger(k?.killmail_id) || typeof k.zkb?.hash !== "string" || !/^[0-9a-f]{40}$/.test(k.zkb.hash)) continue;
    kills.push({ killmail_id: k.killmail_id as number, hash: k.zkb.hash, value: Math.round(Number(k.zkb.totalValue) || 0), solo: k.zkb.solo === true, npc: k.zkb.npc === true });
    if (kills.length === KEEP) break;
  }
  return kills;
}

// Newest kills in a system over the past `hours` (zkillboard wants whole hours).
export const zkillSystemKills = (systemId: number, hours = 24): Promise<ZkKill[]> =>
  zkillGet(`zkill#sys:${systemId}:${hours}`, `/api/kills/solarSystemID/${systemId}/pastSeconds/${hours * 3600}/`, TTL_MS, shapeKills);
