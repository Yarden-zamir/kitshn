// K-620: the swap of the daemon binary at an update. On Windows a running .exe cannot be replaced, only renamed, and a
// virus scan can hold the new file open for a moment.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface SwapFiles {
  readonly rename: (from: string, to: string) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Each update renames the running binary to a name of its own, so an old copy that still runs never blocks one. */
export const oldBinaryName = (binary: string, now: number) =>
  join(dirname(binary), `${basename(binary, ".exe")}.old-${now}.exe`);

/**
 * The old copies of `binary` in its folder, which the next start deletes. K-629: the newest stays, because it is the
 * previous daemon, the way back of the last update.
 */
export function oldBinaries(binary: string, names: ReadonlyArray<string>): Array<string> {
  const prefix = `${basename(binary, ".exe")}.old-`;
  const old = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".exe"))
    .map((name) => ({ name, at: Number(name.slice(prefix.length, -".exe".length)) }))
    .toSorted((a, b) => a.at - b.at);
  return old.slice(0, -1).map(({ name }) => join(dirname(binary), name));
}

/** Where an update writes the new binary before the swap. Windows runs it for the start check, so it ends in .exe. */
export const nextBinaryName = (binary: string, windows: boolean) =>
  windows ? join(dirname(binary), `${basename(binary, ".exe")}.new.exe`) : `${binary}.new`;

/** K-629: the time that a new daemon has to reach kitshn before the previous one comes back. */
export const UPDATE_DEADLINE_MS = 5 * 60_000;
/** K-629: starts of the new daemon without an accepted connection, after which the next start rolls back. */
export const UPDATE_MAX_STARTS = 3;
/** K-629: how long the first accepted connection of a new daemon must stay up before it confirms the update. */
export const UPDATE_STABLE_MS = 3 * 60_000;

/** K-629: `<data>/update.json`, written before the swap and read by each start until kitshn accepts the new daemon. */
export interface UpdateMarker {
  readonly jobId: number;
  readonly from: string;
  readonly to: string;
  /** The previous binary: `kitshn.old` beside the binary, or `kitshn.old-<time>.exe` on Windows (K-620). */
  readonly previous: string;
  readonly deadline: number;
  /** Starts of the new daemon so far. */
  readonly starts: number;
  readonly state: "pending" | "rolled-back";
  readonly reason?: string;
  /** How the new daemon last ended, from its exit log (K-622), so the rollback names it. */
  readonly lastExit?: string;
  /** K-636: the providers that were online before the swap; each must be online again before `done`. */
  readonly providers?: ReadonlyArray<string>;
}

export function parseMarker(value: unknown): UpdateMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const marker = value as Record<string, unknown>;
  if (
    typeof marker["jobId"] !== "number" ||
    typeof marker["from"] !== "string" ||
    typeof marker["to"] !== "string" ||
    typeof marker["previous"] !== "string" ||
    typeof marker["deadline"] !== "number" ||
    (marker["state"] !== "pending" && marker["state"] !== "rolled-back")
  )
    return null;
  return {
    jobId: marker["jobId"],
    from: marker["from"],
    to: marker["to"],
    previous: marker["previous"],
    deadline: marker["deadline"],
    starts: typeof marker["starts"] === "number" ? marker["starts"] : 0,
    state: marker["state"],
    ...(typeof marker["reason"] === "string" ? { reason: marker["reason"] } : {}),
    ...(typeof marker["lastExit"] === "string" ? { lastExit: marker["lastExit"] } : {}),
    ...(Array.isArray(marker["providers"])
      ? { providers: marker["providers"].filter((name): name is string => typeof name === "string") }
      : {}),
  };
}

export const markerPath = (data: string) => join(data, "update.json");

/** A marker that does not parse is dropped with a log line, so it never stops the daemon from starting. */
export function readMarker(data: string, log: (text: string) => void): UpdateMarker | null {
  const file = markerPath(data);
  if (!existsSync(file)) return null;
  try {
    const marker = parseMarker(JSON.parse(readFileSync(file, "utf8")));
    if (marker) return marker;
  } catch {
    // Logged below.
  }
  log(`${file} does not parse; kitshn drops it`);
  rmSync(file, { force: true });
  return null;
}

export function writeMarker(data: string, marker: UpdateMarker) {
  mkdirSync(data, { recursive: true });
  writeFileSync(markerPath(data), JSON.stringify(marker));
}

/**
 * K-629: the first step of every start, before the rest of the daemon loads. A new daemon past its deadline or after
 * UPDATE_MAX_STARTS starts without an accepted connection rolls back at once; any other start of it counts.
 */
export type GateStep =
  | { readonly kind: "none" }
  | { readonly kind: "count"; readonly marker: UpdateMarker }
  | { readonly kind: "roll-back"; readonly reason: string };

