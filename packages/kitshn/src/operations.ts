// K-1777: every owner action is one operation. The map, the CLI and an agent call the same id, and one gate decides.
// The table lives here, so the npm CLI, the daemon and the Worker read the same rows; the gate is in the Worker.

/**
 * K-1730: the effects. Each operation has exactly one effect, the same for every actor (person, token, machine, agent).
 * Circles decide where an actor acts; the mode of an effect on its chip decides what kind of action it takes.
 */
export const EFFECTS = [
  /** The map, logs, History, job output and repo read tokens. */
  "reads",
  /** Closed machine care, and the closing of invites and asks: nothing opens a shell or raises access. */
  "maintains",
  /** New cards. They land only in the creator's own circles, so creating never shares. */
  "creates",
  /** Existing cards in scope: deploys, settings, desired state, repo push tokens, backups. */
  "changes",
  /** Shell and exec on machines in scope. */
  "runs",
  /** Anything without Undo: remove an app, restore over data, delete volumes, forget a card. */
  "destroys",
  /** Raises access (K-715): a card into a circle, a member, a level, public, deploy labels, passes and audiences. */
  "shares",
  /** Hands out a secret: invite codes, key codes, tokens. */
  "secrets",
] as const;
export type Effect = (typeof EFFECTS)[number];

/** K-1730: the mode of an effect that no chip sets, for an actor in an agent circle. Outside one, "automatic" asks the Owner. */
export const EFFECT_DEFAULTS: Record<Effect, "automatic" | "ask the Owner" | "off"> = {
  reads: "automatic",
  maintains: "automatic",
  creates: "automatic",
  changes: "ask the Owner",
  runs: "ask the Owner",
  destroys: "ask the Owner",
  shares: "ask the Owner",
  secrets: "off",
};

/**
 * K-1777: what the target of a call must be for the caller, before the mode of the effect counts. A target out of
 * scope reaches beyond the caller's circles, so the effect "shares" decides it (K-1778).
 * - `any`: no check.
 * - `card`: a card that the caller controls (K-718).
 * - `own`: a card that the caller added or published.
 * - `machine`: a machine where the caller may run a shell (K-718).
 * - `rule`: the edits pass `agentRefusal` (K-715, K-718).
 * - `job`: a job that the caller queued, or a job on a machine card that the caller controls.
 * - `ports`: the body fields `machine` and `relay` name cards that the caller controls (K-2007).
 * - `self`: the machine of the caller.
 * - `owner`: never holds, so "shares" decides every call: settings of the whole kitshn and actions with no target that
 *   a caller controls.
 * A target that does not exist refuses. An edit that does not resolve does not pass the rule.
 */
export type Scope = "any" | "card" | "own" | "machine" | "rule" | "job" | "ports" | "self" | "owner";

/** K-1777: only a person can do it, because only a person has the proof. The reason shows in review and in help. */
export interface PersonGate {
  readonly person: string;
}

export interface ScopeGate {
  readonly scope: Scope;
}

export type Gate = PersonGate | ScopeGate;

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
  /** K-1730: what kind of action the operation is. */
  readonly effect: Effect;
  readonly gate: Gate;
  /** The answer holds a secret: an approval runs nothing, the same call again within 1 hour gets it (K-1723). */
  readonly secret?: true;
  /** What the answer gives beyond the call, for the approver to read; a secret row names it per call instead. */
  readonly gives?: string;
  /** The agent uses this command instead, because the call uploads files or needs the local machine. */
  readonly short?: string;
  /** `/op` does not take this call, because it uploads files or approves with its own proof; `short` does. */
  readonly shortOnly?: true;
}

const care = (title: string, kind: string): Operation => ({
  group: "machines",
  title,
  method: "POST",
  route: "/api/jobs",
  targetField: "machineId",
  pick: [],
  fixed: { command: { kind } },
  effect: "maintains",
  gate: { scope: "any" },
});

const machineField = (title: string, field: string, effect: Effect, scope: Scope): Operation => ({
  group: "machines",
  title,
  method: "POST",
  route: "/api/machines/:target",
  pick: [field],
  effect,
  gate: { scope },
});

const NOTIFICATIONS = "a person's own Inbox: mute, snooze and dismiss change no access (K-1905)";
const PUSH = "a push key belongs to one browser (K-1901)";

