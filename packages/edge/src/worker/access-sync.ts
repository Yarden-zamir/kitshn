import {
  ACCESS_NAME_PREFIX,
  type AppBody,
  type DesiredAccess,
  ENROLLMENT_KEY,
  OP_TOKENS_POLICY,
  type PolicyBody,
} from "../core/access.ts";
import { Schema } from "effect";
import { deepEqual } from "../core/changes.ts";
import { CloudflareError } from "./cloudflare.ts";
import type { AccessState } from "../core/protocol.ts";

/**
 * What kitshn knows about one Access object. `body` is the JSON that Cloudflare last accepted ("" when
 * none). `tried` is the JSON of the last attempt; with `error` set, that attempt failed.
 */
export interface AccessRow {
  readonly key: string;
  readonly cfId: string;
  /** The audience tag of an application with `cfId` ("" for a policy, or until Cloudflare returns it). */
  readonly aud: string;
  readonly body: string;
  readonly tried: string;
  readonly error: string | null;
  /** K-407, K-408: in memory only, when a failed write or delete tries again; after a restart it tries at once. */
  readonly retryAt?: number;
  /** K-408: in memory only, the failed tries in a row, for the backoff. */
  readonly attempts?: number;
  /** K-409: in memory only, the applications whose sessions the write of `tried` already ended. */
  readonly ended?: ReadonlyArray<string>;
}

export interface AccessStore {
  readonly rows: ReadonlyMap<string, AccessRow>;
  put(row: AccessRow): void;
  remove(key: string): void;
}

export type Api = <T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<T>;

/** K-406: one alarm run makes at most this many Cloudflare API calls. */
export const CALLS_PER_RUN = 40;
const PAGE = 1000;

const policyBody = (policy: PolicyBody) => JSON.stringify(policy);

/**
 * K-407, K-408: the backoff of a write after an unclear answer, and of a write that lowers access after a refusal: 5
 * minutes, then 15, then each hour. The daily run of K-408 retries every failed write anyway.
 */
export const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const RETRY_AFTER_MS = BACKOFF_MS[0];

/** The retry time and the count of the next failed try of a row. */
const backoff = (row: AccessRow | undefined, now: number) => {
  const attempts = (row?.attempts ?? 0) + 1;
  return { retryAt: now + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!, attempts };
};

/** K-408: what Cloudflare serves is the wanted body: every field of the body, and the policies by id in order. */
const serves = (live: unknown, body: string) => {
  if (typeof live !== "object" || live === null) return false;
  const served = live as Record<string, unknown>;
  return Object.entries(JSON.parse(body) as Record<string, unknown>).every(([key, wanted]) =>
    key === "policies"
      ? deepEqual(
          ((served["policies"] ?? []) as ReadonlyArray<{ id: string }>).map((policy) => policy.id),
          (wanted as ReadonlyArray<{ id: string }>).map((policy) => policy.id),
        )
      : deepEqual(served[key], wanted),
  );
};

/** K-408: Cloudflare gave no clear answer (no answer, a 5xx or a 429), so the write may or may not have landed. */
export const unclearAnswer = (error: unknown) =>
  error instanceof CloudflareError && (error.status === 0 || error.status >= 500 || error.status === 429);

/**
 * K-407: the write may take access away: it drops a policy of the body that Cloudflare has, or that body is unknown
 * (after an unclear answer), so least access wins.
 */
const lowers = (row: AccessRow, body: string) =>
  row.body === ""
    ? row.cfId !== ""
    : row.key.startsWith("policy:")
      ? row.key !== OP_TOKENS_POLICY && narrowsPolicy(row.body, body)
      : removesPolicy(row.body, body);

/**
 * K-407: a policy body takes access away when it drops a rule of `include`, or changes any other field of the wanted
 * body but its name (a new `require`, a passkey check). Extra fields of a body that Cloudflare served count for nothing.
 * A member out of an "all must match" circle also counts, which fails safe: one more retry and a red card.
 */
const narrowsPolicy = (before: string, after: string) => {
  const { include: was = [], ...wasRest } = JSON.parse(before) as Record<string, unknown> & {
    include?: ReadonlyArray<unknown>;
  };
  const { include: now = [], ...nowRest } = JSON.parse(after) as Record<string, unknown> & {
    include?: ReadonlyArray<unknown>;
  };
  // "Everyone" lets anyone in, so it never takes access away.
  if (nowRest["decision"] === "bypass" && now.some((rule) => deepEqual(rule, { everyone: {} }))) return false;
  return (
    was.some((rule) => !now.some((kept) => deepEqual(rule, kept))) ||
    // The name gives no access, so a renamed circle does not lower it.
    Object.entries(nowRest).some(([key, value]) => key !== "name" && !deepEqual(wasRest[key], value))
  );
};

/** K-409: the Cloudflare ids of the applications whose accepted body uses this policy. */
const appsUsing = (rows: ReadonlyMap<string, AccessRow>, policyId: string) =>
  [...rows.values()]
    .filter((row) => row.key.startsWith("app:") && row.cfId !== "" && policyIds(row.body).includes(policyId))
    .map((row) => row.cfId);

/**
 * True when the write of this body waits. A refusal (`tried` is this body) waits for the daily retry (K-408), and one
 * that lowers access only until its retry time (K-407). After an unclear answer the row has no `tried` and no `body`,
 * and the next write of any body waits until its retry time.
 */
