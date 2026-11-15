import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { config } from "./config";

export function clientIp(c: Context): string {
  if (config.clientIpHeader) return c.req.header(config.clientIpHeader)?.split(",")[0]?.trim() || "unknown";
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // no socket (tests via app.request)
  }
}

// shortcut: buckets live in this replica's memory, so with N replicas the real limit is N times looser; move to Postgres if abuse shows up.
export function rateLimit(opts: { key: (c: Context) => string; perMinute: number }): MiddlewareHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const perSec = opts.perMinute / 60;
  setInterval(() => {
    const idle = Date.now() - 120_000;
    for (const [k, b] of buckets) if (b.at < idle) buckets.delete(k);
  }, 60_000).unref();

  return async (c, next) => {
    const now = Date.now();
    const k = opts.key(c);
    const b = buckets.get(k) ?? { tokens: opts.perMinute, at: now };
    b.tokens = Math.min(opts.perMinute, b.tokens + ((now - b.at) / 1000) * perSec);
    b.at = now;
    buckets.set(k, b);
    if (b.tokens < 1) {
      const retry = Math.ceil((1 - b.tokens) / perSec);
      return c.json({ error: "rate_limited", message: "Too many requests" }, 429, { "Retry-After": String(retry) });
    }
    b.tokens -= 1;
    await next();
  };
}
