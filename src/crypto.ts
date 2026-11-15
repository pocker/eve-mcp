import { config } from "./config";

const CURRENT_ID = 1;
const OLD_ID = 0;
const keys = new Map<string, Promise<CryptoKey>>();

function importKey(b64: string) {
  let k = keys.get(b64);
  if (!k) {
    k = crypto.subtle.importKey("raw", Buffer.from(b64, "base64"), "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.set(b64, k);
  }
  return k;
}

export const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// Output: [key id byte][12 byte IV][ciphertext + tag]
export async function encrypt(plaintext: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(config.tokenEncKey), new TextEncoder().encode(plaintext));
  const out = new Uint8Array(1 + 12 + ct.byteLength);
  out[0] = CURRENT_ID;
  out.set(iv, 1);
  out.set(new Uint8Array(ct), 13);
  return out;
}

// After a rotation, rows written under the old key still carry id 1, so a failed try falls back to the other key.
export async function decrypt(data: Uint8Array): Promise<string> {
  const id = data[0];
  if (id !== CURRENT_ID && id !== OLD_ID) throw new Error("decrypt: unknown key id");
  const order = id === CURRENT_ID ? [config.tokenEncKey, config.tokenEncKeyOld] : [config.tokenEncKeyOld, config.tokenEncKey];
  let last: unknown = new Error("decrypt: no key for this ciphertext");
  for (const b64 of order) {
    if (!b64) continue;
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(1, 13) }, await importKey(b64), data.slice(13));
      return new TextDecoder().decode(pt);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
