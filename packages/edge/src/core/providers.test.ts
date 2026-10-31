import type { ProviderReport } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource, type State, levelForKind, shareKey } from "./model.ts";
import { applyChanges, forgetProviderChanges, invert, ruleViolation } from "./changes.ts";
import {
  commandsFor,
  grantTables,
  grantsOf,
  machineBusy,
  providerCards,
  providerPushes,
  siteAudiences,
  reachOf,
} from "./providers.ts";

const report: ProviderReport = {
  name: "t3",
  online: true,
  kinds: [
    { id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } },
    { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
  ],
  commands: [
    { id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true },
    { id: "stop-agents", title: "Stop all agents", kinds: [], confirm: true },
  ],
  resources: [
    { id: "app", kind: "t3.app", name: "T3", status: "running", site: { name: "t3-vps", port: 3773 } },
    { id: "th-1", kind: "t3.thread", name: "Fix", status: "running", parent: "app", facts: [] },
  ],
};

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "t",
  clientId: "vps.access",
  tunnelId: "u",
};

const circle = (id: string, members: Circle["members"], extra: Partial<Circle> = {}): Circle => ({
  id,
  name: id,
  color: "#000",
  level: "control",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 0,
  y: 0,
  r: 100,
  ...extra,
});

function state(circles: ReadonlyArray<Circle>, extra: Partial<State> = {}): State {
  const cards = providerCards(machine, [report], "example.com");
  return {
    circles: new Map(circles.map((item) => [item.id, item])),
    resources: cards,
    places: new Map([...cards.keys()].map((id) => [id, { x: 0, y: 0 }])),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map([[machine.id, machine]]),
    ...extra,
  };
}

const thread = (value: State) => [...value.resources.values()].find((card) => card.kind === "t3.thread")!;

describe("provider cards (K-705)", () => {
  it("gives a site its address, stacks a child with its parent, and shows an offline provider", () => {
    const cards = [...providerCards(machine, [report], "example.com").values()];
    const [app, child] = cards;
    expect(app).toMatchObject({ addresses: ["t3-vps.example.com"], machine: "vps", status: "running" });
    expect(child?.group).toBe(app?.id);
    const offline = providerCards(machine, [{ ...report, online: false }], "example.com");
    expect([...offline.values()].every((card) => card.status === "offline")).toBe(true);
  });

  it("maps a circle level to the provider's level by K-206 (K-713)", () => {
    const card = thread(state([]));
    expect(levelForKind(card, "control")).toBe("use");
    expect(levelForKind(card, "view")).toBe("view");
  });
});

