import { describe, expect, it } from "vitest";
import { type LegacyCircle, migrateMembers } from "./actors.ts";
import type { Machine } from "./machine.ts";
import { type Circle, actorIdOf, machineActorId } from "./model.ts";
import { keyRights, login, machineKey, token } from "./testkit.ts";

const vps: Machine = {
  id: "vps",
  name: "VPS",
  labels: [],
  order: 0,
  serviceTokenId: "s",
  clientId: "vps.access",
  tunnelId: "t",
};

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

/** The Owner circle holds the admin at (0, 0); the others sit apart from it. */
const migrated = () =>
  migrateMembers(
    [
      circle("owner", 0, [{ _tag: "email", email: "Yarden@example.com" }, phone], { needsPasskey: true }),
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
              readsCode: { mode: "ask", circleId: "owner", conditions },
              restores: { mode: "off" },
            },
          },
        ],
        { machinesMayApprove: true },
      ),
    ],
    new Map([["vps", vps]]),
    { x: 0, y: 0 },
  );

const byId = (circles: ReadonlyArray<Circle>, id: string) => circles.find((each) => each.id === id)!;

describe("the migration of members into actors (K-1778, migration 44)", () => {
  it("makes one person per email and adds the phone of the owner to that person, so no circle changes whom it lets in", () => {
    const { actors, circles } = migrated();
    const yarden = actors.find((actor) => actor.id === actorIdOf(login("yarden@example.com")))!;
    expect(yarden.credentials).toEqual([
      login("yarden@example.com"),
      token("t-phone", "phone.access", "Yarden's phone"),
    ]);
    expect(byId(circles, "owner").members).toEqual([{ _tag: "actor", actorId: yarden.id }]);
    expect(byId(circles, "friends").members).toEqual([
      { _tag: "actor", actorId: yarden.id },
      { _tag: "domain", domain: "qlik.com" },
    ]);
  });

  it("keeps a token of its own when no one person shares every circle of it", () => {
    const { actors, circles } = migrateMembers(
      [
        circle("a", 1000, [{ _tag: "email", email: "a@example.com" }, phone]),
        circle("b", 2000, [{ _tag: "email", email: "b@example.com" }, phone]),
      ],
      new Map(),
      null,
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

  it("moves the rights with conditions of a machine to one agent actor, and the machine keeps the others (break 5)", () => {
    const { actors, circles } = migrated();
    const agentId = actorIdOf(machineKey("vps"), conditions);
    expect(actors.find((actor) => actor.id === agentId)).toEqual({
      id: agentId,
      name: "VPS reads code, writes code",
      credentials: [machineKey("vps")],
      conditions,
    });
    expect(byId(circles, "agents").members.slice(1)).toEqual([
      {
        _tag: "actor",
        actorId: machineActorId("vps"),
        rights: { deploys: { mode: "automatic" }, restores: { mode: "off" } },
      },
      {
        _tag: "actor",
        actorId: agentId,
        rights: { readsCode: { mode: "ask", circleId: "owner" }, writesCode: { mode: "automatic" } },
      },
    ]);
  });

  it("gives every joined machine its actor, and renames machines may approve", () => {
    const { actors, circles } = migrated();
    expect(actors.find((actor) => actor.id === machineActorId("vps"))?.name).toBe("VPS");
    expect(byId(circles, "agents").approvesWithoutPasskey).toBe(true);
    expect("machinesMayApprove" in byId(circles, "agents")).toBe(false);
  });
});
