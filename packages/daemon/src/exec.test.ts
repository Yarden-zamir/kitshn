import { homedir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { gone } from "./processes.testing.ts";
import { type ExecEnd, OUTPUT_WINDOW, FRAME_BYTES, startExec } from "./exec.ts";

const platform = process.platform;

/** One run with a sink that records everything and resolves at the end. */
function run(
  command: string,
  more: { stdin?: boolean; timeoutMs?: number; grant?: boolean; cwd?: string; uid?: number } = {},
) {
  const out: Array<{ stream: string; text: string; bytes: number }> = [];
  const credits: Array<number> = [];
  const ended = Promise.withResolvers<ExecEnd>();
  let received = 0;
  const reached = new Map<number, () => void>();
  const handle = startExec(
    {
      command,
      timeoutMs: more.timeoutMs ?? 30_000,
      stdin: more.stdin ?? false,
      platform,
      ...(more.cwd === undefined ? {} : { cwd: more.cwd }),
      ...(more.uid === undefined ? {} : { uid: more.uid }),
    },
    {
      output: (stream, data) => {
        received += data.length;
        out.push({ stream, text: Buffer.from(data).toString(), bytes: data.length });
        if (more.grant !== false) handle.credit(data.length);
        for (const [at, wake] of reached) if (received >= at) wake();
      },
      stdinCredit: (bytes) => credits.push(bytes),
      exit: ended.resolve,
    },
  );
  const atLeast = (bytes: number) => {
    const wait = Promise.withResolvers<void>();
    reached.set(bytes, wait.resolve);
    if (received >= bytes) wait.resolve();
    return wait.promise;
  };
  return { handle, out, credits, ended: ended.promise, received: () => received, atLeast };
}

describe("an exec run (K-722)", () => {
  it("streams stdout and stderr and ends with the exit code; a signal ends it with no code (C-13)", async () => {
    const ok = run("echo hi; echo oops 1>&2; exit 3");
    expect(await ok.ended).toMatchObject({ exitCode: 3, signal: null, reason: null });
    expect(ok.out.map((frame) => [frame.stream, frame.text])).toEqual(
      expect.arrayContaining([
        ["stdout", "hi\n"],
        ["stderr", "oops\n"],
      ]),
    );
    const killed = run("sleep 30", { timeoutMs: 50 });
    expect(await killed.ended).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      reason: "timed out after 0 s",
    });
  });

  it("finds the tools of the user's ~/.local/bin and the daemon's folder first, as a login shell does", async () => {
    const path = run('printf %s "$PATH"');
    await path.ended;
    const parts = path.out
      .map((frame) => frame.text)
      .join("")
      .split(":");
    expect(parts.slice(0, 2)).toEqual([`${homedir()}/.local/bin`, dirname(process.execPath)]);
    expect(new Set(parts).size).toBe(parts.length);
  });

  it("ends with its main process and ends what it left in the background, also at a timeout (C-13)", async () => {
    const left = run("sleep 30 & echo $!; exit 0");
    expect(await left.ended).toMatchObject({ exitCode: 0, signal: null });
    const pid = Number(
      left.out
        .map((frame) => frame.text)
        .join("")
        .trim(),
    );
    expect(gone(pid)).toBe(true);
    const both = run("sleep 30 & echo $!; sleep 30", { timeoutMs: 100 });
    expect(await both.ended).toMatchObject({
      exitCode: null,
      signal: "SIGKILL",
      reason: "timed out after 0 s",
    });
    const text = (frames: typeof both.out) =>
      frames
        .map((frame) => frame.text)
        .join("")
        .trim();
    expect(gone(Number(text(both.out)))).toBe(true);
  });

  it("runs in the folder that it names, and ends a run in a folder that does not exist with 126", async () => {
    const root = run("pwd -P", { cwd: "/" });
    await root.ended;
    expect(root.out.map((frame) => frame.text).join("")).toBe("/\n");
    expect(await run("true", { cwd: "/no/such/folder" }).ended).toMatchObject({ exitCode: 126 });
  });

  it("stops at the output credit until the caller grants more, so no hop buffers more than the window", async () => {
    const big = 3 * OUTPUT_WINDOW;
    const slow = run(`head -c ${big} /dev/zero`, { grant: false });
    await slow.atLeast(OUTPUT_WINDOW - FRAME_BYTES);
    // Without credit the daemon stops reading; the rest waits in the pipe of the process.
    expect(slow.received()).toBeLessThanOrEqual(OUTPUT_WINDOW + FRAME_BYTES);
    slow.handle.credit(big);
    expect(await slow.ended).toMatchObject({ exitCode: 0 });
    expect(slow.received()).toBe(big);
    expect(Math.max(...slow.out.map((frame) => frame.bytes))).toBeLessThanOrEqual(FRAME_BYTES);
  });

  it("sends no byte beyond the credit, and ends at once on a kill after the exit while output waits for credit", async () => {
    const big = OUTPUT_WINDOW + 30_000;
    const waiting = run(`head -c ${big} /dev/zero`, { grant: false, timeoutMs: 600_000 });
    await waiting.atLeast(OUTPUT_WINDOW);
    expect(waiting.received()).toBe(OUTPUT_WINDOW);
    waiting.handle.credit(1);
    // The byte goes when the pipe has it; then no byte beyond the credit follows.
    await waiting.atLeast(OUTPUT_WINDOW + 1);
    expect(waiting.received()).toBe(OUTPUT_WINDOW + 1);
    // The process exited; its last 30,000 bytes wait for credit that never comes.
    await waiting.handle.exited;
    waiting.handle.kill("killed by the caller");
    expect(await waiting.ended).toMatchObject({ exitCode: 0, reason: "killed by the caller" });
  });

  it("ends a run that never starts with its reason: an unknown user id, and a spawn that throws", async () => {
    expect(await run("true", { uid: 2_147_483_000 }).ended).toMatchObject({
      exitCode: null,
      reason: "this machine has no user id 2147483000.",
    });
    // A NUL byte in an argument makes spawn throw at once.
    expect(await run("echo a\0b").ended).toMatchObject({
      exitCode: null,
      reason: expect.stringMatching(/^the run did not start/),
    });
  });

  it("writes stdin under credit, gives the credit back, and ends stdin on close", async () => {
    const cat = run("cat", { stdin: true });
    cat.handle.input(Buffer.from("hello"));
    expect(() => cat.handle.input(new Uint8Array(65 * 1024))).toThrow(/beyond the stdin credit/);
    cat.handle.closeStdin();
    expect(await cat.ended).toMatchObject({ exitCode: 0 });
    expect(cat.out.map((frame) => frame.text).join("")).toBe("hello");
    expect(cat.credits).toEqual([5]);
    const none = run("true");
    expect(() => none.handle.input(Buffer.from("x"))).toThrow(/no stdin/);
    await none.ended;
  });
});
