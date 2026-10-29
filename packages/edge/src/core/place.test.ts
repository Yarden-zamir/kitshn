import { describe, expect, it } from "vitest";
import { applyChanges, invert, resolveEdits } from "./changes.ts";
import {
  type Circle,
  type Point,
  type Resource,
  type State,
  circlesHolding,
  circlesOverlap,
  insideCircle,
} from "./model.ts";
import { CARD_BOX, circleForCards, enclosingSquare, squareMoves } from "./place.ts";

/** K-529: "New circle for these" places one new circle around the selected cards and keeps every card's circles. */

const circle = (id: string, x: number, y: number, r: number): Circle => ({
  id,
  name: id,
  color: "#6C5CE7",
  level: "view",
  members: [],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y,
  r,
});
const card = (id: string): Resource => ({
  id,
  kind: "file",
  name: id,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

function world(
  circles: ReadonlyArray<Circle>,
  places: Record<string, Point>,
  stacks: Record<string, Array<string>> = {},
): State {
  return {
    circles: new Map(circles.map((each) => [each.id, each])),
    resources: new Map(Object.keys(places).map((id) => [id, card(id)])),
    places: new Map(Object.entries(places)),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(Object.entries(stacks).map(([id, members]) => [id, { id, name: id, members }])),
    paused: null,
    machines: new Map(),
  };
}

const template = {
  id: "new",
  name: "New circle",
  color: "#14B8A6",
  level: "view",
  members: [],
  match: "any",
  needsPasskey: false,
  endsAt: null,
} as const;

const overlap = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < 2 * CARD_BOX.half && Math.abs(a.y - b.y) < CARD_BOX.above + CARD_BOX.below;

/** Applies the edits as the server does, and checks the rule of K-529 for every card of the map. */
function apply(state: State, selected: ReadonlyArray<string>) {
  const plan = circleForCards(state, selected, template);
  if ("refused" in plan) throw new Error(plan.refused);
  const changes = resolveEdits(state, plan.edits);
  const after = applyChanges(state, changes);
  const made = after.circles.get("new");
  if (!made) throw new Error("no new circle");
  // A selected card takes its stack along (K-521).
  const chosen = new Set(selected);
  for (const stack of state.stacks.values())
    if (stack.members.some((id) => chosen.has(id))) for (const id of stack.members) chosen.add(id);
  for (const id of state.places.keys()) {
    const before = circlesHolding(state, id)
      .map((each) => each.id)
      .sort();
    const now = circlesHolding(after, id)
      .map((each) => each.id)
      .filter((each) => each !== "new")
      .sort();
    expect(now, `${id} keeps its circles`).toEqual(before);
    expect(
      insideCircle(after.places.get(id) as Point, made),
      `${id} is inside the new circle only when selected`,
    ).toBe(chosen.has(id));
  }
  return { plan, changes, after, made };
}

describe("New circle for these (K-529)", () => {
  it("draws the smallest square around the cards and moves nothing when no other card is inside", () => {
    const state = world([circle("her", 0, 0, 600)], {
      a: { x: -100, y: 0 },
      b: { x: 100, y: 0 },
      far: { x: 0, y: 500 },
    });
    const { plan, made } = apply(state, ["a", "b"]);
    expect(plan.moved).toBe(0);
    expect(made).toMatchObject({ x: 0, y: 0, members: [] });
  });

  it("moves an unselected card out to its nearest spot in its own circles", () => {
    const state = world([circle("her", 0, 0, 800)], {
      a: { x: -200, y: 0 },
      b: { x: 200, y: 0 },
      middle: { x: 0, y: 0 },
    });
    const { plan, after } = apply(state, ["a", "b"]);
    expect(plan.moved).toBe(1);
    expect(after.places.get("a")).toEqual({ x: -200, y: 0 });
  });

  it("pulls spread cards together when that moves fewer cards than pushing others out", () => {
    // The circle around a and b as they are would hold all four others; pulled to the free middle, it holds none.
    const others = Object.fromEntries([-500, -350, 350, 500].map((x) => [`o${x}`, { x, y: 0 }]));
    const state = world([circle("her", 0, 0, 1000)], {
      a: { x: -700, y: 0 },
      b: { x: 700, y: 0 },
      ...others,
    });
    const { plan, after } = apply(state, ["a", "b"]);
    expect(plan.moved).toBe(2);
    for (const id of Object.keys(others)) expect(after.places.get(id)).toEqual(state.places.get(id));
  });

  it("keeps pulled cards apart unless they are one stack", () => {
    // The reviewer's case: a and b would both land on the middle of A.
    const state = world(
      [circle("A", 0, 0, 700)],
      {
        a: { x: -400, y: 0 },
        b: { x: 400, y: 0 },
        s1: { x: 0, y: -400 },
        s2: { x: 0, y: -400 },
        u1: { x: -300, y: 0 },
        u2: { x: -200, y: 0 },
        u3: { x: 200, y: 0 },
        u4: { x: 300, y: 0 },
      },
      { st: ["s1", "s2"] },
    );
    const { after } = apply(state, ["a", "b", "s1"]);
    const cards = ["a", "b", "s1", "s2", "u1", "u2", "u3", "u4"];
    for (const one of cards)
      for (const other of cards) {
        // Only pulled cards must keep clear; u1 to u4 already overlap each other in this layout.
        const pulled = (id: string) => !id.startsWith("u");
        if (one >= other || !(pulled(one) || pulled(other)) || (one.startsWith("s") && other.startsWith("s")))
          continue;
        const p = after.places.get(one) as Point;
        const q = after.places.get(other) as Point;
        const apart = Math.abs(p.x - q.x) >= 190 || Math.abs(p.y - q.y) >= 86;
        expect(apart, `${one} and ${other} do not overlap`).toBe(true);
      }
    expect(after.places.get("s1")).toEqual(after.places.get("s2"));
  });

  it("never pulls a card onto a selected card that stays (review repro)", () => {
    const state = world([circle("c1", -328, -126, 438), circle("c2", -543, -487, 734)], {
      k0: { x: -252, y: -204 },
      k1: { x: 412, y: 353 },
      k2: { x: -415, y: -291 },
      k3: { x: 254, y: -251 },
      k4: { x: -498, y: -139 },
      k5: { x: -274, y: -330 },
    });
    const { after } = apply(state, ["k2", "k4"]);
    expect(overlap(after.places.get("k2") as Point, after.places.get("k4") as Point)).toBe(false);
  });

  it("leaves a selected card that sits in the middle where it is", () => {
    const state = world([circle("her", 0, 0, 900)], {
      a: { x: 0, y: 0 },
      b: { x: 600, y: 0 },
      u: { x: 300, y: 0 },
    });
    const { after } = apply(state, ["a", "b"]);
    expect(after.places.get("a")).toEqual({ x: 0, y: 0 });
  });

  it("keeps a card in no circle in no other circle, and an unselected one out of the new circle", () => {
    const state = world([circle("her", 0, 0, 300)], {
      a: { x: 600, y: 0 },
      b: { x: 800, y: 0 },
      loose: { x: 700, y: 0 },
      inside: { x: 0, y: 0 },
    });
    apply(state, ["a", "b"]);
    apply(state, ["a", "inside"]);
  });

  it("takes the whole stack when one of its cards is selected", () => {
    const state = world(
      [circle("her", 0, 0, 600)],
      { a: { x: -100, y: 0 }, s1: { x: 100, y: 0 }, s2: { x: 100, y: 0 } },
      { st: ["s1", "s2"] },
    );
    const plan = circleForCards(state, ["a", "s1"], template);
    if ("refused" in plan) throw new Error(plan.refused);
    const after = applyChanges(state, resolveEdits(state, plan.edits));
    expect(insideCircle(after.places.get("s2") as Point, after.circles.get("new") as Circle)).toBe(true);
  });

  it("refuses, and changes nothing, when an unselected card cannot leave without changing its circles", () => {
    const state = world([circle("small", 0, 0, 150)], {
      a: { x: -60, y: 0 },
      b: { x: 60, y: 0 },
      trapped: { x: 0, y: 60 },
    });
    const plan = circleForCards(state, ["a", "b"], template);
    expect(plan).toEqual({ refused: expect.stringContaining("trapped cannot leave the new circle") });
  });

  it("refuses a circle wider than 3 times the widest circle", () => {
    // Each card sits in its own small circle, far apart, so no plan can bring them close.
    const state = world([circle("left", -2000, 0, 100), circle("right", 2000, 0, 100)], {
      a: { x: -2000, y: 0 },
      b: { x: 2000, y: 0 },
    });
    expect(circleForCards(state, ["a", "b"], template)).toEqual({
      refused: expect.stringContaining("wider than 3 times"),
    });
  });

  it("is undone as one change: every moved card goes back and the circle goes", () => {
    const state = world([circle("her", 0, 0, 800)], {
      a: { x: -200, y: 0 },
      b: { x: 200, y: 0 },
      middle: { x: 0, y: 0 },
    });
    const { changes, after } = apply(state, ["a", "b"]);
    const undone = applyChanges(after, invert(changes));
    expect(undone.circles.has("new")).toBe(false);
    expect([...undone.places]).toEqual([...state.places]);
  });

  it("finds the smallest enclosing square", () => {
    expect(enclosingSquare([{ x: 0, y: 0 }])).toEqual({ x: 0, y: 0, r: 0 });
    // The wider side decides: 2 wide and 0.5 tall.
    expect(
      enclosingSquare([
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 0.5 },
      ]),
    ).toEqual({ x: 0, y: 0.25, r: 1 });
    expect(
      enclosingSquare([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 0, y: 3 },
      ]),
    ).toEqual({ x: 2, y: 1.5, r: 2 });
  });
});

