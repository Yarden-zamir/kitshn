import { describe, expect, it } from "vitest";

const as = (clientId: string) => ({ email: null, clientId, ip: null });
import {
  agentDeployPlan,
  agentHas,
  agentHomeCircle,
  agentMayCommand,
  agentMayRunOn,
  agentRefusal,
  agentUploadPlace,
  cardsControlledBy,
  circlesOf,
  codeRightMode,
  machineRightMode,
  mayDeployOn,
} from "./agent.ts";
import { type Edit, applyChanges, resolveEdits } from "./changes.ts";
import {
  type Circle,
  type Point,
  type Resource,
  type RightCondition,
  type RightMode,
  type Effect,
  type State,
  actorIdOf,
  circlesHolding,
} from "./model.ts";
import { placeInside } from "./place.ts";
import { seed } from "./seed.ts";
import { actorOf, chip, keyRights, login, machineKey, token, withActors } from "./testkit.ts";

type KeyFlags = { readonly creates?: true; readonly shares?: true };
const KEY = token("t1", "agent-1", "Agent");
const keyChip = (flags: KeyFlags = {}) => chip(KEY, keyRights(flags));
const HER = login("her@example.com");

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  const base = s.circles[0]!;
  const circle = (
    id: string,
    x: number,
    level: "view" | "control",
    members: Circle["members"] = [keyChip()],
  ): Circle => ({
    ...base,
    id,
    name: id,
    level,
    needsPasskey: false,
    members,
    x,
    y: 1000,
    r: 200,
  });
  const site: Resource = {
    id: "site",
    kind: "site.compose",
    name: "site",
    addresses: [],
    status: "running",
    group: null,
    machine: null,
  };
  return {
    circles: new Map(
      [
        ...s.circles,
        circle("agents", 0, "control"),
        circle("staging", 600, "control"),
        circle("watch", 1200, "view"),
        circle("public", 1800, "control", [{ _tag: "everyone" }, keyChip()]),
        circle("home", 2400, "control", [{ _tag: "ip", range: "10.0.0.0/24" }]),
      ].map((c) => [c.id, c]),
    ),
    resources: new Map([...s.resources, site, { ...site, id: "nas", name: "nas" }].map((r) => [r.id, r])),
    places: new Map([...s.places, ["site", { x: 0, y: 1000 }], ["nas", { x: 2400, y: 1000 }]]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
    actors: new Map(
      [
        ...s.actors,
        actorOf(KEY),
        actorOf(HER),
        actorOf(machineKey("vps"), "vps"),
        actorOf(machineKey("m1"), "m1"),
      ].map((actor) => [actor.id, actor]),
    ),
  };
}

const check = (state: State, edits: Array<Edit>) => {
  const changes = resolveEdits(state, edits);
  return agentRefusal(
    state,
    applyChanges(state, changes),
    as("agent-1"),
    changes,
    0,
    new Set(["site"]),
    null,
  );
};

