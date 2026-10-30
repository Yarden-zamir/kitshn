import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { type DoorPlan, HOUR_MS } from "../src/core/port.ts";
import type { Machine } from "../src/core/machine.ts";
import type { Circle, Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** Section 20: a door opens for a person of the card's circles, and closes when the person leaves the circle. */

const friends: Circle = {
  id: "friends",
  name: "Friends",
  color: "#22c55e",
  level: "view",
  members: [{ _tag: "email", email: "friend@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 9000,
  y: 9000,
  r: 300,
};

async function setup() {
  const machine: Machine = {
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "token-vps",
    clientId: "vps.access",
    tunnelId: "tunnel-vps",
  };
  const card: Resource = {
    id: "card1",
    kind: "port",
    name: "mc",
    addresses: ["mc.example.com"],
    status: "unknown",
    group: null,
    machine: "vps",
  };
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(machine));
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES ('friends', ?)", JSON.stringify(friends));
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES ('card1', ?)", JSON.stringify(card));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('card1', 9000, 9000)");
    sql.exec(
      `INSERT OR REPLACE INTO port_cards (card_id, machine_id, name, ports, door_ms, srv, relay_id, v4, v6)
       VALUES ('card1', 'vps', 'mc', '[{"port":25565,"proto":"tcp"}]', 3600000, 'minecraft', NULL, '198.51.100.7', NULL)`,
    );
    sql.exec("DELETE FROM doors");
    sql.exec("DELETE FROM jobs");
  });
  await evictDurableObject(stub);
  return stub;
}

const visitor = (email: string | null, ip: string) => ({
  email,
  clientId: null,
  ip,
  passkey: false,
  issuedAt: null,
});

async function portCard(stub: DurableObjectStub, body: unknown) {
  const answer = await stub.fetch("https://kitshn.internal/internal/connect", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (await answer.json()) as {
    decision: string;
    error: string | null;
    doors: Array<{ address: string }>;
  };
}

const doorJobs = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ command: string; state: string }>(
        "SELECT command, state FROM jobs WHERE json_extract(command, '$.kind') = 'doors' ORDER BY id",
      )
      .toArray()
      .map((row) => ({ state: row.state, plan: (JSON.parse(row.command) as { plan: DoorPlan }).plan })),
  );

it("opens a door per address for a person of the card, and closes them when the person leaves (K-2005, K-2006)", async () => {
  stubAccessCerts();
  const stub = await setup();
  // A door belongs to a person, so no login means the login step.
  expect(
    (await portCard(stub, { name: "mc", action: "view", visitor: visitor(null, "203.0.113.9") })).decision,
  ).toBe("login");
  expect(
    (
      await portCard(stub, {
        name: "mc",
        action: "view",
        visitor: visitor("stranger@example.com", "203.0.113.9"),
      })
    ).decision,
  ).toBe("deny");

  // A private address never opens a door.
  const refused = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "10.1.2.3"),
    addresses: [],
  });
  expect(refused.error).toMatch(/private/);

  // The seen address and each address that the browser found open, an IPv6 one as its /64; a private one does not.
  const opened = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
    addresses: ["203.0.113.50", "192.168.1.2", "2001:db8:1:2:aaaa::1"],
  });
  expect(opened.error).toBeNull();
  const all = ["2001:db8:1:2::/64", "203.0.113.50", "203.0.113.9"];
  expect(opened.doors.map((door) => door.address).sort()).toEqual(all);
  const [first] = await doorJobs(stub);
  expect(first?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  expect(first?.plan.doors.map((door) => door.address).sort()).toEqual(all);

  // The owner takes the friend out of the circle: the doors close at once, with a new plan.
  const edited = await send("/api/apply", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ edits: [{ _tag: "circle", id: "friends", after: { ...friends, members: [] } }] }),
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const jobs = await doorJobs(stub);
  expect(jobs.at(-1)?.plan.doors).toEqual([]);
  expect(jobs.at(-1)?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  expect(jobs.slice(0, -1).every((job) => job.state === "failed")).toBe(true);
  const left = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT * FROM doors").toArray(),
  );
  expect(left).toEqual([]);
});

