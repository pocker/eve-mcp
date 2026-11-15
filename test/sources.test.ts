import { afterAll, describe, expect, test } from "bun:test";
import { app } from "../src/index";
import { sql } from "../src/db/db";
import { config } from "../src/config";
import { features, toolInfo, CATEGORIES } from "../src/features";
import { prompts } from "../src/mcp/prompts";
import { CCP_NOTICE, sources } from "../src/sources";
import { tools } from "../src/mcp/tools";
import { dbAvailable, useTestSchema } from "./helpers/db";

useTestSchema();

const realFetch = globalThis.fetch;
afterAll(() => void (globalThis.fetch = realFetch));
const page = async () => (await app.request("/features")).text();

test("every tool named in the source list exists", () => {
  const names = new Set(tools.map((t) => t.name));
  for (const s of sources) for (const t of s.tools) expect(names.has(t), `${s.id}: ${t}`).toBe(true);
});

test("feature list covers every registered tool, no stale entries, every tool has a known category", () => {
  const names = tools.map((t) => t.name).sort();
  expect(Object.keys(toolInfo).sort()).toEqual(names);
  for (const [c] of Object.values(toolInfo)) expect(CATEGORIES).toContain(c);
  const f = features();
  expect(f.groups.flatMap((g) => g.tools.map((t) => t.name)).sort()).toEqual(names);
  expect(f.groups.flatMap((g) => g.tools).filter((t) => t.changes_game_data).map((t) => t.name).sort()).toEqual(["create_fitting", "delete_fitting"]);
  expect(f.prompts.map((p) => p.name)).toEqual(prompts.map((p) => p.name));
  expect(f.prompts.length).toBe(6);
});

test("/sources redirects to /features", async () => {
  const res = await app.request("/sources", { redirect: "manual" });
  expect(res.status).toBe(301);
  expect(res.headers.get("location")).toBe("/features");
});

test("footer has the voluntary ko-fi link", async () => {
  const html = await (await app.request("/features")).text();
  expect(html).toContain('href="https://ko-fi.com/pamera"');
  expect(html).toContain('class="btn btn-secondary" href="https://ko-fi.com/pamera"');
  expect(html).toContain("Buy me a coffee");
  expect(html).toContain("voluntary, help cover hosting and unlock nothing");
  expect(html).not.toContain("<script");
});

test("about_sources is public, read-only and not open-world", () => {
  const t = tools.find((x) => x.name === "about_sources")!;
  expect(t.write).toBe(false);
  expect(t.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
});

describe.skipIf(!dbAvailable)("with a database", () => {
  test("page lists every source, links out safely, and loads without outbound calls", async () => {
    let calls = 0;
    globalThis.fetch = (() => (calls++, Promise.reject(new Error("no outbound"))) ) as never;
    const res = await app.request("/features");
    globalThis.fetch = realFetch;
    expect(res.status).toBe(200);
    expect(calls).toBe(0);
    const html = await res.text();
    expect(html).toContain("Connected systems");
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("toolgrid");
    for (const s of sources) {
      expect(html).toContain(s.name.replace(/&/g, "&amp;"));
      expect(html).toContain(`href="${s.url}"`);
    }
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("CC BY-SA 4.0");
    expect(html).toContain('href="/features"');
    expect(html).not.toContain("style=");
  });

  test("?tab=tools lists every tool by category; a bad tab falls back to systems", async () => {
    const html = await (await app.request("/features?tab=tools")).text();
    for (const t of tools) expect(html).toContain(`<code>${t.name}</code>`);
    for (const g of features().groups) expect(html).toContain(g.category);
    expect(html).not.toContain('class="panel" id="esi"');
    expect(html).toMatch(/href="\/features\?tab=tools"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/features\?tab=tools"/);
    for (const bad of ["nope", "", "TOOLS"]) {
      const h = await (await app.request(`/features?tab=${bad}`)).text();
      expect(h).toContain('class="panel" id="esi"');
      expect(h).not.toContain("toolgrid");
    }
    const prompts_ = await (await app.request("/features?tab=prompts")).text();
    for (const p of prompts) expect(prompts_).toContain(p.name);
    expect(await (await app.request("/features?tab=examples")).text()).toContain("Example questions");
  });

  test("status: SDE not loaded, then loaded; ESI limited", async () => {
    await sql`delete from sde_meta`;
    expect(await page()).toContain("Not loaded yet");
    await sql`insert into sde_meta (build_number) values (3333333)`;
    expect(await page()).toContain("Build 3333333");
    expect(await page()).toContain("Error budget ok");
    await sql`update esi_status set error_limit_remain = 5, error_limit_reset_at = now() + interval '30 seconds' where id = 1`;
    expect(await page()).toContain("Limited, resets in");
    await sql`update esi_status set error_limit_remain = null, error_limit_reset_at = null where id = 1`;
  });

  test("the tool returns sources, status and the page url", async () => {
    const t = tools.find((x) => x.name === "about_sources")!;
    const out = (await t.run({} as never, {} as never)) as { sources: unknown[]; status: { sde: { loaded: boolean }; esi: { state: string } }; page: string };
    expect(out.sources).toBe(sources);
    expect(out.status.sde.loaded).toBe(true);
    expect(out.status.esi.state).toBe("ok");
    expect(out.page).toBe(`${config.publicUrl}/features`);
  });
});

test("nav links Sources, signed out; landing and connect link to it", async () => {
  for (const p of ["/", "/connect", "/features"]) {
    const html = await (await app.request(p)).text();
    expect(html).toContain('<a href="/features"');
  }
});

test("footer carries the CCP notice and links /privacy; /privacy is public", async () => {
  const html = await (await app.request("/privacy")).text();
  expect(html).toContain("© 2014 CCP hf. All rights reserved.");
  expect(html).toContain("not affiliated with CCP Games");
  expect(html).toContain('href="/privacy"');
  expect(html).toContain("no usage tracking, analytics or ads");
  expect(CCP_NOTICE).toBe('© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.');
});
