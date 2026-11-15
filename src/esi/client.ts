import { config } from "../config";
import { sql } from "../db/db";
import { AppError } from "../errors";
import pkg from "../../package.json";
import { cacheGet, cachePut, cacheTouch } from "./cache";

const BASE = "https://esi.evetech.net";
export const MIN_ERROR_BUDGET = 20;
const MAX_PAGES = 10;
const TIMEOUT_MS = 15_000;
const NOT_FOUND_TTL_MS = 3600_000;
const NOT_FOUND = { notFound: true };
const notFound = (msg = "") => new AppError("esi_not_found", `ESI: not found${msg ? ` (${msg})` : ""}`, 404);

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setEsiFetch = (f: Fetch | undefined) => void (doFetch = f ?? ((url, init) => fetch(url, init)));

export type Query = Record<string, string | number | boolean | undefined>;
export type EsiOpts = { token?: string; characterId?: number; query?: Query; body?: unknown };

// The error budget is per source IP and shared by all replicas, so it lives in esi_status.
async function guard() {
  const [s] = await sql`
    select error_limit_remain as remain, extract(epoch from error_limit_reset_at - now()) as secs
    from esi_status where id = 1`;
  if (s && s.remain != null && Number(s.remain) < MIN_ERROR_BUDGET && Number(s.secs) > 0) {
    throw new AppError("esi_error_limit", `ESI error limit is low (${s.remain} left). Try again in ${Math.ceil(Number(s.secs))} s.`, 503);
  }
}

async function recordLimit(remain: number, resetSecs: number) {
  // Concurrent replies race: inside one reset window keep the lowest remain; a later window replaces it.
  await sql`
    update esi_status set
      error_limit_remain = case
        when error_limit_reset_at is null or error_limit_reset_at < now()
          or now() + make_interval(secs => ${resetSecs}) > error_limit_reset_at + interval '1 second' then ${remain}::int
        else least(error_limit_remain, ${remain}::int) end,
      error_limit_reset_at = case
        when error_limit_reset_at is null or error_limit_reset_at < now()
          or now() + make_interval(secs => ${resetSecs}) > error_limit_reset_at + interval '1 second' then now() + make_interval(secs => ${resetSecs})
        else error_limit_reset_at end
    where id = 1`;
}

// Per-route-group token buckets (X-Ratelimit-*). Why the group is looked up by route: ESI only tells us a
// call's group in its response, but we must decide before calling. So every grouped response stores
// "route template -> group" in esi_buckets ("route:" rows), and the next call (on any replica) joins that
// to the bucket row "<group>#<character|public>". A route we have never seen has no row yet and just goes
// through; after its first answer it is known. Routes without the header keep the legacy global error limit.
const LOW_FRACTION = 0.05;
const routeKey = (method: string, path: string) => `route:${method} ${path.replace(/\/\d+(?=\/|$)/g, "/{id}")}`;
const knownGroups = new Map<string, string>(); // only avoids repeat writes; losing it costs one upsert
// Tests only.
export const forgetRouteGroups = () => knownGroups.clear();

async function bucketGuard(route: string, who: string) {
  const [b] = await sql`
    select r.grp, b.remaining, b.lim,
      extract(epoch from b.paused_until - now()) as pause_secs, extract(epoch from b.reset_at - now()) as reset_secs
    from esi_buckets r join esi_buckets b on b.bucket = r.grp || '#' || ${who}
    where r.bucket = ${route}`;
  if (!b) return;
  const pause = Number(b.pause_secs);
  const low = b.remaining != null && b.lim != null && Number(b.reset_secs) > 0 && Number(b.remaining) < Number(b.lim) * LOW_FRACTION;
  const wait = Math.ceil(pause > 0 ? pause : low ? Number(b.reset_secs) : 0);
  if (wait > 0) throw new AppError("esi_rate_limited", `ESI rate limit for route group ${b.grp} is ${pause > 0 ? "paused" : "nearly used up"}. Try again in ${wait} s.`, 429);
}

// "150/15m" -> 150 calls per 900 s.
function parseLimit(v: string | null): { lim: number; windowSecs: number } | undefined {
  const m = /^(\d+)\/(\d+)([smh])$/.exec(v ?? "");
  return m ? { lim: Number(m[1]), windowSecs: Number(m[2]) * { s: 1, m: 60, h: 3600 }[m[3] as "s" | "m" | "h"] } : undefined;
}

// Writes only when needed: a new route -> group mapping, a 429, or a nearly empty bucket.
async function recordBucket(route: string, who: string, res: Response, pauseSecs?: number) {
  const group = res.headers.get("x-ratelimit-group");
  if (!group) return;
  if (knownGroups.get(route) !== group) {
    await sql`
      insert into esi_buckets (bucket, grp) values (${route}, ${group})
      on conflict (bucket) do update set grp = excluded.grp, updated_at = now()`;
    knownGroups.set(route, group);
  }
  const l = parseLimit(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const low = l !== undefined && res.headers.get("x-ratelimit-remaining") !== null && Number.isFinite(remaining) && remaining < l.lim * LOW_FRACTION;
  if (pauseSecs === undefined && !low) return;
  // A pause (429) carries no window: the wait is Retry-After only, not the low-remaining rule.
  const paused = pauseSecs !== undefined;
  const windowSecs = !paused && l ? l.windowSecs : null;
  await sql`
    insert into esi_buckets (bucket, remaining, lim, reset_at, paused_until)
    values (${`${group}#${who}`}, ${paused ? null : remaining}, ${paused ? null : (l?.lim ?? null)},
            ${windowSecs === null ? null : sql`now() + make_interval(secs => ${windowSecs})`},
            ${paused ? sql`now() + make_interval(secs => ${pauseSecs})` : null})
    on conflict (bucket) do update set
      remaining = case when esi_buckets.reset_at > now() then least(esi_buckets.remaining, excluded.remaining) else excluded.remaining end,
      lim = coalesce(excluded.lim, esi_buckets.lim),
      reset_at = case when esi_buckets.reset_at > now() then esi_buckets.reset_at else excluded.reset_at end,
      paused_until = greatest(esi_buckets.paused_until, excluded.paused_until),
      updated_at = now()`;
}

export function cacheKey(method: string, path: string, o: EsiOpts) {
  const q = Object.entries(o.query ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${method} ${path}?${q}#${o.characterId ?? "public"}`;
}

