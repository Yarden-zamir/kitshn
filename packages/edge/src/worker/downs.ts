/**
 * K-909: the `compose-down` jobs of app removals (`removeData` false) in the jobs table. A removal down waits
 * for its machine however long, so these decide when it goes out again and when a newer job replaces it.
 */
type Sql = (query: string, ...bindings: Array<string | number | null>) => ReadonlyArray<unknown>;

const REMOVAL_DOWN = `json_extract(command, '$.kind') = 'compose-down' AND json_extract(command, '$.removeData') = 0`;

/**
 * Fails the queued removal downs of a project, for example when a deploy or an undo starts the app again. With a
 * machine, only the downs there: the stop of a dropped instance on another machine stays (K-825).
 */
export function failQueuedDowns(sql: Sql, project: string, output: string, machineId: string | null = null) {
  sql(
    `UPDATE jobs SET state = 'failed', output = ? WHERE state = 'queued' AND ${REMOVAL_DOWN}
     AND json_extract(command, '$.project') = ? AND (? IS NULL OR machine_id = ?)`,
    output,
    project,
    machineId,
    machineId,
  );
}

export const REPLACED = "A newer deploy replaced this removal (K-909).";

/**
 * A machine that lost or renewed its connection gets its sent downs again, because their result may never
 * come and a down can run twice without harm. A down with a newer job of the same project fails instead, so
 * it never stops that newer deploy.
 */
export function requeueDowns(sql: Sql, machineId: string) {
  const newer = `EXISTS (SELECT 1 FROM jobs AS newer WHERE newer.id > jobs.id
    AND json_extract(newer.command, '$.kind') IN ('compose', 'compose-redeploy', 'compose-rollback')
    AND json_extract(newer.command, '$.project') = json_extract(jobs.command, '$.project'))`;
  const sent = `machine_id = ? AND state = 'sent' AND json_extract(command, '$.kind') = 'compose-down'`;
  sql(`UPDATE jobs SET state = 'failed', output = ? WHERE ${sent} AND ${newer}`, REPLACED, machineId);
  sql(`UPDATE jobs SET state = 'queued' WHERE ${sent} AND NOT ${newer}`, machineId);
}

/**
 * A Compose card that comes back (undo, or a new card of a deploy) drops the live site row of its id. A stop
 * that already ran makes the machine's next report leave the site out, and that row would take the card
 * with it. Without the row, the next report that names the site makes it again, to be checked.
 */
export function dropLiveSite(sql: Sql, id: string) {
  sql("DELETE FROM live_sites WHERE id = ?", id);
}

/** The newest removal down of a project, or null. */
export function removalDown(
  sql: Sql,
  project: string,
): { readonly id: number; readonly state: "queued" | "sent" | "done" | "failed" | "expired" } | null {
  const [row] = sql(
    `SELECT id, state FROM jobs WHERE ${REMOVAL_DOWN} AND json_extract(command, '$.project') = ?
     ORDER BY id DESC LIMIT 1`,
    project,
  ) as Array<{ id: number; state: "queued" | "sent" | "done" | "failed" | "expired" }>;
  return row ?? null;
}
