// Shared by the exec tests: whether a process ended, on Linux without `ps` too.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** PF_EXITING in /proc/<pid>/stat: the kernel set it when the process began its exit. */
const PF_EXITING = 0x4;

/**
 * A process that ended: gone, a zombie that its new parent did not reap yet, or one in its exit. A killed process
 * closes its files, which ends the pipes of a run, in its exit, before it becomes a zombie; PF_EXITING is set before
 * that, so after the end of a pipe that it held this answer is never "alive".
 */
export const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  const stat = `/proc/${pid}/stat`;
  if (existsSync(stat)) {
    // The fields after the command name: state, ppid, pgrp, session, tty_nr, tpgid, flags.
    const fields = (readFileSync(stat, "utf8").split(") ")[1] ?? "").split(" ");
    return fields[0] === "Z" || fields[0] === "X" || (Number(fields[6]) & PF_EXITING) !== 0;
  }
  // macOS: Z is a zombie, and E a process in its exit.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state.startsWith("Z") || state.includes("E");
};
