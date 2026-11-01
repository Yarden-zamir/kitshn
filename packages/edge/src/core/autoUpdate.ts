// K-626 to K-629: automatic daemon updates, one machine at a time, as one rollout that survives a deploy.
import { type MachineStatus, daemonProtocol } from "./machine.ts";

/** K-617: a local build names no release, so there is nothing to update a daemon to. */
export const isRelease = (version: string) => /^[0-9a-f]{12}$/.test(version);

/**
 * K-627: the one rollout of kitshn, kept in `meta`. `step` is the machine that updates now, also after a deploy of
 * another release; `failed` stops the rest of `version`; `updated` lists the machines that reached `version`.
 */
export interface Rollout {
  readonly version: string;
  readonly step: {
    readonly machineId: string;
    readonly jobId: number;
    /** When kitshn sent the job; only a connection after it can show that the daemon came back. */
    readonly sentAt: number | null;
    /** The job waits while the machine is busy (K-1608); false after `BUSY_CAP_MS`. Absent in older rollouts: true. */
    readonly whenIdle?: boolean;
    /** K-636: the providers that were online when the job went out; each must be online again after the update. */
    readonly providers?: ReadonlyArray<string>;
  } | null;
  readonly failed: { readonly machineId: string; readonly reason: string } | null;
  readonly updated: ReadonlyArray<string>;
  /** Since when each BEHIND machine waits because a provider reports `busy`; absent in older rollouts. */
  readonly busySince?: Readonly<Record<string, number>>;
}

export const NO_ROLLOUT: Rollout = { version: "", step: null, failed: null, updated: [] };

/**
 * K-627: a busy machine gets its update at the latest this long after kitshn first found it busy, also while busy.
 * Until then kitshn updates the next machines, so a machine whose agents always run never holds the rollout.
 */
export const BUSY_CAP_MS = 2 * 60 * 60 * 1000;

/** K-627: the job of the step. "closed": it failed only because the connection closed. "gone": expired or none. */
export interface StepJob {
  readonly state: "queued" | "sent" | "done" | "failed" | "closed" | "gone";
  readonly output: string;
}

/** The daemon as kitshn sees it now: its status and the start of its connection while online, else null. */
export type LiveStatus =
  | (Pick<
      MachineStatus,
      "version" | "capabilities" | "os" | "protocol" | "refusedProviders" | "offlineProviders"
    > & { readonly connectedAt: number })
  | null;

/** K-628: what the card shows about the update of its daemon. */
export type DaemonUpdate =
  | { readonly state: "updating" }
  /** K-627: a provider reports `busy`, so the update waits until the machine is idle, at the latest until `until`. */
  | { readonly state: "waiting"; readonly reason: "busy"; readonly until: number }
  | { readonly state: "updated" }
  | { readonly state: "failed"; readonly reason: string };

/** The last line of a job's output, which holds the error of a failed update. */
export const lastLine = (output: string) =>
  output
    .trim()
    .split("\n")
    .findLast((line) => line.trim() !== "")
    ?.trim() ?? "The update failed without output.";

const withUpdated = (rollout: Rollout, machineId: string): Rollout => ({
  ...rollout,
  updated: rollout.updated.includes(machineId) ? rollout.updated : [...rollout.updated, machineId],
});

/**
 * K-636: why a daemon that runs the release is not healthy: another protocol than kitshn, or a provider that was online
 * before the update and is refused or offline now. Null when it is healthy.
 */
export function unhealthyReason(
  status: NonNullable<LiveStatus>,
  protocol: string,
  providers: ReadonlyArray<string>,
): string | null {
  const running = daemonProtocol(status);
  if (running !== protocol) return `The daemon came back with kitshn protocol ${running}, not ${protocol}.`;
  for (const provider of providers) {
    const refused = status.refusedProviders?.find((entry) => entry.provider === provider);
    if (refused) return `After the update the daemon refused the provider ${provider}: ${refused.reason}`;
    const offline = status.offlineProviders?.find((entry) => entry.provider === provider);
    if (offline)
      return `The provider ${provider} did not register again after the update: ${offline.reason}.`;
  }
  return null;
}

/**
 * K-627: moves the rollout on from what kitshn sees now. A step ends well only when its job is done and its machine is
 * online on the release: a K-629 daemon sends `done` only after its connection stayed up, so a release that crashes
 * just after kitshn accepts it never counts. A machine that stays offline holds the rest. K-636: the daemon must also
 * speak `protocol`, the one of kitshn, and be healthy (`unhealthyReason`).
 */
