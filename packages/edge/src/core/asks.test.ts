import { describe, expect, it } from "vitest";
import { ASK_ACTIONS as LOCAL_ACTIONS, WINDOW_ACTIONS as LOCAL_WINDOW } from "../../../local/src/index.ts";
import {
  ASK_ACTIONS,
  WINDOW_ACTIONS,
  askRequest,
  formatConditions,
  labelProblem,
  parseConditions,
  rightWarnings,
  selfApprovers,
} from "./asks.ts";
import type { Circle } from "./model.ts";
import { actorOf, chip, login, machineKey } from "./testkit.ts";
import { conditionsHold } from "./visitor.ts";

const VPS = actorOf(machineKey("vps"), "vps");
const ACTORS = new Map([VPS, actorOf(login("o@example.com"))].map((actor) => [actor.id, actor]));

describe("asks of agents on machines (K-1710, K-1711, K-1750)", () => {
  it("knows the same actions as the daemon, and the same actions whose approval opens a window", () => {
    expect([...ASK_ACTIONS]).toEqual([...LOCAL_ACTIONS]);
    expect([...WINDOW_ACTIONS].sort()).toEqual([...LOCAL_WINDOW].sort());
  });

  it("takes at most 10 labels with a prefixed key and a short text value", () => {
    expect(labelProblem(undefined)).toBeNull();
    expect(labelProblem({ "t3.thread.id": "abc" })).toBeNull();
    for (const bad of [
      { thread: "no prefix" },
      { "T3.thread": "capital" },
      { "t3.thread": 5 },
      { "t3.thread": "x".repeat(257) },
      Object.fromEntries(Array.from({ length: 11 }, (_, at) => [`a.${at}`, "x"])),
      ["a.b"],
    ])
      expect(labelProblem(bad)).toEqual(expect.any(String));
  });

  it("maps each action that kitshn runs through an agent path to that path", () => {
    expect(askRequest("allow", "123", null)).toEqual({
      method: "POST",
      path: "/agent/repos/123",
      body: { state: "allowed" },
    });
    expect(askRequest("deploy", "card", { mode: "build" })).toMatchObject({
      body: { card: "card", mode: "build" },
    });
    expect(askRequest("deploy", "card", {})).toMatchObject({ body: { mode: "redeploy" } });
    expect(askRequest("approve", "id", null)).toEqual(expect.any(String));
  });
});

describe("warnings of machine rights (K-1725)", () => {
  const circle = (id: string, members: Circle["members"]): Circle => ({
    id,
    name: id,
    color: "#000000",
    level: "control",
    members,
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 0,
    y: 0,
    r: 1,
  });
  const circles = new Map([
    ["owner", circle("owner", [chip(login("o@example.com"))])],
    ["bots", circle("bots", [chip(machineKey("vps"))])],
  ]);
  const state = { circles, actors: ACTORS, machines: new Map() };

  it("warns and allows: self-approval, no person for a high-risk right, agent approvers, automatic code writes", () => {
    expect(rightWarnings(state, VPS, { runsCommands: { mode: "ask", circleId: "owner" } })).toEqual([]);
    const warnings = rightWarnings(state, VPS, {
      runsCommands: { mode: "ask", circleId: "bots" },
      writesCode: { mode: "automatic" },
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join(" ")).toMatch(/approve itself/);
  });
});

describe("self-approval (K-1727)", () => {
  it("names a machine that a right of it lets approve its own asks in this circle", () => {
    const base = {
      color: "#000000",
      level: "control" as const,
      match: "any" as const,
      needsPasskey: false,
      endsAt: null,
      x: 0,
      y: 0,
      r: 1,
    };
    const bots = {
      ...base,
      id: "bots",
      name: "bots",
      members: [chip(machineKey("vps"))],
    };
    const agents = {
      ...base,
      id: "agents",
      name: "agents",
      members: [chip(machineKey("vps"), { deploys: { mode: "ask", circleId: "bots" } })],
    };
    const circles = new Map<string, Circle>([
      ["bots", bots],
      ["agents", agents],
    ]);
    expect(selfApprovers(circles, bots)).toEqual([VPS.id]);
    expect(selfApprovers(circles, agents)).toEqual([]);
    // In a passkey circle, a machine approves only with "approves without passkey", and the rule warning names it.
    const locked: Circle = { ...bots, needsPasskey: true };
    const lockedCircles = new Map<string, Circle>([
      [locked.id, locked],
      [agents.id, agents],
    ]);
    expect(selfApprovers(lockedCircles, locked)).toEqual([]);
    const lockedState = { circles: lockedCircles, actors: ACTORS, machines: new Map() };
    expect(rightWarnings(lockedState, VPS, { deploys: { mode: "ask", circleId: "bots" } })).toEqual([
      expect.stringContaining("no person"),
    ]);
    const open: Circle = { ...locked, approvesWithoutPasskey: true };
    const openCircles = new Map<string, Circle>([
      [open.id, open],
      [agents.id, agents],
    ]);
    expect(selfApprovers(openCircles, open)).toEqual([VPS.id]);
    const openState = { circles: openCircles, actors: ACTORS, machines: new Map() };
    expect(rightWarnings(openState, VPS, { deploys: { mode: "ask", circleId: "bots" } }).join(" ")).toMatch(
      /"approves without passkey" is on/,
    );
  });
});

describe("conditions on attested labels (K-1754)", () => {
  const conditions = [{ key: "t3.project.name", values: ["kitshn", "riffle"] }];

  it("holds only for a verified label with one of its values, on the prefix of a provider of the machine", () => {
    const attested = (labels: Record<string, string>, prefixes = ["t3."]) => ({ labels, prefixes });
    expect(conditionsHold(conditions, attested({ "t3.project.name": "kitshn" }))).toBe(true);
    expect(conditionsHold(conditions, attested({ "t3.project.name": "other" }))).toBe(false);
    expect(conditionsHold(conditions, attested({}))).toBe(false);
    expect(conditionsHold(conditions, attested({ "t3.project.name": "kitshn" }, []))).toBe(false);
    expect(conditionsHold(conditions, null)).toBe(false);
  });

  it("reads and writes the editor text", () => {
    expect(parseConditions("t3.project.name=kitshn, riffle; t3.subagent=false")).toEqual([
      ...conditions,
      { key: "t3.subagent", values: ["false"] },
    ]);
    expect(parseConditions("nokey")).toEqual(expect.any(String));
    expect(formatConditions(conditions)).toBe("t3.project.name=kitshn,riffle");
  });
});
