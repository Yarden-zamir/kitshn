import { describe, expect, it } from "vitest";
import { type ActorMigration, type LegacyCircle, migrateMembers } from "./actors.ts";
import { ruleViolation } from "./changes.ts";
import type { Machine } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  OWNER_CIRCLE_ID,
  type Circle,
  type Resource,
  type ShareSetting,
  type State,
  actorIdOf,
  machineActorId,
  shareKey,
} from "./model.ts";
import { agentMayCommand, cardsControlledBy, circlesOf, rightMode } from "./agent.ts";
import { OPERATIONS, decide } from "./operations.ts";
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
    // The admin sits in "friends" here, so Owner does not give it, and the devices circle gets no share of it.
    const migration = migrateMembers(legacy, machines, { x: 1000, y: 0 }, settings);
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
    const state = { ...stateOf(migration), places: new Map(places).set(admin.id, { x: 1000, y: 0 }) };
    const phoneVisitor: Visitor = { email: null, clientId: "phone.access", ip: null };
    const levels = (visitor: Visitor) =>
      [site, machineCard].map((each) => visitorLevel(state, each, visitor, 0));
    expect(levels(phoneVisitor)).toEqual(["view", "use"]);
    expect(visitorLevel(stateOf(migration), admin, phoneVisitor, 0)).toBeNull();
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

  it("keeps the admin of each token and machine that held it, with raises access automatic, and gives it to no other actor", () => {
    const owner = circle(
      "owner",
      0,
      [
        { _tag: "email", email: "yarden@example.com" },
        { _tag: "device", tokenId: "s-mac", clientId: "mac.access", name: "kitshn machine mac" },
        { _tag: "device", tokenId: "t-test", clientId: "test.access", name: "kitshn test agent" },
        phone,
      ],
      { needsPasskey: true },
    );
    // A circle without a passkey that also gives the admin keeps its token and machine members there.
    const ops = { _tag: "device", tokenId: "t-ops", clientId: "ops.access", name: "Ops" } as const;
    const admins = circle("admins", 0, [{ _tag: "machine", machineId: "vps" }, ops], { r: 50 });
    const migration = migrateMembers(
      [owner, admins, ...legacy.filter((each) => each.id !== "owner")],
      machines,
      { x: 0, y: 0 },
      settings,
    );
    const state = stateOf(migration);
    const automatic = { mode: "automatic" } as const;
    const holders = migration.circles.flatMap((each) =>
      each.members.flatMap((member) =>
        member._tag === "actor" && member.rights?.raisesAccess !== undefined
          ? [[each.name, member.actorId, member.rights.raisesAccess] as const]
          : [],
      ),
    );
    const testId = actorIdOf(token("t-test", "test.access", "kitshn test agent"));
    const botId = actorIdOf(token("t-bot", "bot.access", "Bot"));
    expect(holders).toEqual([
      ["admins", machineActorId("vps"), automatic],
      ["admins", actorIdOf(token("t-ops", "ops.access", "Ops")), automatic],
      ["Mac's devices", machineActorId("mac"), automatic],
      ["kitshn test agent's devices", testId, automatic],
      ["Yarden's phone's devices", phoneId, automatic],
    ]);
    for (const clientId of ["mac.access", "test.access", "phone.access", "vps.access", "ops.access"])
      expect(visitorLevel(state, admin, { email: null, clientId, ip: null }, 0)).toBe("control");
    // The agent key "Bot" in "agents" holds no admin there, so its key rights stay as before.
    expect(byId(migration.circles, "agents").members[0]).toEqual({
      _tag: "actor",
      actorId: botId,
      rights: keyRights({ publishes: true }),
    });
    expect(visitorLevel(state, admin, { email: null, clientId: "bot.access", ip: null }, 0)).toBeNull();
    for (const name of ["Mac", "kitshn test agent", "Yarden's phone", "VPS", "Ops"])
      expect(migration.notes.some((note) => note.startsWith(`${name} held the kitshn admin`))).toBe(true);
    expect(ruleViolation(state)).toBeNull();
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
          readsMap: { mode: "automatic" },
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
    const ranAtOnce = { maintains: { mode: "automatic" }, readsMap: { mode: "automatic" } };
    expect(byId(circles, "machines").members).toEqual([
      { _tag: "actor", actorId: machineActorId("vps"), rights: ranAtOnce },
      { _tag: "actor", actorId: machineActorId("mac"), rights: ranAtOnce },
    ]);
    expect(byId(circles, "agents").approvesWithoutPasskey).toBe(true);
    expect("machinesMayApprove" in byId(circles, "agents")).toBe(false);
  });

  it("keeps a circle of machines with no rights an agent circle, with the same control and machine care (K-1777)", () => {
    const win = machineOf("win", "windows 2");
    const all = new Map(machines).set("win", win);
    const winCard: Resource = { ...card("win", "machine"), machine: "win" };
    // Before migration 44, a circle of machines only was an agent circle of each machine, with no right set.
    const migration = migrateMembers(
      [
        circle("owner", 0, [{ _tag: "email", email: "yarden@example.com" }], { needsPasskey: true }),
        circle("machines", 3000, [
          { _tag: "machine", machineId: "win" },
          { _tag: "device", tokenId: "s-mac", clientId: "mac.access", name: "kitshn machine mac" },
        ]),
      ],
      all,
      { x: 0, y: 0 },
      new Map(),
    );
    const state: State = {
      ...stateOf(migration),
      machines: all,
      resources: new Map([admin, winCard].map((each) => [each.id, each])),
      places: new Map([
        [admin.id, { x: 0, y: 0 }],
        [winCard.id, { x: 3000, y: 0 }],
      ]),
      shareSettings: new Map(),
    };
    const macVisitor: Visitor = { email: null, clientId: "mac.access", ip: null };
    expect([...circlesOf(state, macVisitor, 0)]).toEqual(["machines"]);
    expect([...circlesOf(state, { email: null, clientId: "win.access", ip: null }, 0)]).toEqual(["machines"]);
    expect([...cardsControlledBy(state, macVisitor, 0)]).toEqual([winCard.id]);
    expect(agentMayCommand(state, macVisitor, "win", "restart", 0)).toBe(true);
    const restart = OPERATIONS["machine-restart"];
    const mode = rightMode(state, macVisitor, "maintains", 0, null);
    expect(mode).toEqual({ mode: "automatic" });
    expect(
      decide(
        restart,
        { admin: false, paused: false, mode, inAgentCircle: true, scope: true, approved: false },
        OWNER_CIRCLE_ID,
      ),
    ).toEqual({ outcome: "run" });
    expect(migration.notes.join(" ")).toContain("machines stays an agent circle");
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