export function advanceRollout(
  rollout: Rollout,
  job: StepJob | null,
  statusOf: (machineId: string) => LiveStatus,
  protocol: string,
): Rollout {
  const step = rollout.step;
  if (!step) return rollout;
  const status = statusOf(step.machineId);
  // A connection that started after the job went out, so not the one that ran it.
  const later = status !== null && step.sentAt !== null && status.connectedAt > step.sentAt;
  if (job === null || job.state === "gone") return { ...rollout, step: null };
  if (job.state === "failed")
    return { ...rollout, step: null, failed: { machineId: step.machineId, reason: lastLine(job.output) } };
  if (status !== null && status.version === rollout.version && job.state === "done") {
    const reason = unhealthyReason(status, protocol, step.providers ?? []);
    return reason === null
      ? withUpdated({ ...rollout, step: null }, step.machineId)
      : { ...rollout, step: null, failed: { machineId: step.machineId, reason } };
  }
  if (
    status !== null &&
    status.version !== rollout.version &&
    later &&
    (job.state === "done" || job.state === "closed")
  )
    return {
      ...rollout,
      step: null,
      failed: { machineId: step.machineId, reason: `The daemon came back on edge-${status.version}.` },
    };
  return rollout;
}

/** K-626: the owner turned the setting off, so that machine neither holds nor stops the rollout. */
export const withoutMachine = (rollout: Rollout, machineId: string): Rollout => ({
  ...rollout,
  step: rollout.step?.machineId === machineId ? null : rollout.step,
  failed: rollout.failed?.machineId === machineId ? null : rollout.failed,
});

/**
 * K-627: the owner sent "Update daemon" to a machine that holds or stopped the rollout. That job becomes the step, so
 * the hold or the failure ends when it succeeds, and fails again when it does not.
 */
export function manualStep(rollout: Rollout, machineId: string, jobId: number): Rollout {
  const holds = rollout.step?.machineId === machineId;
  const stopped = rollout.step === null && rollout.failed?.machineId === machineId;
  if (!holds && !stopped) return rollout;
  return { ...rollout, failed: null, step: { machineId, jobId, sentAt: null } };
}

export interface AutoUpdateMachine {
  readonly id: string;
  readonly order: number;
  /** K-626: absent or true means on. */
  readonly autoUpdate: boolean;
  /** K-1708: a machine without a key gets no jobs. */
  readonly hasKey: boolean;
  readonly status: LiveStatus;
  /** K-1608: a running provider card of the machine reports `busy`. */
  readonly busy: boolean;
}

/** K-627: what kitshn queues next: the machine, and whether its job waits while the machine is busy. */
export interface AutoUpdatePick {
  readonly machineId: string;
  readonly whenIdle: boolean;
}

/**
 * K-622: a Windows daemon without `task-restart` cannot start its task again after the swap, so the new daemon would
 * not run until someone starts the task. It updates only by hand.
 */
export const restartsAfterUpdate = (status: Pick<MachineStatus, "os" | "capabilities">) =>
  !status.os.startsWith("win32") || (status.capabilities ?? []).includes("task-restart");

/** K-627: the BEHIND machines of a release that get automatic updates, in the owner's order. */
const behindMachines = (version: string, machines: ReadonlyArray<AutoUpdateMachine>) =>
  machines
    .filter(
      (machine) =>
        machine.autoUpdate &&
        machine.hasKey &&
        machine.status !== null &&
        isRelease(machine.status.version) &&
        machine.status.version !== version &&
        (machine.status.capabilities ?? []).includes("update") &&
        restartsAfterUpdate(machine.status),
    )
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/**
 * K-627: the rollout with the wait of each BEHIND machine that is busy now: a wait keeps its start while the machine
 * stays busy, and ends when it is idle, updated or gone.
 */
export function withBusyWaits(
  rollout: Rollout,
  version: string,
  machines: ReadonlyArray<AutoUpdateMachine>,
  now: number,
): Rollout {
  const busySince = Object.fromEntries(
    behindMachines(version, machines)
      .filter((machine) => machine.busy)
      .map((machine) => [machine.id, rollout.busySince?.[machine.id] ?? now]),
  );
  return { ...rollout, busySince };
}

/**
 * K-627: a step whose job still waits for a busy machine holds nothing: it ends without a failure, and kitshn comes
 * back to that machine later. A step sent after the cap, or a job that already went out, stays.
 */
export function releaseBusyStep(
  rollout: Rollout,
  job: StepJob | null,
  busy: (machineId: string) => boolean,
): Rollout {
  const step = rollout.step;
  if (!step || step.whenIdle === false || job?.state !== "queued" || !busy(step.machineId)) return rollout;
  return { ...rollout, step: null };
}

/**
 * K-627: the one machine that gets the next automatic update, or null. Nothing while kitshn is paused, while a step
 * of any release runs, or after one failed on this release; then the first BEHIND machine in the owner's order that is
 * idle, or that waited `BUSY_CAP_MS` while busy (`rollout.busySince`, from `withBusyWaits`).
 */
export function nextAutoUpdate(
  version: string,
  paused: boolean,
  rollout: Rollout,
  machines: ReadonlyArray<AutoUpdateMachine>,
  now: number,
): AutoUpdatePick | null {
  if (!isRelease(version) || paused || rollout.step !== null) return null;
  if (rollout.version === version && rollout.failed !== null) return null;
  for (const machine of behindMachines(version, machines)) {
    if (!machine.busy) return { machineId: machine.id, whenIdle: true };
    const since = rollout.busySince?.[machine.id] ?? now;
    if (now - since >= BUSY_CAP_MS) return { machineId: machine.id, whenIdle: false };
  }
  return null;
}