it("keeps a door when its circle checks the address, and refuses a second open within 10 s (K-2005, K-2006)", async () => {
  stubAccessCerts();
  const stub = await setup();
  const office: Circle = {
    ...friends,
    match: "all",
    members: [
      { _tag: "email", email: "friend@example.com" },
      { _tag: "ip", range: "203.0.113.0/24" },
    ],
  };
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("UPDATE circles SET body = ? WHERE id = 'friends'", JSON.stringify(office));
  });
  await evictDurableObject(stub);
  // A browser address outside the circle's range opens no door.
  const opened = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
    addresses: ["203.0.113.50", "198.51.100.7"],
  });
  expect(opened.error).toBeNull();
  expect(opened.doors.map((door) => door.address).sort()).toEqual(["203.0.113.50", "203.0.113.9"]);
  // Any commit runs the share check of the open doors; it uses the address that opened the door.
  const edited = await send("/api/apply", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ edits: [{ _tag: "circle", id: "friends", after: { ...office, x: 9001 } }] }),
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const again = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
  });
  expect(again.doors.map((door) => door.address).sort()).toEqual(["203.0.113.50", "203.0.113.9"]);
  expect(again.error).toMatch(/Wait a moment/);
});

it("counts End now as a door change, so open and close in a loop wait 10 s (K-2005)", async () => {
  stubAccessCerts();
  const stub = await setup();
  const friend = visitor("friend@example.com", "203.0.113.9");
  expect((await portCard(stub, { name: "mc", action: "open", visitor: friend })).error).toBeNull();
  const closed = await portCard(stub, { name: "mc", action: "close", visitor: friend });
  expect(closed.error).toMatch(/Wait a moment/);
  expect(closed.doors.map((door) => door.address)).toEqual(["203.0.113.9"]);
});

it("removes the port cards, doors and wanted records of a removed machine (K-2001, K-2008)", async () => {
  stubAccessCerts();
  const stub = await setup();
  await portCard(stub, { name: "mc", action: "open", visitor: visitor("friend@example.com", "203.0.113.9") });
  const left = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      api: () => unknown;
      removeMachine: (caller: unknown, id: string) => Promise<Response>;
      sql: (query: string) => Array<unknown>;
      state: { resources: Map<string, unknown> };
    };
    // The Cloudflare side of a removal is not what this test checks.
    kitshn.api = () => async () => ({});
    const caller = {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
    };
    const removed = await kitshn.removeMachine(caller, "vps");
    return {
      status: removed.status,
      portCards: kitshn.sql("SELECT * FROM port_cards").length,
      doors: kitshn.sql("SELECT * FROM doors").length,
      card: kitshn.state.resources.has("card1"),
    };
  });
  expect(left).toEqual({ status: 200, portCards: 0, doors: 0, card: false });
});

it("makes the A and SRV records of a port card in one run (K-2008)", async () => {
  const stub = await setup();
  const result = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      syncPortDns: (api: unknown, budget: number) => Promise<number>;
      sql: (query: string) => Array<{ type: string; error: string | null }>;
    };
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const api = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return method === "GET" ? [] : { id: `record-${calls.length}` };
    };
    const spent = await kitshn.syncPortDns(api, 4);
    return { spent, calls, rows: kitshn.sql("SELECT type, error FROM port_records ORDER BY type") };
  });
  expect(result.spent).toBe(4);
  expect(result.rows).toEqual([
    { type: "A", error: null },
    { type: "SRV", error: null },
  ]);
  expect(
    result.calls.find((call) => call.method === "POST" && call.path.includes("dns_records")),
  ).toBeDefined();
  expect(result.calls.at(-1)?.body).toMatchObject({
    type: "SRV",
    name: "_minecraft._tcp.mc.example.com",
    data: { port: 25565, target: "mc.example.com" },
  });
});

