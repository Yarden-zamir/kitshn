// K-1801 to K-1808: the logs of Compose and Worker cards. Shared by the Worker, the map and the daemon.

/** One log line. `source` names the Compose service or the Worker event, such as `web-1` or `GET /`. */
export interface LogLine {
  readonly at: number;
  readonly source: string;
  readonly text: string;
}

/** K-1801: the text and the time range of a search, in milliseconds since the epoch. */
export interface LogSearch {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/** K-1801: a search shows at most this many lines, the newest. */
export const LOG_LINES = 500;

/**
 * K-1801: `matched` counts every line that matched, also the ones beyond `LOG_LINES`. `cut` is true when the
 * daemon stopped the search at its time limit, so the newest lines of the range may be missing (K-1804).
 */
export type LogAnswer =
  | {
      readonly state: "lines";
      readonly lines: ReadonlyArray<LogLine>;
      readonly matched: number;
      readonly cut: boolean;
    }
  | { readonly state: "error"; readonly error: string }
  /** K-1806: the token has no "Account > Workers Observability > Edit". */
  | { readonly state: "needs-permission" };

/** K-1808: one deploy of a card in "Deploy runs", with the lines of its output that match. */
export interface DeployRun {
  readonly id: string;
  readonly at: number;
  readonly sha: string;
  readonly state: string;
  readonly reason: string | null;
  /** The workflow run on GitHub, or null for a rollback that kitshn started. */
  readonly runUrl: string | null;
  /** Null when kitshn has no output: a static or Worker deploy, whose output stays in GitHub Actions. */
  readonly lines: ReadonlyArray<string> | null;
}

/** K-1805: the daemon sends new lines at most once a second, at most this many in one batch. */
export const TAIL_BATCH = 500;
/** K-1805 */
export const TAIL_MS = 30 * 60_000;

/** K-1801: plain text that ignores case; an empty text matches every line. */
export const matchesText = (line: string, text: string) =>
  text === "" || line.toLowerCase().includes(text.toLowerCase());

/** Keeps the newest `limit` items that it gets, and counts all of them. */
export class Newest<T> {
  readonly #items: Array<T> = [];
  count = 0;
  constructor(readonly limit: number) {}
  add(item: T) {
    this.count++;
    this.#items.push(item);
    if (this.#items.length > this.limit) this.#items.shift();
  }
  get items(): ReadonlyArray<T> {
    return this.#items;
  }
}

/**
 * K-1804: one line of `docker compose logs --timestamps --no-color`, such as
 * `web-1  | 2026-10-28T10:00:00.123456789Z hello`. Null for a line without that shape.
 */
export function parseComposeLine(raw: string): LogLine | null {
  const bar = raw.indexOf(" | ");
  if (bar < 0) return null;
  const rest = raw.slice(bar + 3);
  const space = rest.indexOf(" ");
  const stamp = space < 0 ? rest : rest.slice(0, space);
  const at = parseStamp(stamp);
  if (at === null) return null;
  return { at, source: raw.slice(0, bar).trim(), text: space < 0 ? "" : rest.slice(space + 1) };
}

/** RFC 3339 with up to nine digits of a second; some engines parse only three. */
function parseStamp(stamp: string): number | null {
  const dot = stamp.indexOf(".");
  const zone = Math.max(stamp.lastIndexOf("Z"), stamp.lastIndexOf("+"), stamp.lastIndexOf("-"));
  const short =
    dot >= 0 && zone > dot ? `${stamp.slice(0, Math.min(dot + 4, zone))}${stamp.slice(zone)}` : stamp;
  const at = Date.parse(short);
  return Number.isNaN(at) ? null : at;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** K-1806: one event of the Workers Logs query API (view `events`). */
export function telemetryLine(event: unknown): LogLine {
  const body = record(event);
  const meta = record(body["$metadata"]);
  const message = meta["message"] ?? meta["error"] ?? record(body["source"])["message"] ?? body["source"];
  return {
    at: typeof body["timestamp"] === "number" ? body["timestamp"] : 0,
    source: [meta["level"], meta["trigger"]].filter((part) => typeof part === "string").join(" "),
    text: text(message ?? ""),
  };
}

/**
 * K-1807: the lines of one `trace-v1` tail event: its request, then its `console` calls and exceptions.
 * The request line names the status, so a search for "500" finds failed requests.
 */
export function tailLines(event: unknown): Array<LogLine> {
  const body = record(event);
  const at = typeof body["eventTimestamp"] === "number" ? body["eventTimestamp"] : 0;
  const request = record(record(body["event"])["request"]);
  const status = record(record(body["event"])["response"])["status"];
  const trigger =
    typeof request["method"] === "string" && typeof request["url"] === "string"
      ? `${request["method"]} ${URL.canParse(request["url"]) ? new URL(request["url"]).pathname : request["url"]}`
      : typeof record(body["event"])["cron"] === "string"
        ? `cron ${String(record(body["event"])["cron"])}`
        : "event";
  const lines: Array<LogLine> = [
    {
      at,
      source: trigger,
      text: `${String(body["outcome"] ?? "")}${status === undefined ? "" : ` ${String(status)}`}`,
    },
  ];
  for (const log of Array.isArray(body["logs"]) ? body["logs"] : []) {
    const entry = record(log);
    const parts = Array.isArray(entry["message"]) ? entry["message"] : [entry["message"]];
    lines.push({
      at: typeof entry["timestamp"] === "number" ? entry["timestamp"] : at,
      source: `${trigger} ${String(entry["level"] ?? "log")}`,
      text: parts.map(text).join(" "),
    });
  }
  for (const exception of Array.isArray(body["exceptions"]) ? body["exceptions"] : []) {
    const entry = record(exception);
    lines.push({
      at: typeof entry["timestamp"] === "number" ? entry["timestamp"] : at,
      source: `${trigger} exception`,
      text: `${String(entry["name"] ?? "Error")}: ${String(entry["message"] ?? "")}`,
    });
  }
  return lines;
}

/** K-1805, K-1807: the answer to "Live". A Worker tail gives the address that the map connects to itself. */
export type TailAnswer =
  | { readonly kind: "compose"; readonly tail: string }
  | { readonly kind: "worker"; readonly tail: string; readonly url: string }
  | { readonly kind: "error"; readonly error: string };

/** K-1804, K-1805: the lines that a daemon sent, cut to the limits; a wrong shape counts as no line. */
export function logLinesOf(value: unknown, limit: number): Array<LogLine> {
  if (!Array.isArray(value)) return [];
  return value.slice(-limit).flatMap((item): Array<LogLine> => {
    const line = record(item);
    return typeof line["at"] === "number" &&
      typeof line["source"] === "string" &&
      typeof line["text"] === "string"
      ? [{ at: line["at"], source: line["source"].slice(0, 200), text: line["text"].slice(0, 10_000) }]
      : [];
  });
}

/** K-1804: the answer of a daemon; a wrong shape is an error that says so. */
export function logAnswerOf(value: unknown): LogAnswer {
  const answer = record(value);
  if (answer["state"] === "lines" && typeof answer["matched"] === "number")
    return {
      state: "lines",
      lines: logLinesOf(answer["lines"], LOG_LINES),
      matched: answer["matched"],
      cut: answer["cut"] === true,
    };
  if (answer["state"] === "error" && typeof answer["error"] === "string")
    return { state: "error", error: answer["error"].slice(0, 2000) };
  return { state: "error", error: "The daemon sent an answer that kitshn cannot read." };
}

/** K-1802: only Compose and Worker cards have logs. */
export const hasLogs = (kind: string) => kind === "site.compose" || kind === "site.worker";
