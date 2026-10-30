import { useMemo, useState } from "preact/hooks";
import type { Command } from "../core/machine.ts";
import type { State } from "../core/model.ts";
import type { JobView, MachineView } from "../core/protocol.ts";
import { isRelease, restartsAfterUpdate } from "../core/autoUpdate.ts";
import { type HealthCell, healthCell, healthProblems } from "../core/health.ts";
import { ProgressSticker } from "./Progress.tsx";
import { MACHINE_TIPS, untilText } from "./actions.ts";
import { Switch, WhyOff, useDialogEscape } from "./controls.tsx";
import { connectChecklist, isNewMachine, machineProblems } from "./machine-signs.ts";
import { callApi, hiddenChecklists, useStore } from "./store.ts";

/** "5 min", "3 h", "2 d": how long ago a time was (K-515). */
export function ago(time: number | null, now = Date.now()): string {
  if (time === null) return "never";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

const JOB_TIPS: Record<JobView["state"], string> = {
  queued: "Queued: the job waits for the machine.",
  sent: "Sent: the machine has the job and runs it.",
  done: "Done: the job ended well.",
  failed: "Failed: the job ended with an error; the output says why.",
  expired: "Expired: the machine did not take the job before its expiry.",
};

const percent = (value: number | undefined) => (value === undefined ? "–" : `${Math.round(value * 100)}%`);

/** K-515: the presence sticker of a machine card. */
/** `time` off on a machine card: its live row says "seen … ago", and the shorter sticker keeps the foot on one line (K-515). */
export function PresenceSticker(props: { view: MachineView; time?: boolean }) {
  return props.view.online ? (
    <span class="sticker ok presence" data-tip="Online: the daemon has a connection to kitshn now.">
      online
    </span>
  ) : (
    <span class="sticker presence" data-tip="Offline: the time since kitshn last heard from the daemon.">
      {props.time === false ? "offline" : `offline · ${ago(props.view.lastSeen)}`}
    </span>
  );
}

/**
 * K-515, K-1616: the live rows of a machine card, at a fixed height, so the card never grows over its neighbour when
 * the machine comes online or a sticker appears: the daemon line, CPU and memory bars from the newest sample (K-605),
 * and the stickers of its state. Offline, the bar row stays empty, because an old load is wrong.
 */
export function MachineLive(props: { view: MachineView; state: State }) {
  const { online, status, sample, lastSeen } = props.view;
  const daemon = status ? `daemon ${status.version} · ${status.os} ${status.arch}` : "no status yet";
  return (
    <div class="live">
      <div class="sub">{online ? daemon : `seen ${ago(lastSeen)} ago · ${daemon}`}</div>
      <div class="meters">
        {online && sample ? (
          <>
            <Meter label="CPU" value={sample.cpu} />
            <Meter label="Mem" value={sample.memory} />
          </>
        ) : null}
      </div>
      <div class="live-stickers">
        <MachineStickers view={props.view} state={props.state} />
      </div>
    </div>
  );
}

function Meter(props: { label: string; value: number }) {
  const share = Math.min(1, Math.max(0, props.value));
  return (
    <span
      class="meter"
      role="img"
      aria-label={`${props.label} ${percent(share)}`}
      data-tip={`${props.label} ${percent(share)} at the last sample, once a minute (K-605).`}
    >
      <span class="meter-label">{props.label}</span>
      <span class="meter-bar">
        <span class={share >= 0.9 ? "hot" : ""} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span class="meter-value">{percent(share)}</span>
    </span>
  );
}

/** The card starts a drag on a press; a link on it opens instead. */
const keepPress = (event: PointerEvent) => event.stopPropagation();

/**
 * K-515, K-1616, K-1902: the asks that the viewer may answer, the jobs that wait, and the daemon against the release
 * of the Worker. The ask comes first, so it stays in view on a narrow card. Each is a link where it acts: the version
 * to the panel with "Update daemon" (K-612).
 */
function MachineStickers(props: { view: MachineView; state: State }) {
  const { snapshot } = useStore();
  const { machine: own } = props.view;
  // A card renders on each frame of a pan, so this work waits for what it reads to change.
  const signs = useMemo(
    () => machineProblems(props.view, healthProblems(snapshot?.machines ?? [], own.id, Date.now())),
    [props.view, snapshot?.machines],
  );
  const steps = useMemo(
    () =>
      snapshot && isNewMachine(own, Date.now())
        ? connectChecklist(props.view, props.state, snapshot.access)
        : null,
    [props.view, props.state.resources, props.state.circles, snapshot?.access],
  );
  if (!snapshot) return null;
  const { machine, online, status } = props.view;
  const queued = snapshot.queuedJobs[machine.id] ?? 0;
  // The snapshot holds only the asks that this viewer may answer (K-1902).
  const asks = snapshot.proposals.filter((proposal) => proposal.machineId === machine.id).length;
  const panel = `#map/${encodeURIComponent(machine.id)}`;
  const update = props.view.update;
  // K-628: an update in progress or a failed one shows also while the daemon restarts or is offline.
  const version =
    update?.state === "updating" ? (
      <a
        class="sticker wait"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Updating: kitshn installs the daemon of edge-${snapshot.version}. Other machines wait for this one (K-627).`}
      >
        updating
      </a>
    ) : update?.state === "waiting" ? (
      <a
        class="sticker wait"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Update waits: busy, ${ago(Date.now(), update.until)} left. A provider of this machine reports busy, so kitshn updates the other machines first, and this one when it is idle, or ${untilText(update.until)} also while busy (K-627).`}
      >
        update waits
      </a>
    ) : update?.state === "failed" ? (
      <a
        class="sticker"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Update failed: ${update.reason} No other machine updates to edge-${snapshot.version} until this one does. Update daemon in its panel tries again.`}
      >
        update failed
      </a>
    ) : !online || !status || !isRelease(snapshot.version) ? null : !isRelease(status.version) ? (
      <span
        class="sticker info"
        tabIndex={0}
        data-tip={`From source: this daemon runs ${status.version}, not a release, so Update daemon refuses it. Pull its checkout and restart it.`}
      >
        source
      </span>
    ) : status.version === snapshot.version ? (
      <a
        class="sticker ok"
        href={panel}
        onPointerDown={keepPress}
        data-tip={
          update?.state === "updated"
            ? `Updated: kitshn updated this daemon to edge-${snapshot.version}, the release of the Worker (K-628).`
            : `Newest: the daemon runs edge-${snapshot.version}, the release of the Worker (K-617). Its panel has Update daemon.`
        }
      >
        {update?.state === "updated" ? "updated" : "newest"}
      </a>
    ) : (
      <a
        class="sticker wait"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Behind: the daemon runs edge-${status.version}, the Worker runs edge-${snapshot.version}. ${!restartsAfterUpdate(status) ? "This Windows daemon cannot start its task again after an update, so kitshn does not update it by itself. Update daemon in its panel installs it; then run schtasks /run /tn \\kitshn\\daemon on the PC (K-622)." : machine.autoUpdate === false ? "Update daemon in its panel installs it (K-612)." : "kitshn updates it when no other machine updates and no provider is busy (K-627)."}`}
      >
        behind
      </a>
    );
  return (
    <>
      {asks > 0 ? (
        <a
          class="sticker wait"
          href={`#notifications/${encodeURIComponent(machine.id)}`}
          onPointerDown={keepPress}
          data-tip={`An agent on ${machine.name} waits for your answer. The Inbox shows ${asks === 1 ? "its ask" : `its ${asks} asks`}.`}
        >
          {asks} needs you
        </a>
      ) : null}
      {signs[0] ? (
        <a
          class="sticker"
          href={panel}
          onPointerDown={keepPress}
          data-tip={signs.map((sign) => sign.long).join(" · ")}
        >
          {signs[0].short}
          {signs.length > 1 ? ` +${signs.length - 1}` : ""}
        </a>
      ) : null}
      {queued > 0 ? (
        <a
          class="sticker info"
          href="#machines"
          onPointerDown={keepPress}
          data-tip={`${queued} ${queued === 1 ? "job waits" : "jobs wait"} for this machine. The Machines view lists them.`}
        >
          {queued} queued
        </a>
      ) : null}
      {version}
      {/* Last: the row is clipped at two lines, and this one matters least. */}
      {steps && !steps.every((step) => step.done) && !hiddenChecklists().has(machine.id) ? (
        <a
          class="sticker info"
          href={panel}
          onPointerDown={keepPress}
          data-tip="Connect this machine: its panel lists the steps, and each ticks itself off."
        >
          connect {steps.filter((step) => step.done).length}/{steps.length}
        </a>
      ) : null}
    </>
  );
}

