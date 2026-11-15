import { expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "../src/ratelimit";

test("allows the burst, then 429 with Retry-After, per key", async () => {
  const app = new Hono();
  app.use(rateLimit({ key: (c) => c.req.header("x-k") ?? "", perMinute: 3 }));
  app.get("/", (c) => c.text("ok"));
  const hit = (k: string) => app.request("/", { headers: { "x-k": k } });
  for (let i = 0; i < 3; i++) expect((await hit("a")).status).toBe(200);
  const blocked = await hit("a");
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect((await hit("b")).status).toBe(200);
});
