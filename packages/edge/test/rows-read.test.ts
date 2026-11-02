import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Circle } from "../src/core/model.ts";
import type { ProviderReport } from "@kitshn/local";
import type { RevisionView, Snapshot } from "../src/core/protocol.ts";
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
 * History it holds, a snapshot (each map update and `kitshn ops state`) reads no whole notifications or library table
 * and keeps the newest events in memory, and a link event trims by id.
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
  // On main before this fix: 188, 505 and 2,007 rows. A link event that empties the events in memory: 68 for a snapshot.
  expect(snapshot).toBeLessThan(40);
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
  // History is in memory now. A writer that inserts and loads with no snapshot after it, then an apply on top.
  const written = await runInDurableObject(stub, (instance, storage) => {
    const [row] = storage.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO revisions (at, actor, summary, changes) VALUES (?, ?, 'by a loading writer', '[]') RETURNING id",
        Date.now(),
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
      )
      .toArray();
    (instance as unknown as { load(): void }).load();
    return row!.id;
  });
  const reapplied = await send("/api/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ edits: [{ _tag: "circle", id: "stale", after: { ...circle, id: "stale" } }] }),
  });
  expect(reapplied.status).toBe(200);
  const later = (await (await send("/api/state", { headers })).json()) as {
    revisions: ReadonlyArray<RevisionView>;
  };
  expect(later.revisions.map((item) => item.id)).toContain(written);
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
    // Two alarm runs with a load between them, as a run that writes does: the first reads the rows, the second
    // takes them from memory.
    await instance.alarm();
    (instance as unknown as { load(): void }).load();
    await instance.alarm();
    return accessRowsRead;
  });
  expect(read).toBe(300);
});

/**
 * K-1302, K-004: a whole wake on tables of the size of the state of 2026-11-02, with months more of deploys. About
 * 4,500 wakes a day each run the constructor, mostly for one daemon message, so its rows count 4,500 times. On main
 * before this bound, the constructor read 2,285 rows and an alarm wake 2,337, as both scanned all of `deploys`.
 */
