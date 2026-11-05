// K-1811 to K-1822: backups of Compose cards and of the Durable Object. Shared by the Worker, the map and the daemon.

/** K-1819: one backup run of a card, as the `backups` table keeps it. */
export interface BackupRun {
  readonly run: string;
  readonly card: string;
  readonly machineId: string;
  readonly at: number;
  readonly state: "running" | "done" | "failed";
  /** The bytes of the volumes and the data folder that the run read. */
  readonly bytes: number | null;
  /** The bytes that the run added to the repository after deduplication and compression. */
  readonly added: number | null;
  readonly error: string | null;
  /** K-1816: how long the app was paused for this run, in milliseconds. */
  readonly pauseMs: number | null;
}

/** K-1817: what the daemon reports at the end of a backup job. */
export interface BackupReport {
  readonly run: string;
  readonly bytes: number;
  readonly added: number;
  /** K-1820: the volumes and the data folder of the run, which a restore needs to find again. */
  readonly sources: ReadonlyArray<string>;
  /** K-1817: the runs that the repository holds after the retention; absent on the first step of a restore. */
  readonly kept?: ReadonlyArray<string>;
  /** K-1816: how long the app was paused, in milliseconds. */
  readonly pauseMs: number;
}

/**
 * K-1816: the paused pass may take 3 times the last one, from 30 to 90 seconds. 90 s stays under the 100 s that
 * Cloudflare waits for an answer, so a request that waits on the pause still gets one.
 */
export function pauseLimit(lastPauseMs: number | null): number {
  const most = 90_000;
  return lastPauseMs === null ? most : Math.min(most, Math.max(30_000, 3 * lastPauseMs));
}

/**
 * K-827: the repository of an instance: `<card>` for the home one, `<card>@<machine id>` for another, so the
 * retention and a restore of one instance never touch another. Card and machine ids have no `@`.
 */
export const instanceRepository = (card: string, machineId: string | null) =>
  machineId === null ? card : `${card}@${machineId}`;

/** K-827: the card and the machine of an instance repository; the machine is null for the home one. */
export function repositoryParts(repository: string): {
  readonly card: string;
  readonly machineId: string | null;
} {
  const at = repository.indexOf("@");
  return at < 0
    ? { card: repository, machineId: null }
    : { card: repository.slice(0, at), machineId: repository.slice(at + 1) };
}

/** K-1817: the nightly backups start at 03:00 UTC, a quiet hour. */
export function nextBackupAt(now: number): number {
  const day = 24 * 3_600_000;
  const today = Math.floor(now / day) * day + 3 * 3_600_000;
  return today > now ? today : today + day;
}

/** K-1818: the free plan holds 10 GB of R2; backups wait at 8 GB. */
export const R2_FREE_BYTES = 10 * 1000 ** 3;
export const BACKUP_LIMIT_BYTES = 8 * 1000 ** 3;

/** K-1818: the size of the `kitshn` bucket, as the daily run measured it. */
export interface BucketSize {
  readonly bytes: number;
  readonly at: number;
}

/** K-1817 */
export const BACKUP_POLICY = ["--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "3"] as const;

/** K-1813: restic writes packs of at most this many MiB, under the 100 MB request body limit. */
export const PACK_MIB = 32;

/** K-1813: the restic REST paths that the Worker serves, below `backups/<card>/`. */
export const RESTIC_TYPES = ["data", "keys", "locks", "snapshots", "index"] as const;
export type ResticType = (typeof RESTIC_TYPES)[number];

/**
 * K-1813: the R2 key of a restic REST path, or null for a path outside the protocol. `config` is one file; each
 * other type is a folder of files named by their hex id.
 */
export function resticObject(card: string, path: string): { key: string } | { list: string } | null {
  const parts = path.split("/").filter((part) => part !== "");
  const base = `backups/${card}/`;
  if (parts.length === 1 && parts[0] === "config") return { key: `${base}config` };
  const [type, name] = parts;
  if (!RESTIC_TYPES.includes(type as ResticType)) return null;
  if (parts.length === 1) return { list: `${base}${type}/` };
  if (parts.length === 2 && name !== undefined && /^[0-9a-f]{64}$/.test(name))
    return { key: `${base}${type}/${name}` };
  return null;
}

/** K-1818: "1.2 GB" in decimal units, as Cloudflare counts R2. */
export const gigabytes = (bytes: number) => `${(bytes / 1000 ** 3).toFixed(1)} GB`;

/** K-538: the action of "Back up now" on its card. */
export const BACK_UP_NOW = "Back up now";

/**
 * K-1819, K-538: false while the card's latest action is a failed "Back up now", whose sticker already says that the
 * backup failed. The daily backups have no such action, so their failure keeps the K-1819 sticker.
 */
export const backupFailureShown = (
  run: Pick<BackupRun, "state">,
  action: { readonly action: string; readonly outcome: { readonly state: string } } | null,
) => !(run.state === "failed" && action?.action === BACK_UP_NOW && action.outcome.state === "failed");
