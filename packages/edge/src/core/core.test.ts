import { describe, expect, it } from "vitest";
import { ASK_APP, OP_TOKENS_POLICY, circlePolicies, desiredAccess } from "./access.ts";
import {
  type Actor,
  applyChanges,
  type Change,
  conflictOf,
  describeDiff,
  type Edit,
  invert,
  MOVE_MERGE_MS,
  mergeMoves,
  type StoredRevision,
  prepareUndo,
  undoAnswer,
  undoTarget,
  mergedSummary,
  refuseRaiseWhilePaused,
  refuseResume,
  removeAppChanges,
  resolveEdits,
  revisionTargets,
  ruleViolation,
  shareDiff,
  stacksWithout,
  summarize,
  withStackMates,
} from "./changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  EVERYONE_CIRCLE_ID,
  pauseModeOf,
  pauseReach,
  OWNER_CIRCLE_ID,
  RESOURCE_KINDS,
  type ResourceKind,
  type Resource,
  type State,
  circleAloneKey,
  levelForKind,
  shareKey,
} from "./model.ts";
import { placeInside } from "./place.ts";
import { seed } from "./seed.ts";
import { circleMatches, ipInRange, visitorLevel } from "./visitor.ts";

const OWNER = "owner@example.com";

function start(): State {
  const s = seed([OWNER], "kit.example.com");
  const site: Resource = {
    id: "riffle",
    kind: "site.compose",
    name: "riffle",
    addresses: ["riffle.example.com"],
    status: "running",
    group: null,
    machine: null,
  };
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "use",
    members: [{ _tag: "email", email: "her@example.com" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 400,
    y: 0,
    r: 200,
  };
  return {
    circles: new Map([...s.circles, her].map((circle) => [circle.id, circle])),
    resources: new Map([...s.resources, site].map((resource) => [resource.id, resource])),
    places: new Map([...s.places, ["riffle", { x: 0, y: -200 }]]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

const edit = (state: State, edits: Array<Edit>) => {
  const changes = resolveEdits(state, edits);
  return { changes, after: applyChanges(state, changes) };
};

const circle = (state: State, id: string) => {
  const found = state.circles.get(id);
  if (!found) throw new Error(`no circle ${id}`);
  return found;
};

describe("levels", () => {
  it("maps a level that the kind lacks to the highest lower level (K-206)", () => {
    expect(levelForKind("file", "control")).toBe("view");
    expect(levelForKind("machine", "use")).toBe("use");
    expect(levelForKind("kitshn.admin", "view")).toBeNull();
  });
});

describe("circle-alone key (K-504)", () => {
  it("is ⌘ on macOS and iOS, and Ctrl elsewhere", () => {
    for (const platform of ["MacIntel", "iPad", "iPhone"])
      expect(circleAloneKey(platform)).toEqual({ property: "metaKey", label: "⌘" });
    for (const platform of ["Win32", "Linux x86_64", "Linux armv8l", ""])
      expect(circleAloneKey(platform)).toEqual({ property: "ctrlKey", label: "Ctrl" });
  });
});

describe("admin guard (K-105)", () => {
  it("accepts the seeded state", () => {
    expect(ruleViolation(start())).toBeNull();
  });

  it("refuses moving the admin card out of the Owner circle", () => {
    const { after } = edit(start(), [{ _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } }]);
    expect(ruleViolation(after)).toMatch(/passkey/);
  });

  it("refuses turning the passkey off or lowering the Owner level", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    for (const changed of [
      { ...owner, needsPasskey: false },
      { ...owner, level: "view" as const },
      { ...owner, members: [] },
    ]) {
      const { after } = edit(state, [{ _tag: "circle", id: OWNER_CIRCLE_ID, after: changed }]);
      expect(ruleViolation(after)).not.toBeNull();
    }
  });

  it("refuses a public admin and a deleted Owner circle", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const covering = edit(state, [
      {
        _tag: "circle",
        id: EVERYONE_CIRCLE_ID,
        after: { ...everyone, level: "control", x: 0, y: 40, r: 100 },
      },
    ]);
    expect(ruleViolation(covering.after)).toMatch(/public/);
    const deleted = edit(state, [{ _tag: "circle", id: OWNER_CIRCLE_ID, after: null }]);
    expect(ruleViolation(deleted.after)).toMatch(/Owner circle/);
  });

  it("refuses an Owner circle that can never match anyone", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const { after } = edit(state, [
      {
        _tag: "circle",
        id: OWNER_CIRCLE_ID,
        after: {
          ...owner,
          match: "all",
          members: [...owner.members, { _tag: "email", email: "b@example.com" }],
        },
      },
    ]);
    expect(ruleViolation(after)).toMatch(/passkey/);
    const otherDomain = edit(state, [
      {
        _tag: "circle",
        id: OWNER_CIRCLE_ID,
        after: {
          ...owner,
          match: "all",
          members: [...owner.members, { _tag: "domain", domain: "other.com" }],
        },
      },
    ]);
    expect(ruleViolation(otherDomain.after)).toMatch(/passkey/);
  });

  it("accepts a second passkey circle that takes over the admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const { after } = edit(state, [
      {
        _tag: "circle",
        id: "admins",
        after: { ...owner, id: "admins", name: "Admins", x: 2000, y: 2000 },
      },
      { _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } },
    ]);
    expect(ruleViolation(after)).toBeNull();
  });
});

