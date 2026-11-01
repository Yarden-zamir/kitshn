import { useEffect, useState } from "preact/hooks";
import { type DeployRun, type LogAnswer, type LogLine, matchesText, tailLines } from "../core/logs.ts";
import type { Resource } from "../core/model.ts";
import { TOKEN_PERMISSIONS, TOKEN_PLACE } from "../core/token.ts";
import { Radio, Switch, useDialogEscape } from "./controls.tsx";
import { callApi, startTail, stopTail } from "./store.ts";

type Tab = "app" | "deploys";
type Range = "15m" | "1h" | "1d" | "custom";

const RANGE_MS: Record<Exclude<Range, "custom">, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const RANGE_LABELS: Record<Range, string> = {
  "15m": "15 minutes",
  "1h": "1 hour",
  "1d": "1 day",
  custom: "Custom",
};
/** Live keeps this many lines in the view. */
const LIVE_LINES = 2000;

/** K-1806: the exact steps, because the search box is the only place where the owner meets this. */
export const OBSERVABILITY_STEPS = [
  `Open ${TOKEN_PLACE}.`,
  "Find the token of kitshn and click Edit.",
  `Add the permission "${TOKEN_PERMISSIONS.workersObservability.label}".`,
  "Click Continue to summary, then Update token. The token value stays the same, so kitshn needs no deploy.",
  "Search again.",
] as const;

/** "2026-10-28 14:00" in local time; every browser reads the ISO form with a "T" as local time. */
const localTime = (text: string) => Date.parse(text.trim().replace(" ", "T"));

const time = (at: number) => new Date(at).toLocaleString();

function Lines(props: { lines: ReadonlyArray<LogLine> }) {
  if (props.lines.length === 0) return null;
  return (
    <pre class="output log-lines" aria-label="Log lines">
      {props.lines.map((line, index) => (
        <div key={index}>
          <span class="muted">{time(line.at)}</span> <b>{line.source}</b> {line.text}
        </div>
      ))}
    </pre>
  );
}

