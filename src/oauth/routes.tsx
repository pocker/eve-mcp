import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { config } from "../config";
import { randomToken, sha256 } from "../crypto";
import { sql } from "../db/db";
import { AppError } from "../errors";
import { clientIp, rateLimit } from "../ratelimit";
import { requireUser } from "../auth/session";
import type { AppEnv } from "../types";
import { RESOURCE } from "./bearer";
import { type Client, getClient, redirectMatches, registerSchema } from "./clients";
import { audit, revokeGrant } from "./grants";
import { AppsPage, ConsentPage, ManagePage, ErrorPage, RedirectPage, type AuthzFields, type CharRow } from "./pages";

export const routes = new Hono<AppEnv>();

type Row = Record<string, unknown>;
const ISSUER = config.publicUrl;
const SCOPE = "eve:read";
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 24 * 3600;

const byIp = (c: Context) => clientIp(c);
const corsOpen = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"], maxAge: 86400 });
for (const p of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) routes.use(p, corsOpen);

// shortcut: per-replica in-memory buckets, see ratelimit.ts. Registration burst is small because DCR is deprecated.
routes.use("/oauth/register", rateLimit({ key: byIp, perMinute: 5 }));
routes.use("/oauth/token", rateLimit({ key: byIp, perMinute: 60 }));
routes.use("/oauth/revoke", rateLimit({ key: byIp, perMinute: 60 }));
routes.use("/oauth/authorize", rateLimit({ key: byIp, perMinute: 30 }));

// ---- Metadata (RFC 9728, RFC 8414) ----

