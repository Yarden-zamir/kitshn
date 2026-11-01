// K-722: a daemon that is not root runs exec as the provider's exec user through one narrow sudo rule, so a broken
// provider never blocks a repair. The daemon user holds the machine key, so running as that user is a step down.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { systemTool, toolProblem } from "./doors.ts";

export const EXEC_HELPER_PATH = "/usr/local/lib/kitshn/exec";
const SUDOERS_DIR = "/etc/sudoers.d";
const sudoersPath = (execUser: string) => `${SUDOERS_DIR}/kitshn-exec-${execUser}`;

/**
 * The helper runs one command in a folder as the user that sudo made. Its command gets its own process group. A
 * TERM, which sudo passes on, and the end of the command both kill that whole group: the daemon cannot signal
 * another user's processes itself.
 */
export const EXEC_HELPER = `#!/bin/sh
# kitshn exec helper (K-722): kitshn-exec <folder> <command>
case "$1" in
  ""|"~") cd || exit 126 ;;
  "~/"*) cd "$HOME/\${1#"~/"}" || exit 126 ;;
  *) cd "$1" || exit 126 ;;
esac
# sudo sets PATH to its secure_path, so the user's own tools come first, as in a run without sudo.
PATH="$HOME/.local/bin:$PATH"
export PATH
# The trap comes first, so a TERM right after the start still ends the group. Known limit: a TERM between the
# start and child=$! leaves the group; revisit if runs are killed in their first milliseconds in use.
child=
trap '[ -n "$child" ] && kill -KILL -$child 2>/dev/null; exit 137' TERM INT HUP
# Its own process group: setsid on Linux (dash ignores set -m in a script), set -m where setsid is missing.
# A background command gets /dev/null as stdin without job control, before its own redirections, so the stdin of
# the run waits on fd 3 and the command takes it from there (K-722).
exec 3<&0
if command -v setsid >/dev/null 2>&1; then
  setsid /bin/sh -c "$2" <&3 3<&- &
else
  set -m
  /bin/sh -c "$2" <&3 3<&- &
fi
exec 3<&-
child=$!
wait $child
status=$?
# A process that the command left in the background ends with it, so it holds no pipe of the run.
kill -KILL -$child 2>/dev/null
exit $status
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

/**
 * K-722: whether the daemon user may run the helper as `execUser` now; it runs `true` once, with no password. It
 * never blocks the daemon: a sudo that asks or hangs counts as no rule after 5 seconds.
 */
export function execSudoReady(execUser: string): Promise<boolean> {
  if (!existsSync(EXEC_HELPER_PATH)) return Promise.resolve(false);
  const [program = "", ...args] = execSudoArgv(execUser, "/", "true");
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: "ignore", timeout: 5_000 });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
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