it("reads a fixed number of rows in a whole wake, however many deploys kitshn keeps", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  let cursors: Array<SqlStorageCursor<Record<string, SqlStorageValue>>> = [];
  const rows = () => cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
  const restore = await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    // The tests above share this object, so this one starts from empty tables of its own.
    for (const table of [
      "resources",
      "places",
      "deploys",
      "deploy_cards",
      "access_objects",
      "applied_state",
      "dns_objects",
      "revisions",
      "icons",
      "notifications",
      "library",
      "link_events",
    ])
      sql.exec(`DELETE FROM ${table}`);
    const now = Date.now();
    const cards = 86;
    for (let i = 0; i < cards; i++) {
      const card = {
        id: `card-${i}`,
        kind: "site.static",
        name: `card-${i}`,
        addresses: [`card-${i}.example.com`],
        status: "running",
        group: null,
        machine: null,
      };
      sql.exec("INSERT INTO resources (id, body) VALUES (?, ?)", card.id, JSON.stringify(card));
      if (i < 40) sql.exec("INSERT INTO places (id, x, y) VALUES (?, 1, 1)", card.id);
    }
    for (let i = 0; i < 2000; i++)
      sql.exec(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, kind, sha, state, expires_at)
         VALUES (?, 'owner/repo', '1', 'prod', ?, 'card.example.com', 'kitshn-card', 'deploy', 'abc', 'done', ?)`,
        `wake-${i}`,
        `card-${i % cards}`,
        now - (2000 - i) * 60_000,
      );
    for (let i = 0; i < 50; i++) {
      sql.exec(
        "INSERT INTO access_objects (key, cf_id, body, tried) VALUES (?, 'cf', '{}', '{}')",
        `wake-${i}`,
      );
      sql.exec("INSERT INTO applied_state (machine_id, key, hash) VALUES ('vps', ?, 'h')", `wake-${i}`);
    }
    for (let i = 0; i < 25; i++)
      sql.exec(
        "INSERT INTO dns_objects (address, record_id, content, retry_at) VALUES (?, 'r', 'c', 0)",
        `card-${i}.example.com`,
      );
    for (let i = 0; i < 2000; i++)
      sql.exec(
        "INSERT INTO revisions (at, actor, summary, changes) VALUES (?, ?, 'test', '[]')",
        now,
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
      );
    // Counts the rows of every cursor of every instance from here on, so the constructor of the next one too.
    const prototype = Object.getPrototypeOf(sql) as { exec: typeof sql.exec };
    const exec = prototype.exec;
    prototype.exec = function (this: SqlStorage, query: string, ...bindings: Array<SqlStorageValue>) {
      const cursor = exec.call(this, query, ...bindings);
      cursors.push(cursor);
      return cursor;
    } as typeof sql.exec;
    return () => {
      prototype.exec = exec;
    };
  });
  try {
    // The first start plans the alarm, as a new release does; the wakes after it find the alarm pending.
    await evictDurableObject(stub);
    await runInDurableObject(stub, () => undefined);
    await evictDurableObject(stub);
    cursors = [];
    await runInDurableObject(stub, () => undefined);
    const constructor = rows();
    cursors = [];
    const headers = {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    };
    await send("/api/state", { headers });
    const firstSnapshot = rows();
    // A wake for the alarm, every 5 minutes for uptime (K-1126); every site is up.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
    await evictDurableObject(stub);
    cursors = [];
    await runInDurableObject(stub, (instance) => instance.alarm());
    const alarm = rows();
    expect(constructor).toBeLessThan(150);
    expect(constructor + firstSnapshot).toBeLessThan(600);
    expect(alarm).toBeLessThan(300);
  } finally {
    restore();
  }
});

it("never plans the alarm for now for the expired deploy sticker of a removed card, and drops that sticker (K-538)", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { status: 200 }));
  // Review repro: a CI deploy runs, the owner removes the app, the run stops. On c07fb837 each alarm planned the next
  // one for now, about 240 runs a second, which spends the free requests and rows read in minutes.
  const result = await runInDurableObject(
    env.KITSHN.getByName("expired-sticker"),
    async (instance, state) => {
      const kitshn = instance as unknown as {
        load(): void;
        progressCache: unknown;
        scheduleAlarm(): Promise<void>;
        alarm(): Promise<void>;
      };
      state.storage.sql.exec(
        `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
       VALUES ('d1', 'owner/repo', 'prod', 'gone', 'gone.example.com', 'kitshn-gone', 'deploy', 'abc', 'running', ?)`,
        Date.now() - 60_000,
      );
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('progress:gone', ?)",
        JSON.stringify({
          source: { _tag: "deploy", deployId: "d1" },
          progress: { action: "Deploy", steps: [], outcome: { state: "running" }, retry: null },
        }),
      );
      kitshn.load();
      kitshn.progressCache = null;
      await kitshn.scheduleAlarm();
      const planned = await state.storage.getAlarm();
      await kitshn.alarm();
      return {
        planned,
        now: Date.now(),
        sticker: state.storage.sql.exec("SELECT 1 FROM meta WHERE key = 'progress:gone'").toArray().length,
      };
    },
  );
  expect(result.planned).toBeGreaterThan(result.now);
  expect(result.sticker).toBe(0);
});

/** Counts the rows of every cursor of every instance, so the constructor after an eviction too. */
function countRows(sql: SqlStorage) {
  let cursors: Array<SqlStorageCursor<Record<string, SqlStorageValue>>> = [];
  const prototype = Object.getPrototypeOf(sql) as { exec: typeof sql.exec };
  const exec = prototype.exec;
  prototype.exec = function (this: SqlStorage, query: string, ...bindings: Array<SqlStorageValue>) {
    const cursor = exec.call(this, query, ...bindings);
    cursors.push(cursor);
    return cursor;
  } as typeof sql.exec;
  return {
    /** The rows read since the last call. */
    take: () => {
      const rows = cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
      cursors = [];
      return rows;
    },
    restore: () => {
      prototype.exec = exec;
    },
  };
}

type Sent = { readonly type: string; readonly hash?: string; readonly snapshot?: Snapshot };

/** What the object sends from now on to its sockets of one kind ("map" or "machine"); `clear` starts again. */
function sentTo(kind: "map" | "machine") {
  let sent: Array<Sent> = [];
  const send = WebSocket.prototype.send;
  // The kind is read at the send, inside the object; the test harness sends on sockets of its own too.
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data) {
    const attachment = this.deserializeAttachment() as { kind?: string } | null;
    if (attachment?.kind === kind) sent.push(JSON.parse(String(data)) as Sent);
    send.call(this, data);
  });
  return {
    messages: () => sent,
    clear: () => {
      sent = [];
    },
  };
}

/**
 * A socket that the object accepts on `path` for `caller`, as the Worker sends it. Its test end lives outside the
 * object, so the socket outlives an eviction, as a socket outlives a wake.
 */
async function openSocket(stub: DurableObjectStub, path: string, caller: object) {
  const response = await stub.fetch(`https://kit.example.com${path}`, {
    headers: { upgrade: "websocket", "x-kitshn-caller": JSON.stringify(caller) },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`kitshn opened no socket on ${path}: ${response.status}`);
  socket.accept();
  return socket;
}