describe("grant tables (K-706)", () => {
  it("names the provider's level and gives devices and machines their Access client id", () => {
    const value = state([
      circle("her", [
        { _tag: "email", email: "Her@Example.com" },
        { _tag: "machine", machineId: "vps" },
        { _tag: "device", tokenId: "d", clientId: "phone.access", name: "phone" },
      ]),
    ]);
    expect(grantsOf(value, thread(value), 0)).toEqual([
      {
        circle: {
          id: "her",
          name: "her",
          match: "any",
          needsPasskey: false,
          rules: [
            { email: "her@example.com" },
            { machine: { machineId: "vps", clientId: "vps.access" } },
            { device: { clientId: "phone.access", name: "phone" } },
          ],
        },
        level: "send",
        endsAt: null,
      },
    ]);
    // A machine's daemon token held as a device member is that machine, so the provider can tell it from a device.
    const viaToken = state([
      circle("her", [
        { _tag: "device", tokenId: "t-vps", clientId: "vps.access", name: "kitshn machine vps" },
        { _tag: "device", tokenId: "d", clientId: "phone.access", name: "phone" },
      ]),
    ]);
    expect(grantsOf(viaToken, thread(viaToken), 0)[0]?.circle.rules).toEqual([
      { machine: { machineId: "vps", clientId: "vps.access" } },
      { device: { clientId: "phone.access", name: "phone" } },
    ]);
  });

  it("carries the earlier end date and drops an ended share (K-209)", () => {
    const her = circle("her", [{ _tag: "email", email: "a@b.c" }], { endsAt: 500 });
    const value = state([her]);
    const card = thread(value);
    const withShare = {
      ...value,
      shareSettings: new Map([[shareKey(card.id, "her"), { level: null, endsAt: 200 }]]),
    };
    expect(grantsOf(withShare, card, 0)[0]?.endsAt).toBe(200);
    expect(grantsOf(withShare, card, 300)).toEqual([]);
  });

  it("closes every grant in a pause, and never widens an 'all must match' circle (K-1504, K-006)", () => {
    const mixed = circle("mixed", [
      { _tag: "email", email: "a@b.c" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ]);
    const strict = { ...mixed, id: "strict", match: "all" as const };
    const paused = state([mixed, strict], { paused: "keep-public" });
    // A pause closes every share of a provider card, as for a machine (K-1504).
    expect(grantsOf(paused, thread(paused), 0)).toEqual([]);
    const unknown = circle(
      "unknown",
      [
        { _tag: "email", email: "a@b.c" },
        { _tag: "machine", machineId: "gone" },
      ],
      {
        match: "all",
      },
    );
    const open = state([unknown]);
    expect(grantsOf(open, thread(open), 0)).toEqual([]);
  });

  it("builds one table per resource of the provider, by its own id", () => {
    const value = state([circle("her", [{ _tag: "email", email: "a@b.c" }])]);
    expect(Object.keys(grantTables(value, "vps", "t3", 0)).sort()).toEqual(["app", "th-1"]);
    expect(grantTables(value, "other", "t3", 0)).toEqual({});
  });
});

describe("provider commands (K-707)", () => {
  it("offers a card the commands of its kind, and the machine card the commands without kinds", () => {
    const value = state([]);
    const app = [...value.resources.values()].find((card) => card.kind === "t3.app") as Resource;
    expect(commandsFor([report], app).map((item) => item.command.id)).toEqual(["restart"]);
    expect(commandsFor([report], thread(value))).toEqual([]);
    const machineCard = { kind: "machine" } as const;
    expect(commandsFor([report], machineCard).map((item) => item.command.id)).toEqual(["stop-agents"]);
  });
});

describe("forget provider (K-704)", () => {
  it("removes the provider's cards with their places and overrides, and undo brings them back offline", () => {
    const her = circle("her", [{ _tag: "email", email: "a@b.c" }]);
    const value = state([her]);
    const card = thread(value);
    const withOverride = {
      ...value,
      shareSettings: new Map([[shareKey(card.id, "her"), { level: "view" as const, endsAt: null }]]),
    };
    const changes = forgetProviderChanges(withOverride, "vps", "t3");
    const after = applyChanges(withOverride, changes);
    expect([...after.resources.values()].some((item) => item.provider)).toBe(false);
    expect(after.places.size).toBe(0);
    expect(after.shareSettings.size).toBe(0);
    const undone = applyChanges(after, invert(changes));
    expect(undone.resources.get(card.id)?.status).toBe("offline");
    expect(undone.places.get(card.id)).toEqual(withOverride.places.get(card.id));
    expect(undone.shareSettings.get(shareKey(card.id, "her"))?.level).toBe("view");
  });

  it("gives a dropped card no grants while it waits (K-705)", () => {
    const value = state([circle("her", [{ _tag: "email", email: "a@b.c" }])]);
    const card = thread(value);
    const dropped = { ...card, provider: { ...card.provider!, droppedAt: 1 } };
    const waiting = { ...value, resources: new Map([...value.resources, [card.id, dropped]]) };
    expect(Object.keys(grantTables(waiting, "vps", "t3", 0))).toEqual(["app"]);
  });
});

describe("pushes to a machine (K-709, K-717, K-1608)", () => {
  it("gives each provider its grants and card settings, and each state kind the shared and own part", () => {
    const kinds = [
      {
        id: "t3.app",
        name: "T3 app",
        levels: { view: "view" },
        settings: [
          { id: "updateChannel", title: "Update channel", values: ["nightly", "daily"], default: "nightly" },
        ],
      },
      { id: "t3.settings", name: "settings", levels: {}, state: {} },
    ];
    const withSettings = providerCards(
      machine,
      [{ ...report, kinds: [...kinds, report.kinds[1]!] }],
      "example.com",
    );
    // K-1623: the app card serves its site, so its Access application's audience goes to the provider.
    const served = new Map(
      [...withSettings].map(([id, card]): [string, Resource] => [
        id,
        card.kind === "t3.app"
          ? { ...card, addresses: ["t3-vps.example.com"], provider: { ...card.provider!, site: "t3-vps" } }
          : card,
      ]),
    );
    const value: State = { ...state([]), resources: served };
    const app = [...served.values()].find((card) => card.kind === "t3.app")!;
    const access = (aud: string | null, served: string | null = null) => ({
      teamDomain: "team.cloudflareaccess.com",
      audiencesOf: (cardId: string) => (cardId === app.id && aud ? [aud] : []),
      servedHost: (cardId: string) => (cardId === app.id ? served : null),
      revOf: (kind: string) => (kind === "t3.settings" ? "r-7" : null),
    });
    const desired = new Map([
      [
        "t3.settings",
        new Map<string, unknown>([
          ["", { theme: "dark" }],
          ["other", { x: 1 }],
        ]),
      ],
    ]);
    const pushes = providerPushes(
      value,
      "vps",
      [{ name: "t3", kinds }],
      desired,
      new Map([[app.id, { updateChannel: "daily" }]]),
      0,
      access("aud-app", "t3-vps.example.com"),
    );
    expect(pushes.map((push) => push.key)).toEqual([
      "grants:t3",
      "reach:t3",
      "settings:t3",
      "access:t3",
      "desired:t3:t3.settings",
    ]);
    expect(pushes[2]).toMatchObject({ values: { app: { updateChannel: "daily" } } });
    expect(pushes[3]).toMatchObject({
      access: {
        teamDomain: "team.cloudflareaccess.com",
        audiences: ["aud-app"],
        served: ["t3-vps.example.com"],
      },
    });
    // Another machine's part never reaches this one.
    expect(pushes[4]).toMatchObject({ state: { shared: { theme: "dark" }, machine: null }, rev: "r-7" });
    // A stored value that the kind no longer offers falls back to the default.
    const stale = providerPushes(
      value,
      "vps",
      [{ name: "t3", kinds }],
      desired,
      new Map([[app.id, { updateChannel: "weekly" }]]),
      0,
      access(null),
    );
    expect(stale[2]).toMatchObject({ values: { app: { updateChannel: "nightly" } } });
    // No application yet: no audience, so the provider accepts only what it accepted before.
    expect(stale[3]).toMatchObject({ access: { audiences: [], served: [] } });
    // A give-back takes the address off the card at once, but the application answers until the sync deletes it.
    const givenBack: State = { ...value, resources: new Map([[app.id, { ...app, addresses: [] }]]) };
    expect(siteAudiences(givenBack, "vps", "t3", access("aud-app").audiencesOf)).toEqual(["aud-app"]);
  });
});

describe("reach of a machine (K-1609)", () => {
  it("lists the cards of the provider on other machines that the machine's token opens, with the level name", () => {
    const other: Machine = { ...machine, id: "mac", name: "mac", clientId: "mac.access" };
    const base = state([circle("links", [{ _tag: "machine", machineId: "mac" }], { level: "use" })]);
    const value: State = { ...base, machines: new Map([...base.machines, ["mac", other]]) };
    // The cards of vps sit in "links", which holds the machine mac.
    expect(reachOf(value, "mac", "t3", 0)).toEqual([
      {
        machineId: "vps",
        machineName: "vps",
        kind: "t3.app",
        id: "app",
        address: "t3-vps.example.com",
        level: "use",
      },
      { machineId: "vps", machineName: "vps", kind: "t3.thread", id: "th-1", address: null, level: "send" },
    ]);
    // A machine never reaches its own cards, and a pause closes every link (K-1504).
    expect(reachOf(value, "vps", "t3", 0)).toEqual([]);
    expect(reachOf({ ...value, paused: "keep-public" }, "mac", "t3", 0)).toEqual([]);
  });
});

describe("a busy machine (K-1608)", () => {
  it("is busy only while a running card of a provider reports busy, not an offline or dropped one", () => {
    const value = state([]);
    const app = [...value.resources.values()].find((card) => card.kind === "t3.app")!;
    const with_ = (card: Resource) => ({
      ...value,
      resources: new Map([...value.resources, [app.id, card]]),
    });
    const busy = {
      ...app,
      provider: { ...app.provider!, facts: [{ label: "busy", value: "true", role: "busy" as const }] },
    };
    expect(machineBusy(with_(busy), "vps")).toBe(true);
    expect(machineBusy(with_({ ...busy, status: "offline" }), "vps")).toBe(false);
    expect(machineBusy(with_({ ...busy, provider: { ...busy.provider, droppedAt: 1 } }), "vps")).toBe(false);
    expect(machineBusy(value, "vps")).toBe(false);
  });
});

describe("owner control (K-719)", () => {
  it("gives the Owner circle the top level of an owner-control card wherever it sits, and refuses an override of it", () => {
    const owner = circle(OWNER_CIRCLE_ID, [{ _tag: "email", email: "owner@b.c" }], {
      x: 5000,
      y: 5000,
      level: "view",
    });
    const base = state([owner]);
    const app = [...base.resources.values()].find((card) => card.kind === "t3.app")!;
    const guarded = { ...app, provider: { ...app.provider!, ownerControl: true as const } };
    const value: State = { ...base, resources: new Map([...base.resources, [app.id, guarded]]) };
    // The card sits at 0,0, outside the Owner circle, and the Owner circle's default is view.
    expect(grantsOf(value, guarded, 0)).toEqual([
      expect.objectContaining({ circle: expect.objectContaining({ id: OWNER_CIRCLE_ID }), level: "control" }),
    ]);
    expect(grantsOf(base, app, 0)).toEqual([]);
    const lowered = {
      ...value,
      shareSettings: new Map([[shareKey(app.id, OWNER_CIRCLE_ID), { level: "view" as const, endsAt: null }]]),
    };
    expect(ruleViolation(lowered)).toMatch(/keeps control/);
  });
});
