import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { REPLACED, dropLiveSite, failQueuedDowns, removalDown, requeueDowns } from "./downs.ts";
import { migrate } from "./migrations.ts";

function jobs() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate((query) => db.exec(query), 0);
  const sql = (query: string, ...bindings: Array<string | number | null>) =>
    db.prepare(query).all(...bindings);
  const add = (command: object, state: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
           VALUES ('m1', '[]', ?, ?, 0, 0, '{}', '{}', '') RETURNING id`,
        )
        .get(JSON.stringify(command), state)?.["id"],
    );
  const state = (id: number) => db.prepare("SELECT state, output FROM jobs WHERE id = ?").get(id);
  return { db, sql, add, state };
}

const down = { kind: "compose-down", project: "app", name: "app", removeData: false };
const redeploy = { kind: "compose-redeploy", project: "app" };

describe("removal downs (K-909)", () => {
  it("an undo replaces a queued stop, and the restart runs after it", () => {
    const { sql, add, state } = jobs();
    const stop = add(down, "queued");
    failQueuedDowns(sql, "app", "undone");
    const start = add(redeploy, "queued");
    expect(state(stop)).toEqual({ state: "failed", output: "undone" });
    expect(state(start)).toMatchObject({ state: "queued" });
    expect(removalDown(sql, "app")).toEqual({ id: stop, state: "failed" });
  });

  it("a newer deploy wins over a stop that waits or that the machine had when it went offline", () => {
    const { sql, add, state } = jobs();
    const waiting = add(down, "queued");
    const sent = add(down, "sent");
    failQueuedDowns(sql, "app", REPLACED);
    add({ kind: "compose", project: "app" }, "queued");
    requeueDowns(sql, "m1");
    expect(state(waiting)).toEqual({ state: "failed", output: REPLACED });
    expect(state(sent)).toEqual({ state: "failed", output: REPLACED });
  });

  it("a deploy on one machine keeps the stop of a dropped instance on another (K-825)", () => {
    const { db, sql, add, state } = jobs();
    const here = add(down, "queued");
    const elsewhere = add(down, "queued");
    db.prepare("UPDATE jobs SET machine_id = 'm2' WHERE id = ?").run(elsewhere);
    failQueuedDowns(sql, "app", REPLACED, "m1");
    expect(state(here)).toEqual({ state: "failed", output: REPLACED });
    expect(state(elsewhere)).toMatchObject({ state: "queued" });
  });

  it("a stop that the machine had goes out again after a reconnect, when nothing newer exists", () => {
    const { sql, add, state } = jobs();
    const sent = add(down, "sent");
    const other = add({ ...down, project: "other" }, "sent");
    add({ kind: "compose", project: "other" }, "queued");
    requeueDowns(sql, "m1");
    expect(state(sent)).toMatchObject({ state: "queued" });
    expect(state(other)).toMatchObject({ state: "failed" });
    expect(removalDown(sql, "app")).toEqual({ id: sent, state: "queued" });
  });

  it("a volume delete is no newer deploy, so a stop that the machine had still goes out again", () => {
    const { sql, add, state } = jobs();
    const sent = add(down, "sent");
    add({ kind: "compose-volume-remove", project: "app", volume: "app_data" }, "queued");
    add({ kind: "compose-down", project: "app", name: "app", removeData: true }, "queued");
    requeueDowns(sql, "m1");
    expect(state(sent)).toMatchObject({ state: "queued" });
  });

  it("a card that comes back loses the old site row, so a report without the site keeps the card", () => {
    const { db, sql } = jobs();
    db.exec(`INSERT INTO live_sites (id, machine_id, name, address, target, dev, up, last_up, state)
             VALUES ('app', 'm1', 'app', 'app.example.com', 'unix:/s', 0, 1, 0, 'ok')`);
    // The stop ran on the machine; the undo restores the card before the machine reports the sites.
    dropLiveSite(sql, "app");
    // updateLiveSites forgets the card of each row of the machine that the report leaves out: there is none.
    expect(sql("SELECT id FROM live_sites WHERE machine_id = 'm1'")).toEqual([]);
  });
});
