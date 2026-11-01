import { TOKEN_PERMISSIONS } from "./token.ts";

/** K-1303: the free plan limits of the account that the Usage view measures, and how to read the raw numbers. */

/** Daily limits reset at 00:00 UTC, monthly ones on the first of the month; "now" is a count or a size now. */
export type UsagePeriod = "day" | "month" | "now";

export interface UsageRow {
  readonly label: string;
  /** Null when kitshn could not read the value; `error` says why. Never 0 for "unknown". */
  readonly used: number | null;
  readonly limit: number;
  readonly period: UsagePeriod;
  readonly unit: "count" | "bytes";
  /** The Cloudflare page that names the limit. */
  readonly docs: string;
  /** How kitshn counts the value, when that is not plain. */
  readonly note?: string;
  readonly error?: string;
}

export interface Usage {
  /** When kitshn read the numbers; it keeps them for 5 minutes (K-1305). */
  readonly at: number;
  readonly rows: ReadonlyArray<UsageRow>;
  /** K-1304: the Worker answered, because the Durable Object of kitshn failed, with its reason. */
  readonly kitshnDown?: string;
}

/** K-1303: a row warns at 80% of its limit. */
export const USAGE_WARNING = 0.8;

export const usageLevel = (row: UsageRow): "unknown" | "ok" | "warn" | "full" =>
  row.used === null
    ? "unknown"
    : row.used >= row.limit
      ? "full"
      : row.used >= row.limit * USAGE_WARNING
        ? "warn"
        : "ok";

const GB = 1_000_000_000;
const DO_DOCS = "https://developers.cloudflare.com/durable-objects/platform/pricing/";
const D1_DOCS = "https://developers.cloudflare.com/d1/platform/pricing/";
const KV_DOCS = "https://developers.cloudflare.com/kv/platform/pricing/";
const R2_DOCS = "https://developers.cloudflare.com/r2/pricing/";
const ACCESS_DOCS = "https://developers.cloudflare.com/cloudflare-one/account-limits/";
const DNS_DOCS = "https://developers.cloudflare.com/dns/faq/";

/** K-1305: the permission that each part of the view needs on the API token. */
export const PERMISSION = {
  analytics: TOKEN_PERMISSIONS.accountAnalytics.label,
  seats: TOKEN_PERMISSIONS.accessAuditLogs.label,
  applications: TOKEN_PERMISSIONS.accessApps.label,
  serviceTokens: TOKEN_PERMISSIONS.accessServiceTokens.label,
  scripts: TOKEN_PERMISSIONS.workersScripts.label,
  dns: TOKEN_PERMISSIONS.dns.label,
  zone: TOKEN_PERMISSIONS.zone.label,
} as const;

type Sum<T extends string> = { readonly sum: Readonly<Record<T, number>> };
type Max<T extends string> = { readonly max: Readonly<Record<T, number>> };
type Action = { readonly dimensions: { readonly actionType: string } };
type Invocation = Sum<"requests"> & { readonly dimensions: { readonly type: string } };

/** One dataset of `USAGE_QUERY`; null when Cloudflare refused it (the answer then has an error for its alias). */
type Dataset<T> = ReadonlyArray<T> | null | undefined;

/** The answer of the one GraphQL Analytics query of K-1303 (`USAGE_QUERY`), by alias. */
export interface Analytics {
  readonly workers?: Dataset<Sum<"requests">>;
  readonly objects?: Dataset<Invocation>;
  readonly rows?: Dataset<Sum<"rowsRead" | "rowsWritten">>;
  readonly objectStorage?: Dataset<Max<"storedBytes">>;
  readonly d1?: Dataset<Sum<"rowsRead" | "rowsWritten">>;
  readonly d1Storage?: Dataset<Max<"databaseSizeBytes">>;
  readonly kv?: Dataset<Sum<"requests"> & Action>;
  readonly kvStorage?: Dataset<Max<"byteCount">>;
  readonly r2?: Dataset<Sum<"requests"> & Action>;
  readonly r2Storage?: Dataset<Max<"payloadSize" | "metadataSize">>;
}

/**
 * Daily datasets filter on `$day`, monthly R2 operations on `$monthSince`. A storage dataset has one group per
 * Durable Object namespace, database, KV namespace or bucket; kitshn adds them up.
 * Known limit: the R2 free operations count per calendar month, while Cloudflare counts per billing month.
 */
