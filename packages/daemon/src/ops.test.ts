import { OP_IDS } from "@kitshn/edge/operations";
import { AGENT_COMMANDS } from "kitshn/agent";
import { describe, expect, it } from "vitest";
import { isMachineCommand } from "./cli.ts";
import { OP_COMMANDS } from "./ops.ts";

describe("kitshn <operation> (K-1777)", () => {
  it("never shadows a command of the machine or of an agent", () => {
    const names = [...OP_IDS, ...OP_COMMANDS];
    expect(
      names.filter(
        (name) => isMachineCommand(name) || (AGENT_COMMANDS as ReadonlyArray<string>).includes(name),
      ),
    ).toEqual([]);
  });
});
