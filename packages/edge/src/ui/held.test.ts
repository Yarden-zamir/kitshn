import { describe, expect, it } from "vitest";
import type { Edit } from "../core/changes.ts";
import { seed } from "../core/seed.ts";
import type { State } from "../core/model.ts";
import { type Held, isNewer, overlay, settle } from "./held.ts";

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  return {
    circles: new Map(s.circles.map((circle) => [circle.id, circle])),
    resources: new Map(s.resources.map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
    actors: new Map(s.actors.map((actor) => [actor.id, actor])),
  };
}

const move = (x: number): Array<Edit> => [{ _tag: "place", id: "kitshn-admin", after: { x, y: 40 } }];

describe("held edits on the map", () => {
  it("shows a dropped card where it was dropped until a snapshot has the saving revision", () => {
    const old = start();
    const held: Array<Held> = [{ requestId: "a", edits: move(50), revision: null }];
    // An older snapshot arrives while the save runs: the card stays where it was dropped.
    expect(overlay(old, settle(held, 7)).places.get("kitshn-admin")).toEqual({ x: 50, y: 40 });
    // The server answers revision 8; a snapshot of revision 7 still does not settle it.
    const saved = [{ ...held[0]!, revision: 8 }];
    expect(settle(saved, 7)).toBe(saved);
    // The snapshot of revision 8 holds the change, so the held edit goes.
    expect(settle(saved, 8)).toEqual([]);
  });

  it("applies held edits in order, so the newest drop wins", () => {
    const held: Array<Held> = [
      { requestId: "a", edits: move(50), revision: 8 },
      { requestId: "b", edits: move(90), revision: null },
    ];
    expect(overlay(start(), held).places.get("kitshn-admin")).toEqual({ x: 90, y: 40 });
  });

  it("keeps an edit whose answer was lost until the next snapshot", () => {
    const lost: Array<Held> = [{ requestId: "a", edits: move(50), revision: 0 }];
    expect(overlay(start(), lost).places.get("kitshn-admin")).toEqual({ x: 50, y: 40 });
    expect(settle(lost, 3)).toEqual([]);
  });

  it("ignores a snapshot that is older than the one shown", () => {
    expect(isNewer(5, 6)).toBe(false);
    expect(isNewer(6, 6)).toBe(true);
    expect(isNewer(1, null)).toBe(true);
  });

  it("leaves out an edit that no longer fits", () => {
    const held: Array<Held> = [
      { requestId: "a", edits: [{ _tag: "place", id: "gone", after: { x: 1, y: 1 } }], revision: null },
    ];
    expect(overlay(start(), held).places.has("gone")).toBe(false);
  });
});
