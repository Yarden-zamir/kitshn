// K-721: the daemon decides access for its providers. A provider passes the identity headers of a request; the daemon
// verifies the Access token and evaluates the grant tables that kitshn pushed (K-706), so no provider parses a JWT or
// a circle rule.
import { ipInRange } from "@kitshn/edge/visitor";
import type { Answer, CheckRefusal, Grant, GrantRule, GrantTables, ProviderReport } from "@kitshn/local";
import { type JWTVerifyGetKey, createRemoteJWKSet, errors, jwtVerify } from "jose";

/** K-721: the headers that `check` reads, lowercase, as the `register` answer names them. */
export const IDENTITY_HEADERS = ["cf-access-jwt-assertion", "cf-connecting-ip"] as const;

/** K-721: a provider refuses new sessions when kitshn has not answered this long (`stale`). */
export const STALE_MS = 24 * 60 * 60 * 1000;

export type CheckResult = Extract<Answer, { type: "check" }>["results"][number];
type Subject = { readonly type: "person" | "device" | "machine"; readonly id: string; readonly name: string };

export interface CheckContext {
  /** The provider's last registration: the kinds name the order of its levels. */
  readonly report: ProviderReport;
  readonly grants: GrantTables;
  /** The Access team, such as `team.cloudflareaccess.com`; null before kitshn sent it. */
  readonly teamDomain: string | null;
  /** kitshn's applications of the provider's sites, and the `trustAudiences` of its register. */
  readonly audiences: ReadonlyArray<string>;
  readonly paused: boolean;
  readonly syncedAt: number | null;
  /** K-722: the machines whose "runs commands" covers this machine at "automatic". */
  readonly execMachines: ReadonlySet<string>;
  readonly now: number;
  readonly keys: (teamDomain: string) => JWTVerifyGetKey;
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();
/** The signing keys of an Access team, fetched once and kept by jose until a new key id comes. */
export const accessKeys = (teamDomain: string): JWTVerifyGetKey => {
  let keys = remoteKeys.get(teamDomain);
  if (!keys) {
    // The contract tests serve their own keys; a real daemon reads the team's.
    const url = process.env["KITSHN_ACCESS_CERTS_URL"] ?? `https://${teamDomain}/cdn-cgi/access/certs`;
    keys = createRemoteJWKSet(new URL(url));
    remoteKeys.set(teamDomain, keys);
  }
  return keys;
};

const refused = (key: string, code: CheckRefusal, reason: string): CheckResult => ({
  key,
  refused: { code, reason },
});

/** K-706: whether one rule of a circle names the subject. An unknown rule never matches. */
function ruleMatches(rule: GrantRule, subject: Subject, ip: string | null): boolean {
  if ("email" in rule) return subject.type === "person" && subject.id === rule.email.toLowerCase();
  if ("domain" in rule)
    return subject.type === "person" && subject.id.endsWith(`@${rule.domain.toLowerCase()}`);
  if ("ip" in rule) return ip !== null && ipInRange(ip, rule.ip);
  // A machine token never counts as a device (K-706).
  if ("device" in rule) return subject.type === "device" && subject.id === rule.device.clientId;
  if ("machine" in rule) return subject.type === "machine" && subject.id === rule.machine.machineId;
  if ("everyone" in rule) return true;
  return false;
}

const grantMatches = (grant: Grant, subject: Subject, ip: string | null) =>
  grant.circle.match === "all"
    ? grant.circle.rules.length > 0 && grant.circle.rules.every((rule) => ruleMatches(rule, subject, ip))
    : grant.circle.rules.some((rule) => ruleMatches(rule, subject, ip));

/** A service token's client id names a machine or a device of the grant tables; null when no rule names it. */
function tokenSubject(clientId: string, grants: GrantTables): Subject | null {
  let device: Subject | null = null;
  for (const table of Object.values(grants))
    for (const grant of table)
      for (const rule of grant.circle.rules) {
        if ("machine" in rule && rule.machine.clientId === clientId)
          return { type: "machine", id: rule.machine.machineId, name: rule.machine.machineId };
        if ("device" in rule && rule.device.clientId === clientId)
          device = { type: "device", id: clientId, name: rule.device.name };
      }
  return device;
}

/**
 * K-721: one session's answer: anonymous without an Access token; else the levels that the subject reaches, with
 * the time until which they hold; or a refusal with its code. `expired` is the only code that needs no revocation.
 */
export async function checkSession(
  key: string,
  headers: Readonly<Record<string, string>>,
  context: CheckContext,
): Promise<CheckResult> {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const token = lower["cf-access-jwt-assertion"];
  if (!token) return { key, anonymous: true };
  if (context.paused) return refused(key, "paused", "kitshn is paused (K-1504).");
  if (context.syncedAt === null || context.now - context.syncedAt > STALE_MS)
    return refused(key, "stale", "kitshn has not answered this daemon for 24 hours.");
  if (!context.teamDomain || context.audiences.length === 0)
    return refused(key, "invalid", "kitshn has not sent an Access application of this provider yet.");
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, context.keys(context.teamDomain), {
      issuer: `https://${context.teamDomain}`,
      audience: [...context.audiences],
      currentDate: new Date(context.now),
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) return refused(key, "expired", "the Access token expired.");
    return refused(
      key,
      "invalid",
      `the Access token does not verify: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const email =
    typeof payload["email"] === "string" && payload["email"] !== "" ? payload["email"].toLowerCase() : null;
  const commonName = typeof payload["common_name"] === "string" ? payload["common_name"] : null;
  const subject: Subject | null = email
    ? { type: "person", id: email, name: email }
    : commonName
      ? tokenSubject(commonName, context.grants)
      : null;
  if (!subject) return refused(key, "unknown-subject", "no grant names this service token.");
  const ip = lower["cf-connecting-ip"] ?? null;
  const kinds = new Map(context.report.kinds.map((kind) => [kind.id, kind]));
  const kindOf = new Map(context.report.resources.map((resource) => [resource.id, resource.kind]));
  const levels: Record<string, string> = {};
  let until = Math.min(
    typeof payload["exp"] === "number" ? payload["exp"] * 1000 : context.now,
    context.syncedAt + STALE_MS,
  );
  for (const [resourceId, table] of Object.entries(context.grants)) {
    const kind = kinds.get(kindOf.get(resourceId) ?? "");
    if (!kind) continue;
    // The order of a kind's levels is view, use, control (K-713); a higher one wins.
    const order = (["view", "use", "control"] as const).flatMap((step) => kind.levels[step] ?? []);
    let best: Grant | null = null;
    for (const grant of table) {
      if (grant.endsAt !== null && grant.endsAt <= context.now) continue;
      if (!grantMatches(grant, subject, ip)) continue;
      if (!best || order.indexOf(grant.level) > order.indexOf(best.level)) best = grant;
    }
    if (!best) continue;
    levels[resourceId] = best.level;
    if (best.endsAt !== null) until = Math.min(until, best.endsAt);
  }
  if (Object.keys(levels).length === 0) return refused(key, "no-access", "the subject has no level here.");
  const rights =
    subject.type === "machine" && context.execMachines.has(subject.id) ? (["exec"] as const) : [];
  return { key, subject, levels, rights: [...rights], until };
}
