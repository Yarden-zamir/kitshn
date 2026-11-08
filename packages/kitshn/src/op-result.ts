// K-1777: the answer of `/op/<operation>`, shared by `kitshn <operation>` and `kitshn secret`.
import { CliError } from "./cli-error.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The result of an operation answer, or the reason of its refusal as a CliError. */
export async function opResult(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (isRecord(data) && data["outcome"] === "done") return data["result"];
  const reason = isRecord(data)
    ? String(data["reason"] ?? data["error"] ?? `kitshn answered ${response.status}`)
    : `kitshn answered ${response.status}`;
  throw new CliError(reason);
}