const failedWith = (row: AccessRow | undefined, body: string, now = Date.now()) => {
  if (row?.error == null) return false;
  if (row.tried === body) return !lowers(row, body) || (row.retryAt ?? 0) > now;
  return row.tried === "" && (row.retryAt ?? 0) > now;
};

/**
 * The application body, or null while it must wait. A policy without a Cloudflare id is left out only
 * when the result takes access away from what Cloudflare has (fails closed). Otherwise the application
 * waits for that policy, so a failed create never empties an application.
 */
function appBody(key: string, app: AppBody, rows: ReadonlyMap<string, AccessRow>): string | null {
  const ids = app.policyKeys.map((policyKey) => rows.get(policyKey)?.cfId ?? "").filter((id) => id !== "");
  if (ids.length < app.policyKeys.length) {
    const row = rows.get(key);
    if (!row?.body) return null;
    const written = new Set(
      (JSON.parse(row.body) as { policies: Array<{ id: string }> }).policies.map((p) => p.id),
    );
    if (!ids.every((id) => written.has(id))) return null;
  }
  const { policyKeys: _, ...rest } = app;
  return JSON.stringify({ ...rest, policies: ids.map((id, index) => ({ id, precedence: index + 1 })) });
}

/** K-407: the Access state of each card with an application. */
export function accessStates(
  desired: DesiredAccess,
  rows: ReadonlyMap<string, AccessRow>,
): Record<string, AccessState> {
  const states: Record<string, AccessState> = {};
  for (const [key, app] of desired.apps) {
    const resourceId = key.split(":")[1] ?? key;
    const parts = [
      ...app.policyKeys.map((policyKey) => {
        const policy = desired.policies.get(policyKey);
        return { row: rows.get(policyKey), body: policy ? policyBody(policy) : "" };
      }),
      { row: rows.get(key), body: appBody(key, app, rows) ?? "" },
    ];
    // A refusal shows in red; one that may lower access says so, because the old access stays open until it lands.
    const failed = parts.find((part) => part.row?.error != null && part.row.tried === part.body);
    // After an unclear answer the row has no `tried`; kitshn tries again by itself, so the card says "retrying".
    const unclear = parts.find((part) => part.row?.error != null && part.row.tried === "");
    const state: AccessState = failed?.row?.error
      ? {
          state: "failed",
          error: lowers(failed.row, failed.body)
            ? `Access not lowered yet: ${failed.row.error}`
            : failed.row.error,
        }
      : unclear?.row?.error
        ? { state: "retrying", error: unclear.row.error, at: unclear.row.retryAt ?? 0 }
        : parts.every((part) => part.row?.cfId && part.row.body === part.body)
          ? { state: "applied" }
          : { state: "applying" };
    const previous = states[resourceId];
    if (!previous || previous.state === "applied") states[resourceId] = state;
  }
  return states;
}

/** True when some object needs a write that is not waiting for the daily retry. */
export function hasAccessWork(
  desired: DesiredAccess,
  rows: ReadonlyMap<string, AccessRow>,
  reachable: ReadonlySet<string> = new Set(),
  held: ReadonlySet<string> = new Set(),
): boolean {
  for (const [key, policy] of desired.policies) {
    if (isHeld(rows.get(key), held)) continue;
    const body = policyBody(policy);
    if (rows.get(key)?.body !== body && !failedWith(rows.get(key), body)) return true;
  }
  for (const [key, app] of desired.apps) {
    const body = appBody(key, app, rows);
    if (body !== null && rows.get(key)?.body !== body && !failedWith(rows.get(key), body)) return true;
  }
  const kept = withHeld(keptPolicies(desired, rows, reachable), held);
  for (const row of rows.values()) if (isStale(desired, row, reachable, kept)) return true;
  return false;
}

/**
 * K-1004: policy ids that the login applications hold since the last login step that succeeded. The sync
 * neither changes nor deletes them until the login step lets go of them, so a passkey check never drops
 * from `/login/passkey` and a policy in use never goes.
 */
const isHeld = (row: AccessRow | undefined, held: ReadonlySet<string>) =>
  row !== undefined && row.cfId !== "" && held.has(row.cfId);

const withHeld = (kept: ReadonlySet<string> | null, held: ReadonlySet<string>) =>
  kept === null ? null : new Set([...kept, ...held]);

/** The address of an application row, from its key `app:<card>:<address>`, so it never depends on the body. */
const appDomain = (row: AccessRow) => {
  const domain = row.key.split(":").slice(2).join(":");
  return domain || null;
};

/**
 * K-006: an application that kitshn no longer wants stays while a route (tunnel ingress, DNS record,
 * Worker route or custom domain) can still reach its address. Its policies stay with it.
 */
function keptPolicies(
  desired: DesiredAccess,
  rows: ReadonlyMap<string, AccessRow>,
  reachable: ReadonlySet<string>,
) {
  const kept = new Set<string>();
  for (const row of rows.values()) {
    if (!row.key.startsWith("app:") || desired.apps.has(row.key)) continue;
    const domain = appDomain(row);
    if (domain === null || !reachable.has(domain)) continue;
    // A kept app whose body is unknown (after an unclear answer) has unknown policies: keep every policy for now.
    if (!row.body) return null;
    for (const id of policyIds(row.body)) kept.add(id);
  }
  return kept;
}