/**
 * K-1777: the operations. Each owner route of `kitshn.ts` has a row (`src/core/operations.test.ts`), and `gate` is
 * required, so an owner action without an agent path does not compile or does not pass the tests.
 */
export const OPERATIONS = {
  // Cards and circles. `apply` carries every map edit: places, shares, levels, stacks, circles, members and the pause.
  apply: {
    group: "circles",
    title: `edit the map: --body '{"edits":[...]}'. An edit that raises access needs "shares" (K-715)`,
    method: "POST",
    route: "/api/apply",
    pick: ["edits"],
    effect: "changes",
    gate: { scope: "rule" },
  },
  organize: {
    group: "cards",
    title: "tidy the map into a grid, as one Undo (K-532)",
    method: "POST",
    route: "/api/organize",
    effect: "changes",
    gate: { scope: "owner" },
  },
  undo: {
    group: "safety",
    title: `undo one revision: --body '{"revision":<id>}' (K-1506)`,
    method: "POST",
    route: "/api/undo",
    pick: ["revision", "source"],
    effect: "shares",
    gate: { scope: "owner" },
  },
  "undo-item": {
    group: "safety",
    title: `undo the last change of a card or circle: --body '{"item":{"kind":"card","id":"<id>"}}' (K-1507)`,
    method: "POST",
    route: "/api/undo-item",
    pick: ["item"],
    effect: "shares",
    gate: { scope: "owner" },
  },
  "card-setting": {
    group: "cards",
    title: `set a card setting: kitshn card-setting <card> --body '{"setting":"<id>","value":"<value>"}' (K-717)`,
    method: "POST",
    route: "/api/cards/:target/settings",
    effect: "changes",
    gate: { scope: "card" },
  },
  "card-time": {
    group: "cards",
    title: "set the end time of a card; the short form is kitshn time (K-212)",
    method: "POST",
    route: "/api/cards/:target/time",
    effect: "changes",
    gate: { scope: "card" },
    short: "kitshn time <card> <30m|1h|4h|1d|stop|now>",
  },
  "card-address": {
    group: "cards",
    title: "give a card a new address name; the short form is kitshn address (K-1120)",
    method: "POST",
    route: "/api/cards/:target/address",
    effect: "changes",
    gate: { scope: "own" },
    short: "kitshn address <card> <name>",
  },
  "card-redirect-add": {
    group: "cards",
    title: "add a redirect hostname to a site card; the short form is kitshn redirect (K-1128)",
    method: "POST",
    route: "/api/cards/:target/redirects",
    effect: "creates",
    gate: { scope: "card" },
    short: "kitshn redirect <card> <address>",
  },
  "card-redirect-remove": {
    group: "cards",
    title: "remove a redirect hostname of a site card (K-1128)",
    method: "DELETE",
    route: "/api/cards/:target/redirects/:address",
    effect: "changes",
    gate: { scope: "card" },
    short: "kitshn redirect <card> <address> --remove",
  },
  "card-progress-dismiss": {
    group: "cards",
    title: "dismiss the progress sticker of a card",
    method: "POST",
    route: "/api/cards/:target/progress/dismiss",
    effect: "maintains",
    gate: { scope: "card" },
  },
  "card-take-address": {
    group: "cards",
    title: "take the address of a card for another card (K-1124)",
    method: "POST",
    route: "/api/cards/:target/take-address",
    effect: "changes",
    gate: { scope: "card" },
  },
  "card-give-address-back": {
    group: "cards",
    title: "give a taken address back (K-1124)",
    method: "POST",
    route: "/api/cards/:target/give-address-back",
    effect: "changes",
    gate: { scope: "card" },
  },

  // Machines.
  "machine-restart": care("restart the daemon of a machine (K-612)", "restart"),
  "machine-update": care("update the daemon to the release of kitshn (K-617)", "update"),
  "machine-diagnostics": care("print the version, host, paths and tunnel state", "diagnostics"),
  "machine-tunnel-restart": care("restart the tunnel service (K-634)", "tunnel-restart"),
  "machine-shell": {
    group: "machines",
    title: `run a shell script: kitshn machine-shell <machine> --body '{"command":{"kind":"shell","script":"..."}}' (K-612)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command", "labels"],
    fixed: { command: { kind: "shell" } },
    effect: "runs",
    gate: { scope: "machine" },
  },
  "machine-provider-command": {
    group: "machines",
    title: `run a command of a provider: --body '{"command":{"kind":"provider",...}}' (K-707)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command"],
    fixed: { command: { kind: "provider" } },
    effect: "runs",
    gate: { scope: "machine" },
  },
  "machine-volume-remove": {
    group: "machines",
    title: `delete an orphaned Compose volume: --body '{"command":{"kind":"compose-volume-remove","volume":"<name>"}}' (K-909)`,
    method: "POST",
    route: "/api/jobs",
    targetField: "machineId",
    pick: ["command"],
    fixed: { command: { kind: "compose-volume-remove" } },
    effect: "destroys",
    gate: { scope: "machine" },
  },
  "job-cancel": {
    group: "machines",
    title: "cancel a queued job: kitshn job-cancel <job id>",
    method: "POST",
    route: "/api/jobs/:target/cancel",
    effect: "maintains",
    gate: { scope: "job" },
  },
  // K-610, K-614: the label "deploy" is the owner's consent to deploys on a machine, so labels share.
  "machine-labels": machineField(
    `set the labels of a machine: --body '{"labels":["gpu"]}' (K-610)`,
    "labels",
    "shares",
    "owner",
  ),
  "machine-order": machineField(
    `set the place of a machine in lists: --body '{"order":3}'`,
    "order",
    "maintains",
    "any",
  ),
  "machine-auto-update": machineField(
    `turn "Update daemon automatically" on or off: --body '{"autoUpdate":false}' (K-626)`,
    "autoUpdate",
    "maintains",
    "any",
  ),
  // K-818: a risky Compose setting runs a container with host access, as a shell does. It stays with the Owner.
  "machine-compose-allow": machineField(
    `allow risky Compose settings on a machine: --body '{"allow":[...]}' (K-818)`,
    "allow",
    "runs",
    "owner",
  ),
  // A rotation ends the approved jobs of the machine (K-1776), so another machine's key asks the Owner.
  "machine-rotate-key": {
    group: "machines",
    title: "replace the key of a machine over its live connection (K-1705)",
    method: "POST",
    route: "/api/machines/:target/rotate-key",
    effect: "maintains",
    gate: { scope: "self" },
  },
  "machine-reset-key": {
    group: "machines",
    title: "drop the key of a machine and get a key code (K-1706)",
    method: "POST",
    route: "/api/machines/:target/reset-key",
    effect: "secrets",
    gate: { scope: "owner" },
    secret: true,
  },
  "machine-add": {
    group: "machines",
    title: `add a machine and get its join code: --body '{"name":"<name>"}' (K-602)`,
    method: "POST",
    route: "/api/machines",
    effect: "secrets",
    gate: { scope: "owner" },
    secret: true,
  },
  "machine-remove": {
    group: "machines",
    title: "remove a machine (K-615)",
    method: "DELETE",
    route: "/api/machines/:target",
    effect: "destroys",
    gate: { scope: "machine" },
  },
  "provider-forget": {
    group: "machines",
    title: `forget a provider of a machine: --body '{"provider":"<name>"}', or one of its cards with "card" (K-704)`,
    method: "POST",
    route: "/api/machines/:target/providers/:provider/forget",
    pick: ["card"],
    effect: "destroys",
    gate: { scope: "machine" },
  },
  "health-check": {
    group: "machines",
    title: "check the providers and links of every machine now (K-630)",
    method: "POST",
    route: "/api/health/check",
    effect: "maintains",
    gate: { scope: "any" },
  },
  "site-live-add": {
    group: "machines",
    title: "share a server of a machine as a live site; on its own machine use kitshn expose (K-1131)",
    method: "POST",
    route: "/api/sites/live",
    effect: "shares",
    gate: { scope: "owner" },
    short: "kitshn expose <port|socket> --name <name>",
  },

  // Apps, deploys and backups.
  "app-logs": {
    group: "apps",
    title: "search the logs of a card; the short form is kitshn logs (K-1809)",
    method: "POST",
    route: "/api/apps/:target/logs",
    effect: "reads",
    gate: { scope: "card" },
    short: "kitshn logs <card> [text]",
  },
  "app-backups": {
    group: "apps",
    title: "list the backup runs of a Compose card (K-1819)",
    method: "GET",
    route: "/api/apps/:target/backups",
    effect: "reads",
    gate: { scope: "card" },
  },
  "app-backup": {
    group: "apps",
    title: "back up a Compose card now (K-1819)",
    method: "POST",
    route: "/api/apps/:target/backups",
    effect: "changes",
    gate: { scope: "card" },
  },
  "app-restore": {
    group: "apps",
    title: `write a backup run back: --body '{"run":"<run>"}' (K-1820)`,
    method: "POST",
    route: "/api/apps/:target/backups/:run/restore",
    pick: [],
    effect: "destroys",
    gate: { scope: "card" },
  },
  "app-rollbacks": {
    group: "apps",
    title: "list the versions that a card can roll back to (K-913)",
    method: "GET",
    route: "/api/apps/:target/rollbacks",
    effect: "reads",
    gate: { scope: "card" },
  },
  "app-rollback": {
    group: "apps",
    title: `roll a card back: --body '{"deployId":"<id>"}' (K-913)`,
    method: "POST",
    route: "/api/apps/:target/rollback",
    effect: "changes",
    gate: { scope: "card" },
  },
  "app-run-rollback-plan": {
    group: "apps",
    title: "show what a roll back of the last run of a card changes",
    method: "GET",
    route: "/api/apps/:target/run-rollback",
    effect: "reads",
    gate: { scope: "card" },
  },
  "app-run-rollback": {
    group: "apps",
    title: "roll back the last run of a card",
    method: "POST",
    route: "/api/apps/:target/run-rollback",
    effect: "changes",
    gate: { scope: "card" },
  },
  "app-remove": {
    group: "apps",
    title: "remove an app card that you added (K-909)",
    method: "DELETE",
    route: "/api/apps/:target",
    effect: "destroys",
    gate: { scope: "own" },
  },
  "worker-storage-remove": {
    group: "apps",
    title: "delete the orphaned Worker storage of a card",
    method: "DELETE",
    route: "/api/worker-storage/:target",
    effect: "destroys",
    gate: { scope: "owner" },
  },
  "bot-run-deploy": {
    group: "apps",
    title: `deploy a waiting bot pull request: --body '{"repoId":...,"pr":...,"sha":"..."}' (K-1767)`,
    method: "POST",
    route: "/api/bot-runs/deploy",
    // K-1767: a pull request of the kitshn App bot never deploys by itself; a person or a caller with "shares" does.
    effect: "changes",
    gate: { scope: "owner" },
  },
  "port-list": {
    group: "apps",
    title: "list the port cards (K-2001)",
    method: "GET",
    route: "/api/ports",
    effect: "reads",
    gate: { scope: "any" },
  },
  "port-add": {
    group: "apps",
    title: "add a port card; the short form is kitshn port add (K-2001)",
    method: "POST",
    route: "/api/ports",
    effect: "creates",
    gate: { scope: "ports" },
    short: "kitshn port add --machine <machine> --name <name> --port <port/proto>",
  },
  "port-remove": {
    group: "apps",
    title: "remove a port card that you added (K-2007)",
    method: "DELETE",
    route: "/api/ports/:target",
    effect: "destroys",
    gate: { scope: "own" },
    short: "kitshn port remove <card>",
  },
  "port-door-close": {
    group: "apps",
    title: `close one door of a port card: --body '{"address":"<address>"}' (K-2007)`,
    method: "DELETE",
    route: "/api/ports/:target/doors/:address",
    effect: "maintains",
    gate: { scope: "card" },
    short: "kitshn port close <card> <address>",
  },
  uptime: {
    group: "apps",
    title: "the uptime changes of a card (K-1125)",
    method: "GET",
    route: "/api/uptime/:target",
    effect: "reads",
    gate: { scope: "any" },
  },

  // Library.
  "upload-page": {
    group: "library",
    title: "upload a page (K-1101)",
    method: "POST",
    route: "/api/pages",
    shortOnly: true,
    effect: "creates",
    gate: { scope: "any" },
    short: "kitshn publish <file>",
  },
  "upload-file": {
    group: "library",
    title: "upload a file (K-1101)",
    method: "POST",
    route: "/api/files",
    shortOnly: true,
    effect: "creates",
    gate: { scope: "any" },
    short: "kitshn publish <file>",
  },
  "upload-site": {
    group: "library",
    title: "upload a folder as a site (K-1123, K-1129)",
    method: "POST",
    route: "/api/sites/:step",
    shortOnly: true,
    effect: "creates",
    gate: { scope: "any" },
    short: "kitshn publish <folder>",
  },
  "library-list": {
    group: "library",
    title: "list the pages and files (K-1101)",
    method: "GET",
    route: "/api/library",
    effect: "reads",
    gate: { scope: "any" },
  },
  "library-content": {
    group: "library",
    title: "read the content of a page or file that you published",
    method: "GET",
    route: "/api/library/:target/content",
    effect: "reads",
    gate: { scope: "own" },
  },
  "library-previous": {
    group: "library",
    title: "go back to the previous version of a page, file or folder site (K-1117)",
    method: "POST",
    route: "/api/library/:target/previous",
    effect: "changes",
    gate: { scope: "own" },
    short: "kitshn publish --previous <card>",
  },
  "library-delete": {
    group: "library",
    title: "delete a page, file or folder site for good (K-1117)",
    method: "DELETE",
    route: "/api/library/:target",
    effect: "destroys",
    gate: { scope: "own" },
    short: "kitshn unpublish <card>",
  },

  // Circles: devices.
  "device-token-add": {
    group: "circles",
    title: `make a device token and get its secret: --body '{"name":"<name>"}' (K-106)`,
    method: "POST",
    route: "/api/devices",
    effect: "secrets",
    gate: { scope: "owner" },
    secret: true,
  },
  "device-invite": {
    group: "circles",
    title: `invite a phone or desktop app: --body '{"name":"<name>"}', or '{"tokenId":"<id>"}' again (K-1601)`,
    method: "POST",
    route: "/api/devices/invites",
    effect: "secrets",
    gate: { scope: "owner" },
    secret: true,
  },
  "device-invite-cancel": {
    group: "circles",
    title: "cancel a waiting device invite: kitshn device-invite-cancel <token id> (K-1601)",
    method: "DELETE",
    route: "/api/devices/invites/:target",
    effect: "maintains",
    gate: { scope: "any" },
  },
  "device-list": {
    group: "circles",
    title: "list the device tokens (K-106)",
    method: "GET",
    route: "/api/devices",
    effect: "reads",
    gate: { scope: "any" },
  },

  // Repos.
  "repo-allow": {
    group: "repos",
    title: "let a waiting repo deploy (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "allowed" },
    effect: "runs",
    gate: { scope: "any" },
  },
  "repo-block": {
    group: "repos",
    title: "block a repo (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "blocked" },
    effect: "changes",
    gate: { scope: "owner" },
  },
  "repo-forget": {
    group: "repos",
    title: "forget a repo, so its next deploy waits again (K-819)",
    method: "POST",
    route: "/api/repos/:target",
    pick: [],
    fixed: { state: "forget" },
    effect: "destroys",
    gate: { scope: "owner" },
  },
  "repos-check": {
    group: "repos",
    title: "check the repos on GitHub now",
    method: "POST",
    route: "/api/repos/check",
    effect: "maintains",
    gate: { scope: "any" },
  },
  "repo-group-add": {
    group: "repos",
    title: "add a repo group (K-1733)",
    method: "POST",
    route: "/api/repo-groups",
    effect: "shares",
    gate: { scope: "owner" },
  },
  "repo-group-edit": {
    group: "repos",
    title: "change a repo group or its GitHub way (K-1733, K-1760)",
    method: "POST",
    route: "/api/repo-groups/:target",
    effect: "shares",
    gate: { scope: "owner" },
  },
  "repo-group-remove": {
    group: "repos",
    title: "delete a repo group (K-1733)",
    method: "DELETE",
    route: "/api/repo-groups/:target",
    effect: "changes",
    gate: { scope: "card" },
  },
  "github-way": {
    group: "repos",
    title: "set the default GitHub way (K-1760)",
    method: "POST",
    route: "/api/settings/github-way",
    effect: "shares",
    gate: { scope: "owner" },
  },

  // Passes.
  passes: {
    group: "passes",
    title: "the pass settings and audiences (K-1773)",
    method: "GET",
    route: "/api/passes",
    effect: "reads",
    gate: { scope: "any" },
  },
  "passes-set": {
    group: "passes",
    title: `turn passes on or off: --body '{"on":true}' (K-1770)`,
    method: "POST",
    route: "/api/passes",
    effect: "shares",
    gate: { scope: "owner" },
  },
  "passes-rotate": {
    group: "passes",
    title: "rotate the pass key (K-1771)",
    method: "POST",
    route: "/api/passes/rotate",
    effect: "changes",
    gate: { scope: "owner" },
  },
  "audience-add": {
    group: "passes",
    title: `add a pass audience: --body '{"address":"<address>"}' (K-1773)`,
    method: "POST",
    route: "/api/passes/audiences",
    pick: ["address"],
    fixed: { labels: false },
    effect: "shares",
    gate: { scope: "any" },
  },
  "audience-labels": {
    group: "passes",
    title: `put attested labels in the passes of an audience: --body '{"address":"<address>","labels":true}' (K-1772)`,
    method: "POST",
    route: "/api/passes/audiences",
    pick: ["address", "labels"],
    effect: "shares",
    gate: { scope: "owner" },
  },
  "audience-remove": {
    group: "passes",
    title: "remove a pass audience (K-1773)",
    method: "DELETE",
    route: "/api/passes/audiences/:target",
    effect: "changes",
    gate: { scope: "owner" },
    short: "kitshn agent audience-remove --audience <address>, for an audience that you added",
  },

  // Asks.
  "proposal-deny": {
    group: "asks",
    title: "deny an open ask of a circle that you are in (K-1723)",
    method: "POST",
    route: "/api/proposals/:target/deny",
    effect: "maintains",
    gate: { scope: "any" },
  },
  approve: {
    group: "asks",
    title: "approve an open ask of a circle that you are in, with your own proof (K-1723, K-1726)",
    method: "POST",
    route: "/api/approve/:via/:target",
    effect: "maintains",
    gate: { scope: "any" },
    short: "kitshn agent approve <proposal id>",
    shortOnly: true,
  },
  "ask-events": {
    group: "asks",
    title: `the ask events with one label: --body '{"label":"t3.thread.id=<id>"}' (K-1717, K-1756)`,
    method: "GET",
    route: "/api/ask-events",
    pick: ["label"],
    effect: "reads",
    gate: { scope: "any" },
  },

  // Safety and account.
  state: {
    group: "safety",
    title: "the map as the owner sees it, without the hidden fields; the short form is kitshn state (K-1777)",
    method: "GET",
    route: "/api/state",
    effect: "reads",
    gate: { scope: "any" },
    short: "kitshn state [field...]",
  },
  "state-export": {
    group: "safety",
    title: "download the state export (K-1830)",
    method: "GET",
    route: "/api/state/export",
    effect: "secrets",
    gate: { scope: "owner" },
    gives: "the whole state, with History text, which can quote what a person typed",
  },
  jobs: {
    group: "safety",
    title: "the last 100 jobs with their output",
    method: "GET",
    route: "/api/jobs",
    effect: "secrets",
    gate: { scope: "owner" },
    gives: "the commands and output of the last 100 jobs, which can quote what a person typed",
  },
  usage: {
    group: "safety",
    title: "the use of the Cloudflare free plan (K-1301)",
    method: "GET",
    route: "/api/usage",
    effect: "reads",
    gate: { scope: "any" },
  },
  desired: {
    group: "safety",
    title: "the desired state of one resource kind",
    method: "GET",
    route: "/api/desired/:target",
    effect: "reads",
    gate: { scope: "owner" },
  },
  // K-709: the part of one machine and the shared part are two rows, so the scope checks the machine that the call writes.
  "desired-set-machine": {
    group: "safety",
    title: `replace the desired state of one machine: kitshn desired-set-machine <machine> --body '{"kind":"<kind>","value":{...}}'`,
    method: "PUT",
    route: "/api/desired/:kind",
    targetField: "machineId",
    pick: ["value"],
    effect: "changes",
    gate: { scope: "machine" },
  },
  "desired-set-shared": {
    group: "safety",
    title: `replace the shared desired state of one resource kind: --body '{"value":{...}}'`,
    method: "PUT",
    route: "/api/desired/:target",
    pick: ["value"],
    fixed: { machineId: null },
    effect: "changes",
    gate: { scope: "owner" },
  },
  "sign-out": {
    group: "account",
    title: "sign out everywhere (K-110)",
    method: "POST",
    route: "/api/sign-out",
    effect: "changes",
    gate: { scope: "owner" },
  },
  "sign-out-retry": {
    group: "account",
    title: "retry the sign-out of the applications that are left (K-110)",
    method: "POST",
    route: "/api/sign-out/retry",
    effect: "maintains",
    gate: { scope: "any" },
  },
  resume: {
    group: "safety",
    title: "resume after a pause",
    method: "POST",
    route: "/fresh/resume",
    effect: "changes",
    gate: { person: "Resume needs a fresh passkey (K-1504)" },
  },
  "restore-time": {
    group: "safety",
    title: "restore kitshn to a time",
    method: "POST",
    route: "/fresh/restore-time",
    effect: "destroys",
    gate: { person: "a restore to a time needs a fresh passkey (K-1822)" },
  },
  notifications: {
    group: "account",
    title: "the Inbox and its mute, snooze and dismiss",
    method: "POST",
    route: "/api/notifications",
    effect: "maintains",
    gate: { person: NOTIFICATIONS },
  },
  push: {
    group: "account",
    title: "the push subscription of a browser",
    method: "POST",
    route: "/api/push",
    effect: "maintains",
    gate: { person: PUSH },
  },
} as const satisfies Record<string, Operation>;

