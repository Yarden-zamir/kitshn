import { OP_IDS } from "kitshn/operations";
import { AGENT_COMMANDS } from "kitshn/agent";
import { describe, expect, it } from "vitest";
import { isMachineCommand } from "./cli.ts";
import { OP_COMMANDS, stateFields } from "kitshn/ops";

describe("kitshn <operation> (K-1777)", () => {
  it("never shadows a command of the machine or of an agent", () => {
    const names: ReadonlyArray<string> = [...OP_IDS, ...OP_COMMANDS];
    expect(
      names.filter(
        (name) =>
          isMachineCommand(name) ||
          (AGENT_COMMANDS as ReadonlyArray<string>).includes(name) ||
          // The commands of the npm CLI (K-802, K-803).
          name === "check" ||
          name === "deploy",
      ),
    ).toEqual([]);
  });

  it("prints the fields of kitshn state, and refuses an unknown or hidden field with the valid names", () => {
    const result = {
      snapshot: { machines: [], circles: [] },
      hidden: { jobs: "job output can quote a person" },
    };
    expect(stateFields(result, ["machines"])).toEqual({ machines: [] });
    // Found live on the Oracle VPS: `kitshn state rights` printed {"rights": null}.
    expect(() => stateFields(result, ["rights"])).toThrow(
      "the map has no field rights. Fields: circles, machines.",
    );
    expect(() => stateFields(result, ["jobs"])).toThrow("state hides jobs: job output can quote a person");
  });
});
