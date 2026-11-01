import { describe, expect, it } from "vitest";
import {
  type AutoUpdateMachine,
  type LiveStatus,
  NO_ROLLOUT,
  type Rollout,
  advanceRollout,
  daemonUpdate,
  manualStep,
  nextAutoUpdate,
  BUSY_CAP_MS,
  releaseBusyStep,
  rolloutView,
  startStep,
  stepSent,
  withBusyWaits,
  withoutMachine,
} from "./autoUpdate.ts";

const NEW = "aaaaaaaaaaaa";
const NEWER = "cccccccccccc";
const OLD = "bbbbbbbbbbbb";
const PROTOCOL = "2.1.0";
const online = (version: string, connectedAt = 0): LiveStatus => ({
  version,
  protocol: PROTOCOL,
  capabilities: ["update"],
  os: "linux 6.8.0",
  connectedAt,
});
const behind = (id: string, order: number, more: Partial<AutoUpdateMachine> = {}): AutoUpdateMachine => ({
  id,
  order,
  autoUpdate: true,
  hasKey: true,
  status: online(OLD),
  busy: false,
  ...more,
});
/** A rollout of NEW whose step on "a" went out at time 10. */
const sent: Rollout = stepSent(startStep(NO_ROLLOUT, NEW, "a", 1), NEW, 10);

describe("next automatic update (K-627)", () => {
  it("picks the first BEHIND machine in the owner's order, and only one", () => {
    expect(nextAutoUpdate(NEW, false, NO_ROLLOUT, [behind("b", 2), behind("a", 1)], 0)?.machineId).toBe("a");
  });
  it("skips a machine whose setting is off (K-626)", () => {
    expect(nextAutoUpdate(NEW, false, NO_ROLLOUT, [behind("a", 1, { autoUpdate: false })], 0)).toBeNull();
  });
  it("waits while kitshn is paused (K-1618)", () => {
    expect(nextAutoUpdate(NEW, true, NO_ROLLOUT, [behind("a", 1)], 0)).toBeNull();
  });
  it("lets the second machine wait while a step runs, also one of an older release after a deploy", () => {
    expect(nextAutoUpdate(NEW, false, sent, [behind("b", 2)], 0)).toBeNull();
    expect(nextAutoUpdate(NEWER, false, sent, [behind("b", 2)], 0)).toBeNull();
  });
  it("stops the others after the release failed on one machine, but not the next release", () => {
    const failed: Rollout = {
      ...NO_ROLLOUT,
      version: NEW,
      failed: { machineId: "a", reason: "start check" },
    };
    expect(nextAutoUpdate(NEW, false, failed, [behind("b", 2)], 0)).toBeNull();
    expect(nextAutoUpdate(NEWER, false, failed, [behind("b", 2)], 0)?.machineId).toBe("b");
  });
  it("updates a Windows daemon that starts its task again (K-622)", () => {
    const status = { ...online(OLD)!, os: "win32 10.0.26100", capabilities: ["update", "task-restart"] };
    expect(nextAutoUpdate(NEW, false, NO_ROLLOUT, [behind("pc", 1, { status })], 0)?.machineId).toBe("pc");
  });
  it("skips offline, unkeyed, source and NEWEST daemons, old Windows daemons, and a local Worker build", () => {
    expect(
      nextAutoUpdate(
        NEW,
        false,
        NO_ROLLOUT,
        [
          behind("off", 1, { status: null }),
          behind("nokey", 1, { hasKey: false }),
          behind("dev", 1, { status: online("dev") }),
          behind("new", 1, { status: online(NEW) }),
          behind("old", 1, { status: { version: OLD, os: "linux 6.8.0", connectedAt: 0 } }),
          // K-622: a Windows daemon that cannot start its task again after the swap.
          behind("windows", 1, { status: { ...online(OLD)!, os: "win32 10.0.26100" } }),
        ],
        0,
      ),
    ).toBeNull();
    expect(nextAutoUpdate("local", false, NO_ROLLOUT, [behind("a", 1)], 0)).toBeNull();
  });
});

