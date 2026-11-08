// K-1818, K-1821, K-1831: the bucket size, and the daily copy of the Durable Object state in R2.
import type { BucketSize } from "../core/backups.ts";

/**
 * K-1831: tables that the export leaves out because a rebuild does not need them: one-time codes, the jobs, the
 * nonces of forwarded calls (K-1714), and `deploy_cards`, which the triggers of `deploys` fill again on import.
 */
const LEFT_OUT = new Set([
  "join_codes",
  "rekey_codes",
  "device_invites",
  "jobs",
  "forward_nonces",
  "deploy_cards",
]);

/**
 * K-1831: every secret that the Durable Object keeps, which no export and no R2 copy may hold. A whole table, or the
 * `meta` keys that start with a prefix. A new secret is one line here; the test checks each line.
 */
export const SECRET_ROWS: ReadonlyArray<{ readonly table: string } | { readonly metaPrefix: string }> = [
  // K-1771: the pass key of section 17.
  { table: "pass_keys" },
  { table: "github_tokens" },
  { metaPrefix: "pass_key" },
  // K-1907: the VAPID private key of Web Push, and the subscriptions, whose endpoints and auth secrets are keys too.
  { metaPrefix: "push_vapid_jwk" },
  { table: "push_subscriptions" },
  // K-832: the app values. After an import, every name is missing until the owner sets it again.
  { table: "app_values" },
];

const secretTables = new Set(SECRET_ROWS.flatMap((row) => ("table" in row ? [row.table] : [])));
const secretMeta = SECRET_ROWS.flatMap((row) => ("metaPrefix" in row ? [row.metaPrefix] : []));

/** K-1821: the newest copies that stay in R2. */
export const EXPORTS_KEPT = 30;
export const EXPORT_PREFIX = "state/";

/** K-1831: the export format of the whole state; the import of queue item 3 reads it. */
export interface StateExport {
  readonly format: "kitshn-state";
  readonly version: 1;
  /** K-1833: the Cloudflare account of the install; an import works only into the same one. */
  readonly account: string;
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly tables: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

const base64 = (bytes: ArrayBuffer) => {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
};

/** K-1831: every row of every table but the left-out ones; a BLOB becomes `{"base64": ...}`. */
export function stateExport(
  sql: SqlStorage,
  account: string,
  schemaVersion: number,
  now: number,
): StateExport {
  const names = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name)
    .filter((name) => !LEFT_OUT.has(name) && !secretTables.has(name));
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const name of names)
    tables[name] = sql
      .exec(`SELECT * FROM "${name}"`)
      .toArray()
      .filter((row) => name !== "meta" || !secretMeta.some((prefix) => String(row["key"]).startsWith(prefix)))
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            value instanceof ArrayBuffer ? { base64: base64(value) } : value,
          ]),
        ),
      );
  return { format: "kitshn-state", version: 1, account, schemaVersion, exportedAt: now, tables };
}

/** K-1818: the size of every object of the bucket, by listing it. */
export async function bucketSize(bucket: R2Bucket, now: number): Promise<BucketSize> {
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { cursor } : {});
    for (const object of page.objects) bytes += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { bytes, at: now };
}

/** K-1821: writes the export as gzip JSON, and deletes the copies beyond the newest 30. */
export async function writeExport(bucket: R2Bucket, state: StateExport): Promise<string> {
  const key = `${EXPORT_PREFIX}${new Date(state.exportedAt).toISOString().slice(0, 10)}.json.gz`;
  const gzip = new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream("gzip"));
  // R2 needs the length of a stream, so the small gzip file is read whole first.
  await bucket.put(key, await new Response(gzip).arrayBuffer(), {
    httpMetadata: { contentType: "application/gzip" },
  });
  const listed = await bucket.list({ prefix: EXPORT_PREFIX });
  const old = listed.objects
    .map((object) => object.key)
    .filter((name) => name.endsWith(".json.gz"))
    .sort()
    .slice(0, -EXPORTS_KEPT);
  if (old.length > 0) await bucket.delete(old);
  return key;
}