describe("changes and undo (K-1501, K-1502)", () => {
  it("keeps a passed end time unless the same Undo puts the card back on the map (K-209, K-212)", () => {
    const share = shareKey("riffle", "her");
    // At 10:00 the owner sets an end at 11:00 and extends it to 12:00 at 10:30; the Undo comes at 11:15.
    const extended = { ...start(), ends: new Map([["riffle", 12]]) };
    const extension: Array<Change> = [{ _tag: "cardEnd", id: "riffle", before: 11, after: 12 }];
    expect(prepareUndo(extended, extension, 11.25)).toEqual([
      { _tag: "cardEnd", id: "riffle", before: 12, after: 11 },
    ]);
    const sharedLonger = { ...start(), shareSettings: new Map([[share, { level: null, endsAt: 12 }]]) };
    const shareExtension: Array<Change> = [
      {
        _tag: "shareSetting",
        id: share,
        before: { level: null, endsAt: 11 },
        after: { level: null, endsAt: 12 },
      },
    ];
    expect(prepareUndo(sharedLonger, shareExtension, 11.25)).toEqual([
      {
        _tag: "shareSetting",
        id: share,
        before: { level: null, endsAt: 12 },
        after: { level: null, endsAt: 11 },
      },
    ]);
    // The Undo of the expiry gives the place back, so the passed end goes and the shares stay.
    const ended = { ...start(), places: new Map([...start().places].filter(([id]) => id !== "riffle")) };
    const expiry: Array<Change> = [
      { _tag: "place", id: "riffle", before: { x: 0, y: -200 }, after: null },
      { _tag: "cardEnd", id: "riffle", before: 11, after: null },
    ];
    expect(prepareUndo(ended, expiry, 11.25)).toContainEqual({
      _tag: "cardEnd",
      id: "riffle",
      before: null,
      after: null,
    });
  });

  it("drops edits that change nothing", () => {
    const state = start();
    expect(resolveEdits(state, [{ _tag: "place", id: "riffle", after: { x: 0, y: -200 } }])).toEqual([]);
  });

  it("undoes a change and refuses an undo after a later change", () => {
    const state = start();
    const first = edit(state, [{ _tag: "place", id: "riffle", after: { x: 400, y: 0 } }]);
    const undo = invert(first.changes);
    expect(conflictOf(first.after, undo)).toBeNull();
    expect(applyChanges(first.after, undo).places.get("riffle")).toEqual({ x: 0, y: -200 });

    const second = edit(first.after, [{ _tag: "place", id: "riffle", after: { x: 900, y: 900 } }]);
    expect(conflictOf(second.after, undo)).toMatchObject({ _tag: "place", id: "riffle" });
  });

  it("brings a deleted circle back with its shares and overrides, since the delete has no confirm (K-211)", () => {
    const state: State = {
      ...start(),
      places: new Map([...start().places, ["riffle", { x: 400, y: 0 }]]),
      shareSettings: new Map([[shareKey("riffle", "her"), { level: "view", endsAt: 5 }]]),
    };
    const deleted = edit(state, [{ _tag: "circle", id: "her", after: null }]);
    expect(deleted.after.circles.has("her")).toBe(false);
    const back = applyChanges(deleted.after, invert(deleted.changes));
    expect(back.circles.get("her")).toEqual(state.circles.get("her"));
    expect(back.shareSettings.get(shareKey("riffle", "her"))).toEqual({ level: "view", endsAt: 5 });
    expect(shareDiff(state, back)).toEqual([]);
  });

  it("names share changes in the summary (K-502, K-503)", () => {
    const state = start();
    const { changes, after } = edit(state, [{ _tag: "place", id: "riffle", after: { x: 400, y: 0 } }]);
    const diffs = shareDiff(state, after);
    expect(diffs.map((diff) => [diff.circle.id, diff.from, diff.to])).toEqual([
      ["owner", "view", null],
      ["her", null, "view"],
    ]);
    expect(summarize(state, after, changes)).toBe("riffle: − Owner; riffle: + Her · view");
  });

  it("names an agent right that a circle edit gives or takes (K-718)", () => {
    const state = start();
    const owner = state.circles.get("owner")!;
    const bot = { _tag: "device" as const, tokenId: "t", clientId: "c", name: "Bot" };
    const withBot = edit(state, [
      { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, bot] } },
    ]).after;
    const gave = edit(withBot, [
      {
        _tag: "circle",
        id: "owner",
        after: { ...owner, members: [...owner.members, { ...bot, publishes: true }] },
      },
    ]);
    expect(summarize(withBot, gave.after, gave.changes)).toBe("Gave Bot may publish in Owner");
    const took = edit(gave.after, [
      { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, bot] } },
    ]);
    expect(summarize(gave.after, took.after, took.changes)).toBe("Took may publish from Bot in Owner");
  });

  it("uses a share override over the circle default (K-205)", () => {
    const state = start();
    const { after } = edit(state, [
      { _tag: "shareSetting", resourceId: "riffle", circleId: "owner", after: { level: null, endsAt: 5 } },
    ]);
    expect(after.shareSettings.get(shareKey("riffle", "owner"))).toEqual({ level: null, endsAt: 5 });
  });

  it("refuses an edit of a card that does not exist", () => {
    expect(() => resolveEdits(start(), [{ _tag: "place", id: "nope", after: { x: 0, y: 0 } }])).toThrow(
      /No card/,
    );
  });
});

describe("app removal and its undo (K-909, K-1502)", () => {
  const shared = () =>
    edit(start(), [
      { _tag: "shareSetting", resourceId: "riffle", circleId: "owner", after: { level: null, endsAt: 5 } },
    ]).after;

  it("removes the card with its place and shares, and undo puts it back in the same place and circles", () => {
    const state = shared();
    const removal = removeAppChanges(state, "riffle");
    const removed = applyChanges(state, removal);
    expect(removed.resources.has("riffle")).toBe(false);
    expect(removed.places.has("riffle")).toBe(false);
    expect(removed.shareSettings.size).toBe(0);
    expect(summarize(state, removed, removal)).toBe("Removed the app riffle (K-909)");
    const undo = invert(removal);
    expect(conflictOf(removed, undo)).toBeNull();
    const back = applyChanges(removed, undo);
    expect(back.places).toEqual(state.places);
    expect(back.shareSettings).toEqual(state.shareSettings);
    expect(back.resources.get("riffle")).toEqual({ ...state.resources.get("riffle"), status: "unknown" });
    expect(summarize(removed, back, undo)).toBe("Restored the app riffle (K-909)");
  });

  it("names a stack without a name by its cards in History (K-521)", () => {
    const point = { x: 0, y: 40 };
    const named = { id: "s1", name: "Sites", members: ["kitshn-admin", "riffle"] };
    const { after: state } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "place", id: "kitshn-admin", after: point },
      { _tag: "stack", id: "s1", after: named },
    ]);
    const cleared = edit(state, [{ _tag: "stack", id: "s1", after: { ...named, name: "" } }]);
    expect(summarize(state, cleared.after, cleared.changes)).toBe(
      "Took the name Sites off the stack of kitshn admin, riffle",
    );
    const reordered = edit(cleared.after, [
      { _tag: "stack", id: "s1", after: { ...named, name: "", members: ["riffle", "kitshn-admin"] } },
    ]);
    expect(summarize(cleared.after, reordered.after, reordered.changes)).toBe(
      "Changed the stack of riffle, kitshn admin",
    );
    const gone = edit(cleared.after, [{ _tag: "stack", id: "s1", after: null }]);
    expect(summarize(cleared.after, gone.after, gone.changes)).toBe("Unstacked kitshn admin, riffle");
  });

  it("takes a card out of its stack and undo puts it back", () => {
    const point = { x: 0, y: 40 };
    const { after: state } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "place", id: "kitshn-admin", after: point },
      { _tag: "stack", id: "s1", after: { id: "s1", name: "Sites", members: ["kitshn-admin", "riffle"] } },
    ]);
    const removal = removeAppChanges(state, "riffle");
    const removed = applyChanges(state, removal);
    expect(removed.stacks.size).toBe(0);
    expect(ruleViolation(removed)).toBeNull();
    expect(applyChanges(removed, invert(removal)).stacks).toEqual(state.stacks);
  });

  it("refuses an undo once a later deploy made the card again, and a card that is no app", () => {
    const state = shared();
    const removal = removeAppChanges(state, "riffle");
    expect(conflictOf(applyChanges(state, removal.slice(0, -1)), invert(removal))).toMatchObject({
      _tag: "app",
      id: "riffle",
    });
    expect(() => removeAppChanges(state, "kitshn-admin")).toThrow(/not an app/);
    expect(() => removeAppChanges(state, "gone")).toThrow(/No card/);
  });
});

describe("placement (K-511)", () => {
  it("finds a point inside exactly the wanted circles", () => {
    const state = start();
    const point = placeInside(state, { x: 0, y: -200 }, new Set(["owner", "her"]));
    expect(point).not.toBeNull();
    const placed = applyChanges(state, resolveEdits(state, [{ _tag: "place", id: "riffle", after: point }]));
    expect(shareDiff(state, placed).map((diff) => diff.circle.id)).toEqual(["her"]);
  });

  it("returns null when the circles do not overlap", () => {
    expect(placeInside(start(), { x: 0, y: 0 }, new Set(["owner", "everyone"]))).toBeNull();
  });
});