/** K-1801: the logs of a Compose or Worker card: app logs and deploy runs, with search, a time range and Live. */
export function LogsDialog(props: { card: Resource; onClose: () => void }) {
  useDialogEscape(props.onClose);
  const { card } = props;
  const [tab, setTab] = useState<Tab>("app");
  const [text, setText] = useState("");
  const [range, setRange] = useState<Range>("1h");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [answer, setAnswer] = useState<LogAnswer | null>(null);
  const [runs, setRuns] = useState<ReadonlyArray<DeployRun> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [liveLines, setLiveLines] = useState<ReadonlyArray<LogLine>>([]);
  const [liveNote, setLiveNote] = useState<string | null>(null);

  const search = async () => {
    const now = Date.now();
    const start = range === "custom" ? localTime(from) : now - RANGE_MS[range];
    const end = range === "custom" ? (to.trim() === "" ? now : localTime(to)) : now;
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
      setError("Set a start that comes before the end.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await callApi<{ answer?: LogAnswer; runs?: Array<DeployRun> }>(
      "POST",
      `/api/apps/${encodeURIComponent(card.id)}/logs`,
      { tab, text, from: start, to: end },
    );
    setBusy(false);
    if ("error" in result) return setError(result.error);
    if (tab === "app") setAnswer(result.answer ?? null);
    else setRuns(result.runs ?? []);
  };

  // A new tab or range searches at once; the text searches on Enter.
  useEffect(() => {
    if (range !== "custom") void search();
  }, [tab, range]);

  // Live opens a connection to kitshn, or to the Cloudflare tail, while it is on.
  useEffect(() => {
    if (!live) return;
    let tail: string | null = null;
    let socket: WebSocket | null = null;
    let closed = false;
    const add = (lines: ReadonlyArray<LogLine>) =>
      setLiveLines((before) => [...before, ...lines].slice(-LIVE_LINES));
    const end = (reason: string) => {
      setLiveNote(reason);
      setLive(false);
    };
    setLiveLines([]);
    setLiveNote(null);
    void startTail(card.id, (event) => {
      if (event.type === "lines") {
        add(event.lines);
        if (event.skipped > 0)
          setLiveNote(`Live skipped ${event.skipped} lines that came too fast (K-1805).`);
      } else end(event.reason);
    }).then((started) => {
      if (started.kind === "error") return end(started.error);
      tail = started.tail;
      if (closed) return stopTail(started.tail);
      if (started.kind !== "worker") return;
      // K-1807: the map reads the Cloudflare tail itself, so its events cost kitshn nothing.
      socket = new WebSocket(started.url, "trace-v1");
      socket.onmessage = async (message: MessageEvent<string | Blob>) => {
        const data = typeof message.data === "string" ? message.data : await message.data.text();
        add(tailLines(JSON.parse(data)));
      };
      socket.onclose = () => {
        if (!closed) end("The Cloudflare tail closed. Turn Live on again for a new one.");
      };
    });
    return () => {
      closed = true;
      socket?.close();
      if (tail) stopTail(tail);
    };
  }, [live]);

  const shown = answer?.state === "lines" ? answer.lines : [];
  const liveShown = liveLines.filter((line) => matchesText(`${line.source} ${line.text}`, text));
  return (
    <div class="scrim">
      <div class="dialog wide" role="dialog" aria-label={`Logs of ${card.name}`}>
        <div class="row">
          <b>Logs of {card.name}</b>
        </div>
        <div class="choices" role="radiogroup" aria-label="Logs">
          <Radio
            name="logs-tab"
            label="App"
            checked={tab === "app"}
            tip="What the app writes: its containers on the machine, or its Worker events."
            onSelect={() => setTab("app")}
          />
          <Radio
            name="logs-tab"
            label="Deploy runs"
            checked={tab === "deploys"}
            tip="The newest 20 deploys of this card, with the output that kitshn keeps (K-1808)."
            onSelect={() => setTab("deploys")}
          />
        </div>
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            class="field"
            type="search"
            aria-label="Search the logs"
            data-tip="Plain text, case does not count. Press Enter to search."
            placeholder="Search"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
          />
          <button type="submit" class="btn" disabled={busy} data-tip="Search the logs in the time range.">
            {busy ? "Searching…" : "Search"}
          </button>
        </form>
        <div class="choices" role="radiogroup" aria-label="Time range">
          {(Object.keys(RANGE_LABELS) as Array<Range>).map((value) => (
            <Radio
              key={value}
              name="logs-range"
              label={RANGE_LABELS[value]}
              checked={range === value}
              tip={
                value === "custom"
                  ? "Set a start and an end, then search."
                  : `The last ${RANGE_LABELS[value]}.`
              }
              onSelect={() => setRange(value)}
            />
          ))}
          {tab === "app" ? (
            <Switch
              label="Live"
              checked={live}
              tip="Follow new lines as they come. Live stops when this closes, and a Compose tail after 30 minutes."
              onChange={setLive}
            />
          ) : null}
        </div>
        {range === "custom" ? (
          <div class="row">
            <input
              class="field"
              aria-label="From"
              data-tip="The start, in your time zone, such as 2026-10-28 14:00."
              placeholder="From: 2026-10-28 14:00"
              value={from}
              onInput={(event) => setFrom(event.currentTarget.value)}
            />
            <input
              class="field"
              aria-label="To"
              data-tip="The end, in your time zone. Empty means now."
              placeholder="To: empty means now"
              value={to}
              onInput={(event) => setTo(event.currentTarget.value)}
            />
          </div>
        ) : null}
        {error ? <p class="error">{error}</p> : null}
        {tab === "app" && live ? (
          <>
            {liveNote ? <p class="muted">{liveNote}</p> : null}
            <Lines lines={liveShown} />
          </>
        ) : tab === "app" ? (
          <>
            {liveNote ? <p class="muted">{liveNote}</p> : null}
            {answer?.state === "error" ? <p class="error">{answer.error}</p> : null}
            {answer?.state === "needs-permission" ? (
              <div class="help">
                <p>
                  {`Search in Worker logs needs the token permission "${TOKEN_PERMISSIONS.workersObservability.label}". Live works without it.`}
                </p>
                <ol>
                  {OBSERVABILITY_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {answer?.state === "lines" && answer.cut ? (
              <p class="error">
                Search stopped at 15 s, so the newest lines may be missing. Narrow the time range.
              </p>
            ) : null}
            {answer?.state === "lines" ? (
              <p class="muted">
                {answer.matched > shown.length
                  ? `The newest ${shown.length} of ${answer.matched} lines that match.`
                  : `${shown.length} lines.`}
              </p>
            ) : null}
            <Lines lines={shown} />
          </>
        ) : (
          <ul class="log-runs">
            {(runs ?? []).map((run) => (
              <li key={run.id}>
                <div class="row">
                  <code>{run.sha.slice(0, 7)}</code> <span class="muted">{time(run.at)}</span>{" "}
                  <span class="sticker">{run.state}</span>
                  {run.runUrl ? (
                    <a
                      href={run.runUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-tip="Open the workflow run on GitHub."
                    >
                      workflow run
                    </a>
                  ) : null}
                </div>
                {run.reason ? <p class="error">{run.reason}</p> : null}
                {run.lines === null ? (
                  <p class="muted">The output of this deploy is in the workflow run.</p>
                ) : run.lines.length === 0 ? (
                  <p class="muted">No line of the output matches, or kitshn no longer keeps the output.</p>
                ) : (
                  <pre class="output log-lines">{run.lines.join("\n")}</pre>
                )}
              </li>
            ))}
            {runs?.length === 0 ? <li class="muted">No deploy runs in this time range.</li> : null}
          </ul>
        )}
        <button type="button" class="btn" data-tip="Close the logs. Live stops." onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
