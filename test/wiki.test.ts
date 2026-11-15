import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "../src/db/db";
import { tools } from "../src/mcp/tools";
import { plain, setWikiFetch } from "../src/wiki/client";
import { dbAvailable, useTestSchema } from "./helpers/db";
import { fakeEsi, resetEsi, type Routes } from "./helpers/esi";

useTestSchema();
afterAll(() => setWikiFetch(undefined));

const grant = { id: 0, userId: 1, clientId: "t", allCharacters: true, allowWrite: false };
const run = (name: string, input: object) => {
  const t = tools.find((x) => x.name === name)!;
  return t.run(z.object(t.input).parse(input) as never, grant) as Promise<Record<string, any>>;
};

const EXTRACT = `Lead text here.\n\n\n== Intro ==\nIntro body.\n\n\n=== Deep ===\nDeep body.\n\n\n== Other ==\nOther body.`;
const pageFor = (title: string) => (title === "Missing" ? { query: { pages: [{ title, missing: true }] } } : { query: { pages: [{ title: title === "Redir" ? "Real page" : title, extract: title === "Long" ? "x".repeat(20_000) : EXTRACT }] } });
const routes: Routes = {
  "GET /api.php": (c) =>
    c.query.get("generator") === "search"
      ? { query: { redirects: [{ from: "Wh", to: "Wormhole space" }], pages: [{ title: "Other", index: 2, extract: "o" }, { title: "Wormhole space", index: 1, extract: `a <b>wormhole</b> &quot;x&quot; &amp; y ${"z".repeat(500)}` }] } }
      : pageFor(c.query.get("titles")!),
};
let fake: ReturnType<typeof fakeEsi>;
beforeEach(async () => {
  if (!dbAvailable) return;
  await resetEsi();
  fake = fakeEsi(routes);
  setWikiFetch(fake.fetch);
});

describe("plain()", () => {
  test("strips tags and decodes entities", () => expect(plain('<b>a</b> &lt;i&gt; &#39;q&#39; &amp;lt;')).toBe("a 'q' &lt;"));
});

describe.skipIf(!dbAvailable)("wiki tools (needs Postgres)", () => {
  test("search shapes results, sends User-Agent and maxlag", async () => {
    const r = await run("wiki_search", { query: "wormhole" });
    expect(r).toMatchObject({ source: "EVE University Wiki", license: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/" });
    expect(r.results[0].url).toBe("https://wiki.eveuniversity.org/Wormhole_space");
    expect(r.results[0].snippet.startsWith('a wormhole "x" & y')).toBe(true);
    expect(r.results[0].snippet.length).toBeLessThanOrEqual(300);
    expect(r.results[0].redirected_from).toEqual(["Wh"]);
    expect(r.results[1].title).toBe("Other");
    expect(fake.calls[0]!.query.get("redirects")).toBe("1");
    const c = fake.calls[0]!;
    expect(c.headers.get("user-agent")).toMatch(/^eve-mcp\/\S+ \(\+http:\/\/localhost:3000; test@example.com\)$/);
    expect(c.query.get("maxlag")).toBe("5");
  });

  test("page follows the redirect and lists sections", async () => {
    const r = await run("wiki_page", { title: "Redir" });
    expect(r).toMatchObject({ title: "Real page", url: "https://wiki.eveuniversity.org/Real_page", source: "EVE University Wiki", license: "CC BY-SA 4.0", sections: ["Intro", "Deep", "Other"] });
    expect(r.text).toContain("Lead text here.");
    expect(fake.calls[0]!.query.get("redirects")).toBe("1");
    expect(r.truncated).toBeUndefined();
  });

  test("long page is truncated with a hint", async () => {
    const r = await run("wiki_page", { title: "Long" });
    expect(r.text.length).toBe(12_000);
    expect(r.truncated).toContain("section=<heading>");
  });

  test("section, case-insensitive, includes subsections", async () => {
    const r = await run("wiki_page", { title: "Page", section: "iNtRo" });
    expect(r.text).toContain("Intro body.");
    expect(r.text).toContain("Deep body.");
    expect(r.text).not.toContain("Other body.");
    expect((await run("wiki_page", { title: "Page", section: "deep" })).text).toBe("Deep body.");
  });

  test("unknown section lists headings", async () => {
    await expect(run("wiki_page", { title: "Page", section: "nope" })).rejects.toThrow(/Sections: Intro; Deep; Other/);
  });

  test("missing page errors and is negative-cached", async () => {
    await expect(run("wiki_page", { title: "Missing" })).rejects.toThrow(/wiki_search/);
    await expect(run("wiki_page", { title: "Missing" })).rejects.toThrow(/wiki_search/);
    expect(fake.calls.length).toBe(1);
  });

  test("second call is served from cache", async () => {
    await run("wiki_page", { title: "Page" });
    await run("wiki_page", { title: "Page" });
    await run("wiki_search", { query: "Wormhole" });
    await run("wiki_search", { query: "wormhole" });
    expect(fake.calls.length).toBe(2);
    const [{ n }] = await sql`select count(*)::int as n from esi_cache where key like 'wiki#%'`;
    expect(n).toBe(2);
  });

  test("tools are read-only and open-world", () => {
    for (const n of ["wiki_search", "wiki_page"]) expect(tools.find((t) => t.name === n)!.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
  });
});