describe("visitors (K-203, K-207)", () => {
  it("matches IPv4 and IPv6 ranges", () => {
    expect(ipInRange("10.0.0.7", "10.0.0.0/24")).toBe(true);
    expect(ipInRange("10.0.1.7", "10.0.0.0/24")).toBe(false);
    expect(ipInRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInRange("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInRange("10.0.0.7", "2001:db8::/32")).toBe(false);
  });

  it("needs every member in an all circle", () => {
    const qlik: Circle = {
      ...circle(start(), "her"),
      match: "all",
      members: [
        { _tag: "domain", domain: "qlik.com" },
        { _tag: "ip", range: "10.0.0.0/8" },
      ],
    };
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "10.1.2.3" }, new Map())).toBe(
      true,
    );
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "8.8.8.8" }, new Map())).toBe(
      false,
    );
  });

  it("gives the owner control of the admin and nobody else", () => {
    const state = start();
    const admin = state.resources.get(ADMIN_RESOURCE_ID)!;
    expect(visitorLevel(state, admin, { email: "OWNER@example.com", clientId: null, ip: null }, 0)).toBe(
      "control",
    );
    expect(visitorLevel(state, admin, { email: "her@example.com", clientId: null, ip: null }, 0)).toBeNull();
  });

  it("ignores a share after its end date", () => {
    const state = start();
    const { after } = edit(state, [
      { _tag: "shareSetting", resourceId: "riffle", circleId: "owner", after: { level: null, endsAt: 10 } },
    ]);
    const riffle = after.resources.get("riffle")!;
    const owner = { email: OWNER, clientId: null, ip: null };
    expect(visitorLevel(after, riffle, owner, 9)).toBe("view");
    expect(visitorLevel(after, riffle, owner, 10)).toBeNull();
  });
});

describe("Access compile (K-401 to K-403)", () => {
  it("compiles the Owner circle to one allow policy with the passkey check", () => {
    const policies = circlePolicies(circle(start(), OWNER_CIRCLE_ID), new Map());
    expect([...policies.keys()]).toEqual(["policy:owner:people"]);
    const body = policies.get("policy:owner:people")!;
    expect(body.decision).toBe("allow");
    expect(body.include).toEqual([{ email: { email: OWNER } }]);
    expect(body.mfa_config?.allowed_authenticators).toContain("biometrics");
  });

  it("lets only the Owner circle's people into a removed app that still answers, also in a pause (K-909)", () => {
    const removed = [{ id: "app-gone-1-prod", name: "gone", address: "gone.example.com" }];
    for (const state of [start(), { ...start(), paused: "keep-public" as const }]) {
      const desired = desiredAccess(state, 0, removed);
      const keys = desired.apps.get("app:app-gone-1-prod:gone.example.com")?.policyKeys;
      expect(keys).toEqual(["policy:owner:people"]);
      expect(desired.policies.get("policy:owner:people")?.decision).toBe("allow");
    }
  });

  it("compiles Everyone to a bypass and devices to Service Auth", () => {
    expect(
      circlePolicies(circle(start(), EVERYONE_CIRCLE_ID), new Map()).get("policy:everyone:people")?.decision,
    ).toBe("bypass");
    const devices: Circle = {
      ...circle(start(), "her"),
      members: [
        { _tag: "email", email: "her@example.com" },
        { _tag: "device", tokenId: "t1", clientId: "c1.access", name: "her phone" },
      ],
    };
    const policies = circlePolicies(devices, new Map());
    expect(policies.get("policy:her:tokens")?.decision).toBe("non_identity");
    expect(policies.get("policy:her:people")?.mfa_config).toBeUndefined();
  });

  it("gives an all circle no policy when a member cannot become a require rule (K-006)", () => {
    const base = circle(start(), "her");
    const withToken: Circle = {
      ...base,
      match: "all",
      members: [
        { _tag: "email", email: "her@example.com" },
        { _tag: "device", tokenId: "t1", clientId: "c1.access", name: "her phone" },
      ],
    };
    expect(circlePolicies(withToken, new Map()).size).toBe(0);
    const withMachine: Circle = {
      ...withToken,
      members: [withToken.members[0]!, { _tag: "machine", machineId: "m1" }],
    };
    expect(circlePolicies(withMachine, new Map()).size).toBe(0);
  });

  it("gives each addressed card an application with the policies of its circles", () => {
    const state = start();
    const access = desiredAccess(state, 0);
    expect(access.apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    expect(access.apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    const moved = applyChanges(
      state,
      resolveEdits(state, [{ _tag: "place", id: "riffle", after: { x: 3000, y: 3000 } }]),
    );
    expect(desiredAccess(moved, 0).apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual([]);
    // K-1124: an old address keeps the policies of its card, so its redirect asks the same people.
    const old = [{ cardId: "riffle", address: "old-riffle.example.com" }];
    expect(
      desiredAccess(state, 0, [], old).apps.get("app:riffle:old-riffle.example.com")?.policyKeys,
    ).toEqual(["policy:owner:people"]);
    expect(access.apps.get("app:riffle:riffle.example.com")).not.toHaveProperty("custom_pages");
    // K-1777: with a machine joined, the token of each machine reaches the gate of `/op`, except during a pause.
    const joined: State = {
      ...state,
      machines: new Map([
        [
          "m1",
          { id: "m1", name: "m1", labels: [], order: 0, serviceTokenId: "t", clientId: "c", tunnelId: "u" },
        ],
      ]),
    };
    expect(desiredAccess(joined, 0).apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual([
      OP_TOKENS_POLICY,
      "policy:owner:people",
    ]);
    expect(desiredAccess(joined, 0).policies.get(OP_TOKENS_POLICY)?.include).toEqual([
      { service_token: { token_id: "t" } },
    ]);
    expect(
      desiredAccess({ ...joined, paused: "lockdown" }, 0).apps.get("app:kitshn-admin:kit.example.com")
        ?.policyKeys,
    ).toEqual(["policy:owner:people"]);
  });
});

describe("kitshn login pages (K-1130)", () => {
  it("never leaves an application on the bare Cloudflare login, in each case where the owner met it", () => {
    const pages = { chef: "chef", closed: "closed", login: "login" };
    const state = start();
    const spot = state.places.get("riffle")!;
    const tray = applyChanges(
      state,
      resolveEdits(state, [{ _tag: "place", id: "riffle", after: { x: 3000, y: 3000 } }]),
    );
    const shared = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "her", after: { ...circle(state, "her"), x: spot.x, y: spot.y, r: 400 } },
      ]),
    );
    const devices: Circle = {
      ...circle(state, "her"),
      x: 3000,
      y: 3000,
      r: 400,
      members: [{ _tag: "device", tokenId: "t1", clientId: "c1.access", name: "a machine" }],
    };
    const machinesOnly = applyChanges(
      tray,
      resolveEdits(tray, [{ _tag: "circle", id: "her", after: devices }]),
    );
    const old = [{ cardId: "riffle", address: "old-riffle.example.com" }];
    const removed = [{ id: "app-gone-1-prod", name: "gone", address: "gone.example.com" }];
    const page = (from: State, key: string) =>
      desiredAccess(from, 0, removed, old, pages).apps.get(key)?.custom_pages;
    // [case, state, application, page]
    const rows: Array<[string, State, string, string]> = [
      ["a card in the tray, which nobody opens", tray, "app:riffle:riffle.example.com", "closed"],
      ["its old address", tray, "app:riffle:old-riffle.example.com", "closed"],
      ["a card in the Owner circle only", state, "app:riffle:riffle.example.com", "chef"],
      ["the admin", state, "app:kitshn-admin:kit.example.com", "chef"],
      ["an old address of an Owner-only card", state, "app:riffle:old-riffle.example.com", "chef"],
      ["a removed app that still answers", state, "app:app-gone-1-prod:gone.example.com", "chef"],
      ["a card that another people circle opens", shared, "app:riffle:riffle.example.com", "login"],
      ["a card in a circle of machines only", machinesOnly, "app:riffle:riffle.example.com", "closed"],
      [
        "the pause, which closes the card's share",
        { ...state, paused: "keep-public" },
        "app:riffle:riffle.example.com",
        "closed",
      ],
      [
        "the admin in the pause",
        { ...state, paused: "keep-public" },
        "app:kitshn-admin:kit.example.com",
        "chef",
      ],
    ];
    for (const [name, from, key, wanted] of rows) expect(page(from, key), name).toEqual([wanted]);
    expect(desiredAccess(state, 0, [], [], pages).loginPage).toBe("login");
    // K-1132: with the help pages, a refused person goes to `/ask` once it exists, else to the help page. The admin
    // never goes to `/ask`, which lies under its host.
    const help = { host: "kit.example.com", askLive: true };
    const live = desiredAccess(state, 0, [], [], pages, help);
    expect(live.apps.get("app:riffle:riffle.example.com")?.custom_deny_url).toBe(
      "https://kit.example.com/ask",
    );
    expect(live.apps.get("app:kitshn-admin:kit.example.com")?.custom_deny_url).toBe(
      "https://kit.example.com/public/help/denied",
    );
    expect(
      desiredAccess(state, 0, [], [], pages, { ...help, askLive: false }).apps.get(
        "app:riffle:riffle.example.com",
      )?.custom_deny_url,
    ).toBe("https://kit.example.com/public/help/denied");
    expect(desiredAccess(state, 0).apps.get("app:riffle:riffle.example.com")).not.toHaveProperty(
      "custom_deny_url",
    );
    // K-111: `/ask` lets in only people that a circle lets in already: never a Bypass, so no stranger takes a seat.
    const ask = live.apps.get(ASK_APP);
    expect(ask).toMatchObject({
      domain: "kit.example.com/ask",
      custom_deny_url: "https://kit.example.com/public/help/denied",
    });
    expect(ask?.policyKeys.length).toBeGreaterThan(0);
    for (const key of ask?.policyKeys ?? []) expect(live.policies.get(key)?.decision, key).toBe("allow");
    expect(desiredAccess(state, 0).apps.has(ASK_APP)).toBe(false);
    // Without the pages the bootstrap made, nothing changes.
    expect(desiredAccess(tray, 0).apps.get("app:riffle:riffle.example.com")).not.toHaveProperty(
      "custom_pages",
    );
    // A card in no circle still lets nobody in (K-208).
    expect(
      desiredAccess(tray, 0, [], [], pages).apps.get("app:riffle:riffle.example.com")?.policyKeys,
    ).toEqual([]);
  });
});