/** K-1708: a machine without a key, or one that waits for `kitshn rekey` (K-1706), shows it on its card. */
export function KeySticker(props: { view: MachineView }) {
  const key = props.view.machine.key;
  if (key === undefined)
    return (
      <span
        class="sticker wait"
        data-tip="Needs a key: it reports status but gets no job until kitshn rekey runs on it."
      >
        needs a key
      </span>
    );
  if (key.kind === "waiting")
    return (
      <span class="sticker wait" data-tip="Waits for key: run the rekey command on the machine.">
        waits for key
      </span>
    );
  return null;
}

/**
 * K-1608: an offline machine shows the pushes that wait for it. An online daemon that does not report what it applied,
 * one from before K-1608, shows "queued ?". An online daemon that reports it applies each push at once.
 */
export function QueuedSticker(props: { view: MachineView }) {
  const { online, queued } = props.view;
  if (online && queued === null)
    return (
      <span
        class="sticker wait"
        data-tip="Queued: this daemon is older than the queue and does not report what it applied, so kitshn cannot count what waits. Update the daemon."
      >
        queued ?
      </span>
    );
  if (online || queued === null || queued === 0) return null;
  return (
    <span
      class="sticker wait"
      data-tip={`Queued: ${queued} changes of grants, settings or shared state wait for this machine. It applies the current state when it connects.`}
    >
      queued {queued}
    </span>
  );
}

