import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { config } from "../src/config";
import { routes as authRoutes } from "../src/auth/routes";
import { sessionMiddleware } from "../src/auth/session";
import { sql } from "../src/db/db";
import { routes as webRoutes } from "../src/web/routes";
import type { AppEnv } from "../src/types";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEve, tokenResponse } from "./helpers/eve";

useTestSchema();

const app = new Hono<AppEnv>();
app.use(sessionMiddleware);
app.route("/", authRoutes);
app.route("/", webRoutes);

// Each SSO round trip comes from its own "client IP" so the login rate limit (a different test's subject) does not trip.
(config as { clientIpHeader?: string }).clientIpHeader = "x-test-ip";
let ipSeq = 0;

let char: { id: number; owner?: string; name?: string } = { id: 1 };
let fake: ReturnType<typeof fakeEve>;
beforeEach(() => void (fake = fakeEve(() => tokenResponse(char))));
afterEach(() => fake.restore());

const cookieOf = (res: Response) => {
  const cs = res.headers.getSetCookie().filter((s) => !/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(s));
  return cs.length ? cs[cs.length - 1]!.split(";")[0]! : "";
};

// Runs the whole SSO round trip as the given character; returns the callback response.
// bind: the __Host-sso cookie the callback sends; default is the one /auth/login set, null = none.
async function sso(c: typeof char, opts: { cookie?: string; add?: boolean; returnTo?: string; bind?: string | null } = {}) {
  char = c;
  const q = new URLSearchParams({ return_to: opts.returnTo ?? "/characters", ...(opts.add ? { add: "1" } : {}) });
  const ip = { "x-test-ip": `10.0.0.${++ipSeq}` };
  const start = await app.request(`/auth/login?${q}`, { headers: { ...ip, ...(opts.cookie ? { cookie: opts.cookie } : {}) }, redirect: "manual" });
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const bind = opts.bind === undefined ? state : opts.bind;
  const cookie = [opts.cookie, bind ? `__Host-sso=${bind}` : ""].filter(Boolean).join("; ");
  const res = await app.request(`/auth/eve/callback?code=abc&state=${state}`, { headers: { ...ip, ...(cookie ? { cookie } : {}) }, redirect: "manual" });
  return { res, state, start };
}

const chars = async (userId: number) => (await sql`select character_id from characters where user_id = ${userId} order by character_id`).map((r: { character_id: string }) => Number(r.character_id));

