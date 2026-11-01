import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Author } from "../core/changes.ts";
import type { ContentVisitor } from "../core/library.ts";
import type { Effect } from "../core/model.ts";
import type { OpId } from "../core/operations.ts";
import type { Attested, Visitor } from "../core/visitor.ts";
import type { Env } from "./env.ts";

/**
 * K-1776, K-1777: what lets the job of a gated call go out without the agent checks of its delivery. The asker is a
 * machine with its key at the approval, so a reset or a rotation ends the approval; or a token or login credential of an
 * actor (K-1778), which ends when no actor holds it.
 */
export type JobApproval = (
  { readonly machineId: string; readonly key: string | null } | { readonly credential: string }
) & {
  /** The effect that the approval or the gate used (K-1730); null for an approval with no effect to check again. */
  readonly right: Effect | null;
  /** K-1778: the verified labels of a machine call, so its agent actors count again at delivery. */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * A person approved this call. Without one, only the gate let it run, so its delivery checks K-718 again for a command
   * that is not closed, and its job keeps the normal expiry (K-613).
   */
  readonly person: boolean;
  /**
   * K-1777: no approval ran the call; the gate ran it because this effect of the caller was automatic. Its delivery
   * checks that the effect stays automatic.
   */
  readonly automatic?: Effect;
};

export interface Caller {
  readonly visitor: Visitor;
  readonly actor: Author;
  /**
   * K-1777: the operation whose gate let this machine call run, and the approval that its jobs carry. Only the Durable
   * Object sets it, never a header. An owner call through `/op` has none, so it runs as from the map.
   */
  readonly gated?: { readonly op: OpId; readonly approval: JobApproval };
  /**
   * K-1754, K-1778: the verified labels of a machine call, which select its agent actors. Only the Durable Object sets
   * it, after the signature check of K-1714, never a header.
   */
  readonly attested?: Attested;
}

let jwks: { readonly team: string; readonly set: ReturnType<typeof createRemoteJWKSet> } | null = null;

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/** K-404: the identity in an Access JWT that one of the audience tags signed, or a reason string. */
async function accessIdentity(
  token: string,
  env: Env,
  audiences: ReadonlyArray<string>,
): Promise<
  | {
      email: string | null;
      clientId: string | null;
      audience: string;
      issuedAt: number | null;
      expiresAt: number | null;
    }
  | string
