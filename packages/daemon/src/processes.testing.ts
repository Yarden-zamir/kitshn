// Shared by the exec tests: whether a process ended, on Linux without `ps` too.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** A process that ended: gone, or a zombie that its new parent did not reap yet. */
export const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  const stat = `/proc/${pid}/stat`;
  if (existsSync(stat)) return readFileSync(stat, "utf8").split(") ")[1]?.startsWith("Z") === true;
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
    .stdout.trim()
    .startsWith("Z");
};
