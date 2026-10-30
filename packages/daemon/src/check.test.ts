import type { Grant, GrantTables, ProviderReport } from "@kitshn/local";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { type CheckContext, STALE_MS, checkSession } from "./check.ts";

const TEAM = "team.cloudflareaccess.com";
const NOW = 1_800_000_000_000;
const pair = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
const token = (claims: Record<string, unknown>, more: { aud?: string; exp?: number; iss?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuer(more.iss ?? `https://${TEAM}`)
    .setAudience(more.aud ?? "aud-app")
    .setExpirationTime(more.exp ?? Math.floor(NOW / 1000) + 3600)
    .sign(pair.privateKey);

const report: ProviderReport = {
  name: "t3",
  online: true,
  kinds: [
    { id: "t3.app", name: "app", levels: { view: "read", use: "standard", control: "admin" } },
    { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
  ],
  commands: [],
  resources: [
    { id: "app", kind: "t3.app", name: "T3", status: "running" },
    { id: "th-1", kind: "t3.thread", name: "thread", status: "running" },
  ],
};
const grant = (
  rules: Grant["circle"]["rules"],
  level: string,
  more: Partial<Grant["circle"]> & { endsAt?: number } = {},
): Grant => ({
  circle: { id: "c", name: "c", match: "any", needsPasskey: false, rules, ...more },
  level,
  endsAt: more.endsAt ?? null,
});
const grants: GrantTables = {
  app: [
    grant(
      [{ email: "owner@example.com" }, { machine: { machineId: "mac", clientId: "mac.access" } }],
      "admin",
    ),
    grant([{ device: { clientId: "mac.access", name: "a device with a machine's id" } }], "admin"),
    grant([{ device: { clientId: "phone.access", name: "Pixel" } }], "standard", { endsAt: NOW + 60_000 }),
    grant([{ ip: "10.0.0.0/8" }], "read"),
    grant([{ email: "her@example.com" }, { unknown: "future" }], "admin", { match: "all" }),
  ],
  "th-1": [grant([{ everyone: true }], "view"), grant([{ domain: "example.com" }], "send")],
};
const context = (more: Partial<CheckContext> = {}): CheckContext => ({
  report,
  grants,
  teamDomain: TEAM,
  audiences: ["aud-app", "aud-portal"],
  paused: false,
  syncedAt: NOW - 1000,
  execMachines: new Set(["mac"]),
  now: NOW,
  keys: () => jwks,
  ...more,
});
const check = async (headers: Record<string, string>, more: Partial<CheckContext> = {}) =>
  checkSession("s", headers, context(more));
const jwt = async (claims: Record<string, unknown>, more?: Parameters<typeof token>[1]) => ({
  "cf-access-jwt-assertion": await token(claims, more),
});

describe("check (K-721)", () => {
  it("gives each subject the highest level that its circles give, and the exec right only to a machine that has it (C-9)", async () => {
    expect(await check(await jwt({ email: "Owner@Example.com" }))).toMatchObject({
      subject: { type: "person", id: "owner@example.com" },
      levels: { app: "admin", "th-1": "send" },
      rights: [],
    });
    // A machine token matches the machine rule, never the device rule with the same client id.
    expect(await check(await jwt({ common_name: "mac.access" }))).toMatchObject({
      subject: { type: "machine", id: "mac" },
      levels: { app: "admin", "th-1": "view" },
      rights: ["exec"],
    });
    expect(await check(await jwt({ common_name: "phone.access" }))).toMatchObject({
      subject: { type: "device", id: "phone.access", name: "Pixel" },
      levels: { app: "standard", "th-1": "view" },
    });
    // An IP rule matches the address that Cloudflare names; everyone matches anyone.
    expect(
      await check({ ...(await jwt({ email: "x@other.org" })), "cf-connecting-ip": "10.1.2.3" }),
    ).toMatchObject({
      levels: { app: "read", "th-1": "view" },
    });
    // An "all" circle with a rule of an unknown type never matches.
    expect(await check(await jwt({ email: "her@example.com" }))).toMatchObject({
      levels: { "th-1": "send" },
    });
    expect((await check(await jwt({ email: "her@example.com" }))) as object).not.toHaveProperty("levels.app");
  });

  it("answers anonymous without a token, and refuses with a typed code otherwise (C-9)", async () => {
    expect(await check({ "cf-connecting-ip": "10.1.2.3" })).toEqual({ key: "s", anonymous: true });
    expect(await check(await jwt({ email: "a@b.c" }, { exp: Math.floor(NOW / 1000) - 10 }))).toMatchObject({
      refused: { code: "expired" },
    });
    expect(await check(await jwt({ email: "a@b.c" }, { aud: "other" }))).toMatchObject({
      refused: { code: "invalid" },
    });
    expect(await check(await jwt({ email: "a@b.c" }, { iss: "https://evil.example" }))).toMatchObject({
      refused: { code: "invalid" },
    });
    expect(await check(await jwt({ common_name: "stranger.access" }))).toMatchObject({
      refused: { code: "unknown-subject" },
    });
    expect(
      await check(await jwt({ email: "x@other.org" }), { grants: { app: grants["app"]!.slice(0, 1) } }),
    ).toMatchObject({
      refused: { code: "no-access" },
    });
    expect(await check(await jwt({ email: "owner@example.com" }), { paused: true })).toMatchObject({
      refused: { code: "paused" },
    });
    expect(
      await check(await jwt({ email: "owner@example.com" }), { syncedAt: NOW - STALE_MS - 1 }),
    ).toMatchObject({
      refused: { code: "stale" },
    });
  });

  it("holds an answer until the earliest of the token expiry, a grant end and 24 hours after kitshn last answered (C-11)", async () => {
    const exp = Math.floor(NOW / 1000) + 3600;
    expect(await check(await jwt({ common_name: "phone.access" }, { exp }))).toMatchObject({
      until: NOW + 60_000,
    });
    expect(await check(await jwt({ email: "owner@example.com" }, { exp }))).toMatchObject({
      until: exp * 1000,
    });
    expect(
      await check(await jwt({ email: "owner@example.com" }, { exp }), { syncedAt: NOW - STALE_MS + 5000 }),
    ).toMatchObject({
      until: NOW + 5000,
    });
  });
});
