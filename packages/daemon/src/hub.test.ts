import type { DaemonMessage } from "@kitshn/edge/machine";
import type { Answer } from "@kitshn/local";
import { describe, expect, it, vi } from "vitest";
import { ATTEST_MS, type HubOptions, ProviderHub } from "./hub.ts";
import { Providers, parseSaved } from "./providers.ts";

const OWN = 1000;

function setup(more: Partial<HubOptions> = {}) {
  const registry = new Providers(
    parseSaved({ providers: [] }).saved,
    () => {},
    () => {},
  );
  const sent: Array<DaemonMessage> = [];
  const dropped: Array<number> = [];
  const events = new Map<number, Array<Answer>>();
  let now = 1_000;
  const hub = new ProviderHub({
    registry: () => registry,
    toKitshn: (message) => (sent.push(message), true),
    drop: (connection) => dropped.push(connection),
    log: () => {},
    ownUid: OWN,
    platform: "linux",
    pingMs: 15_000,
    graceMs: 45_000,
    saved: { syncedAt: null, paused: false, execMachines: [] },
    save: () => {},
    execSudo: () => null,
    now: () => now,
    ...more,
  });
  const emitter = (connection: number) => {
    const list: Array<Answer> = [];
    events.set(connection, list);
    return (event: Answer) => list.push(event);
  };
  /** Registers the provider `name` as user `uid` on `connection`. */
  const connect = (connection: number, name = "t3", uid = OWN) => {
    registry.register(
      {
        id: "1",
        type: "register",
        protocol: 2,
        provider: name,
        instance: "i",
        kinds: [],
        commands: [],
        resources: [],
      },
      { connection, uid, privileged: uid === OWN, takenSites: new Set(), machineName: "vps" },
    );
    hub.registered(connection, emitter(connection), []);
  };
  return {
    hub,
    registry,
    sent,
    dropped,
    events: (connection: number) => events.get(connection) ?? [],
    emitter,
    connect,
    advance: (ms: number) => (now += ms),
  };
}

const run = { execId: "e1", command: "true", timeoutSeconds: 5, stdin: false };

