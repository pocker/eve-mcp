import pkg from "../../package.json";
import { cacheGet, cachePut } from "../esi/cache";
import { config } from "../config";
import { AppError } from "../errors";

const URL_ = "https://api.eve-scout.com/v2/public/signatures";
const KEY = "evescout#signatures";
const TTL_MS = 5 * 60_000; // the API itself sends cache-control max-age=300
const FAIL_TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_ROWS = 200;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setEveScoutFetch = (f: Fetch | undefined) => void (doFetch = f ?? ((url, init) => fetch(url, init)));

export const SHIP_SIZES = ["small", "medium", "large", "xlarge", "capital"] as const;
export type Connection = {
  hub: "thera" | "turnur";
  system: string;
  system_id: number;
  space: string; // "hs", "ls", "ns" or a wormhole class such as "c2"
  region: string;
  wormhole_type: string;
  max_ship_size: string;
  expires_at: string;
  hub_signature: string | null;
  system_signature: string | null;
};

const str = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").slice(0, n) : "");
const sig = (v: unknown) => (typeof v === "string" && /^[A-Z]{3}-\d{3}$/.test(v) ? v : null);

// Keeps only what is cached and returned. Scanner names and IDs (player free text) are dropped.
export function shapeSignatures(body: unknown): Connection[] {
  if (!Array.isArray(body)) throw new Error("not a list");
  const out: Connection[] = [];
  for (const r of body.slice(0, MAX_ROWS) as Record<string, unknown>[]) {
    const hub = String(r?.out_system_name).toLowerCase();
    const expires = typeof r.expires_at === "string" ? Date.parse(r.expires_at) : NaN;
    if ((hub !== "thera" && hub !== "turnur") || r.signature_type !== "wormhole" || !Number.isInteger(r.in_system_id) || Number.isNaN(expires)) continue;
    out.push({
      hub, system: str(r.in_system_name, 60), system_id: r.in_system_id as number, space: str(r.in_system_class, 10).toLowerCase(), region: str(r.in_region_name, 60),
      wormhole_type: str(r.wh_type, 10), max_ship_size: str(r.max_ship_size, 10).toLowerCase(), expires_at: new Date(expires).toISOString(),
      hub_signature: sig(r.out_signature), system_signature: sig(r.in_signature),
    });
  }
  return out;
}

// One request per 5 minutes for the whole server (shared esi_cache); failures cached 2 minutes.
export async function eveScoutConnections(): Promise<Connection[]> {
  const hit = await cacheGet(KEY);
  if (hit?.fresh) {
    const d = hit.data as { failed?: string; v?: Connection[] };
    if (d.failed) throw new AppError("evescout_unavailable", d.failed, 502);
    if (d.v) return d.v;
  }
  const fail = async (msg: string): Promise<never> => {
    await cachePut(KEY, null, new Date(Date.now() + FAIL_TTL_MS), { failed: msg }, 1);
    throw new AppError("evescout_unavailable", msg, 502);
  };
  let res: Response;
  try {
    res = await doFetch(URL_, {
      method: "GET",
      headers: { "User-Agent": `eve-mcp/${pkg.version} (+${config.publicUrl}; ${config.esiContact})`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail("EVE-Scout did not answer in time.");
  }
  if (!res.ok) return fail(`EVE-Scout returned ${res.status}.`);
  let v: Connection[];
  try {
    v = shapeSignatures(await res.json());
  } catch {
    return fail("EVE-Scout returned a body this server cannot read.");
  }
  await cachePut(KEY, null, new Date(Date.now() + TTL_MS), { v }, 1);
  return v;
}
