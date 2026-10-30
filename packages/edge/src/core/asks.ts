// Section 17: what an ask of an agent on a machine needs, and how kitshn runs it. Pure, for tests.
import {
  type Circle,
  HIGH_RISK_RIGHTS,
  MACHINE_RIGHT_NAMES,
  type MachineRight,
  type RightCondition,
  type RightMode,
} from "./model.ts";
import { FORWARD_HEADERS, type Machine } from "./machine.ts";
import { type Visitor, circleMatches } from "./visitor.ts";

/** K-1711: the actions of an ask. The daemon checks the same list (`@kitshn/local`). */
export const ASK_ACTIONS = [
  "state",
  "apply",
  "organize",
  "publish",
  "allow",
  "deploy",
  "job",
  "job-read",
  "github-token",
  "audience-add",
  "audience-remove",
  "pass",
  "approve",
  "deny",
  "history",
  "backup",
  "restore",
  /** K-722: only an exec start of a daemon makes one; an ask of it is refused. */
  "exec",
] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

/** K-1776: a proposal is for an ask, or for one call that a daemon forwarded (K-1714). */
export type ProposalAction = AskAction | "forward";

export const isAskAction = (value: unknown): value is AskAction =>
  typeof value === "string" && (ASK_ACTIONS as ReadonlyArray<string>).includes(value);

/**
 * K-1711: the right that an action needs. `none` needs no right; `member` needs membership of the approver circle
 * (K-1723); `apply` needs "publishes" only for a move into Everyone, which agentRefusal decides.
 */
export const ASK_RIGHT: Record<AskAction, MachineRight | "none" | "member" | "apply"> = {
  state: "none",
  apply: "apply",
  organize: "apply",
  publish: "apply",
  allow: "addsApps",
  deploy: "deploys",
  job: "runsCommands",
  "job-read": "none",
  "github-token": "readsCode",
  "audience-add": "addsAudiences",
  "audience-remove": "none",
  pass: "getsPasses",
  approve: "member",
  deny: "member",
  history: "none",
  backup: "deploys",
  restore: "restores",
  exec: "runsCommands",
};

/** K-1750: at most 10 labels, each key with a prefix, of `a-z`, `0-9`, `.` and `-`, at most 64 characters. */
export const MAX_LABELS = 10;
const LABEL_KEY_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789.-");

/** K-1750: why these labels are not allowed, or null. */
export function labelProblem(labels: unknown): string | null {
  if (labels === undefined) return null;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return "Labels are an object.";
  const entries = Object.entries(labels);
  if (entries.length > MAX_LABELS) return `An ask has at most ${MAX_LABELS} labels (K-1750).`;
  for (const [key, value] of entries) {
    const keyOk =
      key.length <= 64 &&
      key.includes(".") &&
      !key.startsWith(".") &&
      !key.endsWith(".") &&
      [...key].every((char) => LABEL_KEY_CHARS.has(char));
    if (!keyOk)
      return `The label key "${key.slice(0, 64)}" is not a prefix and a name of a-z, 0-9, . and - (K-1750).`;
    if (typeof value !== "string" || value.length > 256)
      return `The label ${key} has no text value of at most 256 characters (K-1750).`;
  }
  return null;
}

/** K-1711: the agent path, method and body that one ask maps to; the agent keys use the same paths (K-1714). */
export function askRequest(
  action: AskAction,
  target: string,
  body: unknown,
): { readonly method: "GET" | "POST"; readonly path: string; readonly body: unknown } | string {
  const object = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  switch (action) {
    case "state":
      // `{"all": true}` adds the servers and the link events of the machine.
      return {
        method: "GET",
        path: object["all"] === true ? "/agent/state?all=1" : "/agent/state",
        body: null,
      };
    case "apply":
      return { method: "POST", path: "/agent/apply", body: { edits: object["edits"] } };
    case "organize":
      return { method: "POST", path: "/agent/organize", body: {} };
    case "allow":
      return {
        method: "POST",
        path: `/agent/repos/${encodeURIComponent(target)}`,
        body: { state: "allowed" },
      };
    case "deploy":
      return {
        method: "POST",
        path: "/agent/deploy",
        body: { card: target, mode: object["mode"] === "build" ? "build" : "redeploy" },
      };
    case "job":
      // The target names the machine, so the shown target binds the run (K-1722).
      return { method: "POST", path: "/agent/jobs", body: { machineId: target, command: object["command"] } };
    case "job-read":
      return { method: "GET", path: `/agent/jobs/${encodeURIComponent(target)}`, body: null };
    case "publish":
    case "github-token":
    case "audience-add":
    case "audience-remove":
    case "pass":
    case "approve":
    case "deny":
    case "history":
    case "backup":
    case "restore":
    case "exec":
      return `kitshn runs ${action} itself, not through an agent path.`;
  }
}

