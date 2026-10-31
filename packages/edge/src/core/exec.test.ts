import { describe, expect, it } from "vitest";
import { applyChanges } from "./changes.ts";
import { commandName, execMachinesOf, execProviderOn, mayExecOn, migrateAgentShares } from "./exec.ts";
import type { Machine } from "./machine.ts";
import {
  type Circle,
  type Member,
  type Resource,
  type RightMode,
  type State,
  circlesHolding,
  shareKey,
} from "./model.ts";

const machineOf = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `${id}-token`,
  clientId: `${id}.access`,
  tunnelId: id,
});
const card = (id: string, kind: Resource["kind"], machine: string | null): Resource => ({
  id,
  kind,
  name: id,
  addresses: [],
  status: "running",
  group: null,
  machine,
  ...(kind.startsWith("t3.")
    ? {
        provider: {
          name: "t3",
          localId: id,
          kindName: kind,
          levels: { view: "view", use: "use", control: "control" },
          facts: [],
          stickers: [],
          lists: [],
          settings: [],
          site: null,
        },
      }
    : {}),
});
const circle = (id: string, members: ReadonlyArray<Member>, at: { x: number; r: number }): Circle => ({
  id,
  name: id,
  color: "#000",
  level: "control",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: at.x,
  y: 0,
  r: at.r,
});
const mac = (runsCommands?: RightMode): Member => ({
  _tag: "machine",
  machineId: "mac",
  rights: { readsCode: { mode: "automatic" }, ...(runsCommands ? { runsCommands } : {}) },
});

/** The Machines circle at x 0 holds mac's member and the cards in `inside`; Owner at x 300 holds the rest. */
function world(member: Member, inside: ReadonlyArray<string>, extra: Partial<State> = {}): State {
  const cards = [
    card("vps", "machine", null),
    card("vps/t3/agents", "t3.agents", "vps"),
    card("vps/t3/app", "t3.app", "vps"),
  ];
  return {
    circles: new Map([
      ["machines", circle("machines", [member], { x: 0, r: 100 })],
      ["owner", circle("owner", [{ _tag: "email", email: "owner@example.com" }], { x: 300, r: 100 })],
    ]),
    resources: new Map(cards.map((item) => [item.id, item])),
    places: new Map(
      cards.map((item) => [item.id, inside.includes(item.id) ? { x: 0, y: 0 } : { x: 300, y: 0 }]),
    ),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map([
      ["mac", machineOf("mac")],
      ["vps", machineOf("vps")],
    ]),
    ...extra,
  };
}

describe("exec on another machine (K-722)", () => {
  it("lets a machine run commands where its agent circle holds the machine card or a provider card at control", () => {
    const viaMachine = world(mac({ mode: "automatic" }), ["vps"]);
    expect(mayExecOn(viaMachine, "mac", "vps", 0)).toBe(true);
    expect(execMachinesOf(viaMachine, "vps", 0)).toEqual(["mac"]);
    const viaApp = world(mac({ mode: "automatic" }), ["vps/t3/app"]);
    expect(mayExecOn(viaApp, "mac", "vps", 0)).toBe(true);
    // "ask" or a label condition never gives the exec right to `check`; the run itself still may ask.
    const asks = world(mac({ mode: "ask", circleId: "owner" }), ["vps"]);
    expect([mayExecOn(asks, "mac", "vps", 0), execMachinesOf(asks, "vps", 0)]).toEqual([true, []]);
    const conditioned = world(
      mac({ mode: "automatic", conditions: [{ key: "t3.subagent", values: ["false"] }] }),
      ["vps"],
    );
    expect(execMachinesOf(conditioned, "vps", 0)).toEqual([]);
    expect(mayExecOn(world(mac({ mode: "automatic" }), []), "mac", "vps", 0)).toBe(false);
    expect(mayExecOn(viaMachine, "mac", "mac", 0)).toBe(false);
  });
});

describe("what a run on another machine records and who runs it (K-722, K-1610)", () => {
  it("records the command name only, after its leading assignments", () => {
    expect(commandName("GITHUB_TOKEN=x A_B=2 git push origin")).toBe("git");
    expect(commandName("  ls -la")).toBe("ls");
    expect(commandName("TOKEN=x")).toBe("(empty)");
  });

  it("takes a provider that the caller names only among the providers whose cards it controls", () => {
    const grok = { ...card("vps/grok/app", "t3.app", "vps"), id: "vps/grok/app" };
    const both = world(mac({ mode: "automatic" }), ["vps/t3/app", "vps/grok/app"]);
    const withGrok: State = {
      ...both,
      resources: new Map([
        ...both.resources,
        [grok.id, { ...grok, provider: { ...grok.provider!, name: "grok" } }],
      ]),
      places: new Map([...both.places, [grok.id, { x: 0, y: 0 }]]),
    };
    expect(execProviderOn(withGrok, "mac", "vps", 0)).toMatchObject({
      refused: expect.stringMatching(/name one/),
    });
    expect(execProviderOn(withGrok, "mac", "vps", 0, "grok")).toEqual({ provider: "grok" });
    expect(
      execProviderOn(world(mac({ mode: "automatic" }), ["vps/t3/app"]), "mac", "vps", 0, "grok"),
    ).toMatchObject({
      refused: expect.stringMatching(/no card of the provider grok/),
    });
  });

  it("picks the provider of the card that the caller controls, never one that the caller names", () => {
    expect(execProviderOn(world(mac({ mode: "automatic" }), ["vps/t3/app"]), "mac", "vps", 0)).toEqual({
      provider: "t3",
    });
    // Only the machine card: B's own rule decides, with no provider.
    expect(execProviderOn(world(mac({ mode: "automatic" }), ["vps"]), "mac", "vps", 0)).toEqual({
      provider: null,
    });
    expect(execProviderOn(world(mac({ mode: "automatic" }), []), "mac", "vps", 0)).toMatchObject({
      refused: "no card",
    });
  });
});

