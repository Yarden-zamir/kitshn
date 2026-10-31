import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareError, cloudflare } from "./cloudflare.ts";

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

describe("Cloudflare API calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes an empty 200 answer to a DELETE as done", async () => {
    vi.stubGlobal("fetch", answer(200, ""));
    await expect(cloudflare("t", "DELETE", "/accounts/a/workers/domains/d")).resolves.toBeUndefined();
  });

  it("still refuses an empty answer to other methods, and an error envelope", async () => {
    vi.stubGlobal("fetch", answer(200, ""));
    await expect(cloudflare("t", "GET", "/x")).rejects.toBeInstanceOf(CloudflareError);
    vi.stubGlobal(
      "fetch",
      answer(404, JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }] })),
    );
    await expect(cloudflare("t", "DELETE", "/x")).rejects.toThrow(/7003: no route/);
  });
});
