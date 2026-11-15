import type { MiddlewareHandler } from "hono";
import { config } from "../config";
import { sha256 } from "../crypto";
import { sql } from "../db/db";
import type { AppEnv } from "../types";

export const RESOURCE = `${config.publicUrl}/mcp`;
const METADATA_URL = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

function unauthorized(c: Parameters<MiddlewareHandler>[0], tokenSent: boolean) {
  const challenge = `Bearer resource_metadata="${METADATA_URL}"${tokenSent ? ', error="invalid_token"' : ""}`;
  return c.json({ error: tokenSent ? "invalid_token" : "unauthorized" }, 401, { "WWW-Authenticate": challenge });
}

// Guards /mcp. Accepts only access tokens issued for this resource (RFC 8707).
export const mcpAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.header("authorization")?.match(/^Bearer +(\S+)$/i);
  const token = m?.[1];
  if (!token) return unauthorized(c, false);

  if (!config.isProd && config.devGrantToken && token === config.devGrantToken) {
    c.set("grant", { id: 0, userId: config.devUserId, clientId: "dev", allCharacters: true, allowWrite: false });
    return next();
  }

  const [row] = await sql`
    select g.id, g.user_id, g.client_id, g.all_characters, g.allow_write,
           (g.last_used_at is null or g.last_used_at < now() - interval '1 minute') as touch
    from oauth_tokens t
    join grants g on g.id = t.grant_id
    join users u on u.id = g.user_id
    where t.token_hash = ${sha256(token)} and t.kind = 'access' and t.resource = ${RESOURCE}
      and t.expires_at > now() and t.revoked_at is null
      and g.revoked_at is null and u.disabled_at is null`;
  if (!row) return unauthorized(c, true);

  const id = Number(row.id);
  if (row.touch) await sql`update grants set last_used_at = now() where id = ${id}`;
  c.set("grant", { id, userId: Number(row.user_id), clientId: row.client_id, allCharacters: row.all_characters, allowWrite: row.allow_write === true });
  return next();
};
