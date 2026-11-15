import { sql } from "../db/db";
import { decrypt } from "../crypto";
import { log } from "../log";
import { revokeEveToken } from "./eve-sso";

// Authed ESI cache keys are "GET <path>?<query>#<characterId>" (esi/client.ts cacheKey). The "GET " prefix skips name#<id> rows; LIKE is anchored at the end, so #12 does not match #123.
export const purgeCharacterCache = (ids: number[]) =>
  Promise.all(ids.map((id) => sql`delete from esi_cache where key like ${"GET %#" + Number(id)}`));

// Removes a character from its user (grant_characters cascade). Revoking the EVE token is best effort.
export async function unlinkCharacter(characterId: number, reason: string): Promise<void> {
  const [row] = await sql`select user_id, refresh_token_enc from characters where character_id = ${characterId}`;
  if (!row) return;
  if (row.refresh_token_enc) {
    try {
      await revokeEveToken(await decrypt(row.refresh_token_enc));
    } catch (e) {
      log("warn", "could not decrypt token for revoke", { characterId, err: e });
    }
  }
  await sql`delete from characters where character_id = ${characterId}`;
  await purgeCharacterCache([characterId]);
  await sql`insert into audit_log (user_id, event, detail) values (${row.user_id}, 'character_unlinked', ${JSON.stringify({ characterId, reason })}::jsonb)`;
}
