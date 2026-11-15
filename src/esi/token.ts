import { config } from "../config";
import { decrypt, encrypt } from "../crypto";
import { sql } from "../db/db";
import { AppError } from "../errors";
import { log } from "../log";
import { refreshEveToken } from "../auth/eve-sso";
import { unlinkCharacter } from "../auth/characters";

// Swapped in tests so no real SSO call is made.
export const tokenDeps = { refresh: refreshEveToken, unlink: unlinkCharacter };

const relink = () => new AppError("character_needs_reauth", `This character must be re-linked: open ${config.publicUrl}/characters and add it again.`, 403);

const READ = (id: number) => sql`
  select access_token_enc, refresh_token_enc, owner_hash, needs_reauth,
         access_expires_at > now() + interval '60 seconds' as fresh
  from characters where character_id = ${id}`;

type Outcome = { token: string } | { fail: "reauth" | "owner_changed" };

// Postgres 55P03 = lock_not_available (our lock_timeout ran out): another refresh is stuck, tell the caller to retry.
export const isLockTimeout = (e: unknown) => ["errno", "code"].some((k) => (e as Record<string, unknown> | null)?.[k] === "55P03");
const locked = async <T>(characterId: number, run: () => Promise<T>) => {
  try {
    return await run();
  } catch (e) {
    if (!isLockTimeout(e)) throw e;
    log("warn", "token refresh lock timeout", { characterId });
    throw new AppError("token_refresh_busy", "Token refresh busy, try again in a few seconds.", 503);
  }
};

// Returns a usable access token. Stored token if it lives 60 s more, else one replica refreshes under a lock.
export async function accessToken(characterId: number): Promise<string> {
  const [r] = await READ(characterId);
  if (!r) throw new AppError("character_not_allowed", "This character is not available to this client. Call list_characters for the character IDs you may use.", 403);
  if (r.needs_reauth) throw relink();
  if (r.fresh && r.access_token_enc) return decrypt(r.access_token_enc);

  const out: Outcome = await locked(characterId, () => sql.begin(async (tx) => {
    // Two replicas refreshing at once could burn a rotated refresh token, so one at a time per character.
    // Bounded wait: the lock holder is inside an EVE call (10 s timeout), so 15 s is enough.
    await tx.unsafe("set local lock_timeout = '15s'");
    await tx`select pg_advisory_xact_lock(${characterId})`;
    const [row] = await tx`
      select access_token_enc, refresh_token_enc, owner_hash, needs_reauth,
             access_expires_at > now() + interval '60 seconds' as fresh
      from characters where character_id = ${characterId}`;
    if (!row || row.needs_reauth || !row.refresh_token_enc) return { fail: "reauth" } as Outcome;
    if (row.fresh && row.access_token_enc) return { token: await decrypt(row.access_token_enc) };
    try {
      const t = await tokenDeps.refresh(await decrypt(row.refresh_token_enc));
      if (t.ownerHash !== row.owner_hash) return { fail: "owner_changed" } as Outcome;
      await tx`
        update characters set access_token_enc = ${await encrypt(t.accessToken)}, refresh_token_enc = ${await encrypt(t.refreshToken)},
               access_expires_at = ${t.expiresAt}
        where character_id = ${characterId}`;
      return { token: t.accessToken };
    } catch (e) {
      if (e instanceof AppError && e.code === "eve_invalid_grant") {
        await tx`update characters set needs_reauth = true where character_id = ${characterId}`;
        return { fail: "reauth" } as Outcome;
      }
      throw e;
    }
  }));

  if ("token" in out) return out.token;
  if (out.fail === "owner_changed") {
    log("warn", "owner hash changed on refresh, unlinking", { characterId });
    await tokenDeps.unlink(characterId, "owner_changed");
    throw new AppError("character_not_allowed", "This character is not available to this client. Call list_characters for the character IDs you may use.", 403);
  }
  throw relink();
}
