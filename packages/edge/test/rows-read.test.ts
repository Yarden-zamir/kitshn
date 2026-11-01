import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Circle } from "../src/core/model.ts";
import type { RevisionView } from "../src/core/protocol.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

/**
 * K-1302: the free plan reads 5,000,000 rows a day. A wake of the Durable Object (load) and each snapshot read a
 * bounded number of rows, not the whole revisions or deploys table.
 */
it("reads few rows on a wake and on each snapshot", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  let rowsRead = 0;
  const load = await runInDurableObject(stub, (instance, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    for (let i = 0; i < 2000; i++)
      sql.exec(
        "INSERT INTO revisions (at, actor, summary, changes, undoes) VALUES (?, ?, 'test', '[]', ?)",
        now,
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
        i % 10 === 0 ? 1 : null,
      );
    for (let i = 0; i < 500; i++)
      sql.exec(
        `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
         VALUES (?, 'owner/repo', 'prod', 'card', 'card.example.com', 'kitshn-card', 'deploy', 'abc', 'done', ?)`,
        `rows-read-${i}`,
        now,
      );
    // Access rows and icons only the alarm and a snapshot read; a wake for a daemon sample reads neither.
    for (let i = 0; i < 300; i++)
      sql.exec(
        "INSERT INTO access_objects (key, cf_id, body, tried) VALUES (?, 'cf', '{}', '{}')",
        `rows-read-${i}`,
      );
    for (let i = 0; i < 100; i++)
      sql.exec(
        "INSERT INTO icons (id, type, hash, bytes) VALUES (?, 'image/png', 'h', x'00')",
        `rows-read-${i}`,
      );
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        rowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
    (instance as unknown as { load(): void }).load();
    return rowsRead;
  });
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
  };
  rowsRead = 0;
  await send("/api/state", { headers });
  const firstSnapshot = rowsRead;
  rowsRead = 0;
  await send("/api/state", { headers });
  // A wake reads the small tables only; the first snapshot reads the 200 recent revisions and scans the deploys once.
  expect(load).toBeLessThan(100);
  expect(firstSnapshot).toBeLessThan(1000 + 500 + 300 + 100);
  expect(rowsRead).toBeLessThan(100);
});

/**
 * K-1302: the hot paths with grown tables, as on 2026-11-01, when the free plan ran out. A load (each change) keeps the
 * History it holds, a snapshot (each map update and `kitshn ops state`) reads no whole notifications or library table,
 * and a link event trims by id.
 */
it("reads few rows per change, snapshot and link event once the tables grow", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
  };
  let rowsRead = 0;
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    for (let i = 0; i < 300; i++)
      sql.exec(
        "INSERT INTO revisions (at, actor, summary, changes) VALUES (?, ?, 'test', '[]')",
        now,
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
      );
    for (let i = 0; i < 400; i++)
      sql.exec(
        `INSERT INTO notifications (source, key, recipients, level, priority, title, text, actions, state, opened_at,
           closed_at, episode) VALUES ('uptime', ?, '[]', 'view', 'normal', 't', 't', '[]', ?, ?, ?, 'e')`,
        `card-${i}`,
        i < 2 ? "dismissed" : "closed",
        now,
        now,
      );
    for (let i = 0; i < 60; i++)
      sql.exec(
        `INSERT INTO library (id, kind, title, size, content_type, created_at)
         VALUES (?, 'page', 't', 1, 'text/html', ?)`,
        `page-${i}`,
        now,
      );
    for (let i = 0; i < 2100; i++)
      sql.exec(
        `INSERT INTO link_events (at, source, target, kind, name, outcome)
         VALUES (?, 'mac', 'vps', 'exec', 'ls', 'succeeded')`,
        now,
      );
  });
  // A new object, so the first snapshot reads History with these rows.
  await evictDurableObject(stub);
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        rowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
  });
  // The first snapshot reads History, and the first link event trims the 100 events beyond 2,000.
  await send("/api/state", { headers });
  const recordExec = (instance: unknown) =>
    (instance as { recordExec(row: object, exit: object): void }).recordExec(
      { source: "mac", target: "vps", thread: null, command: "ls", cwd: null },
      { exitCode: 0, reason: null },
    );
  await runInDurableObject(stub, recordExec);
  rowsRead = 0;
  await send("/api/state", { headers });
  const snapshot = rowsRead;
  rowsRead = 0;
  // A writer that inserts a revision and then loads, as most writers do.
  const written = await runInDurableObject(stub, (instance, state) => {
    const [row] = state.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO revisions (at, actor, summary, changes) VALUES (?, ?, 'written', '[]') RETURNING id",
        Date.now(),
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
      )
      .toArray();
    (instance as unknown as { load(): void }).load();
    return row!.id;
  });
  const after = (await (await send("/api/state", { headers })).json()) as {
    revisions: ReadonlyArray<RevisionView>;
  };
  const changeAndSnapshot = rowsRead;
  expect(after.revisions[0]?.id).toBe(written);
  expect(after.revisions).toHaveLength(200);
  rowsRead = 0;
  await runInDurableObject(stub, recordExec);
  const linkEvent = rowsRead;
  // Without the indexes, the History refresh and the trim by id: 188, 505 and 2,007 rows.
  expect(snapshot).toBeLessThan(100);
  expect(changeAndSnapshot).toBeLessThan(300);
  expect(linkEvent).toBeLessThan(10);
});