/** A row that kitshn no longer wants and may delete now. A failed deletion waits for the daily retry (K-408). */
const isStale = (
  desired: DesiredAccess,
  row: AccessRow,
  reachable: ReadonlySet<string>,
  kept: ReadonlySet<string> | null,
) => {
  if (desired.policies.has(row.key) || desired.apps.has(row.key)) return false;
  // A failed delete waits for its retry time (an unclear answer, or an application, whose delete lowers access), or
  // else for the daily retry (K-407, K-408).
  if (
    row.error !== null &&
    (row.retryAt === undefined ? !row.key.startsWith("app:") : row.retryAt > Date.now())
  )
    return false;
  if (row.key.startsWith("app:")) {
    const domain = appDomain(row);
    return domain === null || !reachable.has(domain);
  }
  return kept !== null && !kept.has(row.cfId);
};

const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && error.status === 404;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The policy ids in an application body. An empty body (unknown after an unclear answer) has none. */
const policyIds = (body: string) =>
  body
    ? ((JSON.parse(body) as { policies?: ReadonlyArray<{ id: string }> }).policies?.map(
        (policy) => policy.id,
      ) ?? [])
    : [];

const removesPolicy = (before: string, after: string, ignored = "") => {
  const kept = new Set(policyIds(after));
  return policyIds(before).some((id) => id !== ignored && !kept.has(id));
};

interface Named {
  readonly id: string;
  readonly name: string;
  readonly domain?: string;
  readonly aud?: string;
}

interface LivePolicy extends Named {
  readonly decision: string;
  readonly include: unknown;
  readonly require: unknown;
  readonly exclude: unknown;
}

interface LiveApp extends Named {
  readonly session_duration?: string;
  readonly policies?: ReadonlyArray<{ readonly id: string }>;
}

/**
 * K-408, the daily run: reads Access in two calls and marks each object that someone changed or deleted,
 * so the next sync writes it again. The lists carry no MFA settings, so a changed passkey setting is not
 * seen here; revisit if the list API adds `mfa_config`. Returns warnings for applications that kitshn did
 * not make but that cover a kitshn address; kitshn never changes those.
 */
export async function verifyAccess(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
): Promise<Array<string>> {
  const base = `/accounts/${accountId}/access`;
  const policies = await api<ReadonlyArray<LivePolicy>>("GET", `${base}/policies?per_page=${PAGE}`);
  const apps = await api<ReadonlyArray<LiveApp>>("GET", `${base}/apps?per_page=${PAGE}`);
  // A full page can hide objects on a next page; then "missing" means nothing, so kitshn compares nothing.
  if (policies.length >= PAGE || apps.length >= PAGE) {
    return ["The account has too many Access objects for the daily compare (K-408), so kitshn skipped it."];
  }
  for (const row of store.rows.values()) {
    // A pending attempt (a failed write or revoke) is retried by the sync itself; comparing it here would
    // drop the old body that the session revoke of K-409 needs.
    if (!row.cfId || !row.body || (row.tried !== "" && row.tried !== row.body)) continue;
    const ours = JSON.parse(row.body) as Record<string, unknown>;
    let same: boolean;
    if (row.key.startsWith("policy:")) {
      const live = policies.find((policy) => policy.id === row.cfId);
      same =
        live !== undefined &&
        deepEqual(
          {
            name: live.name,
            decision: live.decision,
            include: live.include,
            require: live.require,
            exclude: live.exclude,
          },
          {
            name: ours["name"],
            decision: ours["decision"],
            include: ours["include"],
            require: ours["require"],
            exclude: ours["exclude"],
          },
        );
      if (!live) store.put({ ...row, cfId: "", aud: "", body: "", tried: "", error: null });
      else if (!same) store.put({ ...row, body: JSON.stringify(live), tried: "", error: null });
      continue;
    }
    const live = apps.find((app) => app.id === row.cfId);
    same =
      live !== undefined &&
      deepEqual(
        {
          name: live.name,
          domain: live.domain,
          session: live.session_duration,
          policies: live.policies?.map((p) => p.id) ?? [],
        },
        {
          name: ours["name"],
          domain: ours["domain"],
          session: ours["session_duration"],
          policies: policyIds(row.body),
        },
      );
    if (!live) store.put({ ...row, cfId: "", aud: "", body: "", tried: "", error: null });
    else if (!same) store.put({ ...row, body: JSON.stringify(live), tried: "", error: null });
  }
  const ours = new Set([...store.rows.values()].map((row) => row.cfId));
  const warnings: Array<string> = [];
  for (const app of desired.apps.values()) {
    for (const live of apps) {
      if (live.domain === app.domain && !ours.has(live.id)) {
        warnings.push(
          `The Access application "${live.name}" also covers ${app.domain}. kitshn did not make it and does not change it.`,
        );
      }
    }
  }
  return warnings;
}

/** K-110: an application whose sessions a sign-out did not end yet, and why. */
export interface LeftApp {
  readonly key: string;
  readonly cfId: string;
  readonly reason: string;
}

/**
 * K-110: what a sign-out did. `listFailed` means the list of applications failed, so no session ended and a
 * retry starts over; otherwise `left` names each application that a retry revokes again.
 */
export type SignOutOutcome =
  | { readonly ended: number; readonly left: ReadonlyArray<LeftApp> }
  | { readonly ended: 0; readonly listFailed: string };