const protectedResource = (c: Context) =>
  c.json(
    { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
routes.get("/.well-known/oauth-protected-resource", protectedResource);
routes.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

routes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(
    {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  ),
);

// ---- Dynamic client registration (RFC 7591, public clients only; deprecated in the MCP spec but still used) ----

routes.post("/oauth/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }
  const r = registerSchema.safeParse(body);
  if (!r.success) {
    const redirectBad = r.error.issues.some((i) => i.path[0] === "redirect_uris");
    return c.json({ error: redirectBad ? "invalid_redirect_uri" : "invalid_client_metadata", error_description: "Check redirect_uris (https or loopback http) and client_name" }, 400);
  }
  const clientId = randomToken();
  const name = r.data.client_name ?? "Unnamed app";
  await sql`insert into oauth_clients (client_id, name, redirect_uris) values (${clientId}, ${name}, ${sql.array(r.data.redirect_uris, "TEXT")})`;
  await audit(null, "client_registered", { client_id: clientId, name, ip: clientIp(c) });
  return c.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: r.data.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

// ---- Authorization endpoint ----

const challengeRe = /^[A-Za-z0-9_-]{43}$/;

type Check =
  | { kind: "page"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "ok"; client: Client; fields: AuthzFields };

function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  u.searchParams.set("iss", ISSUER);
  return u.toString();
}

const str = (v: unknown, max = 2000) => (typeof v === "string" && v.length <= max ? v : undefined);

// Shared by GET (query) and POST (hidden fields). Bad client or redirect_uri never redirects.
async function checkAuthorize(p: Record<string, unknown>, post: boolean): Promise<Check> {
  const clientId = str(p.client_id);
  const redirectUri = str(p.redirect_uri);
  if (!clientId || !redirectUri) return { kind: "page", message: "The app did not say who it is. Go back and start again." };
  const client = await getClient(clientId);
  if (!client) return { kind: "page", message: "This app is not known to eve-mcp." };
  if (!client.redirectUris.some((r) => redirectMatches(r, redirectUri))) return { kind: "page", message: "The app's return address is not registered." };

  const state = str(p.state);
  const fail = (error: string, description: string): Check => ({ kind: "redirect", url: redirectWith(redirectUri, { error, error_description: description, state }) });
  if (!post && p.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  const challenge = str(p.code_challenge, 128);
  if (!challenge || !challengeRe.test(challenge)) return fail("invalid_request", "code_challenge (S256) is required");
  if (!post && p.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const resource = str(p.resource) ?? RESOURCE;
  if (resource !== RESOURCE) return fail("invalid_target", `resource must be ${RESOURCE}`);
  return { kind: "ok", client, fields: { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, resource, state } };
}

const redirectHost = (uri: string) => new URL(uri).host;
const isLocal = (uri: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(uri).hostname);

routes.get("/oauth/authorize", requireUser, async (c) => {
  const user = c.var.user!;
  const chk = await checkAuthorize(c.req.query(), false);
  if (chk.kind === "page") return c.html(<ErrorPage message={chk.message} user={user} />, 400);
  if (chk.kind === "redirect") return c.redirect(chk.url);
  const rows = await sql`select character_id, name, needs_reauth from characters where user_id = ${user.id} order by name`;
  const characters = rows.map((r: Row) => ({ id: Number(r.character_id), name: r.name as string, needsReauth: r.needs_reauth as boolean }));
  return c.html(
    <ConsentPage user={user} clientId={chk.client.clientId} clientName={chk.client.name} redirectHost={redirectHost(chk.fields.redirect_uri)} localhost={isLocal(chk.fields.redirect_uri)} fields={chk.fields} characters={characters} />,
  );
});

routes.post("/oauth/authorize", requireUser, async (c) => {
  const user = c.var.user!;
  const body = await c.req.parseBody({ all: true });
  const chk = await checkAuthorize(body, true);
  if (chk.kind === "page") return c.html(<ErrorPage message={chk.message} user={user} />, 400);
  // A 302 to an external URL after a form post is blocked by the form-action CSP, so answer with a page that links on.
  if (chk.kind === "redirect") return c.html(<RedirectPage url={chk.url} />);
  const { client, fields } = chk;
  const back = (params: Record<string, string | undefined>) => c.html(<RedirectPage url={redirectWith(fields.redirect_uri, { ...params, state: fields.state })} />);
  if (body.decision !== "allow") return back({ error: "access_denied", error_description: "The user denied the request" });

  const all = body.all_characters === "1";
  const picked = (Array.isArray(body.characters) ? body.characters : body.characters === undefined ? [] : [body.characters])
    .filter((x): x is string => typeof x === "string")
    .map(Number);
  if (!all && picked.length === 0) return c.html(<ErrorPage message="Pick at least one character, or choose all. Go back and try again." user={user} />, 400);
  const own = await sql`select character_id from characters where user_id = ${user.id}`;
  const ownIds = new Set(own.map((r: Row) => Number(r.character_id)));
  if (!all && picked.some((id) => !ownIds.has(id))) return c.html(<ErrorPage message="One of the selected characters is not yours." user={user} />, 400);

  const code = randomToken();
  const allowWrite = body.allow_write === "1";
  const grantId = await sql.begin(async (tx) => {
    const [g] = await tx`insert into grants (user_id, client_id, all_characters, allow_write) values (${user.id}, ${client.clientId}, ${all}, ${allowWrite}) returning id`;
    const id = Number(g!.id);
    if (!all) for (const cid of new Set(picked)) await tx`insert into grant_characters (grant_id, character_id) values (${id}, ${cid})`;
    await tx`
      insert into oauth_codes (code_hash, client_id, grant_id, redirect_uri, code_challenge, resource, expires_at)
      values (${sha256(code)}, ${client.clientId}, ${id}, ${fields.redirect_uri}, ${fields.code_challenge}, ${fields.resource}, now() + interval '60 seconds')`;
    return id;
  });
  await audit(user.id, "grant_created", { grant_id: grantId, client_id: client.clientId, all_characters: all, allow_write: allowWrite, characters: all ? [] : [...new Set(picked)] });
  return back({ code });
});

// ---- Token endpoint ----

const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, { "Cache-Control": "no-store", Pragma: "no-cache" });

async function issueTokens(tx: typeof sql, grantId: number) {
  const access = randomToken();
  const refresh = randomToken();
  await tx`insert into oauth_tokens (token_hash, kind, grant_id, resource, expires_at) values (${sha256(access)}, 'access', ${grantId}, ${RESOURCE}, now() + make_interval(secs => ${ACCESS_SECONDS}))`;
  await tx`insert into oauth_tokens (token_hash, kind, grant_id, resource, expires_at) values (${sha256(refresh)}, 'refresh', ${grantId}, ${RESOURCE}, now() + make_interval(secs => ${REFRESH_SECONDS}))`;
  return { access, refresh };
}

const tokenResponse = (c: Context, t: { access: string; refresh: string }) =>
  c.json({ access_token: t.access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: t.refresh, scope: SCOPE }, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });

async function revokeForReuse(grantId: number, userId: number, reason: string) {
  await revokeGrant(grantId);
  await audit(userId, reason === "refresh_reuse" ? "refresh_reuse_detected" : "grant_revoked", { grant_id: grantId, reason });
}

routes.post("/oauth/token", async (c) => {
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return tokenError(c, "invalid_request", "Body must be application/x-www-form-urlencoded");
  }
  const clientId = str(form.client_id);
  if (!clientId) return tokenError(c, "invalid_client", "client_id is required", 401);
  const resource = str(form.resource);
  if (resource !== undefined && resource !== RESOURCE) return tokenError(c, "invalid_target", "Unknown resource");

  if (form.grant_type === "authorization_code") {
    const code = str(form.code);
    const verifier = str(form.code_verifier, 200);
    const redirectUri = str(form.redirect_uri);
    if (!code || !verifier || !redirectUri) return tokenError(c, "invalid_request", "code, code_verifier and redirect_uri are required");
    const [row] = await sql`
      select c.client_id, c.grant_id, c.redirect_uri, c.code_challenge, c.resource,
             c.expires_at < now() as expired, c.used_at is not null as used,
             g.user_id, g.revoked_at is not null as revoked, u.disabled_at is not null as disabled
      from oauth_codes c join grants g on g.id = c.grant_id join users u on u.id = g.user_id
      where c.code_hash = ${sha256(code)}`;
    const bad = () => tokenError(c, "invalid_grant", "Invalid or expired code");
    if (!row || row.client_id !== clientId) return bad();
    const grantId = Number(row.grant_id);
    const userId = Number(row.user_id);
    const pkceOk = /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) && new Bun.CryptoHasher("sha256").update(verifier).digest("base64url") === row.code_challenge;
    if (row.used) {
      // Only the holder of the verifier may trigger the revoke; a stranger who saw the code must not kill the grant.
      if (pkceOk) await revokeForReuse(grantId, userId, "code_reuse");
      return bad();
    }
    if (row.expired || row.revoked || row.disabled || row.redirect_uri !== redirectUri) return bad();
    if (!pkceOk) return tokenError(c, "invalid_grant", "PKCE verification failed");
    if (resource !== undefined && resource !== row.resource) return tokenError(c, "invalid_target", "resource does not match the authorization");
    const tokens = await sql.begin(async (tx) => {
      const claimed = await tx`update oauth_codes set used_at = now() where code_hash = ${sha256(code)} and used_at is null returning code_hash`;
      return claimed.length === 0 ? null : issueTokens(tx, grantId);
    });
    if (!tokens) {
      await revokeForReuse(grantId, userId, "code_reuse");
      return bad();
    }
    return tokenResponse(c, tokens);
  }

  if (form.grant_type === "refresh_token") {
    const refresh = str(form.refresh_token);
    if (!refresh) return tokenError(c, "invalid_request", "refresh_token is required");
    const hash = sha256(refresh);
    const [row] = await sql`
      select t.resource, t.revoked_at is not null as revoked, t.replaced_by is not null as replaced, t.expires_at < now() as expired,
             g.id as grant_id, g.user_id, g.client_id, g.revoked_at is not null as grant_revoked, u.disabled_at is not null as disabled
      from oauth_tokens t join grants g on g.id = t.grant_id join users u on u.id = g.user_id
      where t.token_hash = ${hash} and t.kind = 'refresh'`;
    const bad = () => tokenError(c, "invalid_grant", "Invalid or expired refresh token");
    if (!row || row.client_id !== clientId || row.grant_revoked || row.disabled) return bad();
    const grantId = Number(row.grant_id);
    const userId = Number(row.user_id);
    if (row.replaced || row.revoked) {
      await revokeForReuse(grantId, userId, "refresh_reuse");
      return bad();
    }
    if (row.expired) return bad();
    if (resource !== undefined && resource !== row.resource) return tokenError(c, "invalid_target", "resource does not match the authorization");
    const tokens = await sql.begin(async (tx) => {
      const t = await issueTokens(tx, grantId);
      // Only one request can win this update; a concurrent replay finds it already replaced.
      const claimed = await tx`update oauth_tokens set replaced_by = ${sha256(t.refresh)} where token_hash = ${hash} and replaced_by is null and revoked_at is null returning token_hash`;
      if (claimed.length === 0) throw new RefreshRace();
      await tx`update oauth_tokens set revoked_at = now() where grant_id = ${grantId} and kind = 'access' and revoked_at is null and expires_at > now() and token_hash <> ${sha256(t.access)}`;
      return t;
    }).catch((e) => {
      if (e instanceof RefreshRace) return null;
      throw e;
    });
    if (!tokens) {
      await revokeForReuse(grantId, userId, "refresh_reuse");
      return bad();
    }
    return tokenResponse(c, tokens);
  }

  return tokenError(c, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});

class RefreshRace extends Error {}

// ---- Revocation (RFC 7009): always 200 ----

routes.post("/oauth/revoke", async (c) => {
  try {
    const form = await c.req.parseBody();
    const token = str(form.token);
    if (token) {
      const [t] = await sql`select t.kind, t.grant_id, g.user_id from oauth_tokens t join grants g on g.id = t.grant_id where t.token_hash = ${sha256(token)}`;
      if (t?.kind === "refresh") {
        if (await revokeGrant(Number(t.grant_id))) await audit(Number(t.user_id), "grant_revoked", { grant_id: Number(t.grant_id), reason: "token_revoked" });
      } else if (t) {
        await sql`update oauth_tokens set revoked_at = now() where token_hash = ${sha256(token)} and revoked_at is null`;
      }
    }
  } catch {
    // RFC 7009: the answer does not depend on whether the token existed.
  }
  return c.body(null, 200, { "Cache-Control": "no-store" });
});

// ---- /apps ----

const fmt = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : null);

