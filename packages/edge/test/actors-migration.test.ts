import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LegacyCircle } from "../src/core/actors.ts";
import { ruleViolation } from "../src/core/changes.ts";
import { type State, actorIdOf } from "../src/core/model.ts";
import { ACTORS_MIGRATION, EFFECTS_MIGRATION, MIGRATIONS } from "../src/worker/migrations.ts";

/** K-1778, H1: migration 44 on a stored database of migration 43. */

type Instance = {
  migrateSchema(): void;
  load(): void;
  undo(actor: unknown, revisionId: number, source: null): unknown;
  state: State;
};

const owner = (members: LegacyCircle["members"]): LegacyCircle => ({
  id: "owner",
  name: "Owner",
  color: "#6C5CE7",
  level: "control",
  members,
  match: "any",
  needsPasskey: true,
  endsAt: null,
  x: 0,
  y: 0,
  r: 360,
});
const phone = { _tag: "device", tokenId: "t-phone", clientId: "phone.access", name: "Phone" } as const;

/** Puts the install `name` back at migration 43 with this Owner circle, then runs the start migrations. */
/** Migrations 47 (K-823) and 48 (K-1302) come after both, so the tests take them away too. */
const dropLaterMigrations = (sql: SqlStorage) => {
  sql.exec("DROP TABLE deploy_instances");
  sql.exec("ALTER TABLE deploys DROP COLUMN compose");
  sql.exec("ALTER TABLE backups DROP COLUMN repository");
  for (const index of [
    "forward_nonces_at",
    "notifications_state",
    "library_previous",
    "library_added",
    "repos_first_seen",
  ])
    sql.exec(`DROP INDEX ${index}`);
};

const migrateFrom43 = (name: string, members: LegacyCircle["members"]) =>
  runInDurableObject(env.KITSHN.getByName(name), (object, durable) => {
    const instance = object as unknown as Instance;
    const sql = durable.storage.sql;
    const body = JSON.stringify(owner(members));
    // Migration 45 comes after it, so the test takes its column away too.
    sql.exec("DROP INDEX proposals_credential");
    sql.exec("ALTER TABLE proposals DROP COLUMN credential");
    sql.exec("DROP TABLE actors");
    sql.exec("DROP TABLE circles_before_actors");
    sql.exec("ALTER TABLE device_invites DROP COLUMN actor_id");
    sql.exec("DELETE FROM meta WHERE key = 'actors-undo-floor'");
    sql.exec("DELETE FROM circles WHERE id != 'owner'");
    sql.exec("UPDATE circles SET body = ? WHERE id = 'owner'", body);
    dropLaterMigrations(sql);
    sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(ACTORS_MIGRATION - 1));
    let error: unknown = null;
    try {
      instance.migrateSchema();
    } catch (thrown) {
      error = thrown;
    }
    // After a rollback the tables of migration 44 are gone, so only a done migration loads the map.
    if (error === null) instance.load();
    const tables = sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name);
    return {
      error: error === null ? null : String(error),
      version: sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value,
      before: tables.includes("circles_before_actors")
        ? sql.exec<{ body: string }>("SELECT body FROM circles_before_actors WHERE id = 'owner'").one().body
        : null,
      owner: sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'owner'").one().body,
      circles: error === null ? [...instance.state.circles.values()].map((circle) => circle.name) : [],
      devices:
        error === null
          ? [...instance.state.circles.values()].find((circle) => circle.name.endsWith("'s devices"))?.members
          : undefined,
      violation: error === null ? ruleViolation(instance.state) : null,
      undo: (() => {
        if (error !== null) return null;
        const floor = Number(
          sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'actors-undo-floor'").one().value,
        );
        try {
          instance.undo({ _tag: "person", email: "owner@example.com" }, floor, null);
          return "undone";
        } catch (thrown) {
          return String(thrown);
        }
      })(),
      body,
    };
  });

