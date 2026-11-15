import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "../src/db/db";
import { config } from "../src/config";
import { AppError } from "../src/errors";
import { esiGet, esiGetAll, esiPost, forgetRouteGroups, setEsiFetch } from "../src/esi/client";
import { nameMap } from "../src/esi/names";
import { accessToken, isLockTimeout, tokenDeps } from "../src/esi/token";
import { charGet } from "../src/esi/character";
import type { EveTokens } from "../src/auth/eve-sso";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, seedCharacter, seedUser } from "./helpers/esi";

useTestSchema();
afterAll(() => setEsiFetch(undefined));
beforeEach(async () => {
  if (dbAvailable) await resetEsi();
});

const code = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as AppError | null;

describe("lock timeout mapping (no DB)", () => {
  test("recognises Postgres 55P03 only", () => {
    expect(isLockTimeout({ errno: "55P03" })).toBe(true);
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout({ errno: "23505" })).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)("ESI client (needs Postgres)", () => {
  test("a public 404 is cached for an hour: the second call makes no request", async () => {
    const esi = fakeEsi({});
    setEsiFetch(esi.fetch);
    expect((await code(esiGet("/universe/types/1")))?.code).toBe("esi_not_found");
    expect((await code(esiGet("/universe/types/1")))?.code).toBe("esi_not_found");
    expect(esi.calls.length).toBe(1);
  });

  test("an authed 404 is not cached", async () => {
    const esi = fakeEsi({});
    setEsiFetch(esi.fetch);
    await code(esiGet("/x", { characterId: 1, token: "t" }));
    await code(esiGet("/x", { characterId: 1, token: "t" }));
    expect(esi.calls.length).toBe(2);
  });

  test("error limit keeps the lowest remain within one window", async () => {
    const esi = fakeEsi({
      "GET /a": () => new Response("{}", { status: 400, headers: { "x-esi-error-limit-remain": "50", "x-esi-error-limit-reset": "30" } }),
      "GET /b": () => new Response("{}", { status: 400, headers: { "x-esi-error-limit-remain": "60", "x-esi-error-limit-reset": "30" } }),
    });
    setEsiFetch(esi.fetch);
    await code(esiGet("/a"));
    await code(esiGet("/b")); // late reply with a higher value must not raise it
    const [r] = await sql`select error_limit_remain as remain from esi_status where id = 1`;
    expect(Number(r!.remain)).toBe(50);
  });

  test("sends identifying headers and serves repeat calls from the cache", async () => {
    const esi = fakeEsi({ "GET /status": () => ({ players: 5 }) });
    setEsiFetch(esi.fetch);
    expect(await esiGet("/status")).toEqual({ players: 5 });
    expect(await esiGet("/status")).toEqual({ players: 5 });
    expect(esi.calls.length).toBe(1);
    const h = esi.calls[0]!.headers;
    expect(h.get("user-agent")).toContain(config.esiContact);
    expect(h.get("x-compatibility-date")).toBe(config.esiCompatDate);
    expect(h.get("accept")).toBe("application/json");
  });

  test("revalidates with If-None-Match after Expires and reuses the body on 304", async () => {
    let n = 0;
    const esi = fakeEsi({
      "GET /status": (c) => {
        n++;
        if (n === 1) return new Response(JSON.stringify({ players: 1 }), { headers: { etag: '"abc"', expires: new Date(Date.now() - 1000).toUTCString() } });
        expect(c.headers.get("if-none-match")).toBe('"abc"');
        return new Response(null, { status: 304, headers: { expires: new Date(Date.now() + 60_000).toUTCString() } });
      },
    });
    setEsiFetch(esi.fetch);
    await esiGet("/status");
    expect(await esiGet("/status")).toEqual({ players: 1 });
    expect(n).toBe(2);
    await esiGet("/status"); // fresh again after the 304
    expect(n).toBe(2);
  });

  test("authed cache entries are per character", async () => {
    const esi = fakeEsi({ "GET /x": () => ({ ok: true }) });
    setEsiFetch(esi.fetch);
    await esiGet("/x", { characterId: 1, token: "t" });
    await esiGet("/x", { characterId: 2, token: "t" });
    expect(esi.calls.length).toBe(2);
  });

  test("refuses calls while the shared error budget is low", async () => {
    const esi = fakeEsi({
      "GET /bad": () => new Response("{}", { status: 400, headers: { "x-esi-error-limit-remain": "10", "x-esi-error-limit-reset": "30" } }),
      "GET /status": () => ({}),
    });
    setEsiFetch(esi.fetch);
    expect((await code(esiGet("/bad")))?.code).toBe("esi_error");
    const e = await code(esiGet("/status"));
    expect(e?.code).toBe("esi_error_limit");
    expect(esi.calls.length).toBe(1);
    await sql`update esi_status set error_limit_reset_at = now() - interval '1 second' where id = 1`;
    await esiGet("/status"); // window over
    expect(esi.calls.length).toBe(2);
  });

  test("429 stores Retry-After and blocks further calls", async () => {
    const esi = fakeEsi({ "GET /a": () => new Response("{}", { status: 429, headers: { "retry-after": "40" } }), "GET /b": () => ({}) });
    setEsiFetch(esi.fetch);
    const e = await code(esiGet("/a"));
    expect(e?.code).toBe("esi_rate_limited");
    expect(e?.message).toContain("40");
    expect((await code(esiGet("/b")))?.code).toBe("esi_error_limit");
  });

  test("follows X-Pages up to the cap and reports truncation", async () => {
    const esi = fakeEsi({
      "GET /list": (c) => new Response(JSON.stringify([Number(c.query.get("page"))]), { headers: { "x-pages": "5", expires: new Date(Date.now() + 60_000).toUTCString() } }),
    });
    setEsiFetch(esi.fetch);
    const all = await esiGetAll("/list", {}, 3);
    expect(all.items).toEqual([1, 2, 3]);
    expect(all.truncated).toBe(true);
    expect(all.totalPages).toBe(5);
    expect((await esiGetAll("/list", {}, 10)).truncated).toBe(false);
  });

  test("fetch failure becomes a clear error", async () => {
    setEsiFetch(async () => {
      throw new Error("boom");
    });
    expect((await code(esiGet("/status")))?.code).toBe("esi_unreachable");
  });

  test("names: bulk lookup, cached, unknown IDs split out", async () => {
    const esi = fakeEsi({
      "POST /universe/names": (c) => {
        const ids = c.body as number[];
        if (ids.includes(999)) return new Response(JSON.stringify({ error: "Invalid IDs" }), { status: 404 });
        return ids.map((id) => ({ id, name: `N${id}`, category: "type" }));
      },
    });
    setEsiFetch(esi.fetch);
    const m = await nameMap([1, 2, 999, 1]);
    expect(m.get(1)).toBe("N1");
    expect(m.has(999)).toBe(false);
    const before = esi.calls.length;
    expect((await nameMap([1, 2])).get(2)).toBe("N2");
    expect(esi.calls.length).toBe(before);
    // 999 was cached as unknown: no new request for it
    await nameMap([999]);
    expect(esi.calls.length).toBe(before);
    expect(await esiPost("/universe/names", [5])).toEqual([{ id: 5, name: "N5", category: "type" }]);
  });
});

describe.skipIf(!dbAvailable)("ESI 420 and per-bucket rate limits (needs Postgres)", () => {
  const grouped = (group: string, remaining: number, limit = "100/15m") => ({
    "x-ratelimit-group": group,
    "x-ratelimit-limit": limit,
    "x-ratelimit-remaining": String(remaining),
    expires: new Date(Date.now() + 300_000).toUTCString(),
  });
  const bucketRows = async () => Number((await sql`select count(*)::int as n from esi_buckets where grp is null`)[0]!.n);

  test("420 waits for x-esi-error-limit-reset and pauses every call", async () => {
    const esi = fakeEsi({ "GET /a": () => new Response("{}", { status: 420, headers: { "x-esi-error-limit-reset": "30" } }), "GET /b": () => ({}) });
    setEsiFetch(esi.fetch);
    const e = await code(esiGet("/a"));
    expect(e?.code).toBe("esi_rate_limited");
    expect(e?.message).toContain("30");
    expect((await code(esiGet("/b")))?.code).toBe("esi_error_limit");
    expect(esi.calls.length).toBe(1);
  });

  test("420 prefers retry-after and falls back to 60 s", async () => {
    const esi = fakeEsi({ "GET /a": () => new Response("{}", { status: 420, headers: { "retry-after": "7" } }), "GET /c": () => new Response("{}", { status: 420 }) });
    setEsiFetch(esi.fetch);
    expect((await code(esiGet("/a")))?.message).toContain("7 s");
    await resetEsi();
    expect((await code(esiGet("/c")))?.message).toContain("60 s");
  });

  test("a 429 on a character route pauses only that character's bucket", async () => {
    const esi = fakeEsi({
      "GET /characters/1/assets/": () => new Response("{}", { status: 429, headers: { ...grouped("char-asset", 0), "retry-after": "40" } }),
      "GET /characters/2/assets/": () => new Response(JSON.stringify([2]), { headers: grouped("char-asset", 90) }),
      "GET /universe/types/5/": () => new Response(JSON.stringify({ id: 5 }), { headers: grouped("static", 90) }),
      "GET /status/": () => ({ players: 1 }),
    });
    setEsiFetch(esi.fetch);
    // The first answer teaches the route -> group mapping.
    expect((await code(esiGet("/characters/2/assets/", { characterId: 2, token: "t" })))).toBeNull();
    const e = await code(esiGet("/characters/1/assets/", { characterId: 1, token: "t" }));
    expect(e?.code).toBe("esi_rate_limited");
    expect(e?.message).toContain("40");
    const n = esi.calls.length;
    const again = await code(esiGet("/characters/1/assets/", { characterId: 1, token: "t", query: { page: 2 } }));
    expect(again?.code).toBe("esi_rate_limited");
    expect(again?.message).toContain("char-asset");
    expect(esi.calls.length).toBe(n); // refused without calling ESI
    await esiGet("/characters/2/assets/", { characterId: 2, token: "t", query: { page: 2 } }); // other character still goes through
    await esiGet("/universe/types/5/"); // public, other group
    await esiGet("/status/"); // no group: legacy behaviour
    expect(esi.calls.length).toBe(n + 3);
    const [s] = await sql`select error_limit_remain as r from esi_status where id = 1`;
    expect(s!.r).toBeNull(); // the global limit was not touched
  });

  test("a public call and a character call of one group have separate buckets", async () => {
    const esi = fakeEsi({
      "GET /g/1/": () => new Response("{}", { status: 429, headers: { ...grouped("shared", 0), "retry-after": "30" } }),
      "GET /g/2/": () => new Response(JSON.stringify([]), { headers: grouped("shared", 90) }),
    });
    setEsiFetch(esi.fetch);
    await code(esiGet("/g/1/")); // public bucket paused
    await esiGet("/g/2/", { characterId: 9, token: "t" }); // character bucket fine
    expect((await code(esiGet("/g/3/", { query: { x: 1 } })))?.code).toBe("esi_rate_limited"); // same route template, public bucket still paused
  });

  test("refuses before calling when the bucket is nearly empty, and writes only then", async () => {
    const esi = fakeEsi({ "GET /characters/1/skills/": (c) => new Response("{}", { headers: grouped("char-skill", c.query.get("page") === "2" ? 3 : 80) }) });
    setEsiFetch(esi.fetch);
    await esiGet("/characters/1/skills/", { characterId: 1, token: "t" });
    expect(await bucketRows()).toBe(0); // plenty left: only the route row was written
    await esiGet("/characters/1/skills/", { characterId: 1, token: "t", query: { page: 2 } }); // remaining 3 of 100
    expect(await bucketRows()).toBe(1);
    const n = esi.calls.length;
    const e = await code(esiGet("/characters/1/skills/", { characterId: 1, token: "t", query: { page: 3 } }));
    expect(e?.code).toBe("esi_rate_limited");
    expect(e?.message).toMatch(/Try again in \d+ s/);
    expect(esi.calls.length).toBe(n);
  });

  test("another replica sees the state in the database", async () => {
    const esi = fakeEsi({ "GET /characters/7/assets/": () => ({}) });
    setEsiFetch(esi.fetch);
    // Rows as another replica wrote them. This process has never seen the route.
    await sql`insert into esi_buckets (bucket, grp) values ('route:GET /characters/{id}/assets/', 'char-asset')`;
    await sql`insert into esi_buckets (bucket, paused_until) values ('char-asset#7', now() + interval '20 seconds')`;
    forgetRouteGroups();
    expect((await code(esiGet("/characters/7/assets/", { characterId: 7, token: "t" })))?.code).toBe("esi_rate_limited");
    expect(esi.calls.length).toBe(0);
    await sql`update esi_buckets set paused_until = now() - interval '1 second' where bucket = 'char-asset#7'`;
    await esiGet("/characters/7/assets/", { characterId: 7, token: "t" });
    expect(esi.calls.length).toBe(1);
  });
});

describe.skipIf(!dbAvailable)("token handling (needs Postgres)", () => {
  test("a held lock gives a retryable busy error after lock_timeout", async () => {
    tokenDeps.refresh = async () => tokens();
    const id = await seedCharacter(await seedUser(), "Busy", { expired: true });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const got = new Promise<void>((r) => (locked = r));
    const holder = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${id})`;
      locked();
      await held;
    });
    await got;
    try {
      const e = await code(accessToken(id));
      expect(e?.code).toBe("token_refresh_busy");
    } finally {
      release();
      await holder;
    }
  }, 30_000);

  const orig = { ...tokenDeps };
  afterAll(() => Object.assign(tokenDeps, orig));
  const tokens = (over: Partial<EveTokens> = {}): EveTokens => ({
    accessToken: "access-2",
    refreshToken: "refresh-2",
    expiresAt: new Date(Date.now() + 1200_000),
    characterId: 0,
    characterName: "x",
    ownerHash: "owner-1",
    scopes: [],
    ...over,
  });

  test("a valid stored token is used without refreshing", async () => {
    let calls = 0;
    tokenDeps.refresh = async () => (calls++, tokens());
    const id = await seedCharacter(await seedUser(), "Fresh");
    expect(await accessToken(id)).toBe("access-1");
    expect(calls).toBe(0);
  });

  test("two concurrent calls refresh once", async () => {
    let calls = 0;
    tokenDeps.refresh = async () => {
      calls++;
      await Bun.sleep(100);
      return tokens();
    };
    const id = await seedCharacter(await seedUser(), "Stale", { expired: true });
    const [a, b] = await Promise.all([accessToken(id), accessToken(id)]);
    expect([a, b]).toEqual(["access-2", "access-2"]);
    expect(calls).toBe(1);
    expect(await accessToken(id)).toBe("access-2");
  });

  test("invalid_grant marks the character for re-link", async () => {
    tokenDeps.refresh = async () => {
      throw new AppError("eve_invalid_grant", "revoked", 401);
    };
    const id = await seedCharacter(await seedUser(), "Revoked", { expired: true });
    const e = await code(accessToken(id));
    expect(e?.message).toContain(`${config.publicUrl}/characters`);
    const [r] = await sql`select needs_reauth from characters where character_id = ${id}`;
    expect(r!.needs_reauth).toBe(true);
    expect((await code(accessToken(id)))?.code).toBe("character_needs_reauth");
  });

  test("a changed owner hash unlinks the character and refuses", async () => {
    const unlinked: [number, string][] = [];
    tokenDeps.refresh = async () => tokens({ ownerHash: "someone-else" });
    tokenDeps.unlink = async (id, why) => void unlinked.push([id, why]);
    const id = await seedCharacter(await seedUser(), "Sold", { expired: true });
    expect((await code(accessToken(id)))?.code).toBe("character_not_allowed");
    expect(unlinked).toEqual([[id, "owner_changed"]]);
    tokenDeps.unlink = orig.unlink;
  });

  test("missing scope is named and no ESI call is made", async () => {
    const esi = fakeEsi({});
    setEsiFetch(esi.fetch);
    const uid = await seedUser();
    const id = await seedCharacter(uid, "NoScope", { scopes: [] });
    const c = { character_id: id, user_id: uid, name: "NoScope", owner_hash: "o", scopes: [] as string[], needs_reauth: false };
    const e = await code(charGet(c, "esi-skills.read_skills.v1", `/characters/${id}/skills`));
    expect(e?.code).toBe("missing_scope");
    expect(e?.message).toContain("esi-skills.read_skills.v1");
    expect(e?.message).toContain("Re-link");
    expect(esi.calls.length).toBe(0);
  });
});