const LeftAppSchema = Schema.Struct({ key: Schema.String, cfId: Schema.String, reason: Schema.String });
const SignOutOutcomeSchema = Schema.Union([
  Schema.Struct({ ended: Schema.Number, left: Schema.Array(LeftAppSchema) }),
  Schema.Struct({ ended: Schema.Literal(0), listFailed: Schema.String }),
]);
const decodeOutcome = Schema.decodeUnknownSync(SignOutOutcomeSchema);

/** K-110: the stored outcome of the last sign-out, or null when none is left or the row is broken. */
export function readSignOutLeft(saved: string | null): SignOutOutcome | null {
  if (!saved) return null;
  try {
    return decodeOutcome(JSON.parse(saved));
  } catch (error) {
    // A broken row must not break every snapshot; the next sign-out writes a new one.
    console.warn(`kitshn ignores a broken sign_out_left row: ${String(error)}`);
    return null;
  }
}

/** K-110: ends the sessions of every application that kitshn made. It never touches other applications. */
export async function signOutEverywhere(
  store: AccessStore,
  api: Api,
  accountId: string,
  /** Applications that the bootstrap made, such as the page and file logins (K-1004). */
  loginApps: ReadonlyArray<{ readonly key: string; readonly cfId: string }> = [],
): Promise<SignOutOutcome> {
  return revokeSessions(api, accountId, sessionApps(store, loginApps));
}

/** K-110: every application that kitshn made, with the login applications of the bootstrap. */
export function sessionApps(
  store: AccessStore,
  loginApps: ReadonlyArray<{ readonly key: string; readonly cfId: string }>,
): Array<{ readonly key: string; readonly cfId: string }> {
  return [
    ...[...store.rows.values()]
      .filter((row) => row.key.startsWith("app:") && row.cfId)
      .map(({ key, cfId }) => ({ key, cfId })),
    ...loginApps,
  ];
}

/** K-110: `revoke_tokens` for each application, at most one run of calls; the rest stay in `left`. */
export async function revokeSessions(
  api: Api,
  accountId: string,
  apps: ReadonlyArray<{ readonly key: string; readonly cfId: string }>,
): Promise<SignOutOutcome> {
  let ended = 0;
  const left: Array<LeftApp> = [];
  for (const [index, app] of apps.entries()) {
    if (index >= CALLS_PER_RUN) {
      left.push({ key: app.key, cfId: app.cfId, reason: "the call limit of one request" });
      continue;
    }
    try {
      await api("POST", `/accounts/${accountId}/access/apps/${app.cfId}/revoke_tokens`);
      ended++;
    } catch (error) {
      // An application that is gone has no sessions left.
      if (isNotFound(error)) ended++;
      else left.push({ key: app.key, cfId: app.cfId, reason: message(error) });
    }
  }
  return { ended, left };
}

const applications = (count: number) => `${count} application${count === 1 ? "" : "s"}`;

/**
 * K-110: the applications that a retry revokes: those still left that kitshn still has, with their current
 * id, so a removed application drops out and a re-created one gets its new id.
 */
export function retryApps(
  left: ReadonlyArray<LeftApp>,
  current: ReadonlyArray<{ readonly key: string; readonly cfId: string }>,
): Array<{ readonly key: string; readonly cfId: string }> {
  const keys = new Set(left.map((app) => app.key));
  return current.filter((app) => keys.has(app.key));
}

/** K-110: the History entry of one sign-out or retry. */
export function signOutSummary(outcome: SignOutOutcome, retry: boolean): string {
  const what = retry ? "Retry of sign-out everywhere" : "Sign-out everywhere";
  if ("listFailed" in outcome)
    return `${what} failed: kitshn could not list the Access applications (${outcome.listFailed})`;
  const ended = `${what} ended the sessions of ${applications(outcome.ended)}`;
  return outcome.left.length === 0
    ? ended
    : `${ended} and failed for: ${outcome.left.map((app) => app.key).join(", ")}`;
}

/** K-110: the Access warning while sessions are left, or null when every session ended. */
export function signOutWarning(outcome: SignOutOutcome | null): string | null {
  if (!outcome) return null;
  if ("listFailed" in outcome)
    return `Sign out everywhere ended no Access session: kitshn could not list the applications (${outcome.listFailed}). Retry starts it again.`;
  if (outcome.left.length === 0) return null;
  const apps = outcome.left.map((app) => `${app.key} (${app.reason})`).join("; ");
  return `Sign out everywhere did not end the sessions of ${applications(outcome.left.length)}: ${apps}. Retry revokes them again.`;
}

/**
 * K-408 for the passkey check (K-103): the policy lists carry no MFA settings, so this reads each policy
 * that needs a passkey once a day and marks it when someone changed its MFA settings. It reads at most
 * `budget` policies a day, which covers 10 passkey circles, or 5 that also hold pages or files (their passkey
 * login copy needs a read too); revisit when an owner has more.
 */