export function gateStep(marker: UpdateMarker | null, version: string, now: number): GateStep {
  if (marker === null || marker.state !== "pending" || version !== marker.to) return { kind: "none" };
  const ended = marker.lastExit ? ` It last ended: ${marker.lastExit}` : "";
  if (marker.starts >= UPDATE_MAX_STARTS)
    return {
      kind: "roll-back",
      reason: `The new daemon started ${marker.starts} times without reaching kitshn.${ended}`,
    };
  if (now >= marker.deadline)
    return { kind: "roll-back", reason: `The new daemon did not reach kitshn within 5 minutes.${ended}` };
  return { kind: "count", marker: { ...marker, starts: marker.starts + 1 } };
}

/** K-629: what the running daemon does with the marker after the gate let it start. */
export type RunStep =
  | { readonly kind: "none" }
  /** The new daemon runs: it reports the update once kitshn accepts it, or rolls back at the deadline. */
  | { readonly kind: "wait"; readonly jobId: number; readonly deadline: number }
  /** The previous daemon runs again, so it reports why the update failed. */
  | { readonly kind: "report"; readonly jobId: number; readonly reason: string };

export function runStep(marker: UpdateMarker | null, version: string): RunStep {
  if (marker === null) return { kind: "none" };
  if (marker.state === "rolled-back")
    return { kind: "report", jobId: marker.jobId, reason: marker.reason ?? "The previous daemon came back." };
  if (version !== marker.to)
    return {
      kind: "report",
      jobId: marker.jobId,
      reason: `The daemon started on ${version}, not on edge-${marker.to}.`,
    };
  return { kind: "wait", jobId: marker.jobId, deadline: marker.deadline };
}

/**
 * K-636: why the new daemon must not confirm its update: a provider that was online before the swap is refused or not
 * online now. Null when each one is back. A provider refused only for its older major (`olderMajor`) counts as back:
 * it connected again, and it waits for its own release after a major bump (K-724).
 */
export function providersBack(
  before: ReadonlyArray<string>,
  states: ReadonlyArray<{ readonly name: string; readonly online: boolean; readonly refusal: string | null }>,
  olderMajor: ReadonlySet<string>,
): string | null {
  for (const provider of before) {
    const state = states.find((item) => item.name === provider);
    if (state?.online === true || olderMajor.has(provider)) continue;
    if (state?.refusal) return `The new daemon refused the provider ${provider}: ${state.refusal}`;
    return `The provider ${provider} did not register again within 3 minutes.`;
  }
  return null;
}

/**
 * K-629: puts the previous binary back in place of the running one. Unix replaces a running binary with one rename;
 * Windows renames the running .exe out of the way first (K-620).
 */
export async function restorePrevious(
  files: SwapFiles,
  binary: string,
  previous: string,
  windows: boolean,
  now: number,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  if (windows) await swapBinary(files, binary, previous, oldBinaryName(binary, now), 5, sleep);
  else files.rename(previous, binary);
}

/** K-629: the file work of an update, so a test runs it on a fake folder. */
export interface InstallFiles extends SwapFiles {
  readonly copy: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  /** Runs `<binary> version`; the release that it prints, or why it did not run. */
  readonly version: (
    binary: string,
  ) => { readonly ok: true; readonly version: string } | { readonly ok: false; readonly error: string };
  readonly writeMarker: (marker: UpdateMarker) => void;
  readonly removeMarker: () => void;
}

/**
 * K-629: puts the downloaded binary `next` in place of `binary` after it passed the start check, keeps the previous
 * one, and writes the marker first. Returns why it did not, with `binary` as it was.
 */
export async function installUpdate(
  files: InstallFiles,
  input: {
    readonly binary: string;
    readonly next: string;
    readonly windows: boolean;
    readonly jobId: number;
    readonly from: string;
    readonly to: string;
    readonly now: number;
    /** K-636: the providers online now, which the new daemon checks before it confirms. */
    readonly providers: ReadonlyArray<string>;
  },
): Promise<string | null> {
  // The previous binary is the way back, so the running release never replaces it.
  if (input.to === input.from) {
    files.remove(input.next);
    return `The daemon runs edge-${input.to} already.`;
  }
  const check = files.version(input.next);
  if (!check.ok || check.version !== input.to) {
    files.remove(input.next);
    return `The new daemon failed its start check (${check.ok ? `it names ${check.version}` : check.error}).`;
  }
  const previous = input.windows ? oldBinaryName(input.binary, input.now) : `${input.binary}.old`;
  files.writeMarker({
    jobId: input.jobId,
    from: input.from,
    to: input.to,
    previous,
    deadline: input.now + UPDATE_DEADLINE_MS,
    starts: 0,
    state: "pending",
    providers: input.providers,
  });
  try {
    if (input.windows) await swapBinary(files, input.binary, input.next, previous);
    else {
      files.copy(input.binary, previous);
      files.rename(input.next, input.binary);
    }
  } catch (error) {
    files.removeMarker();
    return `The update failed: ${String(error)}`;
  }
  return null;
}

