import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareError, cloudflare, cloudflareCompleteList } from "./cloudflare.ts";

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

describe("Cloudflare API calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes an empty 200 answer to a DELETE as done", async () => {
    vi.stubGlobal("fetch", answer(200, ""));
    await expect(cloudflare("t", "DELETE", "/accounts/a/workers/domains/d")).resolves.toBeUndefined();
  });

  it("accepts a paginated listing only when Cloudflare confirms the whole first page", async () => {
    const page = { count: 1, page: 1, per_page: 1000, total_pages: 1 };
    vi.stubGlobal(
      "fetch",
      answer(200, JSON.stringify({ success: true, result: [{ id: "one" }], result_info: page })),
    );
    await expect(cloudflareCompleteList("t", "/apps?type=site")).resolves.toEqual([{ id: "one" }]);
    for (const resultInfo of [
      undefined,
      { ...page, total_pages: 5 },
      { ...page, count: 2 },
      { ...page, page: 2 },
      { ...page, per_page: 0 },
      { ...page, total_count: 2 },
      { ...page, total_count: -1 },
    ]) {
      vi.stubGlobal(
        "fetch",
        answer(200, JSON.stringify({ success: true, result: [{ id: "one" }], result_info: resultInfo })),
      );
      await expect(cloudflareCompleteList("t", "/apps")).rejects.toThrow("listing is complete");
    }
    vi.stubGlobal(
      "fetch",
      answer(
        200,
        JSON.stringify({ success: true, result: [], result_info: { ...page, count: 0, total_pages: 0 } }),
      ),
    );
    await expect(cloudflareCompleteList("t", "/apps")).resolves.toEqual([]);
    vi.stubGlobal("fetch", async (url: string) => {
      const isSecond = url.includes("page=2");
      return Response.json({
        success: true,
        result: [{ id: isSecond ? "two" : "one" }],
        result_info: { count: 1, page: isSecond ? 2 : 1, per_page: 1, total_pages: 2, total_count: 2 },
      });
    });
    await expect(cloudflareCompleteList("t", "/apps")).resolves.toEqual([{ id: "one" }, { id: "two" }]);
    // A changing list can repeat an id across pages and silently omit a different object.
    vi.stubGlobal("fetch", async (url: string) => {
      const isSecond = url.includes("page=2");
      return Response.json({
        success: true,
        result: [{ id: "one" }],
        result_info: { count: 1, page: isSecond ? 2 : 1, per_page: 1, total_pages: 2, total_count: 2 },
      });
    });
    await expect(cloudflareCompleteList("t", "/apps")).rejects.toThrow("listing is complete");
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
