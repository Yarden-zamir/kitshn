// K-1777: every owner action is one operation. The map, the CLI and an agent call the same id, and one gate decides.
import type { MachineRight, RightMode } from "./model.ts";
import { MACHINE_RIGHT_NAMES } from "./model.ts";
import type { Snapshot } from "./protocol.ts";

/**
 * K-1777: what the target of a call must be for the caller, before a right counts.
 * - `any`: no check.
 * - `card`: a card that the caller controls (K-718).
 * - `own`: a card that the caller added or published.
 * - `machine`: a machine where the caller may run a shell (K-718).
 * - `rule`: the edits pass `agentRefusal` (K-715, K-718).
 * - `never`: nothing passes, so every agent call asks the Owner.
 */
export type Scope = "any" | "card" | "own" | "machine" | "rule" | "never";

/** K-1777: only a person can do it, because only a person has the proof. The reason shows in review and in help. */
export interface PersonGate {
  readonly person: string;
}

export interface RightGate {
  /** The right that lets an agent run it without a person; null when the scope alone decides. */
  readonly right: MachineRight | null;
  readonly scope: Scope;
}

export type Gate = PersonGate | RightGate;

export const isPersonGate = (gate: Gate): gate is PersonGate => "person" in gate;

export type OpGroup =
  "cards" | "circles" | "machines" | "apps" | "library" | "repos" | "passes" | "asks" | "safety" | "account";

export interface Operation {
  readonly group: OpGroup;
  readonly title: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * The owner route. `:target` takes the target of the call, `:<field>` the text of that body field. The gated call
   * runs this route with the owner code (K-1777).
   */
  readonly route: string;
  /** The body field that takes the target, when the owner route reads it from the body. */
  readonly targetField?: string;
  /** Only these fields of the caller's body reach the owner route. Without it, the whole body does. */
  readonly pick?: ReadonlyArray<string>;
  /** Fields that the operation sets over the caller's body. */
  readonly fixed?: Readonly<Record<string, unknown>>;
  readonly gate: Gate;
  /** The answer holds a secret: an approval runs nothing, the same call again within 1 hour gets it (K-1723). */
  readonly secret?: true;
  /** The agent uses this command instead, because the call uploads files or needs the local machine. */
  readonly short?: string;
  /** `/op` does not take this call, because it uploads files or approves with its own proof; `short` does. */
  readonly shortOnly?: true;
}

const job = (title: string, kind: string, right: MachineRight, scope: Scope): Operation => ({
  group: "machines",
  title,
  method: "POST",
  route: "/api/jobs",
  targetField: "machineId",
  pick: [],
  fixed: { command: { kind } },
  gate: { right, scope },
});

const machineField = (title: string, field: string, gate: RightGate): Operation => ({
  group: "machines",
  title,
  method: "POST",
  route: "/api/machines/:target",
  pick: [field],
  gate,
});

const NOTIFICATIONS = "a person's own Inbox: mute, snooze and dismiss change no access (K-1905)";
const PUSH = "a push key belongs to one browser (K-1901)";

/**
 * K-1777: the operations. Each owner route of `kitshn.ts` has a row (`test/parity.test.ts`), and `gate` is required, so
 * an owner action without an agent path does not compile or does not pass the tests.
 */
