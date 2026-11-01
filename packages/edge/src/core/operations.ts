// K-1777: every owner action is one operation. The map, the CLI and an agent call the same id, and one gate decides.
import { type Operation, RIGHT_NAMES, type Right, isPersonGate } from "kitshn/operations";
import type { RightMode } from "./model.ts";
import type { Snapshot } from "./protocol.ts";

export {
  type Gate,
  type OpGroup,
  type OpId,
  type Operation,
  type PersonGate,
  type RightGate,
  type Scope,
  type SecretOpId,
  OPERATIONS,
  OP_IDS,
  isOpId,
  isPersonGate,
  isSecretOp,
  opRequest,
  opsText,
  shownOp,
} from "kitshn/operations";

/** K-1777: the rights that start "automatic" for a machine in an agent circle: their commands are closed (Y1, Y2). */
export const AUTOMATIC_BY_DEFAULT: ReadonlySet<Right> = new Set(["maintains", "readsMap"]);

export type Decision =
  | { readonly outcome: "run" }
  | { readonly outcome: "ask"; readonly circleId: string }
  | { readonly outcome: "refuse"; readonly reason: string };

export interface GateInput {
  /** The caller holds the admin card (K-104), so every right is "automatic". */
  readonly admin: boolean;
  readonly paused: boolean;
  /** The caller's mode of the row's right: null when no circle sets it. Unused when the row has no right. */
  readonly mode: RightMode | null;
  /** The caller is in at least one agent circle (K-1730). */
  readonly inAgentCircle: boolean;
  /** The scope of the row holds for this target. */
  readonly scope: boolean;
  /** An approval of exactly this call is open (K-1714). It waives the scope and the mode, but not "off". */
  readonly approved: boolean;
}

/**
 * K-1777: the one decision of every call. A call runs, waits for a circle, or refuses. It refuses only for a person gate,
 * the pause, and a right that is "off": the owner sees the same refusal in the first two, and set the third.
 */
export function decide(op: Operation, input: GateInput, ownerCircleId: string): Decision {
  if (isPersonGate(op.gate))
    return { outcome: "refuse", reason: `Only a person can do this: ${op.gate.person}.` };
  if (input.admin) return { outcome: "run" };
  if (input.paused)
    return { outcome: "refuse", reason: "kitshn is paused, so agents wait until Resume (K-1504)." };
  const { right, scope } = op.gate;
  // "off" wins over an approval that the owner gave before they set it (K-1776).
  if (right !== null && input.mode?.mode === "off")
    return {
      outcome: "refuse",
      reason: `The right "${RIGHT_NAMES[right]}" is off for this machine (K-1720). Ask the owner to turn it on.`,
    };
  if (input.approved) return { outcome: "run" };
  if (!input.scope || scope === "never") return { outcome: "ask", circleId: ownerCircleId };
  if (right === null) return { outcome: "run" };
  if (input.mode?.mode === "automatic") return { outcome: "run" };
  if (input.mode?.mode === "ask") return { outcome: "ask", circleId: input.mode.circleId };
  if (AUTOMATIC_BY_DEFAULT.has(right) && input.inAgentCircle) return { outcome: "run" };
  return { outcome: "ask", circleId: ownerCircleId };
}

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