export const USAGE_QUERY = `query ($account: String!, $day: Date!, $since: Time!, $monthSince: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } }
    objects: durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: { date: $day }) { sum { requests } dimensions { type } }
    rows: durableObjectsPeriodicGroups(limit: 1, filter: { date: $day }) { sum { rowsRead rowsWritten } }
    objectStorage: durableObjectsSqlStorageGroups(limit: 1000, filter: { date: $day }) { max { storedBytes } dimensions { namespaceId } }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date: $day }) { sum { rowsRead rowsWritten } }
    d1Storage: d1StorageAdaptiveGroups(limit: 1000, filter: { date: $day }) { max { databaseSizeBytes } dimensions { databaseId } }
    kv: kvOperationsAdaptiveGroups(limit: 10, filter: { date: $day }) { sum { requests } dimensions { actionType } }
    kvStorage: kvStorageAdaptiveGroups(limit: 1000, filter: { date: $day }) { max { byteCount } dimensions { namespaceId } }
    r2: r2OperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $monthSince, datetime_leq: $until }) { sum { requests } dimensions { actionType } }
    r2Storage: r2StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $since, datetime_leq: $until }) { max { payloadSize metadataSize } dimensions { bucketName } }
  } }
}`;

/** The variables of `USAGE_QUERY` at `now`. */
export function usageVariables(account: string, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    account,
    day,
    since: `${day}T00:00:00Z`,
    monthSince: `${day.slice(0, 7)}-01T00:00:00Z`,
    until: new Date(now).toISOString(),
  };
}

/** R2 classes from the [pricing page](https://developers.cloudflare.com/r2/pricing/); the free ones count in neither. */
const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

/** The [pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/) bills incoming WebSocket messages 20:1. */
const WEBSOCKET_RATIO = 20;

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

/** A value, or the reason that it is missing. */
export type Read = { readonly used: number } | { readonly error: string };

function row(
  label: string,
  read: Read,
  limit: number,
  period: UsagePeriod,
  unit: UsageRow["unit"],
  docs: string,
  note?: string,
): UsageRow {
  return {
    label,
    limit,
    period,
    unit,
    docs,
    ...("used" in read ? { used: read.used } : { used: null, error: read.error }),
    ...(note ? { note } : {}),
  };
}

/**
 * The rows from the analytics. `errors` holds the GraphQL error of each refused alias. Operations: no group means
 * no operation today, so 0. Storage: no group means that Cloudflare has no value yet, so unknown, never 0.
 */
export function analyticsRows(data: Analytics, errors: Readonly<Record<string, string>>): Array<UsageRow> {
  const refused = (alias: keyof Analytics): Read => ({
    error: `Cloudflare sent no value (needs ${PERMISSION.analytics}): ${errors[alias] ?? "no reason given"}`,
  });
  const operations = <T>(
    groups: Dataset<T>,
    alias: keyof Analytics,
    read: (groups: ReadonlyArray<T>) => number,
  ) => (groups ? { used: read(groups) } : refused(alias));
  const storage = <T>(groups: Dataset<T>, alias: keyof Analytics, read: (group: T) => number): Read => {
    if (!groups) return refused(alias);
    if (groups.length === 0) return { error: "Cloudflare has no value for today yet." };
    return { used: sum(groups.map(read)) };
  };
  const kv = (action: string) =>
    operations(data.kv, "kv", (groups) =>
      sum(
        groups.filter((group) => group.dimensions.actionType === action).map((group) => group.sum.requests),
      ),
    );
  // An action that the pricing page does not name counts as class A, the smaller limit, and the bar says so.
  const unknownR2 = [...new Set((data.r2 ?? []).map((group) => group.dimensions.actionType))].filter(
    (action) => !R2_CLASS_A.has(action) && !R2_CLASS_B.has(action) && !R2_FREE.has(action),
  );
  const r2 = (counts: (action: string) => boolean) =>
    operations(data.r2, "r2", (groups) =>
      sum(groups.filter((group) => counts(group.dimensions.actionType)).map((group) => group.sum.requests)),
    );
  return [
    row(
      "Durable Object rows read",
      operations(data.rows, "rows", (groups) => sum(groups.map((group) => group.sum.rowsRead))),
      5_000_000,
      "day",
      "count",
      DO_DOCS,
    ),
    row(
      "Durable Object rows written",
      operations(data.rows, "rows", (groups) => sum(groups.map((group) => group.sum.rowsWritten))),
      100_000,
      "day",
      "count",
      DO_DOCS,
    ),
    row(
      "Worker requests",
      operations(data.workers, "workers", (groups) => sum(groups.map((group) => group.sum.requests))),
      100_000,
      "day",
      "count",
      "https://developers.cloudflare.com/workers/platform/limits/",
    ),
    row(
      "Durable Object requests",
      operations(data.objects, "objects", (groups) =>
        Math.ceil(
          sum(
            groups.map((group) =>
              // "hibernation" counts the WebSocket messages of a hibernating object, one each (checked 2026-10-28).
              group.dimensions.type === "hibernation"
                ? group.sum.requests / WEBSOCKET_RATIO
                : group.sum.requests,
            ),
          ),
        ),
      ),
      100_000,
      "day",
      "count",
      DO_DOCS,
      "Incoming WebSocket messages count 20:1, as on the bill.",
    ),
    row(
      "Durable Object storage",
      storage(data.objectStorage, "objectStorage", (group) => group.max.storedBytes),
      5 * GB,
      "now",
      "bytes",
      DO_DOCS,
    ),
    row(
      "D1 rows read",
      operations(data.d1, "d1", (groups) => sum(groups.map((group) => group.sum.rowsRead))),
      5_000_000,
      "day",
      "count",
      D1_DOCS,
    ),
    row(
      "D1 rows written",
      operations(data.d1, "d1", (groups) => sum(groups.map((group) => group.sum.rowsWritten))),
      100_000,
      "day",
      "count",
      D1_DOCS,
    ),
    row(
      "D1 storage",
      storage(data.d1Storage, "d1Storage", (group) => group.max.databaseSizeBytes),
      5 * GB,
      "now",
      "bytes",
      D1_DOCS,
    ),
    row("KV reads", kv("read"), 100_000, "day", "count", KV_DOCS),
    row("KV writes", kv("write"), 1_000, "day", "count", KV_DOCS),
    row("KV deletes", kv("delete"), 1_000, "day", "count", KV_DOCS),
    row("KV lists", kv("list"), 1_000, "day", "count", KV_DOCS),
    row(
      "KV storage",
      storage(data.kvStorage, "kvStorage", (group) => group.max.byteCount),
      1 * GB,
      "now",
      "bytes",
      KV_DOCS,
    ),
    row(
      "R2 class A operations",
      r2((action) => R2_CLASS_A.has(action) || unknownR2.includes(action)),
      1_000_000,
      "month",
      "count",
      R2_DOCS,
      unknownR2.length > 0
        ? `Counts ${unknownR2.join(", ")} as class A, because the pricing page does not name them.`
        : undefined,
    ),
    row(
      "R2 class B operations",
      r2((action) => R2_CLASS_B.has(action)),
      10_000_000,
      "month",
      "count",
      R2_DOCS,
    ),
    row(
      "R2 storage",
      storage(data.r2Storage, "r2Storage", (group) => group.max.payloadSize + group.max.metadataSize),
      10 * GB,
      "now",
      "bytes",
      R2_DOCS,
    ),
  ];
}

