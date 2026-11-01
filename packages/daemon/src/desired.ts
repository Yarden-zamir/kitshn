import type { Answer, Request } from "@kitshn/local";
import type { DaemonMessage } from "@kitshn/edge/machine";

type DesiredRequest = Extract<Request, { type: "desired-set" | "desired-init" }>;
type DesiredMessage = Omit<Extract<DaemonMessage, { type: "desiredSet" | "desiredInit" }>, "requestId">;

/** K-704: the provider report goes to kitshn at most once a second; `flush` sends a waiting one now. */
export function providerReports(send: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    send();
  };
  return {
    schedule() {
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}

/**
 * K-709: preserve initialization as its own wire type, so an older Worker cannot apply it as a set. kitshn checks
 * the kind against the last provider report, so a waiting report goes first: a request right after `register` names
 * a kind that kitshn knows only from that report.
 */
export async function forwardDesired(
  request: DesiredRequest,
  flushReport: () => void,
  roundTrip: (message: DesiredMessage) => Promise<{ error: string | null; initialized?: boolean }>,
): Promise<Answer> {
  const { id, type, ...change } = request;
  flushReport();
  const answer = await roundTrip({ ...change, type: type === "desired-init" ? "desiredInit" : "desiredSet" });
  if (answer.error !== null) throw new Error(answer.error);
  if (type === "desired-set") return { id, type };
  if (typeof answer.initialized !== "boolean")
    throw new Error("kitshn did not confirm conditional desired-state initialization.");
  return { id, type, initialized: answer.initialized };
}
