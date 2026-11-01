import { describe, expect, it } from "vitest";
import { applyChanges, resolveEdits, shareDiff } from "./changes.ts";
import type { Circle, Member, Point, Resource, ResourceKind, State } from "./model.ts";
import { type DrawnSizes, NO_SIZES, organize } from "./organize.ts";
import { type Box, USER_STACK, boxesOverlap, cardBox, headAngle, stacksOf } from "./place.ts";
import { actorOf, chip, login } from "./testkit.ts";

/** K-532: Organize keeps every share, moves nothing on a second run, and leaves no overlap. */

const owner: Member = chip(login("owner@example.com"));
const circle = (id: string, x: number, y: number, r: number, members: Array<Member> = [owner]): Circle => ({
  id,
  name: id,
  color: "#6C5CE7",
  level: "view",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y,
  r,
});
const card = (id: string, kind: ResourceKind, group: string | null = null): Resource => ({
  id,
  kind,
  name: id,
  addresses: [],
  status: "running",
  group,
  machine: null,
});

/**
 * Two circles that overlap, a circle inside a bigger one, and cards in each area and in none: single cards of
 * several kinds, a stack of the owner and a stack by group.
 */
function world(): State {
  const resources = [
    card("zeta", "page"),
    card("alpha", "page"),
    card("site", "site.static"),
    card("box", "machine"),
    card("both", "file"),
    card("inner", "file"),
    card("ring", "repo"),
    card("loose", "file"),
    card("loose-2", "page"),
    card("s1", "file"),
    card("s2", "file"),
    card("g1", "site.worker", "api"),
    card("g2", "site.worker", "api"),
  ];
  const places: Record<string, Point> = {
    zeta: { x: -50, y: 40 },
    alpha: { x: -120, y: -80 },
    site: { x: -200, y: 100 },
    box: { x: -260, y: -20 },
    both: { x: 300, y: 0 },
    inner: { x: 1405, y: 10 },
    ring: { x: 1100, y: 300 },
    loose: { x: -900, y: 900 },
    "loose-2": { x: 2200, y: -700 },
    s1: { x: -150, y: 220 },
    s2: { x: -150, y: 220 },
    g1: { x: 500, y: 150 },
    g2: { x: 520, y: 170 },
  };
  return {
    circles: new Map(
      [
        circle("A", 0, 0, 450),
        circle("B", 650, 0, 400, []),
        circle("Outer", 1400, 0, 500),
        circle("Inner", 1400, 0, 160),
      ].map((each) => [each.id, each]),
    ),
    resources: new Map(resources.map((resource) => [resource.id, resource])),
    places: new Map(Object.entries(places)),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map([["s", { id: "s", name: "Notes", members: ["s1", "s2"] }]]),
    paused: null,
    machines: new Map(),
    actors: new Map([actorOf(login("owner@example.com"))].map((actor) => [actor.id, actor])),
  };
}

/** The drawn sizes of the expand states: an open stack as a tall column, a card with a preview frame, wide chips. */
const OPEN: DrawnSizes = {
  units: new Map<string, Box>([
    ["s1", { left: -95, top: -36, right: 95, bottom: 330 }],
    ["alpha", { left: -95, top: -36, right: 95, bottom: 190 }],
    ["g1", { left: -95, top: -36, right: 95, bottom: 260 }],
    ["box", { left: -95, top: -36, right: 95, bottom: 110 }],
  ]),
  heads: new Map([["A", { width: 260, height: 40 }]]),
  members: new Map([["A", { width: 420, height: 60 }]]),
};

function organized(state: State, sizes: DrawnSizes) {
  const result = organize(state, sizes);
  if ("refused" in result) throw new Error(result.refused);
  return { ...result, after: applyChanges(state, resolveEdits(state, result.edits)) };
}

/** The drawn box of every unit, from the place of its first card. */
function drawn(state: State, sizes: DrawnSizes): Array<{ readonly id: string; readonly box: Box }> {
  const inStack = new Set([...stacksOf(state).values()].flat());
  const firsts = [
    ...[...stacksOf(state).values()].map((ids) => ids[0] as string),
    ...[...state.places.keys()].filter((id) => !inStack.has(id)),
  ];
  return firsts.map((id) => {
    const place = state.places.get(id) as Point;
    const box = sizes.units.get(id) ?? cardBox({ x: 0, y: 0 });
    return {
      id,
      box: {
        left: box.left + place.x,
        top: box.top + place.y,
        right: box.right + place.x,
        bottom: box.bottom + place.y,
      },
    };
  });
}

