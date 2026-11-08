// K-830, K-835: `kitshn secret set|list|remove`: the values of value sets, through the operations of K-1777.
import { readFileSync } from "node:fs";
import type { AgentTransport } from "./agent.ts";
import { CliError } from "./cli-error.ts";
import { opResult } from "./op-result.ts";
import { valueRefusal } from "./values.ts";

export const SECRET_HELP = `kitshn secret set <card|set> <NAME> [--var] [--redeploy] [--reason text] < value-file
                                        set a value of a value set, from stdin; a secret is the default and never
                                        shows again. --redeploy starts each card that needs it (K-830, K-835)
kitshn secret list [<card|set>] [--json] the names of each value set with their state; a var shows its value
kitshn secret remove <card|set> <NAME> [--reason text]
                                        remove a value; a deploy that needs it stops until it is set again`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The words that are not flags or flag values. */
const words = (args: ReadonlyArray<string>) =>
  args.filter(
    (arg, index) => !arg.startsWith("--") && !["--reason", "--server"].includes(args[index - 1] ?? ""),
  );

const flag = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

/**
 * K-836: the value from stdin, without one line break at its end, so `echo` and a file with a last line break give
 * the value itself. Known limit: a value that must end in a line break cannot be set. Revisit when an app needs one.
 */
export function stdinValue(text: string): string {
  const value = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  const refusal = valueRefusal(value);
  if (refusal !== null) throw new CliError(refusal);
  return value;
}

/** K-835: one value set as `kitshn secret list` prints it. */
export function setLines(set: unknown): Array<string> {
  if (!isRecord(set) || !Array.isArray(set["names"]) || typeof set["label"] !== "string")
    throw new CliError(
      `kitshn answered a value set of an unknown shape: ${JSON.stringify(set).slice(0, 200)}`,
    );
  const cards = Array.isArray(set["cards"]) ? set["cards"].filter(isRecord) : [];
  const stale = cards.filter((card) => Array.isArray(card["stale"]) && card["stale"].length > 0);
  const head = `${set["label"]}  (${String(set["key"])})${stale.length > 0 ? `  needs redeploy: ${stale.map((card) => String(card["name"])).join(", ")}` : ""}`;
  const names = set["names"].filter(isRecord).map((name) => {
    const value = typeof name["value"] === "string" ? `  = ${name["value"]}` : "";
    return `  ${String(name["name"]).padEnd(24)} ${String(name["kind"]).padEnd(6)} ${String(name["state"])}${value}`;
  });
  return [head, ...(names.length > 0 ? names : ["  (no names)"])];
}

export async function runSecretCommand(
  args: ReadonlyArray<string>,
  transport: () => AgentTransport,
): Promise<void> {
  const [action = "", ...rest] = args;
  const [target = "", name = "", ...extra] = words(rest);
  const reason = flag(rest, "--reason");
  const call = async (op: string, opTarget: string, body: unknown) =>
    opResult(
      await transport().call(`/op/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: opTarget, body, ...(reason === undefined ? {} : { reason }) }),
      }),
    );
  if (action === "list") {
    const result = await call("values", "", target === "" ? {} : { set: target });
    if (rest.includes("--json")) {
      console.log(JSON.stringify(result));
      return;
    }
    const sets = isRecord(result) && Array.isArray(result["sets"]) ? result["sets"] : [];
    if (sets.length === 0)
      console.log("No value sets yet: a deploy of a recipe with needs makes one (K-830).");
    for (const set of sets) console.log(setLines(set).join("\n"));
    if (isRecord(result) && result["secretsKey"] === false)
      console.log("kitshn has no KITSHN_SECRETS_KEY, so it keeps no secret values yet (K-832).");
    return;
  }
  if (action !== "set" && action !== "remove") throw new CliError(SECRET_HELP);
  if (target === "" || name === "")
    throw new CliError(`name the card or value set and the NAME.\n${SECRET_HELP}`);
  if (extra.length > 0)
    throw new CliError(
      "a value never goes on the command line, where the shell history and the process list keep it. Pipe it on stdin.",
    );
  if (action === "remove") {
    const result = await call("value-remove", target, { name });
    console.log(`removed ${name}.${staleText(result)}`);
    return;
  }
  if (process.stdin.isTTY)
    throw new CliError(
      "pipe the value on stdin, for example: op read op://vault/item/field | kitshn secret set <card> <NAME>",
    );
  const value = stdinValue(readFileSync(0, "utf8"));
  const kind = rest.includes("--var") ? "var" : "secret";
  const result = await call("value-set", target, { name, kind, value });
  const version = isRecord(result) ? result["version"] : null;
  console.log(`${name} is set (${kind}, version ${String(version)}).${staleText(result)}`);
  if (!rest.includes("--redeploy")) return;
  // K-835: --redeploy starts each card that the change makes stale, one at a time.
  const set = isRecord(result) ? String(result["set"] ?? target) : target;
  const listed = await call("values", "", { set });
  const sets = isRecord(listed) && Array.isArray(listed["sets"]) ? listed["sets"].filter(isRecord) : [];
  for (const card of sets.flatMap((item) =>
    Array.isArray(item["cards"]) ? item["cards"].filter(isRecord) : [],
  ))
    if (Array.isArray(card["stale"]) && card["stale"].length > 0) {
      await call("app-redeploy", String(card["id"]), {});
      console.log(`redeploy of ${String(card["name"])} started.`);
    }
}

const staleText = (result: unknown) => {
  const stale = isRecord(result) && Array.isArray(result["stale"]) ? result["stale"].map(String) : [];
  return stale.length === 0
    ? ""
    : ` ${stale.join(", ")} still ${stale.length === 1 ? "runs" : "run"} with the old value: redeploy with kitshn app-redeploy <card>, or add --redeploy.`;
};