export const OPERATIONS = {
  // Cards and circles. `apply` carries every map edit: places, shares, levels, stacks, circles, members and the pause.
  apply: {
    group: "circles",
    title: `edit the map: --body '{"edits":[...]}'. Circle and member edits ask the Owner (K-715)`,
    method: "POST",
    route: "/api/apply",
    pick: ["edits"],
    gate: { right: null, scope: "rule" },
  },
  organize: {
    group: "cards",
    title: "tidy the map into a grid, as one Undo (K-532)",
    method: "POST",
    route: "/api/organize",
    gate: { right: null, scope: "never" },
  },
  undo: {
    group: "safety",
    title: `undo one revision: --body '{"revision":<id>}' (K-1506)`,
    method: "POST",
    route: "/api/undo",
    pick: ["revision", "source"],
    gate: { right: null, scope: "never" },
  },
  "undo-item": {
    group: "safety",
    title: `undo the last change of a card or circle: --body '{"item":{"kind":"card","id":"<id>"}}' (K-1507)`,
    method: "POST",
    route: "/api/undo-item",
    pick: ["item"],
    gate: { right: null, scope: "never" },
  },
  "card-setting": {
    group: "cards",
    title: `set a card setting: kitshn card-setting <card> --body '{"setting":"<id>","value":"<value>"}' (K-717)`,
    method: "POST",
    route: "/api/cards/:target/settings",
    gate: { right: null, scope: "card" },
  },
  "card-time": {
    group: "cards",
    title: "set the end time of a card; the short form is kitshn time (K-212)",
    method: "POST",
    route: "/api/cards/:target/time",
    gate: { right: null, scope: "card" },
    short: "kitshn time <card> <30m|1h|4h|1d|stop|now>",
  },
  "card-address": {
    group: "cards",
    title: "give a card a new address name; the short form is kitshn address (K-1120)",
    method: "POST",
    route: "/api/cards/:target/address",
    gate: { right: "addsPages", scope: "own" },
    short: "kitshn address <card> <name>",
  },
  "card-redirect-add": {
    group: "cards",
    title: "add a redirect hostname to a site card; the short form is kitshn redirect (K-1128)",
    method: "POST",
    route: "/api/cards/:target/redirects",
    gate: { right: "addsPages", scope: "card" },
    short: "kitshn redirect <card> <address>",
  },
  "card-redirect-remove": {
    group: "cards",
    title: "remove a redirect hostname of a site card (K-1128)",
    method: "DELETE",
    route: "/api/cards/:target/redirects/:address",
    gate: { right: null, scope: "card" },
    short: "kitshn redirect <card> <address> --remove",
  },
  "card-progress-dismiss": {
    group: "cards",
    title: "dismiss the progress sticker of a card",
    method: "POST",
    route: "/api/cards/:target/progress/dismiss",
    gate: { right: null, scope: "card" },
  },
  "card-take-address": {
    group: "cards",
    title: "take the address of a card for another card (K-1124)",
    method: "POST",
    route: "/api/cards/:target/take-address",
    gate: { right: null, scope: "never" },
  },
  "card-give-address-back": {
    group: "cards",
    title: "give a taken address back (K-1124)",
    method: "POST",
    route: "/api/cards/:target/give-address-back",
    gate: { right: null, scope: "never" },
  },

  // Machines.
  "machine-restart": job("restart the daemon of a machine (K-612)", "restart", "maintains", "any"),
  "machine-update": job("update the daemon to the release of kitshn (K-617)", "update", "maintains", "any"),
  "machine-diagnostics": job(
    "print the version, host, paths and tunnel state",
    "diagnostics",
    "maintains",
    "any",
  ),
  "machine-tunnel-restart": job("restart the tunnel service (K-634)", "tunnel-restart", "maintains", "any"),
  "machine-shell": {
    group: "machines",
    title: `run a shell script: kitshn machine-shell <machine> --body '{"command":{"kind":"shell","script":"..."}}' (K-612)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command", "labels"],
    fixed: { command: { kind: "shell" } },
    gate: { right: "runsCommands", scope: "machine" },
  },
  "machine-provider-command": {
    group: "machines",
    title: `run a command of a provider: --body '{"command":{"kind":"provider",...}}' (K-707)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command"],
    fixed: { command: { kind: "provider" } },
    gate: { right: "runsCommands", scope: "machine" },
  },
  "machine-volume-remove": {
    group: "machines",
    title: `delete an orphaned Compose volume: --body '{"command":{"kind":"compose-volume-remove","volume":"<name>"}}' (K-909)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command"],
    fixed: { command: { kind: "compose-volume-remove" } },
    gate: { right: null, scope: "never" },
  },
  "job-cancel": {
    group: "machines",
    title: "cancel a queued job: kitshn job-cancel <job id>",
    method: "POST",
    route: "/api/jobs/:target/cancel",
    gate: { right: "maintains", scope: "any" },
  },
  "machine-labels": machineField(
    `set the labels of a machine: --body '{"labels":["gpu"]}' (K-610)`,
    "labels",
    { right: "maintains", scope: "any" },
  ),
  "machine-order": machineField(`set the place of a machine in lists: --body '{"order":3}'`, "order", {
    right: "maintains",
    scope: "any",
  }),
  "machine-auto-update": machineField(
    `turn "Update daemon automatically" on or off: --body '{"autoUpdate":false}' (K-626)`,
    "autoUpdate",
    { right: "maintains", scope: "any" },
  ),
  "machine-compose-allow": machineField(
    `allow risky Compose settings on a machine: --body '{"allow":[...]}' (K-818)`,
    "allow",
    { right: null, scope: "never" },
  ),
  "machine-rotate-key": {
    group: "machines",
    title: "replace the key of a machine over its live connection (K-1705)",
    method: "POST",
    route: "/api/machines/:target/rotate-key",
    gate: { right: "maintains", scope: "any" },
  },
  "machine-reset-key": {
    group: "machines",
    title: "drop the key of a machine and get a key code (K-1706)",
    method: "POST",
    route: "/api/machines/:target/reset-key",
    gate: { right: null, scope: "never" },
    secret: true,
  },
  "machine-add": {
    group: "machines",
    title: `add a machine and get its join code: --body '{"name":"<name>"}' (K-602)`,
    method: "POST",
    route: "/api/machines",
    gate: { right: null, scope: "never" },
    secret: true,
  },
  "machine-remove": {
    group: "machines",
    title: "remove a machine (K-615)",
    method: "DELETE",
    route: "/api/machines/:target",
    gate: { right: null, scope: "never" },
  },
  "provider-forget": {
    group: "machines",
    title: `forget a provider of a machine: --body '{"provider":"<name>"}', or one of its cards with "card" (K-704)`,
    method: "POST",
    route: "/api/machines/:target/providers/:provider/forget",
    pick: ["card"],
    gate: { right: null, scope: "never" },
  },
  "health-check": {
    group: "machines",
    title: "check the providers and links of every machine now (K-630)",
    method: "POST",
    route: "/api/health/check",
    gate: { right: "maintains", scope: "any" },
  },
  "site-live-add": {
    group: "machines",
    title: "share a server of a machine as a live site; on its own machine use kitshn expose (K-1131)",
    method: "POST",
    route: "/api/sites/live",
    gate: { right: null, scope: "never" },
    short: "kitshn expose <port|socket> --name <name>",
  },

  // Apps, deploys and backups.
  "app-logs": {
    group: "apps",
    title: "search the logs of a card; the short form is kitshn logs (K-1809)",
    method: "POST",
    route: "/api/apps/:target/logs",
    gate: { right: null, scope: "card" },
    short: "kitshn logs <card> [text]",
  },
  "app-backups": {
    group: "apps",
    title: "list the backup runs of a Compose card (K-1819)",
    method: "GET",
    route: "/api/apps/:target/backups",
    gate: { right: null, scope: "card" },
  },
  "app-backup": {
    group: "apps",
    title: "back up a Compose card now (K-1819)",
    method: "POST",
    route: "/api/apps/:target/backups",
    gate: { right: "deploys", scope: "card" },
  },
  "app-restore": {
    group: "apps",
    title: `write a backup run back: --body '{"run":"<run>"}' (K-1820)`,
    method: "POST",
    route: "/api/apps/:target/backups/:run/restore",
    pick: [],
    gate: { right: "restores", scope: "card" },
  },
  "app-rollbacks": {
    group: "apps",
    title: "list the versions that a card can roll back to (K-913)",
    method: "GET",
    route: "/api/apps/:target/rollbacks",
    gate: { right: null, scope: "card" },
  },
  "app-rollback": {
    group: "apps",
    title: `roll a card back: --body '{"deployId":"<id>"}' (K-913)`,
    method: "POST",
    route: "/api/apps/:target/rollback",
    gate: { right: "deploys", scope: "card" },
  },
  "app-run-rollback-plan": {
    group: "apps",
    title: "show what a roll back of the last run of a card changes",
    method: "GET",
    route: "/api/apps/:target/run-rollback",
    gate: { right: null, scope: "card" },
  },
  "app-run-rollback": {
    group: "apps",
    title: "roll back the last run of a card",
    method: "POST",
    route: "/api/apps/:target/run-rollback",
    gate: { right: "deploys", scope: "card" },
  },
  "app-remove": {
    group: "apps",
    title: "remove an app card that you added (K-909)",
    method: "DELETE",
    route: "/api/apps/:target",
    gate: { right: null, scope: "own" },
  },
  "worker-storage-remove": {
    group: "apps",
    title: "delete the orphaned Worker storage of a card",
    method: "DELETE",
    route: "/api/worker-storage/:target",
    gate: { right: null, scope: "never" },
  },
  "bot-run-deploy": {
    group: "apps",
    title: `deploy a waiting bot pull request: --body '{"repoId":...,"pr":...,"sha":"..."}' (K-1767)`,
    method: "POST",
    route: "/api/bot-runs/deploy",
    // K-1767: a pull request of the kitshn App bot never deploys without a person.
    gate: { right: null, scope: "never" },
  },
  "port-list": {
    group: "apps",
    title: "list the port cards (K-2001)",
    method: "GET",
    route: "/api/ports",
    gate: { right: "readsMap", scope: "any" },
  },
  "port-add": {
    group: "apps",
    title: "add a port card; the short form is kitshn port add (K-2001)",
    method: "POST",
    route: "/api/ports",
    gate: { right: "addsApps", scope: "any" },
    short: "kitshn port add --machine <machine> --name <name> --port <port/proto>",
  },
  "port-remove": {
    group: "apps",
    title: "remove a port card that you added (K-2007)",
    method: "DELETE",
    route: "/api/ports/:target",
    gate: { right: null, scope: "own" },
    short: "kitshn port remove <card>",
  },
  "port-door-close": {
    group: "apps",
    title: `close one door of a port card: --body '{"address":"<address>"}' (K-2007)`,
    method: "DELETE",
    route: "/api/ports/:target/doors/:address",
    gate: { right: null, scope: "card" },
    short: "kitshn port close <card> <address>",
  },
  uptime: {
    group: "apps",
    title: "the uptime changes of a card (K-1125)",
    method: "GET",
    route: "/api/uptime/:target",
    gate: { right: "readsMap", scope: "any" },
  },

  // Library.
  "upload-page": {
    group: "library",
    title: "upload a page (K-1101)",
    method: "POST",
    route: "/api/pages",
    shortOnly: true,
    gate: { right: "addsPages", scope: "any" },
    short: "kitshn publish <file>",
  },
  "upload-file": {
    group: "library",
    title: "upload a file (K-1101)",
    method: "POST",
    route: "/api/files",
    shortOnly: true,
    gate: { right: "addsPages", scope: "any" },
    short: "kitshn publish <file>",
  },
  "upload-site": {
    group: "library",
    title: "upload a folder as a site (K-1123, K-1129)",
    method: "POST",
    route: "/api/sites/:step",
    shortOnly: true,
    gate: { right: "addsPages", scope: "any" },
    short: "kitshn publish <folder>",
  },
  "library-list": {
    group: "library",
    title: "list the pages and files (K-1101)",
    method: "GET",
    route: "/api/library",
    gate: { right: "readsMap", scope: "any" },
  },
  "library-content": {
    group: "library",
    title: "read the content of a page or file that you published",
    method: "GET",
    route: "/api/library/:target/content",
    gate: { right: null, scope: "own" },
  },
  "library-previous": {
    group: "library",
    title: "go back to the previous version of a page, file or folder site (K-1117)",
    method: "POST",
    route: "/api/library/:target/previous",
    gate: { right: "addsPages", scope: "own" },
    short: "kitshn publish --previous <card>",
  },
  "library-delete": {
    group: "library",
    title: "delete a page, file or folder site for good (K-1117)",
    method: "DELETE",
    route: "/api/library/:target",
    gate: { right: null, scope: "own" },
    short: "kitshn unpublish <card>",
  },

  // Circles: devices.
  "device-token-add": {
    group: "circles",
    title: `make a device token and get its secret: --body '{"name":"<name>"}' (K-106)`,
    method: "POST",
    route: "/api/devices",
    gate: { right: null, scope: "never" },
    secret: true,
  },
  "device-invite": {
    group: "circles",
    title: `invite a phone or desktop app: --body '{"name":"<name>"}', or '{"tokenId":"<id>"}' again (K-1601)`,
    method: "POST",
    route: "/api/devices/invites",
    gate: { right: null, scope: "never" },
    secret: true,
  },
  "device-invite-cancel": {
    group: "circles",
    title: "cancel a waiting device invite: kitshn device-invite-cancel <token id> (K-1601)",
    method: "DELETE",
    route: "/api/devices/invites/:target",
    gate: { right: null, scope: "any" },
  },
  "device-list": {
    group: "circles",
    title: "list the device tokens (K-106)",
    method: "GET",
    route: "/api/devices",
    gate: { right: "readsMap", scope: "any" },
  },

  // Repos.
  "repo-allow": {
    group: "repos",
    title: "let a waiting repo deploy (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "allowed" },
    gate: { right: "addsApps", scope: "any" },
  },
  "repo-block": {
    group: "repos",
    title: "block a repo (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "blocked" },
    gate: { right: null, scope: "never" },
  },
  "repo-forget": {
    group: "repos",
    title: "forget a repo, so its next deploy waits again (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "forget" },
    gate: { right: null, scope: "never" },
  },
  "repos-check": {
    group: "repos",
    title: "check the repos on GitHub now",
    method: "POST",
    route: "/api/repos/check",
    gate: { right: "maintains", scope: "any" },
  },
  "repo-group-add": {
    group: "repos",
    title: "add a repo group (K-1733)",
    method: "POST",
    route: "/api/repo-groups",
    gate: { right: null, scope: "never" },
  },
  "repo-group-edit": {
    group: "repos",
    title: "change a repo group or its GitHub way (K-1733, K-1760)",
    method: "POST",
    route: "/api/repo-groups/:target",
    gate: { right: null, scope: "never" },
  },
  "repo-group-remove": {
    group: "repos",
    title: "delete a repo group (K-1733)",
    method: "DELETE",
    route: "/api/repo-groups/:target",
    gate: { right: null, scope: "never" },
  },
  "github-way": {
    group: "repos",
    title: "set the default GitHub way (K-1760)",
    method: "POST",
    route: "/api/settings/github-way",
    gate: { right: null, scope: "never" },
  },

  // Passes.
  passes: {
    group: "passes",
    title: "the pass settings and audiences (K-1773)",
    method: "GET",
    route: "/api/passes",
    gate: { right: "readsMap", scope: "any" },
  },
  "passes-set": {
    group: "passes",
    title: `turn passes on or off: --body '{"on":true}' (K-1770)`,
    method: "POST",
    route: "/api/passes",
    gate: { right: null, scope: "never" },
  },
  "passes-rotate": {
    group: "passes",
    title: "rotate the pass key (K-1771)",
    method: "POST",
    route: "/api/passes/rotate",
    gate: { right: null, scope: "never" },
  },
  "audience-add": {
    group: "passes",
    title: `add a pass audience: --body '{"address":"<address>"}' (K-1773)`,
    method: "POST",
    route: "/api/passes/audiences",
    pick: ["address"],
    fixed: { labels: false },
    gate: { right: "addsAudiences", scope: "any" },
  },
  "audience-labels": {
    group: "passes",
    title: `put attested labels in the passes of an audience: --body '{"address":"<address>","labels":true}' (K-1772)`,
    method: "POST",
    route: "/api/passes/audiences",
    pick: ["address", "labels"],
    gate: { right: null, scope: "never" },
  },
  "audience-remove": {
    group: "passes",
    title: "remove a pass audience (K-1773)",
    method: "DELETE",
    route: "/api/passes/audiences/:target",
    gate: { right: null, scope: "never" },
    short: "kitshn agent audience-remove --audience <address>, for an audience that you added",
  },

  // Asks.
  "proposal-deny": {
    group: "asks",
    title: "deny an open ask of a circle that you are in (K-1723)",
    method: "POST",
    route: "/api/proposals/:target/deny",
    gate: { right: null, scope: "any" },
  },
  approve: {
    group: "asks",
    title: "approve an open ask of a circle that you are in, with your own proof (K-1723, K-1726)",
    method: "POST",
    route: "/api/approve/:via/:target",
    gate: { right: null, scope: "any" },
    short: "kitshn agent approve <proposal id>",
    shortOnly: true,
  },
  "ask-events": {
    group: "asks",
    title: "the ask events of every machine (K-1717)",
    method: "GET",
    route: "/api/ask-events",
    gate: { right: "readsMap", scope: "any" },
  },

  // Safety and account.
  "state-export": {
    group: "safety",
    title: "download the state export (K-1830)",
    method: "GET",
    route: "/api/state/export",
    gate: { right: null, scope: "never" },
  },
  jobs: {
    group: "safety",
    title: "the last 100 jobs with their output",
    method: "GET",
    route: "/api/jobs",
    gate: { right: null, scope: "never" },
  },
  usage: {
    group: "safety",
    title: "the use of the Cloudflare free plan (K-1301)",
    method: "GET",
    route: "/api/usage",
    gate: { right: "readsMap", scope: "any" },
  },
  desired: {
    group: "safety",
    title: "the desired state of one resource kind",
    method: "GET",
    route: "/api/desired/:target",
    gate: { right: null, scope: "never" },
  },
  "desired-set": {
    group: "safety",
    title: "replace the desired state of one resource kind",
    method: "PUT",
    route: "/api/desired/:target",
    gate: { right: null, scope: "never" },
  },
  "sign-out": {
    group: "account",
    title: "sign out everywhere (K-110)",
    method: "POST",
    route: "/api/sign-out",
    gate: { right: null, scope: "never" },
  },
  "sign-out-retry": {
    group: "account",
    title: "retry the sign-out of the applications that are left (K-110)",
    method: "POST",
    route: "/api/sign-out/retry",
    gate: { right: "maintains", scope: "any" },
  },
  resume: {
    group: "safety",
    title: "resume after a pause",
    method: "POST",
    route: "/fresh/resume",
    gate: { person: "Resume needs a fresh passkey (K-1504)" },
  },
  "restore-time": {
    group: "safety",
    title: "restore kitshn to a time",
    method: "POST",
    route: "/fresh/restore-time",
    gate: { person: "a restore to a time needs a fresh passkey (K-1822)" },
  },
  notifications: {
    group: "account",
    title: "the Inbox and its mute, snooze and dismiss",
    method: "POST",
    route: "/api/notifications",
    gate: { person: NOTIFICATIONS },
  },
  push: {
    group: "account",
    title: "the push subscription of a browser",
    method: "POST",
    route: "/api/push",
    gate: { person: PUSH },
  },
} as const satisfies Record<string, Operation>;

export type OpId = keyof typeof OPERATIONS;

export const OP_IDS = Object.keys(OPERATIONS) as ReadonlyArray<OpId>;

export const isOpId = (value: unknown): value is OpId =>
  typeof value === "string" && Object.hasOwn(OPERATIONS, value);

/** K-1777: the rights that start "automatic" for a machine in an agent circle: their commands are closed (Y1, Y2). */
export const AUTOMATIC_BY_DEFAULT: ReadonlySet<MachineRight> = new Set(["maintains", "readsMap"]);

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
  /** An approval of exactly this call is open (K-1714). It waives the right and the scope for this call. */
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
  if (input.approved) return { outcome: "run" };
  const { right, scope } = op.gate;
  if (right !== null && input.mode?.mode === "off")
    return {
      outcome: "refuse",
      reason: `The right "${MACHINE_RIGHT_NAMES[right]}" is off for this machine (K-1720). Ask the owner to turn it on.`,
    };
  if (!input.scope || scope === "never") return { outcome: "ask", circleId: ownerCircleId };
  if (right === null) return { outcome: "run" };
  if (input.mode?.mode === "automatic") return { outcome: "run" };
  if (input.mode?.mode === "ask") return { outcome: "ask", circleId: input.mode.circleId };
  if (AUTOMATIC_BY_DEFAULT.has(right) && input.inAgentCircle) return { outcome: "run" };
  return { outcome: "ask", circleId: ownerCircleId };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep merge of `fixed` over the body, so a fixed `command.kind` keeps the caller's other command fields. */
function over(
  body: Record<string, unknown>,
  fixed: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(fixed)) {
    const now = merged[key];
    merged[key] = isRecord(value) && isRecord(now) ? over(now, value) : value;
  }
  return merged;
}

/** K-1777: the owner request of one call, or why the call is not one. */
export function opRequest(
  op: Operation,
  target: string,
  body: unknown,
): { readonly method: Operation["method"]; readonly path: string; readonly body: unknown } | string {
  const input = isRecord(body) ? body : {};
  let path = "";
  for (const part of op.route.split("/")) {
    if (!part.startsWith(":")) {
      path += part === "" ? "" : `/${part}`;
      continue;
    }
    const name = part.slice(1);
    const value = name === "target" ? target : input[name];
    if (typeof value !== "string" || value === "")
      return `This operation needs ${name === "target" ? "a target" : `the body field "${name}"`}.`;
    path += `/${encodeURIComponent(value)}`;
  }
  if (op.targetField !== undefined && target === "") return "This operation needs a target.";
  const picked =
    op.pick === undefined
      ? input
      : Object.fromEntries(Object.entries(input).filter(([key]) => op.pick?.includes(key)));
  const withTarget = op.targetField === undefined ? picked : { ...picked, [op.targetField]: target };
  return {
    method: op.method,
    path,
    body: op.method === "GET" ? null : op.fixed === undefined ? withTarget : over(withTarget, op.fixed),
  };
}

/** K-1777: what an approver reads of an operation call; the approval binds its hash (K-1722). */
export const shownOp = (id: OpId, target: string, body: unknown) =>
  `${id} ${target} ${JSON.stringify(body ?? null)}`.trim();

/**
 * K-1777, K-208: what an agent reads of the owner snapshot. A new snapshot field needs a decision here, or this does
 * not compile. A hidden field leaves the answer, and `hidden` names it with its reason.
 */
export const AGENT_READ: Record<keyof Snapshot, "same" | { readonly hidden: string }> = {
  accessApps: "same",
  circles: "same",
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

/** K-1777: `kitshn ops`: one line per operation, by group, with its gate. */
export function opsText(): string {
  const width = Math.max(...OP_IDS.map((id) => id.length));
  const gateText = (gate: Gate) =>
    isPersonGate(gate)
      ? `person only: ${gate.person}`
      : gate.scope === "never"
        ? "asks the Owner"
        : `${gate.right === null ? "no right" : `right "${MACHINE_RIGHT_NAMES[gate.right]}"`}, scope ${gate.scope}`;
  const groups = [...new Set(OP_IDS.map((id) => OPERATIONS[id].group))];
  return groups
    .map((group) =>
      [
        `${group}:`,
        ...OP_IDS.filter((id) => OPERATIONS[id].group === group).map((id) => {
          const op: Operation = OPERATIONS[id];
          return `  ${id.padEnd(width)}  ${op.title} [${gateText(op.gate)}]`;
        }),
      ].join("\n"),
    )
    .join("\n");
}
