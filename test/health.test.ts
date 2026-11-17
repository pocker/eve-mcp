import { expect, test } from "bun:test";
import { app } from "../src/index";
import { config } from "../src/config";
import { cssVersion } from "../src/web/layout";
import { sha256 } from "../src/crypto";
import { features } from "../src/features";
import { EVE_SCOPES, SCOPE_INFO } from "../src/esi/scopes";
import { dbAvailable } from "./helpers/db";

test("/health answers 200 when Postgres is up, 503 when not", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(dbAvailable ? 200 : 503);
  expect(await res.json()).toEqual({ ok: dbAvailable });
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
});

test("form POST from another origin is refused, /oauth/token is not CSRF checked", async () => {
  const form = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" }, body: "a=1" };
  expect((await app.request("/auth/logout", form)).status).toBe(403);
  expect((await app.request("/oauth/token", form)).status).toBe(401);
});

test("a POST without a form content type is refused for a foreign Origin or Sec-Fetch-Site", async () => {
  expect((await app.request("/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await app.request("/auth/logout", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  expect((await app.request("/auth/logout", { method: "POST", headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
  expect((await app.request("/auth/logout", { method: "POST", headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }, redirect: "manual" })).status).toBe(302);
  expect((await app.request("/oauth/register", { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).status).not.toBe(403);
});

test("a same-origin consent POST passes the CSRF middlewares, Origin null does not", async () => {
  const post = (origin: string, site: string) =>
    app.request("/oauth/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": site }, body: "a=1", redirect: "manual" });
  expect((await post("http://localhost:3000", "same-origin")).status).not.toBe(403);
  expect((await post("null", "same-origin")).status).toBe(403);
});

test("static css is served and cacheable", async () => {
  const res = await app.request("/static/app.css");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("public");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("pages link the stylesheet with its content hash", async () => {
  const html = await (await app.request("/")).text();
  expect(html).toContain(`/static/app.css?v=${cssVersion}`);
  expect(cssVersion).toBe(sha256(await Bun.file("src/web/app.css").text()).slice(0, 10));
});

test("robots.txt, sitemap.xml, llms.txt and favicons are public and static", async () => {
  const robots = await app.request("/robots.txt");
  expect(robots.status).toBe(200);
  expect(robots.headers.get("content-type")).toContain("text/plain");
  expect(await robots.text()).toContain("Sitemap: http://localhost:3000/sitemap.xml");

  const map = await app.request("/sitemap.xml");
  expect(map.status).toBe(200);
  expect(map.headers.get("content-type")).toContain("application/xml");
  const xml = await map.text();
  for (const p of ["/", "/connect", "/features", "/privacy"]) expect(xml).toContain(`<loc>http://localhost:3000${p}</loc>`);
  for (const p of ["/account", "/characters", "/apps", "/admin", "/auth", "/oauth", "/mcp"]) expect(xml).not.toContain(`localhost:3000${p}`);

  const llms = await app.request("/llms.txt");
  expect(llms.status).toBe(200);
  expect(llms.headers.get("content-type")).toContain("text/markdown");
  const text = await llms.text();
  expect(text).toContain("http://localhost:3000/mcp");
  for (const g of features().groups) for (const t of g.tools) expect(text).toContain(`\`${t.name}\``);

  const ico = await app.request("/favicon.ico");
  expect(ico.status).toBe(200);
  expect(ico.headers.get("content-type")).toBe("image/x-icon");
  expect(ico.headers.get("cache-control")).toContain("max-age=2592000");
  expect((await ico.arrayBuffer()).byteLength).toBeGreaterThan(0);
  const svg = await app.request("/favicon.svg");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(await svg.text()).toContain("<svg");
  expect(await (await app.request("/")).text()).toContain('href="/favicon.svg"');
});

test("pages share a per-IP limit; /health and routes with their own limit are not counted", async () => {
  const prev = config.clientIpHeader;
  config.clientIpHeader = "x-test-ip";
  try {
    const get = (path: string, ip = "198.51.100.7") => app.request(path, { headers: { "x-test-ip": ip } });
    for (let i = 0; i < 120; i++) expect((await get("/privacy")).status).toBe(200);
    const blocked = await get("/features");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await get("/health")).status).not.toBe(429);
    expect((await get("/.well-known/oauth-authorization-server")).status).toBe(429);
    expect((await get("/oauth/authorize")).status).not.toBe(429);
    expect((await get("/privacy", "198.51.100.8")).status).toBe(200);
  } finally {
    config.clientIpHeader = prev;
  }
});

test("every EVE scope has a plain-English reason, and no extra keys", () => {
  expect(Object.keys(SCOPE_INFO).sort()).toEqual([...EVE_SCOPES].sort());
  for (const [name, why] of Object.values(SCOPE_INFO)) expect(name.length > 0 && why.length > 0).toBe(true);
});

test("home page explains the scopes, links the source and shows the dev version", async () => {
  const html = await (await app.request("/")).text();
  expect(html).toContain(`What EVE will ask you to allow (${EVE_SCOPES.length} permissions)`);
  for (const s of EVE_SCOPES) expect(html).toContain(s);
  expect(html).toContain("https://github.com/pocker/eve-mcp#self-hosting");
  expect(html).toContain("Version dev");
});

test("security.txt follows RFC 9116, privacy links CCP's revoke page and the security doc", async () => {
  const res = await app.request("/.well-known/security.txt");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const text = await res.text();
  expect(text).toContain("Contact: https://github.com/pocker/eve-mcp/security/advisories/new");
  expect(text).toContain("Canonical: http://localhost:3000/.well-known/security.txt");
  expect(text).not.toContain("@");
  const expires = new Date(text.match(/^Expires: (.+)$/m)![1]!);
  expect(expires.getTime()).toBeGreaterThan(Date.now() + 170 * 86400_000);

  const privacy = await (await app.request("/privacy")).text();
  expect(privacy).toContain("https://developers.eveonline.com/authorized-apps");
  expect(privacy).toContain("docs/SECURITY.md");
});

test("/connect has the server URL, every client and the copy script", async () => {
  const html = await (await app.request("/connect")).text();
  expect(html).toContain("http://localhost:3000/mcp");
  for (const h of ["Claude (claude.ai", "ChatGPT", "Claude Code", "Codex", "Cursor", "VS Code", "Other MCP clients", "Try these first", "If something goes wrong"]) expect(html).toContain(h);
  const src = html.match(/src="(\/static\/copy\.js\?v=[0-9a-f]{10})"/)?.[1];
  expect(src).toBeTruthy();
  const js = await app.request("/static/copy.js");
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(js.headers.get("cache-control")).toContain("max-age=2592000");
  expect(await (await app.request("/llms.txt")).text()).toContain("codex mcp login eve");
});
