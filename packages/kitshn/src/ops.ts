// K-1777: `kitshn ops`, `kitshn state` and `kitshn <operation>`: one call shape for every owner action.
import type { AgentTransport } from "./agent.ts";
import { CliError } from "./cli-error.ts";
import { OPERATIONS, type OpId, isOpId, opsText } from "./operations.ts";

export const OP_COMMANDS = ["ops", "state"] as const;
export type OpCommand = (typeof OP_COMMANDS)[number] | OpId;

export const isOpCommand = (value: string): value is OpCommand =>
  (OP_COMMANDS as ReadonlyArray<string>).includes(value) || isOpId(value);

export const OPS_HELP = `kitshn ops [--json]                     every operation that an owner can do, with its gate (K-1777)
kitshn state [field...] [--json]        the map as the owner sees it, without the hidden fields (K-1777)
kitshn <operation> [target] [--body json] [--reason text]
                                        do one operation as this actor: it runs, waits for a person, or says why not`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The words that are not flags or flag values. */
const words = (args: ReadonlyArray<string>, valued: ReadonlyArray<string>) =>
  args.filter((arg, index) => !arg.startsWith("--") && !valued.includes(args[index - 1] ?? ""));

const flag = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The result of an operation answer, or the reason of its refusal as a CliError. */
export async function opResult(response: Response): Promise<unknown> {
  const data: unknown = await response.json().catch(() => null);
  if (isRecord(data) && data["outcome"] === "done") return data["result"];
  const reason = isRecord(data)
    ? String(data["reason"] ?? data["error"] ?? `kitshn answered ${response.status}`)
    : `kitshn answered ${response.status}`;
  throw new CliError(reason);
}

/** The body of `kitshn <operation>`: the target, `--body` as JSON, and `--reason`. */
export function opCallBody(args: ReadonlyArray<string>): { target: string; body: unknown; reason?: string } {
  const [target = ""] = words(args, ["--body", "--reason", "--server"]);
  const text = flag(args, "--body");
  let body: unknown = {};
  if (text !== undefined) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new CliError("--body is not JSON.");
    }
  }
  const reason = flag(args, "--reason");
  return { target, body, ...(reason === undefined ? {} : { reason }) };
}

/**
 * K-1777: the fields of `kitshn state <field...>`. A field that the snapshot does not have refuses with the valid names,
 * and a hidden field with the reason that it is hidden, so a typo never prints null.
 */
export function stateFields(
  result: { readonly snapshot: Record<string, unknown>; readonly hidden?: unknown },
  fields: ReadonlyArray<string>,
): Record<string, unknown> {
  const { snapshot } = result;
  const hidden = isRecord(result.hidden) ? result.hidden : {};
  for (const field of fields) {
    if (Object.hasOwn(snapshot, field)) continue;
    if (Object.hasOwn(hidden, field)) throw new CliError(`state hides ${field}: ${String(hidden[field])}`);
    throw new CliError(`the map has no field ${field}. Fields: ${Object.keys(snapshot).sort().join(", ")}.`);
  }
  return Object.fromEntries(fields.map((field) => [field, snapshot[field]]));
}

export async function runOpCommand(
  command: OpCommand,
  args: ReadonlyArray<string>,
  transport: () => AgentTransport,
): Promise<void> {
  const json = args.includes("--json");
  if (command === "ops") {
    console.log(
      json
        ? JSON.stringify(
            Object.entries(OPERATIONS).map(([id, op]) => ({ id, ...op })),
            null,
            2,
          )
        : opsText(),
    );
    return;
  }
  if (command === "state") {
    const result = await opResult(await transport().call("/op/state", { method: "GET" }));
    const fields = words(args, ["--server"]);
    const snapshot = isRecord(result) ? result["snapshot"] : null;
    if (fields.length === 0 || !isRecord(result) || !isRecord(snapshot)) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(stateFields({ snapshot, hidden: result["hidden"] }, fields), null, 2));
    return;
  }
  const result = await opResult(
    await transport().call(`/op/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opCallBody(args)),
    }),
  );
  console.log(JSON.stringify(result ?? null, null, json ? 0 : 2));
}
