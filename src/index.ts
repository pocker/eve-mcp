import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config";
import { AppError } from "./errors";
import { log, requestLogger } from "./log";
import { sql } from "./db/db";
import { migrate } from "./db/migrate";
import { startPrune } from "./db/prune";
import { startSdeRefresh } from "./sde/import";
import { sessionMiddleware } from "./auth/session";
import { routes as authRoutes } from "./auth/routes";
import { routes as webRoutes } from "./web/routes";
import { routes as oauthRoutes } from "./oauth/routes";
import { routes as mcpRoutes } from "./mcp/routes";
import type { AppEnv } from "./types";

// Called by non-browser clients, so no Origin check.
const NO_CSRF = ["/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke"];
const csrfCheck = csrf({ origin: new URL(config.publicUrl).origin });

export const app = new Hono<AppEnv>();

app.use(requestLogger);
app.use(
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], imgSrc: ["'self'", "https://images.evetech.net"], baseUri: ["'none'"] },
    xFrameOptions: "DENY",
    // Hono default is no-referrer, which makes browsers send "Origin: null" on form POSTs and the CSRF checks below then refuse every form.
    referrerPolicy: "same-origin",
  }),
);
app.use(bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "too_large", message: "Request too large" }, 413) }));
app.use(async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});
// Hono csrf() only looks at form content types; this refuses any other state-changing request from a foreign site or Origin.
const publicOrigin = new URL(config.publicUrl).origin;
const headerCheck: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== publicOrigin)) {
    return c.json({ error: "forbidden", message: "Cross-site request refused" }, 403);
  }
  return next();
};
app.use((c, next) => (NO_CSRF.includes(c.req.path) ? next() : headerCheck(c, async () => void (await csrfCheck(c, next)))));
app.use((c, next) => (c.req.path.startsWith("/mcp") ? next() : sessionMiddleware(c, next)));

app.get("/static/app.css", (c) =>
  c.body(Bun.file(new URL("./web/app.css", import.meta.url)).stream(), 200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
  }),
);

app.get("/health", async (c) => {
  try {
    await sql`select 1`;
    return c.json({ ok: true });
  } catch (e) {
    log("error", "health check failed", { err: e });
    return c.json({ ok: false }, 503);
  }
});

app.route("/", authRoutes);
app.route("/", webRoutes);
app.route("/", oauthRoutes);
app.route("/", mcpRoutes);

app.onError((err, c) => {
  let status = 500;
  let code = "internal_error";
  let message = "Something went wrong";
  if (err instanceof AppError) ({ status, code, message } = { status: err.status, code: err.code, message: err.message });
  else if (err instanceof HTTPException) ({ status, code, message } = { status: err.status, code: "http_error", message: err.message || "Request refused" });
  else log("error", "unhandled error", { err, path: c.req.path });
  if (c.req.header("accept")?.includes("text/html")) {
    return c.html(html`<!doctype html><meta charset="utf-8"><title>Error</title><h1>${status}</h1><p>${message}</p>`, status as 400);
  }
  return c.json({ error: code, message }, status as 400);
});

if (import.meta.main) {
  await migrate();
  startPrune();
  startSdeRefresh(); // background: imports CCP's static data when none is loaded, then checks daily
  Bun.serve({ port: config.port, fetch: (req, server) => app.fetch(req, { server }) });
  log("info", "listening", { port: config.port });
}
