import { afterEach, describe, expect, test } from "bun:test";
import { authorizeUrl, exchangeCode, refreshEveToken, revokeEveToken } from "../src/auth/eve-sso";
import { safeReturnTo } from "../src/auth/routes";
import { EVE_SCOPES } from "../src/esi/scopes";
import { fakeEve, tokenResponse } from "./helpers/eve";

let fake: ReturnType<typeof fakeEve> | undefined;
afterEach(() => fake?.restore());

describe("authorizeUrl", () => {
  test("has the fixed parameters", () => {
    const u = new URL(authorizeUrl("st4te"));
    expect(u.origin + u.pathname).toBe("https://login.eveonline.com/v2/oauth/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/eve/callback");
    expect(u.searchParams.get("client_id")).toBe("test-client");
    expect(u.searchParams.get("state")).toBe("st4te");
    expect(u.searchParams.get("scope")).toBe(EVE_SCOPES.join(" "));
  });
  test("scopes are read-only except fittings write, planets (GET only, see SECURITY.md) and activity read", () => {
    expect(EVE_SCOPES.filter((s) => !/\.read_[a-z_]+\.v1$/.test(s)).sort()).toEqual(["esi-fittings.write_fittings.v1", "esi-planets.manage_planets.v1", "esi.activity.char:read"]);
  });
});

describe("token exchange", () => {
  test("good token", async () => {
    fake = fakeEve(() => tokenResponse({ id: 42, name: "Alice", owner: "h1", scp: "esi-skills.read_skills.v1" }));
    const t = await exchangeCode("the-code");
    expect(t).toMatchObject({ characterId: 42, characterName: "Alice", ownerHash: "h1", scopes: ["esi-skills.read_skills.v1"], refreshToken: "refresh-42" });
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://login.eveonline.com/v2/oauth/token");
    const h = call.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    expect(h["User-Agent"]).toContain("eve-mcp");
    expect(String(call.init.body)).toContain("code=the-code");
  });

  test("refresh sends the refresh grant", async () => {
    fake = fakeEve(() => tokenResponse());
    await refreshEveToken("rt");
    expect(String(fake.calls[0]!.init.body)).toContain("grant_type=refresh_token");
  });

  test("wrong audience, wrong issuer, expired are refused", async () => {
    for (const bad of [{ aud: ["other", "EVE Online"] }, { aud: ["test-client"] }, { iss: "https://evil.example" }, { exp: Math.floor(Date.now() / 1000) - 60 }]) {
      fake = fakeEve(() => tokenResponse(bad));
      await expect(exchangeCode("c")).rejects.toMatchObject({ status: 502 });
      fake.restore();
    }
  });

  test("bare issuer is accepted", async () => {
    fake = fakeEve(() => tokenResponse({ iss: "login.eveonline.com" }));
    expect((await exchangeCode("c")).characterId).toBe(90000001);
  });

  test("invalid_grant is 401, other failures 502", async () => {
    fake = fakeEve(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(exchangeCode("c")).rejects.toMatchObject({ code: "eve_invalid_grant", status: 401 });
    fake.restore();
    fake = fakeEve(() => new Response("boom", { status: 500 }));
    await expect(exchangeCode("c")).rejects.toMatchObject({ status: 502 });
  });

  test("revoke never throws", async () => {
    fake = fakeEve(() => {
      throw new Error("network down");
    });
    await revokeEveToken("rt");
  });
});

describe("return_to", () => {
  test("only local paths", () => {
    expect(safeReturnTo("/apps?x=1")).toBe("/apps?x=1");
    for (const bad of [undefined, "", "apps", "//evil.com", "/\\evil.com", "https://evil.com", "/\t/evil.com", "/a\\b"]) {
      expect(safeReturnTo(bad)).toBe("/characters");
    }
  });
});
