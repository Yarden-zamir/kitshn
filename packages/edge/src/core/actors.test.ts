import { describe, expect, it } from "vitest";
import { type ActorMigration, type LegacyCircle, migrateMembers } from "./actors.ts";
import { ruleViolation } from "./changes.ts";
import type { Machine } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Resource,
  type ShareSetting,
  type State,
  actorIdOf,
  machineActorId,
  shareKey,
} from "./model.ts";
import { grantsOf } from "./providers.ts";
import { keyRights, login, machineKey, token } from "./testkit.ts";
import { type Visitor, visitorLevel } from "./visitor.ts";

const machineOf = (id: string, name: string): Machine => ({
  id,
  name,
  labels: [],
  order: 0,
  serviceTokenId: `s-${id}`,
  clientId: `${id}.access`,
  tunnelId: `t-${id}`,
});
const vps = machineOf("vps", "VPS");
const mac = machineOf("mac", "Mac");
const machines = new Map([
  ["vps", vps],
  ["mac", mac],
]);

const circle = (
  id: string,
  x: number,
  members: LegacyCircle["members"],
  extra: Partial<LegacyCircle> = {},
): LegacyCircle => ({
  id,
  name: id,
  color: "#000000",
  level: "control",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 0,
  r: 100,
  ...extra,
});

const phone = {
  _tag: "device",
  tokenId: "t-phone",
  clientId: "phone.access",
  name: "Yarden's phone",
} as const;
const bot = {
  _tag: "device",
  tokenId: "t-bot",
  clientId: "bot.access",
  name: "Bot",
  publishes: true,
} as const;
const conditions = [{ key: "t3.project.name", values: ["kitshn"] }];

const card = (id: string, kind: Resource["kind"]): Resource => ({
  id,
  kind,
  name: id,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});
const admin = card(ADMIN_RESOURCE_ID, "kitshn.admin");
const site = card("site", "site.static");
const machineCard = card("mac-card", "machine");
const strictSite = card("strict-site", "site.static");
const places = new Map([
  [admin.id, { x: 0, y: 0 }],
  [site.id, { x: 20, y: 0 }],
  [machineCard.id, { x: 40, y: 0 }],
  [strictSite.id, { x: 4000, y: 0 }],
]);
/** The Owner circle gives the machine card at "use" only. */
const settings = new Map<string, ShareSetting>([
  [shareKey(machineCard.id, "owner"), { level: "use", endsAt: null }],
]);