export async function verifyPasskeys(
  store: AccessStore,
  api: Api,
  accountId: string,
  budget: number,
): Promise<number> {
  let calls = 0;
  for (const row of store.rows.values()) {
    if (calls >= budget) break;
    if (!row.key.startsWith("policy:") || !row.cfId || !row.body) continue;
    const ours = (
      JSON.parse(row.body) as {
        mfa_config?: { allowed_authenticators: Array<string>; session_duration: string };
      }
    ).mfa_config;
    if (!ours) continue;
    calls++;
    const live = await api<{
      mfa_config?: {
        allowed_authenticators?: Array<string>;
        session_duration?: string;
        mfa_disabled?: boolean;
      } | null;
    }>("GET", `/accounts/${accountId}/access/policies/${row.cfId}`);
    const same =
      live.mfa_config?.mfa_disabled !== true &&
      deepEqual(
        [...(live.mfa_config?.allowed_authenticators ?? [])].sort(),
        [...ours.allowed_authenticators].sort(),
      ) &&
      live.mfa_config?.session_duration === ours.session_duration;
    if (!same) store.put({ ...row, body: JSON.stringify(live), tried: "", error: null });
  }
  return calls;
}

/**
 * K-403, K-603: whether the application that Cloudflare last accepted has a Bypass policy. Null when
 * kitshn does not know: the accepted body of the application, or of one of its policies, is unknown
 * (after an unclear answer, K-408) and no known policy is Bypass.
 */
export function appliesBypass(app: AccessRow, rows: ReadonlyMap<string, AccessRow>): boolean | null {
  if (app.body === "") return null;
  const policies = [...rows.values()].filter((row) => row.key.startsWith("policy:"));
  let unknown = false;
  for (const id of policyIds(app.body)) {
    const policy = policies.find((row) => row.cfId === id);
    if (!policy?.body) unknown = true;
    else if ((JSON.parse(policy.body) as { decision?: string }).decision === "bypass") return true;
  }
  return unknown ? null : false;
}

/** The application rows that have a Cloudflare id but no audience tag yet (K-603). */
export const rowsWithoutAud = (rows: ReadonlyMap<string, AccessRow>) =>
  [...rows.values()].filter((row) => row.key.startsWith("app:") && row.cfId !== "" && row.aud === "");

/**
 * K-603: reads the audience tag of each application row that has an id but no tag, from the list of
 * applications, matched by id. An id that the full list does not have was deleted in Cloudflare: the row
 * forgets it, as the daily compare does (K-408), so the next sync makes the application again. Returns
 * the number of calls. An account has at most 500 applications (K-402), so this is one call; the loop
 * reads further pages only if that limit grows.
 */
export async function fillAudiences(store: AccessStore, api: Api, accountId: string): Promise<number> {
  const missing = rowsWithoutAud(store.rows);
  if (missing.length === 0) return 0;
  const auds = new Map<string, string>();
  let calls = 0;
  // The loop ends only after a short page, so `auds` holds every application of the account.
  for (let page = 1; ; page++) {
    const apps = await api<ReadonlyArray<Named>>(
      "GET",
      `/accounts/${accountId}/access/apps?per_page=${PAGE}&page=${page}`,
    );
    calls++;
    for (const app of apps) auds.set(app.id, app.aud ?? "");
    if (apps.length < PAGE) break;
  }
  for (const { key, cfId } of missing) {
    // The row as it is now: the calls above wait, and a sync may have changed it meanwhile.
    const row = store.rows.get(key);
    if (!row || row.cfId !== cfId || row.aud) continue;
    const aud = auds.get(cfId);
    if (aud === undefined) store.put({ ...row, cfId: "", aud: "", body: "", tried: "", error: null });
    else if (aud) store.put({ ...row, aud });
  }
  return calls;
}

/**
 * K-406: brings Access to the desired state in at most `budget` calls. Returns true when no work is left.
 * It adopts an object that it did not record only when its name starts with "kitshn " (K-408).
 */