describe("organize (K-532)", () => {
  it.each([
    ["closed stacks and plain cards", NO_SIZES],
    ["an open stack, a preview frame and wide chips", OPEN],
  ])("keeps every share and leaves no overlap, with %s", (_, sizes) => {
    const state = world();
    const { after, moved } = organized(state, sizes);
    expect(moved).toBeGreaterThan(0);
    expect(shareDiff(state, after)).toEqual([]);
    const boxes = drawn(after, sizes);
    // No card covers a head: each head stays at the top of its edge.
    for (const each of after.circles.values())
      expect(
        headAngle(
          each,
          boxes.map((unit) => unit.box),
        ),
      ).toBe(0);
    for (const [index, { id, box }] of boxes.entries()) {
      for (const other of boxes.slice(index + 1))
        expect([id, other.id, boxesOverlap(box, other.box)]).toEqual([id, other.id, false]);
      // No card covers the chip row of a circle.
      for (const each of after.circles.values()) {
        const chips = sizes.members.get(each.id);
        if (!chips) continue;
        const top = each.y - each.r + 30;
        const row = {
          left: each.x - chips.width / 2,
          top,
          right: each.x + chips.width / 2,
          bottom: top + chips.height,
        };
        expect([id, each.id, boxesOverlap(box, row)]).toEqual([id, each.id, false]);
      }
    }
    // A stack stays one unit on one spot (K-521).
    expect(after.places.get("s2")).toEqual(after.places.get("s1"));
    expect(after.places.get("g2")).toEqual(after.places.get("g1"));
    // A second Organize moves nothing.
    expect(organized(after, sizes).edits).toEqual([]);
  });

  it("orders each area by kind and then by name, in rows", () => {
    const { after } = organized(world(), NO_SIZES);
    const at = (id: string) => after.places.get(id) as Point;
    // In A, by the order of RESOURCE_KINDS: the machine, the static site, the pages alpha and zeta, the stack of files.
    const reading = (a: Point, b: Point) => a.y < b.y || (a.y === b.y && a.x < b.x);
    expect(reading(at("box"), at("site"))).toBe(true);
    expect(reading(at("site"), at("alpha"))).toBe(true);
    expect(reading(at("alpha"), at("zeta"))).toBe(true);
    expect(reading(at("zeta"), at("s1"))).toBe(true);
    // Cards in no circle line up to the right of every circle.
    expect(at("loose").x).toBeGreaterThan(1900);
    expect(at("loose").y).toBe(at("loose-2").y);
  });

  it("goes around a card that stays, beside it, instead of refusing", () => {
    const state: State = {
      ...world(),
      circles: new Map([["Big", circle("Big", 6000, 2000, 500, [])]]),
      resources: new Map([
        ["fixed", card("fixed", "page")],
        ["free", card("free", "page")],
      ]),
      places: new Map([
        ["fixed", { x: 6000, y: 1600 }],
        ["free", { x: 6100, y: 2300 }],
      ]),
      stacks: new Map(),
    };
    // A tall open column down the middle of the circle stays where it is.
    const sizes: DrawnSizes = {
      ...NO_SIZES,
      units: new Map([["fixed", { left: -95, top: -36, right: 95, bottom: 964 }]]),
    };
    const result = organize(state, sizes, (id) => id === "free");
    if ("refused" in result) throw new Error(result.refused);
    const after = applyChanges(state, resolveEdits(state, result.edits));
    const [fixed, free] = drawn(after, sizes);
    expect(fixed && free && boxesOverlap(fixed.box, free.box)).toBe(false);
  });

  it("moves only the cards that the caller may move, around the others", () => {
    const state = world();
    const result = organize(state, NO_SIZES, (id) => id === "zeta" || id === "alpha");
    if ("refused" in result) throw new Error(result.refused);
    expect(new Set(result.edits.map((edit) => (edit._tag === "place" ? edit.id : edit._tag)))).toEqual(
      new Set(["zeta", "alpha"]),
    );
    const after = applyChanges(state, resolveEdits(state, result.edits));
    const boxes = drawn(after, NO_SIZES);
    for (const [index, { box }] of boxes.entries())
      for (const other of boxes.slice(index + 1)) expect(boxesOverlap(box, other.box)).toBe(false);
  });

  it("refuses and moves nothing when an area has no room", () => {
    const state = world();
    const crowded: State = {
      ...state,
      circles: new Map(state.circles).set("Inner", circle("Inner", 1400, 0, 60)),
      places: new Map(state.places).set("inner", { x: 1400, y: 0 }).set("inner-2", { x: 1410, y: 5 }),
      resources: new Map(state.resources).set("inner-2", card("inner-2", "file")),
    };
    expect(organize(crowded, NO_SIZES)).toEqual({ refused: expect.stringContaining("Inner") });
  });

  it("refuses a stack of the owner whose cards sit in different circles", () => {
    const state = world();
    const split: State = { ...state, places: new Map(state.places).set("s2", { x: 650, y: 0 }) };
    expect(organize(split, NO_SIZES)).toEqual({ refused: expect.stringContaining("Notes") });
    expect(stacksOf(split).has(`${USER_STACK}s`)).toBe(true);
  });
});
