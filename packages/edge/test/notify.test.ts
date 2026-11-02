import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Resource } from "../src/core/model.ts";
import type { Usage } from "../src/core/usage.ts";
import { send } from "./access.ts";

interface Kitshn {
  sql(
    query: string,
    ...bindings: Array<string | number | null>
  ): Array<Record<string, string | number | null>>;
  load(): void;
  mintNotifyToken(card: string, pending: string): string;
  broadcast(): void;
  limitsUsage: Usage | null;
  presence: Map<string, { online: boolean; lastSeen: number; os: null }>;
}

const card = (id: string): Resource => ({
  id,
  kind: "site.static",
  name: id,
  addresses: [`${id}.example.com`],
  status: "running",
  group: null,
  machine: null,
});

const post = (token: string, body: object) =>
  send("/notify", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("takes 10 calls an hour per card and 30 for all cards together, then 429 with Retry-After (K-1908)", async () => {
  const ids = ["one", "two", "three", "four"];
  const tokens = await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) => {
    const kitshn = instance as unknown as Kitshn;
    for (const id of ids)
      kitshn.sql("INSERT INTO resources (id, body) VALUES (?, ?)", id, JSON.stringify(card(id)));
    kitshn.load();
    return Object.fromEntries(ids.map((id) => [id, kitshn.mintNotifyToken(id, `test:${id}`)]));
  });
  const token = (id: string) => tokens[id] ?? "";
  for (let i = 0; i < 9; i++) expect((await post(token("one"), { title: `one ${i}` })).status).toBe(200);
  // A resolve counts against the card's window too: the 10th call of card one.
  expect((await post(token("one"), { title: "one 0", resolved: true })).status).toBe(200);
  const perCard = await post(token("one"), { title: "one 9" });
  expect(perCard.status).toBe(429);
  expect(Number(perCard.headers.get("retry-after"))).toBeGreaterThan(0);
  for (const id of ["two", "three"])
    for (let i = 0; i < 10; i++) expect((await post(token(id), { title: `${id} ${i}` })).status).toBe(200);
  // Card four has room of its own, but all cards together have 29 notifications and one resolve did not count.
  expect((await post(token("four"), { title: "four 0" })).status).toBe(200);
  expect((await post(token("four"), { title: "four 1" })).status).toBe(429);
  const states = await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
    (instance as unknown as Kitshn).sql(
      "SELECT state FROM notifications WHERE source = 'app' AND key = 'one:one 0'",
    ),
  );
  expect(states).toEqual([{ state: "closed" }]);
  // The body is checked before the windows.
  expect((await post(token("two"), { title: "x".repeat(101) })).status).toBe(400);
  expect((await post(token("four"), { title: "t", text: "x".repeat(5000) })).status).toBe(413);
});

it("opens a limits notification at 80% and a machine notification after 15 minutes offline, and closes them (K-1910)", async () => {
  const states = await runInDurableObject(env.KITSHN.getByName("own-sources"), (instance) => {
    const kitshn = instance as unknown as Kitshn;
    const machine = { id: "box", name: "Box" };
    kitshn.sql(
      "INSERT INTO machines (id, body) VALUES ('box', ?)",
      JSON.stringify({
        ...machine,
        labels: [],
        order: 0,
        clientId: "c",
        tokenId: "t",
        tunnelId: "u",
        key: null,
      }),
    );
    kitshn.load();
    const row = (used: number) => ({
      label: "Durable Object rows read",
      used,
      limit: 100,
      period: "day" as const,
      unit: "count" as const,
      docs: "",
    });
    const read = () =>
      kitshn.sql(
        "SELECT source, state FROM notifications WHERE source IN ('limits', 'machine') ORDER BY source",
      );
    kitshn.limitsUsage = { at: 0, rows: [row(85)] };
    kitshn.presence.set("box", { online: false, lastSeen: Date.now() - 16 * 60_000, os: null });
    kitshn.broadcast();
    const open = read();
    kitshn.limitsUsage = { at: 1, rows: [row(10)] };
    kitshn.presence.set("box", { online: true, lastSeen: Date.now(), os: null });
    kitshn.broadcast();
    return { open, after: read() };
  });
  expect(states.open).toEqual([
    { source: "limits", state: "open" },
    { source: "machine", state: "open" },
  ]);
  expect(states.after).toEqual([
    { source: "limits", state: "closed" },
    { source: "machine", state: "closed" },
  ]);
});

it("counts the 15 minutes offline from the last ping of a socket that kitshn finds dead late (K-1910, K-1107)", async () => {
  const since = Date.now() - 16 * 60_000;
  const states = await runInDurableObject(env.KITSHN.getByName("dead-socket"), (instance, durable) => {
    const kitshn = instance as unknown as Kitshn & { checkLiveness(now: number): void };
    kitshn.sql(
      "INSERT INTO machines (id, body) VALUES ('box', ?)",
      JSON.stringify({
        id: "box",
        name: "Box",
        labels: [],
        order: 0,
        clientId: "c",
        tokenId: "t",
        tunnelId: "u",
      }),
    );
    kitshn.load();
    // A daemon that stopped answering 16 minutes ago, on a socket that never closed.
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    durable.acceptWebSocket(server, ["box", "machines"]);
    client.accept();
    server.serializeAttachment({
      kind: "machine",
      machineId: "box",
      since,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    });
    kitshn.presence.set("box", { online: true, lastSeen: since, os: null });
    kitshn.checkLiveness(Date.now());
    kitshn.broadcast();
    return {
      presence: kitshn.presence.get("box"),
      machine: kitshn.sql("SELECT state FROM notifications WHERE source = 'machine'"),
    };
  });
  expect(states.presence).toMatchObject({ online: false, lastSeen: since });
  expect(states.machine).toEqual([{ state: "open" }]);
});
