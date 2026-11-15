import { expect, test } from "bun:test";
import { redact } from "../src/log";

test("redacts secret keys, nested and case-insensitive", () => {
  const out = JSON.stringify(
    redact({ Authorization: "Bearer a", headers: { Cookie: "s=1", ok: "yes" }, list: [{ refresh_token: "r" }], code: "c", client_secret: "s", password: "p", token: "t", status: 200 }),
  );
  for (const leaked of ["Bearer a", "s=1", '"r"', '"c"', '"s"', '"p"', '"t"']) expect(out).not.toContain(leaked);
  expect(out).toContain('"ok":"yes"');
  expect(out).toContain('"status":200');
});
