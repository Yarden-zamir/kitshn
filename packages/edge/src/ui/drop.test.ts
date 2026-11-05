import { describe, expect, it } from "vitest";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import {
  type Circle,
  EVERYONE_CIRCLE_ID,
  OWNER_CIRCLE_ID,
  type Resource,
  type State,
  circlesHolding,
} from "../core/model.ts";
import type { Machine } from "../core/machine.ts";
import { seed } from "../core/seed.ts";
import { actorOf, chip, login, machineKey, token } from "../core/testkit.ts";
import { refusal } from "./actions.ts";
import { dropHover, dropPlan } from "./drop.ts";

/** K-509, K-522: a card from the tray drops as a card from the map does. */

const card = (id: string, kind: Resource["kind"]): Resource => ({
  id,
  kind,
  name: id,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

const joined = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `t-${id}`,
  clientId: `c-${id}`,
  tunnelId: `u-${id}`,
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

function state(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  const resources = [
    ...s.resources,
    card("riffle", "site.static"),
    card("map", "file"),
    card("tray", "file"),
  ];
  return {
    circles: new Map([...s.circles, her].map((circle) => [circle.id, circle])),
    resources: new Map(resources.map((resource) => [resource.id, resource])),
    // "map" lies outside every circle; "tray" has no place.
    places: new Map([...s.places, ["riffle", { x: -400, y: 50 }], ["map", { x: 2000, y: 2000 }]]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
    actors: new Map(
      [
        ...s.actors,
        actorOf(login("her@example.com")),
        actorOf(machineKey("mac"), "mac"),
        actorOf(machineKey("win"), "win"),
        actorOf(token("d", "c", "d")),
      ].map((actor) => [actor.id, actor]),
    ),
  };
}

/** The state after a plan, so map and tray drops compare by their outcome, not by their edits. */
const after = (base: State, plan: ReturnType<typeof dropPlan>) => {
  if (!plan || "refused" in plan) throw new Error(`no edits: ${JSON.stringify(plan)}`);
  return applyChanges(base, resolveEdits(base, plan.edits));
};

describe("dropPlan", () => {
  const point = { x: -420, y: -30 };

  it.each(["map", "tray"])("stacks a %s card onto the card under the pointer", (id) => {
    const base = state();
    const next = after(base, dropPlan(base, new Map([[id, point]]), { _tag: "card", id: "riffle" }, "s-new"));
    expect(next.stacks.get("s-new")?.members).toEqual(["riffle", id]);
    expect(next.places.get(id)).toEqual(base.places.get("riffle"));
    expect(circlesHolding(next, id).map((circle) => circle.id)).toEqual(["her"]);
  });

  it.each(["map", "tray"])("puts a %s card at its point, in exactly the circles there", (id) => {
    const base = state();
    const next = after(base, dropPlan(base, new Map([[id, point]]), { _tag: "map" }, "s-new"));
    expect(next.places.get(id)).toEqual(point);
    expect(circlesHolding(next, id).map((circle) => circle.id)).toEqual(["her"]);
  });

  it("keeps four tray cards dropped on a circle inside it, however far they fan out", () => {
    const base = state();
    const cards = ["t1", "t2", "t3", "t4"];
    const withTray: State = {
      ...base,
      resources: new Map([
        ...base.resources,
        ...cards.map((id): [string, Resource] => [id, card(id, "file")]),
      ]),
    };
    const moves = new Map(
      cards.map((id, index) => [id, { x: her.x + (index % 2) * 30, y: her.y + index * 90 }]),
    );
    const next = after(withTray, dropPlan(withTray, moves, { _tag: "map" }, "s-new"));
    for (const id of cards) expect(circlesHolding(next, id).map((circle) => circle.id)).toEqual(["her"]);
  });

  it("takes a map card out of every circle over the tray, and leaves a tray card as it is", () => {
    const base = state();
    const back = dropPlan(base, new Map([["riffle", point]]), { _tag: "tray" }, "s-new");
    expect(after(base, back).places.has("riffle")).toBe(false);
    expect(dropPlan(base, new Map([["tray", point]]), { _tag: "tray" }, "s-new")).toBeNull();
  });

  it.each(["map", "tray"])("changes nothing for a %s card let go over the panel or the toolbar", (id) => {
    expect(dropPlan(state(), new Map([[id, point]]), { _tag: "away" }, "s-new")).toBeNull();
  });

  describe("the title of a circle (K-539)", () => {
    const machines: Circle = {
      ...her,
      id: "machines",
      name: "Machines",
      members: [chip(machineKey("mac"))],
    };
    const start = { x: 2000, y: 2000 };
    const withMachine = (from: typeof start | null): State => {
      const base = state();
      return {
        ...base,
        circles: new Map([...base.circles, ["machines", machines]]),
        resources: new Map([...base.resources, ["win", card("win", "machine")]]),
        places: from ? new Map([...base.places, ["win", from]]) : base.places,
        machines: new Map([
          ["win", joined("win")],
          ["mac", joined("mac")],
        ]),
      };
    };
    const title = { _tag: "title", id: "machines" } as const;
    const hoverText = (base: State, id: string, target: Parameters<typeof dropHover>[2]) =>
      dropHover(base, new Map([[id, point]]), target).lines.map((line) => line.text);

    it.each([
      ["map", start],
      ["tray", null],
    ] as const)("adds a %s machine as a member with no right, and leaves its place alone", (_, from) => {
      const base = withMachine(from);
      const plan = dropPlan(base, new Map([["win", point]]), title, "s-new");
      const next = after(base, plan);
      expect(next.circles.get("machines")?.members).toContainEqual(chip(machineKey("win")));
      expect(next.places.get("win")).toEqual(base.places.get("win"));
      expect(plan && "rightsIn" in plan ? plan.rightsIn : null).toBe("machines");
      expect(hoverText(base, "win", title)).toEqual(["+ win joins Machines"]);
    });

    it("changes nothing for a member, and says so", () => {
      const base = withMachine(start);
      const member = {
        ...base,
        circles: new Map([
          ...base.circles,
          ["machines", { ...machines, members: [chip(machineKey("win"))] }],
        ]),
      };
      expect(dropPlan(member, new Map([["win", point]]), title, "s-new")).toBeNull();
      expect(hoverText(member, "win", title)[0]).toMatch(/already/);
    });

    it("shares a card that is no machine, as the body of the circle does", () => {
      const base = withMachine(start);
      expect(hoverText(base, "map", title).some((line) => line.startsWith("+ Machines can"))).toBe(true);
      const next = after(base, dropPlan(base, new Map([["map", point]]), title, "s-new"));
      expect(next.places.get("map")).toEqual(point);
      expect(next.circles.get("machines")?.members).toEqual(machines.members);
    });

    it("refuses a public circle, and asks first for a circle that holds kitshn itself", () => {
      const base = withMachine(start);
      const everyone = dropPlan(
        base,
        new Map([["win", point]]),
        { _tag: "title", id: EVERYONE_CIRCLE_ID },
        "s-new",
      );
      expect(everyone && "refused" in everyone ? everyone.refused : "").toMatch(/public/);
      const owner = dropPlan(
        base,
        new Map([["win", point]]),
        { _tag: "title", id: OWNER_CIRCLE_ID },
        "s-new",
      );
      expect(owner && "ask" in owner ? owner.ask : "").toMatch(/kitshn itself/);
    });

    it("refuses a machine that would lock a person out of an all-must-match circle, with no hover that says it joins", () => {
      const base = withMachine(start);
      const both: Circle = { ...her, id: "both", name: "Both", match: "all" };
      const all: State = { ...base, circles: new Map([...base.circles, ["both", both]]) };
      const target = { _tag: "title", id: "both" } as const;
      const plan = dropPlan(all, new Map([["win", point]]), target, "s-new");
      expect(plan && "refused" in plan ? plan.refused : "").toMatch(/no one/);
      expect(hoverText(all, "win", target)[0]).toMatch(/no one/);
    });

    it("shows the refusal of the drop in the hover, for a public circle and during a pause", () => {
      const base = withMachine(start);
      const everyone = { _tag: "title", id: EVERYONE_CIRCLE_ID } as const;
      expect(hoverText(base, "win", everyone)[0]).toMatch(/public/);
      expect(dropHover(base, new Map([["win", point]]), everyone).joins).toBe(false);
      const paused: State = { ...base, paused: "keep-public" };
      const plan = dropPlan(paused, new Map([["win", point]]), { _tag: "map" }, "s-new");
      expect(hoverText(paused, "win", { _tag: "map" })[0]).toBe(
        plan && "refused" in plan ? plan.refused : "?",
      );
    });

    it("never says a circle gives what Access does not give, and uses the kind's word for a level", () => {
      const base = withMachine(start);
      const ended: Circle = { ...her, id: "ended", name: "Ended", x: 3000, y: 0, endsAt: 1 };
      const nobody: Circle = { ...her, id: "nobody", name: "Nobody", x: 3000, y: 900, members: [] };
      const circles = new Map([...base.circles, ["ended", ended], ["nobody", nobody]]);
      const thread: Resource = {
        ...card("thread", "t3.thread" as Resource["kind"]),
        provider: { levels: { view: "read", use: "send", control: "admin" } } as NonNullable<
          Resource["provider"]
        >,
      };
      const with3: State = {
        ...base,
        circles,
        resources: new Map([...base.resources, ["thread", thread]]),
      };
      const text = (at: { x: number; y: number }) =>
        dropHover(with3, new Map([["thread", at]]), { _tag: "map" }).lines.map((line) => line.text);
      expect(text({ x: 3000, y: 0 })[0]).toMatch(/has ended/);
      expect(text({ x: 3000, y: 900 })[0]).toMatch(/lets no one in/);
      expect(text({ x: her.x, y: her.y })[0]).toBe("+ Her can send thread");
    });

    it("leaves a stack with a machine at home, and keeps the join in the toast of a mixed drag", () => {
      const base = withMachine(start);
      const stacked: State = {
        ...base,
        places: new Map([...base.places, ["map", start]]),
        stacks: new Map([["s1", { id: "s1", name: "", members: ["win", "map"] }]]),
      };
      const moves = new Map([
        ["win", point],
        ["map", point],
      ]);
      const next = after(stacked, dropPlan(stacked, moves, title, "s-new"));
      expect(next.places.get("win")).toEqual(start);
      expect(next.places.get("map")).toEqual(start);
      const mixed = dropPlan(
        base,
        new Map([
          ["win", point],
          ["tray", point],
        ]),
        title,
        "s-new",
      );
      expect(mixed && "note" in mixed ? mixed.note : "").toMatch(/win joined Machines/);
      expect(after(base, mixed).places.get("tray")).toEqual(point);
    });

    it("says what the join opens only when it does", () => {
      const base = withMachine(start);
      const ended = { ...machines, id: "gone", name: "Gone", endsAt: 1 };
      const with3: State = { ...base, circles: new Map([...base.circles, ["gone", ended]]) };
      const plan = dropPlan(with3, new Map([["win", point]]), { _tag: "title", id: "gone" }, "s-new");
      expect(plan && "done" in plan ? plan.done : "").toMatch(/has ended/);
      expect(plan && "done" in plan ? plan.done : "").not.toMatch(/opens what/);
    });

    it("says that a machine in the body of a circle is shared, not a member", () => {
      const base = withMachine(start);
      const plan = dropPlan(base, new Map([["win", point]]), { _tag: "map" }, "s-new");
      expect(after(base, plan).circles.get("her")?.members).toEqual(her.members);
      expect(plan && "note" in plan ? plan.note : "").toMatch(/not a member/);
    });
  });

  describe("a change that would admit no one who gets in now (K-539)", () => {
    const email = chip(login("her@example.com"));
    const network = { _tag: "ip", range: "10.0.0.0/8" } as const;
    const win = chip(machineKey("win"));
    const mac = chip(machineKey("mac"));
    const device = chip(token("d", "c", "d"));
    const base = (circle: Circle): State => {
      const s = state();
      return {
        ...s,
        circles: new Map([...s.circles, [circle.id, circle]]),
        machines: new Map([
          ["win", joined("win")],
          ["mac", joined("mac")],
        ]),
      };
    };
    const change = (before: Partial<Circle>, after: Partial<Circle>) => {
      const old = { ...her, ...before };
      return refusal(base(old), [{ _tag: "circle", id: her.id, after: { ...old, ...after } }]);
    };

    it.each([
      ["a machine joins with a person", { match: "all" }, { match: "all", members: [email, win] }, /person/],
      [
        "a person joins with a machine",
        { match: "all", members: [win] },
        { match: "all", members: [win, email] },
        /person/,
      ],
      ["a switch with a person and a machine", { members: [email, win] }, { match: "all" }, /person/],
      ["a second machine", { match: "all", members: [win] }, { match: "all", members: [win, mac] }, /two/],
      [
        "a machine joins with a device",
        { match: "all", members: [device] },
        { match: "all", members: [device, win] },
        /two/,
      ],
      [
        "a machine joins a network",
        { match: "all", members: [network] },
        { match: "all", members: [network, win] },
        /visitors/,
      ],
    ] as const)("refuses %s, and says who it blames", (_, before, after, reason) => {
      expect(change(before, after)).toMatch(reason);
    });

    it.each([
      [
        "a machine joins an empty all-must-match circle",
        { match: "all", members: [] },
        { match: "all", members: [win] },
      ],
      ["a machine joins with a person when any may match", { members: [email] }, { members: [email, win] }],
      [
        "a person joins a network: they were on it",
        { match: "all", members: [network] },
        { match: "all", members: [network, email] },
      ],
      ["a switch with a person and a network", { members: [email, network] }, { match: "all" }],
      ["the last member leaves", { members: [email] }, { members: [] }],
      ["a machine leaves", { match: "all", members: [email, win] }, { match: "all", members: [email] }],
      ["a rename of a circle that lets no one in", { match: "all", members: [email, win] }, { name: "New" }],
    ] as const)("allows %s", (_, before, after) => {
      expect(change(before, after)).toBeNull();
    });
  });
});
