import { sql } from "./db";
import { log } from "../log";

const LOCK_ID = 727002;

// Runs on every replica, but only the one that gets the lock does the work.
export async function prune() {
  const conn = await sql.reserve();
  try {
    const [row] = await conn`select pg_try_advisory_lock(${LOCK_ID}) as ok`;
    if (!row?.ok) return;
    try {
      await conn`delete from sessions where expires_at < now()`;
      await conn`delete from sso_states where expires_at < now()`;
      await conn`delete from oauth_codes where expires_at < now()`;
      await conn`delete from oauth_tokens where expires_at < now()`;
      await conn`delete from esi_cache where expires_at < now() - interval '1 day'`; // keeps stale rows so ETag revalidation works
      // Bucket rows only matter while their window or pause is open. Route rows (grp set) stay: they are few and replicas do not rewrite them.
      await conn`delete from esi_buckets where grp is null and updated_at < now() - interval '1 day'`;
      await conn`delete from audit_log where event = 'client_registered' and at < now() - interval '90 days'`; // holds the registering IP
      await conn`delete from oauth_clients c where created_at < now() - interval '7 days' and not exists (select 1 from grants g where g.client_id = c.client_id)`;
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_ID})`;
    }
  } finally {
    conn.release();
  }
}

export function startPrune() {
  const run = () => prune().catch((e) => log("error", "prune failed", { err: e }));
  setInterval(run, 60 * 60 * 1000).unref();
}
