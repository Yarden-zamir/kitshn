import { describe, expect, it } from "vitest";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  EVERYONE_CIRCLE_ID,
  OWNER_CIRCLE_ID,
  type Resource,
  type State,
  shareKey,
} from "../core/model.ts";
import type { MachineView } from "../core/protocol.ts";
import { seed } from "../core/seed.ts";
import { actorOf, chip, login } from "../core/testkit.ts";
import {
  CHECKING_TIP,
  type MenuTarget,
  type UndoCheck,
  settleUndoCheck,
  slowUndoCheck,
  type Action,
  type ActionContext,
  type ActionGroups,
  type ActionHandlers,
  actionsFor,
  flatten,
  levelEdit,
  paletteActive,
  paletteArrow,
  paletteEnter,
  paletteEntries,
  type PaletteEntry,
  reshareEdits,
} from "./actions.ts";
import { applyChanges, invert, resolveEdits } from "../core/changes.ts";

/** K-523: the action list per item kind. The menu and the palette both read these lists. */

const card = (id: string, kind: Resource["kind"], addresses: Array<string> = []): Resource => ({
  id,
  kind,
  name: id,
  addresses,
  status: "running",
  group: null,
  machine: null,
});

const her: Circle = {
  id: "her",
  name: "Her",
  color: "#FF5277",
  level: "use",
  members: [chip(login("her@example.com"))],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: -400,
  y: 0,
  r: 200,
};

