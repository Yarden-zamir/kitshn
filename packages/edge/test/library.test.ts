import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "../src/core/changes.ts";
import type { Circle } from "../src/core/model.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker/index.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { key, withActors } from "./actors.ts";

/** K-1116, K-1117: an agent key publishes a page, updates it by name, and the owner restores its previous version. */

const agentCircle = (id: string, clientId: string, x: number, publishes = false): Circle => ({
  id,
  name: id,
  color: "#7c3aed",
  level: "control",
  members: [key(`t-${id}`, clientId, id, publishes ? { publishes } : {})],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y: 2000,
  r: 300,
});

const owner = () => accessToken("admin-aud", { email: "owner@example.com" });
const agent = (clientId: string) => accessToken("agent-aud", { common_name: clientId });

async function apply(edits: ReadonlyArray<Edit>) {
  const answer = await send("/api/apply", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await owner(), "content-type": "application/json" },
    body: JSON.stringify({ edits: withActors(edits) }),
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

/** A stream body says its length, as a client must; a wrong one would leave the upload waiting for bytes. */
type Body = string | { readonly stream: ReadableStream<Uint8Array>; readonly length: number };

async function publish(clientId: string, name: string, body: Body, extra: Record<string, string> = {}) {
  return send("/agent/library", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await agent(clientId),
      "x-kitshn-name": encodeURIComponent(name),
      "content-length": String(
        typeof body === "string" ? new TextEncoder().encode(body).length : body.length,
      ),
      ...extra,
    },
    body: typeof body === "string" ? body : body.stream,
  });
}

const idOf = async (response: Response) => ((await response.json()) as { id: string }).id;

/** A visit to `pages.<zone>` or `files.<zone>` with no login. */
async function visit(path: string, host = "pages.example.com") {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://${host}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function ownerPost(path: string, body: unknown) {
  return send(path, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": await owner(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const content = async (id: string) =>
  (
    await send(`/api/library/${id}/content`, { headers: { "cf-access-jwt-assertion": await owner() } })
  ).text();

const state = async () =>
  (await (await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })).json()) as {
    places: Record<string, { x: number; y: number }>;
    previousVersions: ReadonlyArray<string>;
  };

afterEach(() => vi.restoreAllMocks());

