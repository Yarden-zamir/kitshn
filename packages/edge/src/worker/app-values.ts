// K-830 to K-836: the store of app values in the Durable Object. A secret leaves it only for a deploy, a redeploy or a
// rollback (K-833, K-834); no read path, export, History row or snapshot holds it.
import type { Author } from "../core/changes.ts";
import type { StoredName, UsedValue, ValueKind } from "../core/values.ts";
import { open, seal } from "./seal.ts";

type Sql = <T extends Record<string, SqlStorageValue>>(
  query: string,
  ...bindings: Array<SqlStorageValue>
) => Array<T>;

interface ValueRow extends Record<string, SqlStorageValue> {
  set_key: string;
  name: string;
  kind: string;
  version: number;
  iv: ArrayBuffer | null;
  sealed: ArrayBuffer | null;
  plain: string | null;
  set_at: number;
  set_by: string;
}

/** K-832: what the map, the CLI and an agent read of a stored name. A var shows its value; a secret never does. */
export interface ValueView {
  readonly name: string;
  readonly kind: ValueKind;
  readonly version: number;
  readonly setAt: number;
  readonly setBy: Author;
  readonly value?: string;
}

const kindOf = (text: string): ValueKind => {
  if (text !== "secret" && text !== "var")
    throw new Error(`app_values holds the unknown kind ${text} (K-830).`);
  return text;
};

/** K-832: the bound data of a sealed value, so a blob that someone moves to another row does not open. */
const boundData = (setKey: string, name: string, version: number) => `${setKey}\n${name}\n${version}`;

/** K-832: the names of one value set with their kind and version, never a value. */
export function storedNames(sql: Sql, setKey: string): Map<string, StoredName> {
  return new Map(
    sql<{ name: string; kind: string; version: number }>(
      "SELECT name, kind, version FROM app_values WHERE set_key = ?",
      setKey,
    ).map((row) => [row.name, { kind: kindOf(row.kind), version: row.version }]),
  );
}

/** K-832: every stored name of the given sets, for the Values view. Secret rows come without their sealed bytes. */
export function valueViews(sql: Sql, setKeys: ReadonlyArray<string> | null): Map<string, Array<ValueView>> {
  const rows = sql<{
    set_key: string;
    name: string;
    kind: string;
    version: number;
    plain: string | null;
    set_at: number;
    set_by: string;
  }>("SELECT set_key, name, kind, version, plain, set_at, set_by FROM app_values ORDER BY set_key, name");
  const views = new Map<string, Array<ValueView>>();
  for (const row of rows) {
    if (setKeys !== null && !setKeys.includes(row.set_key)) continue;
    const kind = kindOf(row.kind);
    const view: ValueView = {
      name: row.name,
      kind,
      version: row.version,
      setAt: row.set_at,
      setBy: JSON.parse(row.set_by) as Author,
      ...(kind === "var" && row.plain !== null ? { value: row.plain } : {}),
    };
    views.set(row.set_key, [...(views.get(row.set_key) ?? []), view]);
  }
  return views;
}

/** K-832: writes one value. A secret is sealed under `key`; a var is stored as text, because it is not secret. */
export async function writeValue(
  key: CryptoKey | null,
  setKey: string,
  name: string,
  kind: ValueKind,
  value: string,
  version: number,
): Promise<(sql: Sql, at: number, by: Author) => void> {
  if (kind === "var")
    return (sql, at, by) =>
      sql(
        `INSERT OR REPLACE INTO app_values (set_key, name, kind, version, iv, sealed, plain, set_at, set_by)
         VALUES (?, ?, 'var', ?, NULL, NULL, ?, ?, ?)`,
        setKey,
        name,
        version,
        value,
        at,
        JSON.stringify(by),
      );
  if (key === null) throw new Error(NO_KEY);
  const box = await seal(key, value, boundData(setKey, name, version));
  return (sql, at, by) =>
    sql(
      `INSERT OR REPLACE INTO app_values (set_key, name, kind, version, iv, sealed, plain, set_at, set_by)
       VALUES (?, ?, 'secret', ?, ?, ?, NULL, ?, ?)`,
      setKey,
      name,
      version,
      // Both arrays own their whole buffer: `seal` makes them new.
      box.iv.buffer as ArrayBuffer,
      box.sealed.buffer as ArrayBuffer,
      at,
      JSON.stringify(by),
    );
}

export const NO_KEY =
  "kitshn has no Worker secret KITSHN_SECRETS_KEY, so it keeps no secret values. Run the bootstrap again; it makes the key (K-1201, K-832).";

/** K-833, K-834: one delivered value. `secret` marks a value that the job output hides. */
export interface Delivered {
  readonly name: string;
  readonly value: string;
  readonly secret: boolean;
}

/**
 * K-831, K-833: the store values of the names that `used` takes from kitshn, read now. A name that is gone, changed
 * kind, or does not open is missing; the caller stops the deploy with it. `used` gets the versions of now.
 */
export async function deliverValues(
  sql: Sql,
  key: CryptoKey | null,
  setKey: string,
  used: ReadonlyArray<UsedValue>,
): Promise<
  | { readonly values: ReadonlyArray<Delivered>; readonly used: ReadonlyArray<UsedValue> }
  | {
      readonly missing: ReadonlyArray<{
        readonly name: string;
        readonly kind: ValueKind;
        readonly why: "missing" | "kind";
      }>;
      readonly reason: string | null;
    }
> {
  const wanted = used.filter((item) => item.source === "kitshn");
  if (wanted.length === 0) return { values: [], used };
  const rows = new Map(
    sql<ValueRow>("SELECT * FROM app_values WHERE set_key = ?", setKey).map((row) => [row.name, row]),
  );
  const values: Array<Delivered> = [];
  const missing: Array<{ name: string; kind: ValueKind; why: "missing" | "kind" }> = [];
  const versions = new Map<string, number>();
  let reason: string | null = null;
  for (const item of wanted) {
    const row = rows.get(item.name);
    if (row === undefined) {
      missing.push({ name: item.name, kind: item.kind, why: "missing" });
      continue;
    }
    if (kindOf(row.kind) !== item.kind) {
      missing.push({ name: item.name, kind: item.kind, why: "kind" });
      continue;
    }
    versions.set(item.name, row.version);
    if (item.kind === "var") {
      values.push({ name: item.name, value: row.plain ?? "", secret: false });
      continue;
    }
    if (key === null || row.iv === null || row.sealed === null) {
      reason = NO_KEY;
      missing.push({ name: item.name, kind: item.kind, why: "missing" });
      continue;
    }
    try {
      const value = await open(
        key,
        { iv: new Uint8Array(row.iv), sealed: new Uint8Array(row.sealed) },
        boundData(setKey, item.name, row.version),
      );
      values.push({ name: item.name, value, secret: true });
    } catch {
      // K-832: another key, or a blob of another row: the value counts as missing, and kitshn says why.
      reason = `kitshn cannot open the secret ${item.name} with its KITSHN_SECRETS_KEY; set it again (K-832).`;
      missing.push({ name: item.name, kind: item.kind, why: "missing" });
    }
  }
  if (missing.length > 0) return { missing, reason };
  return {
    values,
    used: used.map((item) =>
      item.source === "kitshn" ? { ...item, version: versions.get(item.name) ?? null } : item,
    ),
  };
}
