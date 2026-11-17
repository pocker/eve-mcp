import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { fetchMetadataDocument, isPrivateIp, net, redirectMatches, validRedirectUri } from "../src/oauth/clients";
import { routes } from "../src/oauth/routes";
import { mcpAuth } from "../src/oauth/bearer";
import { sql } from "../src/db/db";
import { sha256 } from "../src/crypto";
import type { AppEnv } from "../src/types";
import { dbAvailable, useTestSchema } from "./helpers/db";

useTestSchema();

const BASE = "http://localhost:3000";
const RESOURCE = `${BASE}/mcp`;

// Stand-in for sessionMiddleware: the x-user header is the signed-in user id.
const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  const id = c.req.header("x-user");
  if (id) c.set("user", { id: Number(id), isAdmin: false });
  await next();
});
app.onError((err, c) => c.json({ error: err.message }, ((err as { status?: number }).status ?? 500) as 404));
app.route("/", routes);
app.get("/mcp", mcpAuth, (c) => c.json(c.var.grant));

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});
const verifier = "v".repeat(50);
const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

describe("metadata", () => {
  test("protected resource and authorization server documents", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.request(p);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [BASE], bearer_methods_supported: ["header"] });
    }
    const as = (await (await app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  test("CORS preflight on token endpoint", async () => {
    const res = await app.request("/oauth/token", { method: "OPTIONS", headers: { origin: "https://x.example", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("registration input", () => {
  test("redirect URI rules", () => {
    expect(validRedirectUri("https://app.example/cb")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:8123/cb")).toBe(true);
    expect(validRedirectUri("http://localhost/cb")).toBe(true);
    expect(validRedirectUri("http://evil.example/cb")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validRedirectUri("myapp://cb")).toBe(false);
    expect(validRedirectUri("https://app.example/cb#frag")).toBe(false);
    expect(validRedirectUri("https://user:pw@app.example/cb")).toBe(false);
  });

  test("bad registrations are refused", async () => {
    const post = (body: unknown) => app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = await post({ redirect_uris: ["http://evil.example/cb"] });
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    expect((await post({ client_name: "x" })).status).toBe(400);
    expect((await post({ redirect_uris: ["https://a.example/cb"], client_name: "n".repeat(500) })).status).toBe(400);
  });
});

describe("SSRF guard", () => {
  test("private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateIp(ip)).toBe(false);
  });

  test("IPv6 ranges and IPv4 embedded in IPv6", () => {
    for (const ip of [
      "::", "::2", "::7f00:1", "::10.0.0.1", "::8.8.8.8", "::ffff:8.8.8.8", "::ffff:808:808", "0:0:0:0:0:ffff:7f00:1", "[::ffff:127.0.0.1]",
      "64:ff9b::7f00:1", "64:ff9b::8.8.8.8", "2002:7f00:1::", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "fc00::1", "fdff::1", "fe80::1", "febf::1", "ff02::1", "not-an-ip", "1:2:3",
    ]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["2001:db9::1", "2a00:1450:4001::200e", "2606:4700::1111", "fec0::1"]) expect(isPrivateIp(ip)).toBe(false);
    for (const ip of ["224.0.0.1", "240.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "203.0.113.5", "198.51.100.1", "100.127.255.255", "999.1.1.1"]) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ["100.63.255.255", "100.128.0.1", "192.0.1.1"]) expect(isPrivateIp(ip)).toBe(false);
  });

  const realFetch = net.fetch;
  const realResolve = net.resolve;
  const doc = (url: string, extra = {}) => JSON.stringify({ client_id: url, client_name: "Doc client", redirect_uris: ["https://doc.example/cb"], ...extra });
  const url = "https://doc.example/client.json";

  test("refuses private resolution, http, redirects, big and mismatched documents; accepts a good one", async () => {
    let fetched = 0;
    net.fetch = async () => (fetched++, new Response(doc(url)));
    net.resolve = async () => ["10.0.0.5"];
    await expect(fetchMetadataDocument(url)).rejects.toThrow();
    expect(fetched).toBe(0);

    net.resolve = async () => ["93.184.216.34", "127.0.0.1"];
    await expect(fetchMetadataDocument(url)).rejects.toThrow();

    net.resolve = async () => ["93.184.216.34"];
    await expect(fetchMetadataDocument("http://doc.example/client.json")).rejects.toThrow();
    await expect(fetchMetadataDocument("https://doc.example/")).rejects.toThrow();

    net.fetch = async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await expect(fetchMetadataDocument(url)).rejects.toThrow();

    net.fetch = async () => new Response("x".repeat(70_000));
    await expect(fetchMetadataDocument(url)).rejects.toThrow();

    net.fetch = async () => new Response(doc("https://other.example/client.json"));
    await expect(fetchMetadataDocument(url)).rejects.toThrow();

    net.fetch = async () => new Response(doc(url, { redirect_uris: ["http://evil.example/cb"] }));
    await expect(fetchMetadataDocument(url)).rejects.toThrow();

    net.fetch = async () => new Response(doc(url));
    expect(await fetchMetadataDocument(url)).toEqual({ clientId: url, name: "Doc client", redirectUris: ["https://doc.example/cb"] });
    net.fetch = realFetch;
    net.resolve = realResolve;
  });

  test("auth methods: accepted when the client can use none, rejected otherwise", async () => {
    net.resolve = async () => ["93.184.216.34"];
    const ok = { name: "Doc client", clientId: url, redirectUris: ["https://doc.example/cb"] };
    const chatgpt = { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], jwks_uri: "https://doc.example/jwks.json" };
    net.fetch = async () => new Response(doc(url, chatgpt));
    expect(await fetchMetadataDocument(url)).toEqual(ok);
    net.fetch = async () => new Response(doc(url, { token_endpoint_auth_method: "none" }));
    expect(await fetchMetadataDocument(url)).toEqual(ok);
    net.fetch = async () => new Response(doc(url, { token_endpoint_auth_method: "private_key_jwt" }));
    await expect(fetchMetadataDocument(url)).rejects.toThrow("none");
    net.fetch = async () => new Response(doc(url, { token_endpoint_auth_methods_supported: ["private_key_jwt"] }));
    await expect(fetchMetadataDocument(url)).rejects.toThrow("none");
    net.fetch = realFetch;
    net.resolve = realResolve;
  });
});

describe("mcpAuth without a token", () => {
  test("401 with resource_metadata", async () => {
    const res = await app.request("/mcp");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });
});

describe.skipIf(!dbAvailable)("OAuth flow (needs Postgres)", () => {
  const redirect = "http://127.0.0.1:9999/cb";

  async function setup() {
    const [u] = await sql`insert into users default values returning id`;
    const userId = Number(u!.id);
    const chars: number[] = [];
    for (let i = 0; i < 2; i++) {
      const cid = Math.floor(Math.random() * 1e9) + 1e9;
      await sql`insert into characters (character_id, user_id, name, owner_hash) values (${cid}, ${userId}, ${"Pilot " + cid}, 'h')`;
      chars.push(cid);
    }
    const clientId = `client-${crypto.randomUUID()}`;
    await sql`insert into oauth_clients (client_id, name, redirect_uris) values (${clientId}, 'Test <b>app</b>', ${sql.array([redirect], "TEXT")})`;
    return { userId, chars, clientId };
  }

  const authzQuery = (clientId: string, o: Record<string, string> = {}) =>
    new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st8", ...o }).toString();

  // Runs consent (POST) and returns the code from the redirect page.
  async function consent(userId: number, clientId: string, characters: number[], extra: Record<string, string> = {}) {
    const body = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, code_challenge: challenge, resource: RESOURCE, state: "st8", decision: "allow", ...extra });
    for (const c of characters) body.append("characters", String(c));
    const res = await app.request("/oauth/authorize", { method: "POST", headers: { "x-user": String(userId), "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    return res;
  }
  const codeFrom = async (res: Response) => {
    const text = await res.text();
    const m = text.match(/href="([^"]+)"/);
    return m ? new URL(m[1]!.replaceAll("&amp;", "&")) : null;
  };

  async function fullFlow(userId: number, clientId: string, characters: number[]) {
    const url = await codeFrom(await consent(userId, clientId, characters));
    const code = url!.searchParams.get("code")!;
    const res = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));
    return { code, res, tokens: (await res.json()) as { access_token: string; refresh_token: string } };
  }

  test("registration creates a client; valid DCR returns client_id", async () => {
    const res = await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: "Reg app" }) });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { client_id: string };
    const [row] = await sql`select name from oauth_clients where client_id = ${j.client_id}`;
    expect(row!.name).toBe("Reg app");
  });

  test("authorize: bad client or redirect_uri shows an error page, other errors redirect", async () => {
    const { userId, clientId } = await setup();
    const get = (q: string) => app.request(`/oauth/authorize?${q}`, { headers: { "x-user": String(userId) }, redirect: "manual" });
    expect((await get(authzQuery("nope"))).status).toBe(400);
    expect((await get(authzQuery(clientId, { redirect_uri: "http://127.0.0.1:9999/other" }))).status).toBe(400);

    const noPkce = await get(authzQuery(clientId, { code_challenge_method: "plain" }));
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
    expect(loc.searchParams.get("state")).toBe("st8");
    expect(loc.searchParams.get("iss")).toBe(BASE);

    const badRes = await get(authzQuery(clientId, { resource: "https://other.example/mcp" }));
    expect(new URL(badRes.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

    const ok = await get(authzQuery(clientId));
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("127.0.0.1:9999");
    expect(html).not.toContain("<b>app</b>");
  });

  test("authorize without a session goes to login", async () => {
    const res = await app.request(`/oauth/authorize?${authzQuery("x")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toStartWith("/auth/login?return_to=");
  });

  test("consent only accepts the user's own characters", async () => {
    const a = await setup();
    const b = await setup();
    const res = await consent(a.userId, a.clientId, [b.chars[0]!]);
    expect(res.status).toBe(400);
    expect((await sql`select 1 from grants where user_id = ${a.userId}`).length).toBe(0);
    expect((await consent(a.userId, a.clientId, [])).status).toBe(400);

    const deny = await codeFrom(await consent(a.userId, a.clientId, [a.chars[0]!], { decision: "deny" }));
    expect(deny!.searchParams.get("error")).toBe("access_denied");
    expect(deny!.searchParams.get("state")).toBe("st8");
    expect((await sql`select 1 from grants where user_id = ${a.userId}`).length).toBe(0);

    const ok = await codeFrom(await consent(a.userId, a.clientId, [a.chars[0]!]));
    expect(ok!.searchParams.get("code")).toBeTruthy();
    expect(ok!.searchParams.get("iss")).toBe(BASE);
    const [g] = await sql`select id, all_characters from grants where user_id = ${a.userId}`;
    expect(g!.all_characters).toBe(false);
    const gc = await sql`select character_id from grant_characters where grant_id = ${g!.id}`;
    expect(gc.map((r: { character_id: unknown }) => Number(r.character_id))).toEqual([a.chars[0]!]);
  });

  test("full code flow, then mcpAuth sets the grant", async () => {
    const { userId, chars, clientId } = await setup();
    const { code, res, tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [stored] = await sql`select token_hash from oauth_tokens where token_hash = ${sha256(tokens.access_token)}`;
    expect(stored).toBeTruthy();
    expect((await sql`select 1 from oauth_codes where code_hash = ${code}`).length).toBe(0); // only the hash is stored

    const mcp = await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toMatchObject({ userId, clientId, allCharacters: false });
    const [g] = await sql`select last_used_at from grants where user_id = ${userId}`;
    expect(g!.last_used_at).toBeTruthy();
  });

  test("consent stores allow_write only when the box is ticked", async () => {
    const { userId, chars, clientId } = await setup();
    await consent(userId, clientId, [chars[0]!]);
    await consent(userId, clientId, [chars[0]!], { allow_write: "1" });
    const rows = await sql`select allow_write from grants where user_id = ${userId} order by id`;
    expect(rows.map((r: { allow_write: boolean }) => r.allow_write)).toEqual([false, true]);
    const apps = await (await app.request("/apps", { headers: { "x-user": String(userId) } })).text();
    expect(apps).toContain("can write fittings");
    expect(apps).toContain("read only");
    const page = await (await app.request(`/oauth/authorize?${authzQuery(clientId)}`, { headers: { "x-user": String(userId) } })).text();
    expect(page).toContain("create and delete fittings");
    expect(page).not.toMatch(/name="allow_write"[^>]*checked/);
  });

  test("wrong verifier, wrong redirect_uri, wrong client are refused", async () => {
    const { userId, chars, clientId } = await setup();
    const url = await codeFrom(await consent(userId, clientId, [chars[0]!]));
    const code = url!.searchParams.get("code")!;
    const base = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect };
    for (const bad of [{ code_verifier: "w".repeat(50) }, { redirect_uri: "http://127.0.0.1:9999/other" }, { client_id: "other" }]) {
      const res = await app.request("/oauth/token", form({ ...base, ...bad }));
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    // a wrong attempt does not burn the code
    expect((await app.request("/oauth/token", form(base))).status).toBe(200);
  });

  test("code reuse revokes the grant and its tokens", async () => {
    const { userId, chars, clientId } = await setup();
    const { code, tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    const again = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect }));
    expect(again.status).toBe(400);
    const mcp = await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(mcp.status).toBe(401);
    const refresh = await app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(refresh.status).toBe(400);
  });

  test("code reuse with a wrong PKCE verifier does not revoke the grant", async () => {
    const { userId, chars, clientId } = await setup();
    const { code, tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    const again = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: "w".repeat(50), client_id: clientId, redirect_uri: redirect }));
    expect(again.status).toBe(400);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);
    const other = await app.request("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: "someone-else", redirect_uri: redirect }));
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);
  });

  test("refresh revokes the grant's older access tokens", async () => {
    const { userId, chars, clientId } = await setup();
    const { tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    const r = await app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    const t2 = (await r.json()) as { access_token: string };
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(200);
  });

  test("consent page defaults to all characters", async () => {
    const { userId, clientId } = await setup();
    const html = await (await app.request(`/oauth/authorize?${authzQuery(clientId)}`, { headers: { "x-user": String(userId) } })).text();
    expect(html).toMatch(/name="all_characters" value="1" checked/);
    expect(html).not.toMatch(/name="all_characters" value="0" checked/);
    expect(html).not.toMatch(/name="allow_write"[^>]*checked/);
    const [g0] = [await codeFrom(await consent(userId, clientId, [], { all_characters: "1" }))];
    expect(g0!.searchParams.get("code")).toBeTruthy();
    const [g] = await sql`select all_characters from grants where user_id = ${userId}`;
    expect(g!.all_characters).toBe(true);
  });

  test("consent page leads with the redirect host and labels the app name as self-claimed", async () => {
    const { userId, clientId } = await setup();
    const html = await (await app.request(`/oauth/authorize?${authzQuery(clientId)}`, { headers: { "x-user": String(userId) } })).text();
    expect(html).toMatch(/An app at <strong>[^<]+<\/strong> wants/);
    expect(html).toContain("Unverified app");
    expect(html).toContain("calls itself");
    expect(html.indexOf("Unverified app")).toBeGreaterThan(html.indexOf("An app at"));
  });

  // The document is shaped like ChatGPT's: singular private_key_jwt, plural lists none. (Fetched here, not pre-inserted; it shares the authorize rate limit, so no extra request.)
  test("consent page for a URL client_id (fetched document) shows the client_id host as the identity", async () => {
    const { userId } = await setup();
    const cid = "https://cimd.example/meta.json";
    const realFetch = net.fetch;
    const realResolve = net.resolve;
    net.resolve = async () => ["93.184.216.34"];
    net.fetch = async () =>
      new Response(JSON.stringify({ client_id: cid, client_name: "Friendly Bank", redirect_uris: [redirect], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_signing_alg: "RS256", jwks_uri: "https://cimd.example/jwks.json" }));
    try {
      const res = await app.request(`/oauth/authorize?${authzQuery(cid)}`, { headers: { "x-user": String(userId) } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<strong>cimd.example</strong>");
      expect(html).toContain("calls itself");
      expect(html).not.toContain("Unverified app");
    } finally {
      net.fetch = realFetch;
      net.resolve = realResolve;
    }
  });

  test("redirectMatches: exact, or any port on the same loopback http host", () => {
    expect(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:33935/callback")).toBe(true);
    expect(redirectMatches("http://localhost:1/cb", "http://localhost:2/cb")).toBe(true);
    expect(redirectMatches("http://[::1]/cb", "http://[::1]:8080/cb")).toBe(true);
    expect(redirectMatches("https://app.example/cb", "https://app.example/cb")).toBe(true);
    expect(redirectMatches("http://127.0.0.1/callback", "http://127.0.0.1:5/other")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb?a=1", "http://127.0.0.1:5/cb?a=2")).toBe(false);
    expect(redirectMatches("https://127.0.0.1/cb", "https://127.0.0.1:5/cb")).toBe(false);
    expect(redirectMatches("https://app.example/cb", "https://app.example:444/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb", "http://localhost:5/cb")).toBe(false);
    expect(redirectMatches("http://app.example/cb", "http://app.example:5/cb")).toBe(false);
    expect(redirectMatches("http://127.0.0.1/cb", "not a url")).toBe(false);
  });

  test("consent page for a Codex-shaped client accepts a random loopback port", async () => {
    const { userId } = await setup();
    const cid = "https://chatgpt.com/oauth/codex/client.json";
    const realFetch = net.fetch;
    const realResolve = net.resolve;
    net.resolve = async () => ["93.184.216.34"];
    net.fetch = async () =>
      new Response(JSON.stringify({ client_id: cid, client_uri: "https://chatgpt.com/codex", application_type: "native", redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"], token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["none"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "Codex" }));
    try {
      const q = authzQuery(cid).replace(encodeURIComponent(redirect), encodeURIComponent("http://127.0.0.1:33935/callback"));
      const res = await app.request(`/oauth/authorize?${q}`, { headers: { "x-user": String(userId) } });
      expect(res.status).toBe(200);
    } finally {
      net.fetch = realFetch;
      net.resolve = realResolve;
    }
  });

  test("refresh rotates; reuse of the old token revokes the grant", async () => {
    const { userId, chars, clientId } = await setup();
    const { tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    const r1 = await app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(r1.status).toBe(200);
    const t2 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(tokens.refresh_token);
    const [old] = await sql`select replaced_by from oauth_tokens where token_hash = ${sha256(tokens.refresh_token)}`;
    expect(old!.replaced_by).toBe(sha256(t2.refresh_token));
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(200);

    const replay = await app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }));
    expect(replay.status).toBe(400);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(401);
    const live = await app.request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: clientId }));
    expect(live.status).toBe(400);
    const ev = await sql`select 1 from audit_log where user_id = ${userId} and event = 'refresh_reuse_detected'`;
    expect(ev.length).toBe(1);
  });

  test("revoked grant, disabled user, wrong audience -> 401 with WWW-Authenticate", async () => {
    const { userId, chars, clientId } = await setup();
    const { tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    expect((await app.request("/mcp", { headers: auth })).status).toBe(200);

    await sql`update oauth_tokens set resource = 'https://other.example/mcp' where token_hash = ${sha256(tokens.access_token)}`;
    expect((await app.request("/mcp", { headers: auth })).status).toBe(401);
    await sql`update oauth_tokens set resource = ${RESOURCE} where token_hash = ${sha256(tokens.access_token)}`;

    await sql`update users set disabled_at = now() where id = ${userId}`;
    expect((await app.request("/mcp", { headers: auth })).status).toBe(401);
    await sql`update users set disabled_at = null where id = ${userId}`;

    await sql`update grants set revoked_at = now() where user_id = ${userId}`;
    const res = await app.request("/mcp", { headers: auth });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  test("/apps lists grants; revoke by another user is refused", async () => {
    const a = await setup();
    const b = await setup();
    const { tokens } = await fullFlow(a.userId, a.clientId, [a.chars[0]!]);
    const [g] = await sql`select id from grants where user_id = ${a.userId}`;

    const list = await app.request("/apps", { headers: { "x-user": String(a.userId) } });
    expect(await list.text()).toContain("Pilot");

    const other = await app.request(`/apps/${g!.id}/revoke`, { method: "POST", headers: { "x-user": String(b.userId) } });
    expect(other.status).toBe(404);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200);

    const own = await app.request(`/apps/${g!.id}/revoke`, { method: "POST", headers: { "x-user": String(a.userId) }, redirect: "manual" });
    expect(own.status).toBe(302);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
  });

  test("manage: owner switches between all characters and a ticked subset, audit row written", async () => {
    const a = await setup();
    await fullFlow(a.userId, a.clientId, [a.chars[0]!]);
    const [g] = await sql`select id from grants where user_id = ${a.userId}`;
    const hdr = { "x-user": String(a.userId), "content-type": "application/x-www-form-urlencoded" };
    const page = await (await app.request(`/apps/${g!.id}`, { headers: hdr })).text();
    expect(page).toContain("create and delete fittings");
    expect(page).not.toMatch(/name="allow_write"[^>]*checked/);

    const save = (fields: [string, string][]) => app.request(`/apps/${g!.id}`, { method: "POST", headers: hdr, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    let res = await save([["all_characters", "1"]]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/apps?saved=${g!.id}`);
    let [row] = await sql`select all_characters, allow_write from grants where id = ${g!.id}`;
    expect(row).toMatchObject({ all_characters: true, allow_write: false });
    expect(await sql`select 1 from grant_characters where grant_id = ${g!.id}`).toHaveLength(0);
    expect(await (await app.request(`/apps?saved=${g!.id}`, { headers: hdr })).text()).toContain("Saved changes to");

    res = await save([["all_characters", "0"], ["characters", String(a.chars[1])], ["allow_write", "1"]]);
    expect(res.status).toBe(302);
    [row] = await sql`select all_characters, allow_write from grants where id = ${g!.id}`;
    expect(row).toMatchObject({ all_characters: false, allow_write: true });
    const gc = await sql`select character_id from grant_characters where grant_id = ${g!.id}`;
    expect(gc.map((r: { character_id: string }) => Number(r.character_id))).toEqual([a.chars[1]!]);
    const [au] = await sql`select detail from audit_log where user_id = ${a.userId} and event = 'grant_updated' order by id desc limit 1`;
    expect(JSON.parse(au!.detail)).toMatchObject({ grant_id: g!.id, all_characters: false, allow_write: true, characters: [a.chars[1]!] });
  });

  test("manage: ticked-only with no character is refused and changes nothing", async () => {
    const a = await setup();
    await fullFlow(a.userId, a.clientId, [a.chars[0]!]);
    const [g] = await sql`select id from grants where user_id = ${a.userId}`;
    const res = await app.request(`/apps/${g!.id}`, { method: "POST", headers: { "x-user": String(a.userId), "content-type": "application/x-www-form-urlencoded" }, body: "all_characters=0&allow_write=1" });
    expect(res.status).toBe(400);
    const [row] = await sql`select allow_write from grants where id = ${g!.id}`;
    expect(row!.allow_write).toBe(false);
  });

  test("manage: another user's grant is 404 on GET and POST; their character cannot be ticked; revoked grant is 404", async () => {
    const a = await setup();
    const b = await setup();
    await fullFlow(a.userId, a.clientId, [a.chars[0]!]);
    const [g] = await sql`select id from grants where user_id = ${a.userId}`;
    const post = (user: number, body: string) =>
      app.request(`/apps/${g!.id}`, { method: "POST", headers: { "x-user": String(user), "content-type": "application/x-www-form-urlencoded" }, body });
    expect((await app.request(`/apps/${g!.id}`, { headers: { "x-user": String(b.userId) } })).status).toBe(404);
    expect((await post(b.userId, "all_characters=1&allow_write=1")).status).toBe(404);
    expect((await app.request(`/apps/abc`, { headers: { "x-user": String(a.userId) } })).status).toBe(404);

    const foreign = await post(a.userId, `all_characters=0&characters=${b.chars[0]}`);
    expect(foreign.status).toBe(400);
    const [row] = await sql`select all_characters, allow_write from grants where id = ${g!.id}`;
    expect(row).toMatchObject({ all_characters: false, allow_write: false });
    const gc = await sql`select character_id from grant_characters where grant_id = ${g!.id}`;
    expect(gc.map((r: { character_id: string }) => Number(r.character_id))).toEqual([a.chars[0]!]);

    await sql`update grants set revoked_at = now() where id = ${g!.id}`;
    expect((await app.request(`/apps/${g!.id}`, { headers: { "x-user": String(a.userId) } })).status).toBe(404);
    expect((await post(a.userId, "all_characters=1")).status).toBe(404);
  });

  test("/oauth/revoke always answers 200 and kills the grant for a refresh token", async () => {
    const { userId, chars, clientId } = await setup();
    const { tokens } = await fullFlow(userId, clientId, [chars[0]!]);
    expect((await app.request("/oauth/revoke", form({ token: "garbage" }))).status).toBe(200);
    expect((await app.request("/oauth/revoke", form({ token: tokens.refresh_token }))).status).toBe(200);
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
  });
});