> {
  // K-1209: during the host move, an `ACCESS_*_AUD` value lists the new and the old tag, comma-separated.
  const wanted = audiences
    .flatMap((value) => value.split(","))
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!env.ACCESS_TEAM_DOMAIN || wanted.length === 0) return "kitshn has no Access configuration.";
  if (jwks?.team !== env.ACCESS_TEAM_DOMAIN) {
    const certs = new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    jwks = { team: env.ACCESS_TEAM_DOMAIN, set: createRemoteJWKSet(certs) };
  }
  try {
    const { payload } = await jwtVerify(token, jwks.set, {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: wanted,
      // Access and the Worker clocks can differ by a second; without slack a fresh token fails its nbf.
      clockTolerance: 60,
    });
    const email = typeof payload["email"] === "string" ? payload["email"] : null;
    const clientId = typeof payload["common_name"] === "string" ? payload["common_name"] : null;
    const tokenAudiences = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
    const audience = wanted.find((tag) => tokenAudiences.includes(tag));
    if (!audience) return "The Access token has none of the expected audience tags.";
    if (!email && !clientId) return "The Access token names no email and no service token.";
    return {
      email: email || null,
      clientId: email ? null : clientId,
      audience,
      issuedAt: payload.iat ?? null,
      expiresAt: payload.exp ?? null,
    };
  } catch (error) {
    return `The Access token is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * K-404: the caller from the Access JWT, checked against the team keys and the audience tag of the
 * Access application of the path. Returns a reason string when the request has no valid identity.
 */
export async function callerOf(request: Request, env: Env, audience: string): Promise<Caller | string> {
  const url = new URL(request.url);
  const ip = request.headers.get("cf-connecting-ip");
  if (env.DEV_IDENTITY && isLocal(url)) {
    return {
      visitor: { email: env.DEV_IDENTITY, clientId: null, ip },
      actor: { _tag: "person", email: env.DEV_IDENTITY },
    };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "The request has no Cloudflare Access token.";
  const identity = await accessIdentity(token, env, [audience]);
  if (typeof identity === "string") return identity;
  const { email, clientId } = identity;
  if (email) return { visitor: { email, clientId: null, ip }, actor: { _tag: "person", email } };
  return {
    visitor: { email: null, clientId, ip },
    actor: { _tag: "device", clientId: clientId ?? "", name: clientId ?? "" },
  };
}

/** K-1504: how old a fresh passkey login may be for "Resume". */
export const FRESH_SECONDS = 600;

/**
 * K-1504: an owner login that passed the passkey check of the `/api/fresh` application within the last
 * ten minutes, or why not.
 */
export async function freshCallerOf(request: Request, env: Env, now: number): Promise<Caller | string> {
  if (env.DEV_IDENTITY && isLocal(new URL(request.url))) return callerOf(request, env, "");
  if (!env.ACCESS_FRESH_AUD) return "Run the bootstrap again to turn on the fresh passkey check.";
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "The request has no Cloudflare Access token.";
  const identity = await accessIdentity(token, env, [env.ACCESS_FRESH_AUD]);
  if (typeof identity === "string") return identity;
  if (!identity.email) return "Resume needs a person with a passkey, not a service token.";
  if (identity.issuedAt === null || now / 1000 - identity.issuedAt > FRESH_SECONDS)
    return "The passkey check is older than 10 minutes. Press Resume again.";
  const ip = request.headers.get("cf-connecting-ip");
  return {
    visitor: { email: identity.email, clientId: null, ip },
    actor: { _tag: "person", email: identity.email },
  };
}

/** The two login applications of a content host: `/login`, and `/login/passkey` with the passkey check. */
export interface ContentLogins {
  readonly login: string;
  readonly passkey: string;
}

/**
 * K-1004: the cookie where the Worker keeps the token of one login step. Both login applications of a host
 * write `CF_Authorization` on `/`, so the later one replaces the earlier one; the Worker keeps its own copy.
 */
export const stepCookie = (step: "login" | "passkey") => `__Host-kitshn-${step}-token`;

/**
 * K-1004: the token that Access put on a login step with its expiry, or the reason it does not prove that
 * step.
 */
export async function stepToken(
  token: string | null,
  env: Env,
  audience: string,
): Promise<{ readonly token: string; readonly expiresAt: number } | string> {
  if (!token) return "Access sent no token with this step.";
  const identity = await accessIdentity(token, env, [audience]);
  if (typeof identity === "string") return identity;
  if (identity.expiresAt === null) return "The Access token has no expiry.";
  return { token, expiresAt: identity.expiresAt };
}

/** Every value of a cookie: a browser can send two with the same name (another path or a parent domain). */
export const cookieValues = (header: string | null, name: string) =>
  (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));

/**
 * K-1004: the visitor of a page or a file. Access sets the `CF_Authorization` cookie with `Path=/` at the
 * login path, so it comes with every request to the host. No valid cookie means an anonymous visitor.
 */
export async function contentVisitorOf(
  request: Request,
  env: Env,
  logins: ContentLogins,
): Promise<{
  readonly visitor: ContentVisitor;
  readonly problem: string | null;
  /** What each token was, for the loop guard text: its source, then its step or the reason it failed. */
  readonly seen: ReadonlyArray<string>;
}> {
  const ip = request.headers.get("cf-connecting-ip");
  const anonymous: ContentVisitor = { email: null, clientId: null, ip, passkey: false, issuedAt: null };
  if (env.DEV_IDENTITY && isLocal(new URL(request.url)))
    return {
      visitor: { email: env.DEV_IDENTITY, clientId: null, ip, passkey: true, issuedAt: null },
      problem: null,
      seen: [],
    };
  const header = request.headers.get("cf-access-jwt-assertion");
  const cookies = request.headers.get("cookie");
  const tokens = [
    ...(header ? [{ source: "header", token: header }] : []),
    ...[stepCookie("passkey"), stepCookie("login"), "CF_Authorization"].flatMap((name) =>
      cookieValues(cookies, name).map((token) => ({ source: name, token })),
    ),
  ];
  let problem: string | null = null;
  // A passkey login wins over a plain one, because it gives the higher level (K-103).
  let best: ContentVisitor | null = null;
  const seen: Array<string> = [];
  for (const { source, token } of tokens) {
    const identity = await accessIdentity(token, env, [logins.login, logins.passkey]);
    if (typeof identity === "string") {
      problem = identity;
      seen.push(`${source}: ${identity}`);
      continue;
    }
    seen.push(`${source}: ${identity.audience === logins.passkey ? "passkey" : "plain"} login`);
    const visitor: ContentVisitor = {
      email: identity.email,
      clientId: identity.clientId,
      ip,
      passkey: identity.audience === logins.passkey,
      issuedAt: identity.issuedAt,
    };
    if (!best || (visitor.passkey && !best.passkey)) best = visitor;
  }
  return { visitor: best ?? anonymous, problem: best ? null : problem, seen };
}

/** Who deploys: the repo of a GitHub Actions run, from its OIDC token (K-811). */
export interface Deployer {
  readonly repo: string;
  /** GitHub's id of the repo; unlike the name, it never changes or clashes. */
  readonly repoId: string;
  readonly ownerId: string;
  readonly sha: string;
  /** The event, the branch and the pull request come from the signed token, never from the request. */
  readonly eventName: string;
  readonly branch: string;
  readonly pr: number | null;
  /** The workflow run and its attempt; the deploys of one run are one group for a later rollback (K-820). */
  readonly runId: string;
  readonly runAttempt: string;
  /** K-1121: the file in `.github/workflows` of the run, from `workflow_ref`; null when the claim names none. */
  readonly workflow: string | null;
  /** K-1767: the login that started the run, for example `kitshn[bot]` for a push of the App. */
  readonly actor: string;
}

/** K-1121: `owner/repo/.github/workflows/<file>@<ref>` names the workflow file of the caller, also for a reusable one. */
export function workflowFile(workflowRef: string, repo: string): string | null {
  const path = workflowRef.split("@")[0] ?? "";
  const prefix = `${repo}/.github/workflows/`;
  const file = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  return file !== "" && !file.includes("/") ? file : null;
}

const github = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

/**
 * K-811: accepts a GitHub Actions OIDC token for this kitshn, from a repo of a listed owner account.
 * Returns a reason string for any other request.
 */
export async function deployerOf(request: Request, env: Env): Promise<Deployer | string> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer "))
    return "A deploy needs the GitHub Actions OIDC token (permissions: id-token: write).";
  const owners = env.DEPLOY_OWNER_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (owners.length === 0)
    return "This kitshn trusts no GitHub owner yet. Run the bootstrap with KITSHN_DEPLOY_OWNERS.";
  try {
    const { payload } = await jwtVerify(header.slice("Bearer ".length), github, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: new URL(request.url).origin,
    });
    const text = (name: string) => (typeof payload[name] === "string" ? (payload[name] as string) : "");
    const [repo, repoId, ownerId, sha, eventName, ref] = [
      "repository",
      "repository_id",
      "repository_owner_id",
      "sha",
      "event_name",
      "ref",
    ].map(text) as [string, string, string, string, string, string];
    if (!repo || !repoId || !ownerId || !sha || !eventName) {
      return "The GitHub token has no repository, owner, commit or event.";
    }
    if (!owners.includes(ownerId)) return `kitshn does not trust the GitHub owner of ${repo} (K-811).`;
    const pull = /^refs\/pull\/(\d+)\//.exec(ref);
    const branch = eventName === "pull_request" ? text("head_ref") : ref.replace(/^refs\/heads\//, "");
    return {
      repo,
      repoId,
      ownerId,
      sha,
      eventName,
      branch,
      pr: pull ? Number(pull[1]) : null,
      runId: text("run_id"),
      runAttempt: text("run_attempt"),
      workflow: workflowFile(text("workflow_ref"), repo),
      actor: text("actor"),
    };
  } catch (error) {
    return `The GitHub token is not valid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * K-1723: a person on an approve path, from the Access token of that path's own application (`audience`). On the passkey
 * path, the login must be at most ten minutes old, because that application only has policies with the passkey check.
 */
export async function approverOf(
  request: Request,
  env: Env,
  audience: string | null,
  fresh: boolean,
  now: number,
): Promise<Caller | string> {
  if (env.DEV_IDENTITY && isLocal(new URL(request.url))) return callerOf(request, env, "");
  if (!audience)
    return "kitshn makes the approve application with its next Access sync. Try again in a minute.";
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return "The request has no Cloudflare Access token.";
  const identity = await accessIdentity(token, env, [audience]);
  if (typeof identity === "string") return identity;
  if (!identity.email) return "An approve needs a person, not a service token.";
  if (fresh && (identity.issuedAt === null || now / 1000 - identity.issuedAt > FRESH_SECONDS))
    return "The passkey check is older than 10 minutes. Approve again.";
  const ip = request.headers.get("cf-connecting-ip");
  return {
    visitor: { email: identity.email, clientId: null, ip },
    actor: { _tag: "person", email: identity.email },
  };
}