/**
 * Puts `next` in place of the running `binary`, keeping it as `old` until the new one runs. A failed rename of `next`
 * is tried again; when it still fails, `old` goes back to `binary`, so the task always finds a binary. Throws with
 * what happened.
 */
export async function swapBinary(
  files: SwapFiles,
  binary: string,
  next: string,
  old: string,
  tries = 5,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  /** The error of the last try, or null when one try worked. */
  const retry = async (from: string, to: string): Promise<unknown> => {
    let last: unknown = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        files.rename(from, to);
        return null;
      } catch (error) {
        last = error;
        if (attempt < tries) await sleep(500 * attempt);
      }
    }
    return last;
  };
  files.rename(binary, old);
  const failed = await retry(next, binary);
  if (failed === null) return;
  if ((await retry(old, binary)) === null)
    throw new Error(`the new binary did not go in place (${String(failed)}); the old one is back.`);
  throw new Error(
    `the new binary did not go in place (${String(failed)}), and the old one could not go back: it is at ${old}.`,
  );
}

/**
 * K-629: the connection of a new daemon closed before it stayed up for UPDATE_STABLE_MS. That counts as a failed start:
 * after UPDATE_MAX_STARTS of them it rolls back, else it has 5 more minutes to reach kitshn.
 */
export function dropStep(
  marker: UpdateMarker,
  now: number,
):
  | { readonly kind: "roll-back"; readonly reason: string }
  | { readonly kind: "wait"; readonly marker: UpdateMarker } {
  const starts = marker.starts + 1;
  if (starts >= UPDATE_MAX_STARTS)
    return {
      kind: "roll-back",
      reason: `The connection of the new daemon to kitshn dropped ${starts} times within ${UPDATE_STABLE_MS / 60_000} minutes.`,
    };
  return { kind: "wait", marker: { ...marker, starts, deadline: now + UPDATE_DEADLINE_MS } };
}

/** K-629: the file work of the start gate, so a test runs it on a fake folder. */
export interface GateFiles extends SwapFiles {
  readonly read: () => UpdateMarker | null;
  readonly write: (marker: UpdateMarker) => void;
  readonly exists: (path: string) => boolean;
}

/**
 * K-629: the start gate of `kitshn run`. Returns "restart" when the previous daemon is back in place, so this start
 * ends; "start" otherwise. A marker that cannot be written (a full disk) restores the previous binary at once when it
 * exists, so the gate never loops on the same failed write.
 */
export async function runGate(
  files: GateFiles,
  input: {
    readonly binary: string;
    readonly version: string;
    readonly windows: boolean;
    readonly now: number;
    readonly log: (text: string) => void;
  },
): Promise<"start" | "restart"> {
  const marker = files.read();
  const step = gateStep(marker, input.version, input.now);
  if (step.kind === "none" || marker === null) return "start";
  let reason: string;
  if (step.kind === "count") {
    try {
      files.write(step.marker);
      return "start";
    } catch (error) {
      reason = `kitshn could not write update.json (${String(error)}).`;
    }
  } else reason = step.reason;
  if (!files.exists(marker.previous)) {
    input.log(
      `the update to edge-${marker.to} failed: ${reason} No previous daemon is at ${marker.previous}.`,
    );
    return "start";
  }
  input.log(`the update to edge-${marker.to} failed: ${reason} edge-${marker.from} comes back.`);
  try {
    files.write({ ...marker, state: "rolled-back", reason });
  } catch (error) {
    // The previous daemon then reports that it started on another release than the marker names.
    input.log(`update.json was not written: ${String(error)}`);
  }
  try {
    await restorePrevious(files, input.binary, marker.previous, input.windows, input.now);
  } catch (error) {
    input.log(`the previous daemon could not come back: ${String(error)}`);
    try {
      files.write({
        ...marker,
        state: "rolled-back",
        reason: `${reason} The previous daemon could not come back: ${String(error)}`,
      });
    } catch {
      // Logged above; this daemon keeps running.
    }
    return "start";
  }
  return "restart";
}

/** K-629: one line about how a daemon ended, for `lastExit`: the code and the first line of the reason. */
export function exitText(code: number, reason: string): string {
  const first = reason.trim().split("\n")[0]?.trim() ?? "";
  return (first ? `exit code ${code}, ${first}` : `exit code ${code}`).slice(0, 300);
}
