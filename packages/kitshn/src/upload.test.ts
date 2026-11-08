import { afterEach, expect, it, vi } from "vitest";
import { CliError } from "./cli-error.ts";
import { sendOnceMore } from "./upload.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const dropped = () => new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });

it.each([
  { name: "a dropped connection", first: () => Promise.reject(dropped()), sends: 2, status: 200 },
  { name: "a 5xx answer", first: async () => Response.json({ error: "R2" }, { status: 502 }), sends: 2, status: 200 },
  { name: "a refusal", first: async () => Response.json({ error: "no" }, { status: 410 }), sends: 1, status: 410 },
  { name: "an accepted file", first: async () => Response.json({ ok: true }), sends: 1, status: 200 },
])("sends a deploy file once more only after a network error or a 5xx answer: $name (K-812)", async (row) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn<() => Promise<Response>>().mockImplementationOnce(row.first).mockResolvedValue(Response.json({ ok: true }));
  const response = await sendOnceMore("/deploy/archive", send);
  expect(send).toHaveBeenCalledTimes(row.sends);
  expect(response.status).toBe(row.status);
});

it("names the cause when the second send fails too, and never repeats a CLI error (K-812)", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(sendOnceMore("/deploy/archive", () => Promise.reject(dropped()))).rejects.toThrow("fetch failed");
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("ECONNRESET"));
  const token = vi.fn(() => Promise.reject(new CliError("no GitHub OIDC token.")));
  await expect(sendOnceMore("/deploy/archive", token)).rejects.toThrow("no GitHub OIDC token.");
  expect(token).toHaveBeenCalledOnce();
});
