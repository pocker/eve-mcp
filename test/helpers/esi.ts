import { encrypt } from "../../src/crypto";
import { sql } from "../../src/db/db";
import { EVE_SCOPES } from "../../src/esi/scopes";
import { forgetRouteGroups } from "../../src/esi/client";

export type Call = { method: string; path: string; query: URLSearchParams; headers: Headers; body: unknown };
type Reply = unknown | Response;
export type Routes = Record<string, (call: Call) => Reply>;

// Fake ESI: routes are keyed "GET /path". Replies are JSON with a future Expires unless a Response is returned.
export function fakeEsi(routes: Routes) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = route(call);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r), { headers: { expires: new Date(Date.now() + 300_000).toUTCString() } });
  };
  return { fetch, calls };
}

let n = 0;
export async function seedUser(): Promise<number> {
  const [u] = await sql`insert into users default values returning id`;
  return Number(u!.id);
}

export async function seedCharacter(userId: number, name: string, opts: { scopes?: readonly string[]; id?: number; expired?: boolean } = {}) {
  const id = opts.id ?? 90_000_000 + ++n;
  const exp = opts.expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 3600_000);
  await sql`
    insert into characters (character_id, user_id, name, owner_hash, scopes, refresh_token_enc, access_token_enc, access_expires_at)
    values (${id}, ${userId}, ${name}, 'owner-1', ${sql.array([...(opts.scopes ?? EVE_SCOPES)], "TEXT")}, ${await encrypt("refresh-1")}, ${await encrypt("access-1")}, ${exp})`;
  return id;
}

export async function resetEsi() {
  await sql`delete from esi_cache`;
  await sql`update esi_status set error_limit_remain = null, error_limit_reset_at = null where id = 1`;
  await sql`delete from esi_buckets`;
  forgetRouteGroups();
}
