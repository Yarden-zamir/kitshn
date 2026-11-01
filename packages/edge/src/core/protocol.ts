import type { Actor, Item, RevisionKind } from "./changes.ts";
import type { DaemonUpdate } from "./autoUpdate.ts";
import type { Command, Machine, MachineStatus, ProjectVolume, Sample } from "./machine.ts";
import type { ServerReport } from "./sites.ts";
import type { BackupRun, BucketSize } from "./backups.ts";
import type { MachineOs } from "./icons.ts";
import type { MachineFact } from "./facts.ts";
import type { LogLine, TailAnswer } from "./logs.ts";
import type {
  Circle,
  GitHubWay,
  PauseMode,
  Point,
  Resource,
  ShareSetting,
  Stack,
  UndoSource,
} from "./model.ts";
import type { RepoGate } from "./repos.ts";
import type { Proposal } from "./asks.ts";
import type { HealthReport, ProviderCommand } from "@kitshn/local";
import type { ActionProgress } from "./progress.ts";

/** K-1623: a provider card's address that something else serves, that kitshn takes over now, or took over. */
export type AddressHold = "in-use" | "taking" | "taken";

/** K-1717: one ask of an agent on a machine, as History shows it: an event, with no Undo. */
export interface AskEventView {
  readonly id: number;
  readonly at: number;
  readonly machineName: string;
  readonly action: string;
  readonly target: string;
  readonly reason: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly outcome: "done" | "waiting" | "refused" | "not-kitshn";
  /** The reason of a refusal, or the proposal id of a waiting ask. */
  readonly detail: string;
  /** K-1752: the label keys that a provider vouched for; the rest are claims. */
  readonly verified: ReadonlyArray<string>;
}

/** K-1610: one call of a source machine on a target machine, as History shows it: an event, with no Undo. */
export interface LinkEventView {
  readonly id: number;
  readonly at: number;
  readonly source: string;
  readonly target: string;
  readonly kind: "exec" | "tool";
  readonly thread: string | null;
  readonly name: string;
  readonly cwd: string | null;
  readonly outcome: "succeeded" | "refused" | "failed";
  readonly exitCode: number | null;
}

/** K-1722: an open proposal, with the name of the machine that asked, for the Asks list. */
export type ProposalView = Proposal & {
  readonly machineName: string;
  /** K-1752: the label keys that a provider vouched for; the rest are claims. */
  readonly verified: ReadonlyArray<string>;
};

/** K-819: `resourceIds` are the cards that this repo deployed, which the card panel matches. */
export type RepoView = RepoGate & {
  readonly resourceIds: ReadonlyArray<string>;
  /** K-819: the agent key that allowed the repo is gone, so the repo waits; `state` then reads "waiting". */
  readonly keyRemoved: boolean;
  /** K-819: GitHub answered that the repo id no longer exists; the owner can only forget the repo. */
  readonly goneOnGitHub: boolean;
};

/** K-909: the Worker storage of one removed card. `script` is the kept Worker with its Durable Objects. */
export interface OrphanWorker {
  readonly card: string;
  readonly script: string | null;
  readonly kv: ReadonlyArray<string>;
}

/** K-820: why the newest deploy of a card failed, or did not run because an app before it did not deploy. */
export interface DeployNote {
  readonly state: "failed" | "skipped";
  readonly reason: string;
}

export interface RevisionView {
  readonly id: number;
  readonly at: number;
  readonly actor: Actor;
  readonly summary: string;
  readonly undoes: number | null;
  /** K-1509: where a whole-revision Undo came from; null for other revisions and older undos. */
  readonly undoSource: UndoSource | null;
  readonly undoneBy: number | null;
  /** False for a revision that records an action, such as a shell command, and changes nothing. */
  readonly undoable: boolean;
  /** K-1508: for the History filters and the map highlight. */
  readonly kind: RevisionKind;
  readonly items: ReadonlyArray<Item>;
}

/** K-407: whether Cloudflare has the Access state of a card. */
export type AccessState =
  | { readonly state: "applied" }
  | { readonly state: "applying" }
  /** K-407, K-408: Cloudflare gave no clear answer; kitshn tries again at `at`. */
  | { readonly state: "retrying"; readonly error: string; readonly at: number }
  | { readonly state: "failed"; readonly error: string };

