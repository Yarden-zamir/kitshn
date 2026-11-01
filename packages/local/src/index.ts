// K-702: the messages of the daemon's local socket (K-701). One JSON value per line. A request carries an id,
// its answer the same id. An event carries no id (K-703). Providers speak protocol 2 (K-704): within it every change
// is additive, so each side ignores unknown fields and skips unknown events.
import { Schema } from "effect";
import {
  CardSettingValues,
  ReachedCard,
  DesiredParts,
  PROVIDER_LIMITS,
  ProviderCommand,
  ProviderKind,
  ProviderName,
  ProviderProblem,
} from "./provider.ts";
import { HealthReport } from "./health.ts";

/** K-704: the provider protocol that this package describes. */
export const PROVIDER_PROTOCOL = 2;

export * from "./provider.ts";
export * from "./health.ts";

/** The longest line, in UTF-16 code units, that the daemon reads; a longer line ends the connection. */
/** K-1714: room for a forwarded body of `MAX_FORWARD_BYTES` in base64 and its request. */
export const MAX_LINE_LENGTH = 17 * 1024 * 1024;

/**
 * K-1714: the largest body that the daemon forwards, each way. Known limit: a bigger file needs an agent key; revisit
 * when an agent needs to publish one through its machine.
 */
export const MAX_FORWARD_BYTES = 12 * 1024 * 1024;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** K-1711: what an agent may ask kitshn for. */
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
  /** K-722: only the `exec` request starts one; an `ask` of it is refused. */
  "exec",
] as const;
export type AskAction = (typeof ASK_ACTIONS)[number];

/** K-1723: the asks whose approval only opens a window; the daemon asks again to get the secret. */
export const WINDOW_ACTIONS: ReadonlySet<AskAction> = new Set(["github-token", "pass"]);

/** K-1750: at most 10 labels; a key of `a-z`, `0-9`, `.` and `-` with a prefix, a value of at most 256 characters. */
export const MAX_LABELS = 10;
const LABEL_KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789.-";
export const isLabelKey = (key: string) =>
  key.length > 0 &&
  key.length <= 64 &&
  key.includes(".") &&
  !key.startsWith(".") &&
  !key.endsWith(".") &&
  [...key].every((char) => LABEL_KEY_CHARS.includes(char));
const Labels = Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(256)));

/** K-1752: at most 16 attested labels; a bare name of a-z, 0-9, `.` and `-`, at most 48 characters. */
export const MAX_ATTESTED_LABELS = 16;
const ATTESTED_NAME_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789.-";
export const isAttestedName = (name: string) =>
  name.length > 0 &&
  name.length <= 48 &&
  !name.startsWith(".") &&
  !name.endsWith(".") &&
  [...name].every((char) => ATTESTED_NAME_CHARS.includes(char));
const AttestedLabels = Schema.Record(
  Schema.String.check(Schema.makeFilter((name: string) => isAttestedName(name) || "a bare label name")),
  Schema.String.check(Schema.isMaxLength(256)),
).check(
  Schema.makeFilter(
    (labels: Readonly<Record<string, string>>) =>
      Object.keys(labels).length <= MAX_ATTESTED_LABELS || `at most ${MAX_ATTESTED_LABELS} labels`,
  ),
);

/** K-1752: the value of `KITSHN_ATTEST`: `<provider>:<token>`. */
const Attest = Schema.String.check(Schema.isMaxLength(4200));
/** A base64 chunk of an exec stream (K-722), at most 16 KB of data. */
const Chunk = Schema.String.check(Schema.isMaxLength(22 * 1024));
const ExecId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/**
 * K-722: one frame of a run between the two daemons through kitshn, and between a daemon and the bridge that runs
 * it as the provider user. B sends output, stdin credit and the exit; A sends credit, stdin and the close.
 */
export const ExecFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    data: Chunk,
  }),
  Schema.Struct({ type: Schema.Literal("stdin-credit"), bytes: Schema.Int }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
    durationMs: Schema.Number,
    reason: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("credit"),
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 * 1024 * 1024 })),
  }),
  Schema.Struct({ type: Schema.Literal("input"), data: Chunk }),
  Schema.Struct({ type: Schema.Literal("close"), what: Schema.Literals(["stdin", "kill"]) }),
]);
export type ExecFrame = typeof ExecFrame.Type;

