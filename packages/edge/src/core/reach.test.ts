import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import type { Circle, Resource, State } from "./model.ts";
import { actorOf, chip, login, machineKey } from "./testkit.ts";
import { capabilitiesOf, reachOf } from "./reach.ts";

const machine = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `token-${id}`,
  clientId: `client-${id}`,
  tunnelId: `tunnel-${id}`,
});
const card = (id: string, kind: Resource["kind"], host: string | null = null): Resource => ({
  id,
  kind,
  name: id,
  addresses: kind === "machine" ? [] : [`${id}.example.com`],
  status: "running",
  group: null,
  machine: host,
});
const circle = (id: string, x: number, level: Circle["level"], members: Circle["members"]): Circle => ({
  id,
  name: id,
  color: "#6C5CE7",
  level,
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 0,
  r: 300,
});

/** Circle "machines" holds mac and vps with `use`; circle "her" (a person) holds riffle, which runs on vps. */
function start(): State {
  const machines = circle("machines", 0, "use", [chip(machineKey("mac")), chip(machineKey("vps"))]);
  const her = circle("her", 1000, "control", [chip(login("her@example.com"))]);
  return {
    circles: new Map([machines, her].map((c) => [c.id, c])),
    resources: new Map(
      [card("mac", "machine"), card("vps", "machine"), card("riffle", "site.compose", "vps")].map((r) => [
        r.id,
        r,
      ]),
    ),
    places: new Map([
      ["mac", { x: -50, y: 0 }],
      ["vps", { x: 50, y: 0 }],
      ["riffle", { x: 1000, y: 0 }],
    ]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    actors: new Map(
      [
        actorOf(machineKey("mac"), "mac"),
        actorOf(machineKey("vps"), "vps"),
        actorOf(login("her@example.com")),
      ].map((actor) => [actor.id, actor]),
    ),
    machines: new Map([machine("mac"), machine("vps")].map((m) => [m.id, m])),
  };
}

const summary = (state: State, id: string) =>
  reachOf(state, id, 0).map(
    (line) => `${line.from.id}>${line.to} ${line.level ?? "-"}${line.runs ? " runs" : ""}`,
  );

describe("reach of the relationship lens (K-537)", () => {
  it("draws machines by their own token, other members from the circle head, and what runs where", () => {
    expect(summary(start(), "vps").sort()).toEqual(["mac>vps use", "vps>mac use", "vps>riffle - runs"]);
    // Riffle's level comes from "her"; the site cuts control down to view (K-206).
    expect(summary(start(), "riffle").sort()).toEqual(["her>riffle view", "vps>riffle - runs"]);
  });

  it("merges a share and a host into one line per pair", () => {
    const state = start();
    const both = { ...state, places: new Map([...state.places, ["riffle", { x: 0, y: 0 }]]) };
    const line = reachOf(both, "riffle", 0).find((each) => each.from.id === "vps");
    expect(line).toMatchObject({ level: "view", runs: true, via: ["machines"] });
  });

  it("shows nothing that Access refuses: a machine in an all-match circle with a person, or a pause", () => {
    const state = start();
    const strict = { ...state.circles.get("machines")!, match: "all" as const };
    const all = { ...state, circles: new Map([...state.circles, ["machines", strict]]) };
    expect(summary(all, "vps")).toEqual(["vps>riffle - runs"]);
    expect(summary({ ...state, paused: "keep-public" }, "vps")).toEqual(["vps>riffle - runs"]);
  });

  it("draws no head line for a circle that Access gives no policy, and counts every member of an all-match circle", () => {
    const state = start();
    // The reviewer's case: all must match a machine and a person, which no single visitor does.
    const strict = circle("strict", 1000, "view", [chip(machineKey("vps")), chip(login("her@example.com"))]);
    const her = { ...state.circles.get("her")!, x: 5000 };
    const mixed = {
      ...state,
      circles: new Map([...state.circles, ["her", her], ["strict", { ...strict, match: "all" as const }]]),
    };
    expect(summary(mixed, "riffle")).toEqual(["vps>riffle - runs"]);
    const network = circle("network", 1000, "view", [
      { _tag: "domain", domain: "example.com" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ]);
    const both = {
      ...state,
      circles: new Map([...state.circles, ["her", her], ["network", { ...network, match: "all" as const }]]),
    };
    expect(reachOf(both, "riffle", 0)).toContainEqual(
      expect.objectContaining({ from: { _tag: "circle", id: "network" }, members: 2 }),
    );
  });

  it("draws no machine line for a level that only a public circle gives", () => {
    const state = start();
    const everyone = circle("everyone", 1000, "view", [{ _tag: "everyone" }]);
    const her = { ...state.circles.get("her")!, x: 5000 };
    const open = { ...state, circles: new Map([...state.circles, ["her", her], ["everyone", everyone]]) };
    expect(summary(open, "riffle").sort()).toEqual(["everyone>riffle view", "vps>riffle - runs"]);
  });

  it("counts a machine without a card as a member of its circle head", () => {
    const state = start();
    const lonely = { ...state, places: new Map([...state.places].filter(([id]) => id !== "mac")) };
    expect(reachOf(lonely, "vps", 0)).toContainEqual(
      expect.objectContaining({ from: { _tag: "circle", id: "machines" }, level: "use", members: 1 }),
    );
  });
});

describe("capabilities of a level (K-537)", () => {
  it("names only what kitshn enforces itself", () => {
    expect(capabilitiesOf(card("vps", "machine"), "use")).toEqual([]);
    expect(capabilitiesOf(card("vps", "machine"), "control")).toEqual(["exec"]);
    expect(capabilitiesOf(card("riffle", "site.compose"), "view")).toEqual(["open"]);
  });
});
