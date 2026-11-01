import { describe, expect, it } from "vitest";
import type { MachineView } from "../core/protocol.ts";
import { seed } from "../core/seed.ts";
import { actorOf, chip, machineKey } from "../core/testkit.ts";
import type { State } from "../core/model.ts";
import { connectChecklist, isNewMachine, machineProblems } from "./machine-signs.ts";

const view = (over: Partial<MachineView>): MachineView =>
  ({
    machine: { id: "mac", name: "Mac" },
    online: true,
    status: { tunnel: "running" },
    keyFailure: null,
    ...over,
  }) as MachineView;

describe("machineProblems (K-515)", () => {
  it("shows nothing for a healthy machine or an offline one", () => {
    expect(machineProblems(view({}), [])).toEqual([]);
    const lost = { offlineProviders: [{ provider: "t3", reason: "the connection closed", at: 1 }] };
    expect(machineProblems(view({ online: false, status: lost as never }), [])).toEqual([]);
  });

  it("shows a failed key check also while offline, because that is often why", () => {
    const failed = { at: 1, reason: "bad signature" };
    expect(
      machineProblems(view({ online: false, keyFailure: failed }), []).map((sign) => sign.short),
    ).toEqual(["key check failed"]);
  });

  it("names a provider that lost its connection, and puts a refusal first", () => {
    const status = {
      tunnel: "running",
      offlineProviders: [{ provider: "t3", reason: "the connection closed", at: 1 }],
      refusedProviders: [{ provider: "riffle", reason: "no", at: 1 }],
    };
    expect(machineProblems(view({ status: status as never }), []).map((sign) => sign.short)).toEqual([
      "kitshn refused Riffle",
      "T3 lost kitshn",
    ]);
  });
});

describe("connectChecklist (K-633)", () => {
  const s = seed(["owner@example.com"], "kit.example.com");
  const state = (over: Partial<State>): State =>
    ({
      circles: new Map(s.circles.map((circle) => [circle.id, circle])),
      resources: new Map(),
      places: new Map(),
      shareSettings: new Map(),
      ends: new Map(),
      stacks: new Map(),
      paused: null,
      machines: new Map(),
      actors: new Map([...s.actors, actorOf(machineKey("mac"), "mac")].map((actor) => [actor.id, actor])),
      ...over,
    }) as State;
  const done = (rows: ReturnType<typeof connectChecklist>) =>
    rows.filter((row) => row.done).map((row) => row.label);

  it("starts with nothing done for a machine that never connected", () => {
    expect(done(connectChecklist(view({ lastSeen: null }), state({}), {}))).toEqual([]);
  });

  it("keeps every tick while the machine is offline, so an old machine never falls back into the list", () => {
    const t3 = {
      id: "t3-mac",
      kind: "t3.app",
      name: "T3 on Mac",
      addresses: ["t3-mac.example.com"],
      status: "offline",
      group: null,
      machine: "mac",
      provider: { name: "t3" },
    };
    const circle = { ...s.circles[0]!, members: [chip(machineKey("mac"))] };
    const rows = connectChecklist(
      view({ online: false, lastSeen: 5 }),
      state({
        circles: new Map([[circle.id, circle]]),
        resources: new Map([["t3-mac", t3 as never]]),
      }),
      { "t3-mac": { state: "applied" } },
    );
    expect(rows.every((row) => row.done)).toBe(true);
  });

  it("does not tick the address for another app on the machine", () => {
    const blog = { id: "blog", kind: "site.compose", addresses: ["blog.example.com"], machine: "mac" };
    const rows = connectChecklist(view({}), state({ resources: new Map([["blog", blog as never]]) }), {
      blog: { state: "applied" },
    });
    expect(rows.find((row) => row.label.includes("address"))?.done).toBe(false);
  });

  it("flips a tick back when the machine leaves its last circle", () => {
    expect(done(connectChecklist(view({ lastSeen: 5 }), state({}), {}))).not.toContain("Member of a circle");
  });

  it("calls a machine new for 7 days after it joined, and never without a join time", () => {
    const machine = view({}).machine;
    const day = 24 * 60 * 60_000;
    expect(isNewMachine(machine, 10 * day)).toBe(false);
    expect(isNewMachine({ ...machine, joinedAt: day }, 7 * day)).toBe(true);
    expect(isNewMachine({ ...machine, joinedAt: day }, 8 * day)).toBe(false);
  });
});
