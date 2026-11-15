import { config } from "../config";
import { AppError } from "../errors";
import type { CharacterRow } from "../mcp/grant";
import { esiCall, esiGet, esiGetAll, type Query } from "./client";
import { accessToken } from "./token";

// Authed ESI call for a character the grant check already passed. Checks the stored scope first.
async function prepare(c: CharacterRow, scope: string) {
  if (!c.scopes.includes(scope)) {
    throw new AppError("missing_scope", `Character "${c.name}" has not granted the scope ${scope}. Re-link it at ${config.publicUrl}/characters to grant it.`, 403);
  }
  return { token: await accessToken(c.character_id), characterId: c.character_id };
}

export async function charGet(c: CharacterRow, scope: string, path: string, query?: Query): Promise<unknown> {
  return esiGet(path, { ...(await prepare(c, scope)), query });
}

export async function charGetAll(c: CharacterRow, scope: string, path: string, query?: Query, maxPages?: number) {
  return esiGetAll(path, { ...(await prepare(c, scope)), query }, maxPages);
}

// Writes change game data: never cached, never retried (not idempotent). Caller checks grant.allowWrite.
export async function charWrite(c: CharacterRow, scope: string, method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  return (await esiCall(method, path, { ...(await prepare(c, scope)), body })).data;
}