describe("circles are squares (K-536)", () => {
  const her = circle("her", 0, 0, 100);

  it("holds a card in its corner, which a round circle left out", () => {
    expect(insideCircle({ x: 90, y: 90 }, her)).toBe(true);
    expect(insideCircle({ x: -99, y: 99 }, her)).toBe(true);
    expect(insideCircle({ x: 100, y: 0 }, her)).toBe(false);
    expect(insideCircle({ x: 0, y: -101 }, her)).toBe(false);
  });

  it("overlaps another square only when both axes overlap", () => {
    expect(circlesOverlap(her, circle("near", 150, 150, 60))).toBe(true);
    expect(circlesOverlap(her, circle("beside", 200, 0, 100))).toBe(false);
    expect(circlesOverlap(her, circle("below", 0, 250, 140))).toBe(false);
  });

  it("moves a card in a corner out to keep exactly its round circles, and leaves the rest", () => {
    const state = world([her, circle("him", 400, 0, 100)], {
      corner: { x: 85, y: 85 },
      middle: { x: 0, y: 0 },
      outside: { x: 1000, y: 1000 },
    });
    const { moves, stuck } = squareMoves(state);
    expect(stuck).toEqual([]);
    expect(moves.map((move) => move.id)).toEqual(["corner"]);
    const after = new Map(state.places).set("corner", moves[0]?.after as Point);
    expect(circlesHolding({ ...state, places: after }, "corner")).toEqual([]);
  });

  it("keeps a card in the corner of an overlap in exactly the circles that held it", () => {
    // "in" sits inside round her, and inside the corner of square him, where round him left it out.
    const state = world([her, circle("him", 150, 150, 120)], { in: { x: 60, y: 60 } });
    const before = new Set(["her"]);
    expect(new Set(circlesHolding(state, "in").map((each) => each.id))).toEqual(new Set(["her", "him"]));
    const { moves } = squareMoves(state);
    const after = { ...state, places: new Map(state.places).set("in", moves[0]?.after as Point) };
    expect(new Set(circlesHolding(after, "in").map((each) => each.id))).toEqual(before);
  });

  it("moves a stack as one unit, onto one spot", () => {
    const state = world(
      [her],
      { a: { x: 88, y: -88 }, b: { x: 88, y: -88 }, alone: { x: 0, y: 0 } },
      { s: ["a", "b"] },
    );
    const { moves } = squareMoves(state);
    expect(moves.map((move) => move.id).sort()).toEqual(["a", "b"]);
    expect(moves[0]?.after).toEqual(moves[1]?.after);
  });

  it("moves nothing on a map where every card keeps its circles", () => {
    const state = world([her], { middle: { x: 0, y: 0 }, far: { x: 500, y: 0 } });
    expect(squareMoves(state)).toEqual({ moves: [], stuck: [] });
  });
});