describe("agent keys (K-718)", () => {
  it("moves a card it controls between its own circles", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 600, y: 1000 } }])).toBeNull();
  });
  it("never moves a card into a circle it is not in, nor the admin, nor edits a circle", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 0, y: 40 } }])).toMatch(/Owner/);
    expect(check(start(), [{ _tag: "place", id: "kitshn-admin", after: { x: 0, y: 1000 } }])).toMatch(
      /no control/,
    );
    const owner = start().circles.get("owner")!;
    expect(check(start(), [{ _tag: "circle", id: "owner", after: { ...owner, name: "x" } }])).toMatch(
      /only move/,
    );
  });
  it("never makes a card public, nor moves it into a circle without control", () => {
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 1800, y: 1000 } }])).toMatch(/public/);
    expect(check(start(), [{ _tag: "place", id: "site", after: { x: 1200, y: 1000 } }])).toMatch(/watch/);
    expect(
      check(start(), [
        {
          _tag: "shareSetting",
          resourceId: "site",
          circleId: "agents",
          after: { level: "view", endsAt: null },
        },
      ]),
    ).toMatch(/only move/);
  });
  it("gets nothing from network or Everyone circles, and a token that no circle names manages nothing", () => {
    expect(cardsControlledBy(start(), as("agent-1"), 0).has("nas")).toBe(false);
    expect(cardsControlledBy(start(), as("stranger"), 0).size).toBe(0);
    expect(check(start(), [{ _tag: "place", id: "nas", after: { x: 0, y: 1000 } }])).toMatch(/no control/);
  });
  it("counts only agent circles that have not ended, and may take a card out of every circle", () => {
    const base = start();
    const agents = base.circles.get("agents")!;
    const mixed = { ...agents, members: [...agents.members, chip(HER)] };
    expect(
      cardsControlledBy({ ...base, circles: new Map(base.circles).set("agents", mixed) }, as("agent-1"), 0)
        .size,
    ).toBe(0);
    const ended = { ...agents, endsAt: 1 };
    expect(
      cardsControlledBy({ ...base, circles: new Map(base.circles).set("agents", ended) }, as("agent-1"), 5)
        .size,
    ).toBe(0);
    expect(check(base, [{ _tag: "place", id: "site", after: null }])).toBeNull();
  });
  it("runs jobs on a machine only when it manages every card on it", () => {
    const base = start();
    const machine = { ...base.resources.get("site")!, id: "m1", name: "m1", kind: "machine" as const };
    const app = { ...base.resources.get("site")!, id: "app", machine: "m1" };
    const resources = new Map(base.resources).set("m1", machine).set("app", app);
    const places = new Map(base.places).set("m1", { x: 0, y: 1000 }).set("app", { x: -5000, y: 0 });
    const m1 = {
      id: "m1",
      name: "m1",
      labels: [],
      order: 0,
      serviceTokenId: "s",
      clientId: "m1-token",
      tunnelId: "t",
    };
    const state: State = { ...base, resources, places, machines: new Map([["m1", m1]]) };
    expect(agentMayRunOn(state, as("agent-1"), "m1", 0)).toBe(false);
    const inside = { ...state, places: new Map(places).set("app", { x: 0, y: 1000 }) };
    expect(agentMayRunOn(inside, as("agent-1"), "m1", 0)).toBe(true);
    // The machine's own token opens the NAS through the "home" circle, which the agent does not manage.
    const home = inside.circles.get("home")!;
    const circles = new Map(inside.circles).set("home", {
      ...home,
      members: [chip(machineKey("m1"))],
    });
    expect(agentMayRunOn({ ...inside, circles }, as("agent-1"), "m1", 0)).toBe(false);
    // A token actor has no closed commands: it stays under the full limit.
    expect(agentMayCommand({ ...inside, circles }, as("agent-1"), "m1", "restart", 0)).toBe(false);
  });
  it("refuses a move that takes along a stacked card the key does not manage", () => {
    const base = start();
    const other = { ...base.resources.get("site")!, id: "other", name: "other" };
    const state: State = {
      ...base,
      resources: new Map(base.resources).set("other", other),
      places: new Map(base.places).set("other", { x: 0, y: 1000 }),
      shareSettings: new Map([["other/agents", { level: "view", endsAt: null }]]),
      ends: new Map(),
      stacks: new Map([["s1", { id: "s1", name: "pair", members: ["site", "other"] }]]),
    };
    expect(check(state, [{ _tag: "place", id: "site", after: { x: 600, y: 1000 } }])).toMatch(/other/);
  });
  it("deploys only the repo's code: the last good build, or the repo's workflow on its branch", () => {
    const last = {
      app: "compose" as const,
      repo: "o/app",
      branch: "main",
      resourceId: "app-o-1-prod",
      environment: "prod",
      name: "app",
      composeFile: null,
    };
    const ready = { canRedeploy: true, takesDeploys: true, runsCard: true, allowed: [] };
    expect(agentDeployPlan(last, "redeploy", ready)).toMatchObject({
      kind: "redeploy",
      command: { kind: "compose-redeploy", project: "app-o-1-prod", name: "app" },
    });
    expect(agentDeployPlan(last, "build", null)).toEqual({ kind: "build", repo: "o/app", branch: "main" });
    expect(agentDeployPlan(last, "redeploy", { ...ready, canRedeploy: false })).toMatchObject({
      error: /Update the daemon/,
    });
    expect(agentDeployPlan(last, "redeploy", { ...ready, takesDeploys: false })).toMatchObject({
      error: /label deploy/,
    });
    expect(agentDeployPlan(last, "redeploy", { ...ready, runsCard: false })).toMatchObject({
      error: /no longer runs/,
    });
    expect(agentDeployPlan(last, "redeploy", null)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, app: "static" }, "redeploy", ready)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, branch: "" }, "build", null)).toMatchObject({ kind: "refused" });
    expect(agentDeployPlan({ ...last, environment: "pr-7" }, "build", null)).toMatchObject({
      error: /preview/,
    });
    expect(agentDeployPlan(null, "build", null)).toMatchObject({
      kind: "refused",
      error: /no finished deploy/,
    });
  });
});

