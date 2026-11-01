// K-1777: every owner action is one operation. The map, the CLI and an agent call the same id, and one gate decides.
import { EFFECT_DEFAULTS, type Effect, type Operation, isPersonGate } from "kitshn/operations";
import type { RightMode } from "./model.ts";
import type { Snapshot } from "./protocol.ts";

export {
  type Effect,
  type Gate,
  type OpGroup,
  type OpId,
  type Operation,
  type PersonGate,
  type ScopeGate,
  type Scope,
  type SecretOpId,
  EFFECTS,
  EFFECT_DEFAULTS,
  OPERATIONS,
  OP_IDS,
  isOpId,
  isPersonGate,
  isSecretOp,
  opRequest,
  opsText,
  shownOp,
} from "kitshn/operations";

export type Decision =
  | { readonly outcome: "run" }
  | { readonly outcome: "ask"; readonly circleId: string }
  | { readonly outcome: "refuse"; readonly reason: string };

export interface GateInput {
  /** The caller holds the admin card (K-104) as the owner, so every effect is "automatic". */
  readonly admin: boolean;
  readonly paused: boolean;
  /** The caller's mode of the row's effect: null when no chip sets it. */
  readonly mode: RightMode | null;
  /** K-1778: the caller's mode of "shares", which decides a target out of scope. */
  readonly shares: RightMode | null;
  /** The caller is in at least one agent circle (K-1730), so the defaults of `EFFECT_DEFAULTS` count. */
  readonly inAgentCircle: boolean;
  /** The scope of the row holds for this target. */
  readonly scope: boolean;
  /** An approval of exactly this call is open (K-1714). It waives the scope and the mode, but not "off". */
  readonly approved: boolean;
}

/**
 * K-1777: the one decision of every call. A call runs, waits for a circle, or refuses. It refuses for a person gate,
 * the pause, and an effect that is "off". A target out of scope reaches beyond the caller's circles, so the caller's
 * "shares" decides it (K-1778). Else the mode of the row's effect decides, and an unset mode takes its default.
 */
export function decide(op: Operation, input: GateInput, ownerCircleId: string): Decision {
  if (isPersonGate(op.gate))
    return { outcome: "refuse", reason: `Only a person can do this: ${op.gate.person}.` };
  if (input.admin) return { outcome: "run" };
  if (input.paused)
    return { outcome: "refuse", reason: "kitshn is paused, so agents wait until Resume (K-1504)." };
  // "off" wins over an approval that the owner gave before they set it (K-1776). A default "off" counts too, so a
  // target out of scope never gets a secret by "shares" alone.
  if (input.mode?.mode === "off") return offDecision(op.effect);
  if (input.mode === null && EFFECT_DEFAULTS[op.effect] === "off")
    return byMode(op.effect, null, false, ownerCircleId);
  // A target out of scope needs "shares"; "off" there refuses also an approval of this call.
  if (!input.scope && input.shares?.mode === "off") return offDecision("shares");
  if (input.approved) return { outcome: "run" };
  if (!input.scope) return byMode("shares", input.shares, input.inAgentCircle, ownerCircleId);
  return byMode(op.effect, input.mode, input.inAgentCircle, ownerCircleId);
}

/** K-1720, K-1730: a set mode decides; an unset mode takes the default of the effect. */
function byMode(
  effect: Effect,
  mode: RightMode | null,
  inAgentCircle: boolean,
  ownerCircleId: string,
): Decision {
  if (mode?.mode === "automatic") return { outcome: "run" };
  if (mode?.mode === "ask") return { outcome: "ask", circleId: mode.circleId };
  if (mode?.mode === "off") return offDecision(effect);
  switch (effectDefault(effect, inAgentCircle)) {
    case "automatic":
      return { outcome: "run" };
    case "ask the Owner":
      return { outcome: "ask", circleId: ownerCircleId };
    case "off":
      return {
        outcome: "refuse",
        reason: `The effect "${effect}" is off by default (K-1730). Ask the owner to set it for this actor.`,
      };
  }
}

/** K-1730: the default of an effect counts only in an agent circle; outside one, "automatic" asks the Owner. */
export const effectDefault = (effect: Effect, inAgentCircle: boolean) => {
  const mode = EFFECT_DEFAULTS[effect];
  return mode === "automatic" && !inAgentCircle ? "ask the Owner" : mode;
};

const offDecision = (effect: Effect): Decision => ({
  outcome: "refuse",
  reason: `The effect "${effect}" is off for this actor (K-1720). Ask the owner to turn it on.`,
});

/**
 * K-1777, K-208: what an agent reads of the owner snapshot. A new snapshot field needs a decision here, or this does
 * not compile. A hidden field leaves the answer, and `hidden` names it with its reason.
 */
export const AGENT_READ: Record<keyof Snapshot, "same" | { readonly hidden: string }> = {
  accessApps: "same",
  circles: "same",
  actors: "same",
  resources: "same",
  places: "same",
  shareSettings: "same",
  ends: "same",
  stacks: "same",
  revisions: { hidden: "History can quote a shell script that a person typed; use kitshn agent history" },
  access: "same",
  accessWarnings: "same",
  signOutWarning: "same",
  paused: "same",
  repos: "same",
  deployedCards: "same",
  previewCards: "same",
  pullRequests: "same",
  orphanWorkers: "same",
  deployNotes: "same",
  uptime: "same",
  bell: "same",
  icons: { hidden: "icons are images for the map; the CLI has no use for them" },
  previousVersions: "same",
  handoverCards: "same",
  addressHolds: "same",
  progress: "same",
  folderSites: "same",
  redirects: "same",
  pausedBy: "same",
  machines: "same",
  cardSettings: "same",
  providerCommands: "same",
  proposals: "same",
  botRuns: "same",
  githubDefaultWay: "same",
  askEvents: "same",
  linkEvents: "same",
  jobs: { hidden: "job commands and output can hold what a person typed; read your own job with job-read" },
  queuedJobs: { hidden: "job commands can hold what a person typed" },
  backups: "same",
  backupsOff: "same",
  restoreUndo: "same",
  version: "same",
  accessTeam: "same",
  zone: "same",
  me: "same",
  r2Bucket: "same",
  revision: "same",
};

/** K-1777: the snapshot as an agent reads it, and the hidden fields with their reasons. */
export function agentRead(snapshot: Snapshot): {
  readonly snapshot: Partial<Snapshot>;
  readonly hidden: Readonly<Record<string, string>>;
} {
  const shown: Record<string, unknown> = {};
  const hidden: Record<string, string> = {};
  for (const [field, value] of Object.entries(snapshot)) {
    const rule = AGENT_READ[field as keyof Snapshot];
    if (rule === "same") shown[field] = value;
    else hidden[field] = rule?.hidden ?? "kitshn has no read rule for this field";
  }
  return { snapshot: shown as Partial<Snapshot>, hidden };
}
