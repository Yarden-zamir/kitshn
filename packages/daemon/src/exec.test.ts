import { describe, expect, it } from "vitest";
import { type ExecEnd, OUTPUT_WINDOW, FRAME_BYTES, startExec } from "./exec.ts";

const platform = process.platform;

/** One run with a sink that records everything and resolves at the end. */
function run(command: string, more: { stdin?: boolean; timeoutMs?: number; grant?: boolean } = {}) {
  const out: Array<{ stream: string; text: string; bytes: number }> = [];
  const credits: Array<number> = [];
  const ended = Promise.withResolvers<ExecEnd>();
  let received = 0;
  const reached = new Map<number, () => void>();
  const handle = startExec(
    { command, timeoutMs: more.timeoutMs ?? 30_000, stdin: more.stdin ?? false, platform },
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

  it("stops at the output credit until the caller grants more, so no hop buffers more than the window", async () => {
    const big = 3 * OUTPUT_WINDOW;
    const slow = run(`head -c ${big} /dev/zero`, { grant: false });
    await slow.atLeast(OUTPUT_WINDOW - FRAME_BYTES);
    // Without credit the daemon stops reading; the rest waits in the pipe of the process.
    expect(slow.received()).toBeLessThanOrEqual(OUTPUT_WINDOW + 64 * 1024);
    slow.handle.credit(big);
    expect(await slow.ended).toMatchObject({ exitCode: 0 });
    expect(slow.received()).toBe(big);
    expect(Math.max(...slow.out.map((frame) => frame.bytes))).toBeLessThanOrEqual(FRAME_BYTES);
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