/** The Owner circle holds the admin at (0, 0); the others sit apart from it. */
const legacy: ReadonlyArray<LegacyCircle> = [
  circle("owner", 0, [{ _tag: "email", email: "Yarden@example.com" }, phone], { needsPasskey: true }),
  circle("everyone", 500, [{ _tag: "everyone" }], { level: "view" }),
  circle("friends", 1000, [
    { _tag: "email", email: "yarden@example.com" },
    phone,
    { _tag: "domain", domain: "qlik.com" },
  ]),
  circle(
    "agents",
    2000,
    [
      bot,
      {
        _tag: "machine",
        machineId: "vps",
        rights: {
          deploys: { mode: "automatic" },
          writesCode: { mode: "automatic", conditions },
          maintains: { mode: "automatic", conditions },
          readsCode: { mode: "ask", circleId: "owner", conditions },
          restores: { mode: "off" },
        },
      },
    ],
    { machinesMayApprove: true },
  ),
  circle("machines", 3000, [
    { _tag: "machine", machineId: "vps" },
    { _tag: "device", tokenId: "s-mac", clientId: "mac.access", name: "kitshn machine mac" },
    { _tag: "machine", machineId: "mac" },
  ]),
  circle(
    "strict",
    4000,
    [
      { _tag: "email", email: "yarden@example.com" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ],
    { match: "all", level: "view" },
  ),
];

const migrated = () => migrateMembers(legacy, machines, { x: 0, y: 0 }, settings);

const stateOf = (migration: ActorMigration): State => ({
  circles: new Map(migration.circles.map((each) => [each.id, each])),
  resources: new Map([admin, site, machineCard, strictSite].map((each) => [each.id, each])),
  places,
  shareSettings: new Map([...settings, ...migration.shareSettings]),
  ends: new Map(),
  stacks: new Map(),
  paused: null,
  machines,
  actors: new Map(migration.actors.map((actor) => [actor.id, actor])),
});

const byId = (circles: ReadonlyArray<Circle>, id: string) => circles.find((each) => each.id === id)!;
const yardenId = actorIdOf(login("yarden@example.com"));
const phoneId = actorIdOf(token("t-phone", "phone.access", "Yarden's phone"));

describe("the migration of members into actors (K-1778, migration 44)", () => {
  it("makes one person per email and adds a token to the one person of all its circles", () => {
    const { actors, circles } = migrateMembers(
      [
        circle("a", 1000, [{ _tag: "email", email: "a@example.com" }, phone]),
        circle("b", 2000, [{ _tag: "email", email: "A@example.com" }, phone]),
      ],
      new Map(),
      null,
      new Map(),
    );
    const a = actorIdOf(login("a@example.com"));
    expect(actors.find((actor) => actor.id === a)?.credentials).toEqual([
      login("a@example.com"),
      token("t-phone", "phone.access", "Yarden's phone"),
    ]);
    expect(byId(circles, "b").members).toEqual([{ _tag: "actor", actorId: a }]);
    expect(byId(migrated().circles, "everyone").members).toEqual([{ _tag: "everyone" }]);
  });

  it("keeps a token in a passkey circle as its own actor, with a chip in its other circles", () => {
    const { actors, circles } = migrated();
    expect(actors.find((actor) => actor.id === yardenId)?.credentials).toEqual([login("yarden@example.com")]);
    expect(byId(circles, "owner").members).toEqual([{ _tag: "actor", actorId: yardenId }]);
    expect(byId(circles, "friends").members).toEqual([
      { _tag: "actor", actorId: yardenId },
      { _tag: "actor", actorId: phoneId },
      { _tag: "domain", domain: "qlik.com" },
    ]);
  });

  it("keeps every card of a passkey circle for its token in a devices circle, except the admin (H2)", () => {
    const migration = migrated();
    const devices = migration.circles.find((each) => each.name === "Yarden's phone's devices")!;
    expect(devices).toMatchObject({
      members: [{ _tag: "actor", actorId: phoneId }],
      needsPasskey: false,
      level: "control",
      x: 0,
      y: 0,
      r: 100,
    });
    expect(migration.notes.join(" ")).toContain(devices.name);
    const state = stateOf(migration);
    const phoneVisitor: Visitor = { email: null, clientId: "phone.access", ip: null };
    const levels = (visitor: Visitor) =>
      [admin, site, machineCard].map((each) => visitorLevel(state, each, visitor, 0));
    expect(levels(phoneVisitor)).toEqual([null, "view", "use"]);
    // M1: Access asks the login for a passkey in Owner, so without one it opens only circles that need no passkey.
    const withoutPasskey = stateOf({
      ...migration,
      circles: migration.circles.filter((each) => !each.needsPasskey),
    });
    expect(
      [admin, site, machineCard].map((each) =>
        visitorLevel(withoutPasskey, each, { email: "yarden@example.com", clientId: null, ip: null }, 0),
      ),
    ).toEqual([null, null, null]);
  });

  it("keeps a token of its own when no one person shares every circle of it", () => {
    const { actors, circles } = migrateMembers(
      [
        circle("a", 1000, [{ _tag: "email", email: "a@example.com" }, phone]),
        circle("b", 2000, [{ _tag: "email", email: "b@example.com" }, phone]),
      ],
      new Map(),
      null,
      new Map(),
    );
    const own = actorIdOf(token("t-phone", "phone.access", "Yarden's phone"));
    expect(actors.map((actor) => actor.id)).toContain(own);
    expect(byId(circles, "b").members).toEqual([
      { _tag: "actor", actorId: actorIdOf(login("b@example.com")) },
      { _tag: "actor", actorId: own },
    ]);
  });

  it("turns an agent key into a token actor whose flags run at once and whose other rights stay off (K-1732)", () => {
    const { circles } = migrated();
    expect(byId(circles, "agents").members[0]).toEqual({
      _tag: "actor",
      actorId: actorIdOf(token("t-bot", "bot.access", "Bot")),
      rights: keyRights({ publishes: true }),
    });
  });

  it("moves the rights with conditions to an agent actor, and the machine chip asks the Owner for them (M1)", () => {
    const { actors, circles } = migrated();
    const agentId = actorIdOf(machineKey("vps"), conditions);
    expect(actors.find((actor) => actor.id === agentId)).toEqual({
      id: agentId,
      name: "VPS reads code, writes code, maintains",
      credentials: [machineKey("vps")],
      conditions,
    });
    const ask = { mode: "ask", circleId: "owner" } as const;
    expect(byId(circles, "agents").members.slice(1)).toEqual([
      {
        _tag: "actor",
        actorId: machineActorId("vps"),
        rights: {
          deploys: { mode: "automatic" },
          writesCode: ask,
          readsCode: ask,
          restores: { mode: "off" },
          maintains: ask,
        },
      },
      {
        _tag: "actor",
        actorId: agentId,
        rights: { readsCode: ask, writesCode: { mode: "automatic" }, maintains: { mode: "automatic" } },
      },
    ]);
  });

  it("gives every joined machine one actor, also in two circles and as its token (K-107), and renames machines may approve", () => {
    const { actors, circles } = migrated();
    expect(actors.filter((actor) => actor.id === machineActorId("vps")).map((actor) => actor.name)).toEqual([
      "VPS",
    ]);
    expect(byId(circles, "machines").members).toEqual([
      { _tag: "actor", actorId: machineActorId("vps") },
      { _tag: "actor", actorId: machineActorId("mac") },
    ]);
    expect(byId(circles, "agents").approvesWithoutPasskey).toBe(true);
    expect("machinesMayApprove" in byId(circles, "agents")).toBe(false);
  });

  it("grants an all-must-match circle of a person with a token by the login alone (M2)", () => {
    const strict = byId(migrated().circles, "strict");
    expect(grantsOf(stateOf(migrated()), strictSite, 0).map((grant) => grant.circle)).toEqual([
      expect.objectContaining({
        id: strict.id,
        rules: [{ email: "yarden@example.com" }, { ip: "10.0.0.0/8" }],
      }),
    ]);
  });

  it("leaves a map that keeps every rule (H1)", () => {
    expect(ruleViolation(stateOf(migrated()))).toBeNull();
  });

  it("keeps a chip of after the migration and throws on a member it does not know (M3)", () => {
    const chip = { _tag: "actor", actorId: yardenId } as const;
    const run = (members: LegacyCircle["members"]) =>
      migrateMembers([circle("a", 1000, members)], new Map(), null, new Map()).circles[0]?.members;
    expect(run([chip])).toEqual([chip]);
    expect(() => run([{ _tag: "group", name: "x" } as unknown as LegacyCircle["members"][number]])).toThrow(
      /does not know the member/,
    );
  });
});
