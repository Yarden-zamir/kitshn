import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import { stubAccessCerts } from "./access.ts";
import { agent } from "./actors.ts";
import { forwarded, setup } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

// Its own file: HTTP probes of one file share a runtime, and a refused upload of another test held this one up.
it("gives a forwarded public page that misses the agent actor the mode of the machine chip (K-1714, K-1754, K-1778)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // "publishes" runs at once only for the agent of project kitshn; the bare machine has it at default, so it asks the Owner.
  await setup({ addsPages: { mode: "automatic" } }, key, { x: 1100, y: 0 }, [
    agent("vps", [{ key: "t3.project.name", values: ["kitshn"] }], { publishes: { mode: "automatic" } }),
  ]);
  const page = { "x-kitshn-name": "p.html", "content-type": "text/html" };
  const open = await forwarded(key, "POST", "/agent/library", "nonce-public-0123456789", "<p>x</p>", {
    ...page,
    "x-kitshn-public": "true",
  });
  expect(open.status).toBe(409);
  expect(await open.json()).toMatchObject({ outcome: "waiting" });
});

it("lets one Owner approval run a forwarded public page whose rights are unset, once and only that page (K-1714, K-1776)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // The agent circle overlaps Everyone (K-718), so a public page has a spot.
  await setup({ deploys: { mode: "automatic" } }, key, { x: 1100, y: 0 });
  const page = { "x-kitshn-name": "q.html", "content-type": "text/html", "x-kitshn-public": "true" };
  const first = await forwarded(key, "POST", "/agent/library", "nonce-owner-0123456789", "<p>q</p>", page);
  expect(first.status).toBe(409);
  const { proposalId } = (await first.json()) as { proposalId: string };
  const stub = env.KITSHN.getByName("kitshn");
  const shown = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ shown: string; right_name: string }>(
        "SELECT shown, right_name FROM proposals WHERE id = ?",
        proposalId,
      )
      .one(),
  );
  // The approver reads the headers that decide the effect and the body.
  expect(shown.shown).toContain("x-kitshn-public: true");
  expect(shown.shown).toContain("<p>q</p>");
  await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
    ).decide(proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    }),
  );
  // "adds pages" and "publishes" both ask the Owner, so the one approval covers both, and the page lands.
  const second = await forwarded(key, "POST", "/agent/library", "nonce-owner-1123456789", "<p>q</p>", page);
  expect(second.status, await second.clone().text()).toBe(201);
  // The approval ran one call: the same call again asks again.
  const third = await forwarded(key, "POST", "/agent/library", "nonce-owner-3123456789", "<p>q</p>", page);
  expect(third.status).toBe(409);
  expect(((await third.json()) as { proposalId: string }).proposalId).not.toBe(proposalId);
  const changed = await forwarded(key, "POST", "/agent/library", "nonce-owner-2123456789", "<p>z</p>", page);
  expect(changed.status).toBe(409);
});

it("binds an approval of a forwarded call to the thread that asked (K-1714)", async () => {
  const now = Date.now();
  const found = await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO proposals (id, machine_id, credential, action, target, body, reason, labels, right_name, circle_id, shown, shown_hash,
       state, created_at, expires_at, verified, decided_at, decided_by) VALUES ('p-thread', 'vps', 'machine/vps', 'forward', 'POST /agent/library', 'null',
       NULL, '{"t3.thread.id":"a"}', 'addsPages', 'owner', 's', 'h-thread', 'approved', ?, ?, '[]', ?, ?)`,
      now,
      now + 60_000,
      now,
      JSON.stringify({ actor: { _tag: "person", email: "owner@example.com" }, reason: null }),
    );
    const approval = (thread: string | null) =>
      (
        instance as unknown as {
          forwardApproval(
            m: string,
            h: string,
            c: string,
            r: string,
            t: string | null,
            n: number,
          ): object | null;
        }
      ).forwardApproval("machine/vps", "h-thread", "owner", "addsPages", thread, now);
    return { same: approval("a"), other: approval("b"), none: approval(null) };
  });
  // K-1777: the approval says that a person gave it, so its job keeps the 1-hour expiry of K-613.
  expect(found).toEqual({ same: { id: "p-thread", person: true }, other: null, none: null });
});
