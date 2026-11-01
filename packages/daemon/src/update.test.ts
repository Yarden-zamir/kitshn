import { describe, expect, it } from "vitest";
import {
  type GateFiles,
  type InstallFiles,
  type UpdateMarker,
  dropStep,
  exitText,
  gateStep,
  installUpdate,
  oldBinaries,
  parseMarker,
  providersBack,
  restorePrevious,
  runGate,
  runStep,
  swapBinary,
} from "./update.ts";

/** Files by name; `busy` names files whose rename fails that many times. */
function folder(names: ReadonlyArray<string>, busy: Record<string, number> = {}) {
  const files = new Set(names);
  const left = { ...busy };
  return {
    files,
    rename(from: string, to: string) {
      if ((left[from] ?? 0) > 0) {
        left[from] = (left[from] ?? 0) - 1;
        throw new Error(`EBUSY ${from}`);
      }
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.add(to);
    },
  };
}
const none = async () => {};

describe("the binary swap of an update (K-620)", () => {
  it("puts the new binary in place and keeps the old one", async () => {
    const files = folder(["k.exe", "k.exe.new"]);
    await swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none);
    expect([...files.files].sort()).toEqual(["k.exe", "k.old-1.exe"]);
  });

  it("tries again while a scan holds the new file", async () => {
    const files = folder(["k.exe", "k.exe.new"], { "k.exe.new": 3 });
    await swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none);
    expect(files.files.has("k.exe")).toBe(true);
  });

  it("puts the old binary back when the new one never goes in place, so the task finds a binary", async () => {
    const files = folder(["k.exe", "k.exe.new"], { "k.exe.new": 99 });
    await expect(swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none)).rejects.toThrow(
      /the old one is back/,
    );
    expect(files.files.has("k.exe")).toBe(true);
    expect(files.files.has("k.old-1.exe")).toBe(false);
  });

  it("finds only the old copies of its own binary, and keeps the newest as the way back (K-629)", () => {
    expect(
      oldBinaries("/p/kitshn.exe", [
        "kitshn.exe",
        "kitshn.old-10.exe",
        "kitshn.old-9.exe",
        "kitshn.old-2.exe",
        "other.old-1.exe",
      ]),
    ).toEqual(["/p/kitshn.old-2.exe", "/p/kitshn.old-9.exe"]);
  });
});

describe("the way back of an update (K-629)", () => {
  const marker: UpdateMarker = {
    jobId: 7,
    from: "bbbbbbbbbbbb",
    to: "aaaaaaaaaaaa",
    previous: "/p/kitshn.old",
    deadline: 1000,
    starts: 0,
    state: "pending",
  };

  it("counts each start of the new daemon before the deadline", () => {
    expect(gateStep(marker, marker.to, 999)).toEqual({ kind: "count", marker: { ...marker, starts: 1 } });
    expect(runStep({ ...marker, starts: 1 }, marker.to)).toEqual({ kind: "wait", jobId: 7, deadline: 1000 });
  });

  it("rolls back at the first start after the deadline", () => {
    expect(gateStep(marker, marker.to, 1000)).toEqual({
      kind: "roll-back",
      reason: "The new daemon did not reach kitshn within 5 minutes.",
    });
  });

  it("rolls back at once after 3 starts without an accepted connection, before the deadline", () => {
    expect(gateStep({ ...marker, starts: 3 }, marker.to, 1)).toEqual({
      kind: "roll-back",
      reason: "The new daemon started 3 times without reaching kitshn.",
    });
  });

  it("names how the new daemon last ended in its rollback, so the card shows why (K-622)", () => {
    const lastExit = exitText(
      1,
      "Error: listen EACCES \\\\.\\pipe\\kitshn-ya\n    at listenLocal (main.ts:1:1)",
    );
    expect(lastExit).toBe("exit code 1, Error: listen EACCES \\\\.\\pipe\\kitshn-ya");
    expect(gateStep({ ...marker, starts: 3, lastExit }, marker.to, 1)).toEqual({
      kind: "roll-back",
      reason: `The new daemon started 3 times without reaching kitshn. It last ended: ${lastExit}`,
    });
  });

  it("counts a connection that dropped within 3 minutes as a failed start, and rolls back at the third", () => {
    expect(dropStep({ ...marker, starts: 1 }, 50)).toEqual({
      kind: "wait",
      marker: { ...marker, starts: 2, deadline: 50 + 5 * 60_000 },
    });
    expect(dropStep({ ...marker, starts: 2 }, 50)).toEqual({
      kind: "roll-back",
      reason: "The connection of the new daemon to kitshn dropped 3 times within 3 minutes.",
    });
  });

  it("restores the previous binary at once when the gate cannot write update.json", async () => {
    const files = folder(["/p/kitshn", "/p/kitshn.old"]);
    const gate: GateFiles = {
      ...files,
      read: () => marker,
      write: () => {
        throw new Error("ENOSPC");
      },
      exists: (path) => files.files.has(path),
    };
    const input = { binary: "/p/kitshn", version: marker.to, windows: false, now: 0, log: () => {} };
    expect(await runGate(gate, input)).toBe("restart");
    expect([...files.files]).toEqual(["/p/kitshn"]);
    // Without a previous binary, the daemon starts; there is nothing to go back to.
    const bare = folder(["/p/kitshn"]);
    expect(await runGate({ ...gate, ...bare, exists: (path) => bare.files.has(path) }, input)).toBe("start");
  });

  it("lets the previous daemon start, which reports why", () => {
    const back = { ...marker, state: "rolled-back" as const, reason: "The new daemon crashed." };
    expect(gateStep(back, marker.from, 2000)).toEqual({ kind: "none" });
    expect(runStep(back, marker.from)).toEqual({
      kind: "report",
      jobId: 7,
      reason: "The new daemon crashed.",
    });
  });

  it("puts the previous binary back on Linux and macOS", async () => {
    const files = folder(["/p/kitshn", "/p/kitshn.old"]);
    await restorePrevious(files, "/p/kitshn", marker.previous, false, 2000, none);
    expect([...files.files]).toEqual(["/p/kitshn"]);
  });

  it("swaps the previous .exe back on Windows, keeping the failed one aside (K-620)", async () => {
    const files = folder(["k.exe", "k.old-1.exe"]);
    await restorePrevious(files, "k.exe", "k.old-1.exe", true, 2, none);
    expect([...files.files].sort()).toEqual(["k.exe", "k.old-2.exe"]);
  });
});