/** K-1702: the start of a fingerprint is enough to compare it by eye. */
const shortFingerprint = (fingerprint: string) => `${fingerprint.slice(0, "SHA256:".length + 12)}…`;

/** K-1702, K-1705, K-1706: the key of the machine, "Rotate key" and "Reset key". */
function MachineKeyRow(props: { view: MachineView; onToast: (text: string, error: boolean) => void }) {
  const { machine } = props.view;
  const [rekey, setRekey] = useState<{ command: string; expiresAt: number } | null>(null);
  const path = `/api/machines/${encodeURIComponent(machine.id)}`;
  const rotate = async () => {
    const result = await callApi<{ rotating: string }>("POST", `${path}/rotate-key`, {});
    props.onToast(
      "error" in result ? result.error : `${machine.name} rotates its key now.`,
      "error" in result,
    );
  };
  const rotateOff =
    machine.key?.kind !== "public"
      ? "Rotate key needs a machine key first: Make key code or Reset key gives one."
      : !props.view.online
        ? `Rotate key needs ${machine.name} online.`
        : null;
  const reset = async () => {
    const result = await callApi<{ command: string; expiresAt: number }>("POST", `${path}/reset-key`, {});
    if ("error" in result) props.onToast(result.error, true);
    else setRekey(result);
  };
  return (
    <>
      <div class="row">
        <span class="label" data-tip="Key: the key pair that the machine proves itself with to kitshn.">
          Key
        </span>
        {machine.key?.kind === "public" ? (
          <span class="mono" data-tip={`The fingerprint of the machine key: ${machine.key.fingerprint}`}>
            {shortFingerprint(machine.key.fingerprint)} · {ago(machine.key.since)} old
          </span>
        ) : (
          <KeySticker view={props.view} />
        )}
        <button
          class="btn"
          disabled={rotateOff !== null}
          data-tip={
            rotateOff ?? "Rotate key: the online machine makes a new key pair and sends its public half."
          }
          onClick={() => void rotate()}
        >
          Rotate key
        </button>
        <button
          class="btn"
          data-tip="Make a one-time rekey command; the machine gets a new key when you run it there."
          onClick={() => void reset()}
        >
          {machine.key === undefined ? "Make key code" : "Reset key"}
        </button>
      </div>
      <WhyOff reason={rotateOff} />
      {rekey ? (
        <>
          <p>
            Run this on the machine, as the user that runs the daemon. It works once, until{" "}
            {new Date(rekey.expiresAt).toLocaleTimeString()}.
          </p>
          <pre class="command">{rekey.command}</pre>
        </>
      ) : null}
    </>
  );
}