function context(version = "0123456789ab"): ActionContext {
  const s = seed(["owner@example.com"], "kit.example.com");
  const resources = [
    ...s.resources,
    card("riffle", "site.compose", ["riffle.example.com"]),
    card("vps", "machine"),
    card("notes", "page", ["pages.example.com/notes"]),
    card("a", "file"),
    card("b", "file"),
    card("loose", "file"),
  ];
  const state: State = {
    // Everyone overlaps Owner, so a card fits into both; Her overlaps Owner on the other side.
    circles: new Map(
      [
        ...s.circles.map((circle) => (circle.id === EVERYONE_CIRCLE_ID ? { ...circle, x: 500 } : circle)),
        her,
      ].map((circle) => [circle.id, circle]),
    ),
    resources: new Map(resources.map((resource) => [resource.id, resource])),
    places: new Map([
      ...s.places,
      ["riffle", { x: 0, y: -200 }],
      ["vps", { x: 10, y: 10 }],
      ["a", { x: -500, y: 0 }],
      ["b", { x: -500, y: 0 }],
    ]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map([["s1", { id: "s1", name: "Docs", members: ["a", "b"] }]]),
    paused: null,
    machines: new Map(),
    actors: new Map([...s.actors, actorOf(login("her@example.com"))].map((actor) => [actor.id, actor])),
  };
  const machine: MachineView = {
    machine: {
      id: "vps",
      name: "vps",
      labels: [],
      order: 0,
      serviceTokenId: "t",
      clientId: "c",
      tunnelId: "u",
    },
    online: true,
    lastSeen: null,
    status: null,
    facts: [],
    sample: null,
    os: null,
    keyFailure: null,
    orphanVolumes: [],
    health: null,
    servers: [],
    queued: 0,
    update: null,
  };
  return {
    state,
    deployed: new Set(["riffle"]),
    previews: new Set(),
    machines: new Map([["vps", machine]]),
    version,
    undoCheck: null,
    selected: new Set(),
    previousVersions: new Set(),
    handoverCards: new Set(),
    addressHolds: {},
    openStacks: new Set(),
    folderSites: new Set(),
    providerCommands: {},
  };
}

/** Handlers that record each call by name. */
function recorder() {
  const calls: Array<[string, ...Array<unknown>]> = [];
  const handlers = new Proxy({} as ActionHandlers, {
    get:
      (_target, name) =>
      (...args: Array<unknown>) =>
        calls.push([String(name), ...args]),
  });
  return { calls, handlers };
}

const ids = (groups: ActionGroups | null) => (groups ?? []).flat().map((action) => action.id);
const find = (groups: ActionGroups | null, id: string): Action => {
  const action = (groups ?? []).flat().find((candidate) => candidate.id === id);
  if (!action) throw new Error(`No action ${id} in ${ids(groups).join(", ")}`);
  return action;
};
const run = (action: Action) => {
  if (!("run" in action)) throw new Error(`${action.id} opens a list`);
  action.run();
};
const items = (action: Action) => ("items" in action ? action.items : []);

describe("card actions", () => {
  it("offers a deployed app its address, shares, tray, rollbacks and Remove app, and nothing of a machine", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "riffle" });
    expect(ids(groups)).toEqual([
      "details",
      "open",
      "copy",
      "add-redirect",
      "share",
      "unshare",
      "select-kind",
      "add-to-stack",
      "tray",
      "time",
      "logs",
      "rollback",
      "rollback-run",
      "backups",
      "remove-app",
    ]);
    // K-212, K-533: a card without a time offers end times from now.
    expect(items(find(groups, "time")).map((item) => item.label)).toEqual([
      "For 1 h",
      "For 4 h",
      "For 1 day",
    ]);
    // K-1801: Logs opens the logs of this card.
    run(find(groups, "logs"));
    expect(calls.at(-1)).toMatchObject(["logs", { id: "riffle" }]);
    // K-1819: Backups opens the backups of this Compose card.
    run(find(groups, "backups"));
    expect(calls.at(-1)).toMatchObject(["backups", { id: "riffle" }]);
    expect(find(groups, "remove-app").danger).toBe(true);
    // K-821: a preview has no rollback, but it can still go.
    const preview = actionsFor({ ...context(), previews: new Set(["riffle"]) }, handlers, {
      _tag: "card",
      id: "riffle",
    });
    expect(ids(preview)).not.toContain("rollback");
    expect(ids(preview)).toContain("remove-app");
    // K-1129: a folder site takes a new version from a folder, and no workflow run made it.
    const folder = actionsFor({ ...context(), folderSites: new Set(["riffle"]) }, handlers, {
      _tag: "card",
      id: "riffle",
    });
    expect(ids(folder)).not.toContain("rollback-run");
    run(find(folder, "upload-version"));
    expect(calls.at(-1)).toMatchObject(["uploadFolder", { card: { id: "riffle" } }]);
    run(find(groups, "rollback-run"));
    expect(calls.at(-1)).toMatchObject(["rollback", { id: "riffle" }, "run"]);
    calls.length = 0;
    // The card sits in the Owner circle only, so it can join Everyone and Her.
    expect(items(find(groups, "share")).map((item) => item.id)).toEqual([
      `share:${EVERYONE_CIRCLE_ID}`,
      "share:her",
      "share:new-circle",
    ]);
    run(find(groups, "remove-app"));
    run(items(find(groups, "share"))[1] as Action);
    expect(calls.map(([name]) => name)).toEqual(["removeApp", "reshare"]);
    expect(calls[1]).toMatchObject(["reshare", { id: "riffle" }, { id: "her" }, true, "stack"]);
  });

  it("gives a machine its level per circle and its daemon commands, and Update only with a release", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "vps" });
    expect(ids(groups)).toEqual(
      expect.arrayContaining([`level:${OWNER_CIRCLE_ID}`, "restart", "update", "remove-machine"]),
    );
    expect(ids(groups)).not.toContain("remove-app");
    expect(items(find(groups, `level:${OWNER_CIRCLE_ID}`)).map((item) => item.id)).toEqual([
      `level:${OWNER_CIRCLE_ID}:default`,
      `level:${OWNER_CIRCLE_ID}:view`,
      `level:${OWNER_CIRCLE_ID}:use`,
      `level:${OWNER_CIRCLE_ID}:control`,
    ]);
    run(find(groups, "update"));
    expect(calls[0]).toMatchObject([
      "runJob",
      { machine: { id: "vps" } },
      { kind: "update", version: "0123456789ab" },
    ]);
    expect(ids(actionsFor(context("local"), handlers, { _tag: "card", id: "vps" }))).not.toContain("update");
  });

  it("has no level list for a kind with one level, no tray for the admin, and Place for a tray card", () => {
    const { handlers } = recorder();
    const ctx = context();
    expect(
      ids(actionsFor(ctx, handlers, { _tag: "card", id: "riffle" })).some((id) => id.startsWith("level:")),
    ).toBe(false);
    expect(ids(actionsFor(ctx, handlers, { _tag: "card", id: ADMIN_RESOURCE_ID }))).not.toContain("tray");
    const loose = ids(actionsFor(ctx, handlers, { _tag: "card", id: "loose" }));
    expect(loose).toContain("place");
    expect(loose).not.toContain("tray");
    expect(loose).not.toContain("share");
  });

  it("lets a stacked card leave its stack, and not join it again", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "a" });
    expect(ids(groups)).toContain("leave-stack");
    expect(ids(groups)).not.toContain("add-to-stack");
    run(find(groups, "leave-stack"));
    expect(calls[0]).toEqual(["pullOut", "s1", "a"]);
  });

  it("selects every placed card of the same kind", () => {
    const { handlers, calls } = recorder();
    run(find(actionsFor(context(), handlers, { _tag: "card", id: "a" }), "select-kind"));
    expect(calls[0]).toEqual(["select", { cards: new Set(["a", "b"]), circle: null }]);
  });
});