describe("the t3.agents migration (K-722, migration 42)", () => {
  it("shares the T3 app card wherever the T3 agents card was, keeps its other shares, and turns on runs commands for an exec share", () => {
    const before = world(mac(), ["vps/t3/agents"]);
    const result = migrateAgentShares(before);
    // The Owner circle at x 300 and the Machines circle at x 0 do not overlap, so no point holds the card in both.
    expect(result.unmet).toEqual([expect.stringMatching(/T3 app card of vps could not move into machines/)]);
    const overlapping = world(mac(), ["vps/t3/agents"], {
      circles: new Map([
        ["machines", circle("machines", [mac()], { x: 0, r: 100 })],
        ["owner", circle("owner", [{ _tag: "email", email: "owner@example.com" }], { x: 150, r: 100 })],
      ]),
      places: new Map([
        ["vps", { x: 150, y: 0 }],
        ["vps/t3/agents", { x: 0, y: 0 }],
        ["vps/t3/app", { x: 200, y: 0 }],
      ]),
    });
    const moved = migrateAgentShares(overlapping);
    expect(moved.unmet).toEqual([]);
    const placed = applyChanges(overlapping, moved.changes);
    expect(
      circlesHolding(placed, "vps/t3/app")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["machines", "owner"]);
    expect(placed.circles.get("machines")?.members[0]).toMatchObject({
      rights: { readsCode: { mode: "automatic" }, runsCommands: { mode: "automatic" } },
    });
  });

  it("copies a lower level of the T3 agents share, never turns on an exec right that the owner set off, and names a stacked card", () => {
    const base = world(mac({ mode: "off" }), ["vps/t3/agents", "vps/t3/app"], {
      shareSettings: new Map([[shareKey("vps/t3/agents", "machines"), { level: "use", endsAt: null }]]),
    });
    // Both cards sit in the circle and a "use" share is no exec share, so nothing changes.
    expect(migrateAgentShares(base)).toEqual({ changes: [], unmet: [] });
    // An exec share keeps every mode that the owner set: off, ask a circle, and automatic.
    for (const mode of [{ mode: "off" }, { mode: "ask", circleId: "owner" }, { mode: "automatic" }] as const)
      expect(migrateAgentShares(world(mac(mode), ["vps/t3/agents", "vps/t3/app"]))).toEqual({
        changes: [],
        unmet: [],
      });

    const stacked = migrateAgentShares(
      world(mac(), ["vps/t3/agents"], {
        stacks: new Map([["s", { id: "s", name: "", members: ["vps/t3/app", "vps"] }]]),
      }),
    );
    expect(stacked.unmet).toEqual([expect.stringMatching(/share it there by hand/)]);
  });

  it("keeps the end date of a T3 agents share also when its level is the circle level, so no share outlives it", () => {
    const endsAt = 1_900_000_000_000;
    const timed = world(mac({ mode: "off" }), ["vps/t3/agents"], {
      circles: new Map([
        ["machines", circle("machines", [mac({ mode: "off" })], { x: 0, r: 100 })],
        ["owner", circle("owner", [{ _tag: "email", email: "owner@example.com" }], { x: 150, r: 100 })],
      ]),
      places: new Map([
        ["vps", { x: 150, y: 0 }],
        ["vps/t3/agents", { x: 0, y: 0 }],
        ["vps/t3/app", { x: 200, y: 0 }],
      ]),
      shareSettings: new Map([[shareKey("vps/t3/agents", "machines"), { level: null, endsAt }]]),
    });
    const after = applyChanges(timed, migrateAgentShares(timed).changes);
    expect(after.shareSettings.get(shareKey("vps/t3/app", "machines"))).toEqual({ level: null, endsAt });
  });

  it("moves no share of a circle that holds more than machines, and sets no right that would cover another machine", () => {
    // A person in the circle would get T3 itself with the app card, so the card stays where it is.
    const people = world(mac(), ["vps/t3/agents"], {
      circles: new Map([
        [
          "machines",
          circle("machines", [mac(), { _tag: "email", email: "her@example.com" }], { x: 0, r: 100 }),
        ],
      ]),
    });
    expect(migrateAgentShares(people)).toEqual({
      changes: [],
      unmet: [expect.stringMatching(/machines holds more than machines/)],
    });
    // mac also controls the machine card of db in that circle, so automatic would cover db too.
    const db = card("db", "machine", null);
    const wider = world(mac(), ["vps/t3/agents", "vps/t3/app", "db"], {
      machines: new Map([
        ["mac", machineOf("mac")],
        ["vps", machineOf("vps")],
        ["db", machineOf("db")],
      ]),
    });
    const withDb: State = {
      ...wider,
      resources: new Map([...wider.resources, ["db", db]]),
      places: new Map([...wider.places, ["db", { x: 0, y: 0 }]]),
    };
    expect(migrateAgentShares(withDb)).toEqual({
      changes: [],
      unmet: [expect.stringMatching(/"Runs commands" of mac stays unset: automatic would also cover db/)],
    });
  });
});
