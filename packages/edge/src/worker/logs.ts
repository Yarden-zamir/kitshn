// K-1806 to K-1808: the logs that kitshn reads from Cloudflare and from its own deploy rows.
import {
  type DeployRun,
  LOG_LINES,
  type LogAnswer,
  type LogSearch,
  matchesText,
  telemetryLine,
} from "../core/logs.ts";
import { CloudflareError } from "./cloudflare.ts";

type Api = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;

/** K-1806: the events of one Worker script that match; checked against the live API on 2026-10-28. */
export async function searchWorker(
  api: Api,
  account: string,
  script: string,
  search: LogSearch,
): Promise<LogAnswer> {
  let result: { events?: { count?: number; events?: ReadonlyArray<unknown> } };
  try {
    result = await api("POST", `/accounts/${account}/workers/observability/telemetry/query`, {
      queryId: "kitshn-logs",
      view: "events",
      limit: LOG_LINES,
      // A dry query keeps no saved query in the account.
      dry: true,
      timeframe: { from: search.from, to: search.to },
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }],
        ...(search.text === "" ? {} : { needle: { value: search.text } }),
      },
    });
  } catch (error) {
    // The token answers 403 "Forbidden" without "Account > Workers Observability > Edit".
    if (error instanceof CloudflareError && error.status === 403) return { state: "needs-permission" };
    throw error;
  }
  const events = result.events?.events ?? [];
  const lines = events.map(telemetryLine).sort((a, b) => a.at - b.at);
  return { state: "lines", lines, matched: Math.max(result.events?.count ?? 0, lines.length), cut: false };
}

/** K-1807: a tail of one Worker script; the map connects to `url` itself. */
export const startWorkerTail = (api: Api, account: string, script: string) =>
  api<{ id: string; url: string }>("POST", `/accounts/${account}/workers/scripts/${script}/tails`, {});

/** K-1807: a tail that is gone already is no error. */
export async function stopWorkerTail(api: Api, account: string, script: string, id: string) {
  try {
    await api("DELETE", `/accounts/${account}/workers/scripts/${script}/tails/${id}`);
  } catch (error) {
    if (!(error instanceof CloudflareError && error.status === 404)) throw error;
  }
}

/** K-1808: the deploy rows and job outputs that "Deploy runs" reads. */
export interface RunSource {
  readonly id: string;
  readonly at: number;
  readonly repo: string;
  readonly sha: string;
  readonly state: string;
  readonly reason: string | null;
  readonly runId: string | null;
  readonly runAttempt: string | null;
  /** The job output of a Compose deploy; null for a static or Worker deploy. */
  readonly output: string | null;
}

/** K-1808: the runs in the time range; with a search text, only the runs whose output or reason matches. */
export function deployRuns(sources: ReadonlyArray<RunSource>, search: LogSearch): Array<DeployRun> {
  return sources.flatMap((source): Array<DeployRun> => {
    if (source.at < search.from || source.at > search.to) return [];
    const lines =
      source.output === null
        ? null
        : source.output.split("\n").filter((line) => matchesText(line, search.text));
    const found =
      search.text === "" || (lines?.length ?? 0) > 0 || matchesText(source.reason ?? "", search.text);
    if (!found) return [];
    return [
      {
        id: source.id,
        at: source.at,
        sha: source.sha,
        state: source.state,
        reason: source.reason,
        runUrl:
          source.runId === null
            ? null
            : `https://github.com/${source.repo}/actions/runs/${source.runId}/attempts/${source.runAttempt ?? "1"}`,
        lines,
      },
    ];
  });
}