describe("a busy machine in the rollout (K-627, K-1608)", () => {
  const machines = [behind("a", 1, { busy: true }), behind("b", 2)];
  it("lets the next BEHIND machine go while the first one is busy, and comes back to it later", () => {
    const waiting = withBusyWaits(NO_ROLLOUT, NEW, machines, 100);
    expect(waiting.busySince).toEqual({ a: 100 });
    expect(nextAutoUpdate(NEW, false, waiting, machines, 100)).toEqual({ machineId: "b", whenIdle: true });
    // Once idle, the first one goes first again, and its wait ends.
    const idle = [behind("a", 1), behind("b", 2)];
    const after = withBusyWaits(waiting, NEW, idle, 200);
    expect([after.busySince, nextAutoUpdate(NEW, false, after, idle, 200)]).toEqual([
      {},
      { machineId: "a", whenIdle: true },
    ]);
  });
  it("sends the update to a busy machine after the cap, also while busy, and shows the wait until then", () => {
    const alone = [behind("a", 1, { busy: true })];
    const waiting = withBusyWaits(NO_ROLLOUT, NEW, alone, 0);
    expect(nextAutoUpdate(NEW, false, waiting, alone, BUSY_CAP_MS - 1)).toBeNull();
    expect(daemonUpdate(waiting, "a", NEW)).toEqual({ state: "waiting", reason: "busy", until: BUSY_CAP_MS });
    // A wait keeps its start while the machine stays busy.
    const later = withBusyWaits(waiting, NEW, alone, BUSY_CAP_MS);
    expect(nextAutoUpdate(NEW, false, later, alone, BUSY_CAP_MS)).toEqual({
      machineId: "a",
      whenIdle: false,
    });
  });
  it("still updates one machine at a time and stops the rest after a failure", () => {
    const waiting = withBusyWaits(NO_ROLLOUT, NEW, machines, 0);
    // While the step of "b" runs, the capped busy machine waits.
    const running = startStep(waiting, NEW, "b", 7);
    expect(nextAutoUpdate(NEW, false, running, machines, BUSY_CAP_MS)).toBeNull();
    const failed: Rollout = { ...running, step: null, failed: { machineId: "b", reason: "x" } };
    expect(nextAutoUpdate(NEW, false, failed, machines, BUSY_CAP_MS)).toBeNull();
  });
  it("lets a step whose job waits for a busy machine go, and keeps a sent one or one after the cap", () => {
    const queued = startStep(NO_ROLLOUT, NEW, "a", 1);
    const busy = () => true;
    expect(releaseBusyStep(queued, { state: "queued", output: "" }, busy).step).toBeNull();
    expect(releaseBusyStep(queued, { state: "sent", output: "" }, busy)).toEqual(queued);
    expect(releaseBusyStep(queued, { state: "queued", output: "" }, () => false)).toEqual(queued);
    const forced = startStep(NO_ROLLOUT, NEW, "a", 1, false);
    expect(releaseBusyStep(forced, { state: "queued", output: "" }, busy)).toEqual(forced);
  });
});

