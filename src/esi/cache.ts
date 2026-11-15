import { sql } from "../db/db";

// Keys: "<METHOD> <path>?<sorted query>#<characterId|public>" for ESI calls (authed ones end in "#<characterId>"), "name#<id>" for names.
// esi_cache is shared by all replicas. Body is stored as {p: X-Pages, d: data}.
export type Cached = { data: unknown; pages: number; etag: string | null; fresh: boolean };

export async function cacheGet(key: string): Promise<Cached | undefined> {
  const [r] = await sql`select etag, body, expires_at > now() as fresh from esi_cache where key = ${key}`;
  if (!r) return undefined;
  const body = (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as { p: number; d: unknown };
  return { data: body.d, pages: body.p, etag: r.etag, fresh: !!r.fresh };
}

// Many keys in one query. Returns only the keys that exist.
export async function cacheGetMany(keys: string[]): Promise<Map<string, Cached>> {
  const out = new Map<string, Cached>();
  if (keys.length === 0) return out;
  const rows = await sql`select key, etag, body, expires_at > now() as fresh from esi_cache where key = any(${sql.array(keys, "TEXT")})`;
  for (const r of rows) {
    const body = (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as { p: number; d: unknown };
    out.set(r.key, { data: body.d, pages: body.p, etag: r.etag, fresh: !!r.fresh });
  }
  return out;
}

// Many entries with one expiry, one upsert. Entries are [key, data] with pages = 1, no ETag.
export async function cachePutMany(entries: [string, unknown][], expiresAt: Date) {
  if (entries.length === 0) return;
  await sql`
    insert into esi_cache (key, etag, expires_at, body)
    select k, null, ${expiresAt}::timestamptz, jsonb_build_object('p', 1, 'd', b::jsonb)
    from unnest(${sql.array(entries.map((e) => e[0]), "TEXT")}::text[], ${sql.array(entries.map((e) => JSON.stringify(e[1])), "TEXT")}::text[]) as t(k, b)
    on conflict (key) do update set etag = null, expires_at = excluded.expires_at, body = excluded.body`;
}

export async function cachePut(key: string, etag: string | null, expiresAt: Date, data: unknown, pages: number) {
  const body = JSON.stringify({ p: pages, d: data });
  await sql`
    insert into esi_cache (key, etag, expires_at, body) values (${key}, ${etag}, ${expiresAt}, ${body}::jsonb)
    on conflict (key) do update set etag = excluded.etag, expires_at = excluded.expires_at, body = excluded.body`;
}

export async function cacheTouch(key: string, expiresAt: Date) {
  await sql`update esi_cache set expires_at = ${expiresAt} where key = ${key}`;
}

export async function cacheDelete(key: string) {
  await sql`delete from esi_cache where key = ${key}`;
}
