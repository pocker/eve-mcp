import { lookup } from "node:dns/promises";
import { z } from "zod";
import { sql } from "../db/db";
import { AppError } from "../errors";

// Swapped in tests so nothing touches the network.
export const net = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  resolve: (host: string) => lookup(host, { all: true }).then((r) => r.map((a) => a.address)),
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// https, or http on loopback (any port). No fragment, no credentials.
export function validRedirectUri(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

const redirectUris = z.array(z.string().max(2000).refine(validRedirectUri, "invalid redirect URI")).min(1).max(10);
const clientName = z.string().trim().min(1).max(100);

export const registerSchema = z.object({
  redirect_uris: redirectUris,
  client_name: clientName.optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
});

const metadataSchema = z.object({
  client_id: z.string(),
  client_name: clientName,
  redirect_uris: redirectUris,
  token_endpoint_auth_method: z.literal("none").optional(),
});

export type Client = { clientId: string; name: string; redirectUris: string[] };

// Expands an IPv6 literal to 8 16-bit groups (handles "::" and a trailing dotted IPv4). null when it does not parse.
function ipv6Groups(v: string): number[] | null {
  const tail = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[2]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    v = `${tail[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const g = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return g.length === 8 && g.every((n) => !Number.isNaN(n)) ? g : null;
}

// True for loopback, private, link-local, CGNAT, multicast, reserved, documentation and IPv6 equivalents. Unparseable input counts as private.
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if ([a, b, c, Number(m[4])].some((n) => n > 255)) return true;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const g = v.includes(":") ? ipv6Groups(v) : null;
  if (!g) return true;
  const f = g[0]!;
  return (
    f < 0x100 || // ::/8: unspecified, loopback, IPv4-compatible and every ::ffff: mapped form
    (f === 0x64 && g[1] === 0xff9b) || // NAT64
    f === 0x2002 || // 6to4
    (f === 0x2001 && g[1] === 0) || // Teredo
    (f & 0xfe00) === 0xfc00 || // unique local
    (f & 0xffc0) === 0xfe80 || // link-local
    (f & 0xff00) === 0xff00 // multicast
  );
}

const bad = (msg: string) => new AppError("invalid_client", msg, 400);

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw bad("Client metadata document is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw bad("Client metadata document is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Client ID Metadata Document: the client_id is an https URL that serves the client's JSON.
// shortcut: DNS is checked, then fetch resolves again, so a rebinding race is possible (Bun fetch cannot pin the resolved IP and a custom connector needs a dependency); the response is also only parsed as a small JSON document and never returned to the caller.
export async function fetchMetadataDocument(clientId: string): Promise<Client> {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    throw bad("Invalid client_id URL");
  }
  if (u.protocol !== "https:" || u.pathname === "/" || u.hash || u.username || u.password || (u.port && u.port !== "443")) {
    throw bad("client_id must be an https URL with a path, no fragment or credentials");
  }
  let addrs: string[];
  try {
    addrs = await net.resolve(u.hostname);
  } catch {
    throw bad("Cannot resolve client_id host");
  }
  if (addrs.length === 0 || addrs.some(isPrivateIp)) throw bad("client_id host is not allowed");

  let res: Response;
  try {
    res = await net.fetch(clientId, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  } catch {
    throw bad("Could not fetch client metadata document");
  }
  if (res.status !== 200) throw bad("Client metadata document did not return 200");
  let json: unknown;
  try {
    json = JSON.parse(await readCapped(res, 64 * 1024));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw bad("Client metadata document is not valid JSON");
  }
  const doc = metadataSchema.safeParse(json);
  if (!doc.success) throw bad("Client metadata document is invalid");
  if (doc.data.client_id !== clientId) throw bad("client_id in the document does not match its URL");
  return { clientId, name: doc.data.client_name, redirectUris: doc.data.redirect_uris };
}

const CACHE_SECONDS = 3600;

// Registered (DCR) clients come from the table. URL client_ids are fetched, then cached in the same table;
// created_at doubles as "fetched at" for them.
export async function getClient(clientId: string): Promise<Client | null> {
  if (clientId.length > 2000) return null;
  const [row] = await sql`
    select client_id, name, redirect_uris, created_at > now() - make_interval(secs => ${CACHE_SECONDS}) as fresh
    from oauth_clients where client_id = ${clientId}`;
  const isUrl = clientId.startsWith("https://");
  if (row && (!isUrl || row.fresh)) return { clientId, name: row.name, redirectUris: row.redirect_uris };
  if (!isUrl) return null;
  let c: Client;
  try {
    c = await fetchMetadataDocument(clientId);
  } catch (e) {
    if (row) return { clientId, name: row.name, redirectUris: row.redirect_uris }; // stale cache beats an outage
    if (e instanceof AppError) return null;
    throw e;
  }
  await sql`
    insert into oauth_clients (client_id, name, redirect_uris) values (${c.clientId}, ${c.name}, ${sql.array(c.redirectUris, "TEXT")})
    on conflict (client_id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, created_at = now()`;
  return c;
}
