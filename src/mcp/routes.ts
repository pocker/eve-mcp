import { Hono, type Context } from "hono";
import { createMcpHandler, type McpServer, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { config } from "../config";
import { mcpAuth } from "../oauth/bearer";
import { clientIp, rateLimit } from "../ratelimit";
import type { AppEnv } from "../types";
import { buildServer } from "./server";

const MAX_BODY_BYTES = 256 * 1024;

// Before auth, so unauthenticated floods (bad tokens hit Postgres) are limited too.
const ipLimit = rateLimit({ key: (c) => `ip:${clientIp(c)}`, perMinute: 300 });
// shortcut: per replica, like every other limit (ARCHITECTURE.md, "Scaling limits").
const mcpLimit = rateLimit({ key: (c) => `grant:${c.var.grant?.id}:${c.var.grant?.userId}`, perMinute: 120 });

// Why did the SDK refuse? Headers and the JSON-RPC error only, never the request body or Authorization.
async function logRejected(c: Context<AppEnv>, res: Response, req: { json(): Promise<any> }) {
  const text = await res.clone().text().catch(() => "");
  let message = text;
  try { message = JSON.parse(text)?.error?.message ?? text; } catch {}
  let method = "-"; // JSON-RPC method name only, never params
  try { const b = await req.json(); method = (Array.isArray(b) ? b : [b]).map((m) => String(m?.method).slice(0, 50)).join(","); } catch {}
  console.log(`mcp_rejected method=${method} status=${res.status} message=${JSON.stringify(String(message).slice(0, 200))} protocol=${c.req.header("mcp-protocol-version") ?? "-"} session=${c.req.header("mcp-session-id") !== undefined} accept=${JSON.stringify(c.req.header("accept") ?? "-")}`);
}

export async function handleMcp(c: Context<AppEnv>): Promise<Response> {
  const grant = c.var.grant;
  if (!grant) return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
  // DNS rebinding rule from the MCP spec: browsers send Origin, MCP clients usually do not.
  const origin = c.req.header("origin");
  if (origin && !config.allowedOrigins.includes(origin)) return c.json({ error: "forbidden_origin", message: "Origin not allowed" }, 403);
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json({ error: "too_large", message: "Request too large" }, 413);

  const server = buildServer(grant);
  // 2026-07-28 era (server/discover, per-request envelope); 2025 traffic (initialize) goes to serveLegacy.
  const modern = createMcpHandler(() => server, { legacy: "reject", maxRequestBodySize: MAX_BODY_BYTES });
  try {
    const copy = c.req.raw.clone(); // the SDK consumes the body; keep a copy to name the rejected method
    const res = (await isLegacyRequest(c.req.raw.clone() as Request, undefined, { maxRequestBodySize: MAX_BODY_BYTES }))
      ? await serveLegacy(server, c.req.raw)
      : await modern.fetch(c.req.raw);
    if (res.status >= 400 && res.status < 500) await logRejected(c, res, copy);
    return res;
  } finally {
    await server.close();
  }
}

// 2025 era (initialize): stateless (no sessionIdGenerator) and plain JSON replies, no long-lived stream behind Cloudflare's 100 s timeout.
async function serveLegacy(server: McpServer, req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const routes = new Hono<AppEnv>();
routes.all("/mcp", ipLimit, mcpAuth, mcpLimit, handleMcp);
