import { sql } from "../db/db";
import { AppError } from "../errors";

// What an MCP client may see: set by the /mcp auth middleware (OAuth, or the dev token outside production).
export type Grant = { id: number; userId: number; clientId: string; allCharacters: boolean; allowWrite: boolean };

export type CharacterRow = {
  character_id: number;
  user_id: number;
  name: string;
  owner_hash: string;
  scopes: string[];
  needs_reauth: boolean;
};

const COLS = sql`character_id, user_id, name, owner_hash, scopes, needs_reauth`;

function norm(r: Record<string, unknown>): CharacterRow {
  return { ...(r as CharacterRow), character_id: Number(r.character_id), user_id: Number(r.user_id) };
}

// Same error for "not yours", "not in grant" and "does not exist": no ID probing.
export async function requireCharacter(grant: Grant, characterId: number): Promise<CharacterRow> {
  const rows = await sql`
    select ${COLS} from characters c
    where c.character_id = ${characterId} and c.user_id = ${grant.userId}
      and (${grant.allCharacters} or exists (
        select 1 from grant_characters g where g.grant_id = ${grant.id} and g.character_id = c.character_id))`;
  if (!rows[0]) throw new AppError("character_not_allowed", "This character is not available to this client. Call list_characters for the character IDs you may use.", 403);
  return norm(rows[0]);
}

export async function grantCharacters(grant: Grant): Promise<CharacterRow[]> {
  const rows = await sql`
    select ${COLS} from characters c
    where c.user_id = ${grant.userId}
      and (${grant.allCharacters} or exists (
        select 1 from grant_characters g where g.grant_id = ${grant.id} and g.character_id = c.character_id))
    order by c.name`;
  return rows.map(norm);
}