describe("page and file logins (K-1004)", () => {
  const page: Resource = {
    id: "notes",
    kind: "page",
    name: "notes",
    addresses: [],
    status: "running",
    group: null,
    machine: null,
  };
  const withPage = (state: State, x: number): State => ({
    ...state,
    resources: new Map(state.resources).set(page.id, page),
    places: new Map(state.places).set(page.id, { x, y: 0 }),
  });
  const loginRules = (state: State) => {
    const access = desiredAccess(state, 0);
    return [...access.logins.login, ...access.logins.passkey].map((key) => access.policies.get(key)!);
  };

  it("lets in only the people of circles that can open an item, never everyone", () => {
    // Only the Owner circle holds the admin; Her holds nothing and "Everyone" holds the page.
    const state = withPage(start(), 760);
    expect(desiredAccess(state, 0).logins).toEqual({
      login: ["policy:owner:login"],
      passkey: ["policy:owner:login-passkey"],
    });
    for (const policy of loginRules(state)) {
      expect(policy.decision).toBe("allow");
      expect(policy.include).toEqual([{ email: { email: OWNER } }]);
    }
  });

  it("adds the people of a circle that holds a page, in a copy of its own", () => {
    const access = desiredAccess(withPage(start(), 450), 0);
    // Her holds no site, so her site policy is not wanted at all: a stuck login step never holds it.
    expect(access.policies.has("policy:her:people")).toBe(false);
    expect(access.logins.login).toEqual(["policy:owner:login", "policy:her:login"]);
    expect(access.policies.get("policy:her:login")?.include).toEqual([
      { email: { email: "her@example.com" } },
    ]);
  });

  it("asks for the passkey only on the passkey login", () => {
    const access = desiredAccess(withPage(start(), 450), 0);
    expect(access.logins.passkey).toEqual(["policy:owner:login-passkey"]);
    expect(access.policies.get("policy:owner:login-passkey")?.mfa_config).toBeDefined();
    expect(access.policies.get("policy:owner:login")?.mfa_config).toBeUndefined();
    expect(access.policies.get("policy:owner:login")?.include).toEqual([{ email: { email: OWNER } }]);
  });

  it("adds nothing for circles of only networks or devices, which need no login", () => {
    const state = withPage(start(), 450);
    const her = circle(state, "her");
    for (const members of [
      [{ _tag: "ip" as const, range: "10.0.0.0/8" }],
      [{ _tag: "device" as const, tokenId: "t1", clientId: "c1.access", name: "phone" }],
    ]) {
      const only = { ...state, circles: new Map(state.circles).set("her", { ...her, members }) };
      expect(desiredAccess(only, 0).logins.login).toEqual(["policy:owner:login"]);
    }
  });

  it("keeps an all circle exact and drops ended circles, ended shares and the pause", () => {
    const state = withPage(start(), 450);
    const her = circle(state, "her");
    const strict = {
      ...state,
      circles: new Map(state.circles).set("her", {
        ...her,
        match: "all" as const,
        members: [...her.members, { _tag: "ip" as const, range: "10.0.0.0/8" }],
      }),
    };
    expect(desiredAccess(strict, 0).logins.login).toEqual(["policy:owner:login", "policy:her:login"]);
    expect(desiredAccess(strict, 0).policies.get("policy:her:login")?.require).toEqual([
      { ip: { ip: "10.0.0.0/8" } },
    ]);
    const ended = { ...state, circles: new Map(state.circles).set("her", { ...her, endsAt: 1 }) };
    expect(desiredAccess(ended, 1).logins.login).toEqual(["policy:owner:login"]);
    const shareEnded = {
      ...state,
      shareSettings: new Map([[shareKey("notes", "her"), { level: null, endsAt: 1 }]]),
    };
    expect(desiredAccess(shareEnded, 1).logins.login).toEqual(["policy:owner:login"]);
    for (const mode of ["keep-public", "lockdown"] as const) {
      const { after } = edit(state, [{ _tag: "pause", after: mode }]);
      expect(desiredAccess(after, 0).logins).toEqual({
        login: ["policy:owner:login"],
        passkey: ["policy:owner:login-passkey"],
      });
    }
  });
});

