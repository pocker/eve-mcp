import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/db/db";
import { tools } from "../src/mcp/tools";
import { parseFeed, setNewsFetch } from "../src/news/client";
import { parseChanges, setChangesFetch } from "../src/sde/changes";
import { setSdeLatest } from "../src/sde/import";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => {
  setNewsFetch(undefined);
  setChangesFetch(undefined);
  setSdeLatest(undefined);
});

const grant = { id: 0, userId: 1, clientId: "t", allCharacters: true, allowWrite: false };
const run = (name: string, input: object) => {
  const t = tools.find((x) => x.name === name)!;
  return t.run(z.object(t.input).parse(input) as never, grant) as Promise<Record<string, any>>;
};

const item = (title: string, link: string, cat: string, desc: string) =>
  `<item>\n<title>${title}</title>\n<link>${link}</link>\n<description>${desc}</description>\n<author>x</author>\n<category>${cat}</category>\n<guid isPermaLink="false">g</guid>\n<pubDate>Fri, 13 Nov 2026 11:00:00 GMT</pubDate>\n</item>`;
const FEED = `﻿<?xml version="1.0"?><rss version="2.0"><channel><title>EVE Online feeds</title>
${item("Patch Notes - Version 24.02", "https://www.eveonline.com/news/view/patch-notes-version-24-02", "patch-notes", `&lt;p&gt;Fixed &lt;script&gt;alert(1)&lt;/script&gt; the &amp;#39;thing&amp;#39; ${"long ".repeat(200)}&lt;/p&gt;`)}
${item("Monthly Economic Report", "https://www.eveonline.com/news/view/mer", "monthly-economic-reports", "&lt;p&gt;Numbers&lt;/p&gt;")}
${item("Evil", "https://evil.example/x", "offers", "no")}
</channel></rss>`;

describe("parseFeed", () => {
  test("strips markup, decodes entities, caps text, drops foreign links", () => {
    const items = parseFeed(FEED);
    expect(items.map((i) => i.title)).toEqual(["Patch Notes - Version 24.02", "Monthly Economic Report"]);
    expect(items[0]!.date).toBe("2026-11-13T11:00:00.000Z");
    expect(items[0]!.categories).toEqual(["patch-notes"]);
    expect(items[0]!.description.startsWith("Fixed alert(1) the 'thing'")).toBe(true);
    expect(items[0]!.description).not.toContain("<");
    expect(items[0]!.description.length).toBeLessThanOrEqual(300);
  });
});

describe("parseChanges", () => {
  test("counts per file, ids for types, schemaChanged", () => {
    const text = [
      '{"_key":"_meta","buildNumber":2,"lastBuildNumber":1,"releaseDate":"2026-11-13T11:06:47Z"}',
      '{"_key":"types","added":[10],"removed":[11],"changed":[12,13],"changedLocalization":[1,2,3]}',
      '{"_key":"typeDogma","changed":[13,14]}',
      '{"_key":"blueprints","schemaChanged":true}',
      "not json",
    ].join("\n");
    const c = parseChanges(text, 2);
    expect(c).toMatchObject({ build: 2, previous_build: 1, release_date: "2026-11-13T11:06:47Z" });
    expect(c.types).toEqual({ added: [10], removed: [11], changed: [12, 13, 14] });
    expect(c.files).toEqual([
      { file: "types", added: 1, removed: 1, changed: 2, changed_localization: 3, schema_changed: false },
      { file: "typeDogma", added: 0, removed: 0, changed: 2, changed_localization: 0, schema_changed: false },
      { file: "blueprints", added: 0, removed: 0, changed: 0, changed_localization: 0, schema_changed: true },
    ]);
  });
});

const CHANGES = [
  '{"_key":"_meta","buildNumber":777,"lastBuildNumber":700,"releaseDate":"2026-11-13T11:06:47Z"}',
  '{"_key":"types","added":[900001],"removed":[900002],"changed":[900003,900004,900099]}',
].join("\n");

let rssCalls = 0;
let chCalls: string[] = [];
beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  rssCalls = 0;
  chCalls = [];
  setNewsFetch(fakeEsi({ "GET /rss": () => (rssCalls++, new Response(FEED)) }).fetch);
  setChangesFetch(async (url) => {
    chCalls.push(url);
    return url.endsWith("/777.jsonl") ? new Response(CHANGES) : new Response("<Error/>", { status: 403 });
  });
  setSdeLatest(async () => 777);
});

describe.skipIf(!dbAvailable)("news tools (needs Postgres)", () => {
  test("ccp_news filters by keyword and caches the feed", async () => {
    const all = await run("ccp_news", {});
    expect(all.items).toHaveLength(2);
    const r = await run("ccp_news", { keyword: "patch notes" });
    expect(r.items.map((i: any) => i.title)).toEqual(["Patch Notes - Version 24.02"]);
    expect((await run("ccp_news", { limit: 1 })).items).toHaveLength(1);
    expect(rssCalls).toBe(1);
  });

  test("sde_changes names types from the SDE and caches", async () => {
    await sql`delete from sde_types`;
    await sql`insert into sde_types (type_id, group_id, name) values (900001, 1, 'Zeta Ship'), (900003, 1, 'Beta Module'), (900004, 1, 'Alpha Module')`;
    const r = await run("sde_changes", { build: 777 });
    expect(r).toMatchObject({ build: 777, previous_build: 700 });
    expect(r.types_added.top).toEqual([{ type_id: 900001, name: "Zeta Ship" }]);
    expect(r.types_removed).toEqual({ total: 1, ids: [900002] });
    expect(r.types_changed).toMatchObject({ total: 3, unnamed: 1 });
    expect(r.types_changed.top.map((t: any) => t.name)).toEqual(["Alpha Module", "Beta Module"]);
    await run("sde_changes", { build: 777 });
    expect(chCalls).toEqual(["https://developers.eveonline.com/static-data/tranquility/changes/777.jsonl"]);
  });

  test("sde_changes defaults to the current build and refuses an unknown one", async () => {
    await sql`delete from sde_meta`;
    expect((await run("sde_changes", {})).build).toBe(777);
    await expect(run("sde_changes", { build: 5 })).rejects.toMatchObject({ code: "not_found" });
  });
});