/** K-627: the rollout with a new step; a new release starts a new rollout. */
export const startStep = (
  rollout: Rollout,
  version: string,
  machineId: string,
  jobId: number,
  whenIdle = true,
): Rollout => ({
  ...(rollout.version === version ? rollout : { ...NO_ROLLOUT, version, busySince: rollout.busySince ?? {} }),
  step: { machineId, jobId, sentAt: null, whenIdle },
});

/**
 * K-627: the step went out. Delivery names the release of the Worker at that time (K-617), so a step queued before a
 * deploy moves to the new release.
 */
export function stepSent(
  rollout: Rollout,
  version: string,
  now: number,
  providers: ReadonlyArray<string>,
): Rollout {
  if (rollout.step === null) return rollout;
  return {
    ...startStep(rollout, version, rollout.step.machineId, rollout.step.jobId, rollout.step.whenIdle ?? true),
    step: { ...rollout.step, sentAt: now, providers },
  };
}

/** K-628: what the card of a machine shows for the release of the Worker. */
export function daemonUpdate(rollout: Rollout, machineId: string, version: string): DaemonUpdate | null {
  if (rollout.step?.machineId === machineId) return { state: "updating" };
  const since = rollout.busySince?.[machineId];
  if (since !== undefined) return { state: "waiting", reason: "busy", until: since + BUSY_CAP_MS };
  if (rollout.version !== version) return null;
  if (rollout.failed?.machineId === machineId) return { state: "failed", reason: rollout.failed.reason };
  return rollout.updated.includes(machineId) ? { state: "updated" } : null;
}

/** Reads the stored rollout; kitshn writes it, so another shape is a bug. */
export function parseRollout(text: string | null): Rollout {
  if (text === null) return NO_ROLLOUT;
  const value = JSON.parse(text) as Rollout;
  if (typeof value.version !== "string" || !Array.isArray(value.updated))
    throw new Error(`The stored daemon rollout does not parse: ${text.slice(0, 200)}`);
  return value;
}

/** K-636: one machine in the answer of the rollout operation. */
export interface RolloutMachine {
  readonly id: string;
  readonly name: string;
  readonly state: "updated" | "newest" | "updating" | "waiting" | "failed" | "behind" | "offline" | "skipped";
  readonly version: string | null;
  readonly protocol: string | null;
  /** Why it waits, failed, is skipped or offline. */
  readonly reason: string | null;
}

/** K-636: the rollout of the release of the Worker, as `kitshn rollout` follows it. */
export interface RolloutView {
  readonly version: string;
  readonly protocol: string;
  /** `stopped`: a step failed; `running`: a daemon waits for its update; `done`: none does. */
  readonly state: "running" | "done" | "stopped";
  readonly machines: ReadonlyArray<RolloutMachine>;
}

/** K-636: where each machine stands in the rollout of `version`, in the owner's order. */
export function rolloutView(
  version: string,
  protocol: string,
  rollout: Rollout,
  machines: ReadonlyArray<AutoUpdateMachine & { readonly name: string }>,
): RolloutView {
  const current = rollout.version === version;
  const behind = new Set(behindMachines(version, machines).map((machine) => machine.id));
  const machineState = (machine: AutoUpdateMachine & { readonly name: string }): RolloutMachine => {
    const status = machine.status;
    const base = {
      id: machine.id,
      name: machine.name,
      version: status?.version ?? null,
      protocol: status ? daemonProtocol(status) : null,
    };
    const is = (state: RolloutMachine["state"], reason: string | null = null) => ({ ...base, state, reason });
    if (rollout.step?.machineId === machine.id) return is("updating");
    if (current && rollout.failed?.machineId === machine.id) return is("failed", rollout.failed.reason);
    if (status === null) return is("offline", "It updates when it connects (K-627).");
    if (status.version === version)
      return is(current && rollout.updated.includes(machine.id) ? "updated" : "newest");
    const since = rollout.busySince?.[machine.id];
    if (since !== undefined)
      return is(
        "waiting",
        `A provider reports busy; it updates at the latest at ${new Date(since + BUSY_CAP_MS).toISOString()} (K-627).`,
      );
    if (behind.has(machine.id)) return is("behind");
    if (!machine.autoUpdate) return is("skipped", "Update daemon automatically is off (K-626).");
    if (!isRelease(status.version)) return is("skipped", "It runs from source, not a release.");
    if (!machine.hasKey) return is("skipped", "It has no machine key, so it gets no jobs (K-1708).");
    return is("skipped", "It cannot update by itself; Update daemon in its panel installs it (K-622).");
  };
  const states = machines.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(machineState);
  const state =
    current && rollout.failed !== null
      ? "stopped"
      : states.some((machine) => ["updating", "waiting", "behind"].includes(machine.state))
        ? "running"
        : "done";
  return { version, protocol, state, machines: states };
}
