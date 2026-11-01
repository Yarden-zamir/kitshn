import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import type { Circle } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { forwarded, setup } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

const ADMIN = "admin-aud";
const call = (target: string, body: unknown = {}) => JSON.stringify({ target, body, reason: "test" });

it("lets an agent do owner actions through /op: care runs, a circle edit waits for the Owner, and the approval runs that call once (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // A right set makes "agents" an agent circle of the machine (K-1730).
  await setup({ deploys: { mode: "automatic" } }, key);
  const op = (id: string, nonce: string, body: string) =>
    forwarded(key, "POST", `/op/${id}`, `${nonce}-0123456789abcdef`, body, {}, ADMIN);

  // "maintains" starts automatic for a machine in an agent circle (Y2), so the setting changes at once (K-626).
  const care = await op("machine-auto-update", "care", call("vps", { autoUpdate: false }));
  expect(care.status, await care.clone().text()).toBe(200);
  expect(await care.json()).toMatchObject({ outcome: "done", result: { id: "vps", autoUpdate: false } });

  // A circle edit raises access, so it asks the Owner (K-715); the proposal names no right.
  const renamed: Circle = {
    id: "agents",
    name: "Builders",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights: { deploys: { mode: "automatic" } } }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  const edit = call("", { edits: [{ _tag: "circle", id: "agents", after: renamed }] });
  const first = await op("apply", "edit-1", edit);
  expect(first.status).toBe(409);
  const waiting = (await first.json()) as { outcome: string; proposalId: string };
  expect(waiting.outcome).toBe("waiting");
  const stub = env.KITSHN.getByName("kitshn");
  const right = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ right_name: string }>("SELECT right_name FROM proposals WHERE id = ?", waiting.proposalId)
      .one(),
  );
  expect(right.right_name).toBe("owner");
  await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
    ).decide(waiting.proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    }),
  );
  const second = await op("apply", "edit-2", edit);
  expect(second.status, await second.clone().text()).toBe(200);
  const name = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
  );
  expect((JSON.parse(name.body) as Circle).name).toBe("Builders");
  // The approval covers only the call that it named: another edit asks again.
  const other = call("", {
    edits: [{ _tag: "circle", id: "agents", after: { ...renamed, name: "Others" } }],
  });
  const third = await op("apply", "edit-3", other);
  expect(third.status).toBe(409);

  // Only a person resumes; the refusal says why.
  const resume = await op("resume", "resume", call(""));
  expect(resume.status).toBe(403);
  expect(await resume.json()).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("passkey"),
  });
});

it("runs an owner call at once, and refuses a service token that is no machine (K-1732, K-1777)", async () => {
  stubAccessCerts();
  await setup({});
  const post = async (claims: { email: string } | { common_name: string }) =>
    send("/op/machine-order", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessToken(ADMIN, claims),
        "content-type": "application/json",
      },
      body: call("vps", { order: 7 }),
    });
  const owner = await post({ email: "owner@example.com" });
  expect(owner.status, await owner.clone().text()).toBe(200);
  expect(await owner.json()).toMatchObject({ outcome: "done", result: { order: 7 } });
  const key = await post({ common_name: "someone.access" });
  expect(key.status).toBe(403);
});

it("refuses an unsigned call of a machine token on /op (K-1714)", async () => {
  stubAccessCerts();
  await setup({});
  const answer = await send("/op/machine-order", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken(ADMIN, { common_name: "vps.access" }),
      "content-type": "application/json",
    },
    body: call("vps", { order: 3 }),
  });
  expect(answer.status).toBe(403);
});