/** K-722: what a run needs on B, from kitshn to B's daemon and from B's daemon to the bridge that runs it. */
export const ExecRun = Schema.Struct({
  execId: ExecId,
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
  stdin: Schema.Boolean,
});
export type ExecRun = typeof ExecRun.Type;

/** K-1710: one ask. `body` carries what the action needs, such as the edits of `apply` or the command of `job`. */
const Ask = Schema.Struct({
  id: Id,
  type: Schema.Literal("ask"),
  action: Schema.Literals(ASK_ACTIONS),
  target: Schema.String.check(Schema.isMaxLength(512)),
  body: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  labels: Schema.optionalKey(Labels),
  /** K-1752: `KITSHN_ATTEST` of the caller, `<provider>:<token>`; the daemon asks that provider to attest it. */
  attest: Schema.optionalKey(Attest),
});
export type Ask = typeof Ask.Type;

/** K-709: the fields of `desired-set` and `desired-init`. */
const DesiredChange = {
  provider: ProviderName,
  kind: Schema.String.check(Schema.isMaxLength(64)),
  part: Schema.Literals(["shared", "machine"]),
  value: Schema.Unknown,
  /** K-709: the provider's mark of this set; the next `desired` event of the kind carries the last stored one. */
  rev: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
};

export const Request = Schema.Union([
  /** The machine id, the key fingerprint, the connection to kitshn and the tunnel service (K-605). */
  Schema.Struct({ id: Id, type: Schema.Literal("status") }),
  /** K-1705: rotate the machine key over the live connection. */
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key") }),
  /** K-1706: `kitshn rekey` saved a new key; connect again with it. */
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
  /**
   * K-1714: one HTTP call to `/agent` that the daemon sends with the machine token and signs with the machine key, for
   * the commands that publish, set addresses, read logs and make repos. `body` is base64.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forward"),
    method: Schema.Literals(["GET", "POST", "DELETE"]),
    path: Schema.String.check(Schema.isMaxLength(2048)),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(1024)))),
    body: Schema.optionalKey(Schema.String),
    attest: Schema.optionalKey(Attest),
  }),
  /** K-1762: `git credential erase` drops the kept tokens of one repo. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forget-token"),
    repo: Schema.String.check(Schema.isMaxLength(512)),
  }),
  /**
   * K-704: a provider names its kinds, its commands and all its resources; this replaces what an earlier connection
   * of the same instance registered. The daemon user, root and provider users send it (K-701). `protocol` and
   * `instance` are checked by the daemon, so an old provider gets a reason, not a decode error. Resources and clients
   * decode item by item (`decodeResources`): a bad one is dropped and named in `problems`.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("register"),
    protocol: Schema.optionalKey(Schema.Number),
    provider: ProviderName,
    instance: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
    kinds: Schema.Array(ProviderKind).check(Schema.isMaxLength(PROVIDER_LIMITS.kinds)),
    commands: Schema.Array(ProviderCommand).check(Schema.isMaxLength(PROVIDER_LIMITS.commands)),
    resources: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
    /** K-720: the provider's client apps for device invites. */
    clients: Schema.optionalKey(
      Schema.Array(Schema.Unknown).check(Schema.isMaxLength(PROVIDER_LIMITS.clients)),
    ),
    /** K-721: AUD tags of Access applications that kitshn did not make but that front this provider now. */
    trustAudiences: Schema.optionalKey(
      Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(4)),
    ),
  }),
  /** K-705: adds or replaces resources of a provider that this connection registered; item by item, as `register`. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("upsert"),
    provider: ProviderName,
    resources: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
  }),
  /** K-705: removes resources of a provider that this connection registered, by their ids. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("remove"),
    provider: ProviderName,
    ids: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(PROVIDER_LIMITS.resources),
    ),
  }),
  /** K-704: `kitshn provider forget <name>`: the daemon drops a provider that does not run, so it no longer reports it. */
  Schema.Struct({ id: Id, type: Schema.Literal("provider-forget"), provider: ProviderName }),
  /** K-701: root or the daemon user lists or edits the local users of the daemon's own `machine.json`. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("local-users"),
    action: Schema.Literals(["list", "add", "remove"]),
    uid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    provider: Schema.optionalKey(Schema.Boolean),
  }),
  /** K-722: root or the daemon user sets the user that runs exec for a provider (`kitshn providers exec-user`). */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("provider-exec-user"),
    provider: ProviderName,
    uid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  /** K-704: root or the daemon user moves a provider name to another user. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("provider-rebind"),
    provider: ProviderName,
    uid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  /**
   * K-709: a provider sets the part of a desired state of this machine, or the shared part. kitshn stores it and pushes
   * it to every machine of the provider. `desired-init` writes only an absent part, including when another provider
   * or the owner writes between registration and this request. Only the registered connection sends either.
   */
  // One member per type, so `Extract<Request, { type: "desired-set" }>` finds it.
  Schema.Struct({
    id: Id,
    type: Schema.Literal("desired-set"),
    ...DesiredChange,
  }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("desired-init"),
    ...DesiredChange,
  }),
  /** K-1612: cancels a job of this machine while it waits in the queue: one that runs here, or one that it queued. */
  Schema.Struct({ id: Id, type: Schema.Literal("job-cancel"), jobId: Schema.Int }),
  /** K-605, K-606: the resource sample now and the samples of the last hour, read on this machine only. */
  Schema.Struct({ id: Id, type: Schema.Literal("samples") }),
  /** K-630: the last health check of this machine; with `now`, a new one first. */
  Schema.Struct({ id: Id, type: Schema.Literal("health"), now: Schema.optionalKey(Schema.Boolean) }),
  /** K-721: the levels of each session, from the identity headers that `register` named. At most 50 keys. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("check"),
    requests: Schema.Array(
      Schema.Struct({
        key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        headers: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(8192))),
      }),
    ).check(Schema.isMaxLength(50)),
  }),
  /**
   * K-1752: the provider's answer to an `attest` event, within 2 s. Label names are bare: the daemon adds the
   * provider's registered prefix, so `thread.id` of T3 becomes `t3.thread.id`.
   */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("attest-result"),
    attestId: Schema.String.check(Schema.isMaxLength(64)),
    active: Schema.Boolean,
    labels: Schema.optionalKey(AttestedLabels),
  }),
  /** K-722: runs a command on another machine, streamed; `exec-output` and `exec-exit` events follow. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("exec"),
    target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
    cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
    timeoutSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 }))),
    stdin: Schema.optionalKey(Schema.Boolean),
    attest: Schema.optionalKey(Attest),
    /** K-722: the provider on the target whose user runs it, when this machine controls cards of several there. */
    targetProvider: Schema.optionalKey(ProviderName),
  }),
  /** K-722: a chunk for the stdin of a run that the caller started with `stdin: true`. */
  Schema.Struct({ id: Id, type: Schema.Literal("exec-input"), execId: ExecId, data: Chunk }),
  /** K-722: ends the stdin of a run, or kills it. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("exec-close"),
    execId: ExecId,
    what: Schema.Literals(["stdin", "kill"]),
  }),
  /** K-704: the answer to a `ping` event; it has no id and gets no answer. */
  Schema.Struct({ type: Schema.Literal("pong") }),
  /** K-722: a frame of a run that the daemon gave this bridge (`exec-run`); no id and no answer. */
  Schema.Struct({ type: Schema.Literal("exec-frame"), execId: ExecId, frame: ExecFrame }),
  /** K-722: more output credit for a run, after the caller consumed its data; no id and no answer. */
  Schema.Struct({
    type: Schema.Literal("exec-credit"),
    execId: ExecId,
    bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 * 1024 * 1024 })),
  }),
  /** K-707: the result of a `command` event. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("command-result"),
    provider: ProviderName,
    commandId: Schema.Int,
    ok: Schema.Boolean,
    output: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  }),
  Ask,
]);
export type Request = typeof Request.Type;
export type ProviderRequest = Extract<Request, { type: "register" | "upsert" | "remove" | "command-result" }>;
/** A request with an id, which gets one answer. */
export type IdRequest = Exclude<Request, { type: "pong" | "exec-credit" | "exec-frame" }>;

