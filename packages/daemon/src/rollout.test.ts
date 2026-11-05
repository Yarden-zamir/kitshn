import { describe, expect, it } from "vitest";
import { lineReader } from "./rollout.ts";

describe("kitshn rollout output (K-636)", () => {
  it("keeps a line that the bootstrap output splits across chunks", () => {
    const lines: Array<string> = [];
    const reader = lineReader((line) => lines.push(line));
    reader.data(Buffer.from("  chan"));
    reader.data(Buffer.from("ged: the Worker\nkitshn: no"));
    reader.end();
    expect(lines).toEqual(["  changed: the Worker", "kitshn: no"]);
  });
});