async function errorText(res: Response) {
  try {
    const j = JSON.parse((await res.text()).slice(0, 2000)) as { error?: unknown };
    return typeof j.error === "string" ? j.error.slice(0, 200) : "";
  } catch {
    return "";
  }
}

// One ESI call. GETs go through the shared cache. Returns the parsed body and X-Pages.
export async function esiCall(method: "GET" | "POST" | "DELETE", path: string, o: EsiOpts = {}): Promise<{ data: unknown; pages: number }> {
  const key = method === "GET" ? cacheKey(method, path, o) : undefined;
  const cached = key ? await cacheGet(key) : undefined;
  if (cached?.fresh) {
    if ((cached.data as { notFound?: boolean } | null)?.notFound === true) throw notFound("cached");
    return { data: cached.data, pages: cached.pages };
  }

  const route = routeKey(method, path);
  const who = String(o.characterId ?? "public");
  await bucketGuard(route, who);
  await guard();
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    "User-Agent": `eve-mcp/${pkg.version} (${config.esiContact})`,
    "X-Compatibility-Date": config.esiCompatDate,
    Accept: "application/json",
  };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError("esi_unreachable", "ESI did not answer in time. Try again shortly.", 502);
  }

  const remain = res.headers.get("x-esi-error-limit-remain");
  const reset = res.headers.get("x-esi-error-limit-reset");
  if (remain !== null && reset !== null && Number.isFinite(Number(remain)) && Number.isFinite(Number(reset))) await recordLimit(Number(remain), Number(reset));

  // 429 is a per-bucket limit when the route has a group; 420 is the legacy global error limit. Both honour the wait.
  if (res.status === 429 || res.status === 420) {
    const wait = Math.min(Math.max(Number(res.headers.get("retry-after")) || Number(res.headers.get("x-esi-error-limit-reset")) || 60, 1), 3600);
    if (res.status === 429 && res.headers.get("x-ratelimit-group")) await recordBucket(route, who, res, wait);
    else await recordLimit(0, wait);
    throw new AppError("esi_rate_limited", `ESI rate limit hit. Try again in ${wait} s.`, 429);
  }
  await recordBucket(route, who, res);
  const expires = new Date(res.headers.get("expires") ?? "");
  const expiresAt = Number.isNaN(expires.getTime()) ? new Date(Date.now() + 60_000) : expires;
  if (res.status === 304 && key && cached) {
    await cacheTouch(key, expiresAt);
    return { data: cached.data, pages: cached.pages };
  }
  if (!res.ok) {
    const msg = await errorText(res);
    if (res.status === 404) {
      // Public GETs only: a 404 counts against the shared per-IP error budget, so do not repeat it for an hour.
      if (key && !o.token) await cachePut(key, null, new Date(Date.now() + NOT_FOUND_TTL_MS), NOT_FOUND, 1);
      throw notFound(msg);
    }
    if (res.status === 401 || res.status === 403) throw new AppError("esi_forbidden", `ESI refused the request (${res.status})${msg ? `: ${msg}` : ""}`, 403);
    throw new AppError("esi_error", `ESI returned ${res.status}${msg ? `: ${msg}` : ""}`, 502);
  }
  if (res.status === 204) return { data: null, pages: 1 };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AppError("esi_error", "ESI returned a body that is not JSON", 502);
  }
  const pages = Number(res.headers.get("x-pages")) || 1;
  if (key) await cachePut(key, res.headers.get("etag"), expiresAt, data, pages);
  return { data, pages };
}

export async function esiGet(path: string, o: EsiOpts = {}): Promise<unknown> {
  return (await esiCall("GET", path, o)).data;
}

export async function esiPost(path: string, body: unknown, o: EsiOpts = {}): Promise<unknown> {
  return (await esiCall("POST", path, { ...o, body })).data;
}

// Follows X-Pages up to maxPages, then says how many were left out.
export async function esiGetAll(path: string, o: EsiOpts = {}, maxPages = MAX_PAGES): Promise<{ items: unknown[]; totalPages: number; truncated: boolean }> {
  const first = await esiCall("GET", path, { ...o, query: { ...o.query, page: 1 } });
  const items = Array.isArray(first.data) ? [...first.data] : [];
  const last = Math.min(first.pages, maxPages);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, last - 1) }, (_, i) => esiCall("GET", path, { ...o, query: { ...o.query, page: i + 2 } })),
  );
  for (const r of rest) if (Array.isArray(r.data)) items.push(...r.data);
  return { items, totalPages: first.pages, truncated: first.pages > last };
}
