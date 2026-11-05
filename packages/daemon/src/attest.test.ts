import { describe, expect, it } from "vitest";
import { dropAttested, labelPrefixes } from "./attest.ts";

describe("attested labels (K-1753)", () => {
  it("drops a caller's label in the prefix of any registered provider, and in t3. always", () => {
    const prefixes = labelPrefixes(["grok"]);
    expect(dropAttested({ "t3.thread.id": "x", "grok.thread.id": "y", "my.note": "kept" }, prefixes)).toEqual(
      { "my.note": "kept" },
    );
  });
});