/** What a wake does: the load, which leaves History unread. */
const wake = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance) => (instance as unknown as { load(): void }).load());

it("applies and undoes right after a wake, before History is read", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    "content-type": "application/json",
  };
  const circle: Circle = {
    id: "wake",
    name: "Wake",
    color: "#7c3aed",
    level: "view",
    members: [],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 3000,
    y: 3000,
    r: 200,
  };
  await wake(stub);
  const applied = await send("/api/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ edits: [{ _tag: "circle", id: circle.id, after: circle }] }),
  });
  expect(applied.status).toBe(200);
  const { revision } = (await applied.json()) as { revision: number };
  await wake(stub);
  const undone = await send("/api/undo", { method: "POST", headers, body: JSON.stringify({ revision }) });
  expect(undone.status).toBe(200);
  const state = (await (await send("/api/state", { headers })).json()) as {
    revisions: ReadonlyArray<RevisionView>;
    circles: ReadonlyArray<{ id: string }>;
  };
  expect(state.circles.map((item) => item.id)).not.toContain("wake");
  const [undo, ...older] = state.revisions;
  expect(undo?.undoes).toBe(revision);
  expect(older.find((item) => item.id === revision)?.undoneBy).toBe(undo?.id);
  expect(new Set(state.revisions.map((item) => item.id)).size).toBe(state.revisions.length);
});

it("reads few rows in an alarm run that checks a static site that is up (K-1126)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
  // Its own object, so the rows of the tests above do not count here.
  const stub = env.KITSHN.getByName("uptime-rows");
  let rowsRead = 0;
  await runInDurableObject(stub, (instance, state) => {
    const sql = state.storage.sql;
    for (let i = 0; i < 20; i++) {
      const card = {
        id: `static-${i}`,
        kind: "site.static",
        name: `static-${i}`,
        addresses: [`static-${i}.example.com`],
        status: "running",
        group: null,
        machine: null,
      };
      sql.exec("INSERT INTO resources (id, body) VALUES (?, ?)", card.id, JSON.stringify(card));
    }
    (instance as unknown as { load(): void }).load();
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        rowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
    // What a wake reads, then one alarm run with its uptime turn; every site is up, so no uptime row exists.
    (instance as unknown as { load(): void }).load();
    return instance.alarm();
  });
  expect(rowsRead).toBeLessThan(100);
});

it("reads the Access rows once for the life of the object, not in each alarm run (K-1302)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
  // Its own object, so the rows of the tests above do not count here.
  const stub = env.KITSHN.getByName("access-rows");
  await runInDurableObject(stub, (_instance, state) => {
    for (let i = 0; i < 300; i++)
      state.storage.sql.exec(
        "INSERT INTO access_objects (key, cf_id, body, tried) VALUES (?, 'cf', '{}', '{}')",
        `access-rows-${i}`,
      );
  });
  // A new object reads the Access rows once, when it first needs them.
  await evictDurableObject(stub);
  const read = await runInDurableObject(stub, async (instance, state) => {
    let accessRowsRead = 0;
    const sql = state.storage.sql;
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        if (query.includes("FROM access_objects")) accessRowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
    // Two alarm runs with a load between them, as a run that writes does: the rows come from memory each time.
    await instance.alarm();
    (instance as unknown as { load(): void }).load();
    await instance.alarm();
    return accessRowsRead;
  });
  expect(read).toBe(0);
});
