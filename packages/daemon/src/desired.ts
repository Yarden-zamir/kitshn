import type { Answer, Request } from "@kitshn/local";
import type { DaemonMessage } from "@kitshn/edge/machine";

type DesiredRequest = Extract<Request, { type: "desired-set" | "desired-init" }>;
type DesiredMessage = Omit<Extract<DaemonMessage, { type: "desiredSet" | "desiredInit" }>, "requestId">;

/** K-709: preserve initialization as its own wire type, so an older Worker cannot apply it as a set. */
export async function forwardDesired(
  request: DesiredRequest,
  roundTrip: (message: DesiredMessage) => Promise<{ error: string | null; initialized?: boolean }>,
): Promise<Answer> {
  const { id, type, ...change } = request;
  const answer = await roundTrip({ ...change, type: type === "desired-init" ? "desiredInit" : "desiredSet" });
  if (answer.error !== null) throw new Error(answer.error);
  if (type === "desired-set") return { id, type };
  if (typeof answer.initialized !== "boolean")
    throw new Error("kitshn did not confirm conditional desired-state initialization.");
  return { id, type, initialized: answer.initialized };
}
