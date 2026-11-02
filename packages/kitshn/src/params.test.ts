import { describe, expect, it } from "vitest";
import { envLines } from "./params.ts";

describe("envLines (K-808)", () => {
  it("escapes $ so Compose does not expand it", () => {
    expect(envLines(new Map([["PASSWORD", "a$b${c}"]]))).toBe('PASSWORD="a\\$b\\${c}"');
  });

  it("keeps line breaks, quotes and # as JSON escapes", () => {
    expect(
      envLines(
        new Map([
          ["A", 'x\n"y" #z'],
          ["B", ""],
        ]),
      ),
    ).toBe('A="x\\n\\"y\\" #z"\nB=""');
  });
});
