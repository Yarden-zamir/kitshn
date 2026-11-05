import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Author } from "../src/core/changes.ts";
import type { Circle, State } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { key, withActors } from "./actors.ts";

/** K-212: a timed card leaves every circle for the tray at its end, as one revision that Undo takes back. */

const owner = () => accessToken("admin-aud", { email: "owner@example.com" });
const agent = (clientId: string) => accessToken("agent-aud", { common_name: clientId });

const agentCircle = (id: string, clientId: string, x: number): Circle => ({
  id,
  name: id,
  color: "#7c3aed",
  level: "control",
  members: [key(`t-${id}`, clientId, id)],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 2000,
  r: 300,
});

const post = async (path: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  send(path, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

interface Seen {
  readonly places: Record<string, { x: number; y: number }>;
  readonly ends: Record<string, number>;
  readonly revisions: ReadonlyArray<{ id: number; summary: string; actor: Author }>;
}
const seen = async () =>
  (await (
    await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
  ).json()) as Seen;

/** A page that the agent `clientId` publishes into its own agent circle at `x`. */
async function page(clientId: string, x: number) {
  const circle = agentCircle(`c-${x}`, clientId, x);
  expect(
    (
      await post("/api/apply", await owner(), {
        edits: withActors([{ _tag: "circle", id: circle.id, after: circle }]),
      })
    ).status,
  ).toBe(200);
  const published = await post("/agent/library", await agent(clientId), "<p>preview</p>", {
    "content-type": "text/html",
    "x-kitshn-name": "preview.html",
    "x-kitshn-circle": circle.id,
    "content-length": "14",
  });
  expect(published.status, await published.clone().text()).toBe(201);
  return ((await published.json()) as { id: string }).id;
}

/** Moves the end time of `id` into the past, as if its hour went by. */
const timePasses = (id: string) =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (instance, state) => {
    state.storage.sql.exec("UPDATE card_ends SET ends_at = 1 WHERE id = ?", id);
    const kitshn = instance as unknown as { state: State };
    kitshn.state = { ...kitshn.state, ends: new Map(kitshn.state.ends).set(id, 1) };
  });

afterEach(() => vi.restoreAllMocks());

it("ends a timed card as one revision to the tray, as its setter, and the Undo gives the shares back for good (K-212)", async () => {
  stubAccessCerts();
  const id = await page("preview.access", 6000);
  const place = (await seen()).places[id];
  expect(place).toBeDefined();
  const set = await post(`/api/cards/${id}/time`, await owner(), { endsAt: Date.now() + 3_600_000 });
  expect(set.status, await set.clone().text()).toBe(200);
  expect((await seen()).ends[id]).toBeGreaterThan(Date.now());
  // An extension and its Undo: the restored end time keeps its setter, so the owner can undo the end later too.
  const extended = await post(`/api/cards/${id}/time`, await owner(), { endsAt: Date.now() + 7_200_000 });
  const { revision } = (await extended.json()) as { revision: number };
  expect((await post("/api/undo", await owner(), { revision })).status).toBe(200);

  await timePasses(id);
  await runDurableObjectAlarm(env.KITSHN.getByName("kitshn"));
  const ended = await seen();
  expect([ended.places[id], ended.ends[id]]).toEqual([undefined, undefined]);
  const [expiry] = ended.revisions;
  expect(expiry?.summary).toMatch(/^Time of preview ended: /);
  expect(expiry?.actor).toEqual({ _tag: "person", email: "owner@example.com" });

  expect((await post("/api/undo", await owner(), { revision: expiry?.id })).status).toBe(200);
  await runDurableObjectAlarm(env.KITSHN.getByName("kitshn"));
  const back = await seen();
  // The past end time does not come back, so the alarm leaves the card where it is.
  expect([back.places[id], back.ends[id]]).toEqual([place, undefined]);
});

it("refuses an end time on the admin card (K-105)", async () => {
  stubAccessCerts();
  const answer = await post("/api/cards/kitshn-admin/time", await owner(), {
    endsAt: Date.now() + 3_600_000,
  });
  expect([answer.status, await answer.json()]).toEqual([
    409,
    { error: "The kitshn admin cannot have an end time." },
  ]);
});

it("lets an agent set, extend and end the time of a card that it manages, and of no other (K-212, K-718)", async () => {
  stubAccessCerts();
  const id = await page("timer.access", 8000);
  const time = async (clientId: string, body: unknown) =>
    post(`/agent/cards/${id}/time`, await agent(clientId), body);
  const hour = Date.now() + 3_600_000;
  expect((await time("timer.access", { endsAt: hour })).status).toBe(200);
  expect((await time("timer.access", { endsAt: hour + 3_600_000 })).status).toBe(200);
  expect((await seen()).ends[id]).toBe(hour + 3_600_000);
  await page("other.access", 9000);
  expect((await time("other.access", { endsAt: hour })).status).toBe(403);
  expect((await time("timer.access", { endsAt: 1 })).status).toBe(400);
  expect((await time("timer.access", { now: true })).status).toBe(200);
  const after = await seen();
  expect([after.places[id], after.ends[id]]).toEqual([undefined, undefined]);
});

it("ends a timed card during a lockdown too, because the end only lowers access (K-212, K-1504)", async () => {
  stubAccessCerts();
  const id = await page("paused.access", 10000);
  expect(
    (await post(`/api/cards/${id}/time`, await owner(), { endsAt: Date.now() + 3_600_000 })).status,
  ).toBe(200);
  expect(
    (await post("/api/apply", await owner(), { edits: [{ _tag: "pause", after: "lockdown" }] })).status,
  ).toBe(200);
  await timePasses(id);
  await runDurableObjectAlarm(env.KITSHN.getByName("kitshn"));
  const after = await seen();
  expect([after.places[id], after.ends[id]]).toEqual([undefined, undefined]);
});
