// K-722: one exec run on this machine, for a run that another machine asked for through kitshn. The daemon runs it
// itself, or the bridge of a provider runs it as that provider's user. Output and stdin move under credit, so no hop
// buffers more than its window: a run without output credit stops reading, and its process blocks on a full pipe.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ExecFrame } from "@kitshn/local";

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
  const account = spec.uid === undefined ? null : accountOf(spec.uid);
  if (spec.uid !== undefined && !account) {
    queueMicrotask(() =>
      end({ exitCode: null, signal: null, reason: `this machine has no user id ${spec.uid}.` }),
    );
    return { credit: () => {}, input: () => {}, closeStdin: () => {}, kill: () => {} };
  }
  const home = account?.home ?? homedir();
  const [program, args] =
    spec.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-Command", spec.command]]
      : ["/bin/sh", ["-c", spec.command]];
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  try {
    child = spawn(program, args, {
      cwd: folderOf(spec.cwd, home),
      stdio: ["pipe", "pipe", "pipe"],
      ...(account
        ? {
            uid: account.uid,
            gid: account.gid,
            env: {
              PATH: process.env["PATH"] ?? "/usr/bin:/bin",
              HOME: account.home,
              USER: account.name,
              LOGNAME: account.name,
            },
          }
        : {}),
    });
  } catch (error) {
    queueMicrotask(() =>
      end({ exitCode: null, signal: null, reason: `the run did not start: ${String(error)}` }),
    );
    return { credit: () => {}, input: () => {}, closeStdin: () => {}, kill: () => {} };
  }
  if (!spec.stdin) child.stdin.end();
  let credit = OUTPUT_WINDOW;
  let stdinCredit = STDIN_WINDOW;
  const streams = [child.stdout, child.stderr] as const;
  const pump = (stream: Readable, name: "stdout" | "stderr") =>
    stream.on("data", (chunk: Buffer) => {
      for (let start = 0; start < chunk.length; start += FRAME_BYTES) {
        const part = chunk.subarray(start, start + FRAME_BYTES);
        credit -= part.length;
        sink.output(name, part);
      }
      if (credit <= 0) for (const each of streams) each.pause();
    });
  pump(child.stdout, "stdout");
  pump(child.stderr, "stderr");
  child.stdin.on("error", () => {});
  child.on("error", (error) =>
    end({ exitCode: null, signal: null, reason: `the run failed: ${error.message}` }),
  );
  child.on("close", (code, signal) =>
    end({ exitCode: signal ? null : code, signal: signal ?? null, reason }),
  );
  const kill = (why: string) => {
    if (ended) return;
    reason = why;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(
    () => kill(`timed out after ${Math.round(spec.timeoutMs / 1000)} s`),
    spec.timeoutMs,
  );
  return {
    credit: (bytes) => {
      credit += bytes;
      if (credit > 0) for (const each of streams) each.resume();
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
  };
}

/**
 * K-722: applies one frame from A to a run on B. A frame that only B sends is a mistake of the relay and throws. A
 * stdin chunk beyond the credit throws too, so its sender gets the error.
 */
export function applyFrame(run: ExecHandle, frame: ExecFrame): void {
  if (frame.type === "credit") return run.credit(frame.bytes);
  if (frame.type === "input") return run.input(Buffer.from(frame.data, "base64"));
  if (frame.type === "close")
    return frame.what === "stdin" ? run.closeStdin() : run.kill("killed by the caller");
  throw new Error(`a ${frame.type} frame goes from B to A, not to a run (K-722).`);
}
