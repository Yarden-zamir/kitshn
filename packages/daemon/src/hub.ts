// K-704, K-721, K-722, K-1752: the live side of the provider connections: liveness, attestation, `check`, the exec
// relay in both directions, and the events that kitshn's pushes cause. `providers.ts` keeps what is saved; this keeps
// what lives only while a connection does.
import type { DaemonMessage } from "@kitshn/edge/machine";
import type { Answer, ExecFrame, ExecRun, Request } from "@kitshn/local";
import { type CheckContext, accessKeys, checkSession } from "./check.ts";
import { type ExecHandle, applyFrame, startExec } from "./exec.ts";
import type { Providers } from "./providers.ts";

/** K-704: the default ping timing; the `register` answer names the values in use. */
export const PING_MS = 15_000;
export const GRACE_MS = 45_000;
/** K-1752: a provider answers `attest` within this time, or the ask is refused. */
export const ATTEST_MS = 2_000;
/** K-722: kitshn answers the start of a run within this time. */
const EXEC_START_MS = 30_000;
/** K-722: the stdin credit of a run on A; B gives it back with `stdin-credit` frames. */
const STDIN_WINDOW = 64 * 1024;
/** K-721: a `sync` event goes at most once a minute, and at once when `paused` changes. */
const SYNC_MS = 60_000;

type Emit = (event: Answer) => void;
type Exec = Extract<Request, { type: "exec" }>;
type ExecStart = Extract<Answer, { type: "exec" }>;

/** K-721: what kitshn last said to this daemon, saved so a restart without kitshn keeps it. */
export interface KitshnState {
  readonly syncedAt: number | null;
  readonly paused: boolean;
  /** K-722: the machines whose "runs commands" covers this machine at automatic. */
  readonly execMachines: ReadonlyArray<string>;
}

export interface HubOptions {
  readonly registry: () => Providers;
  /** Sends a message over the signed connection to kitshn; false when there is none. */
  readonly toKitshn: (message: DaemonMessage) => boolean;
  /** Closes a local connection (K-704); its close handler then calls `closed`. */
  readonly drop: (connection: number) => void;
  readonly log: (text: string) => void;
  readonly ownUid: number;
  readonly platform: NodeJS.Platform;
  readonly pingMs: number;
  readonly graceMs: number;
  readonly saved: KitshnState;
  readonly save: (state: KitshnState) => void;
  readonly now?: () => number;
  readonly keys?: CheckContext["keys"];
  /** K-722: the user name to run as through the sudo rule of `kitshn exec install`, or null when the rule is missing. */
  readonly execSudo: (uid: number) => string | null;
}

/** A run that a connection of this machine started (A). */
interface Outgoing {
  readonly connection: number;
  readonly emit: Emit;
  stdinCredit: number;
  started: ((answer: ExecStart["state"], proposalId?: string) => void) | null;
  /** The proposal of a run that waits for an approval. */
  proposalId?: string;
}

/** A run on this machine (B): the daemon runs it, or the bridge of the provider user does. */
type Incoming =
  | { readonly kind: "local"; readonly handle: ExecHandle }
  | { readonly kind: "bridge"; readonly connection: number; readonly provider: string };

export class ProviderHub {
  private readonly emitters = new Map<number, Emit>();
  private readonly lastSeen = new Map<number, number>();
  private readonly trust = new Map<number, ReadonlyArray<string>>();
  private readonly attests = new Map<
    string,
    { readonly connection: number; readonly settle: (result: AttestOutcome) => void }
  >();
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly jobs = new Map<number, number>();
  private kitshn: KitshnState;
  private lastSync = 0;