routes.get("/apps", requireUser, async (c) => {
  const user = c.var.user!;
  const saved = z.coerce.number().int().positive().safeParse(c.req.query("saved"));
  const rows = await sql`
    select g.id, o.name, g.all_characters, g.allow_write, g.created_at, g.last_used_at,
           coalesce(array_agg(ch.name order by ch.name) filter (where ch.name is not null), '{}') as names
    from grants g
    join oauth_clients o on o.client_id = g.client_id
    left join grant_characters gc on gc.grant_id = g.id
    left join characters ch on ch.character_id = gc.character_id
    where g.user_id = ${user.id} and g.revoked_at is null
    group by g.id, o.name
    order by g.created_at desc`;
  const apps = rows.map((r: Row) => ({
    id: Number(r.id),
    name: r.name as string,
    all: r.all_characters as boolean,
    allowWrite: r.allow_write as boolean,
    characters: (r.names as string[]) ?? [],
    createdAt: fmt(r.created_at) ?? "",
    lastUsedAt: fmt(r.last_used_at),
  }));
  return c.html(<AppsPage user={user} apps={apps} saved={saved.success ? apps.find((a: { id: number }) => a.id === saved.data)?.name : undefined} />);
});

routes.post("/apps/:id/revoke", requireUser, async (c) => {
  const user = c.var.user!;
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || !(await revokeGrant(id, user.id))) throw new AppError("not_found", "App not found", 404);
  await audit(user.id, "grant_revoked", { grant_id: id, reason: "user" });
  return c.redirect("/apps");
});

