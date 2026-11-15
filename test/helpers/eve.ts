import { generateKeyPair, SignJWT } from "jose";
import { setJwksForTests } from "../../src/auth/eve-sso";

const { publicKey, privateKey } = await generateKeyPair("RS256");
setJwksForTests(async () => publicKey);

type Claims = { id?: number; name?: string; owner?: string; aud?: string[]; iss?: string; exp?: number; scp?: string | string[] };

export async function eveJwt(c: Claims = {}) {
  return new SignJWT({ name: c.name ?? "Test Pilot", owner: c.owner ?? "owner-1", scp: c.scp ?? ["esi-skills.read_skills.v1"] })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(`CHARACTER:EVE:${c.id ?? 90000001}`)
    .setIssuer(c.iss ?? "https://login.eveonline.com")
    .setAudience(c.aud ?? ["test-client", "EVE Online"])
    .setIssuedAt()
    .setExpirationTime(c.exp ?? Math.floor(Date.now() / 1000) + 1200)
    .sign(privateKey);
}

// Replaces global fetch for the login.eveonline.com token endpoint. Returns the calls made.
export function fakeEve(respond: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

export const tokenResponse = async (c: Claims = {}) =>
  Response.json({ access_token: await eveJwt(c), refresh_token: "refresh-" + (c.id ?? 90000001), expires_in: 1199, token_type: "Bearer" });