describe("a step of the rollout (K-627)", () => {
  type State = "queued" | "sent" | "done" | "failed" | "closed" | "gone";
  const job = (state: State, output = "") => ({ state, output });
  it("holds the rest while the machine stays offline, also after a done job", () => {
    expect(advanceRollout(sent, job("done"), () => null)).toEqual(sent);
    expect(advanceRollout(sent, job("closed"), () => null)).toEqual(sent);
  });
  it("ends when the machine is online on the release, and the card says updated", () => {
    const next = advanceRollout(sent, job("done"), () => online(NEW, 20));
    expect(next).toEqual({ ...sent, step: null, updated: ["a"] });
    expect(daemonUpdate(next, "a", NEW)).toEqual({ state: "updated" });
  });
  it("waits while the connection that ran the job still reports the old release", () => {
    expect(advanceRollout(sent, job("done"), () => online(OLD, 5))).toEqual(sent);
  });
  it("fails when a later connection comes back on another release, or with the last line of a failed job", () => {
    expect(advanceRollout(sent, job("done"), () => online(OLD, 20)).failed).toEqual({
      machineId: "a",
      reason: `The daemon came back on edge-${OLD}.`,
    });
    const failed = advanceRollout(
      sent,
      job("failed", "download\nThe new daemon failed its start check.\n"),
      () => null,
    );
    expect(daemonUpdate(failed, "a", NEW)).toEqual({
      state: "failed",
      reason: "The new daemon failed its start check.",
    });
  });
  it("tells kitshn rollout where each machine stands, and stops on a failure (K-636)", () => {
    const machines = [
      { ...behind("c", 3), name: "C" },
      { ...behind("a", 1, { status: online(NEW, 20) }), name: "A" },
      { ...behind("b", 2), name: "B" },
      { ...behind("d", 4, { status: null }), name: "D" },
      { ...behind("e", 5, { autoUpdate: false }), name: "E" },
    ];
    const done = advanceRollout(sent, job("done"), () => online(NEW, 20));
    const view = rolloutView(NEW, PROTOCOL, done, machines, false);
    expect(view.state).toBe("running");
    expect(view.machines.map((machine) => `${machine.id} ${machine.state}`)).toEqual([
      "a updated",
      "b behind",
      "c behind",
      "d offline",
      "e skipped",
    ]);
    const stopped = { ...done, failed: { machineId: "b", reason: "start check" } };
    expect(rolloutView(NEW, PROTOCOL, stopped, machines, false)).toMatchObject({
      state: "stopped",
      reason: "B: start check",
      machines: [{ id: "a" }, { id: "b", state: "failed", reason: "start check" }, {}, {}, {}],
    });
    expect(rolloutView(NEW, PROTOCOL, done, machines.slice(1, 2), false).state).toBe("done");
    // K-1504: nothing updates while kitshn is paused, so the view says so instead of running forever.
    expect(rolloutView(NEW, PROTOCOL, done, machines, true)).toMatchObject({
      state: "held",
      reason: expect.stringContaining("paused"),
    });
  });
  it("holds while a daemon on the release has not confirmed it, so a crash just after acceptance never counts", () => {
    expect(advanceRollout(sent, job("closed"), () => online(NEW, 20))).toEqual(sent);
  });
  it("drops an expired step without a failure", () => {
    expect(advanceRollout(sent, job("gone"), () => null)).toEqual({ ...sent, step: null });
  });
  it("lets the owner end a hold or a failure: setting off, or Update daemon that succeeds (K-626)", () => {
    const held = advanceRollout(sent, job("done"), () => null);
    expect(withoutMachine(held, "a")).toEqual({ ...held, step: null });
    const failed: Rollout = { ...NO_ROLLOUT, version: NEW, failed: { machineId: "a", reason: "x" } };
    expect(withoutMachine(failed, "a").failed).toBeNull();
    for (const before of [held, failed]) {
      const retry = manualStep(before, "a", 9);
      expect(retry).toMatchObject({ failed: null, step: { machineId: "a", jobId: 9 } });
      expect(advanceRollout(retry, job("done"), () => online(NEW, 20))).toMatchObject({
        step: null,
        failed: null,
        updated: ["a"],
      });
    }
    // An update of another machine changes nothing.
    expect(manualStep(held, "b", 9)).toEqual(held);
  });
  it("follows the release that delivery names after a deploy", () => {
    const queued = startStep(NO_ROLLOUT, NEW, "a", 1);
    expect(stepSent(queued, NEWER, 10)).toMatchObject({
      version: NEWER,
      step: { machineId: "a", sentAt: 10 },
    });
  });
});