// ---- Manage one grant (owner only, not revoked; anything else is 404) ----

const grantId = z.coerce.number().int().positive();
const manageBody = z.object({
  all_characters: z.enum(["0", "1"]),
  characters: z.union([z.string(), z.array(z.string())]).optional(),
  allow_write: z.literal("1").optional(),
});

async function loadManage(userId: number, idParam: string) {
  const id = grantId.safeParse(idParam);
  const [g] = id.success
    ? await sql`
        select g.id, o.name, g.all_characters, g.allow_write from grants g join oauth_clients o on o.client_id = g.client_id
        where g.id = ${id.data} and g.user_id = ${userId} and g.revoked_at is null`
    : [];
  if (!g) throw new AppError("not_found", "App not found", 404);
  const chars = await sql`select character_id, name, needs_reauth from characters where user_id = ${userId} order by name`;
  const picked = await sql`select character_id from grant_characters where grant_id = ${g.id}`;
  return {
    app: { id: Number(g.id), name: g.name as string, all: g.all_characters as boolean, allowWrite: g.allow_write as boolean },
    characters: chars.map((r: Row): CharRow => ({ id: Number(r.character_id), name: r.name as string, needsReauth: r.needs_reauth as boolean })),
    picked: new Set<number>(picked.map((r: Row) => Number(r.character_id))),
  };
}