  constructor(private readonly options: HubOptions) {
    this.kitshn = options.saved;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** K-704: a connection registered a provider; it gets events from now on. */
  registered(connection: number, emit: Emit, trustAudiences: ReadonlyArray<string>) {
    this.emitters.set(connection, emit);
    this.trust.set(connection, trustAudiences);
    this.lastSeen.set(connection, this.now());
  }

  /** K-704: the ping timing that the `register` answer names. */
  timing() {
    return { pingMs: this.options.pingMs, graceMs: this.options.graceMs };
  }

  /** K-704: any line of a connection counts as alive. */
  seen(connection: number) {
    if (this.emitters.has(connection)) this.lastSeen.set(connection, this.now());
  }

  /** K-704: sends one event to the connection of a provider; false when none holds it. */
  emitTo(provider: string, event: Answer): boolean {
    const connection = this.options.registry().connectionOf(provider);
    const emit = connection === null ? undefined : this.emitters.get(connection);
    emit?.(event);
    return emit !== undefined;
  }

  /** K-704: one round of the liveness: a ping to each provider connection, and a drop of each quiet one. */
  tick() {
    const now = this.now();
    for (const [connection, emit] of this.emitters) {
      if (now - (this.lastSeen.get(connection) ?? now) > this.options.graceMs) {
        this.options.log(
          `provider connection ${connection} sent nothing for ${this.options.graceMs} ms; dropped`,
        );
        this.options.drop(connection);
        continue;
      }
      emit({ type: "ping", at: now });
    }
  }

  /** K-704: the liveness timer; returns its stop. */
  start(): () => void {
    const timer = setInterval(() => this.tick(), this.options.pingMs);
    return () => clearInterval(timer);
  }

  /** K-704, K-722: a connection closed: its attests fail, its runs end on both sides. */
  closed(connection: number) {
    this.emitters.delete(connection);
    this.lastSeen.delete(connection);
    this.trust.delete(connection);
    for (const attest of this.attests.values())
      if (attest.connection === connection) attest.settle({ refused: "the provider closed its connection" });
    for (const [execId, run] of this.outgoing)
      if (run.connection === connection) {
        this.outgoing.delete(execId);
        this.options.toKitshn({ type: "execFrame", execId, frame: { type: "close", what: "kill" } });
      }
    for (const [execId, run] of this.incoming)
      if (run.kind === "bridge" && run.connection === connection) {
        this.incoming.delete(execId);
        this.toSource(execId, exitFrame(`the provider ${run.provider} on this machine went offline`));
      }
    for (const [jobId, owner] of this.jobs) if (owner === connection) this.jobs.delete(jobId);
  }

  /**
   * K-1752, K-1753: asks the provider named in `KITSHN_ATTEST` to vouch for a token. Its bare labels get the
   * provider's prefix, so only that provider sets labels of its prefix.
   */
  attest(value: string): Promise<AttestOutcome> {
    const colon = value.indexOf(":");
    const provider = colon > 0 ? value.slice(0, colon) : "";
    const token = value.slice(colon + 1);
    const connection = this.options.registry().connectionOf(provider);
    const emit = connection === null ? undefined : this.emitters.get(connection);
    if (connection === null || !emit)
      return Promise.resolve({
        refused: provider
          ? `the provider ${provider} is not connected on this machine, so it cannot check this agent.`
          : "KITSHN_ATTEST is not <provider>:<token>.",
      });
    const attestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ refused: `the provider ${provider} did not attest within ${ATTEST_MS / 1000} s.` }),
        ATTEST_MS,
      );
      const settle = (outcome: AttestOutcome) => {
        clearTimeout(timer);
        this.attests.delete(attestId);
        resolve(outcome);
      };
      this.attests.set(attestId, {
        connection,
        settle: (outcome) =>
          settle(
            "labels" in outcome
              ? {
                  labels: Object.fromEntries(
                    Object.entries(outcome.labels).map(([name, label]) => [`${provider}.${name}`, label]),
                  ),
                }
              : outcome,
          ),
      });
      emit({ type: "attest", attestId, token });
    });
  }

  /** K-1752: the answer of a provider to `attest`; only the connection that got the event settles it. */
  attested(request: Extract<Request, { type: "attest-result" }>, connection: number) {
    const attest = this.attests.get(request.attestId);
    if (!attest || attest.connection !== connection)
      throw new Error(
        `no attest ${request.attestId} waits on this connection; it may have timed out (K-1752).`,
      );
    attest.settle(
      request.active
        ? { labels: request.labels ?? {} }
        : { refused: "the provider says that this agent is not active." },
    );
  }

  /** K-721: what the daemon knows from kitshn; null `syncedAt` before the first contact. */
  state(): KitshnState {
    return this.kitshn;
  }

  /**
   * K-721: kitshn answered: a new `syncedAt`, and the pause and the exec rights when the message names them. A
   * change of either is a change of every session's answer, so each provider checks its sessions again.
   */
  fromKitshnState(change: Partial<Omit<KitshnState, "syncedAt">> = {}) {
    const now = this.now();
    const before = this.kitshn;
    this.kitshn = { ...before, ...change, syncedAt: now };
    const pausedChanged = before.paused !== this.kitshn.paused;
    const rightsChanged = before.execMachines.join() !== this.kitshn.execMachines.join();
    if (!pausedChanged && !rightsChanged && now - this.lastSync < SYNC_MS) return;
    this.lastSync = now;
    this.options.save(this.kitshn);
    for (const emit of this.emitters.values()) {
      emit({ type: "sync", syncedAt: now, paused: this.kitshn.paused });
      if (pausedChanged || rightsChanged) emit({ type: "grants-changed", at: now });
    }
  }

  /** K-721: the grants of a provider changed; it checks its live sessions again. */
  grantsChanged(provider: string) {
    this.emitTo(provider, { type: "grants-changed", at: this.now() });
  }

  /** K-721: answers a `check` of the connection that registered a provider. */
  async check(request: Extract<Request, { type: "check" }>, connection: number) {
    const registry = this.options.registry();
    const provider = registry.providerOf(connection);
    const report = provider === null ? null : registry.reportOf(provider);
    if (provider === null || !report)
      throw new Error("register a provider on this connection first (K-704).");
    const access = registry.accessOf(provider);
    const context: CheckContext = {
      report,
      grants: registry.grantsOf(provider),
      teamDomain: access?.teamDomain ?? null,
      audiences: [...(access?.audiences ?? []), ...(this.trust.get(connection) ?? [])],
      paused: this.kitshn.paused,
      syncedAt: this.kitshn.syncedAt,
      execMachines: new Set(this.kitshn.execMachines),
      now: this.now(),
      keys: this.options.keys ?? accessKeys,
    };
    const results = await Promise.all(
      request.requests.map((item) => checkSession(item.key, item.headers, context)),
    );
    return { id: request.id, type: "check" as const, results };
  }

  /** K-1612: a job that this connection queued; its `job-result` comes back to it. */
  jobQueued(jobId: number, connection: number) {
    this.jobs.set(jobId, connection);
  }

  /** K-1612: a job ended; the connection that queued it gets `job-result`. */
  jobEnded(event: Extract<Answer, { type: "job-result" }>) {
    const connection = this.jobs.get(event.jobId);
    if (connection === undefined) return;
    this.jobs.delete(event.jobId);
    this.emitters.get(connection)?.(event);
  }

  /**
   * K-722, A: starts a run on another machine through kitshn. The answer comes when kitshn says that the run started,
   * waits for an approval, or ended before it started; frames follow as events on this connection.
   */
  exec(
    request: Exec,
    caller: { readonly connection: number; readonly emit: Emit },
    attested: Readonly<Record<string, string>>,
  ): Promise<ExecStart> {
    const execId = crypto.randomUUID();
    const run: Outgoing = {
      connection: caller.connection,
      emit: caller.emit,
      stdinCredit: STDIN_WINDOW,
      started: null,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outgoing.delete(execId);
        this.options.toKitshn({ type: "execFrame", execId, frame: { type: "close", what: "kill" } });
        reject(new Error(`kitshn did not start the run within ${EXEC_START_MS / 1000} s.`));
      }, EXEC_START_MS);
      run.started = (state, proposalId) => {
        clearTimeout(timer);
        run.started = null;
        resolve({ id: request.id, type: "exec", execId, state, ...(proposalId ? { proposalId } : {}) });
      };
      this.outgoing.set(execId, run);
      const sent = this.options.toKitshn({
        type: "execStart",
        execId,
        provider: this.options.registry().providerOf(caller.connection),
        run: {
          execId,
          command: request.command,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          timeoutSeconds: request.timeoutSeconds ?? 90,
          stdin: request.stdin ?? false,
        },
        target: request.target,
        attested,
      });
      if (!sent) {
        clearTimeout(timer);
        this.outgoing.delete(execId);
        reject(
          new Error(
            "the daemon has no signed connection to kitshn, so it cannot run a command elsewhere now.",
          ),
        );
      }
    });
  }

  /** K-722, A: credit, stdin and close of a run that this connection started. */
  execControl(
    execId: string,
    connection: number,
    frame: Extract<ExecFrame, { type: "credit" | "input" | "close" }>,
  ) {
    const run = this.outgoing.get(execId);
    if (!run || run.connection !== connection)
      throw new Error(`no run ${execId} of this connection is open (K-722).`);
    if (frame.type === "input") {
      const bytes = Buffer.byteLength(frame.data, "base64");
      if (bytes > run.stdinCredit)
        throw new Error(
          `a stdin chunk of ${bytes} bytes is beyond the stdin credit of ${run.stdinCredit} (K-722).`,
        );
      run.stdinCredit -= bytes;
    }
    if (!this.options.toKitshn({ type: "execFrame", execId, frame }))
      throw new Error("the daemon has no signed connection to kitshn now (K-722).");
  }

  /** K-722: kitshn says how a run of this machine started; a waiting one keeps its proposal. */
  execState(execId: string, state: "running" | "waiting", proposalId?: string) {
    const run = this.outgoing.get(execId);
    if (!run) return;
    if (state === "waiting" && proposalId) run.proposalId = proposalId;
    run.started?.(state, proposalId);
  }

  /** K-722: a deny or an expiry of its proposal ends a waiting run; after an approval its frames follow. */
  proposalEnded(proposalId: string, outcome: "approved" | "denied" | "expired", reason?: string) {
    if (outcome === "approved") return;
    for (const [execId, run] of this.outgoing)
      if (run.proposalId === proposalId) {
        this.outgoing.delete(execId);
        run.emit({
          type: "exec-exit",
          execId,
          ...withoutType(exitFrame(`refused: the ask was ${outcome}${reason ? ` (${reason})` : ""}`)),
        });
      }
  }

  /**
   * K-722: a frame from kitshn. Output, stdin credit and the exit come from B for a run that this machine started
   * (A); credit, stdin and the close come from A for a run that this machine runs (B). One machine can be both.
   */
  execFrame(execId: string, frame: ExecFrame) {
    if (frame.type === "output" || frame.type === "stdin-credit" || frame.type === "exit") {
      const mine = this.outgoing.get(execId);
      if (!mine) return;
      if (frame.type === "output")
        mine.emit({ type: "exec-output", execId, stream: frame.stream, data: frame.data });
      else if (frame.type === "stdin-credit") {
        mine.stdinCredit += frame.bytes;
        mine.emit({ type: "exec-stdin-credit", execId, bytes: frame.bytes });
      } else {
        this.outgoing.delete(execId);
        mine.started?.("ended");
        mine.emit({ type: "exec-exit", execId, ...withoutType(frame) });
      }
      return;
    }
    const run = this.incoming.get(execId);
    if (!run) return;
    if (run.kind === "bridge") {
      this.emitters.get(run.connection)?.({ type: "exec-control", execId, frame });
      return;
    }
    try {
      applyFrame(run.handle, frame);
    } catch (error) {
      this.options.log(`exec ${execId}: ${String(error)}`);
    }
  }

  /**
   * K-722, B: runs a command for another machine. It runs as the exec user of the provider of the same name: the
   * daemon runs it when that is its own user, or as that user when the daemon is root; else the bridge of that
   * provider, which runs as that user. Without such a provider it runs as the daemon user only when this machine
   * has no provider users at all.
   */
  execRun(provider: string | null, run: ExecRun) {
    const registry = this.options.registry();
    const execUser = provider === null ? null : registry.execUserOf(provider);
    const { ownUid } = this.options;
    const local = (as: { readonly uid?: number; readonly sudoUser?: string } = {}) => {
      const handle = startExec(
        {
          command: run.command,
          ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
          timeoutMs: run.timeoutSeconds * 1000,
          stdin: run.stdin,
          platform: this.options.platform,
          ...as,
        },
        {
          output: (stream, data) =>
            this.toSource(run.execId, { type: "output", stream, data: Buffer.from(data).toString("base64") }),
          stdinCredit: (bytes) => this.toSource(run.execId, { type: "stdin-credit", bytes }),
          exit: (end) => {
            this.incoming.delete(run.execId);
            this.toSource(run.execId, { type: "exit", ...end });
          },
        },
      );
      this.incoming.set(run.execId, { kind: "local", handle });
    };
    // Windows has one account per pipe, so the daemon user runs every command there (K-621).
    if (this.options.platform === "win32") return local();
    if (execUser === null) {
      if (registry.providerUsers().size === 0) return local();
      return this.toSource(
        run.execId,
        exitFrame(
          provider === null
            ? "this machine runs commands only for a provider, and the caller has none."
            : `this machine has no provider ${provider}, and it runs commands only as a provider user.`,
        ),
      );
    }
    if (execUser === ownUid) return local();
    if (ownUid === 0) return local({ uid: execUser });
    // A daemon that is not root becomes the exec user through the rule of `kitshn exec install`; without the rule,
    // the bridge of that user runs the command, so the provider must be connected.
    const sudoUser = this.options.execSudo(execUser);
    if (sudoUser !== null) return local({ sudoUser });
    const connection = provider === null ? null : registry.connectionOf(provider);
    const emit = connection === null ? undefined : this.emitters.get(connection);
    if (provider === null || connection === null || !emit)
      return this.toSource(
        run.execId,
        exitFrame(
          `the provider ${provider} on this machine is offline, and the daemon has no sudo rule to run as its exec user (kitshn exec install).`,
        ),
      );
    if (registry.ownerOf(provider) !== execUser)
      return this.toSource(
        run.execId,
        exitFrame(
          `the exec user of ${provider} is not the user that runs it, and the daemon is not root; set it with kitshn providers exec-user.`,
        ),
      );
    this.incoming.set(run.execId, { kind: "bridge", connection, provider });
    emit({ type: "exec-run", run });
  }

  /**
   * K-722: how a run on this machine would become each provider's exec user, for the machine card: `sudo` through
   * the rule of `kitshn exec install`, or `bridge` when the rule is missing. Only providers whose exec user is not
   * the daemon user, on a daemon that is not root.
   */
  execPaths(): Array<{ readonly provider: string; readonly uid: number; readonly via: "sudo" | "bridge" }> {
    const { ownUid, platform } = this.options;
    if (ownUid === 0 || platform === "win32") return [];
    const registry = this.options.registry();
    return registry.reports().flatMap((report) => {
      const uid = registry.execUserOf(report.name);
      if (uid === null || uid === ownUid) return [];
      return [{ provider: report.name, uid, via: this.options.execSudo(uid) === null ? "bridge" : "sudo" }];
    });
  }

  /** K-722, B: a frame of the bridge that runs a run as the provider user. */
  bridgeFrame(request: Extract<Request, { type: "exec-frame" }>, connection: number) {
    const run = this.incoming.get(request.execId);
    if (!run || run.kind !== "bridge" || run.connection !== connection)
      throw new Error(`no run ${request.execId} was given to this connection (K-722).`);
    if (request.frame.type === "exit") this.incoming.delete(request.execId);
    this.toSource(request.execId, request.frame);
  }

  /** K-722: the connection to kitshn closed: every run ends, on this side with "the relay was lost". */
  kitshnLost() {
    for (const [execId, run] of this.outgoing) {
      this.outgoing.delete(execId);
      run.started?.("ended");
      run.emit({ type: "exec-exit", execId, ...withoutType(exitFrame("the relay was lost")) });
    }
    for (const [execId, run] of this.incoming) {
      this.incoming.delete(execId);
      if (run.kind === "local") run.handle.kill("the relay was lost");
      else
        this.emitters.get(run.connection)?.({
          type: "exec-control",
          execId,
          frame: { type: "close", what: "kill" },
        });
    }
  }

  private toSource(execId: string, frame: ExecFrame) {
    this.options.toKitshn({ type: "execFrame", execId, frame });
  }
}

export type AttestOutcome =
  { readonly labels: Readonly<Record<string, string>> } | { readonly refused: string };

const exitFrame = (reason: string): Extract<ExecFrame, { type: "exit" }> => ({
  type: "exit",
  exitCode: null,
  signal: null,
  durationMs: 0,
  reason,
});

const withoutType = ({ type: _type, ...rest }: Extract<ExecFrame, { type: "exit" }>) => rest;

/** K-721: the saved state of kitshn; nothing usable gives the state before a first contact. */
export function kitshnStateOf(value: unknown): KitshnState {
  const saved = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const machines = Array.isArray(saved["execMachines"]) ? saved["execMachines"] : [];
  return {
    syncedAt: typeof saved["syncedAt"] === "number" ? saved["syncedAt"] : null,
    paused: saved["paused"] === true,
    execMachines: machines.filter((item): item is string => typeof item === "string"),
  };
}