/** K-602: "Add machine" makes a service token, a tunnel and a join code that works once for 10 minutes. */
export function AddMachine(props: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [result, setResult] = useState<{ command: string; windowsCommand: string; expiresAt: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The join command shows once, also when the request for it still runs, so only "Done" ends it then.
  const locked = sending || result !== null;
  useDialogEscape(locked ? () => undefined : props.onClose);
  return (
    <div
      class="scrim"
      onClick={(event) => !locked && event.target === event.currentTarget && props.onClose()}
    >
      <div class="dialog" role="dialog" aria-label="Add machine">
        <h2>Add machine</h2>
        {result ? (
          <>
            <p>
              Run this on the machine, as the user that runs the daemon. It works once, until{" "}
              {new Date(result.expiresAt).toLocaleTimeString()}.
            </p>
            <pre class="command">{result.command}</pre>
            <p>On Windows, in PowerShell:</p>
            <pre class="command">{result.windowsCommand}</pre>
            <div class="row">
              <button
                class="btn primary"
                data-tip="Copy the join command for Linux and macOS to the clipboard."
                onClick={() => void navigator.clipboard.writeText(result.command)}
              >
                Copy
              </button>
              <button
                class="btn"
                data-tip="Copy the join command for Windows PowerShell to the clipboard."
                onClick={() => void navigator.clipboard.writeText(result.windowsCommand)}
              >
                Copy for Windows
              </button>
              <button
                class="btn"
                data-tip="Close this dialog. The command keeps working until it expires."
                onClick={props.onClose}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (sending) return;
              setSending(true);
              const response = await callApi<{ command: string; windowsCommand: string; expiresAt: number }>(
                "POST",
                "/api/machines",
                {
                  name,
                  labels: labels
                    .split(",")
                    .map((label) => label.trim())
                    .filter(Boolean),
                },
              );
              setSending(false);
              if ("error" in response) setError(response.error);
              else setResult(response);
            }}
          >
            <p class="muted">The new machine card starts in the tray, so it is private until you place it.</p>
            <input
              class="field"
              aria-label="Machine name"
              data-tip="The name of the machine card."
              placeholder="Name, for example Oracle VPS"
              value={name}
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
            <input
              class="field"
              aria-label="Labels"
              data-tip="Labels, split by commas. A job runs on the first online machine that has all labels that it needs."
              placeholder="Labels, for example docker, server, arm"
              value={labels}
              onInput={(event) => setLabels((event.target as HTMLInputElement).value)}
            />
            <div class="row">
              <button
                class="btn primary"
                data-tip="Make a join command with a code that works once, for 10 minutes."
              >
                Make a join code
              </button>
              <button
                class="btn"
                type="button"
                data-tip="Close this dialog; nothing changes."
                disabled={sending}
                onClick={props.onClose}
              >
                Cancel
              </button>
            </div>
            {error ? <p class="muted">{error}</p> : null}
          </form>
        )}
      </div>
    </div>
  );
}

const describe = (command: Command) =>
  command.kind === "shell"
    ? command.script
    : command.kind === "update"
      ? `update to ${command.version}`
      : command.kind === "compose-volume-remove"
        ? `delete volume ${command.volume}`
        : command.kind;

/** K-612: queues one command on a machine, and says what happened. */
export async function queueJob(
  machineId: string,
  command: Command,
): Promise<{ text: string; error: boolean }> {
  const result = await callApi<{ id: number }>("POST", "/api/jobs", { machineId, command });
  return "error" in result
    ? { text: result.error, error: true }
    : { text: `Job #${result.id} is queued.`, error: false };
}