export async function syncAccess(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
  budget = CALLS_PER_RUN,
  reachable: ReadonlySet<string> = new Set(),
  held: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  let calls = 0;
  const spend = () => calls++ < budget;
  const base = `/accounts/${accountId}/access`;
  let existingPolicies: ReadonlyArray<Named> | null = null;
  let existingApps: ReadonlyArray<Named> | null = null;
  // K-409: the session ends that run while the sync goes on; the sync waits for them before it returns.
  const revoking: Array<Promise<void>> = [];

  const write = async (
    key: string,
    kind: "policies" | "apps",
    body: string,
    find: (list: ReadonlyArray<Named>) => Named | undefined,
  ) => {
    const row = store.rows.get(key);
    if (kind === "policies" && isHeld(row, held)) return true;
    if (row?.body === body || failedWith(row, body)) return true;
    let cfId = row?.cfId ?? "";
    try {
      if (!cfId) {
        if (kind === "policies" && !existingPolicies) {
          if (!spend()) return false;
          existingPolicies = await api<ReadonlyArray<Named>>("GET", `${base}/policies?per_page=1000`);
        }
        if (kind === "apps" && !existingApps) {
          if (!spend()) return false;
          existingApps = await api<ReadonlyArray<Named>>("GET", `${base}/apps?per_page=1000`);
        }
        const found = find((kind === "policies" ? existingPolicies : existingApps) ?? []);
        // Never adopt an object that another row holds: one Cloudflare object belongs to one row (K-408).
        const taken = new Set([...store.rows.values()].map((item) => item.cfId));
        cfId = found && found.name.startsWith(ACCESS_NAME_PREFIX) && !taken.has(found.id) ? found.id : "";
      }
      // K-408: the body of the object is unknown (after an unclear answer): read it back. When
      // Cloudflare serves the wanted body, the row takes it and nothing is written; else the wanted body is written.
      // kitshn never adopts what Cloudflare serves as the wanted body.
      let live: unknown = null;
      if (cfId && row !== undefined && row.body === "") {
        if (!spend()) return false;
        live = await api<unknown>("GET", `${base}/${kind}/${cfId}`);
        if (serves(live, body)) {
          const aud = kind === "apps" ? String((live as { aud?: unknown }).aud ?? row.aud) : "";
          store.put({ key, cfId, aud, body, tried: body, error: null });
          return true;
        }
      }
      if (!spend()) return false;
      const request: unknown = JSON.parse(body);
      const result = cfId
        ? await api<Named>("PUT", `${base}/${kind}/${cfId}`, request)
        : await api<Named>("POST", `${base}/${kind}`, request);
      // A missing tag is read again from the list of applications (K-603).
      const aud = kind === "apps" ? (result.aud ?? "") : "";
      // K-409: a removed share, or a person out of a circle, takes effect at once, so the sessions of each application
      // that loses access end. Until every revoke succeeds, the row keeps the old body (what Cloudflare served, read back
      // when unknown), so the next run writes and revokes again. A create that landed after an unclear answer is read
      // back too. Page and file logins need no revoke: the Worker checks the shares on each request (K-404).
      const before = live !== null ? JSON.stringify(live) : (row?.body ?? "");
      const known = row !== undefined && (row.cfId !== "" || live !== null) && before !== "";
      // K-615: removing a machine deletes its service token, which already ends its access, so the `/op` policy ends no
      // session of the admin application.
      const ending = !known
        ? []
        : kind === "apps"
          ? removesPolicy(before, body, store.rows.get(OP_TOKENS_POLICY)?.cfId)
            ? [result.id]
            : []
          : key !== OP_TOKENS_POLICY && narrowsPolicy(before, body)
            ? appsUsing(store.rows, result.id)
            : [];
      // Sessions that an earlier run of this same write already ended (`tried` is this body).
      const ended = row?.tried === body ? (row.ended ?? []) : [];
      const left = ending.filter((appId) => !ended.includes(appId));
      if (left.length > 0) {
        // K-406: each revoke counts before it starts. They run together, while the run goes on (K-409); what does not
        // fit in this run's budget waits for the next run.
        const now = left.slice(0, Math.max(0, budget - calls));
        calls += now.length;
        const id = result.id;
        // Later writes of this run see the new id; the old body stays until every session ended.
        store.put({ key, cfId: id, aud, body: before, tried: body, error: null, ended });
        revoking.push(
          Promise.allSettled(now.map((appId) => api("POST", `${base}/apps/${appId}/revoke_tokens`))).then(
            (results) => {
              // An application that is gone has no sessions left.
              const done = [
                ...ended,
                ...now.filter((_, index) => {
                  const result = results[index];
                  return result?.status === "fulfilled" || isNotFound(result?.reason);
                }),
              ];
              const failed = results.find(
                (item): item is PromiseRejectedResult =>
                  item.status === "rejected" && !isNotFound(item.reason),
              );
              const waiting = { key, cfId: id, aud, body: before, tried: body, ended: done };
              store.put(
                failed
                  ? {
                      ...waiting,
                      error: `sessions not ended: ${message(failed.reason)}`,
                      ...backoff(row, Date.now()),
                    }
                  : done.length < ended.length + left.length
                    ? { ...waiting, error: null }
                    : { key, cfId: id, aud, body, tried: body, error: null },
              );
            },
          ),
        );
        return now.length === left.length;
      }
      store.put({ key, cfId: result.id, aud, body, tried: body, error: null });
    } catch (error) {
      // Someone deleted the object: forget its id, so the next run creates it again.
      if (isNotFound(error) && cfId) store.put({ key, cfId: "", aud: "", body: "", tried: "", error: null });
      else {
        const aud = cfId === row?.cfId ? row.aud : "";
        if (unclearAnswer(error))
          // K-408: the write may or may not have landed, so the body of the object is unknown, and the next run
          // writes the wanted body, whatever it is then.
          store.put({
            key,
            cfId,
            aud,
            body: "",
            tried: "",
            error: message(error),
            ...backoff(row, Date.now()),
          });
        else {
          const failed: AccessRow = {
            key,
            cfId,
            aud,
            body: row?.body ?? "",
            tried: body,
            error: message(error),
          };
          store.put(lowers(failed, body) ? { ...failed, ...backoff(row, Date.now()) } : failed);
        }
      }
    }
    return true;
  };

  try {
    return await syncObjects();
  } finally {
    await Promise.all(revoking);
  }

  async function syncObjects() {
    for (const [key, policy] of desired.policies) {
      const found = (list: ReadonlyArray<Named>) => list.find((item) => item.name === policy.name);
      if (!(await write(key, "policies", policyBody(policy), found))) return false;
    }
    for (const [key, app] of desired.apps) {
      const body = appBody(key, app, store.rows);
      if (body === null) continue;
      const found = (list: ReadonlyArray<Named>) => list.find((item) => item.domain === app.domain);
      if (!(await write(key, "apps", body, found))) return false;
    }
    const kept = withHeld(keptPolicies(desired, store.rows, reachable), held);
    const stale = [...store.rows.values()].filter((row) => isStale(desired, row, reachable, kept));
    // Applications first: Access refuses to delete a policy that an application still uses.
    stale.sort((a, b) => Number(a.key.startsWith("policy:")) - Number(b.key.startsWith("policy:")));
    for (const row of stale) {
      // A row without an object, or one whose object another row now holds, goes without a call.
      const shared = [...store.rows.values()].some((item) => item.key !== row.key && item.cfId === row.cfId);
      if (!row.cfId || shared) {
        store.remove(row.key);
        continue;
      }
      if (!spend()) return false;
      const kind = row.key.startsWith("policy:") ? "policies" : "apps";
      try {
        await api("DELETE", `${base}/${kind}/${row.cfId}`);
        store.remove(row.key);
      } catch (error) {
        if (isNotFound(error)) store.remove(row.key);
        else {
          const { retryAt: _, ...failed } = row;
          // An unclear answer, or the delete of an application, which lowers access, tries again in five minutes.
          store.put(
            unclearAnswer(error) || row.key.startsWith("app:")
              ? { ...failed, tried: "", error: message(error), ...backoff(row, Date.now()) }
              : { ...failed, tried: "", error: message(error) },
          );
        }
      }
    }
    return true;
  }
}