describe("stack, circle and map actions", () => {
  it("lists each card of a stack under Pull out, and opens or closes it without a click (K-521)", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "stack", id: "s1" });
    expect(ids(groups)).toEqual(
      expect.arrayContaining(["details", "rename", "open-stack", "pull-out", "unstack"]),
    );
    expect(items(find(groups, "pull-out")).map((item) => item.id)).toEqual(["pull-out:a", "pull-out:b"]);
    expect(find(groups, "open-stack").label).toBe("Open as a column");
    run(find(groups, "open-stack"));
    expect(calls.at(-1)).toEqual(["toggleStack", "stack:s1"]);
    const open = { ...context(), openStacks: new Set(["stack:s1"]) };
    expect(find(actionsFor(open, handlers, { _tag: "stack", id: "s1" }), "open-stack").label).toBe(
      "Close the column",
    );
  });

  it("never offers to delete the Owner circle (K-211), and deletes another at once", () => {
    const { handlers, calls } = recorder();
    expect(ids(actionsFor(context(), handlers, { _tag: "circle", id: OWNER_CIRCLE_ID }))).not.toContain(
      "delete",
    );
    const groups = actionsFor(context(), handlers, { _tag: "circle", id: "her" });
    expect(find(groups, "delete").danger).toBe(true);
    run(find(groups, "delete"));
    expect(calls[0]).toMatchObject(["deleteCircle", { id: "her" }]);
  });

  it("adds a circle and an upload at the clicked point", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "map", at: { x: 5, y: 6 } });
    run(find(groups, "new-circle"));
    for (const upload of items(find(groups, "upload"))) run(upload);
    expect(calls).toEqual([
      ["newCircle", { x: 5, y: 6 }],
      ["upload", { x: 5, y: 6 }],
      ["uploadFolder", { at: { x: 5, y: 6 } }],
    ]);
  });

  it("offers in the toolbar + exactly the add items of an empty spot (K-526)", () => {
    const { handlers, calls } = recorder();
    const add = actionsFor(context(), handlers, { _tag: "add" });
    const spot = actionsFor(context(), handlers, { _tag: "map", at: { x: 5, y: 6 } });
    expect(ids(add)).toEqual(spot?.[0]?.map((action) => action.id));
    expect(ids(add)).toEqual([
      "new-circle",
      "upload",
      "add-site",
      "add-repo-group",
      "add-machine",
      "add-member",
    ]);
    run(find(add, "new-circle"));
    expect(calls[0]).toEqual(["newCircle", null]);
    expect(items(find(add, "add-member")).map((item) => item.id)).toContain(`add-member:${OWNER_CIRCLE_ID}`);
    const owner = items(find(add, "add-member")).find((item) => item.id === `add-member:${OWNER_CIRCLE_ID}`);
    if (!owner) throw new Error("no Owner item");
    run(owner);
    expect(calls[1]).toEqual(["addMember", OWNER_CIRCLE_ID]);
  });

  it("has no menu for an item that is gone", () => {
    expect(actionsFor(context(), recorder().handlers, { _tag: "card", id: "gone" })).toBeNull();
  });
});

