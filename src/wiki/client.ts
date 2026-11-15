import pkg from "../../package.json";
import { cacheGet, cachePut } from "../esi/cache";
import { config } from "../config";
import { AppError } from "../errors";

const HOST = "https://wiki.eveuniversity.org";
const API = `${HOST}/api.php`;
const TTL_MS = 24 * 3600_000;
const NOT_FOUND_TTL_MS = 3600_000;
const TIMEOUT_MS = 10_000;
const NOT_FOUND = { notFound: true };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setWikiFetch = (f: Fetch | undefined) => void (doFetch = f ?? ((url, init) => fetch(url, init)));

export const wikiUrl = (title: string) => `${HOST}/${encodeURIComponent(title.replaceAll(" ", "_"))}`;

// Only the fixed wiki host is ever called. One retry for a 5xx or a maxlag answer, none otherwise.
async function apiGet(params: Record<string, string>): Promise<Record<string, any>> {
  const url = new URL(API);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", maxlag: "5", ...params })) url.searchParams.set(k, v);
  const headers = { "User-Agent": `eve-mcp/${pkg.version} (+${config.publicUrl}; ${config.esiContact})`, Accept: "application/json" };
  for (let attempt = 0; ; attempt++) {
    let body: Record<string, any> | undefined;
    let status = 0;
    try {
      const res = await doFetch(url.toString(), { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = res.status;
      body = res.ok ? ((await res.json()) as Record<string, any>) : undefined;
    } catch {
      throw new AppError("wiki_unreachable", "The EVE University wiki did not answer in time. Try again shortly.", 502);
    }
    const retryable = status >= 500 || body?.error?.code === "maxlag";
    if (body && !retryable) {
      if (body.error) throw new AppError("wiki_error", `Wiki API error: ${String(body.error.code).slice(0, 50)}`, 502);
      return body;
    }
    if (!retryable || attempt === 1) throw new AppError("wiki_error", `The wiki returned ${status || "an error"}. Try again later.`, 502);
    await Bun.sleep(1000);
  }
}

// Shared Postgres cache (esi_cache). Keys start with "wiki#", so the per-character purge ("GET %#<id>") never touches them.
async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = await cacheGet(key);
  if (hit?.fresh) return (hit.data as { notFound?: boolean } | null)?.notFound === true ? null : (hit.data as T);
  const data = await load();
  await cachePut(key, null, new Date(Date.now() + (data ? TTL_MS : NOT_FOUND_TTL_MS)), data ?? NOT_FOUND, 1);
  return data;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// Wiki text is untrusted: no markup survives, only plain text.
export function plain(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type WikiHit = { title: string; snippet: string; redirected_from?: string[] };

export async function wikiSearch(query: string, limit: number): Promise<WikiHit[]> {
  const hits = await cached(`wiki#search:${limit}:${query.toLowerCase()}`, async () => {
    // generator=search + redirects=1: a redirect hit becomes its target page, with the target's intro as the snippet.
    const r = await apiGet({ action: "query", generator: "search", gsrsearch: query, gsrlimit: String(limit), redirects: "1", prop: "extracts", exintro: "1", explaintext: "1", exchars: "400", exlimit: String(limit) });
    const from = new Map<string, string[]>();
    for (const x of (r.query?.redirects ?? []) as { from: string; to: string }[]) from.set(x.to, [...(from.get(x.to) ?? []), x.from]);
    const pages = ((r.query?.pages ?? []) as { title: string; index?: number; extract?: string }[]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return pages.map((p) => ({ title: String(p.title), snippet: plain(p.extract ?? "").slice(0, 300), ...(from.has(p.title) ? { redirected_from: from.get(p.title)!.slice(0, 5).map((t) => t.slice(0, 100)) } : {}) }));
  });
  return hits ?? [];
}

export type WikiPage = { title: string; extract: string };

// One request: the plain-text extract with "== Heading ==" lines (exsectionformat=wiki), redirects followed. Null when the page does not exist.
export async function wikiPage(title: string): Promise<WikiPage | null> {
  return cached(`wiki#page:${title.replaceAll(" ", "_")}`, async () => {
    const r = await apiGet({ action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", redirects: "1", titles: title });
    const p = (r.query?.pages ?? [])[0] as { title: string; missing?: boolean; invalid?: boolean; extract?: string } | undefined;
    if (!p || p.missing || p.invalid) return null;
    return { title: String(p.title), extract: String(p.extract ?? "").trim() };
  });
}

export type Heading = { level: number; heading: string; body: string };

// Headings of an extract with their text. A section runs to the next heading of the same or a higher level, so it includes its subsections.
export function parseHeadings(extract: string): Heading[] {
  const hs = [...extract.matchAll(/^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm)].map((m) => ({ level: m[1]!.length, heading: m[2]!, from: m.index!, to: m.index! + m[0].length }));
  return hs.map((h, i) => ({ level: h.level, heading: h.heading, body: extract.slice(h.to, hs.slice(i + 1).find((n) => n.level <= h.level)?.from ?? extract.length).trim() }));
}