interface LauncherApp {
  readonly id: string;
  readonly type?: string;
  readonly policies?: ReadonlyArray<{ readonly id: string; readonly precedence?: number }>;
  readonly [field: string]: unknown;
}

/** Fields that Cloudflare sets itself; a PUT of the App Launcher sends the rest back unchanged. */
const READ_ONLY = new Set(["id", "uid", "aud", "created_at", "updated_at", "policies"]);

/**
 * K-113: adds the passkey enrollment policy to the App Launcher application, next to the policies that
 * are already there, and takes back only the one that kitshn attached before. `attached` is the policy id
 * that kitshn last attached; the result is the new one. It calls Cloudflare only when the wanted id
 * differs from `attached`, or when `force` is set (the daily compare of K-408).
 */
export async function syncLauncher(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
  attached: string | null,
  force: boolean,
): Promise<{ readonly attached: string | null; readonly calls: number }> {
  const want = desired.policies.has(ENROLLMENT_KEY) ? store.rows.get(ENROLLMENT_KEY)?.cfId || null : null;
  if (!force && want === attached) return { attached, calls: 0 };
  const base = `/accounts/${accountId}/access/apps`;
  const apps = await api<ReadonlyArray<LauncherApp>>("GET", `${base}?per_page=${PAGE}`);
  const found = apps.find((app) => app.type === "app_launcher");
  if (!found) throw new Error("The account has no App Launcher application, so nobody can enroll a passkey.");
  const launcher = await api<LauncherApp>("GET", `${base}/${found.id}`);
  // Other policies keep their own precedence; the kitshn policy goes after all of them.
  const live = (launcher.policies ?? []).map((policy, index) => ({
    id: policy.id,
    precedence: policy.precedence ?? index + 1,
  }));
  const next = live.filter((policy) => policy.id === want || policy.id !== attached);
  if (want && !next.some((policy) => policy.id === want))
    next.push({ id: want, precedence: Math.max(0, ...next.map((policy) => policy.precedence)) + 1 });
  if (deepEqual(next, live)) return { attached: want, calls: 2 };
  const body = Object.fromEntries(Object.entries(launcher).filter(([field]) => !READ_ONLY.has(field)));
  await api("PUT", `${base}/${found.id}`, { ...body, policies: next });
  return { attached: want, calls: 3 };
}

/** The bootstrap's policy that lets every service token log in (K-1204); it is always on `/login`. */
export const MACHINES_POLICY_NAME = `${ACCESS_NAME_PREFIX}machines`;

/** Policies that let anyone log in, which older bootstraps made (K-1004). kitshn deletes them once unused. */
export const OLD_LOGIN_POLICY_NAMES: ReadonlySet<string> = new Set([
  `${ACCESS_NAME_PREFIX}any login`,
  `${ACCESS_NAME_PREFIX}any login (passkey)`,
]);

/** K-1004: the most Cloudflare calls of one `syncLogins`: two lists, four applications, two old policies. */
export const LOGIN_CALLS = 8;

/**
 * K-1004: the policy ids that the login applications should have. A policy goes on only when Cloudflare
 * holds the body that kitshn wants now, so a policy that still lacks a new passkey check never does.
 */
export function loginWant(desired: DesiredAccess, rows: ReadonlyMap<string, AccessRow>): string {
  const ids = (keys: ReadonlyArray<string>) =>
    keys.flatMap((key) => {
      const row = rows.get(key);
      const policy = desired.policies.get(key);
      return row?.cfId && policy && row.body === policyBody(policy) ? [row.cfId] : [];
    });
  return JSON.stringify({
    login: ids(desired.logins.login),
    passkey: ids(desired.logins.passkey),
    page: desired.loginPage,
  });
}

/** K-1004: the policy ids in a `loginWant`, which the login applications hold once it is applied. */
export function loginHeld(attached: string): Set<string> {
  if (!attached) return new Set();
  const ids = JSON.parse(attached) as { login: Array<string>; passkey: Array<string> };
  return new Set([...ids.login, ...ids.passkey]);
}

/**
 * K-1004: the `loginWant` of what the login applications may hold after a login step: its own ids when it
 * worked, and the earlier and its own ids together when some write failed, since some apps may hold each.
 */
