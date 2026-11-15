import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { config } from "../src/config";
import { sql } from "../src/db/db";
import { sessionMiddleware } from "../src/auth/session";
import { randomToken, sha256 } from "../src/crypto";
import { routes as webRoutes } from "../src/web/routes";
import type { AppEnv } from "../src/types";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { seedUser } from "./helpers/esi";

useTestSchema();

const app = new Hono<AppEnv>();
app.use(sessionMiddleware);
app.route("/", webRoutes);

async function createSession(userId: number) {
  const id = randomToken();
  await sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256(id)}, ${userId}, now() + interval '1 day')`;
  return id;
}

describe.skipIf(!dbAvailable)("admin users (needs Postgres)", () => {
  const ADMIN_CID = 555002;
  async function asAdmin<T>(fn: (admin: number, cookie: string) => Promise<T>) {
    const admin = await seedUser();
    await sql`insert into characters (character_id, user_id, name, owner_hash, scopes) values (${ADMIN_CID}, ${admin}, 'Boss2', 'h', ${[]}) on conflict (character_id) do update set user_id = ${admin}`;
    config.adminCharacterIds.push(ADMIN_CID);
    try {
      return await fn(admin, `__Host-session=${await createSession(admin)}`);
    } finally {
      config.adminCharacterIds.splice(config.adminCharacterIds.indexOf(ADMIN_CID), 1);
      await sql`delete from characters where character_id = ${ADMIN_CID}`;
    }
  }
  const post = (path: string, cookie: string, body = "confirm=yes") =>
    app.request(path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body });

  test("page lists users with their character names", async () => {
    await asAdmin(async (_a, cookie) => {
      const u = await seedUser();
      await sql`insert into characters (character_id, user_id, name, owner_hash, scopes) values (555005, ${u}, 'Listed Pilot', 'h', ${[]})`;
      const html = await (await app.request("/admin/users", { headers: { cookie } })).text();
      expect(html).toContain("Listed Pilot");
      expect(html).toMatch(new RegExp(`<td class="num" data-label="ID">${u}</td>`));
      expect(html).toContain(`href="/admin/users/${u}/delete"`);
      expect(html).toContain("Boss2");
      expect(html).toContain("you");
      expect(html).not.toContain("Usage");
    });
  });

  test("confirm page names the user; refuses self, admins and unknown ids", async () => {
    await asAdmin(async (admin, cookie) => {
      const get = (path: string) => app.request(path, { headers: { cookie } });
      const v = await seedUser();
      await sql`insert into characters (character_id, user_id, name, owner_hash, scopes) values (555006, ${v}, 'Doomed Pilot', 'h', ${[]})`;
      const res = await get(`/admin/users/${v}/delete`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Doomed Pilot");
      expect(html).toContain('name="confirm"');
      expect((await get(`/admin/users/${admin}/delete`)).status).toBe(400);
      expect((await get("/admin/users/99999999/delete")).status).toBe(404);
      expect((await get("/admin/users/abc/delete")).status).toBe(404);
      config.adminCharacterIds.push(555006);
      try {
        expect((await get(`/admin/users/${v}/delete`)).status).toBe(400);
        const list = await (await get("/admin/users")).text();
        expect(list).not.toContain(`href="/admin/users/${v}/delete"`);
      } finally {
        config.adminCharacterIds.splice(config.adminCharacterIds.indexOf(555006), 1);
      }
      expect((await sql`select 1 from users where id = ${v}`).length).toBe(1);
    });
  });

  test("non-admin gets 403 on page, confirm page and delete", async () => {
    const u = await seedUser();
    const victim = await seedUser();
    const cookie = `__Host-session=${await createSession(u)}`;
    expect((await app.request("/admin/users", { headers: { cookie } })).status).toBe(403);
    expect((await app.request(`/admin/users/${victim}/delete`, { headers: { cookie } })).status).toBe(403);
    expect((await post(`/admin/users/${victim}/delete`, cookie)).status).toBe(403);
    expect((await sql`select 1 from users where id = ${victim}`).length).toBe(1);
  });

  test("admin deletes another user and the audit row survives", async () => {
    await asAdmin(async (admin, cookie) => {
      const v = await seedUser();
      await sql`insert into characters (character_id, user_id, name, owner_hash, scopes) values (555003, ${v}, 'Victim', 'h', ${[]})`;
      await createSession(v);
      const res = await post(`/admin/users/${v}/delete`, cookie);
      expect(res.status).toBe(302);
      expect((await sql`select 1 from users where id = ${v}`).length).toBe(0);
      expect((await sql`select 1 from characters where user_id = ${v}`).length).toBe(0);
      expect((await sql`select 1 from sessions where user_id = ${v}`).length).toBe(0);
      const [a] = await sql`select detail from audit_log where user_id = ${admin} and event = 'user_deleted'`;
      expect(JSON.parse(a!.detail)).toEqual({ by: admin, deleted_user: v });
    });
  });

  test("refuses self-delete, deleting an admin, and a missing confirm", async () => {
    await asAdmin(async (admin, cookie) => {
      expect((await post(`/admin/users/${admin}/delete`, cookie)).status).toBe(400);
      const other = await seedUser();
      await sql`insert into characters (character_id, user_id, name, owner_hash, scopes) values (555004, ${other}, 'Admin2', 'h', ${[]})`;
      config.adminCharacterIds.push(555004);
      try {
        expect((await post(`/admin/users/${other}/delete`, cookie)).status).toBe(400);
      } finally {
        config.adminCharacterIds.splice(config.adminCharacterIds.indexOf(555004), 1);
      }
      const plain = await seedUser();
      expect((await post(`/admin/users/${plain}/delete`, cookie, "")).status).toBe(400);
      expect((await post(`/admin/users/${plain}/delete`, cookie, "confirm=no")).status).toBe(400);
      expect((await sql`select 1 from users where id in (${admin}, ${other}, ${plain})`).length).toBe(3);
    });
  });
});
