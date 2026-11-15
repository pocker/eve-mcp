import pkg from "../../package.json";
import { cacheGet, cachePut } from "../esi/cache";
import { config } from "../config";
import { AppError } from "../errors";
import { plain } from "../wiki/client";

const URL_RSS = "https://www.eveonline.com/rss";
const LINK_PREFIX = "https://www.eveonline.com/";
const KEY = "news#rss";
const TTL_MS = 3600_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000; // the feed was ~95 KB in 2026 (each item carries the whole article)
const MAX_ITEMS = 30;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, init);
// Tests only.
export const setNewsFetch = (f: Fetch | undefined) => void (doFetch = f ?? ((url, init) => fetch(url, init)));

export type NewsItem = { title: string; date: string | null; link: string; categories: string[]; description: string };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "";

// Small parse of the known RSS 2.0 shape. All text is untrusted: tags removed, entities decoded, length capped.
export function parseFeed(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]!;
    const link = plain(tag(it, "link"));
    if (!link.startsWith(LINK_PREFIX)) continue;
    const t = Date.parse(tag(it, "pubDate"));
    out.push({
      title: plain(tag(it, "title")).slice(0, 200),
      date: Number.isNaN(t) ? null : new Date(t).toISOString(),
      link: link.slice(0, 300),
      categories: [...it.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => plain(c[1]!).slice(0, 50)).slice(0, 8),
      // The feed holds the whole article as escaped HTML: decode twice (XML, then HTML entities), keep the start.
      description: plain(plain(tag(it, "description"))).slice(0, 300),
    });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

async function load(): Promise<NewsItem[]> {
  let xml: string;
  try {
    const res = await doFetch(URL_RSS, {
      method: "GET",
      headers: { "User-Agent": `eve-mcp/${pkg.version} (+${config.publicUrl}; ${config.esiContact})`, Accept: "application/rss+xml, application/xml" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(String(res.status));
    xml = await res.text();
  } catch {
    throw new AppError("news_unreachable", "The EVE Online news feed did not answer. Try again shortly.", 502);
  }
  if (xml.length > MAX_BYTES) throw new AppError("news_error", "The EVE Online news feed was too large.", 502);
  const items = parseFeed(xml);
  if (!items.length) throw new AppError("news_error", "The EVE Online news feed had no items.", 502);
  return items;
}

// Shared Postgres cache (esi_cache). The key does not end in "#<characterId>", so the character purge never touches it.
export async function news(): Promise<NewsItem[]> {
  const hit = await cacheGet(KEY);
  if (hit?.fresh) return hit.data as NewsItem[];
  const items = await load();
  await cachePut(KEY, null, new Date(Date.now() + TTL_MS), items, 1);
  return items;
}
