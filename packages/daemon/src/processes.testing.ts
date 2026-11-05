// Shared by the exec tests: whether a process ended, on Linux without `ps` too.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** PF_EXITING in /proc/<pid>/stat: the kernel set it when the process began its exit. */
const PF_EXITING = 0x4;

/** The fields of /proc/<pid>/stat after the command name, or null when the process went meanwhile. */
function procFields(pid: number): Array<string> | null {
  try {
    return (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1] ?? "").split(" ");
  } catch {
    return null;
  }
}

/**
 * A process that ended: gone, a zombie that its new parent did not reap yet, or one in its exit. A killed process
 * closes its files, which ends the pipes of a run, in its exit, before it becomes a zombie, and the kernel marks the
 * exit before that, so after the end of a pipe that it held this answer is never "alive". Each source that finds no
 * process counts as gone, because the parent can reap it between two reads. Known limit: macOS has no /proc, so
 * there `ps` decides: Z for a zombie, E for a process in its exit.
 */
export const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform === "linux") {
    // The fields: state, ppid, pgrp, session, tty_nr, tpgid, flags.
    const fields = procFields(pid);
    return fields === null || ["Z", "X"].includes(fields[0] ?? "") || (Number(fields[6]) & PF_EXITING) !== 0;
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state === "" || state.startsWith("Z") || state.includes("E");
};
