import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gone } from "./processes.testing.ts";
import { EXEC_HELPER, execSudoersLine } from "./execSudo.ts";

const helper = join(mkdtempSync(join(tmpdir(), "kitshn-exec-")), "exec");
writeFileSync(helper, EXEC_HELPER, { mode: 0o755 });

/** Runs the helper as sudo would, with `home` as HOME; resolves with its output and exit code. */
function run(folder: string, command: string, home: string, onStart?: (pid: number) => void) {
  return new Promise<{ output: string; code: number | null }>((resolve) => {
    const child = spawn(helper, [folder, command], { env: { HOME: home, PATH: process.env["PATH"] } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += String(chunk);
      if (onStart && output.includes("\n")) onStart(child.pid!);
    });
    child.on("close", (code) => resolve({ output, code }));
  });
}

describe("the exec helper of the sudo rule (K-722)", () => {
  it("allows only the helper, as only the exec user", () => {
    expect(execSudoersLine("kitshn", "t3")).toBe("kitshn ALL=(t3) NOPASSWD: /usr/local/lib/kitshn/exec\n");
  });

  it("runs in the home of the exec user for ~ and ~/x, and passes the exit code on", async () => {
    const home = mkdtempSync(join(tmpdir(), "kitshn-home-"));
    expect(await run("~", "pwd -P; exit 3", home)).toEqual({
      output: expect.stringContaining(home.split("/").at(-1)!),
      code: 3,
    });
    expect((await run("~/missing", "true", home)).code).toBe(126);
  });

  it("ends a process that the command left in the background when the command exits", async () => {
    const ended = await run("/", "sleep 30 & echo $!; exit 0", tmpdir());
    expect(ended.code).toBe(0);
    expect(gone(Number(ended.output.trim()))).toBe(true);
  });

  it("ends the whole command group on TERM, which sudo passes on", async () => {
    const ended = await run("/", "sleep 30 & echo $!; wait", tmpdir(), (pid) => process.kill(pid, "SIGTERM"));
    const child = Number(ended.output.trim());
    expect(ended.code).toBe(137);
    expect(gone(child)).toBe(true);
  });
});
