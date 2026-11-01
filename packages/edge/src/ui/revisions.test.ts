import { describe, expect, it } from "vitest";
import type { Author } from "../core/changes.ts";
import type { RevisionView } from "../core/protocol.ts";
import { dayOf, filterHistory, groupHistory, rowText, undoableRow, undoneText } from "./revisions.ts";

const me: Author = { _tag: "person", email: "me@example.com" };
const bot: Author = { _tag: "device", clientId: "c1", name: "Bot" };

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

const revision = (id: number, at: number, actor: Author, summary = "Moved a card"): RevisionView => ({
  id,
  at,
  undoSource: null,
  actor,
  summary,
  undoes: null,
  undoneBy: null,
  undoable: true,
  kind: "card",
  items: [{ kind: "card", id: "tick3d" }],
});

describe("History rows start with the verb, under their actor (K-1508)", () => {
  it.each([
    ["tick3d: + Everyone · view", "shared tick3d with Everyone at view"],
    ["tick3d: − Her", "removed tick3d from Her"],
    ["a: + Qlik · use; b: − Her", "shared a with Qlik at use and removed b from Her"],
    [
      "a: + X · view; b: + X · view; c: + X · view; and 2 more",
      "shared a with X at view, shared b with X at view, shared c with X at view and 2 more",
    ],
    ["Set up kitshn", "set up kitshn"],
    ["Created circle Agents", "created circle Agents"],
    ["riffle: Her · view → use", "changed the level of riffle in Her from view to use"],
    ["Undo #12: tick3d: − Her", "undid #12 and so removed tick3d from Her"],
    ["Undo #12 for tick3d: Moved a card", "undid #12 for tick3d and so moved a card"],
  ])("says %s as %s", (summary, said) => {
    expect(rowText(summary)).toBe(said);
  });

  it("says in an undo toast what came back, also for a name with a colon (K-1502)", () => {
    expect(["tick3d: − Her", "a: b: + Qlik · use", "Stacked riffle, tick3d"].map(undoneText)).toEqual([
      "Removed tick3d from Her",
      "Shared a: b with Qlik at use",
      "Stacked riffle, tick3d",
    ]);
  });

  it("keeps a summary of an unknown shape as it is, so it adds no fact", () => {
    expect(rowText("Sign out everywhere: kitshn refuses older logins")).toBe(
      "Sign out everywhere: kitshn refuses older logins",
    );
  });
});

describe("History groups (K-1508)", () => {
  it("groups by day, then by runs of one actor, newest first", () => {
    const yesterday = NOW - 20 * HOUR;
    const groups = groupHistory(
      [
        revision(5, NOW - HOUR, me),
        revision(4, NOW - 2 * HOUR, me),
        revision(3, NOW - 3 * HOUR, bot),
        revision(2, yesterday, bot),
        revision(1, NOW - 30 * 24 * HOUR, me),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.day, group.actor, group.revisions.map((item) => item.id)])).toEqual([
      ["Today", me, [5, 4]],
      ["Today", bot, [3]],
      ["Yesterday", bot, [2]],
      ["Older", me, [1]],
    ]);
  });

  it("splits days at local midnight", () => {
    const midnight = new Date(2026, 9, 28).getTime();
    const yesterday = new Date(2026, 9, 27).getTime();
    expect(dayOf(midnight, NOW)).toBe("Today");
    expect(dayOf(midnight - 1, NOW)).toBe("Yesterday");
    expect(dayOf(yesterday, NOW)).toBe("Yesterday");
    expect(dayOf(yesterday - 1, NOW)).toBe("Older");
  });

  it("filters by kind, actor and the name of a changed item", () => {
    const revisions = [
      revision(3, NOW, me),
      { ...revision(2, NOW, bot), kind: "circle" as const, items: [{ kind: "circle" as const, id: "c-1" }] },
      revision(1, NOW, bot),
    ];
    const names = (item: { readonly id: string }) => (item.id === "c-1" ? "Agents" : "tick3d");
    const ids = (filter: Parameters<typeof filterHistory>[1]) =>
      filterHistory(revisions, filter, names).map((item) => item.id);
    expect(ids({ kind: "circle", actor: null, item: "" })).toEqual([2]);
    expect(ids({ kind: null, actor: "device:c1", item: "" })).toEqual([2, 1]);
    expect(ids({ kind: null, actor: null, item: "agen" })).toEqual([2]);
  });
});

describe("History Undo (K-1506)", () => {
  it("offers Undo only on the caller's own newest change that is not an action or undone", () => {
    const revisions = [
      revision(5, NOW, bot),
      { ...revision(4, NOW, me), undoable: false },
      { ...revision(3, NOW, me), undoneBy: 6 },
      revision(2, NOW, me),
      revision(1, NOW, me),
    ];
    expect(undoableRow(revisions, me)).toBe(2);
    expect(undoableRow(revisions, { _tag: "person", email: "other@example.com" })).toBeNull();
  });
});
