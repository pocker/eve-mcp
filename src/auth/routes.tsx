import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { sql } from "../db/db";
import { encrypt, randomToken } from "../crypto";
import { AppError } from "../errors";
import { clientIp, rateLimit } from "../ratelimit";
import { MessagePage } from "../web/pages";
import type { AppEnv } from "../types";
import { unlinkCharacter } from "./characters";
import { authorizeUrl, exchangeCode } from "./eve-sso";
import { createSession, destroySession } from "./session";

// Local paths only: no scheme, no "//host", no "/\host", no control characters (browsers strip tabs and newlines).
export function safeReturnTo(s: string | undefined): string {
  if (!s || !s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\") || /[\u0000-\u001f\u007f\\]/.test(s)) return "/characters";
  return s;
}

const loginQuery = z.object({ return_to: z.string().optional(), add: z.string().optional() });
const callbackQuery = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(256) });

export const routes = new Hono<AppEnv>();

routes.get("/auth/login", rateLimit({ key: clientIp, perMinute: 20 }), async (c) => {
  const q = loginQuery.parse(c.req.query());
  const user = c.var.user;
  const add = q.add === "1" && !!user;
  const state = randomToken();
  await sql`
    insert into sso_states (state, purpose, user_id, return_to, expires_at)
    values (${state}, ${add ? "add" : "login"}, ${add ? user!.id : null}, ${safeReturnTo(q.return_to)}, now() + interval '10 minutes')`;
  // Binds the state to this browser, so a state from the attacker's own login cannot be replayed in a victim's browser.
  setCookie(c, "sso", state, { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return c.redirect(authorizeUrl(state));
});

routes.get("/auth/eve/callback", rateLimit({ key: clientIp, perMinute: 30 }), async (c) => {
  const user = c.var.user;
  const page = (title: string, message: string, status: 400 | 401 | 403 | 409) =>
    c.html(<MessagePage title={title} message={message} user={user} />, status);

  const q = callbackQuery.safeParse(c.req.query());
  if (!q.success) return page("Sign-in failed", "EVE did not send a valid answer. Please try again.", 400);

  const bound = getCookie(c, "sso", "host") ?? "";
  deleteCookie(c, "sso", { prefix: "host", secure: true, path: "/" });
  const a = Buffer.from(bound);
  const b = Buffer.from(q.data.state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return page("Sign-in failed", "This sign-in did not start in this browser. Please start again.", 400);

  // Single use: the delete is the check.
  const [st] = await sql`
    delete from sso_states where state = ${q.data.state} and expires_at > now()
    returning purpose, user_id, return_to`;
  if (!st) return page("Sign-in expired", "This sign-in link is expired or was already used. Please start again.", 400);

  const adding = st.purpose === "add";
  if (adding && (!user || user.id !== st.user_id)) {
    return page("Sign-in failed", "You were signed out while adding a character. Please sign in and try again.", 403);
  }

  let t;
  try {
    t = await exchangeCode(q.data.code);
  } catch (e) {
    if (e instanceof AppError && e.code === "eve_invalid_grant") return page("Sign-in failed", "EVE rejected the sign-in. Please try again.", 401);
    throw e;
  }

  let [existing] = await sql`select user_id, owner_hash from characters where character_id = ${t.characterId}`;
  if (existing && existing.owner_hash !== t.ownerHash) {
    // The character moved to another EVE account: it is a new character for us.
    await unlinkCharacter(t.characterId, "owner_changed");
    existing = undefined;
  }

  let userId: number;
  if (adding) {
    if (existing && Number(existing.user_id) !== user!.id) {
      return page(
        "Character already linked",
        "This character is linked to another account. Sign in with it and remove it there first.",
        409,
      );
    }
    userId = user!.id;
  } else if (existing) {
    userId = Number(existing.user_id);
    const [u] = await sql`select disabled_at from users where id = ${userId}`;
    if (u?.disabled_at) return page("Account disabled", "This account is disabled.", 403);
  } else {
    const [u] = await sql`insert into users default values returning id`;
    userId = Number(u!.id);
    await sql`insert into audit_log (user_id, event) values (${userId}, 'user_created')`;
  }

  const refreshEnc = await encrypt(t.refreshToken);
  const accessEnc = await encrypt(t.accessToken);
  await sql`
    insert into characters (character_id, user_id, name, owner_hash, scopes, refresh_token_enc, access_token_enc, access_expires_at, needs_reauth)
    values (${t.characterId}, ${userId}, ${t.characterName}, ${t.ownerHash}, ${sql.array(t.scopes, "TEXT")}, ${refreshEnc}, ${accessEnc}, ${t.expiresAt}, false)
    on conflict (character_id) do update set
      name = excluded.name, scopes = excluded.scopes, refresh_token_enc = excluded.refresh_token_enc,
      access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, needs_reauth = false`;
  if (!existing) {
    await sql`insert into audit_log (user_id, event, detail) values (${userId}, 'character_linked', ${JSON.stringify({ characterId: t.characterId })}::jsonb)`;
  }

  if (!adding) {
    await destroySession(c); // no session fixation
    await createSession(c, userId);
    await sql`insert into audit_log (user_id, event, detail) values (${userId}, 'login', ${JSON.stringify({ characterId: t.characterId })}::jsonb)`;
  }
  return c.redirect(safeReturnTo(st.return_to));
});

routes.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.redirect("/");
});