/** The start state with these key flags on the chip of the key in one circle. */
function withRights(circleId: string, rights: KeyFlags): State {
  const base = start();
  const circle = base.circles.get(circleId)!;
  const members = circle.members.map((member) =>
    member._tag === "actor" && member.actorId === actorIdOf(KEY) ? keyChip(rights) : member,
  );
  return { ...base, circles: new Map(base.circles).set(circleId, { ...circle, members }) };
}

/** The spot in the overlap of the agent circle and Everyone, where a public move through `/agent/apply` goes. */
const overlapSpot = (state: State) =>
  placeInside(state, state.circles.get("agents")!, new Set(["agents", "everyone"])) as Point;

describe("agent keys that add and publish apps (K-718, K-819)", () => {
  it("has no effect outside its circles, and an effect counts in every circle that holds it (K-1730)", () => {
    expect(agentHas(start(), as("agent-1"), "creates", 0, null)).toBe(false);
    expect(agentHas(start(), as("agent-1"), "shares", 0, null)).toBe(false);
    expect(agentHas(withRights("agents", { creates: true }), as("agent-1"), "creates", 0, null)).toBe(true);
    // "public" holds Everyone, so it is no agent circle, but a set effect counts there too.
    expect(agentHas(withRights("public", { shares: true }), as("agent-1"), "shares", 0, null)).toBe(true);
  });
  it("publishes a card that it added into the overlap of its agent circle and Everyone, and keeps managing it", () => {
    const state = overlapping({ shares: true });
    const place = overlapSpot(state);
    const after = moved(state, place);
    expect(
      circlesHolding(after, "site")
        .map((circle) => circle.id)
        .sort(),
    ).toEqual(["agents", "everyone"]);
    expect(check(state, [{ _tag: "place", id: "site", after: place }])).toBeNull();
    // It still manages the card, so redeploy, unpublish and the machine rule keep working.
    expect(cardsControlledBy(after, as("agent-1"), 0).has("site")).toBe(true);
  });
  it("refuses a publish without the right, of a card that it did not add, or of a live site", () => {
    const place = overlapSpot(overlapping({ shares: true }));
    const into = (state: State, added: ReadonlySet<string>) => {
      const changes = resolveEdits(state, [{ _tag: "place", id: "site", after: place }]);
      return agentRefusal(state, applyChanges(state, changes), as("agent-1"), changes, 0, added, null);
    };
    expect(into(overlapping({}), new Set(["site"]))).toMatch(/Everyone/);
    expect(into(overlapping({ shares: true }), new Set())).toMatch(/Everyone/);
    const live = overlapping({ shares: true });
    const site = { ...live.resources.get("site")!, kind: "site.live" as const };
    expect(
      into({ ...live, resources: new Map(live.resources).set("site", site) }, new Set(["site"])),
    ).toMatch(/Everyone/);
  });
  it("refuses a publish that leaves every agent circle, and names the missing overlap", () => {
    const apart = withRights("agents", { shares: true });
    expect(check(apart, [{ _tag: "place", id: "site", after: { x: 760, y: 0 } }])).toMatch(
      /overlaps Everyone/,
    );
    expect(
      check(overlapping({ shares: true }), [{ _tag: "place", id: "site", after: { x: 760, y: -100 } }]),
    ).toMatch(/overlap of an agent circle/);
  });
  it("takes a published card back into the agent circle alone, also without the right", () => {
    const place = overlapSpot(overlapping({ shares: true }));
    const after = moved(overlapping({}), place);
    const back = placeInside(after, place, new Set(["agents"])) as Point;
    expect(circlesHolding(moved(after, back), "site").map((circle) => circle.id)).toEqual(["agents"]);
    expect(check(after, [{ _tag: "place", id: "site", after: back }])).toBeNull();
  });
  it("places an upload in the tray, in one of its agent circles, or with the right in the overlap with Everyone (K-1116)", () => {
    const plain = overlapping({});
    expect(agentUploadPlace(plain, as("agent-1"), null, false, 0, null)).toBeNull();
    const inAgents = agentUploadPlace(plain, as("agent-1"), "agents", false, 0, null) as Point;
    expect(circlesHolding(moved(plain, inAgents), "site").map((circle) => circle.id)).toEqual(["agents"]);
    // By name too, and never a circle that is not an agent circle of the key with control.
    expect(agentUploadPlace(plain, as("agent-1"), "watch", false, 0, null)).toMatch(/not an agent circle/);
    expect(agentUploadPlace(plain, as("agent-1"), "everyone", false, 0, null)).toMatch(/not an agent circle/);
    expect(agentUploadPlace(plain, as("stranger"), null, true, 0, null)).toMatch(/no agent circle/);
    expect(agentUploadPlace(plain, as("agent-1"), null, true, 0, null)).toMatch(/may not publish/);
    const right = overlapping({ shares: true });
    const open = agentUploadPlace(right, as("agent-1"), null, true, 0, null) as Point;
    expect(
      circlesHolding(moved(right, open), "site")
        .map((circle) => circle.id)
        .sort(),
    ).toEqual(["agents", "everyone"]);
    expect(
      agentUploadPlace(withRights("agents", { shares: true }), as("agent-1"), null, true, 0, null),
    ).toMatch(/overlaps Everyone/);
  });
  it("lets a page or a file that the key published become public, as an app of a repo that it allowed", () => {
    const state = overlapping({ shares: true });
    const page = { ...state.resources.get("site")!, kind: "page" as const };
    const withPage = { ...state, resources: new Map(state.resources).set("site", page) };
    expect(check(withPage, [{ _tag: "place", id: "site", after: overlapSpot(withPage) }])).toBeNull();
  });
  it("takes a card out of Everyone through apply and keeps its other agent circles", () => {
    // Agents and staging both overlap Everyone; the card sits in all three and keeps its two agent circles.
    const base = overlapping({ shares: true });
    const staging = { ...base.circles.get("staging")!, x: 760, y: 360 };
    const state = { ...base, circles: new Map(base.circles).set("staging", staging) };
    const published = moved(state, { x: 760, y: 230 });
    const back = placeInside(published, { x: 760, y: 230 }, new Set(["agents", "staging"])) as Point;
    expect(check(published, [{ _tag: "place", id: "site", after: back }])).toBeNull();
    expect(
      circlesHolding(moved(published, back), "site")
        .map((circle) => circle.id)
        .sort(),
    ).toEqual(["agents", "staging"]);
  });
  it("treats a repurposed Everyone circle as any other circle", () => {
    const state = overlapping({ shares: true });
    const place = overlapSpot(state);
    const everyone = state.circles.get("everyone")!;
    const members = [...everyone.members, chip(HER)];
    const repurposed = {
      ...state,
      circles: new Map(state.circles).set("everyone", { ...everyone, members }),
    };
    expect(check(repurposed, [{ _tag: "place", id: "site", after: place }])).toMatch(/Everyone/);
  });
  it("starts a new card in the first agent circle at control of the key", () => {
    const home = agentHomeCircle(start(), "agent-1", 0);
    expect(home?.id).toBe("agents");
    const place = placeInside(start(), { x: home!.x, y: home!.y }, new Set([home!.id]));
    const placed = { ...start(), places: new Map(start().places).set("new", place!) };
    expect(circlesHolding(placed, "new").map((circle) => circle.id)).toEqual(["agents"]);
    expect(agentHomeCircle(start(), "stranger", 0)).toBeUndefined();
  });
  it("deploys the Compose apps of an agent-allowed repo only to machines that the key runs jobs on", () => {
    const base = start();
    const machine = { ...base.resources.get("site")!, id: "m1", name: "m1", kind: "machine" as const };
    const m1 = {
      id: "m1",
      name: "m1",
      labels: ["deploy"],
      order: 0,
      serviceTokenId: "s",
      clientId: "m1-token",
      tunnelId: "t",
    };
    const state = {
      ...base,
      resources: new Map(base.resources).set("m1", machine),
      machines: new Map([["m1", m1]]),
    };
    expect(mayDeployOn(state, null, "m1", 0)).toBe(true);
    expect(mayDeployOn(state, "agent-1", "m1", 0)).toBe(false);
    const managed = { ...state, places: new Map(state.places).set("m1", { x: 0, y: 1000 }) };
    expect(mayDeployOn(managed, "agent-1", "m1", 0)).toBe(true);
    expect(mayDeployOn(managed, "stranger", "m1", 0)).toBe(false);
  });
});

