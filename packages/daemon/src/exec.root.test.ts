// K-722: a root daemon runs a command as the exec user and enters its folder only as that user. Only root can run
// this; CI runs it with sudo, and it skips for any other user.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ExecEnd, startExec } from "./exec.ts";

const NOBODY = 65534;

function run(command: string, cwd: string) {
  let output = "";
  const ended = Promise.withResolvers<ExecEnd>();
  startExec(
    { command, cwd, timeoutMs: 10_000, stdin: false, uid: NOBODY, platform: process.platform },
    {
      output: (_stream, data) => (output += Buffer.from(data).toString()),
      stdinCredit: () => {},
      exit: ended.resolve,
    },
  );
  return ended.promise.then((end) => ({ end, output }));
}

describe.runIf(process.getuid?.() === 0 && process.platform === "linux")(
  "exec as another user, from root (K-722)",
  () => {
    it("never enters a folder that only root can enter, and runs with the user's ids and no groups of root", async () => {
      const root = mkdtempSync("/root/kitshn-exec-");
      const locked = join(root, "locked");
      mkdirSync(join(locked, "open"), { recursive: true });
      chmodSync(locked, 0o700);
      chmodSync(join(locked, "open"), 0o755);
      writeFileSync(join(locked, "open", "secret"), "root only");
      const inside = await run("cat secret", join(locked, "open"));
      expect(inside.end.exitCode).toBe(126);
      expect(inside.output).not.toContain("root only");
      const ids = await run("id -u; id -G", "/");
      expect(ids.output.split("\n").slice(0, 2)).toEqual([
        String(NOBODY),
        expect.not.stringMatching(/(^| )0( |$)/),
      ]);
    });
  },
);
