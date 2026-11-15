// Tests never need a real .env: fill in fake values before any module reads config.
const fake: Record<string, string> = {
  PUBLIC_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://eve:eve@localhost:5432/eve_mcp",
  EVE_CLIENT_ID: "test-client",
  EVE_CLIENT_SECRET: "test-secret",
  TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
  ESI_CONTACT: "test@example.com",
};
for (const [k, v] of Object.entries(fake)) process.env[k] ??= v;
// DB tests: the app client must use the same database the helper probes.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