it("opens nothing for a relayed port card when no IPv4 address answered, because the relay listens on IPv4 only (K-2004)", async () => {
  stubAccessCerts();
  const stub = await setup();
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("UPDATE port_cards SET relay_id = 'relay1' WHERE card_id = 'card1'");
  });
  const opened = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "2001:db8:1:2::5"),
    addresses: ["2001:db8:1:2::6"],
  });
  expect(opened.error).toMatch(/needs IPv4/);
  expect(opened.doors).toEqual([]);
});

it("closes every door of the person on the card with End now (K-2005)", async () => {
  stubAccessCerts();
  const stub = await setup();
  // The rows go in directly, so End now is the first door change and the 10 s wait does not apply.
  await runInDurableObject(stub, (_, state) => {
    for (const [person, address] of [
      ["friend@example.com", "203.0.113.9"],
      ["friend@example.com", "198.51.100.7"],
      ["friend@example.com", "2001:db8:1:2::/64"],
      ["other@example.com", "203.0.113.9"],
    ])
      state.storage.sql.exec(
        "INSERT INTO doors (card_id, person, address, opened_at, ends_at, seen_ip) VALUES ('card1', ?, ?, 0, ?, NULL)",
        person,
        address,
        Date.now() + HOUR_MS,
      );
  });
  const closed = await portCard(stub, {
    name: "mc",
    action: "close",
    visitor: visitor("friend@example.com", "203.0.113.9"),
  });
  expect(closed.error).toBeNull();
  expect(closed.doors).toEqual([]);
  const left = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ person: string }>("SELECT person FROM doors").toArray(),
  );
  expect(left.map((row) => row.person)).toEqual(["other@example.com"]);
});

it("opens the ports of a port card in Everyone to all and gates them again after the unshare (K-2005, K-2006)", async () => {
  stubAccessCerts();
  const stub = await setup();
  const owner = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    "content-type": "application/json",
  };
  const state = (await (await send("/api/state", { headers: owner })).json()) as {
    circles: Array<{ id: string; x: number; y: number }>;
  };
  const everyone = state.circles.find((circle) => circle.id === "everyone");
  if (!everyone) throw new Error("The seed has no Everyone circle.");
  const place = (after: { x: number; y: number }) =>
    send("/api/apply", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ edits: [{ _tag: "place", id: "card1", after }] }),
    });

  expect((await place({ x: everyone.x, y: everyone.y })).status).toBe(200);
  expect((await doorJobs(stub)).at(-1)?.plan).toMatchObject({ ports: [], doors: [] });
  // After a restart, a commit sends no plan that equals the last one.
  await evictDurableObject(stub);
  const before = (await doorJobs(stub)).length;
  expect((await place({ x: everyone.x + 1, y: everyone.y })).status).toBe(200);
  expect(await doorJobs(stub)).toHaveLength(before);
  // The connect page needs no login and offers no door.
  const view = (await portCard(stub, {
    name: "mc",
    action: "view",
    visitor: visitor(null, "203.0.113.9"),
  })) as {
    decision: string;
    openToAll?: boolean;
  };
  expect(view).toMatchObject({ decision: "allow", openToAll: true });

  expect((await place({ x: 9000, y: 9000 })).status).toBe(200);
  expect((await doorJobs(stub)).at(-1)?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  const opened = await portCard(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
  });
  expect(opened.error).toBeNull();
  expect((await doorJobs(stub)).at(-1)?.plan.doors.map((door) => door.address)).toEqual(["203.0.113.9"]);

  // Shared again, then a pause gates the ports, and the connect page asks for a login (K-1504).
  expect((await place({ x: everyone.x, y: everyone.y })).status).toBe(200);
  expect((await doorJobs(stub)).at(-1)?.plan.ports).toEqual([]);
  const paused = await send("/api/apply", {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ edits: [{ _tag: "pause", after: "keep-public" }] }),
  });
  expect(paused.status).toBe(200);
  expect((await doorJobs(stub)).at(-1)?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  const login = await portCard(stub, { name: "mc", action: "view", visitor: visitor(null, "203.0.113.9") });
  expect(login.decision).toBe("login");
});