/** K-605: one resource sample; each share is between 0 and 1. */
export const Sample = Schema.Struct({
  at: Schema.Number,
  cpu: Schema.Number,
  memory: Schema.Number,
  disk: Schema.Number,
});
export type Sample = typeof Sample.Type;

/** K-704: the last refused registration of one provider; `at` is when the refusal with this reason started. */
export const ProviderRefusal = Schema.Struct({
  provider: Schema.String,
  reason: Schema.String,
  at: Schema.Number,
});
export type ProviderRefusal = typeof ProviderRefusal.Type;

/** K-704: one provider of the machine as `kitshn status` shows it. */
export const ProviderState = Schema.Struct({
  name: Schema.String,
  instance: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
  /** Since when it is online or offline; null when it never connected since the daemon started. */
  since: Schema.NullOr(Schema.Number),
  problems: Schema.Array(ProviderProblem),
  refusal: Schema.NullOr(Schema.String),
  /** K-722: the user id that runs exec for this provider. */
  execUser: Schema.NullOr(Schema.Number),
});
export type ProviderState = typeof ProviderState.Type;

export const Status = Schema.Struct({
  version: Schema.String,
  machineId: Schema.String,
  /** Null when this machine has no `machine.key` (K-1708). */
  fingerprint: Schema.NullOr(Schema.String),
  /** `token-only`: kitshn has no key for this machine and reads only its status (K-1708). */
  connection: Schema.Literals(["connected", "token-only", "disconnected"]),
  tunnel: Schema.Literals(["starting", "running", "stopped"]),
  /** K-1127: the address of kitshn, for the files of a new repo. */
  server: Schema.optionalKey(Schema.String),
  /** K-704: the providers whose last registration the daemon refused, until one is accepted. */
  refusedProviders: Schema.optionalKey(Schema.Array(ProviderRefusal)),
  /** K-704: every provider that registered: online, since when, its last problems and the user that runs its exec. */
  providers: Schema.optionalKey(Schema.Array(ProviderState)),
  /**
   * K-704, K-515: the registered providers without a connection now: since when (`at`) and why (`reason`), such as
   * "the connection closed" or "never connected since the daemon started".
   */
  offlineProviders: Schema.optionalKey(Schema.Array(ProviderRefusal)),
});
export type Status = typeof Status.Type;

