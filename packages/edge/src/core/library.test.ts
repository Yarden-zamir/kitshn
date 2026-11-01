import { describe, expect, it } from "vitest";
import { type ContentVisitor, contentAccess, fileNameError, loginStep } from "./library.ts";
import type { Circle, Resource, State } from "./model.ts";
import { seed } from "./seed.ts";
import { actorOf, chip, login } from "./testkit.ts";

const OWNER = "owner@example.com";

function start(): State {
  const s = seed([OWNER], "kit.example.com");
  const page: Resource = {
    id: "p",
    kind: "page",
    name: "A page",
    addresses: ["pages.example.com/p"],
    status: "running",
    group: null,
    machine: null,
  };
  const friends: Circle = {
    ...s.circles[0]!,
    id: "friends",
    name: "Friends",
    members: [chip(login("friend@example.com"))],
    needsPasskey: false,
    x: 2000,
    y: 0,
    r: 100,
  };
  return {
    circles: new Map([...s.circles, friends].map((circle) => [circle.id, circle])),
    resources: new Map([...s.resources, page].map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
    actors: new Map([...s.actors, actorOf(login("friend@example.com"))].map((actor) => [actor.id, actor])),
  };
}

const anonymous: ContentVisitor = {
  email: null,
  clientId: null,
  ip: "203.0.113.9",
  passkey: false,
  issuedAt: null,
};
const person = (email: string, passkey = false): ContentVisitor => ({
  email,
  clientId: null,
  ip: null,
  passkey,
  issuedAt: 1,
});
const at = (state: State, x: number) => ({ ...state, places: new Map(state.places).set("p", { x, y: 0 }) });
const decide = (state: State, visitor: ContentVisitor) =>
  contentAccess(state, state.resources.get("p")!, visitor, 0);

describe("page and file access (K-1004)", () => {
  it("serves a page in Everyone with no login", () => {
    expect(decide(at(start(), 760), anonymous)).toBe("allow");
  });

  it("sends an anonymous visitor of a private or shared page to the login", () => {
    expect(decide(start(), anonymous)).toBe("login");
    expect(decide(at(start(), 2000), anonymous)).toBe("login");
  });

  it("lets a circle member in, and refuses a logged-in stranger", () => {
    const shared = at(start(), 2000);
    expect(decide(shared, person("friend@example.com"))).toBe("allow");
    expect(decide(shared, person("stranger@example.com"))).toBe("deny");
  });

  it("opens a private page for the admin only after the passkey login (K-103, K-1002)", () => {
    expect(decide(start(), person(OWNER))).toBe("passkey");
    expect(decide(start(), person(OWNER, true))).toBe("allow");
    expect(decide(start(), person("friend@example.com", true))).toBe("deny");
  });

  it('does not make an "all must match" circle with everyone public', () => {
    const state = at(start(), 2000);
    const friends = state.circles.get("friends")!;
    const strict: Circle = { ...friends, match: "all", members: [{ _tag: "everyone" }, ...friends.members] };
    const circles = new Map(state.circles).set("friends", strict);
    expect(decide({ ...state, circles }, anonymous)).toBe("login");
    expect(decide({ ...state, circles }, person("friend@example.com"))).toBe("allow");
  });

  it("lets in a network member of a passkey circle only as a login after the passkey step (K-1778)", () => {
    const state = at(start(), 2000);
    const friends = state.circles.get("friends")!;
    const office: Circle = {
      ...friends,
      needsPasskey: true,
      members: [{ _tag: "ip", range: "203.0.113.0/24" }],
    };
    const circles = new Map(state.circles).set("friends", office);
    expect(decide({ ...state, circles }, { ...anonymous, ip: "203.0.113.9" })).toBe("login");
    expect(decide({ ...state, circles }, { ...person("friend@example.com"), ip: "203.0.113.9" })).toBe(
      "passkey",
    );
  });

  it("asks the passkey during a pause also on a network of a passkey circle (K-1504)", () => {
    const state = { ...start(), paused: "lockdown" as const };
    const owner = state.circles.get("owner")!;
    const withOffice: Circle = {
      ...owner,
      members: [...owner.members, { _tag: "ip", range: "203.0.113.0/24" }],
    };
    const circles = new Map(state.circles).set("owner", withOffice);
    expect(decide({ ...state, circles }, { ...person("stranger@example.com"), ip: "203.0.113.9" })).toBe(
      "deny",
    );
  });

  it("keeps a public page open in a pause, but not in a lockdown (K-1504)", () => {
    expect(decide({ ...at(start(), 760), paused: "keep-public" }, anonymous)).toBe("allow");
    expect(decide({ ...at(start(), 760), paused: "lockdown" }, anonymous)).toBe("login");
  });

  it("lets only people through during a pause (K-1504)", () => {
    const paused = { ...at(start(), 2000), paused: "lockdown" as const };
    expect(decide(paused, person("friend@example.com"))).toBe("deny");
    expect(decide(paused, person(OWNER, true))).toBe("allow");
  });
});

describe("file names (K-1102)", () => {
  it("takes a normal name and refuses names that leave the path segment", () => {
    expect(fileNameError("report v2.pdf")).toBeNull();
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\nb"]) expect(fileNameError(name)).not.toBeNull();
  });
});

describe("the browser login chain (K-1004)", () => {
  it("goes page, login, passkey login, page, and never back to a step it just passed", () => {
    // An anonymous visitor goes to the login.
    expect(loginStep("login", null)).toBe("login");
    // Back from the login, a passkey circle needs the passkey login next.
    expect(loginStep("passkey", "login")).toBe("passkey");
    // Back from the passkey login with a login that kitshn reads: the page opens.
    expect(loginStep("allow", "passkey")).toBeNull();
    // Back from a step that kitshn still asks for: explain instead of a redirect loop.
    expect(loginStep("login", "login")).toBe("explain");
    expect(loginStep("passkey", "passkey")).toBe("explain");
    // A passkey token that kitshn cannot read must not send the visitor back to the plain login either.
    expect(loginStep("login", "passkey")).toBe("explain");
  });
});
