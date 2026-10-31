import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import { type Circle, type Member, type Resource, type State, shareKey } from "./model.ts";
import {
  SITE_RELAY_FRAME_BYTES,
  SITE_RELAY_WINDOW_BYTES,
  SiteRelayWindow,
  siteRelayDestination,
} from "./site-relay.ts";

const machine = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `${id}-token`,
  clientId: `${id}.access`,
  tunnelId: id,
});
const site: Resource = {
  id: "site",
  name: "proxy",
  kind: "site.live",
  machine: "mac",
  addresses: [],
  status: "running",
  group: null,
};
const circle = (members: ReadonlyArray<Member>, extra: Partial<Circle> = {}): Circle => ({
  id: "share",
  name: "share",
  color: "#000",
  level: "view",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 0,
  y: 0,
  r: 100,
  ...extra,
});
const vps: Member = { _tag: "machine", machineId: "vps" };
function world(group = circle([vps]), extra: Partial<State> = {}): State {
  return {
    circles: new Map([[group.id, group]]),
    resources: new Map([[site.id, site]]),
    places: new Map([[site.id, { x: 0, y: 0 }]]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(["mac", "vps", "other"].map((id) => [id, machine(id)])),
    ...extra,
  };
}

describe("live-site relay authorization", () => {
  it("reaches only the destination of a live-site card held in a circle for the source machine", () => {
    const state = world();
    expect(siteRelayDestination(state, "vps", "site", 0)).toBe("mac");
    expect(siteRelayDestination(state, "other", "site", 0)).toBeNull();
    // A device rule is a different identity, even if an inconsistent import gives it this machine's client id.
    const device: Member = {
      _tag: "device",
      tokenId: "device-token",
      clientId: machine("vps").clientId,
      name: "device",
    };
    expect(siteRelayDestination(world(circle([device])), "vps", "site", 0)).toBeNull();
    expect(siteRelayDestination(state, "unknown", "site", 0)).toBeNull();
    expect(siteRelayDestination(state, "mac", "site", 0)).toBeNull();
    expect(siteRelayDestination(state, "vps", "unknown", 0)).toBeNull();
    expect(siteRelayDestination({ ...state, places: new Map() }, "vps", "site", 0)).toBeNull();
  });

  it("closes on a pause, expiration, removal, or a changed destination", () => {
    const state = world();
    for (const paused of ["lockdown", "keep-public"] as const)
      expect(siteRelayDestination({ ...state, paused }, "vps", "site", 0)).toBeNull();
    expect(siteRelayDestination(world(circle([vps], { endsAt: 10 })), "vps", "site", 10)).toBeNull();
    expect(
      siteRelayDestination(
        world(circle([vps]), {
          shareSettings: new Map([[shareKey("site", "share"), { level: null, endsAt: 10 }]]),
        }),
        "vps",
        "site",
        10,
      ),
    ).toBeNull();
    expect(
      siteRelayDestination(world(circle([vps]), { ends: new Map([["site", 10]]) }), "vps", "site", 10),
    ).toBeNull();
    expect(
      siteRelayDestination({ ...state, machines: new Map([["vps", machine("vps")]]) }, "vps", "site", 0),
    ).toBeNull();
    const moved = { ...site, machine: "other" };
    expect(siteRelayDestination({ ...state, resources: new Map([[site.id, moved]]) }, "vps", "site", 0)).toBe(
      "other",
    );
    const wrongKind = { ...site, kind: "site.compose" as const };
    expect(
      siteRelayDestination({ ...state, resources: new Map([[site.id, wrongKind]]) }, "vps", "site", 0),
    ).toBeNull();
  });

  it("uses only enforceable circle policies, including all-of and public shares", () => {
    const everyone: Member = { _tag: "everyone" };
    const publicState = world(circle([everyone]));
    expect(siteRelayDestination(publicState, "vps", "site", 0)).toBe("mac");
    expect(siteRelayDestination({ ...publicState, paused: "keep-public" }, "vps", "site", 0)).toBeNull();
    expect(siteRelayDestination(world(circle([vps, everyone], { match: "all" })), "vps", "site", 0)).toBe(
      "mac",
    );
    expect(
      siteRelayDestination(
        world(circle([vps, { _tag: "machine", machineId: "other" }], { match: "all" })),
        "vps",
        "site",
        0,
      ),
    ).toBeNull();
    expect(
      siteRelayDestination(
        world(circle([vps, { _tag: "email", email: "owner@example.com" }], { match: "all" })),
        "vps",
        "site",
        0,
      ),
    ).toBeNull();
    // A duplicate source member makes both rules match, but the all-of policy cannot enforce two tokens.
    expect(siteRelayDestination(world(circle([vps, vps], { match: "all" })), "vps", "site", 0)).toBeNull();
  });
});

describe("live-site relay flow control", () => {
  it("bounds each direction and rejects oversized frames, duplicate credit, and invalid lengths", () => {
    const window = new SiteRelayWindow();
    expect(window.remaining()).toBe(SITE_RELAY_WINDOW_BYTES);
    expect(window.give(1)).toBe(false);
    for (const invalid of [0, -1, NaN, Infinity, 1.5, SITE_RELAY_FRAME_BYTES + 1])
      expect(window.take(invalid)).toBe(false);
    for (let n = 0; n < SITE_RELAY_WINDOW_BYTES / SITE_RELAY_FRAME_BYTES; n++)
      expect(window.take(SITE_RELAY_FRAME_BYTES)).toBe(true);
    expect(window.remaining()).toBe(0);
    expect(window.take(1)).toBe(false);
    expect(window.give(SITE_RELAY_FRAME_BYTES)).toBe(true);
    expect(window.take(SITE_RELAY_FRAME_BYTES)).toBe(true);
    for (const invalid of [0, -1, NaN, Infinity, 1.5, SITE_RELAY_WINDOW_BYTES + 1])
      expect(window.give(invalid)).toBe(false);
    expect(window.give(SITE_RELAY_WINDOW_BYTES)).toBe(true);
    expect(window.give(1)).toBe(false);
    expect(window.remaining()).toBe(SITE_RELAY_WINDOW_BYTES);
  });
});