routes.get("/apps/:id", requireUser, async (c) => {
  const user = c.var.user!;
  return c.html(<ManagePage user={user} {...await loadManage(user.id, c.req.param("id"))} />);
});

routes.post("/apps/:id", requireUser, async (c) => {
  const user = c.var.user!;
  const m = await loadManage(user.id, c.req.param("id"));
  const parsed = manageBody.safeParse(await c.req.parseBody({ all: true }));
  const refuse = (error: string) => c.html(<ManagePage user={user} {...m} error={error} />, 400);
  if (!parsed.success) return refuse("That form was not understood. Try again.");
  const all = parsed.data.all_characters === "1";
  const allowWrite = parsed.data.allow_write === "1";
  const raw = parsed.data.characters === undefined ? [] : Array.isArray(parsed.data.characters) ? parsed.data.characters : [parsed.data.characters];
  const picked = [...new Set(raw.map(Number))];
  // Same rule as consent: an empty pick is refused, not stored as a grant that shows nothing.
  if (!all && picked.length === 0) return refuse("Pick at least one character, or choose all.");
  const own = new Set(m.characters.map((x: CharRow) => x.id));
  if (!all && picked.some((id) => !own.has(id))) return refuse("One of the selected characters is not yours.");

  const ok = await sql.begin(async (tx) => {
    const g = await tx`update grants set all_characters = ${all}, allow_write = ${allowWrite} where id = ${m.app.id} and user_id = ${user.id} and revoked_at is null returning id`;
    if (g.length === 0) return false;
    await tx`delete from grant_characters where grant_id = ${m.app.id}`;
    if (!all) for (const cid of picked) await tx`insert into grant_characters (grant_id, character_id) values (${m.app.id}, ${cid})`;
    return true;
  });
  if (!ok) throw new AppError("not_found", "App not found", 404);
  await audit(user.id, "grant_updated", { grant_id: m.app.id, all_characters: all, allow_write: allowWrite, characters: all ? [] : picked });
  return c.redirect(`/apps?saved=${m.app.id}`);
});
