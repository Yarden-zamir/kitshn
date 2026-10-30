import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AGENTS_MIGRATION, MIGRATIONS, migrate } from "./migrations.ts";

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

describe("Durable Object migrations", () => {
  it("builds a new database to the newest version", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(migrate((query) => db.exec(query), 0)).toBe(MIGRATIONS.length);
    expect(columns(db, "tunnel_objects")).toEqual(["machine_id", "body", "error", "applied", "retry_at"]);
    expect(columns(db, "providers")).toEqual(["machine_id", "name", "body"]);
    expect(columns(db, "desired_state")).toEqual(["kind", "machine_id", "body"]);
    expect(columns(db, "jobs")).toContain("when_idle");
    // K-722: the code step of the t3.agents shares runs with the migration that makes the exec table, never earlier.
    expect(MIGRATIONS[AGENTS_MIGRATION - 1]?.join()).toContain("exec_runs");
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    });
  });

  it("moves a database from before the migrations forward and keeps its rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE tunnel_objects (machine_id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT)");
    db.exec(
      "CREATE TABLE dns_objects (address TEXT PRIMARY KEY, record_id TEXT NOT NULL, content TEXT NOT NULL, error TEXT)",
    );
    db.exec("CREATE TABLE route_objects (address TEXT PRIMARY KEY, route_id TEXT NOT NULL, error TEXT)");
    db.exec(`INSERT INTO tunnel_objects VALUES ('m1', '{"ok":1}', NULL), ('m2', '{"new":1}', 'failed')`);
    migrate((query) => db.exec(query), 0);
    expect(db.prepare("SELECT machine_id, applied FROM tunnel_objects ORDER BY machine_id").all()).toEqual([
      { machine_id: "m1", applied: '{"ok":1}' },
      { machine_id: "m2", applied: "" },
    ]);
  });

  it("runs nothing when the database is current, and refuses a newer one", () => {
    const run: Array<string> = [];
    expect(migrate((query) => run.push(query), MIGRATIONS.length)).toBe(MIGRATIONS.length);
    expect(run).toEqual([]);
    expect(() => migrate(() => undefined, MIGRATIONS.length + 1)).toThrow(/newer/);
  });
});