describe("the provider hub", () => {
  it("pings each provider connection and drops one that sent nothing for the grace time (C-6)", () => {
    const { hub, connect, events, dropped, advance } = setup();
    connect(1);
    hub.tick();
    expect(events(1)).toEqual([{ type: "ping", at: 1_000 }]);
    advance(30_000);
    hub.seen(1);
    advance(30_000);
    hub.tick();
    expect(dropped).toEqual([]);
    advance(16_000);
    hub.tick();
    expect(dropped).toEqual([1]);
  });

  it("asks the named provider to attest, adds its prefix to the labels, and refuses inactive, silent and unknown ones (C-14)", async () => {
    vi.useFakeTimers();
    try {
      const { hub, connect, events } = setup();
      connect(1);
      const pending = hub.attest("t3:token-a");
      const [event] = events(1);
      expect(event).toMatchObject({ type: "attest", token: "token-a" });
      const attestId = (event as Extract<Answer, { type: "attest" }>).attestId;
      expect(() => hub.attested({ id: "2", type: "attest-result", attestId, active: true }, 2)).toThrow(
        /no attest/,
      );
      hub.attested(
        { id: "2", type: "attest-result", attestId, active: true, labels: { "thread.id": "th-1" } },
        1,
      );
      expect(await pending).toEqual({ labels: { "t3.thread.id": "th-1" } });

      const inactive = hub.attest("t3:token-b");
      const second = events(1)[1] as Extract<Answer, { type: "attest" }>;
      hub.attested({ id: "3", type: "attest-result", attestId: second.attestId, active: false }, 1);
      expect(await inactive).toMatchObject({ refused: expect.stringMatching(/not active/) });

      const silent = hub.attest("t3:token-c");
      vi.advanceTimersByTime(ATTEST_MS);
      expect(await silent).toMatchObject({ refused: expect.stringMatching(/did not attest within 2 s/) });
      expect(await hub.attest("grok:x")).toMatchObject({
        refused: expect.stringMatching(/grok is not connected/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a command as the provider user: itself when it is that user, else the bridge of that user, and refuses one with no provider (K-722)", () => {
    const own = setup();
    own.connect(1);
    own.hub.execRun("t3", run);
    expect(own.events(1)).toEqual([]);

    // A daemon that is not root gives the run to the bridge of the provider user.
    const other = setup();
    other.connect(1, "t3", 1002);
    other.hub.execRun("t3", run);
    expect(other.events(1)).toEqual([{ type: "exec-run", run }]);
    other.hub.execFrame("e1", { type: "credit", bytes: 10 });
    expect(other.events(1)[1]).toEqual({
      type: "exec-control",
      execId: "e1",
      frame: { type: "credit", bytes: 10 },
    });
    expect(() =>
      other.hub.bridgeFrame(
        { type: "exec-frame", execId: "e1", frame: { type: "stdin-credit", bytes: 1 } },
        9,
      ),
    ).toThrow(/no run e1/);
    // A bridge that goes away ends its run for the caller.
    other.hub.closed(1);
    expect(other.sent.at(-1)).toMatchObject({
      type: "execFrame",
      execId: "e1",
      frame: { type: "exit", reason: "the provider t3 on this machine went offline" },
    });

    expect(other.hub.execPaths()).toEqual([{ provider: "t3", uid: 1002, via: "bridge" }]);
    // With the sudo rule of `kitshn exec install`, the daemon runs it itself and the bridge gets nothing.
    const sudo = setup({ execSudo: () => "t3" });
    sudo.connect(1, "t3", 1002);
    sudo.hub.execRun("t3", { ...run, execId: "e9" });
    expect(sudo.events(1)).toEqual([]);
    expect(sudo.hub.execPaths()).toEqual([{ provider: "t3", uid: 1002, via: "sudo" }]);
    sudo.hub.kitshnLost();

    // A machine with provider users never runs a command as the daemon user for a caller without a provider.
    other.hub.execRun(null, { ...run, execId: "e2" });
    expect(other.sent.at(-1)).toMatchObject({
      execId: "e2",
      frame: { type: "exit", exitCode: null, reason: expect.stringMatching(/only for a provider/) },
    });
  });

  it("answers an exec when kitshn says how it started, keeps the stdin credit, and ends every run when the relay is lost (C-13, C-15)", async () => {
    const { hub, connect, sent, emitter, events } = setup();
    connect(1);
    const emit = emitter(5);
    const caller = { connection: 5, emit };
    const started = hub.exec({ id: "4", type: "exec", target: "mac", command: "cat", stdin: true }, caller, {
      "t3.thread.id": "th-1",
    });
    const start = sent.at(-1) as Extract<DaemonMessage, { type: "execStart" }>;
    expect(start).toMatchObject({ target: "mac", provider: null, run: { timeoutSeconds: 90, stdin: true } });
    hub.execState(start.execId, "waiting", "p-1");
    expect(await started).toMatchObject({ execId: start.execId, state: "waiting", proposalId: "p-1" });
    // An approval keeps the run; its frames follow on the same exec id.
    hub.proposalEnded("p-1", "approved");

    const big = Buffer.alloc(64 * 1024).toString("base64");
    hub.execControl(start.execId, 5, { type: "input", data: big });
    expect(() => hub.execControl(start.execId, 5, { type: "input", data: "AA==" })).toThrow(/stdin credit/);
    hub.execFrame(start.execId, { type: "stdin-credit", bytes: 1 });
    hub.execControl(start.execId, 5, { type: "input", data: "AA==" });
    expect(() => hub.execControl(start.execId, 6, { type: "credit", bytes: 1 })).toThrow(/no run/);

    // A run that ends before it starts answers `ended`, and its exit follows.
    const refused = hub.exec({ id: "5", type: "exec", target: "gone", command: "x" }, caller, {});
    const second = sent.at(-1) as Extract<DaemonMessage, { type: "execStart" }>;
    hub.execFrame(second.execId, {
      type: "exit",
      exitCode: null,
      signal: null,
      durationMs: 0,
      reason: "the target is offline",
    });
    expect(await refused).toMatchObject({ state: "ended" });

    // A deny of its proposal ends a waiting run with the reason.
    const denied = hub.exec({ id: "6", type: "exec", target: "mac", command: "x" }, caller, {});
    const third = sent.at(-1) as Extract<DaemonMessage, { type: "execStart" }>;
    hub.execState(third.execId, "waiting", "p-2");
    await denied;
    hub.proposalEnded("p-2", "denied", "not now");

    hub.kitshnLost();
    expect(events(5).filter((event) => event.type === "exec-exit")).toEqual([
      expect.objectContaining({ execId: second.execId, reason: "the target is offline" }),
      expect.objectContaining({ execId: third.execId, reason: "refused: the ask was denied (not now)" }),
      expect.objectContaining({ execId: start.execId, reason: "the relay was lost" }),
    ]);
  });
});
