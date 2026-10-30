// K-722: one exec run on this machine, for a run that another machine asked for through kitshn. The daemon runs it
// itself, or the bridge of a provider runs it as that provider's user. Output and stdin move under credit, so no hop
// buffers more than its window: a run without output credit stops reading, and its process blocks on a full pipe.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ExecFrame } from "@kitshn/local";
import { execSudoArgv } from "./execSudo.ts";

/** K-722: each run starts with this much output credit; the caller grants more with `exec-credit`. */
export const OUTPUT_WINDOW = 1024 * 1024;
/** K-722: each run starts with this much stdin credit; `exec-stdin-credit` gives back what the process took. */
export const STDIN_WINDOW = 64 * 1024;
/** K-722: the most bytes of one frame. */
export const FRAME_BYTES = 16 * 1024;

export interface ExecSpec {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly stdin: boolean;
  /** A user id to run as; only a root daemon sets one other than its own. */
  readonly uid?: number;
  /** A user to run as through the sudo rule of `kitshn exec install`, for a daemon that is not root. */
  readonly sudoUser?: string;
  readonly platform: NodeJS.Platform;
}

export interface ExecEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly reason: string | null;
}

export interface ExecSink {
  readonly output: (stream: "stdout" | "stderr", data: Uint8Array) => void;
  readonly stdinCredit: (bytes: number) => void;
  /** Exactly once, always last. */
  readonly exit: (end: ExecEnd) => void;
}

export interface ExecHandle {
  readonly credit: (bytes: number) => void;
  /** Writes one chunk of stdin; refuses one beyond the stdin credit. */
  readonly input: (data: Uint8Array) => void;
  readonly closeStdin: () => void;
  readonly kill: (reason: string) => void;
  /** Resolves when the main process exited; the run may still drain or wait for credit then. */
  readonly exited: Promise<void>;
}

interface Account {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  readonly home: string;
}

/** The account of a user id from `/etc/passwd`, for a root daemon that runs as that user. */
function accountOf(uid: number): Account | null {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const [name, , id, gid, , home] = line.split(":");
      if (name && Number(id) === uid) return { uid, gid: Number(gid), name, home: home || "/" };
    }
  } catch {
    // A machine without /etc/passwd runs no exec as another user.
  }
  return null;
}

/** `~` and `~/x` in the folder of a run are the home of the user that runs it. */
const folderOf = (cwd: string | undefined, home: string) =>
  cwd === undefined || cwd === "" || cwd === "~"
    ? home
    : cwd.startsWith("~/")
      ? `${home}${cwd.slice(1)}`
      : cwd;

/**
 * Changes to the folder as the user that runs the command, then runs it. The process starts in `/` and enters the
 * folder only after it dropped to that user, so a run never sees a folder that its user cannot enter.
 */
const IN_FOLDER = 'cd -- "$1" || exit 126; exec /bin/sh -c "$2"';

/** K-722: how long a run that exited may still deliver output that its pipes hold, before it ends anyway. */
export const DRAIN_MS = 2_000;

