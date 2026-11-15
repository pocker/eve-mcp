import { sql } from "../db/db";

export async function audit(userId: number | null, event: string, detail: Record<string, unknown> = {}) {
  await sql`insert into audit_log (user_id, event, detail) values (${userId}, ${event}, ${JSON.stringify(detail)}::jsonb)`;
}

// Revokes the grant and every token under it. Returns false when it was already revoked or not found.
export async function revokeGrant(grantId: number, userId?: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update grants set revoked_at = now()
      where id = ${grantId} and revoked_at is null and (${userId ?? null}::int is null or user_id = ${userId ?? null})
      returning id`;
    if (rows.length === 0) return false;
    await tx`update oauth_tokens set revoked_at = now() where grant_id = ${grantId} and revoked_at is null`;
    return true;
  });
}
