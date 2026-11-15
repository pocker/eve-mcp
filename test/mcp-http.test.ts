import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { config } from "../src/config";
import { setEsiFetch } from "../src/esi/client";
import { routes } from "../src/mcp/routes";
import type { AppEnv } from "../src/types";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, seedCharacter, seedUser } from "./helpers/esi";

useTestSchema();
afterAll(() => setEsiFetch(undefined));

const app = new Hono<AppEnv>();
app.route("/", routes);

const TOKEN = "dev-token-for-tests";
config.devGrantToken = TOKEN;
config.isProd = false;

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });

describe("/mcp auth and origin (no DB)", () => {
  test("no token is 401", async () => {
    expect((await rpc({}, { authorization: "" })).status).toBe(401);
  });

  // wrong tokens are looked up in Postgres
  test.skipIf(!dbAvailable)("wrong token is 401", async () => {
    expect((await rpc({}, { authorization: "Bearer nope" })).status).toBe(401);
  });

  test.skipIf(!dbAvailable)("dev token is refused in production", async () => {
    config.isProd = true;
    try {
      expect((await rpc({})).status).toBe(401);
    } finally {
      config.isProd = false;
    }
  });

  test("unlisted Origin is 403", async () => {
    expect((await rpc({}, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("/mcp protocol (no DB)", () => {
  test("initialize and tools/list", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("eve-mcp");

    const list = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    const listed = list.result.tools.map((t: { name: string }) => t.name);
    expect(listed).toContain("get_skills");
    expect(listed).not.toContain("create_fitting"); // write tools are not listed for the dev grant
    expect(listed).not.toContain("delete_fitting");

  });
});

describe.skipIf(!dbAvailable)("/mcp end to end (needs Postgres)", () => {
  let charId: number;
  beforeAll(async () => {
    const uid = await seedUser();
    (config as { devUserId: number }).devUserId = uid;
    charId = await seedCharacter(uid, "Eve");
    setEsiFetch(fakeEsi({ "GET /status": () => ({ players: 42 }) }).fetch);
  });

  test("tools/call", async () => {
    const chars = (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_characters", arguments: {} } })).json()) as any;
    expect(JSON.parse(chars.result.content[0].text)[0].character_id).toBe(charId);

    const status = (await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_server_status", arguments: {} } })).json()) as any;
    expect(JSON.parse(status.result.content[0].text).players).toBe(42);

    const bad = (await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_skills", arguments: { character_id: 1 } } })).json()) as any;
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).not.toContain("at ");
  });
});

describe("/mcp rejections (no DB)", () => {
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer dev-token-for-tests", ...headers },
    body: JSON.stringify(body),
  });
const init = (v: string) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };

test("rejections: only a 2026 header without the envelope, bad JSON and init batches give 400; stale session id is ignored; logged as mcp_rejected", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  const out: Record<string, number> = {};
  out.newerInit = (await post(init("2026-07-28"), { "mcp-protocol-version": "2026-07-28" })).status;
  out.newerList = (await post(list, { "mcp-protocol-version": "2026-07-28" })).status;
  out.staleSessionInit = (await post(init("2025-06-18"), { "mcp-session-id": "old" })).status;
  out.staleSessionList = (await post(list, { "mcp-session-id": "old" })).status;
  out.badJson = (await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer dev-token-for-tests" }, body: "{" })).status;
  out.batchWithInit = (await post([init("2025-06-18"), list])).status;
  out.noAccept = (await post(list, { accept: "application/json" })).status;
  out.get = (await app.request("/mcp", { headers: { accept: "text/event-stream", authorization: "Bearer dev-token-for-tests" } })).status;
  const logs = spy.mock.calls.map((a) => String(a[0]));
  spy.mockRestore();
  expect(out).toMatchObject({ newerInit: 400, newerList: 400, staleSessionInit: 200, staleSessionList: 200, badJson: 400, batchWithInit: 400, noAccept: 406, get: 200 });
  expect(logs.some((l) => l.includes("mcp_rejected method=tools/list status=400") && l.includes("protocol=2026-07-28") && !l.includes("dev-token"))).toBe(true);
});
});

describe("/mcp protocol 2026-07-28 (no DB)", () => {
  test("server/discover returns server info; initialize with an older version still works", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    expect(res.status).toBe(200);
    const r = ((await res.json()) as any).result;
    expect(r.supportedVersions).toContain("2026-07-28");
    expect(r._meta["io.modelcontextprotocol/serverInfo"].name).toBe("eve-mcp");

    const init = await rpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("eve-mcp");
  });
});

describe("/mcp instructions and prompts on both protocol paths (no DB)", () => {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  const modern = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).result;
  };
  const legacy = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method, params });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).result;
  };
  const PROMPTS = ["asset_overview", "check_fit", "industry_check", "pilot_check", "plan_for_ship", "route_check"];

  test("instructions are delivered at discover and at initialize", async () => {
    const d = await modern("server/discover");
    const i = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    for (const text of [d.instructions, i.instructions]) {
      expect(text).toContain("list_characters");
      expect(text).toContain(`${config.publicUrl}/characters`);
      expect(text).toContain("PLEX");
    }
  });

  for (const [label, call] of [["2026-07-28", modern], ["legacy", legacy]] as const) {
    test(`prompts/list and prompts/get (${label})`, async () => {
      const list = await call("prompts/list");
      expect(list.prompts.map((p: { name: string }) => p.name).sort()).toEqual(PROMPTS);
      expect(list.prompts.find((p: any) => p.name === "route_check").arguments.map((a: any) => a.name)).toEqual(["from", "to"]);
      const got = await call("prompts/get", { name: "route_check", arguments: { from: "Jita", to: "Amarr" } });
      expect(got.messages[0].role).toBe("user");
      expect(got.messages[0].content.text).toContain("route_safety");
      expect(got.messages[0].content.text).toContain('"Jita"');
    });
  }

  test("prompt arguments are validated", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "route_check", arguments: { from: "Jita" } } });
    expect(((await res.json()) as any).error).toBeDefined();
  });
});

describe("/mcp per-IP limit (no DB)", () => {
  test("unauthenticated floods get 429 before auth", async () => {
    let last = 0;
    for (let i = 0; i < 400 && last !== 429; i++) last = (await rpc({}, { authorization: "" })).status;
    expect(last).toBe(429);
  });
});
