import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { type Circle, insideCircle } from "../src/core/model.ts";
import { type StateExport, stateExport } from "../src/worker/backups.ts";
import { MIGRATIONS, SQUARE_MIGRATION } from "../src/worker/migrations.ts";
import { IMPORT_OBJECT } from "../src/worker/state-import.ts";
import { send } from "./access.ts";

/** K-1833: an empty install takes a state export of the same account; anything else is refused and changes nothing. */

type Instance = {
  importIfDue(at: string | undefined): Promise<void>;
  runImport(at: string): Promise<{ code: string; detail: string } | null>;
  finishImport(): Promise<void>;
  rotatePassKey(actor: unknown): Promise<void>;
  load(): void;
};

const circle: Circle = {
  id: "friends",
  name: "Friends",
  color: "#7c3aed",
  level: "view",
  members: [{ _tag: "email", email: "friend@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 900,
  y: 900,
  r: 200,
};
const ICON = new Uint8Array([0, 1, 2, 250, 255]);

/** An export of the install `name`, with one more circle and one icon than the first start. */
const exportOf = (name: string) =>
  runInDurableObject(env.KITSHN.getByName(name), (instance, durable) => {
    durable.storage.sql.exec(
      "INSERT INTO circles (id, body) VALUES (?, ?)",
      circle.id,
      JSON.stringify(circle),
    );
    durable.storage.sql.exec(
      "INSERT INTO icons (id, type, hash, bytes) VALUES ('c', 'image/png', 'h', ?)",
      ICON,
    );
    (instance as unknown as Instance).load();
    return stateExport(durable.storage.sql, env.CLOUDFLARE_ACCOUNT_ID, MIGRATIONS.length, 1_000);
  });

const upload = async (state: unknown) =>
  env.BUCKET!.put(
    IMPORT_OBJECT,
    await new Response(
      new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

const meta = (sql: SqlStorage, key: string) =>
  sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value ?? null;

/** Runs the import into the install `name`, and reads what it holds after. */
const importInto = (name: string, before?: (sql: SqlStorage, instance: Instance) => void) =>
  runInDurableObject(env.KITSHN.getByName(name), async (object, durable) => {
    const instance = object as unknown as Instance;
    before?.(durable.storage.sql, instance);
    const refused = await instance.runImport("run-1");
    const sql = durable.storage.sql;
    return {
      refused,
      status: meta(sql, "import_status"),
      circles: sql
        .exec<{ id: string }>("SELECT id FROM circles ORDER BY id")
        .toArray()
        .map((row) => row.id),
      icon:
        sql.exec<{ bytes: ArrayBuffer }>("SELECT bytes FROM icons WHERE id = 'c'").toArray()[0]?.bytes ??
        null,
      history: sql
        .exec<{ summary: string }>("SELECT summary FROM revisions")
        .toArray()
        .map((row) => row.summary),
      version: meta(sql, "schema_version"),
    };
  });

describe("state import (K-1833)", () => {
  it("rebuilds an empty install with its BLOBs, and stores done with the rows", async () => {
    await upload(await exportOf("source-a"));
    const after = await importInto("target-a");
    expect(after.refused).toBeNull();
    expect(JSON.parse(after.status ?? "null")).toEqual({ state: "done" });
    expect(after.circles).toContain("friends");
    expect(new Uint8Array(after.icon!)).toEqual(ICON);
    // The History of the export comes along, and the import is its newest row.
    expect(after.history.at(-1)).toMatch(/^Imported the state of 1970-01-01T00:00:01.000Z/);
    expect(after.version).toBe(String(MIGRATIONS.length));
  });

  it("stays done when a step after the import fails, and the next start finishes it", async () => {
    await upload(await exportOf("source-f"));
    const result = await runInDurableObject(env.KITSHN.getByName("target-f"), async (object, durable) => {
      const instance = object as unknown as Instance;
      const rotate = vi.spyOn(instance, "rotatePassKey").mockRejectedValueOnce(new Error("no key yet"));
      expect(await instance.runImport("run-1")).toBeNull();
      await instance.finishImport();
      const failed = {
        status: meta(durable.storage.sql, "import_status"),
        due: meta(durable.storage.sql, "import_finish"),
      };
      await instance.finishImport();
      return { failed, due: meta(durable.storage.sql, "import_finish"), calls: rotate.mock.calls.length };
    });
    expect(JSON.parse(result.failed.status ?? "null")).toEqual({ state: "done" });
    expect(result.failed.due).toBe("due");
    expect([result.due, result.calls]).toEqual([null, 2]);
    expect(await env.BUCKET!.head(IMPORT_OBJECT)).toBeNull();
  });

  it("imports an export of an older schema and runs the later migrations", async () => {
    const full = await exportOf("source-b");
    const old: StateExport = {
      ...full,
      schemaVersion: 20,
      tables: {
        circles: full.tables["circles"]!,
        resources: full.tables["resources"]!,
        places: full.tables["places"]!,
        meta: [{ key: "schema_version", value: "20" }],
      },
    };
    await upload(old);
    const after = await importInto("target-b");
    expect(after.refused).toBeNull();
    expect(after.version).toBe(String(MIGRATIONS.length));
  });

  it("moves a card out of a square corner on an export from before K-536, so it keeps its circles", async () => {
    const full = await exportOf("source-s");
    const corner = {
      id: "corner",
      kind: "file",
      name: "corner.pdf",
      addresses: [],
      status: "running",
      group: null,
      machine: null,
    };
    // 170 from the centre of Friends on both axes: outside the round circle of r 200, inside its square.
    const old: StateExport = {
      ...full,
      schemaVersion: SQUARE_MIGRATION - 1,
      tables: {
        ...full.tables,
        resources: [...full.tables["resources"]!, { id: corner.id, body: JSON.stringify(corner) }],
        places: [...full.tables["places"]!, { id: corner.id, x: 1070, y: 1070 }],
        meta: [{ key: "schema_version", value: String(SQUARE_MIGRATION - 1) }],
      },
    };
    await upload(old);
    const after = await importInto("target-s");
    expect(after.refused).toBeNull();
    const place = await runInDurableObject(env.KITSHN.getByName("target-s"), (_, durable) =>
      durable.storage.sql.exec<{ x: number; y: number }>("SELECT x, y FROM places WHERE id = 'corner'").one(),
    );
    expect(insideCircle(place, circle)).toBe(false);
    expect(after.history).toContain("Moved 1 card out of square corners, so each keeps its circles (K-536)");
  });

  it("refuses with a fixed code, and changes nothing", async () => {
    const state = await exportOf("source-c");
    const refusals: Array<[unknown, string, ((sql: SqlStorage) => void)?]> = [
      [{ ...state, account: "another-account" }, "other_account"],
      [{ ...state, schemaVersion: MIGRATIONS.length + 1 }, "newer_schema"],
      [state, "not_empty", (sql) => sql.exec("INSERT INTO machines (id, body) VALUES ('m', '{}')")],
      [{ ...state, tables: { ...state.tables, strange: [{ id: "x" }] } }, "unknown_table"],
      [{ format: "something else" }, "bad_file"],
    ];
    for (const [index, [file, code, before]] of refusals.entries()) {
      await upload(file);
      const after = await importInto(`target-c${index}`, before);
      expect(after.refused?.code, after.refused?.detail).toBe(code);
      expect(after.circles).not.toContain("friends");
      expect(after.history).not.toContainEqual(expect.stringMatching(/^Imported/));
    }
  });
});

describe("refused import file (K-1833)", () => {
  it("deletes the import file from R2 after a refusal", async () => {
    await upload(await exportOf("source-r"));
    const status = await runInDurableObject(env.KITSHN.getByName("target-r"), async (object, durable) => {
      durable.storage.sql.exec("INSERT INTO machines (id, body) VALUES ('m', '{}')");
      await (object as unknown as Instance).importIfDue("run-1");
      return meta(durable.storage.sql, "import_status");
    });
    expect(JSON.parse(status ?? "null")).toEqual({ state: "refused", code: "not_empty" });
    expect(await env.BUCKET!.head(IMPORT_OBJECT)).toBeNull();
  });

  it("finishes a due import at a start without KITSHN_IMPORT_AT", async () => {
    const due = await runInDurableObject(env.KITSHN.getByName("target-u"), async (object, durable) => {
      const instance = object as unknown as Instance;
      const rotate = vi.spyOn(instance, "rotatePassKey").mockResolvedValue();
      durable.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('import_finish', 'due')");
      await instance.importIfDue(undefined);
      return { due: meta(durable.storage.sql, "import_finish"), calls: rotate.mock.calls.length };
    });
    expect(due).toEqual({ due: null, calls: 1 });
  });
});

describe("import status (K-1833)", () => {
  it("answers without a login with the state alone", async () => {
    const response = await send("/join/import-status");
    expect([response.status, await response.json()]).toEqual([200, { state: "none" }]);
  });
});
