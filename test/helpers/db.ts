import { afterAll, beforeAll } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../../src/db/migrate";
import { sql, useSchema } from "../../src/db/db";

const url = process.env.TEST_DATABASE_URL ?? "postgres://eve:eve@localhost:5432/eve_mcp";
const admin = new SQL(url, { max: 1 });

async function probe() {
  try {
    await Promise.race([admin`select 1`, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 2000))]);
    return true;
  } catch (e) {
    console.log(`DB tests skipped: Postgres not reachable at TEST_DATABASE_URL (${(e as Error).message}). Run: bun run db:up`);
    return false;
  }
}

export const dbAvailable = await probe();

// Call once at the top of a test file: gives it a fresh migrated schema, dropped afterwards.
export function useTestSchema() {
  const schema = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    if (!dbAvailable) return;
    await admin.unsafe(`create schema ${schema}`);
    await useSchema(schema);
    await migrate();
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await sql.close();
    await admin.unsafe(`drop schema ${schema} cascade`);
  });
}