describe("a stacked card leaves a circle (K-527)", () => {
  it("asks whether the card or its stack leaves, and a card that is not stacked does not ask", () => {
    const { handlers, calls } = recorder();
    const unshare = find(actionsFor(context(), handlers, { _tag: "card", id: "a" }), "unshare");
    const her = items(unshare).find((item) => item.id === "unshare:her");
    if (!her) throw new Error("no Her item");
    expect(items(her).map((item) => item.label)).toEqual(["This card", "Docs (2)"]);
    run(items(her)[0] as Action);
    expect(calls[0]).toMatchObject(["reshare", { id: "a" }, { id: "her" }, false, "card"]);
    const loose = find(actionsFor(context(), handlers, { _tag: "card", id: "riffle" }), "unshare");
    expect(items(loose).every((item) => "run" in item)).toBe(true);
  });

  it("moves only the card out of its stack, or the whole stack", () => {
    const { state } = context();
    const a = state.resources.get("a");
    const her = state.circles.get("her");
    if (!a || !her) throw new Error("fixture");
    const moved = (part: "card" | "stack") => {
      const plan = reshareEdits(state, a, her, false, part);
      if ("refused" in plan) throw new Error(plan.refused);
      const after = applyChanges(state, resolveEdits(state, plan.edits));
      return { stack: after.stacks.get("s1") ?? null, b: after.places.get("b"), a: after.places.get("a") };
    };
    // The card leaves alone: a stack left with one card goes, and the other card stays where it was.
    const card = moved("card");
    expect(card.stack).toBeNull();
    expect(card.b).toEqual({ x: -500, y: 0 });
    expect(card.a).not.toEqual({ x: -500, y: 0 });
    // Undo of "This card" puts the card back on its stack and brings the stack back.
    const plan = reshareEdits(state, a, her, false, "card");
    if ("refused" in plan) throw new Error(plan.refused);
    const changes = resolveEdits(state, plan.edits);
    const undone = applyChanges(applyChanges(state, changes), invert(changes));
    expect(undone.stacks.get("s1")?.members).toEqual(["a", "b"]);
    expect(undone.places.get("a")).toEqual({ x: -500, y: 0 });
    // The stack leaves together, as before.
    const stack = moved("stack");
    expect(stack.stack?.members).toEqual(["a", "b"]);
    expect(stack.b).toEqual(stack.a);
  });
});

describe("New circle for these (K-529)", () => {
  it("is in the menu of a selected card and once in the palette, only for two or more cards", () => {
    const { handlers, calls } = recorder();
    const ctx = { ...context(), selected: new Set(["riffle", "vps"]) };
    run(find(actionsFor(ctx, handlers, { _tag: "card", id: "riffle" }), "new-circle-for"));
    expect(calls[0]).toEqual(["newCircleFor", ["riffle", "vps"]]);
    expect(ids(actionsFor(ctx, handlers, { _tag: "card", id: "a" }))).not.toContain("new-circle-for");
    expect(
      paletteEntries(ctx, handlers).filter((entry) => entry.label.startsWith("New circle for these")),
    ).toHaveLength(1);
    const one = { ...context(), selected: new Set(["riffle"]) };
    expect(ids(actionsFor(one, handlers, { _tag: "card", id: "riffle" }))).not.toContain("new-circle-for");
    // One card makes its own new circle from "Share with".
    const share = find(actionsFor(one, handlers, { _tag: "card", id: "riffle" }), "share");
    const fresh = items(share).find((item) => item.id === "share:new-circle");
    if (!fresh) throw new Error("No New circle in Share with");
    run(fresh);
    expect(calls.at(-1)).toEqual(["newCircleFor", ["riffle"]]);
  });
});

