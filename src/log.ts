import type { MiddlewareHandler } from "hono";
import { clientIp } from "./ratelimit";

const SECRET_KEY = /authorization|cookie|token|secret|password|^code$/i;

export function redact(v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(x)]));
  }
  return v;
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields) as object) }));
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  await next();
  log("info", "request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Math.round(performance.now() - start),
    ip: clientIp(c),
  });
};
