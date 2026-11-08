import { describe, expect, it } from "vitest";
import { stdinValue } from "./secret.ts";

describe("kitshn secret set (K-836)", () => {
  it("takes the value from stdin without one line break at its end, and refuses an empty value", () => {
    expect(stdinValue("abc\n")).toBe("abc");
    expect(stdinValue("abc\r\n")).toBe("abc");
    expect(stdinValue("abc\n\n")).toBe("abc\n");
    expect(() => stdinValue("\n")).toThrow(/empty/);
  });
});