describe("Stack these (K-521)", () => {
  it("is a shared selection action in the card menu and once in the palette, and runs stackOnto", () => {
    const { handlers, calls } = recorder();
    const ctx = { ...context(), selected: new Set(["riffle", "vps"]) };
    run(find(actionsFor(ctx, handlers, { _tag: "card", id: "vps" }), "stack-these"));
    expect(calls[0]).toEqual(["stackOnto", ["riffle", "vps"], "riffle"]);
    expect(
      paletteEntries(ctx, handlers).filter((entry) => entry.label.startsWith("Stack these")),
    ).toHaveLength(1);
  });

  it("skips a selected card that no longer exists", () => {
    const { handlers, calls } = recorder();
    const ctx = { ...context(), selected: new Set(["gone", "riffle", "vps"]) };
    run(find(actionsFor(ctx, handlers, { _tag: "card", id: "vps" }), "stack-these"));
    expect(calls[0]).toEqual(["stackOnto", ["riffle", "vps"], "riffle"]);
    const alone = { ...context(), selected: new Set(["gone", "riffle"]) };
    expect(ids(actionsFor(alone, handlers, { _tag: "card", id: "riffle" }))).not.toContain("stack-these");
  });

  it("is not offered when the selected cards already are one stack", () => {
    const { handlers } = recorder();
    const ctx = { ...context(), selected: new Set(["a", "b"]) };
    expect(ids(actionsFor(ctx, handlers, { _tag: "card", id: "a" }))).not.toContain("stack-these");
  });
});

describe("Restore previous version (K-1117)", () => {
  it("is offered only for a page or a file that has a previous version, and runs restorePrevious", () => {
    const { handlers, calls } = recorder();
    expect(ids(actionsFor(context(), handlers, { _tag: "card", id: "notes" }))).not.toContain(
      "restore-previous",
    );
    const ctx = { ...context(), previousVersions: new Set(["notes"]) };
    run(find(actionsFor(ctx, handlers, { _tag: "card", id: "notes" }), "restore-previous"));
    expect(calls[0]).toMatchObject(["restorePrevious", { id: "notes" }]);
  });
});

describe("Set address (K-1120)", () => {
  it("is offered for a page or a file, not for an app, and runs editAddress", () => {
    const { handlers, calls } = recorder();
    run(find(actionsFor(context(), handlers, { _tag: "card", id: "notes" }), "set-address"));
    expect(calls[0]).toMatchObject(["editAddress", { id: "notes" }]);
    expect(ids(actionsFor(context(), handlers, { _tag: "card", id: "riffle" }))).not.toContain("set-address");
  });
});

/** Every entry that runs, with the path through its second lists, such as "riffle · Share with…: Her". */
const runnable = (entries: ReadonlyArray<PaletteEntry>): Array<string> =>
  entries.flatMap((entry) =>
    "items" in entry ? runnable(entry.items).map((label) => `${entry.label}: ${label}`) : [entry.label],
  );

describe("the palette", () => {
  it("has every action of every menu, so no action exists only in a menu", () => {
    const { handlers } = recorder();
    const ctx = context();
    const palette = runnable(paletteEntries(ctx, handlers));
    for (const id of ctx.state.resources.keys()) {
      const groups = actionsFor(ctx, handlers, { _tag: "card", id });
      // flatten leaves out refused actions, in the menu and in the palette alike.
      for (const label of runnable(flatten(groups ?? [], "")))
        expect(palette.some((each) => each.endsWith(label))).toBe(true);
    }
    // K-511, U11: the words of "Share <card> with <circle>" find one entry per card, whose second list has Her.
    const found = paletteEntries(ctx, handlers).filter((entry) =>
      ["share", "riffle", "her"].every((word) =>
        `${entry.label} ${entry.keywords ?? ""}`.toLowerCase().includes(word),
      ),
    );
    expect(found.map((entry) => entry.label)).toEqual(["📦 riffle · Share with…"]);
    expect(runnable(found)).toContain("📦 riffle · Share with…: Her");
  });
});