/** K-722: starts one run; `sink` gets its output under credit, the stdin credit it gives back, and its end. */
export function startExec(spec: ExecSpec, sink: ExecSink): ExecHandle {
  const started = Date.now();
  let ended = false;
  let reason: string | null = null;
  const end = (value: Omit<ExecEnd, "durationMs">) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    sink.exit({ ...value, durationMs: Date.now() - started });
  };
  const nothing: ExecHandle = {
    credit: () => {},
    input: () => {},
    closeStdin: () => {},
    kill: () => {},
    exited: Promise.resolve(),
  };
  const account = spec.uid === undefined ? null : accountOf(spec.uid);
  if (spec.uid !== undefined && !account) {
    queueMicrotask(() =>
      end({ exitCode: null, signal: null, reason: `this machine has no user id ${spec.uid}.` }),
    );
    return nothing;
  }
  const windows = spec.platform === "win32";
  const home = account?.home ?? homedir();
  const user = account?.name ?? process.env["USER"] ?? "";
  const [program = "", ...args] = spec.sudoUser
    ? execSudoArgv(spec.sudoUser, spec.cwd, spec.command)
    : windows
      ? ["powershell.exe", "-NoProfile", "-Command", spec.command]
      : ["/bin/sh", "-c", IN_FOLDER, "kitshn-exec", folderOf(spec.cwd, home), spec.command];
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawn(program, args, {
      cwd: windows ? folderOf(spec.cwd, home) : "/",
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so an exit, a timeout or a kill ends every process of the run, also one in the
      // background. Windows has no process groups; there only the main process ends (known limit).
      detached: !windows,
      ...(account ? { uid: account.uid, gid: account.gid } : {}),
      // The same small environment for every user, so a run never sees the daemon's own variables.
      env: windows
        ? process.env
        : {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: home,
            USER: user,
            LOGNAME: user,
            ...(process.env["LANG"] ? { LANG: process.env["LANG"] } : {}),
          },
    });
  } catch (error) {
    queueMicrotask(() =>
      end({ exitCode: null, signal: null, reason: `the run did not start: ${String(error)}` }),
    );
    return nothing;
  }
  /** Ends every process of the run. The daemon cannot signal the processes of a sudo run; its helper ends them. */
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (!windows && !spec.sudoUser && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The group is gone already.
    }
  };
  if (!spec.stdin) child.stdin.end();
  let credit = OUTPUT_WINDOW;
  let stdinCredit = STDIN_WINDOW;
  const streams = [child.stdout, child.stderr] as const;
  // Output beyond the credit waits here; the streams pause, so the process blocks on its full pipe.
  const queue: Array<{ readonly stream: "stdout" | "stderr"; readonly part: Uint8Array }> = [];
  let exited: Omit<ExecEnd, "durationMs"> | null = null;
  let open: number = streams.length;
  const maybeEnd = () => {
    if (exited !== null && open === 0 && queue.length === 0) end(exited);
  };
  const flush = () => {
    while (queue.length > 0 && credit > 0) {
      const { stream, part } = queue.shift()!;
      // Never more than the credit: the rest of a part waits at the head of the queue.
      if (part.length > credit) queue.unshift({ stream, part: part.subarray(credit) });
      const sent = part.subarray(0, credit);
      credit -= sent.length;
      sink.output(stream, sent);
    }
    // After the exit the pipes hold at most their buffers, so the rest is read into the queue.
    for (const each of streams)
      if (queue.length === 0 || exited !== null) each.resume();
      else each.pause();
    maybeEnd();
  };
  const pump = (stream: Readable, name: "stdout" | "stderr") => {
    stream.on("data", (chunk: Buffer) => {
      for (let start = 0; start < chunk.length; start += FRAME_BYTES)
        queue.push({ stream: name, part: chunk.subarray(start, start + FRAME_BYTES) });
      flush();
    });
    stream.once("close", () => {
      open--;
      maybeEnd();
    });
  };
  pump(child.stdout, "stdout");
  pump(child.stderr, "stderr");
  child.stdin.on("error", () => {});
  child.on("error", (error) =>
    end({ exitCode: null, signal: null, reason: `the run failed: ${error.message}` }),
  );
  // The run ends with its main process: the rest of its group goes, and the pipes drain for a short time. `close`
  // alone could wait forever for a process that left the group and holds a pipe.
  const exitedOnce = Promise.withResolvers<void>();
  child.on("exit", (code, signal) => {
    exitedOnce.resolve();
    killGroup("SIGKILL");
    exited =
      reason !== null
        ? { exitCode: null, signal: signal ?? "SIGKILL", reason }
        : { exitCode: signal ? null : code, signal: signal ?? null, reason };
    setTimeout(() => {
      for (const each of streams) each.destroy();
    }, DRAIN_MS).unref();
    flush();
  });
  /** After the exit: the output that waits is dropped, and the run ends now with the exit status and `why`. */
  const endAfterExit = (why: string) => {
    if (exited === null) return;
    exited = { ...exited, reason: why };
    queue.length = 0;
    for (const each of streams) each.destroy();
    open = 0;
    maybeEnd();
  };
  const kill = (why: string) => {
    if (ended || reason !== null) return;
    if (exited !== null) return endAfterExit(why);
    reason = why;
    if (!spec.sudoUser) return killGroup("SIGKILL");
    // sudo passes TERM on to the helper, which kills its group; sudo itself cannot pass on a KILL.
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };
  // A run that exited but whose caller takes no more output ends at its timeout too, with what it sent.
  const timer = setTimeout(
    () => kill(`timed out after ${Math.round(spec.timeoutMs / 1000)} s`),
    spec.timeoutMs,
  );
  return {
    credit: (bytes) => {
      credit += bytes;
      flush();
    },
    input: (data) => {
      if (!spec.stdin) throw new Error("this run has no stdin (K-722).");
      if (data.length > stdinCredit)
        throw new Error(
          `a stdin chunk of ${data.length} bytes is beyond the stdin credit of ${stdinCredit} (K-722).`,
        );
      stdinCredit -= data.length;
      child.stdin.write(data, () => {
        stdinCredit += data.length;
        sink.stdinCredit(data.length);
      });
    },
    closeStdin: () => child.stdin.end(),
    kill,
    exited: exitedOnce.promise,
  };
}

/**
 * K-722: applies one frame from A to a run on B. A frame that only B sends is a mistake of the relay and throws. A
 * stdin chunk beyond the credit throws too; the hub logs it, because A checks the same credit before it sends.
 */
export function applyFrame(run: ExecHandle, frame: ExecFrame): void {
  if (frame.type === "credit") return run.credit(frame.bytes);
  if (frame.type === "input") return run.input(Buffer.from(frame.data, "base64"));
  if (frame.type === "close")
    return frame.what === "stdin" ? run.closeStdin() : run.kill("killed by the caller");
  throw new Error(`a ${frame.type} frame goes from B to A, not to a run (K-722).`);
}