describe("migration 44 on a database of migration 43 (K-1778)", () => {
  it("moves the stored members to actors, keeps the bodies of before, and leaves a map that keeps every rule", async () => {
    const after = await migrateFrom43("m44-good", [{ _tag: "email", email: "owner@example.com" }, phone]);
    expect(after.error).toBeNull();
    expect(after.version).toBe(String(MIGRATIONS.length));
    expect(after.before).toBe(after.body);
    expect(JSON.parse(after.owner).members).toEqual([
      { _tag: "actor", actorId: actorIdOf({ _tag: "login", email: "owner@example.com" }) },
    ]);
    // M1: the devices circle holds only the token, so the login opens nothing new there without a passkey. The token
    // held the admin through Owner, so migration 46 gives it "shares" and "secrets" automatic (K-1730).
    expect(after.circles).toContain("Phone's devices");
    expect(after.devices).toEqual([
      {
        _tag: "actor",
        actorId: actorIdOf({ ...phone, _tag: "token" }),
        rights: {
          creates: { mode: "ask", circleId: "owner" },
          shares: { mode: "automatic" },
          secrets: { mode: "automatic" },
        },
      },
    ]);
    expect(after.violation).toBeNull();
    // L2: the refusal of an Undo from before it names the migration.
    expect(after.undo).toMatch(/before migration 44/);
  });

  it("throws on a map that breaks a rule after it, and the database stays at migration 43", async () => {
    // A token alone holds the admin: after the passkey line no person does (K-105).
    const after = await migrateFrom43("m44-bad", [phone]);
    expect(after.error).toMatch(/Migration 44 .* breaks a rule/);
    expect(after.version).toBe(String(ACTORS_MIGRATION - 1));
    expect(after.before).toBeNull();
    expect(after.owner).toBe(after.body);
  });
});

/** K-1730: puts the install `name` back at migration 45 with three jobs, then runs the start migrations. */
const migrateFrom45 = (name: string, broken: boolean) =>
  runInDurableObject(env.KITSHN.getByName(name), (object, durable) => {
    const sql = durable.storage.sql;
    const visitor = { email: null, clientId: "vps.access", ip: null };
    const approval = { machineId: "vps", key: "f 0", right: "runsCommands", person: true };
    const job = (id: number, state: string, stored: object) =>
      sql.exec(
        `INSERT OR REPLACE INTO jobs (id, machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, when_idle)
         VALUES (?, 'vps', '[]', '{"kind":"restart"}', ?, 0, ?, '{"_tag":"machine","machineId":"vps","name":"vps"}', ?, NULL, '', 0)`,
        id,
        state,
        Date.now() + 60_000,
        JSON.stringify(stored),
      );
    job(1, "queued", { ...visitor, ownerApproved: approval });
    job(2, "queued", visitor);
    job(3, "sent", { ...visitor, ownerApproved: approval });
    // A circle body that does not parse makes the code step throw.
    if (broken) sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES ('broken', 'not json')");
    dropLaterMigrations(sql);
    sql.exec("UPDATE meta SET value = ? WHERE key = 'schema_version'", String(EFFECTS_MIGRATION - 1));
    let error: unknown = null;
    try {
      (object as unknown as Instance).migrateSchema();
    } catch (thrown) {
      error = thrown;
    }
    return {
      error: error === null ? null : String(error),
      version: sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value,
      jobs: sql
        .exec<{ id: number; state: string; output: string }>("SELECT id, state, output FROM jobs ORDER BY id")
        .toArray(),
    };
  });

describe("migration 46 on a database of migration 45 (K-1730)", () => {
  it("fails each queued job that carries a stored approval, because its right names are of before", async () => {
    const after = await migrateFrom45("m46-jobs", false);
    expect(after.error).toBeNull();
    expect(after.version).toBe(String(MIGRATIONS.length));
    expect(after.jobs).toEqual([
      { id: 1, state: "failed", output: "kitshn moved to effects; send the job again (K-1730)" },
      { id: 2, state: "queued", output: "" },
      { id: 3, state: "sent", output: "" },
    ]);
  });

  it("rolls back when its code step throws, so the database stays at migration 45", async () => {
    const after = await migrateFrom45("m46-broken", true);
    expect(after.error).not.toBeNull();
    expect(after.version).toBe(String(EFFECTS_MIGRATION - 1));
    expect(after.jobs.map((row) => row.state)).toEqual(["queued", "queued", "sent"]);
  });
});
