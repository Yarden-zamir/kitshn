// Section 17: what an ask of an agent on a machine needs, and how kitshn runs it. Pure, for tests.
import {
  type Actor,
  type Circle,
  type Directory,
  type Effect,
  HIGH_RISK_EFFECTS,
  type RightCondition,
  type RightMode,
  type State,
  isPerson,
  machineIdOf,
  memberActor,
} from "./model.ts";
import { FORWARD_HEADERS } from "./machine.ts";
import { type Attested, type Visitor, circleMatches } from "./visitor.ts";

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
 * K-1711: the effect of an action. `none` needs none; `member` needs membership of the approver circle (K-1723);
 * `apply` checks the edits with agentRefusal, and an edit that raises access follows "shares" (K-1778).
 */
export const ASK_RIGHT: Record<AskAction, Effect | "none" | "member" | "apply"> = {
  state: "none",
  apply: "apply",
  organize: "apply",
  publish: "apply",
  allow: "runs",
  deploy: "changes",
  job: "runs",
  "job-read": "none",
  "github-token": "reads",
  "audience-add": "shares",
  "audience-remove": "none",
  pass: "shares",
  approve: "member",
  deny: "member",
  history: "none",
  backup: "changes",
  restore: "destroys",
  exec: "runs",
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

/**
 * K-1722: the request headers of a forwarded call that a notification and a push show, because they decide what the
 * call does: its name, address, circle, publish, deploy, and on `/op` what the answer gives (K-1777). No other header.
 */
export const NOTIFIED_HEADERS: ReadonlySet<string> = new Set([
  "x-kitshn-name",
  "x-kitshn-address",
  "x-kitshn-circle",
  "x-kitshn-public",
  "x-kitshn-deploy",
  "gives",
]);

/**
 * K-1722: the text of an ask in a notification and a push: the shown text, where a forwarded call keeps only the
 * headers of NOTIFIED_HEADERS. The Inbox shows the whole shown text.
 */
export function askNotificationText(action: ProposalAction, target: string, body: unknown): string {
  if (action !== "forward") return shownAsk(action, target, body);
  const object = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const headers =
    typeof object["headers"] === "object" && object["headers"] !== null ? object["headers"] : {};
  return shownAsk("forward", target, {
    ...object,
    headers: Object.fromEntries(Object.entries(headers).filter(([key]) => NOTIFIED_HEADERS.has(key))),
  });
}

/** K-1722: the SHA-256 of the shown text, hex. */
export async function shownHash(shown: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(shown)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** K-1722: the longest shown text of a proposal; a longer ask is refused, so each snapshot stays small. */
export const MAX_SHOWN = 4096;

/** K-1722, K-1778: at most 20 open proposals for each credential that asks; a new ask past it is refused. */
export const MAX_OPEN_PROPOSALS = 20;

/** K-1722: a proposal of an ask that waits for its approver circle. */
export interface Proposal {
  readonly id: string;
  /** The machine that asked; empty for a token or a login (K-1778). */
  readonly machineId: string;
  /** K-1778: the credential that asked: `machine/<id>`, `token/<id>` or `login/<email>`. It never approves. */
  readonly credential: string;
  readonly action: ProposalAction;
  readonly target: string;
  readonly body: unknown;
  readonly reason: string | null;
  readonly labels: Readonly<Record<string, string>>;
  /** K-1730: the effect that the ask is for; a target out of scope asks for "shares" (K-1778). */
  readonly right: Effect;
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

/** K-1723: an approval of an ask for these effects needs a passkey proof, because they raise access or hand out secrets. */
export const PASSKEY_EFFECTS: ReadonlySet<Effect> = new Set(["shares", "secrets"]);

/** K-1723: the approve path of an ask; a passkey circle and an ask of a passkey effect go through the passkey check. */
export const approveVia = (circle: Pick<Circle, "needsPasskey"> | undefined, right: Effect) =>
  circle?.needsPasskey === true || PASSKEY_EFFECTS.has(right) ? "passkey" : "login";

/** K-1727: a proof without a passkey answers the asks of this circle; in a passkey circle only with the setting on. */
export const approvesWithoutPasskey = (circle: Circle) =>
  !circle.needsPasskey || circle.approvesWithoutPasskey === true;

/**
 * K-1723, K-1727, K-1902: why this proof may not answer the asks of an approver circle, or null when it may. The answer
 * check and the live list of asks use it, so who sees an ask and who answers it never differ. `withoutPasskey` says that
 * the proof has no passkey (a token or a machine), which answers only where `approvesWithoutPasskey` lets it.
 */
export function answerRefusal(
  circle: Circle | undefined,
  circleId: string,
  visitor: Visitor,
  directory: Directory,
  attested: Attested | null,
  withoutPasskey: boolean,
): string | null {
  if (!circle || !circleMatches(circle, visitor, directory, attested))
    return `Only a member of the approver circle ${circle?.name ?? circleId} answers this ask (K-1723).`;
  if (withoutPasskey && !approvesWithoutPasskey(circle))
    return `${circle.name} needs a passkey, and "approves without passkey" is off, so a token or a machine does not answer its asks (K-1727).`;
  return null;
}

/** K-1717: ask events stay 30 days, at most 5,000, as K-1610. */
export const ASK_EVENT_DAYS = 30;
export const ASK_EVENT_COUNT = 5000;

/** K-1778: whether a member is a person or names nobody: a person actor or a rule other than a network. */
const isPersonMember = (member: Circle["members"][number], directory: Directory) => {
  const actor = memberActor(member, directory);
  return member._tag === "domain" || (actor !== undefined && isPerson(actor));
};

/** K-1778: whether a member is an actor that proves calls without a passkey: a machine, an agent or a script. */
const isAgentMember = (member: Circle["members"][number], directory: Directory) => {
  const actor = memberActor(member, directory);
  return actor !== undefined && !isPerson(actor);
};

/** K-1730: what each effect lets an actor do, in the words of the map. */
export const EFFECT_HELP: Record<Effect, string> = {
  reads: "Reads: the map, logs, History, job output and repo read tokens.",
  maintains:
    "Maintains: closed machine care (restart, update, tunnel restart, diagnostics, order, automatic update), and closing invites and asks.",
  creates:
    "Creates: new cards (apps, pages, sites, ports, repos). They land only in the actor's own circles, so creating never shares.",
  changes:
    "Changes: existing cards in scope: deploys, settings, desired state, repo push tokens and backups.",
  runs: "Runs: shell and exec on machines in scope.",
  destroys:
    "Destroys: anything without Undo: remove an app, restore over data, delete volumes, forget a card.",
  shares:
    "Shares: shares what this actor manages: its cards into a circle or Everyone, audiences and passes. Circles, members, levels, effects and targets out of scope ask the Owner. With Secrets automatic too, it acts as the owner. A person approves an ask of it with a passkey.",
  secrets:
    "Secrets: hands out a secret: invite codes, key reset codes and tokens. A person approves an ask of it with a passkey.",
};

/** K-1725: the effects that the map warns about at "automatic", with what they do with no person. */
const AUTOMATIC_WARNING: Readonly<Partial<Record<Effect, string>>> = {
  shares: `"shares" runs at once: the actor shares what this actor manages, such as its cards into any circle or Everyone, audiences and passes, with no person. Circles, members, levels and effects still ask the Owner.`,
  secrets: `"secrets" alone gives nothing at once: each secret still asks the Owner. With "shares" automatic too, the actor acts as you, the owner.`,
  runs: `"runs" runs at once: the actor runs shell commands on its machines with no person.`,
  destroys: `"destroys" runs at once: the actor removes data that has no Undo with no person.`,
};

/** K-1725: the effects that run a shell, destroy data, raise access or hand out a secret, so their sticker warns. */
export const WARNED_EFFECTS: ReadonlySet<Effect> = new Set(Object.keys(AUTOMATIC_WARNING) as Array<Effect>);

/** K-1778: "shares" and "secrets" automatic together make an actor with control of the admin card the owner (K-104). */
const OWNER_WARNING = `"shares" and "secrets" run at once: where the actor has control of the admin card, it acts as you, the owner, with no person.`;

/** K-1725: the warning of one effect at "automatic", which for "shares" and "secrets" depends on the other one. */
export function automaticWarning(
  effect: Effect,
  rights: Readonly<Partial<Record<Effect, RightMode>>>,
): string | undefined {
  const owner = rights.shares?.mode === "automatic" && rights.secrets?.mode === "automatic";
  return owner && (effect === "shares" || effect === "secrets") ? OWNER_WARNING : AUTOMATIC_WARNING[effect];
}

/**
 * K-1725: the warnings of the effect modes of one actor in a circle. The map shows them and refuses nothing: all configurations
 * are allowed.
 */
export function rightWarnings(
  state: Pick<State, "circles" | "actors" | "machines">,
  actor: Actor,
  rights: Readonly<Partial<Record<Effect, RightMode>>>,
): Array<string> {
  const warnings: Array<string> = [];
  for (const [right, mode] of Object.entries(rights) as Array<[Effect, RightMode | undefined]>) {
    if (!mode || mode.mode === "off") continue;
    const name = right;
    if (mode.mode === "automatic") {
      const warning = automaticWarning(right, rights);
      if (warning !== undefined) warnings.push(warning);
      if (right === "changes" && machineIdOf(actor) !== null && (actor.conditions ?? []).length === 0)
        warnings.push(
          `"changes" runs at once for an actor with no thread condition, so any process of the machine pushes code and deploys.`,
        );
      continue;
    }
    const circle = state.circles.get(mode.circleId);
    if (!circle) {
      warnings.push(`"${name}" asks a circle that is gone, so no one can approve it.`);
      continue;
    }
    const agentsHere =
      approvesWithoutPasskey(circle) && circle.members.some((member) => isAgentMember(member, state));
    // K-1778: the credential that asked never approves, so a circle of this actor alone answers no ask of it.
    if (
      circle.members.length > 0 &&
      circle.members.every((member) => member._tag === "actor" && member.actorId === actor.id)
    )
      warnings.push(
        `"${name}" asks ${circle.name}, which holds only this actor, and an actor never approves its own ask.`,
      );
    if (HIGH_RISK_EFFECTS.has(right) && !circle.members.some((member) => isPersonMember(member, state)))
      warnings.push(
        `"${name}" asks ${circle.name}, which has no person, so no person sees it before it runs.`,
      );
    if (agentsHere)
      warnings.push(
        `${circle.name} has agents: they read the reason and the labels, which the asking agent writes.`,
      );
    if (agentsHere && circle.needsPasskey)
      warnings.push(
        `${circle.name} needs a passkey, but "approves without passkey" is on, so its agents approve with no passkey.`,
      );
  }
  return [...new Set(warnings)];
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