/** The counts that the REST API gives; each one fails on its own. */
export interface Counts {
  readonly seats: Read;
  readonly applications: Read;
  readonly serviceTokens: Read;
  readonly scripts: Read;
  /** Each zone with its records and its creation date, which sets its limit (K-1111). */
  readonly zones: ReadonlyArray<{ readonly name: string; readonly records: Read; readonly createdOn: Read }>;
}

/** K-1111: 200 records for a Free zone made after 2024-09-01, else 1,000. `createdOn` is an ISO time. */
export const dnsLimit = (createdOn: string) => (createdOn >= "2024-09-01" ? 200 : 1_000);

export function countRows(counts: Counts): Array<UsageRow> {
  const now = (label: string, read: Read, limit: number, docs: string) =>
    row(label, read, limit, "now", "count", docs);
  return [
    now(
      "Access seats",
      counts.seats,
      50,
      "https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/",
    ),
    now("Access applications", counts.applications, 500, ACCESS_DOCS),
    now("Access service tokens", counts.serviceTokens, 50, ACCESS_DOCS),
    now("Worker scripts", counts.scripts, 100, "https://developers.cloudflare.com/workers/platform/limits/"),
    ...counts.zones.map((zone) =>
      "used" in zone.createdOn
        ? now(
            `DNS records of ${zone.name}`,
            zone.records,
            dnsLimit(new Date(zone.createdOn.used).toISOString()),
            DNS_DOCS,
          )
        : // Without the date the limit is unknown; 200 is the smaller one, so the bar does not hide a full zone.
          now(`DNS records of ${zone.name}`, { error: zone.createdOn.error }, 200, DNS_DOCS),
    ),
  ];
}

/**
 * K-1303, K-1818: the `kitshn` bucket on its own, from the size that the daily backup run measures. Backups wait at
 * 8 GB (K-1818), which is the warning at 80% of the 10 GB of the free plan.
 */
export function bucketRow(size: { readonly bytes: number; readonly at: number }): UsageRow {
  return {
    label: "R2 bucket kitshn",
    used: size.bytes,
    limit: 10 * GB,
    period: "now",
    unit: "bytes",
    docs: R2_DOCS,
    note: `Measured ${new Date(size.at).toISOString().slice(0, 16).replace("T", " ")} UTC by the daily backup run; backups wait at 8 GB.`,
  };
}

/** The rows with the bucket row right after the account's R2 storage, when the daily run measured the bucket. */
export function withBucket(
  rows: ReadonlyArray<UsageRow>,
  size: { readonly bytes: number; readonly at: number } | null,
) {
  if (size === null) return rows;
  const at = rows.findIndex((row) => row.label === "R2 storage");
  return at === -1
    ? [...rows, bucketRow(size)]
    : [...rows.slice(0, at + 1), bucketRow(size), ...rows.slice(at + 1)];
}