/** The agent circle overlaps Everyone (at 760, 0 with r 260), and the site sits in the agent circle alone. */
function overlapping(rights: KeyFlags): State {
  const state = withRights("agents", rights);
  const agents = state.circles.get("agents")!;
  return {
    ...state,
    circles: new Map(state.circles).set("agents", { ...agents, x: 760, y: 400 }),
    places: new Map(state.places).set("site", { x: 760, y: 500 }),
  };
}

const moved = (state: State, place: Point): State => ({
  ...state,
  places: new Map(state.places).set("site", place),
});

describe("rights of machines with a mode (K-1720, K-1730)", () => {
  const vps = {
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "s",
    clientId: "vps-token",
    tunnelId: "t",
  };
  const withMachine = (rights: Partial<Record<Effect, RightMode>> | undefined): State => {
    const base = start();
    const circle = base.circles.get("agents")!;
    return {
      ...base,
      machines: new Map([["vps", vps]]),
      circles: new Map(base.circles).set("agents", {
        ...circle,
        members: [...circle.members, chip(machineKey("vps"), rights)],
      }),
    };
  };

  it("is off by default, and a circle of devices and machines is its agent circle", () => {
    expect(machineRightMode(withMachine(undefined), "vps", "creates", 0, null)).toBeNull();
    expect(agentHas(withMachine(undefined), as("vps-token"), "creates", 0, null)).toBe(false);
  });

  it("runs an automatic right at once, and an ask right only with its approval", () => {
    const automatic = withMachine({ creates: { mode: "automatic" } });
    expect(agentHas(automatic, as("vps-token"), "creates", 0, null)).toBe(true);
    const asking = withMachine({ creates: { mode: "ask", circleId: "owner" } });
    expect(machineRightMode(asking, "vps", "creates", 0, null)).toEqual({ mode: "ask", circleId: "owner" });
    expect(agentHas(asking, as("vps-token"), "creates", 0, null)).toBe(false);
    expect(agentHas(asking, as("vps-token"), "creates", 0, null, ["creates"])).toBe(true);
    // An approval of one right gives no other right.
    expect(agentHas(asking, as("vps-token"), "shares", 0, null, ["creates"])).toBe(false);
  });

  it("makes a circle of actors that are not people the agent circle of each actor with a right set there (K-1778)", () => {
    const state = withMachine({ changes: { mode: "automatic" } });
    expect(circlesOf(state, as("vps-token"), 0).has("agents")).toBe(true);
    expect(circlesOf(state, as("agent-1"), 0).has("agents")).toBe(true);
    // A machine with no right set there gets nothing new from an older circle (K-1730).
    expect(circlesOf(withMachine(undefined), as("vps-token"), 0).has("agents")).toBe(false);
    // A person in the circle makes it no agent circle, and a passkey circle never is one.
    const agents = state.circles.get("agents")!;
    const person = {
      ...state,
      circles: new Map(state.circles).set("agents", { ...agents, members: [...agents.members, chip(HER)] }),
    };
    expect(circlesOf(person, as("vps-token"), 0).has("agents")).toBe(false);
    const passkey = {
      ...state,
      circles: new Map(state.circles).set("agents", { ...agents, needsPasskey: true }),
    };
    expect(circlesOf(passkey, as("vps-token"), 0).has("agents")).toBe(false);
  });

  it("gives an agent actor its rights only for calls with its verified labels (K-1754, K-1778)", () => {
    const conditions: ReadonlyArray<RightCondition> = [{ key: "t3.project.name", values: ["kitshn"] }];
    const agent = {
      ...actorOf(machineKey("vps"), "kitshn builder"),
      id: actorIdOf(machineKey("vps"), conditions),
      conditions,
    };
    const base = withActors(withMachine({ changes: { mode: "ask", circleId: "owner" } }), [agent]);
    const agents = base.circles.get("agents")!;
    const state: State = {
      ...base,
      circles: new Map(base.circles).set("agents", {
        ...agents,
        members: [
          ...agents.members,
          { _tag: "actor", actorId: agent.id, rights: { changes: { mode: "automatic" } } },
        ],
      }),
    };
    const kitshn = { labels: { "t3.project.name": "kitshn" }, prefixes: ["t3."] };
    expect(machineRightMode(state, "vps", "changes", 0, kitshn)).toEqual({ mode: "automatic" });
    // A bare call, another project, a claimed label (no provider prefix) or a provider that the machine lacks: the machine chip.
    expect(machineRightMode(state, "vps", "changes", 0, null)).toEqual({ mode: "ask", circleId: "owner" });
    const other = { labels: { "t3.project.name": "riffle" }, prefixes: ["t3."] };
    expect(machineRightMode(state, "vps", "changes", 0, other)).toEqual({ mode: "ask", circleId: "owner" });
    expect(machineRightMode(state, "vps", "changes", 0, { ...kitshn, prefixes: [] })).toEqual({
      mode: "ask",
      circleId: "owner",
    });
  });

  it("gives a code right only for a repo that a card in the same agent circle covers (K-1733, K-1761)", () => {
    const base = withMachine({ changes: { mode: "automatic" } });
    const group = {
      id: "repo-group-yarden-zamir",
      kind: "repo.group" as const,
      name: "Yarden-zamir",
      addresses: [],
      status: "unknown" as const,
      group: null,
      machine: null,
      match: "Yarden-zamir",
    };
    const state = {
      ...base,
      resources: new Map(base.resources).set(group.id, group),
      places: new Map(base.places).set(group.id, { x: 0, y: 1000 }),
    };
    expect(codeRightMode(state, "vps", "changes", "Yarden-zamir/riffle", 0, null)).toEqual({
      mode: "automatic",
    });
    // "writes code" includes "reads code".
    expect(codeRightMode(state, "vps", "reads", "Yarden-zamir/riffle", 0, null)).toEqual({
      mode: "automatic",
    });
    expect(codeRightMode(state, "vps", "changes", "qlik-trial/app", 0, null)).toBeNull();
    // Without the group in the circle, no repo is covered.
    expect(codeRightMode(base, "vps", "changes", "Yarden-zamir/riffle", 0, null)).toBeNull();
  });

  it("takes automatic from any agent circle over ask from another", () => {
    const state = withMachine({ changes: { mode: "ask", circleId: "owner" } });
    const staging = state.circles.get("staging")!;
    const both = {
      ...state,
      circles: new Map(state.circles).set("staging", {
        ...staging,
        members: [chip(machineKey("vps"), { changes: { mode: "automatic" } })],
      }),
    };
    expect(machineRightMode(both, "vps", "changes", 0, null)).toEqual({ mode: "automatic" });
  });
});
