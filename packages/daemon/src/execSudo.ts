// K-722: a daemon that is not root runs exec as the provider's exec user through one narrow sudo rule, so a broken
// provider never blocks a repair. The daemon user holds the machine key, so running as that user is a step down.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemTool, toolProblem } from "./doors.ts";

export const EXEC_HELPER_PATH = "/usr/local/lib/kitshn/exec";
const SUDOERS_DIR = "/etc/sudoers.d";
const sudoersPath = (execUser: string) => `${SUDOERS_DIR}/kitshn-exec-${execUser}`;

/**
 * The helper runs one command in a folder as the user that sudo made. Its command gets its own process group, and a
 * TERM, which sudo passes on, kills that whole group: the daemon cannot signal another user's processes itself.
 */
export const EXEC_HELPER = `#!/bin/sh
# kitshn exec helper (K-722): kitshn-exec <folder> <command>
case "$1" in
  ""|"~") cd || exit 126 ;;
  "~/"*) cd "$HOME/\${1#"~/"}" || exit 126 ;;
  *) cd "$1" || exit 126 ;;
esac
set -m
/bin/sh -c "$2" &
child=$!
trap 'kill -KILL -- -$child 2>/dev/null; exit 137' TERM INT HUP
wait $child
`;

export const execSudoersLine = (daemonUser: string, execUser: string) =>
  `${daemonUser} ALL=(${execUser}) NOPASSWD: ${EXEC_HELPER_PATH}\n`;

/** The argv that runs `command` in `cwd` as `execUser` through the helper. */
export const execSudoArgv = (execUser: string, cwd: string | undefined, command: string) => [
  systemTool("sudo"),
  "-n",
  "-u",
  execUser,
  "--",
  EXEC_HELPER_PATH,
  cwd ?? "",
  command,
];

/** K-722: whether the daemon user may run the helper as `execUser` now; it runs `true` once, with no password. */
export function execSudoReady(execUser: string): boolean {
  if (!existsSync(EXEC_HELPER_PATH)) return false;
  const [program = "", ...args] = execSudoArgv(execUser, "/", "true");
  return spawnSync(program, args, { stdio: "ignore", timeout: 5_000 }).status === 0;
}

/** A Linux user name: a lower-case letter or `_` first, then letters, digits, `_` and `-`, at most 32. */
const FIRST_CHARS = "abcdefghijklmnopqrstuvwxyz_";
const NAME_CHARS = `${FIRST_CHARS}0123456789-`;
const isUserName = (name: string) =>
  name.length > 0 &&
  name.length <= 32 &&
  [...name].every((char, index) => (index === 0 ? FIRST_CHARS : NAME_CHARS).includes(char));

/** `kitshn exec install --user <exec user> --daemon-user <daemon user>` and `kitshn exec uninstall --user <exec user>`, as root. */
export function execCommand(
  action: string | undefined,
  execUser: string | undefined,
  daemonUser: string | undefined,
) {
  if (process.getuid?.() !== 0) throw new Error("run `kitshn exec install|uninstall` as root");
  if (!execUser || !isUserName(execUser))
    throw new Error(
      "usage: kitshn exec install --user <exec user> --daemon-user <daemon user> | kitshn exec uninstall --user <exec user>",
    );
  if (action === "uninstall") {
    rmSync(sudoersPath(execUser), { force: true });
    // The helper goes with the last rule.
    if (!readdirSync(SUDOERS_DIR).some((name) => name.startsWith("kitshn-exec-")))
      rmSync(EXEC_HELPER_PATH, { force: true });
    console.log(
      `kitshn: removed ${sudoersPath(execUser)}. Exec for ${execUser} now needs its provider's bridge.`,
    );
    return;
  }
  if (action !== "install" || !daemonUser || !isUserName(daemonUser))
    throw new Error("usage: kitshn exec install --user <exec user> --daemon-user <daemon user>");
  mkdirSync(dirname(EXEC_HELPER_PATH), { recursive: true, mode: 0o755 });
  writeFileSync(EXEC_HELPER_PATH, EXEC_HELPER, { mode: 0o755 });
  chmodSync(EXEC_HELPER_PATH, 0o755);
  const staged = `${sudoersPath(execUser)}.new`;
  writeFileSync(staged, execSudoersLine(daemonUser, execUser), { mode: 0o440 });
  const problem = toolProblem(
    "visudo",
    spawnSync(systemTool("visudo"), ["-cf", staged], { encoding: "utf8" }),
    "refused the sudoers line",
  );
  if (problem !== null) {
    rmSync(staged, { force: true });
    throw new Error(problem);
  }
  renameSync(staged, sudoersPath(execUser));
  console.log(
    `kitshn: installed ${EXEC_HELPER_PATH} and ${sudoersPath(execUser)}: ${daemonUser} runs exec as ${execUser}.`,
  );
}