/**
 * K-1302, K-605, K-004: on 2026-11-02, the first broadcast after a wake read History again for a snapshot, about 470
 * rows, and each link call broadcast while any map socket was open, mostly a sleeping phone. Now only a watching map
 * gets snapshots and link broadcasts, and a map that missed one gets the current state as soon as it watches again.
 */
it("reads no History in the first broadcast after a wake while no map watches, and a map that watches gets it at once", async () => {
  const stub = env.KITSHN.getByName("map-rows");
  const counter = await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    // The History tables as on 2026-11-02.
    const now = Date.now();
    for (let i = 0; i < 300; i++)
      sql.exec(
        "INSERT INTO revisions (at, actor, summary, changes) VALUES (?, ?, 'test', '[]')",
        now,
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
      );
    for (let i = 0; i < 60; i++) {
      sql.exec(
        `INSERT INTO ask_events (at, machine_id, action, target, labels, outcome, detail)
         VALUES (?, 'vps', 'deploy', 'card', '{}', 'allowed', '{}')`,
        now,
      );
      sql.exec(
        `INSERT INTO link_events (at, source, target, kind, name, outcome)
         VALUES (?, 'mac', 'vps', 'tool', 'proxy-probe', 'succeeded')`,
        now,
      );
    }
    for (let i = 0; i < 47; i++)
      sql.exec("INSERT INTO applied_state (machine_id, key, hash) VALUES ('vps', ?, 'h')", `key-${i}`);
    for (let i = 0; i < 36; i++)
      sql.exec(
        "INSERT INTO backups (run, card, machine_id, at, state) VALUES (?, ?, 'vps', ?, 'done')",
        `run-${i}`,
        `card-${i % 12}`,
        now - i,
      );
    for (let i = 0; i < 15; i++)
      sql.exec("INSERT INTO icons (id, type, hash, bytes) VALUES (?, 'image/png', 'h', x'00')", `icon-${i}`);
    return countRows(sql);
  });
  // A map that never sends `watching`: a hidden tab or a sleeping phone.
  const map = await openSocket(stub, "/api/ws", {
    visitor: { email: "owner@example.com", clientId: null, ip: null },
    actor: { _tag: "person", email: "owner@example.com" },
  });
  const sent = sentTo("map");
  type Internals = {
    broadcast(): void;
    recordExec(row: object, exit: object): void;
    webSocketMessage(socket: WebSocket, data: string): Promise<void>;
  };
  const run = <T>(fn: (instance: Internals, state: DurableObjectState) => T) =>
    runInDurableObject(stub, async (instance, state) => await fn(instance as unknown as Internals, state));
  const broadcast = (instance: Internals) => instance.broadcast();
  const watching = (visible?: boolean) =>
    run((instance, state) =>
      instance.webSocketMessage(
        state.getWebSockets("map")[0]!,
        JSON.stringify(visible === undefined ? { type: "watching" } : { type: "watching", visible }),
      ),
    );
  const types = () => sent.messages().map((message) => message.type);
  try {
    await evictDurableObject(stub);
    counter.take();
    await run(broadcast);
    const hiddenBroadcast = counter.take();
    await evictDurableObject(stub);
    await run((instance) =>
      instance.recordExec(
        { source: "mac", target: "vps", thread: null, command: "after-wake", cwd: null },
        { exitCode: 0, reason: null },
      ),
    );
    const hiddenLinkEvent = counter.take();
    expect(types()).toEqual([]);

    // The map becomes visible: it gets the current state at once, with the event that it missed.
    await watching();
    const [fresh] = sent.messages();
    expect(types()).toEqual(["snapshot"]);
    expect(fresh?.snapshot?.linkEvents.some((event) => event.name === "after-wake")).toBe(true);
    // A watching map gets each broadcast, also the first one after a wake.
    await evictDurableObject(stub);
    sent.clear();
    counter.take();
    await run(broadcast);
    const watchedBroadcast = counter.take();
    expect(types()).toEqual(["snapshot"]);
    // A renewal while it watches sends nothing more.
    sent.clear();
    await watching();
    expect(types()).toEqual([]);
    // Hidden again: no snapshot, and the next `watching` brings one.
    await watching(false);
    await run(broadcast);
    expect(types()).toEqual([]);
    await watching();
    expect(types()).toEqual(["snapshot"]);

    // On main before this fix: 433 and 438 rows, because both sent the hidden map a snapshot that read History.
    expect(hiddenBroadcast).toBeLessThan(100);
    expect(hiddenLinkEvent).toBeLessThan(100);
    // Known limit: a watching map still reads History in the first snapshot after a wake, about 430 rows here.
    expect(watchedBroadcast).toBeLessThan(600);
  } finally {
    counter.restore();
    map.close();
  }
});

