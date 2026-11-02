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
    // K-722: migration 42 makes the exec table; an import from before it runs the t3.agents step again.
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

  it("keeps one row of deploy facts per card, from the rows of before and from each later write (K-1302)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    migrate((query) => db.exec(query), 0, 48);
    const insert = db.prepare(
      `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, kind, sha, state, expires_at,
         reason) VALUES (?, 'o/r', ?, ?, ?, 'a.example.com', 's', ?, 'abc', ?, 0, ?)`,
    );
    insert.run("a1", null, "prod", "a", "deploy", "failed", "no build");
    insert.run("a2", "r1", "prod", "a", "deploy", "done", null);
    // K-1623: a handover moves the card to another repo, which then deploys it too.
    insert.run("h1", "r1", "prod", "h", "deploy", "done", null);
    insert.run("h2", "r2", "prod", "h", "deploy", "running", null);
    insert.run("t1", "r1", "prod", "t", "teardown", "done", null);
    migrate((query) => db.exec(query), 48);
    insert.run("p1", null, "pr-12", "p", "deploy", "planned", null);
    const before = db.prepare("SELECT deployed, preview FROM deploy_cards WHERE resource_id = 'p'").get();
    db.exec("UPDATE deploys SET state = 'done' WHERE id = 'p1'");
    insert.run("a3", "r1", "prod", "a", "deploy", "failed", "the build failed");
    db.exec("UPDATE deploys SET state = 'done' WHERE id = 'h2'");
    db.exec("UPDATE deploys SET state = 'skipped' WHERE id = 'a2'");
    expect(before).toEqual({ deployed: 0, preview: null });
    expect(db.prepare("SELECT * FROM deploy_cards ORDER BY rowid").all()).toEqual([
      {
        resource_id: "a",
        newest_id: "a3",
        newest_state: "failed",
        newest_reason: "the build failed",
        deployed: 1,
        preview: null,
        repo_ids: '["r1"]',
      },
      {
        resource_id: "h",
        newest_id: "h2",
        newest_state: "done",
        newest_reason: null,
        deployed: 1,
        preview: null,
        repo_ids: '["r1","r2"]',
      },
      {
        resource_id: "p",
        newest_id: "p1",
        newest_state: "done",
        newest_reason: null,
        deployed: 1,
        preview: "pr-12",
        repo_ids: "[]",
      },
    ]);
  });

  it("runs nothing when the database is current, and refuses a newer one", () => {
    const run: Array<string> = [];
    expect(migrate((query) => run.push(query), MIGRATIONS.length)).toBe(MIGRATIONS.length);
    expect(run).toEqual([]);
    expect(() => migrate(() => undefined, MIGRATIONS.length + 1)).toThrow(/newer/);
  });
});
