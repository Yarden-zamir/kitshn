import { describe, expect, it } from "vitest";
import { type LegacyRightsCircle, migrateRights } from "./effects.ts";
import { type Actor, OWNER_CIRCLE_ID } from "./model.ts";
import { actorOf, login, machineKey, token } from "./testkit.ts";

const vps = actorOf(machineKey("vps"), "VPS");
const oracle = actorOf(machineKey("oracle"), "Oracle VPS");
const phone = actorOf(token("t-phone", "phone.access", "Phone"));
const yarden = actorOf(login("yarden@example.com"));
const actors = new Map<string, Actor>([vps, oracle, phone, yarden].map((actor) => [actor.id, actor]));
const automatic = { mode: "automatic" } as const;
const owner = { mode: "ask", circleId: OWNER_CIRCLE_ID } as const;

const circle = (id: string, members: LegacyRightsCircle["members"]): LegacyRightsCircle => ({
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
});
const rightsOf = (
  circles: ReadonlyArray<{ readonly id: string; readonly members: ReadonlyArray<unknown> }>,
  id: string,
) => circles.find((each) => each.id === id)?.members[0];

describe("the move of rights to effects (K-1730, migration 46)", () => {
  it("takes the narrowest mode of the rights of one effect, with a note, so nothing widens", () => {
    // Today's Agents circle: VPS has ten rights automatic; "raises access" was unset, so it asked the Owner.
    const all = Object.fromEntries(
      (
        [
          "addsApps",
          "publishes",
          "deploys",
          "runsCommands",
          "readsCode",
          "writesCode",
          "addsAudiences",
          "getsPasses",
          "addsPages",
          "restores",
        ] as const
      ).map((right) => [right, automatic]),
    );
    const { circles, notes } = migrateRights(
      [circle("agents", [{ _tag: "actor", actorId: vps.id, rights: all }])],
      actors,
      () => true,
      0,
    );
    expect(rightsOf(circles, "agents")).toEqual({
      _tag: "actor",
      actorId: vps.id,
      rights: {
        reads: automatic,
        creates: automatic,
        changes: automatic,
        runs: automatic,
        destroys: automatic,
        shares: owner,
      },
    });
    expect(notes).toEqual([
      'VPS in agents: "shares" is ask owner, the narrowest of publishes (automatic), adds audiences (automatic), gets passes (automatic), raises access (ask owner, default).',
    ]);
  });

  it("takes off over automatic, and counts code rights only in a circle that holds a repo", () => {
    const rights = {
      addsApps: automatic,
      addsPages: { mode: "off" },
      readsCode: { mode: "off" },
      readsMap: automatic,
    } as const;
    const migrate = (holdsRepo: boolean) =>
      rightsOf(
        migrateRights(
          [circle("agents", [{ _tag: "actor", actorId: vps.id, rights }])],
          actors,
          () => holdsRepo,
          0,
        ).circles,
        "agents",
      );
    expect(migrate(false)).toEqual({
      _tag: "actor",
      actorId: vps.id,
      rights: { reads: automatic, creates: { mode: "off" } },
    });
    expect(migrate(true)).toEqual({
      _tag: "actor",
      actorId: vps.id,
      rights: { reads: { mode: "off" }, creates: { mode: "off" } },
    });
  });

  it("keeps machine care and reads of a circle of machines, and keeps adding cards at the Owner (agent-circle rule)", () => {
    const care = { maintains: automatic, readsMap: automatic } as const;
    const { circles } = migrateRights(
      [circle("machines", [{ _tag: "actor", actorId: oracle.id, rights: care }])],
      actors,
      () => false,
      0,
    );
    expect(rightsOf(circles, "machines")).toEqual({
      _tag: "actor",
      actorId: oracle.id,
      rights: { reads: automatic, maintains: automatic, creates: owner },
    });
  });

  it("gives a chip that acted as the owner shares and secrets automatic", () => {
    const { circles, notes } = migrateRights(
      [circle("phone-devices", [{ _tag: "actor", actorId: phone.id, rights: { raisesAccess: automatic } }])],
      actors,
      () => false,
      0,
    );
    expect(rightsOf(circles, "phone-devices")).toEqual({
      _tag: "actor",
      actorId: phone.id,
      rights: { creates: owner, shares: automatic, secrets: automatic },
    });
    expect(notes).toContain(
      'Phone in phone-devices acted as the owner, so "shares" and "secrets" are automatic.',
    );
  });

  it("keeps only off for a machine in a circle with a person, where its rights did not count before", () => {
    const { circles, notes } = migrateRights(
      [
        circle("mixed", [
          { _tag: "actor", actorId: yarden.id },
          { _tag: "actor", actorId: vps.id, rights: { deploys: automatic, runsCommands: { mode: "off" } } },
        ]),
      ],
      actors,
      () => false,
      0,
    );
    expect(circles[0]?.members[1]).toEqual({
      _tag: "actor",
      actorId: vps.id,
      rights: { runs: { mode: "off" } },
    });
    expect(notes.some((note) => note.startsWith("VPS in mixed: effects now count"))).toBe(true);
  });
});