export interface Snapshot {
  /** K-402: the Access applications that kitshn made, against the account's limit of 500. */
  readonly accessApps: number;
  readonly circles: ReadonlyArray<Circle>;
  readonly resources: ReadonlyArray<Resource>;
  readonly places: Readonly<Record<string, Point>>;
  readonly shareSettings: Readonly<Record<string, ShareSetting>>;
  /** K-212: the end time of each timed card. */
  readonly ends: Readonly<Record<string, number>>;
  readonly stacks: ReadonlyArray<Stack>;
  readonly revisions: ReadonlyArray<RevisionView>;
  readonly access: Readonly<Record<string, AccessState>>;
  /** K-408: Access applications that kitshn did not make but that cover a kitshn address. */
  readonly accessWarnings: ReadonlyArray<string>;
  /** K-110: sessions that the last sign-out everywhere did not end, with "Retry sign-out"; null when all ended. */
  readonly signOutWarning: string | null;
  readonly paused: PauseMode | null;
  /** K-819: the repos that deployed or wait to deploy, newest first. */
  readonly repos: ReadonlyArray<RepoView>;
  /** K-909: the cards that a deploy made; only these show "Remove app". */
  readonly deployedCards: ReadonlyArray<string>;
  /** K-821: the deployed cards of pull request previews, which have no rollback. */
  readonly previewCards: ReadonlyArray<string>;
  /** K-303: the pull request number of each preview card, by card id. */
  readonly pullRequests: Readonly<Record<string, number>>;
  /** K-909: what removed Worker apps left in Cloudflare: a kept script and KV namespaces, by the removed card. */
  readonly orphanWorkers: ReadonlyArray<OrphanWorker>;
  /** K-820: the cards whose newest deploy failed or did not run, with why. */
  readonly deployNotes: Readonly<Record<string, DeployNote>>;
  /** K-1125: the uptime of each checked card: up or down, and since when. */
  readonly uptime: Readonly<Record<string, { readonly up: boolean; readonly since: number }>>;
  /** K-1905: the open notifications of the caller that are neither muted nor snoozed. */
  readonly bell: number;
  /** K-1113: the cards with a stored icon, each with the hash of its bytes, which versions its address. */
  readonly icons: Readonly<Record<string, string>>;
  /** K-1117: the pages and files that have a previous version to restore. */
  readonly previousVersions: ReadonlyArray<string>;
  /** K-1127: the pages and folder sites that an agent key published, which it can hand over to a repo. */
  readonly handoverCards: ReadonlyArray<string>;
  /** K-1623: provider cards whose address something else serves, that kitshn takes over now, or took over. */
  readonly addressHolds: Readonly<Record<string, AddressHold>>;
  /** K-538: the action of each card that runs, failed and waits for Dismiss, or ended a moment ago. */
  readonly progress: Readonly<Record<string, ActionProgress & { readonly canDismiss: boolean }>>;
  /** K-1123, K-1129: the folder sites that no repo took over; a folder from the owner gives them a new version. */
  readonly folderSites: ReadonlyArray<string>;
  /** K-1128: the redirect addresses of each site card, by card id. */
  readonly redirects: Readonly<Record<string, ReadonlyArray<string>>>;
  /** K-1504: who paused and when, while paused. */
  readonly pausedBy: { readonly actor: Actor; readonly at: number } | null;
  readonly machines: ReadonlyArray<MachineView>;
  /** K-717: the stored card setting values, by card id; a missing value is the default of its setting. */
  readonly cardSettings: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** K-707: the commands of the providers of each machine, by machine id. */
  readonly providerCommands: Readonly<
    Record<
      string,
      ReadonlyArray<{ readonly name: string; readonly commands: ReadonlyArray<ProviderCommand> }>
    >
  >;
  /** K-1722: the asks that wait for an approver circle, oldest first. */
  readonly proposals: ReadonlyArray<ProposalView>;
  /** K-1767: runs of pull requests of the kitshn App that wait for the owner's Deploy. */
  readonly botRuns: ReadonlyArray<{
    readonly repoId: string;
    readonly repo: string;
    readonly pr: number;
    readonly sha: string;
    readonly at: number;
  }>;
  /** K-1760: the GitHub way of an owner with no owner group. */
  readonly githubDefaultWay: GitHubWay;
  /** K-1717: the newest 50 ask events. */
  readonly askEvents: ReadonlyArray<AskEventView>;
  /** K-1610: the newest 50 exec runs and forwarded tool calls between machines. */
  readonly linkEvents: ReadonlyArray<LinkEventView>;
  /** The newest jobs, with their output cut to 4,000 characters. */
  readonly jobs: ReadonlyArray<JobView>;
  /** K-515: the jobs that wait for each machine, from the job table, not from the newest jobs above. */
  readonly queuedJobs: Readonly<Record<string, number>>;
  /** K-1819: the newest backup run of each Compose card that has one. */
  readonly backups: Readonly<Record<string, BackupRun>>;
  /** K-1818: the size of the `kitshn` bucket at the last daily run; null before the first. */
  readonly r2Bucket: BucketSize | null;
  /** K-1815: the Worker has no KITSHN_BACKUP_KEY, so no backup runs until the owner makes one. */
  readonly backupsOff: boolean;
  /** K-1822: the bookmark that undoes the last "Restore kitshn to a time"; null when none ran. */
  readonly restoreUndo: string | null;
  /** K-617: the release of this kitshn; "Update daemon" installs the daemon of this release. */
  readonly version: string;
  /** The Zero Trust team domain; people enroll a passkey at `https://<team>/AddMfaDevice` (K-103). */
  readonly accessTeam: string;
  /** The zone that sites, pages and files live on (K-1111). */
  readonly zone: string;
  readonly me: Actor;
  /** The newest revision in this snapshot; a map shows a held edit until a snapshot reaches it. */
  readonly revision: number;
}