describe("the install of an update (K-629)", () => {
  /** The fake folder, with a start check that prints `printed` or fails, and the marker writes. */
  function install(printed: string | null, from = "bbbbbbbbbbbb") {
    const files = folder(["/p/kitshn", "/p/kitshn.new"]);
    const markers: Array<UpdateMarker | null> = [];
    const ops: InstallFiles = {
      ...files,
      copy: (_, to) => void files.files.add(to),
      remove: (path) => void files.files.delete(path),
      version: () =>
        printed === null ? { ok: false, error: "exit 1, segfault" } : { ok: true, version: printed },
      writeMarker: (value) => void markers.push(value),
      removeMarker: () => void markers.push(null),
    };
    const run = () =>
      installUpdate(ops, {
        binary: "/p/kitshn",
        next: "/p/kitshn.new",
        windows: false,
        jobId: 7,
        from,
        to: "aaaaaaaaaaaa",
        now: 0,
        providers: ["t3"],
      });
    return { files, markers, run };
  }

  it("leaves the binary as it was when the new one fails its start check", async () => {
    for (const printed of [null, "cccccccccccc"]) {
      const { files, markers, run } = install(printed);
      expect(await run()).toMatch(/failed its start check/);
      expect([...files.files]).toEqual(["/p/kitshn"]);
      expect(markers).toEqual([]);
    }
  });

  it("never puts the running release in place of kitshn.old", async () => {
    const { files, markers, run } = install("aaaaaaaaaaaa", "aaaaaaaaaaaa");
    expect(await run()).toBe("The daemon runs edge-aaaaaaaaaaaa already.");
    expect([...files.files]).toEqual(["/p/kitshn"]);
    expect(markers).toEqual([]);
  });

  it("keeps the previous binary as kitshn.old and writes the marker before the swap", async () => {
    const { files, markers, run } = install("aaaaaaaaaaaa");
    expect(await run()).toBeNull();
    expect([...files.files].sort()).toEqual(["/p/kitshn", "/p/kitshn.old"]);
    expect(markers).toMatchObject([{ jobId: 7, previous: "/p/kitshn.old", starts: 0, state: "pending" }]);
    // K-636: the new daemon reads back which providers it must see again before it confirms.
    expect(parseMarker(JSON.parse(JSON.stringify(markers[0])))?.providers).toEqual(["t3"]);
  });
});

describe("the provider check before done (K-636)", () => {
  const state = (name: string, online: boolean, refusal: string | null = null) => ({ name, online, refusal });
  it("confirms only when each provider that was online before is online again and not refused", () => {
    expect(providersBack(["t3"], [state("t3", true), state("other", false)])).toBeNull();
    expect(providersBack(["t3"], [state("t3", false, "the major versions differ")])).toBe(
      "The new daemon refused the provider t3: the major versions differ",
    );
    expect(providersBack(["t3"], [state("t3", false)])).toBe(
      "The provider t3 did not register again within 3 minutes.",
    );
    expect(providersBack(["t3"], [])).toBe("The provider t3 did not register again within 3 minutes.");
  });
});
