import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

const key = Buffer.alloc(32, 7).toString("base64");
const base = {
  PUBLIC_URL: "https://x.example/",
  DATABASE_URL: "postgres://a:b@h/d",
  EVE_CLIENT_ID: "id",
  EVE_CLIENT_SECRET: "sec",
  TOKEN_ENC_KEY: key,
  ESI_CONTACT: "me@example.com",
};

test("defaults and parsing", () => {
  const c = loadConfig({ ...base, ADMIN_CHARACTER_IDS: "1, 2", CLIENT_IP_HEADER: "CF-Connecting-IP" });
  expect(c.publicUrl).toBe("https://x.example");
  expect(c.port).toBe(3000);
  expect(c.adminCharacterIds).toEqual([1, 2]);
  expect(c.clientIpHeader).toBe("CF-Connecting-IP");
});

test("fails fast with a clear message", () => {
  expect(() => loadConfig({ ...base, TOKEN_ENC_KEY: "short" })).toThrow(/TOKEN_ENC_KEY/);
  expect(() => loadConfig({})).toThrow(/Invalid configuration/);
});

test("X_FILE wins over X", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "s"), "from-file\n");
  const c = loadConfig({ ...base, EVE_CLIENT_SECRET: "from-env", EVE_CLIENT_SECRET_FILE: join(dir, "s") });
  expect(c.eveClientSecret).toBe("from-file");
});

test("builds DATABASE_URL from parts and encodes the password", () => {
  const { DATABASE_URL: _, ...rest } = base;
  const c = loadConfig({ ...rest, POSTGRES_HOST: "postgres", POSTGRES_USER: "eve", POSTGRES_DB: "eve_mcp", POSTGRES_PASSWORD: "p@ss/w:rd" });
  expect(c.databaseUrl).toBe("postgres://eve:p%40ss%2Fw%3Ard@postgres:5432/eve_mcp");
});

test("password can come from POSTGRES_PASSWORD_FILE", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p"), "secret\n");
  const { DATABASE_URL: _, ...rest } = base;
  const c = loadConfig({ ...rest, POSTGRES_HOST: "h", POSTGRES_PASSWORD_FILE: join(dir, "p") });
  expect(c.databaseUrl).toContain(":secret@h:5432/");
});

test("DEV_GRANT_TOKEN is refused with an https PUBLIC_URL", () => {
  expect(() => loadConfig({ ...base, DEV_GRANT_TOKEN: "dev" })).toThrow(/DEV_GRANT_TOKEN.*https/);
  expect(loadConfig({ ...base, PUBLIC_URL: "http://localhost:3000", DEV_GRANT_TOKEN: "dev" }).devGrantToken).toBe("dev");
  expect(loadConfig(base).devGrantToken).toBeUndefined();
});

test("DB_POOL_MAX defaults to 20", () => {
  expect(loadConfig(base).dbPoolMax).toBe(20);
  expect(loadConfig({ ...base, DB_POOL_MAX: "5" }).dbPoolMax).toBe(5);
});
