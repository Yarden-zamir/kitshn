import { type Answer, type Request, parseProtocol } from "@kitshn/local";
import type { DaemonMessage } from "@kitshn/edge/machine";

type DesiredRequest = Extract<Request, { type: "desired-set" | "desired-init" }>;
type DesiredMessage = Omit<
  Extract<DaemonMessage, { type: "desiredSet" | "desiredInit" | "desiredSetCircle" | "desiredInitCircle" }>,
  "requestId"
>;

/** K-726: a kitshn of this protocol or newer stores circle parts. */
const CIRCLE_PARTS = { major: 2, minor: 3 } as const;

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
 * K-709: preserve initialization as its own wire type, so an older Worker cannot apply it as a set. K-726: a circle
 * part has its own types too, because an older Worker files any part that is not shared as the machine part. The
 * daemon refuses a circle part at once when kitshn is older, instead of waiting for an answer that never comes.
 * kitshn checks the kind against the last provider report, so a waiting report goes first: a request right after
 * `register` names a kind that kitshn knows only from that report.
 */
export async function forwardDesired(
  request: DesiredRequest,
  flushReport: () => void,
  roundTrip: (message: DesiredMessage) => Promise<{ error: string | null; initialized?: boolean }>,
  /** K-724: the protocol that kitshn named in `accepted`. */
  kitshnProtocol: string,
): Promise<Answer> {
  const { id, type, ...change } = request;
  const circle = change.part === "circle";
  if (circle) {
    const kitshn = parseProtocol(kitshnProtocol);
    if (kitshn === null || kitshn.major !== CIRCLE_PARTS.major || kitshn.minor < CIRCLE_PARTS.minor)
      throw new Error(
        `kitshn speaks protocol ${kitshnProtocol}, which stores no circle parts; update kitshn to ${CIRCLE_PARTS.major}.${CIRCLE_PARTS.minor}.0 or newer (K-726).`,
      );
  }
  flushReport();
  const init = type === "desired-init";
  const answer = await roundTrip({
    ...change,
    type: init ? (circle ? "desiredInitCircle" : "desiredInit") : circle ? "desiredSetCircle" : "desiredSet",
  });
  if (answer.error !== null) throw new Error(answer.error);
  if (type === "desired-set") return { id, type };
  if (typeof answer.initialized !== "boolean")
    throw new Error("kitshn did not confirm conditional desired-state initialization.");
  return { id, type, initialized: answer.initialized };
}
