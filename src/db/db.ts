import { SQL } from "bun";
import { config } from "../config";

// Connects lazily, so importing this never needs a running database.
export let sql = new SQL(config.databaseUrl, { max: config.dbPoolMax });

// Tests only: point `sql` at one schema (importers see the new client through the live binding).
export async function useSchema(schema: string) {
  await sql.close();
  sql = new SQL(config.databaseUrl, { max: config.dbPoolMax, connection: { search_path: schema } });
}
