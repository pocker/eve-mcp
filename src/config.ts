import { readFileSync } from "node:fs";
import { z } from "zod";

type Env = Record<string, string | undefined>;

const SECRETS = ["EVE_CLIENT_SECRET", "TOKEN_ENC_KEY", "TOKEN_ENC_KEY_OLD", "POSTGRES_PASSWORD", "DEV_GRANT_TOKEN"];

const key32 = z.string().refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes, base64 (openssl rand -base64 32)");
const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const schema = z.object({
  PUBLIC_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "set DATABASE_URL, or POSTGRES_HOST and POSTGRES_PASSWORD(_FILE)"),
  EVE_CLIENT_ID: z.string().min(1),
  EVE_CLIENT_SECRET: z.string().min(1),
  TOKEN_ENC_KEY: key32,
  TOKEN_ENC_KEY_OLD: key32.optional(),
  ESI_CONTACT: z.string().min(1),
  ESI_COMPAT_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").default("2026-08-18"),
  ADMIN_CHARACTER_IDS: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  CLIENT_IP_HEADER: z.string().optional(),
  DEV_GRANT_TOKEN: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DEV_USER_ID: z.coerce.number().int().positive().default(1),
  NODE_ENV: z.string().optional(),
});

// X_FILE (file contents, trimmed) wins over X. Empty values count as unset.
function resolve(env: Env): Env {
  const out: Env = { ...env };
  for (const name of SECRETS) {
    const file = env[`${name}_FILE`];
    if (file) out[name] = readFileSync(file, "utf8").trim();
  }
  for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
  if (!out.DATABASE_URL && out.POSTGRES_HOST && out.POSTGRES_PASSWORD) {
    const user = encodeURIComponent(out.POSTGRES_USER ?? "eve");
    const pass = encodeURIComponent(out.POSTGRES_PASSWORD);
    out.DATABASE_URL = `postgres://${user}:${pass}@${out.POSTGRES_HOST}:${out.POSTGRES_PORT ?? 5432}/${out.POSTGRES_DB ?? "eve_mcp"}`;
  }
  return out;
}

export function loadConfig(env: Env) {
  const r = schema.safeParse(resolve(env));
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = r.data;
  if (e.DEV_GRANT_TOKEN && e.PUBLIC_URL.startsWith("https://")) {
    throw new Error("Invalid configuration: DEV_GRANT_TOKEN is a development shortcut and must not be set when PUBLIC_URL is https://");
  }
  return {
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    eveClientId: e.EVE_CLIENT_ID,
    eveClientSecret: e.EVE_CLIENT_SECRET,
    tokenEncKey: e.TOKEN_ENC_KEY,
    tokenEncKeyOld: e.TOKEN_ENC_KEY_OLD,
    esiContact: e.ESI_CONTACT,
    esiCompatDate: e.ESI_COMPAT_DATE,
    adminCharacterIds: list(e.ADMIN_CHARACTER_IDS).map(Number).filter(Number.isSafeInteger),
    allowedOrigins: list(e.ALLOWED_ORIGINS),
    clientIpHeader: e.CLIENT_IP_HEADER,
    devGrantToken: e.DEV_GRANT_TOKEN,
    devUserId: e.DEV_USER_ID,
    isProd: e.NODE_ENV === "production",
  };
}

export type Config = ReturnType<typeof loadConfig>;
export const config = loadConfig(process.env);