/**
 * K-1722: what an approver reads before an approval: the action, the target and every field of the body that
 * decides the effect. The proposal stores its hash, and the approval runs exactly the stored body.
 */
export function shownAsk(action: ProposalAction, target: string, body: unknown): string {
  const object = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  switch (action) {
    case "job":
      return `run on ${target}: ${JSON.stringify(object["command"] ?? null)}`;
    case "exec":
      return `run on ${target} as ${String(object["provider"] ?? "the daemon user")}: ${JSON.stringify(object["command"] ?? null)}`;
    case "deploy":
      return `deploy ${target} (${object["mode"] === "build" ? "build" : "redeploy"})`;
    case "apply":
      return `move: ${JSON.stringify(object["edits"] ?? null)}`;
    case "publish":
      return `${object["public"] === false ? "unpublish" : "publish"} ${target}`;
    case "allow":
      return `allow the repo ${target}`;
    case "backup":
      return `back up ${target} now`;
    case "restore":
      return `restore ${target} to the backup run ${JSON.stringify(object["run"] ?? null)}`;
    case "forward": {
      const headers =
        typeof object["headers"] === "object" && object["headers"] !== null ? object["headers"] : {};
      return [
        target,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${String(value)}`),
        String(object["body"] ?? ""),
      ].join("\n");
    }
    default:
      return `${action} ${target} ${JSON.stringify(body ?? null)}`.trim();
  }
}

/** K-1722: the SHA-256 of the shown text, hex. */
export async function shownHash(shown: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(shown)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** K-1722: the longest shown text of a proposal; a longer ask is refused, so each snapshot stays small. */
export const MAX_SHOWN = 4096;

/** K-1722: at most 20 open proposals for each machine; a new ask past it is refused. */
export const MAX_OPEN_PROPOSALS = 20;

/** K-1722: a proposal of an ask that waits for its approver circle. */
export interface Proposal {
  readonly id: string;
  readonly machineId: string;
  readonly action: ProposalAction;
  readonly target: string;
  readonly body: unknown;
  readonly reason: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly right: MachineRight;
  readonly circleId: string;
  /** What the approver reads, and its SHA-256 hex (shownAsk). */
  readonly shown: string;
  readonly shownHash: string;
  readonly state: "pending" | "approved" | "denied" | "expired";
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** K-1724: a proposal expires 24 hours after the ask (K-1607). */
export const PROPOSAL_MS = 24 * 60 * 60_000;

/** K-1723: after an approval of a token or of a forwarded call, the same ask of that machine runs at once for this long. */
export const APPROVED_WINDOW_MS = 60 * 60_000;

/**
 * K-1723: the actions whose answer is a secret. Their approval only opens the window above, and the next ask of the
 * machine gets the secret, so no proposal row ever holds one.
 */
export const WINDOW_ACTIONS: ReadonlySet<AskAction> = new Set(["github-token", "pass"]);

/** K-1727: a machine of this circle approves asks; in a circle that needs a passkey only with "machines may approve". */
export const machinesApprove = (circle: Circle) => !circle.needsPasskey || circle.machinesMayApprove === true;

/**
 * K-1723, K-1727, K-1902: why this visitor may not answer the asks of an approver circle, or null when it may. The
 * answer check and the live list of asks use it, so who sees an ask and who answers it never differ. `machine` says
 * that the visitor is a machine, which answers only where machines approve.
 */
export function answerRefusal(
  circle: Circle | undefined,
  circleId: string,
  visitor: Visitor,
  machines: ReadonlyMap<string, Machine>,
  machine: boolean,
): string | null {
  if (!circle || !circleMatches(circle, visitor, machines))
    return `Only a member of the approver circle ${circle?.name ?? circleId} answers this ask (K-1723).`;
  if (machine && !machinesApprove(circle))
    return `${circle.name} needs a passkey, and "machines may approve" is off, so a machine does not answer its asks (K-1727).`;
  return null;
}

/** K-1717: ask events stay 30 days, at most 5,000, as K-1610. */
export const ASK_EVENT_DAYS = 30;
export const ASK_EVENT_COUNT = 5000;

/**
 * K-1725: the warnings of the rights of one machine. The map shows them and refuses nothing: all configurations are
 * allowed.
 */
export function rightWarnings(
  circles: ReadonlyMap<string, Circle>,
  machineId: string,
  rights: Readonly<Partial<Record<MachineRight, RightMode>>>,
): Array<string> {
  const warnings: Array<string> = [];
  for (const [right, mode] of Object.entries(rights) as Array<[MachineRight, RightMode | undefined]>) {
    if (!mode || mode.mode === "off") continue;
    const name = MACHINE_RIGHT_NAMES[right];
    if (mode.mode === "automatic") {
      if (right === "writesCode" && (mode.conditions ?? []).length === 0)
        warnings.push(
          `"${name}" runs at once with no thread condition, so any process of the machine writes code.`,
        );
      continue;
    }
    const circle = circles.get(mode.circleId);
    if (!circle) {
      warnings.push(`"${name}" asks a circle that is gone, so no one can approve it.`);
      continue;
    }
    const machinesHere =
      machinesApprove(circle) && circle.members.some((member) => member._tag === "machine");
    if (
      machinesApprove(circle) &&
      circle.members.some((member) => member._tag === "machine" && member.machineId === machineId)
    )
      warnings.push(`"${name}" asks ${circle.name}, which holds this machine, so it can approve itself.`);
    if (
      HIGH_RISK_RIGHTS.has(right) &&
      !circle.members.some((member) => member._tag === "email" || member._tag === "domain")
    )
      warnings.push(
        `"${name}" asks ${circle.name}, which has no person, so no person sees it before it runs.`,
      );
    if (machinesHere)
      warnings.push(
        `${circle.name} has machines: their agents read the reason and the labels, which the asking agent writes.`,
      );
    if (machinesHere && circle.needsPasskey)
      warnings.push(
        `${circle.name} needs a passkey, but "machines may approve" is on, so its machines approve with no passkey.`,
      );
  }
  return [...new Set(warnings)];
}

/**
 * K-1725, K-1727: the machines of this circle that it would let approve their own asks, because one of their rights asks
 * this circle. The circle editor warns at once, when the owner adds the machine or sets the rule.
 */
export function selfApprovers(circles: ReadonlyMap<string, Circle>, circle: Circle): Array<string> {
  if (!machinesApprove(circle)) return [];
  return circle.members.flatMap((member) => {
    if (member._tag !== "machine") return [];
    const asks = [...circles.values()].some((other) =>
      (other.id === circle.id ? circle : other).members.some(
        (each) =>
          each._tag === "machine" &&
          each.machineId === member.machineId &&
          Object.values(each.rights ?? {}).some(
            (mode) => mode?.mode === "ask" && mode.circleId === circle.id,
          ),
      ),
    );
    return asks ? [member.machineId] : [];
  });
}

/**
 * K-1754: why the attested labels of an ask fail the conditions of its right, or null. A condition counts only on the
 * prefix of a provider of the machine, because only then the daemon dropped the caller's own labels of it.
 */
export function conditionProblem(
  conditions: ReadonlyArray<RightCondition> | undefined,
  labels: Readonly<Record<string, string>>,
  labelPrefixes: ReadonlyArray<string>,
): string | null {
  for (const condition of conditions ?? []) {
    if (!labelPrefixes.some((prefix) => condition.key.startsWith(prefix)))
      return `The condition on ${condition.key} has no provider on this machine that sets it (K-1754).`;
    const value = labels[condition.key];
    if (value === undefined || !condition.values.includes(value))
      return `The right needs ${condition.key} to be ${condition.values.join(" or ")}, and the ask has ${value === undefined ? "no such verified label" : value} (K-1754).`;
  }
  return null;
}

/** K-1754: conditions as the editor writes them: `key=value,value; key=value`. */
export function parseConditions(text: string): Array<RightCondition> | string {
  const conditions: Array<RightCondition> = [];
  for (const part of text
    .split(";")
    .map((each) => each.trim())
    .filter((each) => each !== "")) {
    const equals = part.indexOf("=");
    if (equals <= 0) return `"${part}" is not key=value.`;
    const key = part.slice(0, equals).trim();
    const values = part
      .slice(equals + 1)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (!key.includes(".") || values.length === 0)
      return `"${part}" needs a prefixed key and at least one value.`;
    conditions.push({ key, values });
  }
  return conditions;
}

export const formatConditions = (conditions: ReadonlyArray<RightCondition> | undefined) =>
  (conditions ?? []).map((condition) => `${condition.key}=${condition.values.join(",")}`).join("; ");

/** K-1776: a forwarded body up to this many characters of text shows in full; a longer one shows its size and hash. */
const SHOWN_BODY = 1000;

/**
 * K-1776: what an approver reads of a forwarded call: the `x-kitshn-` headers, which decide its effect, and the body,
 * as text when it is short, else as its size and SHA-256. The approval binds the hash of exactly this text.
 */
export async function forwardShown(
  target: string,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>,
): Promise<{ readonly shown: string; readonly body: unknown }> {
  const kitshn = Object.fromEntries(
    [...headers.entries()].filter(
      ([key]) =>
        key.startsWith("x-kitshn-") && !(Object.values(FORWARD_HEADERS) as Array<string>).includes(key),
    ),
  );
  let text: string | null = null;
  try {
    text =
      body.length <= SHOWN_BODY
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)
        : null;
  } catch {
    text = null;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const proposalBody = { headers: kitshn, body: text ?? `${body.length} bytes, sha256 ${hex}` };
  return { shown: shownAsk("forward", target, proposalBody), body: proposalBody };
}