export type ServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  /** One machine changed (status or sample); cheaper than a whole snapshot. */
  | { readonly type: "machine"; readonly view: MachineView }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: true;
      readonly revision: number | null;
      /** K-909: what an undo of an app removal started again, or why it did not. */
      readonly notes: ReadonlyArray<string>;
      /** K-1502: what an undo changed, in History words without its "Undo #n" label; null for an edit. */
      readonly summary: string | null;
    }
  | { readonly type: "result"; readonly requestId: string; readonly ok: false; readonly error: string }
  /** K-1805, K-1807: the answer to a `tail` message. */
  | { readonly type: "tail"; readonly requestId: string; readonly answer: TailAnswer }
  /** K-1805: new lines of a Compose tail of this map. */
  | {
      readonly type: "tailLines";
      readonly tail: string;
      readonly lines: ReadonlyArray<LogLine>;
      readonly skipped: number;
    }
  | { readonly type: "tailEnd"; readonly tail: string; readonly reason: string };

export interface MachineView {
  readonly machine: Machine;
  readonly online: boolean;
  readonly lastSeen: number | null;
  readonly status: MachineStatus | null;
  /** K-635: the labels that kitshn derives from the live status; none while offline. */
  readonly facts: ReadonlyArray<MachineFact>;
  readonly sample: Sample | null;
  /** K-524: the system of the last status, also while offline; null before the first status or for another system. */
  readonly os: MachineOs | null;
  /** K-1708: the last failed challenge since kitshn started, until the next one passes. */
  readonly keyFailure: { readonly at: number; readonly reason: string } | null;
  /** K-909: idle volumes of kitshn apps that have no card; each has its own delete. */
  readonly orphanVolumes: ReadonlyArray<ProjectVolume>;
  /** K-619: the listening ports of the machine while it is online, for the site wizard. */
  readonly servers: ReadonlyArray<ServerReport>;
  /** K-630: the last health check of the machine while it is online. */
  readonly health: HealthReport | null;
  /** K-1608: the pushes of state that the machine has not applied yet; null when its daemon does not report it. */
  readonly queued: number | null;
  /** K-628: the update of its daemon to the release of the Worker; null when no update job of that release exists. */
  readonly update: DaemonUpdate | null;
}

export interface JobView {
  readonly id: number;
  readonly machineId: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly command: Command;
  readonly state: "queued" | "sent" | "done" | "failed" | "expired";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly actor: string;
  readonly exitCode: number | null;
  readonly output: string;
}