describe.skipIf(!dbAvailable)("SSO callback (needs Postgres)", () => {
  test("new user: creates user, session, encrypted tokens, audit", async () => {
    const { res } = await sso({ id: 101, name: "Alice", owner: "a" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/characters");
    const cookie = cookieOf(res);
    expect(cookie).toContain("__Host-session=");
    const [row] = await sql`select user_id, name, scopes, refresh_token_enc, needs_reauth from characters where character_id = 101`;
    expect(row!.name).toBe("Alice");
    expect(row!.needs_reauth).toBe(false);
    expect(Buffer.from(row!.refresh_token_enc).includes("refresh-101")).toBe(false);
    const events = (await sql`select event from audit_log where user_id = ${row!.user_id}`).map((r: { event: string }) => r.event);
    expect(events).toEqual(expect.arrayContaining(["user_created", "character_linked", "login"]));
    expect(await (await app.request("/characters", { headers: { cookie } })).text()).toContain("Alice");
  });

  test("state is single use and unknown state is refused", async () => {
    const { state } = await sso({ id: 102, owner: "a" });
    const bound = (s: string) => ({ headers: { cookie: `__Host-sso=${s}` } });
    expect((await app.request(`/auth/eve/callback?code=abc&state=${state}`, bound(state))).status).toBe(400);
    expect((await app.request("/auth/eve/callback?code=abc&state=nope", bound("nope"))).status).toBe(400);
  });

  test("login sets a __Host-sso cookie holding the state", async () => {
    const { start, state } = await sso({ id: 103, owner: "a" });
    const sc = start.headers.getSetCookie().find((s) => s.startsWith("__Host-sso="))!;
    expect(sc).toContain(`__Host-sso=${state}`);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=600/);
  });

  test("callback with a valid state but a missing or different sso cookie is refused", async () => {
    for (const bind of [null, "someone-elses-state"]) {
      const { res, state } = await sso({ id: 104, owner: "a" }, { bind });
      expect(res.status).toBe(400);
      expect(cookieOf(res)).toBe("");
      expect(await res.text()).toContain("did not start in this browser");
      expect((await sql`select 1 from characters where character_id = 104`).length).toBe(0);
      expect(state).toBeTruthy();
    }
  });

  test("expired state is refused", async () => {
    const start = await app.request("/auth/login", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    await sql`update sso_states set expires_at = now() - interval '1 second' where state = ${state}`;
    expect((await app.request(`/auth/eve/callback?code=abc&state=${state}`, { headers: { cookie: `__Host-sso=${state}` } })).status).toBe(400);
  });

  test("add a second character, then same user logging in with it", async () => {
    const first = await sso({ id: 111, owner: "o111" });
    const cookie = cookieOf(first.res);
    const [u] = await sql`select user_id from characters where character_id = 111`;
    const uid = Number(u!.user_id);
    const add = await sso({ id: 112, owner: "o112" }, { cookie, add: true });
    expect(add.res.status).toBe(302);
    expect(await chars(uid)).toEqual([111, 112]);
    const login = await sso({ id: 112, owner: "o112" });
    const me = await app.request("/characters", { headers: { cookie: cookieOf(login.res) } });
    expect(await me.text()).toContain("Test Pilot");
    expect((await sql`select user_id from characters where character_id = 112`)[0]!.user_id).toBe(uid);
  });

  test("re-link keeps grant_characters and clears needs_reauth", async () => {
    const first = await sso({ id: 131, owner: "o131" });
    const [u] = await sql`select user_id from characters where character_id = 131`;
    const uid = Number(u!.user_id);
    await sql`insert into oauth_clients (client_id, name, redirect_uris) values ('relink-c', 'x', ${sql.array(["http://127.0.0.1/cb"], "TEXT")}) on conflict do nothing`;
    const [g] = await sql`insert into grants (user_id, client_id, all_characters) values (${uid}, 'relink-c', false) returning id`;
    await sql`insert into grant_characters (grant_id, character_id) values (${g!.id}, 131)`;
    await sql`update characters set needs_reauth = true, scopes = ${sql.array([], "TEXT")} where character_id = 131`;
    const { res } = await sso({ id: 131, owner: "o131" }, { cookie: cookieOf(first.res), add: true });
    expect(res.status).toBe(302);
    const [row] = await sql`select needs_reauth, scopes from characters where character_id = 131`;
    expect(row!.needs_reauth).toBe(false);
    expect(row!.scopes.length).toBeGreaterThan(0);
    expect((await sql`select 1 from grant_characters where grant_id = ${g!.id} and character_id = 131`).length).toBe(1);
  });

  test("adding a character owned by another user is refused", async () => {
    const a = await sso({ id: 121, owner: "o121" });
    const b = await sso({ id: 122, owner: "o122" });
    const { res } = await sso({ id: 122, owner: "o122" }, { cookie: cookieOf(a.res), add: true });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("another account");
    const [row] = await sql`select user_id from characters where character_id = 122`;
    expect(await chars(Number(row!.user_id))).toEqual([122]);
    expect(cookieOf(b.res)).not.toBe("");
  });

  test("owner hash change moves the character to a new user", async () => {
    const a = await sso({ id: 131, owner: "old" });
    const [before] = await sql`select user_id from characters where character_id = 131`;
    const b = await sso({ id: 131, owner: "new" });
    const [after] = await sql`select user_id, owner_hash from characters where character_id = 131`;
    expect(after!.owner_hash).toBe("new");
    expect(after!.user_id).not.toBe(before!.user_id);
    const events = (await sql`select detail from audit_log where event = 'character_unlinked' and user_id = ${before!.user_id}`) as { detail: string }[];
    expect(JSON.parse(events[0]!.detail).reason).toBe("owner_changed");
    expect(cookieOf(a.res)).not.toBe(cookieOf(b.res));
  });

  test("disabled user cannot sign in", async () => {
    await sso({ id: 141, owner: "o" });
    await sql`update users set disabled_at = now() where id = (select user_id from characters where character_id = 141)`;
    const { res } = await sso({ id: 141, owner: "o" });
    expect(res.status).toBe(403);
    expect(cookieOf(res)).toBe("");
  });

  test("login replaces the old session", async () => {
    const a = await sso({ id: 151, owner: "o" });
    const old = cookieOf(a.res);
    const b = await sso({ id: 151, owner: "o" }, { cookie: old });
    expect(cookieOf(b.res)).not.toBe(old);
    expect((await app.request("/characters", { headers: { cookie: old }, redirect: "manual" })).status).toBe(302);
  });

  test("a rejected token creates nothing", async () => {
    fake.restore();
    fake = fakeEve(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    const start = await app.request("/auth/login", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(`/auth/eve/callback?code=abc&state=${state}`, { headers: { cookie: `__Host-sso=${state}` } });
    expect(res.status).toBe(401);
  });

  test("logout destroys the session", async () => {
    const cookie = cookieOf((await sso({ id: 161, owner: "o" })).res);
    await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect((await app.request("/characters", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
  });
});

describe.skipIf(!dbAvailable)("web pages (needs Postgres)", () => {
  test("admin page is 403 for non-admin, anonymous is sent to login", async () => {
    const cookie = cookieOf((await sso({ id: 201, owner: "o" })).res);
    expect((await app.request("/admin/users", { headers: { cookie } })).status).toBe(403);
    expect((await app.request("/admin/users", { redirect: "manual" })).status).toBe(302);
  });

  test("admin lists, disables and enables others, not self", async () => {
    const cookie = cookieOf((await sso({ id: 211, owner: "o" })).res);
    const [a] = await sql`select user_id from characters where character_id = 211`;
    config.adminCharacterIds.push(211);
    const other = await sso({ id: 212, owner: "o" });
    const [b] = await sql`select user_id from characters where character_id = 212`;
    expect(await (await app.request("/admin/users", { headers: { cookie } })).text()).toContain("Test Pilot");
    await app.request(`/admin/users/${b!.user_id}/disable`, { method: "POST", headers: { cookie } });
    expect((await sql`select disabled_at from users where id = ${b!.user_id}`)[0]!.disabled_at).not.toBeNull();
    expect((await app.request("/characters", { headers: { cookie: cookieOf(other.res) }, redirect: "manual" })).status).toBe(302);
    await app.request(`/admin/users/${b!.user_id}/enable`, { method: "POST", headers: { cookie } });
    expect((await sql`select disabled_at from users where id = ${b!.user_id}`)[0]!.disabled_at).toBeNull();
    expect((await app.request(`/admin/users/${a!.user_id}/disable`, { method: "POST", headers: { cookie } })).status).toBe(400);
    // Admin is read from config on every request: dropping the id works without a new login.
    config.adminCharacterIds.splice(config.adminCharacterIds.indexOf(211), 1);
    expect((await app.request("/admin/users", { headers: { cookie } })).status).toBe(403);
  });

  test("the users.is_admin column is not used for authorisation", async () => {
    const cookie = cookieOf((await sso({ id: 241, owner: "o" })).res);
    await sql`update users set is_admin = true where id = (select user_id from characters where character_id = 241)`;
    expect((await app.request("/admin/users", { headers: { cookie } })).status).toBe(403);
  });

  test("unlink and account delete purge that character's authed cache rows only", async () => {
    const cookie = cookieOf((await sso({ id: 251, owner: "o" })).res);
    await sso({ id: 25, owner: "o2" });
    const put = (k: string) => sql`insert into esi_cache (key, expires_at, body) values (${k}, now() + interval '1 hour', '{}'::jsonb)`;
    for (const k of ["GET /a/?#251", "GET /b/?x=1#251", "GET /a/?#2511", "GET /a/?#25", "GET /a/?#public"]) await put(k);
    await app.request("/characters/251/remove", { method: "POST", headers: { cookie } });
    const left = (await sql`select key from esi_cache where key like 'GET /_/?%' order by key`).map((r: { key: string }) => r.key);
    expect(left).toEqual(["GET /a/?#25", "GET /a/?#2511", "GET /a/?#public"]);

    const c2 = cookieOf((await sso({ id: 261, owner: "o3" })).res);
    await put("GET /z/?#261");
    await app.request("/account/delete", { method: "POST", headers: { cookie: c2 }, redirect: "manual" });
    expect((await sql`select 1 from esi_cache where key = 'GET /z/?#261'`).length).toBe(0);
  });

  test("remove only your own character", async () => {
    const a = cookieOf((await sso({ id: 221, owner: "o" })).res);
    await sso({ id: 222, owner: "o" });
    expect((await app.request("/characters/222/remove", { method: "POST", headers: { cookie: a } })).status).toBe(404);
    expect((await sql`select 1 from characters where character_id = 222`).length).toBe(1);
    await app.request("/characters/221/remove", { method: "POST", headers: { cookie: a } });
    expect((await sql`select 1 from characters where character_id = 221`).length).toBe(0);
  });

  test("account delete removes user, characters and session", async () => {
    const cookie = cookieOf((await sso({ id: 231, owner: "o" })).res);
    const [u] = await sql`select user_id from characters where character_id = 231`;
    const res = await app.request("/account/delete", { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(res.headers.get("location")).toBe("/");
    expect((await sql`select 1 from users where id = ${u!.user_id}`).length).toBe(0);
    expect((await sql`select 1 from characters where character_id = 231`).length).toBe(0);
    expect((await app.request("/account", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
  });
});

describe("public pages", () => {
  test("landing and connect render without a database", async () => {
    expect(await (await app.request("/")).text()).toContain("Sign in with EVE Online");
    expect(await (await app.request("/connect")).text()).toContain("http://localhost:3000/mcp");
  });
});