export type OpId = keyof typeof OPERATIONS;

export const OP_IDS = Object.keys(OPERATIONS) as ReadonlyArray<OpId>;

export const isOpId = (value: unknown): value is OpId =>
  typeof value === "string" && Object.hasOwn(OPERATIONS, value);

/** The rows whose answer holds a secret, so each needs a text of what it gives (K-1777). */
export type SecretOpId = {
  [Id in OpId]: (typeof OPERATIONS)[Id] extends { readonly secret: true } ? Id : never;
}[OpId];

export const isSecretOp = (id: OpId): id is SecretOpId => (OPERATIONS[id] as Operation).secret === true;

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

/**
 * K-1777: the owner request of one call, or why the call is not one. A GET sends no body, so the text fields of the
 * body go in its query (`search`), as the owner route reads them (K-1756).
 */
export function opRequest(
  op: Operation,
  target: string,
  body: unknown,
):
  | {
      readonly method: Operation["method"];
      readonly path: string;
      readonly search: string;
      readonly body: unknown;
    }
  | string {
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
  const full = op.fixed === undefined ? withTarget : over(withTarget, op.fixed);
  if (op.method !== "GET") return { method: op.method, path, search: "", body: full };
  const query = new URLSearchParams(
    Object.entries(full).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ).toString();
  return { method: op.method, path, search: query === "" ? "" : `?${query}`, body: null };
}

/** K-1777: what an approver reads of an operation call; the approval binds its hash (K-1722). */
export const shownOp = (id: OpId, target: string, body: unknown) =>
  `${id} ${target} ${JSON.stringify(body ?? null)}`.trim();

/** K-1777: `kitshn ops`: one line per operation, by group, with its gate. */
export function opsText(): string {
  const width = Math.max(...OP_IDS.map((id) => id.length));
  const gateText = (op: Operation) =>
    isPersonGate(op.gate)
      ? `${op.effect}, person only: ${op.gate.person}`
      : `${op.effect}, scope ${op.gate.scope}`;
  const groups = [...new Set(OP_IDS.map((id) => OPERATIONS[id].group))];
  const head = `Each row: [effect, scope]. The mode of the effect decides; a target out of scope follows "shares" (K-1730).`;
  return `${head}\n${groups
    .map((group) =>
      [
        `${group}:`,
        ...OP_IDS.filter((id) => OPERATIONS[id].group === group).map((id) => {
          const op: Operation = OPERATIONS[id];
          return `  ${id.padEnd(width)}  ${op.title} [${gateText(op)}]`;
        }),
      ].join("\n"),
    )
    .join("\n")}`;
}
