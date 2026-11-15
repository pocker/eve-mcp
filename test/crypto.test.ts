import { afterEach, expect, test } from "bun:test";
import { config } from "../src/config";
import { decrypt, encrypt, randomToken, sha256 } from "../src/crypto";

const orig = { k: config.tokenEncKey, old: config.tokenEncKeyOld };
afterEach(() => {
  config.tokenEncKey = orig.k;
  config.tokenEncKeyOld = orig.old;
});
const newKey = (n: number) => Buffer.alloc(32, n).toString("base64");

test("randomToken and sha256", () => {
  expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomToken()).not.toBe(randomToken());
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("round trip", async () => {
  const ct = await encrypt("refresh-token");
  expect(ct[0]).toBe(1);
  expect(await decrypt(ct)).toBe("refresh-token");
});

test("tampered ciphertext fails", async () => {
  const ct = await encrypt("x");
  ct[ct.length - 1] = ct[ct.length - 1]! ^ 1;
  expect(decrypt(ct)).rejects.toThrow();
});

test("old key still decrypts after rotation", async () => {
  const before = await encrypt("secret");
  config.tokenEncKeyOld = config.tokenEncKey;
  config.tokenEncKey = newKey(9);
  expect(await decrypt(before)).toBe("secret");
  expect(await decrypt(await encrypt("new"))).toBe("new");
});

test("wrong key fails", async () => {
  const ct = await encrypt("secret");
  config.tokenEncKey = newKey(9);
  expect(decrypt(ct)).rejects.toThrow();
});
