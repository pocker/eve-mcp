import { expect, test } from "bun:test";
import { app } from "../src/index";
import { cssVersion } from "../src/web/layout";
import { sha256 } from "../src/crypto";
import { features } from "../src/features";
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
