import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { forwarded, setup } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

it("takes a call that the daemon forwarded and signed, with the right of its path, once per nonce (K-1714)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // K-1777: an address change has the effect "changes", as the row card-address.
  await setup({ creates: { mode: "automatic" }, changes: { mode: "ask", circleId: "owner" } }, key);
  const address = "/agent/cards/no-such-card/address";
  // K-1776: an effect that asks the Owner waits, and the same call again gets the same proposal, not a second one.
  const unset = await forwarded(key, "POST", address, "nonce-off-0123456789");
  expect(unset.status).toBe(409);
  const waiting = (await unset.json()) as {
    error: string;
    outcome: string;
    proposalId: string;
    circle: string;
  };
  expect(waiting).toMatchObject({
    outcome: "waiting",
    circle: "Owner",
    error: expect.stringMatching(/^waiting: /),
  });
  const again = await forwarded(key, "POST", address, "nonce-off-1123456789");
  expect(((await again.json()) as { proposalId: string }).proposalId).toBe(waiting.proposalId);
  // A changed call is another call, so the approval of the first does not run it.
  const other = await forwarded(
    key,
    "POST",
    address,
    "nonce-off-2123456789",
    JSON.stringify({ address: "y" }),
  );
  expect(((await other.json()) as { proposalId: string }).proposalId).not.toBe(waiting.proposalId);
  const stub = env.KITSHN.getByName("kitshn");
  const decided = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        decide(id: string, decision: "approved", by: object): Promise<{ ok: boolean }>;
      }
    ).decide(waiting.proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    }),
  );
  expect(decided).toEqual({ ok: true });
  // The approval runs the same call once more within the hour; the path itself answers for the unknown card.
  const approved = await forwarded(key, "POST", address, "nonce-off-3123456789");
  expect((await approved.json()) as { error?: string }).toEqual({
    error: expect.not.stringMatching(/K-1714|K-1776|adds pages|waiting/),
  });
  await runInDurableObject(stub, (_, state) => state.storage.sql.exec("DELETE FROM ask_events"));
  // "off" still refuses at once, with the right for the CLI's offer.
  await setup({ creates: { mode: "automatic" }, changes: { mode: "off" } }, key);
  const off = await forwarded(key, "POST", address, "nonce-off-4123456789");
  expect(off.status).toBe(403);
  expect(await off.json()).toEqual({ error: expect.stringContaining("is off"), need: "changes" });
  // The previous version of a library card follows "changes" too, as the row library-previous.
  const previous = await forwarded(
    key,
    "POST",
    "/agent/library/no-such-card/previous",
    "nonce-off-5123456789",
  );
  expect(await previous.json()).toEqual({ error: expect.stringContaining("is off"), need: "changes" });
  await setup({ creates: { mode: "automatic" }, changes: { mode: "automatic" } }, key);
  const passed = await forwarded(
    key,
    "POST",
    address,
    "nonce-on-01234567890",
    JSON.stringify({ address: "x" }),
  );
  // The right passes; the path itself answers for the unknown card.
  expect((await passed.json()) as { error?: string }).toEqual({
    error: expect.not.stringMatching(/K-1714|adds pages/),
  });
  // A path that decodes out of a card, or out of /agent/, never reaches a route (K-1714).
  for (const [index, path] of [
    "/agent/cards/a%2f..%2f..%2fconnect/address",
    "/agent/cards/a%252e%252e/address",
  ].entries()) {
    const climbing = await forwarded(key, "POST", path, `nonce-climb-${index}-0123456789`);
    expect(climbing.status, path).toBe(403);
    expect(await climbing.json()).toEqual({ error: expect.stringContaining("forwards no call") });
  }
  // The used nonce stays in storage, so a restart of the object does not let a copied call run again.
  await evictDurableObject(env.KITSHN.getByName("kitshn"));
  const reused = await forwarded(key, "POST", address, "nonce-on-01234567890");
  expect(reused.status).toBe(403);
  expect(await reused.json()).toEqual({ error: expect.stringContaining("nonce") });
  const events = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql
      .exec<{ action: string; target: string }>("SELECT action, target FROM ask_events ORDER BY id")
      .toArray(),
  );
  // A call whose signature or nonce fails is no call of the machine, so it writes no event.
  expect(events).toEqual([{ action: "forward", target: `POST ${address}` }]);
});

it("refuses the machine's own token on every agent path over HTTP without the daemon's signature (K-1714)", async () => {
  stubAccessCerts();
  await setup({ runs: { mode: "automatic" }, changes: { mode: "automatic" } });
  const token = await accessToken("agent-aud", { common_name: "vps.access" });
  const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
  for (const [method, path] of [
    ["GET", "/agent/state"],
    ["POST", "/agent/apply"],
    ["POST", "/agent/jobs"],
    ["GET", "/agent/jobs/1"],
    ["POST", "/agent/deploy"],
    ["POST", "/agent/repos/123"],
    ["POST", "/agent/library"],
  ] as const) {
    const response = await send(path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status, path).toBe(403);
  }
});