/** A small seeded random generator (mulberry32), so the property test is the same on every run. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("New circle for these on random maps (K-529)", () => {
  it("keeps every card's circles, holds exactly the selection, and adds no overlap", () => {
    const random = seeded(529);
    const between = (low: number, high: number) => Math.round(low + random() * (high - low));
    let made = 0;
    for (let layout = 0; layout < 300; layout++) {
      const circles = Array.from({ length: between(1, 4) }, (_, i) =>
        circle(`c${i}`, between(-800, 800), between(-800, 800), between(200, 800)),
      );
      const places: Record<string, Point> = {};
      const count = between(3, 9);
      for (let i = 0; i < count; i++) places[`k${i}`] = { x: between(-1000, 1000), y: between(-1000, 1000) };
      const stacks: Record<string, Array<string>> = {};
      if (random() < 0.3) {
        places["k1"] = places["k0"] as Point;
        stacks["st"] = ["k0", "k1"];
      }
      const state = world(circles, places, stacks);
      const selected = Object.keys(places).filter(() => random() < 0.4);
      if (selected.length < 2) continue;
      const plan = circleForCards(state, selected, template);
      if ("refused" in plan) continue;
      made++;
      const { after } = apply(state, selected);
      const stackOf = (id: string) => (stacks["st"]?.includes(id) ? "st" : id);
      const names = Object.keys(places);
      for (const one of names)
        for (const other of names) {
          if (one >= other || stackOf(one) === stackOf(other)) continue;
          if (overlap(places[one] as Point, places[other] as Point)) continue;
          expect(
            overlap(after.places.get(one) as Point, after.places.get(other) as Point),
            `layout ${layout}: ${one} and ${other}`,
          ).toBe(false);
        }
    }
    // Most layouts make a circle, so the checks above ran on real plans.
    expect(made).toBeGreaterThan(100);
  });
});
