import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config";
import { sql } from "../db/db";
import { randomToken, sha256 } from "../crypto";
import type { AppEnv } from "../types";


const MAX_AGE = 30 * 24 * 3600;

const setSessionCookie = (c: Context, value: string) =>
  setCookie(c, "session", value, { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: MAX_AGE });

export async function createSession(c: Context, userId: number) {
  const id = randomToken();
  await sql`insert into sessions (id_hash, user_id, expires_at) values (${sha256(id)}, ${userId}, now() + interval '30 days')`;
  setSessionCookie(c, id);
}

export async function destroySession(c: Context) {
  const id = getCookie(c, "session", "host");
  if (id) await sql`delete from sessions where id_hash = ${sha256(id)}`;
  deleteCookie(c, "session", { prefix: "host", secure: true, path: "/" });
}

export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = getCookie(c, "session", "host");
  if (id) {
    // Admin is derived per request from config, never from users.is_admin, so removing an id takes effect at once.
    const hash = sha256(id);
    const [row] = await sql`
      select u.id, exists(select 1 from characters ch where ch.user_id = u.id and ch.character_id = any(${sql.array(config.adminCharacterIds, "BIGINT")})) as is_admin, s.expires_at < now() + interval '29 days' as stale
      from sessions s join users u on u.id = s.user_id
      where s.id_hash = ${hash} and s.expires_at > now() and u.disabled_at is null`;
    if (row) {
      c.set("user", { id: Number(row.id), isAdmin: row.is_admin });
      if (row.stale) {
        await sql`update sessions set expires_at = now() + interval '30 days' where id_hash = ${hash}`;
        setSessionCookie(c, id);
      }
    }
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.user) return next();
  const u = new URL(c.req.url);
  return c.redirect(`/auth/login?return_to=${encodeURIComponent(u.pathname + u.search)}`);
};