export function loginHeldAfter(previous: string, want: string, ok: boolean): string {
  if (ok || !previous) return want;
  const before = JSON.parse(previous) as { login: Array<string>; passkey: Array<string> };
  const after = JSON.parse(want) as { login: Array<string>; passkey: Array<string> };
  return JSON.stringify({
    login: [...new Set([...before.login, ...after.login])],
    passkey: [...new Set([...before.passkey, ...after.passkey])],
  });
}

/** K-1004: a login policy that Cloudflare refused, so the map shows why some people cannot log in. */
export function loginWarnings(desired: DesiredAccess, rows: ReadonlyMap<string, AccessRow>): Array<string> {
  const keys = new Set([...desired.logins.login, ...desired.logins.passkey]);
  return [...keys].flatMap((key) => {
    const error = rows.get(key)?.error;
    const name = desired.policies.get(key)?.name ?? key;
    return error ? [`The login policy "${name}" of pages and files failed: ${error}`] : [];
  });
}

/**
 * K-406, K-1004: the login step runs first and inside the budget, so the sync never deletes a policy that
 * a login application still uses, and both together never pass the budget. Returns the login calls.
 */
export async function syncWithLogins(
  budget: number,
  loginWork: boolean,
  logins: () => Promise<number>,
  access: (budget: number) => Promise<boolean>,
): Promise<number> {
  // Without room for the whole login step it waits for the next alarm, which runs at once.
  const spent = loginWork && budget >= LOGIN_CALLS ? await logins() : 0;
  await access(Math.max(0, budget - spent));
  return spent;
}

/**
 * K-1004: gives the four login applications of pages and files, which the bootstrap made, the policies of
 * the circles that may log in, and the machines policy on `/login`. It drops every other policy, then
 * deletes the old policies that let anyone log in once no application uses them. `attached` is the
 * `loginWant` that kitshn last applied; it calls Cloudflare only when that differs, or when `force` is set
 * (the daily compare of K-408). Each application is written on its own; the errors are thrown together.
 */
export async function syncLogins(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
  zone: string,
  attached: string,
  force: boolean,
): Promise<{ readonly attached: string; readonly calls: number }> {
  const want = loginWant(desired, store.rows);
  if (!force && want === attached) return { attached, calls: 0 };
  const ids = JSON.parse(want) as { login: Array<string>; passkey: Array<string> };
  const base = `/accounts/${accountId}/access`;
  const apps = await api<ReadonlyArray<LauncherApp>>("GET", `${base}/apps?per_page=${PAGE}`);
  const policies = await api<ReadonlyArray<Named>>("GET", `${base}/policies?per_page=${PAGE}`);
  let calls = 2;
  const errors: Array<string> = [];
  const machines = policies.find((policy) => policy.name === MACHINES_POLICY_NAME)?.id;
  if (!machines) errors.push(`no policy "${MACHINES_POLICY_NAME}"; run the bootstrap again`);
  // The policy ids of each application after this run, to know which old policies are free to delete.
  const uses = new Map(apps.map((app) => [app.id, (app.policies ?? []).map((policy) => policy.id)]));
  for (const host of [`pages.${zone}`, `files.${zone}`]) {
    for (const [path, wanted] of [
      ["/login", machines ? [machines, ...ids.login] : null],
      ["/login/passkey", ids.passkey],
    ] as const) {
      const domain = `${host}${path}`;
      // Without the machines policy a write would end service-token logins, so `/login` waits (error above).
      if (wanted === null) continue;
      const app = apps.find(
        (item) =>
          item["domain"] === domain &&
          typeof item["name"] === "string" &&
          item["name"].startsWith(ACCESS_NAME_PREFIX),
      );
      if (!app) {
        errors.push(`no kitshn login application on ${domain}; run the bootstrap again`);
        continue;
      }
      const live = [...(app.policies ?? [])].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
      // K-1130: the kitshn sign-in page, so a page or file login is never the bare Cloudflare one.
      const pages = desired.loginPage === null ? undefined : [desired.loginPage];
      if (
        deepEqual(
          wanted,
          live.map((policy) => policy.id),
        ) &&
        (pages === undefined || deepEqual(app["custom_pages"] ?? [], pages))
      )
        continue;
      calls++;
      try {
        // The list holds whole applications, so like the App Launcher every other field goes back unchanged.
        // Checked on 2026-10-27: Access accepts this PUT without scim_config.
        const body = Object.fromEntries(
          Object.entries(app).filter(([field]) => !READ_ONLY.has(field) && field !== "scim_config"),
        );
        await api("PUT", `${base}/apps/${app.id}`, {
          ...body,
          policies: wanted.map((id, index) => ({ id, precedence: index + 1 })),
          ...(pages === undefined ? {} : { custom_pages: pages }),
        });
        uses.set(app.id, wanted);
      } catch (error) {
        errors.push(`${domain}: ${message(error)}`);
      }
    }
  }
  const used = new Set([...uses.values()].flat());
  for (const policy of policies) {
    if (!OLD_LOGIN_POLICY_NAMES.has(policy.name) || used.has(policy.id)) continue;
    // The rest goes at the next daily run.
    if (calls >= LOGIN_CALLS) break;
    calls++;
    try {
      await api("DELETE", `${base}/policies/${policy.id}`);
    } catch (error) {
      if (!isNotFound(error)) errors.push(`deleting the policy "${policy.name}": ${message(error)}`);
    }
  }
  if (errors.length > 0)
    throw new Error(`kitshn could not update the page and file logins: ${errors.join("; ")}`);
  return { attached: want, calls };
}
