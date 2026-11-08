import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Machine } from "../src/core/machine.ts";
import type { Resource } from "../src/core/model.ts";
import { SECRET_ROWS, stateExport } from "../src/worker/backups.ts";
import { OFFLINE_OUTPUT } from "../src/worker/kitshn.ts";
import { type ActionProgress, currentStep } from "../src/core/progress.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-1813, K-1814, K-1831: restic reaches a card's repository through the Worker, and the export of the state. */

const stub = () => env.KITSHN.getByName("kitshn");
const ID = "a".repeat(64);

const machine = (id: string): Machine => ({
  id,
  name: id,
  labels: ["deploy"],
  order: 0,
  serviceTokenId: `token-${id}`,
  clientId: `${id}.access`,
  tunnelId: `tunnel-${id}`,
});

async function setup(card: string, machines: Array<string>, on: string) {
  await runInDurableObject(stub(), (instance, durable) => {
    const sql = durable.storage.sql;
    for (const id of machines)
      sql.exec("INSERT INTO machines (id, body) VALUES (?, ?)", id, JSON.stringify(machine(id)));
    const resource: Resource = {
      id: card,
      kind: "site.compose",
      name: card,
      addresses: [`${card}.example.com`],
      status: "running",
      group: null,
      machine: on,
    };
    sql.exec("INSERT INTO resources (id, body) VALUES (?, ?)", card, JSON.stringify(resource));
    const command: Command = { kind: "backup", card, run: "r1", prune: false, pauseLimitMs: 90_000 };
    sql.exec(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
       VALUES (?, '[]', ?, 'sent', 0, ?, '{}', '{}', NULL, '')`,
      on,
      JSON.stringify(command),
      Date.now() + 60_000,
    );
    reload(instance);
  });
}

/** The machines and cards in memory follow the tables, as after any change. */
const reload = (instance: unknown) => (instance as { load(): void }).load();

/** One restic request of machine `machineId`, as its proxy sends it; the body is read, so no request stays open. */
async function restic(machineId: string, path: string, init: RequestInit<IncomingRequestCfProperties> = {}) {
  const response = await send(path, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      "cf-access-jwt-assertion": await accessToken("connect-aud", { common_name: `${machineId}.access` }),
    },
  });
  return {
    status: response.status,
    headers: response.headers,
    text: new TextDecoder().decode(await response.arrayBuffer()),
  };
}

afterEach(() => vi.restoreAllMocks());

/** K-538: the action that a card shows, with the step that runs and how it ended. */
const shown = (card: string) =>
  runInDurableObject(stub(), (instance) => {
    const row = (instance as unknown as { progressRows(): Map<string, { progress: ActionProgress }> })
      .progressRows()
      .get(card)?.progress;
    return row
      ? {
          action: row.action,
          steps: row.steps.length,
          step: currentStep(row),
          outcome: row.outcome.state,
          reason: row.outcome.state === "failed" ? row.outcome.reason : null,
        }
      : null;
  });

describe("restic through the Worker (K-1813, K-1814)", () => {
  it("serves the repository of a card to the machine that runs its job, with ranges and v2 lists", async () => {
    stubAccessCerts();
    await setup("app-store", ["m-a"], "m-a");
    const base = "/connect/backups/app-store";
    expect((await restic("m-a", `${base}/config`, { method: "HEAD" })).status).toBe(404);
    const saved = await restic("m-a", `${base}/data/${ID}`, {
      method: "POST",
      body: "0123456789",
      headers: { "content-length": "10" },
    });
    expect(saved.status).toBe(200);
    // restic refuses a range answer whose Content-Length is not the length that it asked for.
    const read = async (range?: string) => {
      const answer = await restic("m-a", `${base}/data/${ID}`, range ? { headers: { range } } : {});
      return [
        answer.status,
        answer.text,
        answer.headers.get("content-length"),
        answer.headers.get("content-range"),
        answer.headers.get("cache-control"),
      ];
    };
    expect(await read("bytes=2-5")).toEqual([206, "2345", "4", "bytes 2-5/10", "no-transform"]);
    expect(await read("bytes=7-")).toEqual([206, "789", "3", "bytes 7-9/10", "no-transform"]);
    expect(await read()).toEqual([200, "0123456789", "10", null, "no-transform"]);
    const listed = await restic("m-a", `${base}/data/`, {
      headers: { accept: "application/vnd.x.restic.rest.v2" },
    });
    expect(JSON.parse(listed.text)).toEqual([{ name: ID, size: 10 }]);
    const key = await restic("m-a", `${base}/key`);
    expect(JSON.parse(key.text)).toEqual({ password: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await restic("m-a", `${base}/data/..%2Fother`)).status).toBe(404);
  });

  it("refuses another machine, a machine with no job of the card, and the old machine after a move", async () => {
    stubAccessCerts();
    await setup("app-moved", ["m-old", "m-new"], "m-old");
    const path = "/connect/backups/app-moved/key";
    expect((await restic("m-old", path)).status).toBe(200);
    expect((await restic("m-new", path)).status).toBe(403);
    // K-1814: the card moves; its job stays with the old machine, which loses the repository at once.
    await runInDurableObject(stub(), (instance, durable) => {
      const [row] = durable.storage.sql
        .exec<{ body: string }>("SELECT body FROM resources WHERE id = 'app-moved'")
        .toArray();
      const moved = { ...(JSON.parse(row!.body) as Resource), machine: "m-new" };
      durable.storage.sql.exec("UPDATE resources SET body = ? WHERE id = 'app-moved'", JSON.stringify(moved));
      reload(instance);
    });
    expect((await restic("m-old", path)).status).toBe(403);
    // The new machine needs its own job of the card.
    expect((await restic("m-new", path)).status).toBe(403);
  });
});

describe("a dropped daemon socket (K-1814)", () => {
  it("keeps the access of a running job until the job expires", async () => {
    stubAccessCerts();
    await setup("app-drop", ["m-drop"], "m-drop");
    const path = "/connect/backups/app-drop/key";
    const mark = (expiresAt: number) =>
      runInDurableObject(stub(), (_instance, durable) => {
        durable.storage.sql.exec(
          "UPDATE jobs SET state = 'failed', output = ?, expires_at = ? WHERE machine_id = 'm-drop'",
          OFFLINE_OUTPUT,
          expiresAt,
        );
      });
    await mark(Date.now() + 60_000);
    expect((await restic("m-drop", path)).status).toBe(200);
    await mark(Date.now() - 1);
    expect((await restic("m-drop", path)).status).toBe(403);
  });
});

describe("state export (K-1831)", () => {
  it("holds every table but the one-time codes and the jobs, with a BLOB as base64", async () => {
    await runInDurableObject(stub(), (_instance, durable) => {
      durable.storage.sql.exec(
        "INSERT INTO icons (id, type, hash, bytes) VALUES ('c', 'image/png', 'h', ?)",
        new Uint8Array([1, 2, 3]),
      );
      // K-1831: each named secret holds a value that must not reach the export.
      for (const row of SECRET_ROWS)
        if ("table" in row) {
          // A secret table may exist already with its real columns (pass_keys of K-1771); a row of secrets goes in either way.
          durable.storage.sql.exec(
            `CREATE TABLE IF NOT EXISTS "${row.table}" (id TEXT PRIMARY KEY, value TEXT)`,
          );
          // A table that a migration made keeps its columns; each column of the row holds the secret.
          const columns = durable.storage.sql
            .exec<{ name: string; type: string }>(`PRAGMA table_info("${row.table}")`)
            .toArray()
            .filter((column) => column.name !== "id" || column.type !== "INTEGER");
          durable.storage.sql.exec(
            `INSERT OR REPLACE INTO "${row.table}" (${columns.map((column) => column.name).join(", ")})
             VALUES (${columns.map((column) => (column.type === "INTEGER" ? "1" : "'secret'")).join(", ")})`,
          );
        } else
          durable.storage.sql.exec(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, 'secret')",
            `${row.metaPrefix}_test`,
          );
      const exported = stateExport(durable.storage.sql, "acct", 21, 5);
      expect(exported).toMatchObject({
        format: "kitshn-state",
        version: 1,
        account: "acct",
        schemaVersion: 21,
        exportedAt: 5,
      });
      expect(Object.keys(exported.tables)).toEqual(
        expect.arrayContaining(["circles", "resources", "revisions", "backups"]),
      );
      for (const left of ["jobs", "join_codes", "rekey_codes", "device_invites"])
        expect(exported.tables).not.toHaveProperty(left);
      expect(JSON.stringify(exported)).not.toContain("secret");
      expect(exported.tables["icons"]).toContainEqual(
        expect.objectContaining({ id: "c", bytes: { base64: "AQID" } }),
      );
    });
  });
});

/** A daemon socket of a machine that passed its key check (K-1704). */
const daemonSocket = (machineId: string) =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId,
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send() {},
    close() {},
  }) as unknown as WebSocket;

const admin = async (path: string, method: "GET" | "POST" | "DELETE", body: object = {}) => {
  const response = await send(path, {
    method,
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("backup runs (K-1817 to K-1819)", () => {
  it("queues Back up now, records what the daemon reports, and waits when the bucket is near full", async () => {
    stubAccessCerts();
    await setup("app-runs", ["m-runs"], "m-runs");
    const started = await admin("/api/apps/app-runs/backups", "POST");
    const run = started.body["run"];
    expect(run).toEqual(expect.any(String));
    expect(await shown("app-runs")).toMatchObject({ action: "Back up now", step: 0, outcome: "running" });
    const job = await runInDurableObject(
      stub(),
      (_instance, durable) =>
        durable.storage.sql
          .exec<{ id: number; command: string }>(
            "SELECT id, command FROM jobs WHERE json_extract(command, '$.run') = ?",
            String(run),
          )
          .toArray()[0],
    );
    expect(JSON.parse(job!.command)).toEqual({
      kind: "backup",
      card: "app-runs",
      run,
      prune: expect.any(Boolean),
      pauseLimitMs: 90_000,
    });
    // K-1817: every backup on a Sunday (UTC) prunes, the ones of "Back up now" too.
    const prunes = await runInDurableObject(stub(), (instance, durable) =>
      ["2026-11-08T12:00:00Z", "2026-11-09T12:00:00Z"].map((day) => {
        const queue = instance as unknown as {
          queueBackup(card: string, actor: unknown, now: number): { jobId: number };
        };
        const { jobId } = queue.queueBackup("app-runs", { _tag: "kitshn", reason: "test" }, Date.parse(day));
        const [row] = durable.storage.sql
          .exec<{ command: string }>("SELECT command FROM jobs WHERE id = ?", jobId)
          .toArray();
        return (JSON.parse(row!.command) as { prune: boolean }).prune;
      }),
    );
    expect(prunes).toEqual([true, false]);
    await runInDurableObject(stub(), async (instance, durable) => {
      // The job went to the machine; the daemon answers.
      durable.storage.sql.exec("UPDATE jobs SET state = 'sent', machine_id = 'm-runs' WHERE id = ?", job!.id);
      await instance.webSocketMessage(
        daemonSocket("m-runs"),
        JSON.stringify({
          type: "jobResult",
          id: job!.id,
          result: {
            ok: true,
            exitCode: 0,
            output: "",
            backup: { run, bytes: 2000, added: 300, sources: ["data"], kept: [run], pauseMs: 50_000 },
          },
        }),
      );
    });
    expect(await shown("app-runs")).toMatchObject({ steps: 2, step: 2, outcome: "done" });
    const listed = await admin("/api/apps/app-runs/backups", "GET");
    expect(listed.body["runs"]).toContainEqual(
      expect.objectContaining({ run, state: "done", bytes: 2000, added: 300, error: null, pauseMs: 50_000 }),
    );
    // K-1818: at 8 GB the bucket takes no more backups.
    await runInDurableObject(stub(), (_instance, durable) => {
      durable.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('r2_bucket', ?)",
        JSON.stringify({ bytes: 8.2e9, at: 0 }),
      );
    });
    const refused = await admin("/api/apps/app-runs/backups", "POST");
    expect([refused.status, refused.body["error"]]).toEqual([
      409,
      expect.stringMatching(/8\.2 GB of the 10\.0 GB/),
    ]);
    // K-1818, K-1820: a restore passes the size guard, and it names the sources of the run for the daemon.
    const restoring = await admin(`/api/apps/app-runs/backups/${String(run)}/restore`, "POST");
    const before = restoring.body["before"];
    expect(restoring.status).toBe(200);
    const restoreJob = await runInDurableObject(stub(), (_instance, durable) =>
      durable.storage.sql
        .exec<{ id: number; command: string }>(
          "SELECT id, command FROM jobs WHERE json_extract(command, '$.before') = ?",
          String(before),
        )
        .one(),
    );
    expect(JSON.parse(restoreJob.command)).toEqual({
      kind: "backup-restore",
      card: "app-runs",
      run,
      before,
      sources: ["data"],
      // K-1816: 3 times the last pause of 50 s, at most 90 s.
      pauseLimitMs: 90_000,
    });
    // K-1820: the write-back fails after the backup of before; that backup stays the way back.
    await runInDurableObject(stub(), async (instance, durable) => {
      durable.storage.sql.exec(
        "UPDATE jobs SET state = 'sent', machine_id = 'm-runs' WHERE id = ?",
        restoreJob.id,
      );
      await instance.webSocketMessage(
        daemonSocket("m-runs"),
        JSON.stringify({
          type: "jobResult",
          id: restoreJob.id,
          result: {
            ok: false,
            exitCode: 1,
            output: "The restore failed, and the data of before stays",
            backup: { run: before, bytes: 2100, added: 10, sources: ["data"] },
          },
        }),
      );
    });
    expect(await shown("app-runs")).toMatchObject({
      action: "Restore",
      step: 1,
      outcome: "failed",
      reason: "The restore failed, and the data of before stays",
    });
    const after = (await admin("/api/apps/app-runs/backups", "GET")).body["runs"];
    expect(after).toContainEqual(expect.objectContaining({ run: before, state: "done", error: null }));
  });

  it("leaves a card with Daily backup off out of the daily run, also after a redeploy (K-1817)", async () => {
    stubAccessCerts();
    await setup("app-off", ["m-off"], "m-off");
    await setup("app-on", ["m-on"], "m-on");
    // Control on a card comes from its circles (K-717, tested with the provider settings); these cards have none.
    await runInDurableObject(stub(), (instance) => {
      vi.spyOn(instance as unknown as { canControl(): boolean }, "canControl").mockReturnValue(true);
    });
    expect(
      (await admin("/api/cards/app-off/settings", "POST", { key: "dailyBackup", value: "off" })).status,
    ).toBe(200);
    expect(
      (await admin("/api/cards/app-on/settings", "POST", { key: "dailyBackup", value: "no" })).status,
    ).toBe(400);
    const queued = await runInDurableObject(stub(), async (instance, durable) => {
      const sql = durable.storage.sql;
      // A redeploy writes the card again; the setting lives outside it.
      const [row] = sql.exec<{ body: string }>("SELECT body FROM resources WHERE id = 'app-off'").toArray();
      sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES ('app-off', ?)", row!.body);
      sql.exec("UPDATE jobs SET state = 'done'");
      reload(instance);
      const daily = instance as unknown as {
        deployedAndPreviewCards(): unknown;
        dailyBackups(now: number): Promise<void>;
      };
      vi.spyOn(daily, "deployedAndPreviewCards").mockReturnValue({
        deployedCards: ["app-off", "app-on"],
        previewCards: [],
        pullRequests: {},
      });
      await daily.dailyBackups(Date.now());
      return sql
        .exec<{ card: string }>(
          "SELECT json_extract(command, '$.card') AS card FROM jobs WHERE state = 'queued' ORDER BY id",
        )
        .toArray()
        .map((job) => job.card);
    });
    expect(queued).toEqual(["app-on"]);
    expect((await admin("/api/apps/app-off/backups", "GET")).body["daily"]).toBe(false);
    expect((await admin("/api/apps/app-on/backups", "GET")).body["daily"]).toBe(true);
    // Back up now stays for a card that is out of the daily run.
    expect((await admin("/api/apps/app-off/backups", "POST")).status).toBe(200);
  });

  it("deletes every backup of one card only, never while a job can reach it (K-1823)", async () => {
    stubAccessCerts();
    await setup("app-del", ["m-del", "m-two"], "m-del");
    const keys = ["backups/app-del/config", `backups/app-del/data/${ID}`, "backups/app-del@m-two/config"];
    const others = ["backups/app-del-2/config", "backups/app-other/config", "state/2026-11-08.json.gz"];
    await env.BUCKET!.put(`backups/app-renamed/data/${ID}`, "x");
    for (const key of [...keys, ...others]) await env.BUCKET!.put(key, "x");
    await runInDurableObject(stub(), (_instance, durable) => {
      for (const [run, card] of [
        ["d1", "app-del"],
        ["d2", "app-del"],
        ["o1", "app-other"],
        ["n1", "app-renamed"],
      ])
        durable.storage.sql.exec(
          "INSERT INTO backups (run, card, machine_id, at, state) VALUES (?, ?, 'm-del', 1, 'done')",
          run,
          card,
        );
    });
    // The sent backup job of setup can still write to the repository.
    expect((await admin("/api/apps/app-del/backups", "DELETE")).status).toBe(409);
    await runInDurableObject(stub(), (_instance, durable) => {
      durable.storage.sql.exec("UPDATE jobs SET state = 'failed', output = ?", OFFLINE_OUTPUT);
    });
    // A dropped socket keeps the access of its job until the job expires (K-1814).
    expect((await admin("/api/apps/app-del/backups", "DELETE")).status).toBe(409);
    await runInDurableObject(stub(), (_instance, durable) => {
      durable.storage.sql.exec("UPDATE jobs SET state = 'done'");
    });
    const deleted = await admin("/api/apps/app-del/backups", "DELETE");
    expect(deleted).toEqual({ status: 200, body: { runs: 2, objects: 3 } });
    for (const key of keys) expect(await env.BUCKET!.head(key)).toBeNull();
    for (const key of others) expect(await env.BUCKET!.head(key)).not.toBeNull();
    const rows = await runInDurableObject(stub(), (_instance, durable) =>
      durable.storage.sql.exec<{ run: string }>("SELECT run FROM backups ORDER BY run").toArray(),
    );
    expect(rows.map((row) => row.run)).toEqual(expect.arrayContaining(["o1"]));
    expect(rows.map((row) => row.run)).not.toEqual(expect.arrayContaining(["d1"]));
    expect(rows.map((row) => row.run)).not.toEqual(expect.arrayContaining(["d2"]));
    // While the objects go, no backup of the card starts.
    const refused = await runInDurableObject(stub(), (instance) => {
      const guarded = instance as unknown as {
        deletingBackups: Set<string>;
        backupRefusal(card: string): unknown;
      };
      guarded.deletingBackups.add("app-del");
      try {
        return guarded.backupRefusal("app-del");
      } finally {
        guarded.deletingBackups.delete("app-del");
      }
    });
    expect(refused).toEqual(expect.stringContaining("being deleted"));
    // A removed card with runs left (K-1819) can go now; a card that kitshn never knew cannot.
    expect(await admin("/api/apps/app-renamed/backups", "DELETE")).toEqual({
      status: 200,
      body: { runs: 1, objects: 1 },
    });
    expect((await admin("/api/apps/app-never/backups", "DELETE")).status).toBe(404);
  });

  it("deletes the repository of a removed card 7 days after the daily run first saw it gone", async () => {
    const day = 24 * 3_600_000;
    await env.BUCKET!.put(`backups/app-gone/data/${"b".repeat(64)}`, "pack");
    const drop = (now: number) =>
      runInDurableObject(stub(), async (instance, durable) => {
        durable.storage.sql.exec(
          "INSERT OR IGNORE INTO backups (run, card, machine_id, at, state) VALUES ('g1', 'app-gone', 'm', 1, 'done')",
        );
        await (
          instance as unknown as { dropRemovedRepositories(bucket: R2Bucket, now: number): Promise<void> }
        ).dropRemovedRepositories(env.BUCKET!, now);
      });
    const start = Date.now();
    await drop(start);
    await drop(start + 6 * day);
    expect((await env.BUCKET!.list({ prefix: "backups/app-gone/" })).objects).toHaveLength(1);
    await drop(start + 8 * day);
    expect((await env.BUCKET!.list({ prefix: "backups/app-gone/" })).objects).toHaveLength(0);
  });

  it("drops the rows of runs that the retention removed", async () => {
    await setup("app-trim", ["m-trim"], "m-trim");
    await runInDurableObject(stub(), async (instance, durable) => {
      const sql = durable.storage.sql;
      for (const old of ["old-1", "old-2"])
        sql.exec(
          "INSERT INTO backups (run, card, machine_id, at, state, sources) VALUES (?, 'app-trim', 'm-trim', 1, 'done', '[]')",
          old,
        );
      const command: Command = {
        kind: "backup",
        card: "app-trim",
        run: "new",
        prune: false,
        pauseLimitMs: 120_000,
      };
      const [job] = sql
        .exec<{ id: number }>("SELECT id FROM jobs WHERE json_extract(command, '$.card') = 'app-trim'")
        .toArray();
      sql.exec("UPDATE jobs SET command = ? WHERE id = ?", JSON.stringify(command), job!.id);
      sql.exec(
        "INSERT INTO backups (run, card, machine_id, at, state, job_id) VALUES ('new', 'app-trim', 'm-trim', 2, 'running', ?)",
        job!.id,
      );
      await instance.webSocketMessage(
        daemonSocket("m-trim"),
        JSON.stringify({
          type: "jobResult",
          id: job!.id,
          result: {
            ok: true,
            exitCode: 0,
            output: "",
            backup: { run: "new", bytes: 1, added: 1, sources: [], kept: ["old-2", "new"] },
          },
        }),
      );
      expect(
        sql.exec<{ run: string }>("SELECT run FROM backups WHERE card = 'app-trim' ORDER BY run").toArray(),
      ).toEqual([{ run: "new" }, { run: "old-2" }]);
    });
  });
});

describe("restore to a time (K-1822, K-1771)", () => {
  const actor = { _tag: "person", email: "owner@example.com" };
  const finish = { undo: "bookmark-before", label: "2026-10-28T12:00:00.000Z", jobsAfter: 500, actor };

  it("finishes after the restart: History, job ids after the old highest, and the pass key last", async () => {
    const caller = { visitor: { email: "owner@example.com", clientId: null, ip: null }, actor };
    // K-538: the request started the steps on the admin card; the restart lost that row, so R2 carries it.
    const steps = ["find", "restart", "record", "rotate"].map((label, index) => ({
      label,
      expectedMs: 1_000,
      startedAt: index < 2 ? 0 : null,
      endedAt: index < 1 ? 0 : null,
    }));
    const progress = {
      action: "Restore kitshn to a time",
      steps,
      outcome: { state: "running" },
      retry: null,
    };
    await env.BUCKET!.put("state/restore-pending.json", JSON.stringify({ ...finish, progress }));
    const rotated = await runInDurableObject(stub(), async (instance) => {
      const spy = vi.spyOn(
        instance as unknown as { rotatePassKey(actor: unknown): Promise<void> },
        "rotatePassKey",
      );
      const response = await instance.fetch(
        new Request("https://kitshn.internal/fresh/restored", {
          method: "POST",
          headers: { "x-kitshn-caller": JSON.stringify(caller), "content-type": "application/json" },
          body: JSON.stringify(finish),
        }),
      );
      expect(response.status).toBe(200);
      return spy.mock.calls;
    });
    expect(rotated).toEqual([[actor]]);
    const after = await runInDurableObject(stub(), (_instance, durable) => ({
      // The pass key rotation writes its own revision after the restore (K-1771).
      summary: durable.storage.sql
        .exec<{ summary: string }>(
          "SELECT summary FROM revisions WHERE summary LIKE 'Restored kitshn to%' ORDER BY id DESC LIMIT 1",
        )
        .one().summary,
      seq: durable.storage.sql
        .exec<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'")
        .toArray()[0]?.seq,
    }));
    expect(after.summary).toMatch(/Restored kitshn to 2026-10-28T12:00:00.000Z.*bookmark-before/);
    expect(after.seq).toBeGreaterThanOrEqual(500);
    expect(await shown("kitshn-admin")).toMatchObject({
      action: "Restore kitshn to a time",
      step: 4,
      outcome: "done",
    });
    expect(await env.BUCKET!.head("state/restore-pending.json")).toBeNull();
  });

  it("carries the steps of the request through R2 to the finish on the admin card (K-538)", async () => {
    const caller = { visitor: { email: "owner@example.com", clientId: null, ip: null }, actor };
    await runInDurableObject(stub(), async (instance, state) => {
      // The real restore rewinds the storage and restarts the object; here the restart is only the reset of restoring.
      vi.spyOn(state.storage, "getBookmarkForTime").mockResolvedValue("bookmark-then");
      vi.spyOn(state.storage, "onNextSessionRestoreBookmark").mockResolvedValue("bookmark-undo");
      const abort = vi.spyOn(state, "abort").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        const response = await instance.fetch(
          new Request("https://kitshn.internal/fresh/restore-time", {
            method: "POST",
            headers: { "x-kitshn-caller": JSON.stringify(caller), "content-type": "application/json" },
            body: JSON.stringify({ at: Date.now() - 60_000 }),
          }),
        );
        expect(response.status).toBe(200);
        vi.runAllTimers();
      } finally {
        vi.useRealTimers();
      }
      expect(abort).toHaveBeenCalledTimes(1);
      (instance as unknown as { restoring: unknown }).restoring = null;
    });
    expect(await shown("kitshn-admin")).toMatchObject({ step: 1, outcome: "running" });
    await runInDurableObject(stub(), (instance) =>
      (instance as unknown as { finishPendingRestore(): Promise<void> }).finishPendingRestore(),
    );
    expect(await shown("kitshn-admin")).toMatchObject({
      action: "Restore kitshn to a time",
      steps: 4,
      step: 4,
      outcome: "done",
    });
  });

  it("finishes at the next alarm when the poll timed out, and only once", async () => {
    await env.BUCKET!.put("state/restore-pending.json", JSON.stringify({ ...finish, undo: "bookmark-late" }));
    const calls = await runInDurableObject(stub(), async (instance) => {
      const hooks = instance as unknown as {
        rotatePassKey(actor: unknown): Promise<void>;
        finishPendingRestore(): Promise<void>;
      };
      const spy = vi.spyOn(hooks, "rotatePassKey");
      // The poll and the alarm at the same time: one finish only.
      await Promise.all([hooks.finishPendingRestore(), hooks.finishPendingRestore()]);
      return spy.mock.calls.length;
    });
    expect(calls).toBe(1);
    expect(await env.BUCKET!.head("state/restore-pending.json")).toBeNull();
  });
});