/**
 * K-706, K-1608: `sentGrants` lives in memory, so on 2026-11-02 each wake sent every push again, about 40, and each
 * daemon answered each one with `applied`. Now a push that the daemon applied goes out again only on a new connection.
 */
it("sends no push again after a wake when the daemon applied it, and every push on a new connection", async () => {
  const stub = env.KITSHN.getByName("grants-wake");
  const attachment = {
    kind: "machine",
    machineId: "vps",
    since: Date.now(),
    challenge: "",
    check: "signed",
    answered: true,
    rotateBy: null,
    status: {
      version: "dev",
      os: "linux",
      arch: "x64",
      hostname: "vps",
      tunnel: "running",
      capabilities: ["applied", "access", "protocol-2"],
    },
    sample: null,
  };
  type Internals = {
    load(): void;
    broadcast(): void;
    hashesOf(machineId: string): ReadonlyMap<string, string>;
    acceptMachine(socket: WebSocket, attachment: object): void;
    webSocketMessage(socket: WebSocket, data: string): Promise<void>;
  };
  const run = <T>(fn: (instance: Internals, socket: WebSocket) => T) =>
    runInDurableObject(stub, async (instance, state) => {
      const [socket] = state.getWebSockets("vps");
      return await fn(instance as unknown as Internals, socket!);
    });
  const sent = sentTo("machine");
  const pushes = () => sent.messages().filter((message) => message.hash !== undefined);
  await runInDurableObject(stub, async (instance, state) => {
    const machine = {
      id: "vps",
      name: "vps",
      labels: [],
      order: 0,
      serviceTokenId: "token-vps",
      clientId: "vps.access",
      tunnelId: "tunnel-vps",
      key: { kind: "public", publicKey: "x", fingerprint: "f", since: 0 },
    };
    state.storage.sql.exec("INSERT INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(machine));
    (instance as unknown as Internals).load();
  });
  const daemon = await openSocket(stub, "/connect", {
    visitor: { email: null, clientId: "vps.access", ip: null },
    actor: { _tag: "kitshn", reason: "test" },
  });
  // The daemon passed its challenge (K-1704).
  await run((_instance, socket) => socket.serializeAttachment(attachment));
  try {
    const report: ProviderReport = {
      name: "t3",
      online: true,
      kinds: [{ id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } }],
      commands: [],
      resources: [{ id: "app", kind: "t3.app", name: "T3 on vps", status: "running" }],
    };
    await run((instance, socket) =>
      instance.webSocketMessage(socket, JSON.stringify({ type: "providers", providers: [report] })),
    );
    const all = pushes().length;
    expect(all).toBeGreaterThan(2);
    // The daemon saves each push and answers `applied`.
    await run(async (instance, socket) => {
      for (const [key, hash] of instance.hashesOf("vps"))
        await instance.webSocketMessage(socket, JSON.stringify({ type: "applied", key, hash }));
    });
    await evictDurableObject(stub);
    sent.clear();
    await run((instance) => instance.broadcast());
    expect(pushes()).toEqual([]);
    // K-706: a new connection of the daemon gets every push again.
    await run((instance, socket) => instance.acceptMachine(socket, attachment));
    expect(pushes()).toHaveLength(all);
  } finally {
    daemon.close();
  }
});