describe("pause (K-1504)", () => {
  it("closes every share except the Owner circle's share of the admin", () => {
    const state = start();
    const { after } = edit(state, [{ _tag: "pause", after: "lockdown" }]);
    expect(ruleViolation(after)).toBeNull();
    const access = desiredAccess(after, 0);
    expect(access.apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual([]);
    expect(access.apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    const owner = { email: OWNER, clientId: null, ip: null };
    expect(visitorLevel(after, after.resources.get("riffle")!, owner, 0)).toBeNull();
    // K-212: a card end stops its shares at that time, before the alarm moves the card.
    const timed = { ...state, ends: new Map([["riffle", 10]]) };
    expect(visitorLevel(timed, timed.resources.get("riffle")!, owner, 9)).not.toBeNull();
    expect(visitorLevel(timed, timed.resources.get("riffle")!, owner, 10)).toBeNull();
    expect(visitorLevel(after, after.resources.get(ADMIN_RESOURCE_ID)!, owner, 0)).toBe("control");
  });

  it("stops owner devices during a pause and keeps refusing a public admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const device = { _tag: "device" as const, tokenId: "t1", clientId: "c1.access", name: "agent" };
    const withDevice = edit(state, [
      { _tag: "circle", id: OWNER_CIRCLE_ID, after: { ...owner, members: [...owner.members, device] } },
    ]);
    const paused = edit(withDevice.after, [{ _tag: "pause", after: "lockdown" }]).after;
    const admin = paused.resources.get(ADMIN_RESOURCE_ID)!;
    expect(visitorLevel(paused, admin, { email: null, clientId: "c1.access", ip: null }, 0)).toBeNull();
    expect(desiredAccess(paused, 0).apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual([
      "policy:owner:people",
    ]);
    const everyone = circle(paused, EVERYONE_CIRCLE_ID);
    const covering = edit(paused, [
      {
        _tag: "circle",
        id: EVERYONE_CIRCLE_ID,
        after: { ...everyone, level: "control", x: 0, y: 40, r: 100 },
      },
    ]);
    expect(ruleViolation(covering.after)).toMatch(/public/);
  });

  it("refuses a pause when only another circle guards the admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const moved = edit(state, [
      { _tag: "circle", id: "admins", after: { ...owner, id: "admins", name: "Admins", x: 2000, y: 2000 } },
      { _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } },
    ]);
    expect(ruleViolation(edit(moved.after, [{ _tag: "pause", after: "lockdown" }]).after)).toMatch(/pause/);
  });
});