describe("agent publish (K-1116, K-1117)", () => {
  it("publishes a page, updates it by name, and keeps one previous version to restore", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);

    const first = await publish("agent-1.access", "design.html", "<html>v1</html>");
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    // No circle: the page waits in the tray, private.
    expect((await state()).places[id]).toBeUndefined();

    const second = await publish("agent-1.access", "design.html", "<html>version two</html>");
    expect(await second.json()).toMatchObject({ id, updated: true });
    expect(await content(id)).toBe("<html>version two</html>");
    expect((await state()).previousVersions).toContain(id);

    const restore = () =>
      owner().then((token) =>
        send(`/api/library/${id}/previous`, {
          method: "POST",
          headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
          body: "{}",
        }),
      );
    expect((await restore()).status).toBe(200);
    expect(await content(id)).toBe("<html>v1</html>");
    // A second restore swaps back.
    expect((await restore()).status).toBe(200);
    expect(await content(id)).toBe("<html>version two</html>");
  });

  it("lands in the agent circle that it names, and another key cannot restore its page", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) },
      { _tag: "circle", id: "others", after: agentCircle("others", "agent-2.access", 3000) },
    ]);
    const placed = await publish("agent-1.access", "notes.html", "<p>one</p>", {
      "x-kitshn-circle": "agents",
    });
    expect(placed.status).toBe(201);
    const { id } = (await placed.json()) as { id: string };
    const place = (await state()).places[id];
    expect(place && Math.hypot(place.x - 2000, place.y - 2000)).toBeLessThan(300);

    await publish("agent-1.access", "notes.html", "<p>two</p>");
    const foreign = await send(`/agent/library/${id}/previous`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await agent("agent-2.access") },
    });
    expect(foreign.status).toBe(403);
    // A circle that is not its own refuses the upload before anything lands.
    const refused = await publish("agent-1.access", "other.html", "<p>x</p>", {
      "x-kitshn-circle": "others",
    });
    expect(refused.status).toBe(403);
  });

  it("goes back to the previous version and removes a page that it published, and not one of another key (K-1117)", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) },
      { _tag: "circle", id: "others", after: agentCircle("others", "agent-2.access", 3000) },
    ]);
    const id = await idOf(await publish("agent-1.access", "gone.html", "<p>one</p>"));
    await publish("agent-1.access", "gone.html", "<p>two</p>");
    const call = async (clientId: string, method: string, path: string) =>
      send(path, {
        method,
        headers: { "cf-access-jwt-assertion": await agent(clientId), "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
    const back = await call("agent-1.access", "POST", `/agent/cards/${id}/previous`);
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await content(id)).toBe("<p>one</p>");
    expect((await call("agent-2.access", "DELETE", `/agent/cards/${id}`)).status).toBe(403);
    const removed = await call("agent-1.access", "DELETE", `/agent/cards/${id}`);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await call("agent-1.access", "POST", `/agent/cards/${id}/previous`)).status).toBe(403);
  });

  it("has no /agent/publish route any more; a public move goes through /agent/apply (K-718)", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const gone = await send("/agent/publish", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await agent("agent-1.access"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ card: "x", public: true }),
    });
    expect(gone.ok).toBe(false);
  });
  it("keeps the served version when an update fails, and gives key B its own card", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) },
      { _tag: "circle", id: "others", after: agentCircle("others", "agent-2.access", 3000) },
    ]);
    const id = await idOf(await publish("agent-1.access", "kept.html", "<html>v1</html>"));
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>v2"));
        controller.error(new Error("the connection dropped"));
      },
    });
    // The connection drops after 8 of the 15 bytes that it announced.
    expect((await publish("agent-1.access", "kept.html", { stream: broken, length: 15 })).status).toBe(502);
    expect(await content(id)).toBe("<html>v1</html>");
    expect((await state()).previousVersions).not.toContain(id);

    const other = await publish("agent-2.access", "kept.html", "<html>b</html>");
    expect(other.status).toBe(201);
    expect(await idOf(other)).not.toBe(id);
    expect(await content(id)).toBe("<html>v1</html>");
  });

  it("updates only while the key controls the card, and refuses --circle on an update (K-1117)", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const id = await idOf(
      await publish("agent-1.access", "control.html", "<p>one</p>", { "x-kitshn-circle": "agents" }),
    );
    const moved = await publish("agent-1.access", "control.html", "<p>two</p>", {
      "x-kitshn-circle": "agents",
    });
    expect(moved.status).toBe(409);
    // The owner moves the card out of the agent circle, so the key no longer controls it.
    await apply([{ _tag: "place", id, after: { x: -4000, y: -4000 } }]);
    expect((await publish("agent-1.access", "control.html", "<p>two</p>")).status).toBe(403);
    expect(await content(id)).toBe("<p>one</p>");
  });
  it("refuses an update when the owner moves the tray card during the write, and keeps no stale version", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const id = await idOf(await publish("agent-1.access", "race.html", "<p>one</p>"));
    expect((await publish("agent-1.access", "race.html", "<p>number two</p>")).status).toBe(200);
    const last = new TextEncoder().encode("<p>three</p>");
    let finish = () => {};
    const slow = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(last);
          controller.close();
        };
      },
    });
    const update = publish("agent-1.access", "race.html", { stream: slow, length: last.length });
    const { circles } = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as { circles: ReadonlyArray<Circle> };
    const everyone = circles.find((circle) => circle.id === "everyone");
    if (!everyone) throw new Error("The seed has no Everyone circle.");
    await apply([{ _tag: "place", id, after: { x: everyone.x, y: everyone.y } }]);
    finish();
    expect((await update).status).toBe(403);
    expect(await content(id)).toBe("<p>number two</p>");
    expect((await state()).previousVersions).not.toContain(id);
    // Back in the tray by the owner, the card stays out of the key's reach.
    await apply([{ _tag: "place", id, after: null }]);
    expect((await publish("agent-1.access", "race.html", "<p>four</p>")).status).toBe(403);
  });

  it("serves a page at its name, sends old names and the id on, and undoes a new name (K-1120)", async () => {
    stubAccessCerts();
    await apply([{ _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000) }]);
    const named = await publish("agent-1.access", "named.html", "<p>named</p>", {
      "x-kitshn-address": "my-design",
    });
    const { id, address } = (await named.json()) as { id: string; address: string };
    expect(address).toBe("pages.example.com/my-design");
    const random = (await (await publish("agent-1.access", "plain.html", "<p>x</p>")).json()) as {
      address: string;
    };
    expect(random.address.split("/")[1]?.split("-")).toHaveLength(3);
    expect(random.address).not.toContain("plain");
    const taken = await publish("agent-1.access", "other.html", "<p>y</p>", {
      "x-kitshn-address": "my-design",
    });
    expect(taken.status).toBe(409);

    // In Everyone, the page opens with no login.
    const { circles } = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as { circles: ReadonlyArray<Circle> };
    const everyone = circles.find((circle) => circle.id === "everyone");
    if (!everyone) throw new Error("The seed has no Everyone circle.");
    await apply([{ _tag: "place", id, after: { x: everyone.x, y: everyone.y } }]);
    expect(await (await visit("/my-design")).text()).toBe("<p>named</p>");

    const renamed = await ownerPost(`/api/cards/${id}/address`, { address: "renamed" });
    const { revision } = (await renamed.json()) as { revision: number };
    for (const old of ["/my-design", `/${id}`]) {
      const sent = await visit(old);
      expect([sent.status, sent.headers.get("location")]).toEqual([302, "https://pages.example.com/renamed"]);
    }
    expect(await (await visit("/renamed")).text()).toBe("<p>named</p>");
    // The old name stays with its page.
    expect(
      (await publish("agent-1.access", "late.html", "<p>z</p>", { "x-kitshn-address": "my-design" })).status,
    ).toBe(409);
    // Out of its agent circle, the key cannot rename the card.
    const foreign = await send(`/agent/cards/${id}/address`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await agent("agent-1.access"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "mine" }),
    });
    expect(foreign.status).toBe(403);
    // A key gets the same answer for a card that does not exist, so it learns no names.
    const unknown = await send("/agent/cards/no-such-card/address", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await agent("agent-1.access"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "mine" }),
    });
    expect(unknown.status).toBe(403);
    // The text up to the card that the key named, which differs between the two calls.
    const said = async (response: Response) => {
      const { error } = (await response.json()) as { error: string };
      return error.slice(0, error.indexOf('"'));
    };
    expect(await said(unknown)).toBe(await said(foreign));

    expect((await ownerPost("/api/undo", { revision })).status).toBe(200);
    expect(await (await visit("/my-design")).text()).toBe("<p>named</p>");
    expect((await visit("/renamed")).headers.get("location")).toBe("https://pages.example.com/my-design");

    // The current name changes nothing; the name of another item is taken.
    expect(await (await ownerPost(`/api/cards/${id}/address`, { address: "my-design" })).json()).toEqual({
      card: id,
      kind: "page",
      address: "pages.example.com/my-design",
      revision: null,
    });
    const otherName = random.address.split("/")[1] ?? "";
    expect((await ownerPost(`/api/cards/${id}/address`, { address: otherName })).status).toBe(409);

    // K-1122: past 5 old names, the oldest go free. Old now: renamed; the six renames push out my-design and renamed.
    for (const next of ["n-one", "n-two", "n-three", "n-four", "n-five", "n-six"])
      expect((await ownerPost(`/api/cards/${id}/address`, { address: next })).status).toBe(200);
    expect((await visit("/renamed")).status).toBe(404);
    expect((await visit("/n-one")).headers.get("location")).toBe("https://pages.example.com/n-six");
    expect(
      (await publish("agent-1.access", "freed.html", "<p>f</p>", { "x-kitshn-address": "my-design" })).status,
    ).toBe(201);

    // A name that the item takes back counts as its newest: after n-one comes back, the next rename frees n-two.
    for (const next of ["n-one", "n-seven"])
      expect((await ownerPost(`/api/cards/${id}/address`, { address: next })).status).toBe(200);
    expect((await visit("/n-one")).headers.get("location")).toBe("https://pages.example.com/n-seven");
    expect((await visit("/n-two")).status).toBe(404);

    // A delete frees every name of the item.
    const deleted = await send(`/api/library/${id}`, {
      method: "DELETE",
      headers: { "cf-access-jwt-assertion": await owner() },
    });
    expect(deleted.status).toBe(200);
    expect(
      (await publish("agent-1.access", "after.html", "<p>a</p>", { "x-kitshn-address": "n-seven" })).status,
    ).toBe(201);

    // A file keeps its file name when an old name sends a visitor on.
    const file = await idOf(
      await publish("agent-1.access", "pic.png", "png bytes", {
        "x-kitshn-address": "pic",
        "content-type": "image/png",
      }),
    );
    await apply([{ _tag: "place", id: file, after: { x: everyone.x, y: everyone.y + 40 } }]);
    expect((await ownerPost(`/api/cards/${file}/address`, { address: "pic-two" })).status).toBe(200);
    expect((await visit("/pic/pic.png", "files.example.com")).headers.get("location")).toBe(
      "https://files.example.com/pic-two/pic.png",
    );
  });

  // Last: the Durable Object keeps its state across the tests of this file, and only a passkey resumes.
  it("refuses a new public page during a keep-public pause (K-1504)", async () => {
    stubAccessCerts();
    await apply([
      { _tag: "circle", id: "agents", after: agentCircle("agents", "agent-1.access", 2000, true) },
    ]);
    // Everyone sits next to the agent circle, so the two overlap.
    const everyone = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": await owner() } })
    ).json()) as { circles: ReadonlyArray<Circle> };
    const open = everyone.circles.find((circle) => circle.id === "everyone");
    if (!open) throw new Error("The seed has no Everyone circle.");
    await apply([
      { _tag: "circle", id: "everyone", after: { ...open, x: 2400, y: 2000, r: 300 } },
      { _tag: "pause", after: "keep-public" },
    ]);
    const refused = await publish("agent-1.access", "open.html", "<p>open</p>", {
      "x-kitshn-public": "true",
    });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await state())).not.toContain("open.html");
  });
});
