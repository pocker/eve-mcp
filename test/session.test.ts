import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSession, destroySession, requireUser, sessionMiddleware } from "../src/auth/session";
import { sql } from "../src/db/db";
import type { AppEnv } from "../src/types";
import { dbAvailable, useTestSchema } from "./helpers/db";

useTestSchema();

const app = new Hono<AppEnv>();
app.use(sessionMiddleware);
app.get("/login-as/:id", async (c) => (await createSession(c, Number(c.req.param("id"))), c.text("ok")));
app.get("/logout", async (c) => (await destroySession(c), c.text("bye")));
app.get("/me", requireUser, (c) => c.json(c.var.user));

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

describe.skipIf(!dbAvailable)("sessions (needs Postgres)", () => {
  test("create, load, destroy", async () => {
    const [u] = await sql`insert into users default values returning id`;
    const login = await app.request(`/login-as/${u!.id}`);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain("__Host-session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = cookieOf(login);

    const me = await app.request("/me", { headers: { cookie } });
    expect(await me.json()).toEqual({ id: Number(u!.id), isAdmin: false });

    await app.request("/logout", { headers: { cookie } });
    const after = await app.request("/me", { headers: { cookie }, redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/auth/login?return_to=%2Fme");
  });

  test("stores only a hash, ignores disabled users and expired sessions", async () => {
    const [u] = await sql`insert into users default values returning id`;
    const cookie = cookieOf(await app.request(`/login-as/${u!.id}`));
    const id = cookie.split("=")[1]!;
    expect((await sql`select 1 from sessions where id_hash = ${id}`).length).toBe(0);

    await sql`update users set disabled_at = now() where id = ${u!.id}`;
    expect((await app.request("/me", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
    await sql`update users set disabled_at = null where id = ${u!.id}`;
    expect((await app.request("/me", { headers: { cookie } })).status).toBe(200);
    await sql`update sessions set expires_at = now() - interval '1 second' where user_id = ${u!.id}`;
    expect((await app.request("/me", { headers: { cookie }, redirect: "manual" })).status).toBe(302);
  });
});
