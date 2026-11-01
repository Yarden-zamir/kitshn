import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../src/core/logs.ts";
import type { Machine, MachineStatus } from "../src/core/machine.ts";
import type { Edit } from "../src/core/changes.ts";
import type { Circle, Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { key, withActors } from "./actors.ts";

/** K-1804, K-1805: log searches and tails go between a map, the Durable Object and the daemon of the card. */

const stub = () => env.KITSHN.getByName("kitshn");

async function composeCard(machineId: string, card: string) {
  await runInDurableObject(stub(), (instance, durable) => {
    const machine: Machine = {
      id: machineId,
      name: machineId,
      labels: ["deploy"],
      order: 0,
      serviceTokenId: `token-${machineId}`,
      clientId: `${machineId}.access`,
      tunnelId: `tunnel-${machineId}`,
    };
    const resource: Resource = {
      id: card,
      kind: "site.compose",
      name: card,
      addresses: [`${card}.example.com`],
      status: "running",
      group: null,
      machine: machineId,
    };
    durable.storage.sql.exec(
      "INSERT INTO machines (id, body) VALUES (?, ?)",
      machineId,
      JSON.stringify(machine),
    );
    durable.storage.sql.exec(
      "INSERT INTO resources (id, body) VALUES (?, ?)",
      card,
      JSON.stringify(resource),
    );
    // The machines and cards in memory follow the tables. No eviction: a Live timer can keep the object awake.
    (instance as unknown as { load(): void }).load();
  });
}

/** A socket that the Durable Object accepted, and the messages that it sent on it. */
async function socket(tags: Array<string>, attachment: object) {
  const received: Array<Record<string, unknown>> = [];
  const server = await runInDurableObject(stub(), (_instance, durable) => {
    const pair = new WebSocketPair();
    durable.acceptWebSocket(pair[1], tags);
    pair[0].accept();
    pair[0].addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    pair[1].serializeAttachment(attachment);
    return pair[1];
  });
  return { server, received };
}

const daemon = (machineId: string, capabilities: Array<string>) =>
  socket([machineId, "machines"], {
    kind: "machine",
    machineId,
    since: Date.now(),
    challenge: "",
    check: "signed",
    answered: true,
    rotateBy: null,
    status: {
      version: "1",
      os: "linux",
      arch: "x64",
      hostname: machineId,
      tunnel: "running",
      capabilities,
    } satisfies MachineStatus,
    sample: null,
  });

const fromDaemon = (server: WebSocket, message: object) =>
  runInDurableObject(stub(), (instance) => instance.webSocketMessage(server, JSON.stringify(message)));

const close = (server: WebSocket) =>
  runInDurableObject(stub(), async (instance) => {
    server.close(1001, "gone");
    await instance.webSocketClose(server);
  });

/** The messages arrive on the other end of the pair after the call returns. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const search = async (card: string, body: object) => {
  const response = await send(`/api/apps/${card}/logs`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

afterEach(() => vi.restoreAllMocks());

describe("Compose logs (K-1804, K-1805)", () => {
  it("sends a search to the card's daemon and answers with its lines", async () => {
    stubAccessCerts();
    await composeCard("m-search", "app-search");
    const { server, received } = await daemon("m-search", ["logs"]);
    const query = { tab: "app", text: "boom", from: 1000, to: 2000 };
    const answer = search("app-search", query);
    await vi.waitFor(() => expect(received.some((message) => message["type"] === "logs")).toBe(true));
    const request = received.find((message) => message["type"] === "logs");
    expect(request).toMatchObject({ project: "app-search", search: { text: "boom", from: 1000, to: 2000 } });
    const line: LogLine = { at: 1500, source: "web-1", text: "boom" };
    await fromDaemon(server, {
      type: "logs",
      id: request?.["id"],
      answer: { state: "lines", lines: [line], matched: 7, cut: true },
    });
    expect((await answer).body).toEqual({ answer: { state: "lines", lines: [line], matched: 7, cut: true } });
    await close(server);
  });

  it("refuses a daemon that cannot read logs, and a card that has none", async () => {
    stubAccessCerts();
    await composeCard("m-old", "app-old");
    const { server } = await daemon("m-old", ["compose"]);
    const old = await search("app-old", { tab: "app", text: "", from: 0, to: 1 });
    expect(old.body["answer"]).toMatchObject({
      state: "error",
      error: expect.stringMatching(/Update the daemon/),
    });
    await close(server);
    const none = await search("kitshn-admin", { tab: "app", text: "", from: 0, to: 1 });
    expect(none.status).toBe(409);
  });

  it("sends tail lines only to the map that holds the tail, and stops a tail that no map holds", async () => {
    await composeCard("m-tail", "app-tail");
    const machine = await daemon("m-tail", ["logs"]);
    const map = await socket(["map"], {
      kind: "map",
      caller: {
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        actor: { _tag: "person", email: "owner@example.com" },
      },
      tails: [{ kind: "compose", id: "t1", machineId: "m-tail" }],
    });
    const line: LogLine = { at: 1, source: "web-1", text: "hello" };
    await fromDaemon(machine.server, { type: "tailLines", id: "t1", lines: [line], skipped: 2 });
    await fromDaemon(machine.server, { type: "tailLines", id: "lost", lines: [line], skipped: 0 });
    await settle();
    expect(map.received).toEqual([{ type: "tailLines", tail: "t1", lines: [line], skipped: 2 }]);
    expect(machine.received).toContainEqual({ type: "tailStop", id: "lost" });
    // A map that closes stops its tails on the daemon.
    await close(map.server);
    await settle();
    expect(machine.received).toContainEqual({ type: "tailStop", id: "t1" });
    await close(machine.server);
  });

  it("ends the tails of a machine whose connection closes", async () => {
    await composeCard("m-gone", "app-gone");
    const machine = await daemon("m-gone", ["logs"]);
    const map = await socket(["map"], {
      kind: "map",
      caller: {
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        actor: { _tag: "person", email: "owner@example.com" },
      },
      tails: [{ kind: "compose", id: "t2", machineId: "m-gone" }],
    });
    await close(machine.server);
    await settle();
    expect(map.received).toContainEqual({
      type: "tailEnd",
      tail: "t2",
      reason: expect.stringMatching(/closed/),
    });
    await close(map.server);
  });
});

it("stops the tail of a closing map while the daemon's socket closes too (K-1805)", async () => {
  await composeCard("m-closing", "app-closing");
  const machine = await daemon("m-closing", ["logs"]);
  const map = await socket(["map"], {
    kind: "map",
    caller: {
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      actor: { _tag: "person", email: "owner@example.com" },
    },
    tails: [{ kind: "compose", id: "t3", machineId: "m-closing" }],
  });
  // The daemon's socket is closing, and kitshn has not seen its close yet, when the map goes.
  await runInDurableObject(stub(), async (instance) => {
    machine.server.close(1001, "gone");
    map.server.close(1001, "gone");
    await instance.webSocketClose(map.server);
  });
  await settle();
  await runInDurableObject(stub(), (instance) => instance.webSocketClose(machine.server));
});

describe("logs for agent keys (K-1810)", () => {
  const circle = (id: string, clientId: string, x: number, level: "view" | "control"): Circle => ({
    id,
    name: id,
    color: "#7c3aed",
    level,
    members: [key(`t-${id}`, clientId, id)],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x,
    y: 2000,
    r: 300,
  });
  const owner = () => accessToken("admin-aud", { email: "owner@example.com" });
  const asKey = async (clientId: string, card: string) => {
    const response = await send("/agent/logs", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessToken("agent-aud", { common_name: clientId }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ card, tab: "deploys", text: "", from: 0, to: Date.now() }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("answers a key that controls the card, and refuses a key at view and a key without the card", async () => {
    stubAccessCerts();
    await composeCard("m-keys", "app-keys");
    const edits: ReadonlyArray<Edit> = [
      {
        _tag: "circle",
        id: "keys-control",
        after: circle("keys-control", "agent-c.access", 2000, "control"),
      },
      { _tag: "circle", id: "keys-view", after: circle("keys-view", "agent-v.access", 2200, "view") },
      { _tag: "place", id: "app-keys", after: { x: 2100, y: 2000 } },
    ];
    const applied = await send("/api/apply", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await owner(), "content-type": "application/json" },
      body: JSON.stringify({ edits: withActors(edits) }),
    });
    expect(applied.status).toBe(200);
    expect(await asKey("agent-c.access", "app-keys")).toEqual({ status: 200, body: { runs: [] } });
    expect((await asKey("agent-v.access", "app-keys")).status).toBe(403);
    expect((await asKey("agent-c.access", "app-other")).status).toBe(403);
    // K-1810: at most 30 searches a minute per key; the first one above counts.
    for (let index = 1; index < 30; index++)
      expect((await asKey("agent-c.access", "app-keys")).status).toBe(200);
    const limited = await send("/agent/logs", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessToken("agent-aud", { common_name: "agent-c.access" }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ card: "app-keys", tab: "deploys", text: "", from: 0, to: Date.now() }),
    });
    expect([limited.status, Number(limited.headers.get("retry-after"))]).toEqual([429, expect.any(Number)]);
    await limited.arrayBuffer();
  });
});