/** K-721: why `check` refuses a session. */
export const CHECK_REFUSALS = [
  "expired",
  "no-access",
  "paused",
  "unknown-subject",
  "invalid",
  "stale",
  /** The daemon could not fetch the Access signing keys: no new session, and no revocation of a live one. */
  "unavailable",
] as const;
export type CheckRefusal = (typeof CHECK_REFUSALS)[number];

export const Answer = Schema.Union([
  Schema.Struct({ id: Id, type: Schema.Literal("status"), status: Status }),
  Schema.Struct({ id: Id, type: Schema.Literal("rotate-key"), fingerprint: Schema.String }),
  Schema.Struct({ id: Id, type: Schema.Literal("reconnect") }),
  Schema.Struct({ id: Id, type: Schema.Literal("forget-token") }),

  /** K-1714: kitshn's answer to a forwarded call; `body` is base64. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("forward"),
    status: Schema.Number,
    contentType: Schema.String,
    body: Schema.String,
  }),
  /** K-1710: kitshn ran the ask; `result` is what the action gives. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("done"),
    result: Schema.Unknown,
  }),
  /** K-1722: the ask waits for an answer of its approver circle; an `ask-result` event follows. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("waiting"),
    proposalId: Schema.String,
  }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("refused"),
    reason: Schema.String,
    /** K-1776: the right that is off. */
    need: Schema.optionalKey(Schema.String),
  }),
  /** K-1760: the repo's owner is "not kitshn", so the machine uses its own login. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("ask"),
    outcome: Schema.Literal("not-kitshn"),
    reason: Schema.String,
  }),
  /** K-1722 to K-1724: the answer to a waiting ask. An event: it has no id. */
  Schema.Struct({
    type: Schema.Literal("ask-result"),
    proposalId: Schema.String,
    outcome: Schema.Literals(["approved", "denied", "expired"]),
    result: Schema.optionalKey(Schema.Unknown),
    reason: Schema.optionalKey(Schema.String),
  }),
  /** K-704: the register took effect; `problems` names each dropped item, and `saved` what the daemon kept. */
  Schema.Struct({
    id: Id,
    type: Schema.Literal("register"),
    protocol: Schema.Literal(2),
    machine: Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }),
    capabilities: Schema.Array(Schema.String),
    /** K-721: the request headers that `check` needs, lowercase. */
    identityHeaders: Schema.Array(Schema.String),
    problems: Schema.Array(ProviderProblem),
    saved: Schema.Struct({
      /** K-709, K-1608: the saved desired state of each kind of the provider. */
      desired: Schema.Record(Schema.String, DesiredParts),
      /** K-717: the saved value of each card setting, by resource id and setting id. */
      settings: CardSettingValues,
      /** K-1609: the saved reach of this machine. */
      reach: Schema.Array(ReachedCard),
      /** K-1623: the provider's site hosts whose record points at kitshn's tunnel. */
      served: Schema.Array(Schema.String),
    }),
    /**
     * K-1609: the Unix socket or Windows pipe of the link proxy: `http://link/<provider>/<machine id>/<path>` reaches
     * that provider's card on that machine. Null when the daemon could not serve it.
     */
    linkSocket: Schema.NullOr(Schema.String),
    /** K-721: when kitshn last answered this daemon; null before the first contact. */
    syncedAt: Schema.NullOr(Schema.Number),
    /** K-704: the daemon pings this often; it drops a connection that sent nothing for `graceMs`. */
    pingMs: Schema.Number,
    graceMs: Schema.Number,
  }),
  Schema.Struct({ id: Id, type: Schema.Literal("desired-set") }),
  Schema.Struct({ id: Id, type: Schema.Literal("desired-init"), initialized: Schema.Boolean }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("check"),
    results: Schema.Array(
      Schema.Union([
        Schema.Struct({
          key: Schema.String,
          subject: Schema.Struct({
            type: Schema.Literals(["person", "device", "machine"]),
            id: Schema.String,
            name: Schema.String,
          }),
          levels: Schema.Record(Schema.String, Schema.String),
          /** `exec` when the subject is a machine whose "runs" covers this machine at automatic. */
          rights: Schema.Array(Schema.Literal("exec")),
          until: Schema.Number,
        }),
        /** The headers name no one: not a kitshn visitor. */
        Schema.Struct({ key: Schema.String, anonymous: Schema.Literal(true) }),
        Schema.Struct({
          key: Schema.String,
          refused: Schema.Struct({ code: Schema.Literals(CHECK_REFUSALS), reason: Schema.String }),
        }),
      ]),
    ),
  }),
  Schema.Struct({ id: Id, type: Schema.Literal("attest-result") }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("exec"),
    execId: ExecId,
    /** `ended`: the run ended before it started; its `exec-exit` with the reason follows. */
    state: Schema.Literals(["running", "waiting", "ended"]),
    proposalId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ id: Id, type: Schema.Literal("exec-input") }),
  Schema.Struct({ id: Id, type: Schema.Literal("exec-close") }),
  Schema.Struct({ id: Id, type: Schema.Literal("provider-exec-user") }),
  Schema.Struct({ id: Id, type: Schema.Literal("job-cancel") }),
  Schema.Struct({ id: Id, type: Schema.Literal("samples"), newest: Sample, history: Schema.Array(Sample) }),
  /** K-630: null before the first check. */
  Schema.Struct({ id: Id, type: Schema.Literal("health"), report: Schema.NullOr(HealthReport) }),
  /** K-704: an event every 15 s; answer with `pong`. */
  Schema.Struct({ type: Schema.Literal("ping"), at: Schema.Number }),
  /** K-722: an event for the bridge only: run this command as the bridge's user; the provider never sees it. */
  Schema.Struct({ type: Schema.Literal("exec-run"), run: ExecRun }),
  /** K-722: an event for the bridge only: a frame from A for a run that the bridge runs. */
  Schema.Struct({ type: Schema.Literal("exec-control"), execId: ExecId, frame: ExecFrame }),
  /** K-721: an event: kitshn answered this daemon; at most once a minute, and at once when `paused` changes. */
  Schema.Struct({ type: Schema.Literal("sync"), syncedAt: Schema.Number, paused: Schema.Boolean }),
  /** K-721: an event: the grants changed; check the live sessions again. */
  Schema.Struct({ type: Schema.Literal("grants-changed"), at: Schema.Number }),
  /** K-1623: an event: the provider's site hosts whose record points at kitshn's tunnel. */
  Schema.Struct({ type: Schema.Literal("served"), hosts: Schema.Array(Schema.String) }),
  /** K-1609: an event: the cards of this provider on other machines that this machine reaches, on each change. */
  Schema.Struct({ type: Schema.Literal("reach"), cards: Schema.Array(ReachedCard) }),
  /** K-709: an event: the desired state of one kind, on each change, with the `rev` of the last stored set. */
  Schema.Struct({
    type: Schema.Literal("desired"),
    kind: Schema.String,
    state: DesiredParts,
    rev: Schema.NullOr(Schema.String),
  }),
  /** K-717: an event: the card settings of the provider's cards, on each change. */
  Schema.Struct({ type: Schema.Literal("settings"), values: CardSettingValues }),
  /** K-1752: an event: attest an agent's token within 2 s with `attest-result`. */
  Schema.Struct({ type: Schema.Literal("attest"), attestId: Schema.String, token: Schema.String }),
  /** K-722: an event: a chunk of the output of a run that this connection started. */
  Schema.Struct({
    type: Schema.Literal("exec-output"),
    execId: ExecId,
    stream: Schema.Literals(["stdout", "stderr"]),
    data: Chunk,
  }),
  /** K-722: an event: B wrote this much of the stdin into the process; send that much more. */
  Schema.Struct({ type: Schema.Literal("exec-stdin-credit"), execId: ExecId, bytes: Schema.Int }),
  /** K-722: an event: the run ended, or never started (`reason`); always the last frame of a run. */
  Schema.Struct({
    type: Schema.Literal("exec-exit"),
    execId: ExecId,
    exitCode: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
    durationMs: Schema.Number,
    reason: Schema.NullOr(Schema.String),
  }),
  /** K-1612: an event: a job that this connection queued with `ask job` ended. */
  Schema.Struct({
    type: Schema.Literal("job-result"),
    jobId: Schema.Int,
    state: Schema.Literals(["done", "failed", "expired"]),
    exitCode: Schema.NullOr(Schema.Int),
    output: Schema.String,
  }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("upsert"),
    problems: Schema.optionalKey(Schema.Array(ProviderProblem)),
  }),
  Schema.Struct({ id: Id, type: Schema.Literal("remove") }),
  Schema.Struct({ id: Id, type: Schema.Literal("command-result") }),
  Schema.Struct({ id: Id, type: Schema.Literal("provider-forget") }),
  Schema.Struct({ id: Id, type: Schema.Literal("provider-rebind") }),
  Schema.Struct({
    id: Id,
    type: Schema.Literal("local-users"),
    daemonUid: Schema.Int,
    users: Schema.Array(Schema.Struct({ uid: Schema.Int, provider: Schema.Boolean })),
  }),
  /**
   * K-707: an event: run one command. `resource` is the provider's id of the card, null for a command of the machine.
   * The provider answers with `command-result` and the same `commandId` before `deadline`.
   */
  Schema.Struct({
    type: Schema.Literal("command"),
    commandId: Schema.Int,
    command: Schema.String,
    resource: Schema.NullOr(Schema.String),
    /** K-1625: the row of a list that the command is for. */
    row: Schema.NullOr(Schema.String),
    deadline: Schema.Number,
  }),
  /** The id is null when the line has no valid id. */
  Schema.Struct({ id: Schema.NullOr(Id), type: Schema.Literal("error"), error: Schema.String }),
]);
export type Answer = typeof Answer.Type;
export type ErrorAnswer = Extract<Answer, { type: "error" }>;