describe("refused actions", () => {
  it("shows an action that the rules refuse as refused, and leaves it out of the palette", () => {
    const { handlers, calls } = recorder();
    const ctx = context();
    // K-105: the admin card stays in the Owner circle, so the menu says why before anything is sent.
    const unshare = items(
      find(actionsFor(ctx, handlers, { _tag: "card", id: ADMIN_RESOURCE_ID }), "unshare"),
    );
    expect(unshare.find((item) => item.id === `unshare:${OWNER_CIRCLE_ID}`)?.refused).toMatch(/admin/);
    expect(runnable(paletteEntries(ctx, handlers))).not.toContain("🔐 kitshn admin · Unshare from…: Owner");
    // A card in Everyone only cannot also be in Her: the two circles do not overlap.
    const loose = {
      ...ctx,
      state: { ...ctx.state, places: new Map([...ctx.state.places, ["loose", { x: 700, y: 0 }]]) },
    };
    const share = items(find(actionsFor(loose, handlers, { _tag: "card", id: "loose" }), "share"));
    expect(share.find((item) => item.id === "share:her")?.refused).toMatch(/No spot/);
    expect(calls).toEqual([]);
  });

  it("shows Add to stack refused when the stack's circles break a rule (K-105)", () => {
    const ctx = context();
    // The stack lies outside every circle, so the admin card that joins it would leave the Owner circle.
    const state: State = {
      ...ctx.state,
      places: new Map([...ctx.state.places, ["a", { x: 5000, y: 0 }], ["b", { x: 5000, y: 0 }]]),
    };
    const groups = actionsFor({ ...ctx, state }, recorder().handlers, {
      _tag: "card",
      id: ADMIN_RESOURCE_ID,
    });
    expect(
      items(find(groups, "add-to-stack")).find((item) => item.id === "add-to-stack:s1")?.refused,
    ).toMatch(/admin/);
  });

  it("marks the current level as the checked radio item", () => {
    const groups = actionsFor(context(), recorder().handlers, { _tag: "card", id: "vps" });
    const levels = items(find(groups, `level:${OWNER_CIRCLE_ID}`));
    expect(levels.filter((item) => item.checked).map((item) => item.id)).toEqual([
      `level:${OWNER_CIRCLE_ID}:default`,
    ]);
  });
});

describe("Enter in the palette", () => {
  const safe = {};
  const danger = { danger: true as const };
  it("never runs a dangerous top match from Enter alone while other entries match", () => {
    expect(paletteEnter([danger, safe], 0, false)).toBeNull();
    expect(paletteEnter([danger, safe], 0, true)).toBe(0);
    expect(paletteEnter([danger], 0, false)).toBe(0);
    expect(paletteEnter([safe, danger], 0, false)).toBe(0);
    expect(paletteEnter([], 0, false)).toBeNull();
  });

  it("keeps the active entry by label, so a reorder never changes what Enter runs", () => {
    const moved = paletteArrow("ArrowDown", ["a", "Remove b"], { label: null, picked: false });
    expect(moved).toEqual({ label: "Remove b", picked: true });
    // A broadcast puts another entry first: the cursor stays on "Remove b".
    expect(paletteActive(["c", "a", "Remove b"], moved)).toEqual({ index: 2, picked: true });
    // The entry is gone: the first match is active and not picked.
    expect(paletteActive(["c", "a"], moved)).toEqual({ index: 0, picked: false });
  });

  it("does not pick on an arrow that does not move, nor on a hover", () => {
    const top = { label: "Remove a", picked: false };
    expect(paletteArrow("ArrowUp", ["Remove a", "b"], top)).toBe(top);
    expect(paletteArrow("ArrowDown", ["Remove a"], top)).toBe(top);
    // A hover sets the label with picked false, so Enter alone still refuses a dangerous entry.
    const hovered = paletteActive(["b", "Remove a"], { label: "Remove a", picked: false });
    expect(paletteEnter([{}, { danger: true }], hovered.index, hovered.picked)).toBeNull();
  });

  it("finds an action by the words of its older label", () => {
    const entries = paletteEntries(context(), recorder().handlers);
    expect(entries.find((entry) => entry.label === "Add a machine")?.keywords).toContain("join");
    expect(entries.find((entry) => entry.label === "Add a site")?.keywords).toContain("static");
  });
});

