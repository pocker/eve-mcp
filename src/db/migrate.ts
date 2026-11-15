import { readdir } from "node:fs/promises";
import { sql } from "./db";
import { log } from "../log";

const LOCK_ID = 727001;
const dir = new URL("./migrations/", import.meta.url);

// Safe to call from several replicas at once: the advisory lock makes the others wait.
export async function migrate() {
  const lock = await sql.reserve();
  try {
    await lock`select pg_advisory_lock(${LOCK_ID})`;
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await sql`select name from schema_migrations`).map((r: { name: string }) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const name of files) {
      if (done.has(name)) continue;
      const text = await Bun.file(new URL(name, dir)).text();
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`insert into schema_migrations (name) values (${name})`;
      });
      log("info", "migration applied", { name });
    }
  } finally {
    await lock`select pg_advisory_unlock(${LOCK_ID})`;
    lock.release();
  }
}

if (import.meta.main) {
  await migrate();
  await sql.close();
}