describe("stacks (K-521, K-522)", () => {
  const stack = { id: "s1", name: "Sites", members: ["kitshn-admin", "riffle"] };
  it("refuses a stack of one card or of a missing card", () => {
    expect(() =>
      edit(start(), [{ _tag: "stack", id: "s1", after: { ...stack, members: ["riffle"] } }]),
    ).toThrow(/at least two/);
    expect(() =>
      edit(start(), [{ _tag: "stack", id: "s1", after: { ...stack, members: ["riffle", "gone"] } }]),
    ).toThrow(/No card/);
  });

  it("keeps a card in one stack, on the point of its stack, and undoes a stack in one step", () => {
    const point = { x: 0, y: 40 };
    const { changes, after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    expect(ruleViolation(after)).toBeNull();
    expect(
      ruleViolation(
        applyChanges(after, [{ _tag: "place", id: "riffle", before: point, after: { x: 9, y: 9 } }]),
      ),
    ).toMatch(/share one place/);
    const second = { id: "s2", name: "Other", members: ["riffle", "kitshn-admin"] };
    expect(
      ruleViolation(applyChanges(after, [{ _tag: "stack", id: "s2", before: null, after: second }])),
    ).toMatch(/two stacks/);
    expect(applyChanges(after, invert(changes)).stacks.size).toBe(0);
  });

  it("moves the whole stack when one of its cards moves, and lets a card leave in the same change", () => {
    const point = { x: 0, y: 40 };
    const { after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const moved = applyChanges(
      after,
      resolveEdits(after, [{ _tag: "place", id: "riffle", after: { x: 5, y: 5 } }]),
    );
    expect(moved.places.get("kitshn-admin")).toEqual({ x: 5, y: 5 });
    expect(ruleViolation(moved) ?? "").not.toMatch(/share one place/);
    const left = applyChanges(
      after,
      resolveEdits(after, [
        ...stacksWithout(after.stacks.values(), "riffle").map((change): Edit => ({
          _tag: "stack",
          ...change,
        })),
        { _tag: "place", id: "riffle", after: { x: 5, y: 5 } },
      ]),
    );
    expect(left.places.get("kitshn-admin")).toEqual(point);
    expect(left.stacks.size).toBe(0);
  });

  it("undoes an older move of a card that joined a stack since then, with its stack", () => {
    const first = edit(start(), [{ _tag: "place", id: "riffle", after: { x: 0, y: 40 } }]);
    const second = edit(first.after, [
      { _tag: "place", id: "kitshn-admin", after: { x: 0, y: 40 } },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const undone = applyChanges(second.after, withStackMates(second.after, invert(first.changes)));
    expect(ruleViolation(undone) ?? "").not.toMatch(/share one place/);
    expect(undone.places.get("kitshn-admin")).toEqual(undone.places.get("riffle"));
  });

  it("takes a card out of its stack when an undo sends it back to the tray", () => {
    const point = { x: 0, y: 40 };
    const first = edit(start(), [{ _tag: "place", id: "riffle", after: point }]);
    const second = edit(first.after, [
      { _tag: "place", id: "kitshn-admin", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const undone = applyChanges(
      second.after,
      withStackMates(second.after, [{ _tag: "place", id: "riffle", before: point, after: null }]),
    );
    expect(undone.places.get("kitshn-admin")).toEqual(point);
    expect(undone.stacks.size).toBe(0);
    expect(ruleViolation(undone) ?? "").not.toMatch(/stack/);
  });

  it("keeps the rules true when a stacked card is deleted outside an edit", () => {
    const point = { x: 0, y: 40 };
    const { after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const resources = new Map(after.resources);
    const places = new Map(after.places);
    resources.delete("riffle");
    places.delete("riffle");
    const stacks = new Map(after.stacks);
    for (const change of stacksWithout(after.stacks.values(), "riffle")) {
      if (change.after) stacks.set(change.id, change.after);
      else stacks.delete(change.id);
    }
    expect(stacks.size).toBe(0);
    expect(ruleViolation({ ...after, resources, places, stacks })).toBeNull();
  });
});

describe("emergency pause (K-1504)", () => {
  it("counts what a press closes and what stays open, also while paused", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const base = state.resources.get("riffle")!;
    const site = { ...base, id: "site", kind: "site.static" as const, addresses: [] };
    const box = { ...base, id: "box", kind: "machine" as const, addresses: [] };
    const at = { x: everyone.x, y: everyone.y };
    const open = {
      ...state,
      resources: new Map(state.resources).set("site", site).set("box", box),
      places: new Map(state.places).set("site", at).set("box", at),
    };
    const before = pauseReach(state, 0);
    const reach = pauseReach(open, 0);
    // The public site stays open unless it is a lockdown; the public machine closes in every pause.
    expect(reach).toEqual({
      closes: before.closes + 1,
      cards: before.cards + 1,
      keptPublic: before.keptPublic + 1,
    });
    expect(pauseReach(edit(open, [{ _tag: "pause", after: "lockdown" }]).after, 0)).toEqual(reach);
  });
  it("lets an edit or an undo pause, but never resume", () => {
    const paused = edit(start(), [{ _tag: "pause", after: "lockdown" }]);
    expect(refuseResume(paused.changes)).toEqual(paused.changes);
    expect(() => refuseResume(resolveEdits(paused.after, [{ _tag: "pause", after: null }]))).toThrow(
      /passkey/,
    );
    expect(() => refuseResume(invert(paused.changes))).toThrow(/passkey/);
  });
  it("keeps public sites open unless the pause is a lockdown", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const open = edit(state, [
      { _tag: "place", id: "riffle", after: { x: everyone.x, y: everyone.y } },
    ]).after;
    const stranger = { email: null, clientId: null, ip: null };
    const riffle = open.resources.get("riffle")!;
    for (const [mode, level] of [
      ["keep-public", "view"],
      ["lockdown", null],
    ] as const) {
      const paused = edit(open, [{ _tag: "pause", after: mode }]).after;
      expect(visitorLevel(paused, riffle, stranger, 0)).toBe(level);
      expect(desiredAccess(paused, 0).apps.get("app:riffle:riffle.example.com")?.policyKeys ?? []).toEqual(
        level === null ? [] : [`policy:${EVERYONE_CIRCLE_ID}:people`],
      );
    }
  });
  it("reads an old stored pause as a lockdown", () => {
    expect([null, "", "false", "true", "keep-public", "lockdown"].map(pauseModeOf)).toEqual([
      null,
      null,
      null,
      "lockdown",
      "keep-public",
      "lockdown",
    ]);
  });
  it("names the kind of each pause step in the history", () => {
    const state = start();
    const soft = edit(state, [{ _tag: "pause", after: "keep-public" }]);
    const hard = edit(soft.after, [{ _tag: "pause", after: "lockdown" }]);
    const direct = edit(state, [{ _tag: "pause", after: "lockdown" }]);
    expect(summarize(state, soft.after, soft.changes)).toMatch(/except public/);
    expect(summarize(soft.after, hard.after, hard.changes)).toMatch(/Closed public sites too/);
    expect(summarize(state, direct.after, direct.changes)).toMatch(/Paused all shares: lockdown/);
  });
  it("keeps public shares open in a pause only on sites, pages and files", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const base = state.resources.get("riffle")!;
    const kinds = Object.keys(RESOURCE_KINDS).filter(
      (kind) => kind !== "kitshn.admin",
    ) as Array<ResourceKind>;
    for (const kind of kinds) {
      const card = { ...base, id: "card", kind, addresses: [] };
      const open = {
        ...state,
        resources: new Map(state.resources).set("card", card),
        places: new Map(state.places).set("card", { x: everyone.x, y: everyone.y }),
      };
      const paused = edit(open, [{ _tag: "pause", after: "keep-public" }]).after;
      const kept = visitorLevel(paused, card, { email: null, clientId: null, ip: null }, 0) !== null;
      expect([kind, kept]).toEqual([kind, kind.startsWith("site.") || kind === "page" || kind === "file"]);
    }
  });
  it("closes a public machine card in every pause", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const machine = { ...state.resources.get("riffle")!, id: "box", kind: "machine" as const, addresses: [] };
    const open = {
      ...state,
      resources: new Map(state.resources).set("box", machine),
      places: new Map(state.places).set("box", { x: everyone.x, y: everyone.y }),
    };
    const paused = edit(open, [{ _tag: "pause", after: "keep-public" }]).after;
    expect(visitorLevel(paused, machine, { email: null, clientId: null, ip: null }, 0)).toBeNull();
  });
  it("closes public sites during a pause, but reopens them only through Resume", () => {
    const soft = edit(start(), [{ _tag: "pause", after: "keep-public" }]).after;
    const hard = edit(soft, [{ _tag: "pause", after: "lockdown" }]);
    expect(refuseResume(hard.changes)).toEqual(hard.changes);
    expect(() => refuseResume(invert(hard.changes))).toThrow(/passkey/);
  });
  it("lets access only go down while paused (MM-711)", () => {
    const paused = edit(start(), [{ _tag: "pause", after: "lockdown" }]).after;
    const owner = paused.circles.get("owner")!;
    const wider = edit(paused, [
      { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, { _tag: "everyone" }] } },
    ]).after;
    expect(() => refuseRaiseWhilePaused(paused, wider)).toThrow(/only goes down/);
    const narrower = edit(paused, [
      { _tag: "circle", id: "owner", after: { ...owner, needsPasskey: true } },
    ]).after;
    expect(() => refuseRaiseWhilePaused(paused, narrower)).not.toThrow();
    const allMatch = {
      ...owner,
      match: "all" as const,
      members: [...owner.members, { _tag: "ip" as const, range: "10.0.0.0/8" }],
    };
    const strict = { ...paused, circles: new Map(paused.circles).set("owner", allMatch) };
    const looser = {
      ...strict,
      circles: new Map(strict.circles).set("owner", { ...allMatch, members: owner.members }),
    };
    expect(() => refuseRaiseWhilePaused(strict, looser)).toThrow(/only goes down/);
    const ending = {
      ...paused,
      shareSettings: new Map([["kitshn-admin/owner", { level: null, endsAt: 5 }]]),
    };
    expect(() => refuseRaiseWhilePaused(ending, { ...ending, shareSettings: new Map() })).toThrow(
      /end later/,
    );
    // K-212: a card end that goes or moves later raises access; an earlier one lowers it.
    const timed = { ...paused, ends: new Map([["riffle", 5]]) };
    expect(() => refuseRaiseWhilePaused(timed, { ...timed, ends: new Map() })).toThrow(/end later/);
    expect(() => refuseRaiseWhilePaused(timed, { ...timed, ends: new Map([["riffle", 2]]) })).not.toThrow();
    // The expiry and End now take the end away with the card, to the tray, so they work during a pause.
    const placed = { ...timed, places: new Map(timed.places).set("riffle", { x: 0, y: -200 }) };
    const tray = {
      ...placed,
      ends: new Map(),
      places: new Map([...placed.places].filter(([id]) => id !== "riffle")),
    };
    expect(() => refuseRaiseWhilePaused(placed, tray)).not.toThrow();
    // K-718: an agent right that turns on raises access; one that turns off lowers it.
    const device = { _tag: "device" as const, tokenId: "t", clientId: "c", name: "Bot" };
    const withDevice = (member: typeof device & { publishes?: true }) => ({
      ...paused,
      circles: new Map(paused.circles).set("owner", { ...owner, members: [...owner.members, member] }),
    });
    expect(() =>
      refuseRaiseWhilePaused(withDevice(device), withDevice({ ...device, publishes: true })),
    ).toThrow(/only goes down/);
    expect(() =>
      refuseRaiseWhilePaused(withDevice({ ...device, publishes: true }), withDevice(device)),
    ).not.toThrow();
  });
});

describe("undo that follows intent (K-1505 to K-1507)", () => {
  const A = { _tag: "person", email: "a@example.com" } as const;
  const B = { _tag: "person", email: "b@example.com" } as const;
  const KITSHN = { _tag: "kitshn", reason: "live site report" } as const;
  /** The start state with a machine card "box" that waits in the tray. */
  const withTray = (): State => {
    const state = start();
    const box: Resource = { ...state.resources.get("riffle")!, id: "box", name: "box", kind: "machine" };
    return { ...state, resources: new Map([...state.resources, ["box", box]]) };
  };
  const move = (state: State, id: string, x: number, y: number) =>
    edit(state, [{ _tag: "place", id, after: { x, y } }]);

  /** A small History: each step is an actor and edits; returns the state and the stored revisions. */
  const history = (state: State, steps: ReadonlyArray<readonly [Actor, Array<Edit>]>) => {
    const revisions: Array<StoredRevision & { readonly changes: ReadonlyArray<Change> }> = [];
    for (const [actor, edits] of steps) {
      const step = edit(state, edits);
      revisions.push({
        id: revisions.length + 1,
        actor,
        summary: `step ${revisions.length + 1}`,
        changes: step.changes,
        undoes: null,
      });
      state = step.after;
    }
    return { state, revisions };
  };
  const her = circle(start(), "her");
  const place = (id: string, x: number, y: number): Edit => ({ _tag: "place", id, after: { x, y } });
  const herAs = (changes: Partial<Circle>): Edit => ({
    _tag: "circle",
    id: "her",
    after: { ...her, ...changes },
  });

  it("merges moves of the same card by the same actor into the drop, and undo sends the card to the tray", () => {
    const drop = move(withTray(), "box", 400, 0);
    const first = move(drop.after, "box", 420, 10);
    const merged = mergeMoves(
      { actor: A, at: 0, changes: drop.changes, undoes: null },
      A,
      60_000,
      first.changes,
    )!;
    expect(merged).toEqual([{ _tag: "place", id: "box", before: null, after: { x: 420, y: 10 } }]);
    const second = move(first.after, "box", 430, 10);
    const again = mergeMoves(
      { actor: A, at: 60_000, changes: merged, undoes: null },
      A,
      170_000,
      second.changes,
    )!;
    expect(again).toEqual([{ _tag: "place", id: "box", before: null, after: { x: 430, y: 10 } }]);
    const revisions = [{ id: 1, actor: A, summary: "Added box", changes: again, undoes: null }];
    const target = undoTarget(second.after, revisions, A, { revision: 1 });
    expect(applyChanges(second.after, invert(target.changes)).places.has("box")).toBe(false);
  });

  it("keeps moves apart for another actor, after the window, for another card and after a share change", () => {
    const drop = move(withTray(), "box", 400, 0);
    const previous = { actor: A, at: 0, changes: drop.changes, undoes: null };
    const later = move(drop.after, "box", 420, 10).changes;
    expect(mergeMoves(previous, B, 1, later)).toBeNull();
    expect(mergeMoves(previous, A, MOVE_MERGE_MS + 1, later)).toBeNull();
    expect(mergeMoves(previous, A, 1, move(drop.after, "riffle", 5, 5).changes)).toBeNull();
    expect(mergeMoves({ ...previous, undoes: 3 }, A, 1, later)).toBeNull();
    const share = edit(drop.after, [
      { _tag: "shareSetting", resourceId: "box", circleId: "her", after: { level: "view", endsAt: null } },
    ]);
    expect(mergeMoves({ ...previous, changes: share.changes }, A, 1, later)).toBeNull();
  });

  it("keeps the first summary for pure moves, and the net summary for a move that changes a share", () => {
    const drop = move(withTray(), "box", 0, -200);
    const nudge = move(drop.after, "box", 10, -200);
    const merged = mergeMoves({ actor: A, at: 0, changes: drop.changes, undoes: null }, A, 1, nudge.changes)!;
    const summary = mergedSummary(
      "Added the file box on the map",
      withTray(),
      drop.after,
      nudge.after,
      merged,
    );
    expect(summary).toBe("Added the file box on the map and moved it");
    expect(mergedSummary(summary, withTray(), drop.after, nudge.after, merged)).toBe(summary);
    expect(mergedSummary("Moved a card", withTray(), drop.after, nudge.after, merged)).toBe("Moved a card");
    const into = move(drop.after, "box", 400, 0);
    const shared = mergeMoves({ actor: A, at: 0, changes: drop.changes, undoes: null }, A, 1, into.changes)!;
    expect(mergedSummary("Added the file box on the map", withTray(), drop.after, into.after, shared)).toBe(
      summarize(withTray(), into.after, shared),
    );
  });

  it("undoes the caller's own newest change after an unrelated revision by kitshn", () => {
    const { state, revisions } = history(withTray(), [
      [A, [place("box", 1500, 1500)]],
      [KITSHN, [place("riffle", 400, 0)]],
    ]);
    expect(undoTarget(state, revisions, A, { revision: 1 }).revision).toBe(1);
  });

  it("refuses an older change of the caller, a change of someone else, and an undo or an undone revision", () => {
    const { state, revisions } = history(withTray(), [
      [A, [place("box", 1500, 1500)]],
      [A, [place("box", 1600, 1500)]],
      [B, [place("riffle", 2000, 2000)]],
    ]);
    expect(() => undoTarget(state, revisions, A, { revision: 1 })).toThrow(
      'Only your newest change can be undone: #2 "step 2".',
    );
    expect(() => undoTarget(state, revisions, A, { revision: 3 })).toThrow(/Only your newest change/);
    const withUndo = [
      ...revisions,
      { id: 4, actor: A, summary: "Undo #2", changes: invert(revisions[1]!.changes), undoes: 2 },
    ];
    expect(() => undoTarget(state, withUndo, A, { revision: 4 })).toThrow(/is an undo/);
    expect(() => undoTarget(state, withUndo, A, { revision: 2 })).toThrow(/undone already/);
    // An undo and the revision that it undid cancel out, so the change before them is the newest again.
    expect(undoTarget(state, withUndo, A, { revision: 1 }).revision).toBe(1);
  });

  // Each access leak that the reviews of the first models found ends in a refusal.
  it.each<[string, Array<Edit>, Array<Edit>, boolean?]>([
    ["another actor changed the circle of my card", [place("box", 400, 0)], [herAs({ level: "view" })]],
    ["a card enters a circle that my undo changes", [herAs({ level: "view" })], [place("box", 400, 0)]],
    ["remove a member, then a card enters, then undo", [herAs({ members: [] })], [place("box", 400, 0)]],
    ["shrink, then a card enters the freed area, then undo", [herAs({ r: 50 })], [place("box", 520, 0)]],
    ["move the circle away, then a card enters, then undo", [herAs({ x: 1400 })], [place("box", 400, 0)]],
    [
      "remove everyone, then a machine card enters, then undo",
      [herAs({ members: [] })],
      [place("box", 400, 0)],
      true,
    ],
    [
      "delete the circle, then a card enters its area, then undo",
      [{ _tag: "circle", id: "her", after: null }],
      [place("box", 400, 0)],
    ],
    [
      "unstack, then a card of the stack moves, then undo",
      [{ _tag: "stack", id: "s1", after: null }],
      [place("kitshn-admin", 30, 40)],
    ],
  ])("refuses when %s", (_, mine, theirs, everyone = false) => {
    const stacked = edit(withTray(), [
      place("riffle", 0, 40),
      { _tag: "stack", id: "s1", after: { id: "s1", name: "Pair", members: ["kitshn-admin", "riffle"] } },
    ]).after;
    const base = everyone ? edit(stacked, [herAs({ members: [{ _tag: "everyone" }] })]).after : stacked;
    const { state, revisions } = history(base, [
      [A, mine],
      [B, theirs],
    ]);
    expect(() => undoTarget(state, revisions, A, { revision: 1 })).toThrow(
      /#2 "step 2" changed the same cards or circles later/,
    );
  });

  it("undoes only the caller's newest change to one card, also when that revision moved several cards", () => {
    const { state, revisions } = history(withTray(), [
      [A, [place("box", 1500, 1500)]],
      [A, [place("box", 1600, 1600), place("riffle", 2000, 2000)]],
    ]);
    const target = undoTarget(state, revisions, A, { item: { kind: "card", id: "box" } });
    expect(target.revision).toBe(2);
    const back = applyChanges(state, invert(target.changes));
    expect(back.places.get("box")).toEqual({ x: 1500, y: 1500 });
    expect(back.places.get("riffle")).toEqual({ x: 2000, y: 2000 });
    expect(() => undoTarget(state, revisions, B, { item: { kind: "card", id: "box" } })).toThrow(
      /no change to this item/,
    );
  });

  it("takes back only the cards that sat inside a circle before its head drag", () => {
    const { state, revisions } = history(move(start(), "riffle", 400, 0).after, [
      [A, [herAs({ x: 600 }), place("riffle", 600, 0), place("kitshn-admin", 0, 60)]],
    ]);
    const target = undoTarget(state, revisions, A, { item: { kind: "circle", id: "her" } });
    expect(target.changes.map((change) => change.id).sort()).toEqual(["her", "riffle"]);
  });

  it("does not refuse my undo for an unrelated new card in the same circle", () => {
    const pr = { ...withTray().resources.get("box")!, id: "pr", name: "pr" };
    const base = { ...withTray(), resources: new Map([...withTray().resources, ["pr", pr]]) };
    const { state, revisions } = history(base, [
      [A, [place("riffle", 10, -200)]],
      [KITSHN, [place("pr", 0, 100)]],
    ]);
    expect(undoTarget(state, revisions, A, { revision: 1 }).revision).toBe(1);
  });

  it("refuses a per-item undo whose part the rest of its revision depends on, both ways", () => {
    const inHer = move(withTray(), "box", 400, 0).after;
    const { state, revisions } = history(inHer, [
      [A, [herAs({ members: [{ _tag: "everyone" }] }), place("box", 1500, 1500)]],
    ]);
    for (const item of [
      { kind: "card", id: "box" },
      { kind: "circle", id: "her" },
    ] as const)
      expect(() => undoTarget(state, revisions, A, { item })).toThrow(/undo the whole change instead/);
    expect(undoTarget(state, revisions, A, { revision: 1 }).revision).toBe(1);
  });

  it("refuses an undo for a card whose id was forgotten and made again, also from the tray", () => {
    const forget = (id: number): StoredRevision => ({
      id,
      actor: KITSHN,
      summary: "stopped exposing box",
      changes: [{ _tag: "forget", id: "box", before: null, after: null }],
      undoes: null,
    });
    const placed = history(withTray(), [[A, [place("box", 400, 0)]]]);
    // forgetCard deleted the card; the live site then came back with the same id, in the tray.
    const again = applyChanges(placed.state, [
      { _tag: "place", id: "box", before: { x: 400, y: 0 }, after: null },
    ]);
    expect(() => undoTarget(again, [...placed.revisions, forget(2)], A, { revision: 1 })).toThrow(
      /#2 "stopped exposing box"/,
    );
    const trayed = history(move(withTray(), "box", 400, 0).after, [
      [A, [{ _tag: "place", id: "box", after: null }]],
    ]);
    expect(() => undoTarget(trayed.state, [...trayed.revisions, forget(2)], A, { revision: 1 })).toThrow(
      /#2/,
    );
    expect(() => undoTarget(trayed.state, [forget(1)], KITSHN, { revision: 1 })).toThrow(/records an action/);
  });

  it("answers the menu's question with the same rule as the undo", () => {
    const { state, revisions } = history(withTray(), [
      [A, [place("box", 1500, 1500)]],
      [A, [herAs({ level: "view" })]],
      [B, [place("riffle", 400, 0)]],
    ]);
    expect(undoAnswer(state, revisions, A, { item: { kind: "card", id: "box" } }, 0)).toEqual({
      allowed: true,
    });
    expect(undoAnswer(state, revisions, A, { item: { kind: "circle", id: "her" } }, 0)).toEqual({
      allowed: false,
      reason:
        '#3 "step 3" changed the same cards or circles later, so this undo no longer fits. Change it by hand.',
    });
    expect(undoAnswer(state, revisions, B, { item: { kind: "card", id: "box" } }, 0)).toEqual({
      allowed: false,
      reason: "You have no change to this item left to undo.",
    });
    expect(undoAnswer(state, revisions, A, { revision: 2 }, 0)).toEqual({
      allowed: false,
      reason:
        '#3 "step 3" changed the same cards or circles later, so this undo no longer fits. Change it by hand.',
    });
  });

  it("runs every check of the undo itself when it answers the menu, and names what would become public", () => {
    const everyone = circle(start(), EVERYONE_CIRCLE_ID);
    const { state, revisions } = history(move(withTray(), "riffle", 560, 0).after, [
      [A, [{ _tag: "circle", id: EVERYONE_CIRCLE_ID, after: { ...everyone, r: 100 } }]],
    ]);
    const reason =
      "This undo would make riffle public in Everyone. An undo never does that without asking; share it by hand.";
    expect(() => prepareUndo(state, revisions[0]!.changes, 0)).toThrow(reason);
    expect(undoAnswer(state, revisions, A, { item: { kind: "circle", id: EVERYONE_CIRCLE_ID } }, 0)).toEqual({
      allowed: false,
      reason,
    });
  });
});

describe("History targets (K-1508)", () => {
  it("names the cards and circles of a revision once, and its kind", () => {
    expect(
      revisionTargets([
        { _tag: "place", id: "tick3d" },
        { _tag: "shareSetting", id: "tick3d/everyone" },
        { _tag: "circle", id: "everyone" },
      ]),
    ).toEqual({
      kind: "circle",
      items: [
        { kind: "card", id: "tick3d" },
        { kind: "circle", id: "everyone" },
      ],
    });
  });

  it("names the cards of a stack before and after the change", () => {
    expect(
      revisionTargets([
        {
          _tag: "stack",
          id: "s-1",
          members: [
            ["a", "b"],
            ["b", "c"],
          ],
        },
      ]).items,
    ).toEqual([
      { kind: "card", id: "a" },
      { kind: "card", id: "b" },
      { kind: "card", id: "c" },
    ]);
  });

  it("files a share that ends and takes its card out of a stack under shares", () => {
    expect(
      revisionTargets([
        { _tag: "shareSetting", id: "a/her" },
        {
          _tag: "stack",
          id: "s-1",
          members: [
            ["a", "b", "c"],
            ["b", "c"],
          ],
        },
      ]).kind,
    ).toBe("share");
  });

  it("calls a revision without changes an action", () => {
    expect(revisionTargets([{ _tag: "forget", id: "page-1" }])).toEqual({
      kind: "action",
      items: [{ kind: "card", id: "page-1" }],
    });
  });
});

describe("share summaries (K-1501, K-1508)", () => {
  it("names a new level of a share apart from a new share", () => {
    const state = start();
    const riffle = state.resources.get("riffle");
    const her = circle(state, "her");
    if (!riffle) throw new Error("The fixture has riffle.");
    expect(describeDiff({ resource: riffle, circle: her, from: null, to: "view" })).toBe(
      "riffle: + Her · view",
    );
    expect(describeDiff({ resource: riffle, circle: her, from: "view", to: "use" })).toBe(
      "riffle: Her · view → use",
    );
  });
});