describe("levelEdit (K-205)", () => {
  it("clears the setting for the default, and keeps an end date", () => {
    const ctx = context();
    const vps = ctx.state.resources.get("vps") as Resource;
    const owner = ctx.state.circles.get(OWNER_CIRCLE_ID) as Circle;
    expect(levelEdit(ctx.state, vps, owner, null).after).toBeNull();
    const ending: State = {
      ...ctx.state,
      shareSettings: new Map([[shareKey("vps", OWNER_CIRCLE_ID), { level: "use", endsAt: 9 }]]),
    };
    expect(levelEdit(ending, vps, owner, null).after).toEqual({ level: null, endsAt: 9 });
    expect(levelEdit(ending, vps, owner, "view").after).toEqual({ level: "view", endsAt: 9 });
  });
});

describe("per-item undo (K-1507)", () => {
  const withCheck = (check: UndoCheck | null) => ({ ...context(), undoCheck: check });
  const undoOf = (check: UndoCheck | null, target: MenuTarget) => {
    const { handlers, calls } = recorder();
    const action = (actionsFor(withCheck(check), handlers, target) ?? [])
      .flat()
      .find((entry) => entry.id === "undo-item");
    return { action, calls };
  };

  it("shows the entry only for the item that the server was asked about", () => {
    expect(undoOf(null, { _tag: "card", id: "riffle" }).action).toBeUndefined();
    const check = { key: "card:vps", answer: null, slow: false };
    expect(undoOf(check, { _tag: "card", id: "riffle" }).action).toBeUndefined();
  });

  it("checks, then runs when allowed, or shows the reason when refused", () => {
    const card = { _tag: "card", id: "riffle" } as const;
    const quick = undoOf({ key: "card:riffle", answer: null, slow: false }, card).action;
    expect(quick).toMatchObject({ label: "Undo last change to this card", refused: CHECKING_TIP });
    const slow = slowUndoCheck({ key: "card:riffle", answer: null, slow: false }, "card:riffle");
    expect(undoOf(slow, card).action).toMatchObject({ label: "Undo last change to this card (checking…)" });
    const allowed = undoOf(settleUndoCheck(slow, "card:riffle", { allowed: true }), card);
    expect(allowed.action?.refused).toBeUndefined();
    run(allowed.action!);
    expect(allowed.calls).toEqual([["undoItem", { kind: "card", id: "riffle" }]]);
    const refused = settleUndoCheck(slow, "card:riffle", { allowed: false, reason: "#9 changed it later." });
    expect(undoOf(refused, card).action?.refused).toBe("#9 changed it later.");
  });

  it("drops an answer for another item, and keeps a settled answer out of the checking state", () => {
    const check = { key: "circle:her", answer: null, slow: false };
    expect(settleUndoCheck(check, "card:riffle", { allowed: true })).toBe(check);
    expect(settleUndoCheck(null, "card:riffle", { allowed: true })).toBeNull();
    const settled = settleUndoCheck(check, "circle:her", { allowed: true });
    expect(slowUndoCheck(settled, "circle:her")).toBe(settled);
  });
});

describe("port cards (K-534)", () => {
  it("offer Remove ports as a dangerous action, the way out of the Ports step", () => {
    const { handlers, calls } = recorder();
    const base = context();
    const portCard = card("mc", "port", ["mc.example.com"]);
    const ctx = {
      ...base,
      state: { ...base.state, resources: new Map(base.state.resources).set("mc", portCard) },
    };
    const groups = actionsFor(ctx, handlers, { _tag: "card", id: "mc" });
    const remove = find(groups, "remove-port card");
    expect(remove.danger).toBe(true);
    run(remove);
    expect(calls).toEqual([["removePortCard", portCard]]);
    expect(ids(actionsFor(base, handlers, { _tag: "card", id: "riffle" }))).not.toContain("remove-port card");
  });
});
