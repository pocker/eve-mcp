import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { config } from "../config";
import { AppError } from "../errors";
import { log } from "../log";
import { EVE_SCOPES } from "../esi/scopes";

export type EveTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
};

const BASE = "https://login.eveonline.com";
let jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${BASE}/oauth/jwks`), { timeoutDuration: 10_000 });

// Tests only: use a local key set instead of EVE's.
export function setJwksForTests(keys: JWTVerifyGetKey) {
  jwks = keys;
}

export function authorizeUrl(state: string): string {
  const u = new URL(`${BASE}/v2/oauth/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    redirect_uri: `${config.publicUrl}/auth/eve/callback`,
    client_id: config.eveClientId,
    scope: EVE_SCOPES.join(" "),
    state,
  }).toString();
  return u.toString();
}

const headers = () => ({
  Authorization: `Basic ${Buffer.from(`${config.eveClientId}:${config.eveClientSecret}`).toString("base64")}`,
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": `eve-mcp (${config.esiContact})`,
});

async function tokenRequest(form: Record<string, string>): Promise<EveTokens> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/v2/oauth/token`, { method: "POST", headers: headers(), body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new AppError("eve_unavailable", "EVE login is unreachable", 502);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "invalid_grant") throw new AppError("eve_invalid_grant", "EVE refused the code or refresh token", 401);
    throw new AppError("eve_unavailable", `EVE login failed (${res.status})`, 502);
  }
  const t = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null;
  if (!t?.access_token || !t.refresh_token || typeof t.expires_in !== "number") {
    throw new AppError("eve_bad_response", "EVE login returned an unexpected response", 502);
  }
  try {
    const { payload } = await jwtVerify(t.access_token, jwks, { issuer: [BASE, "login.eveonline.com"], algorithms: ["RS256", "ES256"] });
    const aud = [payload.aud ?? []].flat();
    const m = /^CHARACTER:EVE:(\d+)$/.exec(payload.sub ?? "");
    if (!aud.includes(config.eveClientId) || !aud.includes("EVE Online") || !m) throw new Error("bad claims");
    if (typeof payload.name !== "string" || typeof payload.owner !== "string") throw new Error("bad claims");
    const scp = payload.scp;
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      characterId: Number(m[1]),
      characterName: payload.name,
      ownerHash: payload.owner,
      scopes: typeof scp === "string" ? [scp] : Array.isArray(scp) ? scp.map(String) : [],
    };
  } catch (e) {
    // A JWKS fetch timeout is EVE being slow, not a bad token.
    if (e instanceof joseErrors.JWKSTimeout) throw new AppError("eve_unavailable", "EVE login is unreachable", 502);
    log("warn", "EVE token rejected", { reason: (e as Error).message });
    throw new AppError("eve_bad_token", "EVE returned a token that failed verification", 502);
  }
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: "authorization_code", code });

export const refreshEveToken = (refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

export async function revokeEveToken(refreshToken: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/v2/oauth/revoke`, {
      method: "POST",
      headers: headers(),
      body: new URLSearchParams({ token_type_hint: "refresh_token", token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log("warn", "EVE revoke failed", { status: res.status });
  } catch (e) {
    log("warn", "EVE revoke failed", { err: e });
  }
}
