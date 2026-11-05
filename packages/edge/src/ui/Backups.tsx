import { useEffect, useState } from "preact/hooks";
import { type BackupRun, gigabytes } from "../core/backups.ts";
import type { Resource } from "../core/model.ts";
import { useDialogEscape } from "./controls.tsx";
import { callApi } from "./store.ts";

// Two runs can fall in one minute, and the owner picks one to restore, so this time keeps its seconds.
const time = (at: number) => new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
const size = (bytes: number | null) =>
  bytes === null
    ? ""
    : bytes < 1000 ** 3
      ? `${Math.max(1, Math.round(bytes / 1000 ** 2))} MB`
      : gigabytes(bytes);

/** K-1819: one run in a line: its time, its size and its state. */
export function backupLabel(run: BackupRun) {
  const pause =
    run.pauseMs === null || run.pauseMs === 0
      ? ""
      : ` · paused ${Math.max(1, Math.round(run.pauseMs / 1000))} s`;
  return `${time(run.at)}${run.bytes === null ? "" : ` · ${size(run.bytes)}`}${pause}`;
}

/** K-1819: the sticker of a run. */
export function BackupState(props: { run: BackupRun }) {
  const { run } = props;
  return run.state === "failed" ? (
    <span class="sticker" data-tip={run.error ?? "The backup failed."}>
      backup failed
    </span>
  ) : run.state === "running" ? (
    <span class="sticker wait" data-tip="The machine runs this backup now, or runs it when it is online.">
      backing up
    </span>
  ) : (
    <span class="sticker ok" data-tip={`Added ${size(run.added) || "nothing"} to the repository.`}>
      backed up
    </span>
  );
}

/** K-1819, K-1820: the backup runs of a card, newest first, with Restore. */
export function BackupsDialog(props: {
  card: Resource;
  /** K-827: the name of a machine, so a card with several instances names the machine of each run. */
  machineName: (id: string) => string;
  onClose: () => void;
  onDone: (text: string, error: boolean) => void;
  ask: (text: string) => Promise<boolean>;
}) {
  const { card } = props;
  useDialogEscape(props.onClose);
  const base = `/api/apps/${encodeURIComponent(card.id)}/backups`;
  const [runs, setRuns] = useState<ReadonlyArray<BackupRun> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The dialog loads its list when it opens.
  useEffect(() => {
    void callApi<{ runs: Array<BackupRun> }>("GET", base).then((result) =>
      "error" in result ? setError(result.error) : setRuns(result.runs),
    );
  }, [base]);
  const restore = async (run: BackupRun) => {
    // K-1820: the confirm names the time of the run.
    const sure = await props.ask(
      `Restore ${card.name} to its backup of ${time(run.at)}? kitshn backs up the state of now first, stops the app, writes the backup back and starts the app.`,
    );
    if (!sure || busy) return;
    setBusy(true);
    const result = await callApi<{ before: string }>(
      "POST",
      `${base}/${encodeURIComponent(run.run)}/restore`,
    );
    setBusy(false);
    if ("error" in result) return props.onDone(result.error, true);
    props.onDone(`The restore of ${card.name} started. History records it when it ends.`, false);
    props.onClose();
  };
  return (
    <div class="scrim">
      <div class="dialog" role="dialog" aria-label={`Backups of ${card.name}`}>
        <div class="row">
          <b>Backups of {card.name}</b>
        </div>
        <p class="help">
          Daily backups of the volumes and the data folder: 7 daily, 4 weekly and 3 monthly runs stay.
        </p>
        {error ? <p class="error">{error}</p> : null}
        <ul>
          {(runs ?? []).map((run) => (
            <li key={run.run}>
              <div class="row">
                {(card.instances ?? []).length > 0 ? <span>{props.machineName(run.machineId)}</span> : null}
                <span>{backupLabel(run)}</span> <BackupState run={run} />
                {run.state === "done" ? (
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    data-tip={`Write this backup back. kitshn backs up the state of now first, as the way back.`}
                    onClick={() => void restore(run)}
                  >
                    Restore…
                  </button>
                ) : null}
              </div>
              {run.state === "failed" && run.error ? <p class="error">{run.error}</p> : null}
            </li>
          ))}
          {runs?.length === 0 ? (
            <li class="muted">No backup yet. The first runs tonight, or with Back up now.</li>
          ) : null}
        </ul>
        <button type="button" class="btn" data-tip="Close the backups." onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** K-1822: what "Restore kitshn to a time" sets aside while Access checks the passkey. */
export const RESTORE_KEY = "kitshn.restoreTime";
export type RestoreWish = { readonly label: string } & (
  { readonly at: number } | { readonly bookmark: string }
);

/** "2026-10-28 14:00" in local time; every browser reads the ISO form with a "T" as local time. */
const localTime = (text: string) => Date.parse(text.trim().replace(" ", "T"));

/** K-1822: the time to restore to; the passkey check and the confirm come after it. */
export function RestoreTimeDialog(props: { restoreUndo: string | null; onClose: () => void }) {
  useDialogEscape(props.onClose);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = (wish: RestoreWish) => {
    sessionStorage.setItem(RESTORE_KEY, JSON.stringify(wish));
    location.assign("/api/fresh/start?then=restore");
  };
  const submit = () => {
    const at = localTime(text);
    if (Number.isNaN(at) || at >= Date.now() || at < Date.now() - 30 * 24 * 3_600_000)
      return setError("Write a time of the past 30 days, such as 2026-10-28 14:00.");
    go({ at, label: time(at) });
  };
  return (
    <div class="scrim">
      <div class="dialog" role="dialog" aria-label="Restore kitshn to a time">
        <div class="row">
          <b>Restore kitshn to a time</b>
        </div>
        <p class="help">
          This rewinds everything that kitshn keeps to that time: cards, circles, shares, History, rollbacks,
          jobs and repos. Cloudflare follows at the next run. A second restore undoes it. It needs a fresh
          passkey.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            class="field"
            aria-label="Time"
            data-tip="A time of the past 30 days, in your time zone."
            placeholder="2026-10-28 14:00"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
          />
          {error ? <p class="error">{error}</p> : null}
          <div class="row">
            <button type="submit" class="btn danger" data-tip="Check the passkey, then confirm the time.">
              Continue with passkey
            </button>
            {props.restoreUndo ? (
              <button
                type="button"
                class="btn"
                data-tip="Go back to the state just before the last restore."
                onClick={() =>
                  go({ bookmark: props.restoreUndo!, label: "the state before the last restore" })
                }
              >
                Undo the last restore
              </button>
            ) : null}
            <button type="button" class="btn" data-tip="Close without a restore." onClick={props.onClose}>
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
