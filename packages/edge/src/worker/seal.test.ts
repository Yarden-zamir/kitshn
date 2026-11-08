import { describe, expect, it } from "vitest";
import { aesKey, open, seal } from "./seal.ts";

describe("seal (K-832)", () => {
  it("opens a value only with its key and the data of its own row", async () => {
    const key = await aesKey("one secret", "kitshn app_values");
    const box = await seal(key, "the value", "1:app:prod\nAPI_KEY\n3");
    expect(await open(key, box, "1:app:prod\nAPI_KEY\n3")).toBe("the value");
    // A blob that someone moves to another row, or another version, does not open.
    await expect(open(key, box, "2:app:prod\nAPI_KEY\n3")).rejects.toThrow();
    await expect(open(key, box, "1:app:prod\nAPI_KEY\n4")).rejects.toThrow();
    await expect(
      open(await aesKey("another secret", "kitshn app_values"), box, "1:app:prod\nAPI_KEY\n3"),
    ).rejects.toThrow();
  });
});