/** K-626: sets "Update daemon automatically"; the answer is a toast text. */
export async function setAutoUpdate(
  machineId: string,
  on: boolean,
): Promise<{ text: string; error: boolean }> {
  const result = await callApi<{ id: string }>("POST", `/api/machines/${encodeURIComponent(machineId)}`, {
    autoUpdate: on,
  });
  return "error" in result
    ? { text: result.error, error: true }
    : { text: `Update daemon automatically is ${on ? "on" : "off"}. History can undo it.`, error: false };
}

/** K-1612: cancels a queued job; the answer is a toast text. */
async function cancelJob(id: number): Promise<{ text: string; error: boolean }> {
  const result = await callApi<{ ok: true }>("POST", `/api/jobs/${id}/cancel`, {});
  return "error" in result
    ? { text: result.error, error: true }
    : { text: `Job #${id} is cancelled.`, error: false };
}

/** The machine part of the card panel: status, sample, commands (K-612) and removal (K-615). */
export function MachinePanel(props: {
  view: MachineView;
  /** K-617: the release of this kitshn. */
  version: string;
  jobs: ReadonlyArray<JobView>;
  onRemove: () => void;
  onRun: (command: Command) => Promise<void>;
  onToast: (text: string, error: boolean) => void;
}) {
  const { view } = props;
  const { snapshot } = useStore();
  const [script, setScript] = useState("");
  const run = props.onRun;
  const jobs = props.jobs.filter((job) => job.machineId === view.machine.id);
  return (
    <>
      <div class="row">
        <PresenceSticker view={view} />
        <QueuedSticker view={view} />
        {view.status ? (
          <span class="muted">
            {view.status.hostname} · {view.status.os} · {view.status.arch} · kitshn {view.status.version} ·
            tunnel {view.status.tunnel}
            {view.status.keptBytes === undefined ? null : (
              <span data-tip="Kept builds (K-821): the images that this machine keeps for rollbacks, at most; shared layers count once per image.">
                {" "}
                · kept builds up to {Math.round(view.status.keptBytes / 1024 / 1024)} MB
              </span>
            )}
          </span>
        ) : null}
      </div>
      <MachineKeyRow view={view} onToast={props.onToast} />
      {machineProblems(view, healthProblems(snapshot?.machines ?? [], view.machine.id, Date.now())).map(
        (problem) => (
          <p key={problem.long} class="error">
            {problem.long}
          </p>
        ),
      )}
      {view.online
        ? (view.status?.refusedProviders ?? []).map((refusal) => (
            <details key={refusal.provider} class="raw">
              <summary data-tip="The reason as the provider check wrote it.">Details</summary>
              <code>{refusal.reason}</code>
            </details>
          ))
        : null}
      {view.online
        ? (view.status?.execPaths ?? [])
            .filter((entry) => entry.via === "bridge")
            .map((entry) => (
              <p key={`exec-${entry.provider}`} class="muted">
                Exec as {entry.user} needs the {entry.provider} provider running: no sudo rule. Fix as root:{" "}
                <code>kitshn exec install --user {entry.user} --daemon-user &lt;daemon user&gt;</code>
              </p>
            ))
        : null}
      {view.online
        ? (view.status?.providerProblems ?? []).map((entry) => (
            <p key={`problem-${entry.provider}-${entry.reason}`} class="muted">
              Provider {entry.provider} dropped {entry.reason}
            </p>
          ))
        : null}
      {view.sample ? (
        <div class="row">
          <span class="label" data-tip="CPU: the share in use, from the latest sample of the minute.">
            CPU
          </span>{" "}
          {percent(view.sample.cpu)}{" "}
          <span class="label" data-tip="Memory: the share in use, from the latest sample of the minute.">
            Memory
          </span>{" "}
          {percent(view.sample.memory)}{" "}
          <span class="label" data-tip="Disk: the share in use, from the latest sample of the minute.">
            Disk
          </span>{" "}
          {percent(view.sample.disk)}
        </div>
      ) : null}
      <form
        class="row"
        onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
            "labels",
          ) as HTMLInputElement;
          const result = await callApi<{ id: string }>(
            "POST",
            `/api/machines/${encodeURIComponent(view.machine.id)}`,
            {
              labels: input.value
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean),
            },
          );
          props.onToast("error" in result ? String(result.error) : "Saved the labels.", "error" in result);
        }}
      >
        <span class="label">Labels</span>
        <input
          class="field"
          name="labels"
          aria-label="Labels"
          data-tip="Labels, split by commas. A job runs on the first online machine that has all labels that it needs."
          key={view.machine.labels.join(",")}
          defaultValue={view.machine.labels.join(", ")}
          placeholder="docker, server"
        />
        <button class="btn" data-tip="Save the labels of this machine.">
          Save
        </button>
      </form>
      <form
        class="allow-list"
        onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
            "allow",
          ) as HTMLTextAreaElement;
          const lines = input.value
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter((words) => words[0]);
          const long = lines.find((words) => words.length > 2);
          if (long) {
            props.onToast(
              `"${long.join(" ")}" has more than a repo and one setting; write one setting per line.`,
              true,
            );
            return;
          }
          const allow = lines.map(([repo = "", setting = ""]) => ({ repo, setting }));
          const result = await callApi<{ id: string }>(
            "POST",
            `/api/machines/${encodeURIComponent(view.machine.id)}`,
            { allow },
          );
          props.onToast(
            "error" in result ? String(result.error) : "Saved the allowed Compose settings.",
            "error" in result,
          );
        }}
      >
        <span
          class="label"
          data-tip="Allowed Compose settings: the risky settings that deploys on this machine may use."
        >
          Allowed Compose settings
        </span>
        <p class="help">
          One line per repo and setting, for example{" "}
          <code>Yarden-zamir/dozzle bind:/var/run/docker.sock</code>. A deploy names the setting it needs when
          it stops.
        </p>
        <textarea
          name="allow"
          aria-label="Allowed Compose settings"
          data-tip="One repo and one risky Compose setting per line. A deploy on this machine may use only these."
          rows={3}
          class="mono"
          key={(view.machine.allow ?? []).map((entry) => `${entry.repo} ${entry.setting}`).join("|")}
          defaultValue={(view.machine.allow ?? [])
            .map((entry) => `${entry.repo} ${entry.setting}`)
            .join("\n")}
        />
        <button class="btn" data-tip="Save the allowed Compose settings of this machine.">
          Save
        </button>
      </form>
      <div
        class="label"
        style={{ marginTop: "10px" }}
        data-tip="Commands: jobs that the daemon runs. They need control on the machine card."
      >
        Commands
      </div>
      <form
        class="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (script.trim()) void run({ kind: "shell", script }).then(() => setScript(""));
        }}
      >
        <input
          class="field mono"
          aria-label="Shell command"
          data-tip="A shell command that the daemon runs as a job. It needs control on the machine card."
          placeholder="Shell command, needs control"
          value={script}
          onInput={(event) => setScript((event.target as HTMLInputElement).value)}
        />
        <button class="btn" data-tip="Queue the command as a job; it waits while the machine is offline.">
          Run
        </button>
      </form>
      <div class="row">
        <button
          class="btn"
          data-tip="Collect diagnostics of the daemon as a job; the output shows below."
          onClick={() => void run({ kind: "diagnostics" })}
        >
          Diagnostics
        </button>
        <button class="btn" data-tip={MACHINE_TIPS.restart} onClick={() => void run({ kind: "restart" })}>
          Restart daemon
        </button>
        {/* A local build names no release, so there is nothing to update to (K-617). */}
        {isRelease(props.version) ? (
          <button
            class={`btn${view.status && view.status.version !== props.version ? " primary" : ""}`}
            data-tip={MACHINE_TIPS.update(props.version)}
            onClick={() => void run({ kind: "update", version: props.version })}
          >
            {view.status && view.status.version !== props.version
              ? `Update daemon to ${props.version}`
              : "Update daemon"}
          </button>
        ) : null}
      </div>
      {isRelease(props.version) ? (
        <div class="row">
          <Switch
            checked={view.machine.autoUpdate !== false}
            label="Update daemon automatically"
            tip={MACHINE_TIPS.autoUpdate}
            onChange={async (on) => {
              const { text, error } = await setAutoUpdate(view.machine.id, on);
              props.onToast(text, error);
            }}
          />
        </div>
      ) : null}
      {view.orphanVolumes.length > 0 ? (
        <>
          <div
            class="label"
            style={{ marginTop: "10px" }}
            data-tip="Orphaned volumes: volumes of removed apps that still hold their data on this machine."
          >
            Orphaned volumes
          </div>
          <p class="help">Volumes of removed apps. Undo of a removal does not bring back a deleted volume.</p>
          <ul>
            {view.orphanVolumes.map((volume) => (
              <li key={volume.name}>
                <div class="row">
                  <code>{volume.name}</code>
                  <button
                    class="btn danger"
                    data-tip={`Delete the volume ${volume.name} and its data. Undo cannot bring it back.`}
                    onClick={() =>
                      void run({
                        kind: "compose-volume-remove",
                        project: volume.project,
                        volume: volume.name,
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ul>
        {jobs.slice(0, 5).map((job) => (
          <li key={job.id}>
            <div class="row">
              <code>#{job.id}</code> <code>{describe(job.command)}</code>
              <span
                class={`sticker ${job.state === "done" ? "ok" : job.state === "queued" || job.state === "sent" ? "wait" : ""}`}
                data-tip={JOB_TIPS[job.state]}
              >
                {job.state}
              </span>
              {job.state === "queued" ? (
                <button
                  type="button"
                  class="btn"
                  data-tip="Cancel this job before it reaches the machine. History records it (K-1612)."
                  onClick={() => void cancelJob(job.id).then(({ text, error }) => props.onToast(text, error))}
                >
                  Cancel
                </button>
              ) : null}
            </div>
            {job.output ? <pre class="output">{job.output}</pre> : null}
          </li>
        ))}
      </ul>
      <button class="btn danger" data-tip={MACHINE_TIPS.remove} onClick={props.onRemove}>
        Remove machine: deletes its token and tunnel
      </button>
    </>
  );
}

const CELL_MARK: Record<HealthCell["state"], string> = { ok: "✓", bad: "✗", unknown: "?", none: "" };

/** K-631: the tooltip of one cell: what the row machine found about the column machine, and when. */
function cellTip(from: MachineView, to: MachineView, cell: HealthCell): string {
  const what =
    from === to ? `The providers of ${from.machine.name}` : `${from.machine.name} → ${to.machine.name}`;
  if (cell.state === "none") return `${what}: no link to check.`;
  if (cell.state === "unknown")
    return `${what}: unknown. ${from.online ? "No report in the last 25 minutes." : `${from.machine.name} is offline.`}${cell.at === null ? "" : ` Last check ${ago(cell.at)} ago.`}`;
  const when = `Checked ${ago(cell.at)} ago.`;
  return cell.state === "ok" ? `${what}: answers. ${when}` : `${what}: ${cell.errors.join("; ")}. ${when}`;
}

/**
 * K-631: the health grid. Rows are the machines that check, columns the machines that they reach; the diagonal is the
 * providers of the machine itself. A column has the number of its row, so long names fit.
 */
export function HealthGrid(props: {
  machines: ReadonlyArray<MachineView>;
  onToast: (text: string, error: boolean) => void;
}) {
  const { snapshot } = useStore();
  const [checking, setChecking] = useState(false);
  const now = Date.now();
  const checkNow = async () => {
    setChecking(true);
    const result = await callApi<{
      checking: ReadonlyArray<string>;
      skipped: ReadonlyArray<{ machine: string; reason: string }>;
    }>("POST", "/api/health/check");
    setChecking(false);
    if ("error" in result) return props.onToast(result.error, true);
    const skipped = result.skipped.map((item) => `${item.machine} (${item.reason})`).join(", ");
    props.onToast(
      `${result.checking.length === 0 ? "No machine checks now." : `Checking ${result.checking.join(", ")}.`}${skipped ? ` Skipped: ${skipped}.` : ""}`,
      result.checking.length === 0,
    );
  };
  return (
    <section class="health">
      <div class="row">
        <h3>Health</h3>
        <button
          type="button"
          class="btn"
          disabled={checking}
          data-tip="Each online machine that you control checks its providers and links now. Each daemon also checks every 10 minutes (K-630)."
          onClick={() => void checkNow()}
        >
          Check now
        </button>
      </div>
      <p class="muted">
        Rows check, columns answer; the circle is the machine's own providers. ✓ answers, ✗ fails, ? unknown,
        empty: no link.
      </p>
      <div
        class="health-grid"
        role="table"
        aria-label="Health: rows check, columns answer"
        style={{ gridTemplateColumns: `minmax(0, max-content) repeat(${props.machines.length}, 1.75rem)` }}
      >
        <span role="columnheader" class="health-corner">
          from \ to
        </span>
        {props.machines.map((view, index) => (
          <span role="columnheader" class="health-head" data-tip={view.machine.name} key={view.machine.id}>
            {index + 1}
          </span>
        ))}
        {props.machines.map((from, row) => {
          const progress = snapshot?.progress[from.machine.id];
          return [
            <span role="rowheader" class="health-name" key={`${from.machine.id}:name`}>
              <span>
                {row + 1} {from.machine.name}
              </span>
              {progress ? (
                <ProgressSticker progress={progress} panel={`#map/${encodeURIComponent(from.machine.id)}`} />
              ) : null}
            </span>,
            ...props.machines.map((to) => {
              const cell = healthCell(from, to.machine.id, now);
              return (
                <span
                  role="cell"
                  class={`health-cell ${cell.state}${from === to ? " self" : ""}`}
                  tabIndex={cell.state === "none" ? -1 : 0}
                  data-tip={cellTip(from, to, cell)}
                  key={`${from.machine.id}:${to.machine.id}`}
                >
                  {CELL_MARK[cell.state]}
                </span>
              );
            }),
          ];
        })}
      </div>
    </section>
  );
}

/** K-519: the Machines view, a table of status and health. */
export function MachinesView(props: {
  machines: ReadonlyArray<MachineView>;
  /** K-402: the Access applications that kitshn made; an account has at most 500. */
  accessApps: number;
  onAdd: () => void;
  onToast: (text: string, error: boolean) => void;
}) {
  return (
    <div class="table-view">
      <p class="muted">
        Each machine runs the kitshn daemon. Commands and jobs need control on the machine card.
      </p>
      <p
        class={props.accessApps >= 450 ? "error" : "muted"}
        data-tip="Each web address and each private port route has one Access application; the account has at most 500 (K-402)."
      >
        Access applications: {props.accessApps} of 500
      </p>
      <button
        class="btn primary"
        data-tip="Make a join command for a new machine. Its card starts in the tray, private."
        onClick={props.onAdd}
      >
        + Machine
      </button>
      <table>
        <thead>
          <tr>
            <th>Machine</th>
            <th>Status</th>
            <th>Labels</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Disk</th>
            <th>Daemon</th>
          </tr>
        </thead>
        <tbody>
          {props.machines.map((view) => (
            <tr key={view.machine.id}>
              <td>
                <a
                  href={`#map/${view.machine.id}`}
                  data-tip="Show the machine card and its panel on the map."
                >
                  {view.machine.name}
                </a>
              </td>
              <td data-label="Status">
                <PresenceSticker view={view} />
              </td>
              <td data-label="Labels">{view.machine.labels.join(", ")}</td>
              <td data-label="CPU">{percent(view.sample?.cpu)}</td>
              <td data-label="Memory">{percent(view.sample?.memory)}</td>
              <td data-label="Disk">{percent(view.sample?.disk)}</td>
              <td data-label="Daemon">
                {view.status ? `${view.status.version} · ${view.status.arch}` : "–"}
              </td>
            </tr>
          ))}
          {props.machines.length === 0 ? (
            <tr>
              <td colSpan={7}>No machine yet. Add one; the command joins it in one step.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {props.machines.length > 0 ? <HealthGrid machines={props.machines} onToast={props.onToast} /> : null}
    </div>
  );
}