const decodeRequest = Schema.decodeUnknownSync(Request);
/** Every `type` of an answer or event that this package knows. */
const ANSWER_TYPES: ReadonlySet<string> = new Set(
  Answer.members.map((member) => String((member.fields.type as unknown as { literal: unknown }).literal)),
);
const decodeAnswer = Schema.decodeUnknownSync(Answer);
const isId = Schema.is(Id);

export const line = (message: Request | Answer): string => `${JSON.stringify(message)}\n`;

/** One line from a client: the request, or the error answer that the daemon sends back for it. */
export function readRequest(
  text: string,
): { ok: true; request: Request } | { ok: false; answer: ErrorAnswer } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, answer: { id: null, type: "error", error: "The line is not JSON." } };
  }
  try {
    return { ok: true, request: decodeRequest(value) };
  } catch (error) {
    const id =
      typeof value === "object" && value !== null && "id" in value && isId(value.id) ? value.id : null;
    return {
      ok: false,
      answer: {
        id,
        type: "error",
        error: `The request does not match K-702: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * One line from the daemon, or null for an event of a type that this reader does not know: within protocol 2 a newer
 * daemon may add one, and a reader skips it. A known type that does not match throws: the two sides disagree.
 */
export function readAnswer(text: string): Answer | null {
  const value: unknown = JSON.parse(text);
  const type = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
  if (typeof type === "string" && !ANSWER_TYPES.has(type)) return null;
  return decodeAnswer(value);
}
