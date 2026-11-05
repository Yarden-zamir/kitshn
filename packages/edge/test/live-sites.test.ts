import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { machine as machineChip, person, withActors } from "./actors.ts";
import { setup as agentSetup } from "./machine-http.ts";

/** K-1131: the site wizard only makes new sites, through one service that queues `kitshn expose --new`. */

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

afterEach(() => vi.restoreAllMocks());

/** The machine and its card in the Owner circle, so the owner has control on it (K-614). */
async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: "vps",
      kind: "machine",
      name: "vps",
      addresses: [],
      status: "running",
      group: null,
      machine: "vps",
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(card),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
      "vps",
      owner.x,
      owner.y,
    );
  });
  await evictDurableObject(stub);
  return () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ command: string }>("SELECT command FROM jobs ORDER BY id DESC LIMIT 1")
        .toArray()
        .map((row) => (JSON.parse(row.command) as { script: string }).script)
        .at(0),
    );
}

it("queues expose --new for a new name, and refuses a taken address or a bad server (K-1131)", async () => {
  stubAccessCerts();
  const lastScript = await setup();
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const add = (body: object) =>
    send("/api/sites/live", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "vps", dev: false, endsAt: null, ...body }),
    });
  const state = (await (
    await send("/api/state", { headers: { "cf-access-jwt-assertion": token } })
  ).json()) as {
    resources: ReadonlyArray<Resource>;
  };
  // A static site card that holds busy.<zone> already.
  const zone = state.resources
    .find((resource) => resource.kind === "kitshn.admin")
    ?.addresses[0]?.split(".")
    .slice(1)
    .join(".");
  if (!zone) throw new Error("no admin address");
  const busy: Resource = {
    id: "busy",
    kind: "site.static",
    name: "busy",
    addresses: [`busy.${zone}`],
    status: "running",
    group: null,
    machine: null,
  };
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, storage) => {
    storage.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      "busy",
      JSON.stringify(busy),
    );
  });
  await evictDurableObject(env.KITSHN.getByName("kitshn"));
  const taken = "busy";

  const ok = await add({ server: "http://localhost:5173/app", name: "trek", endsAt: Date.now() + 3_600_000 });
  expect(ok.status, await ok.clone().text()).toBe(200);
  expect(await lastScript()).toContain("expose '5173' --name 'trek' --new");
  expect((await add({ server: "5174", name: taken })).status).toBe(409);
  expect((await add({ server: "http://localhost:0", name: "zero" })).status).toBe(400);
  expect((await add({ server: "https://foo.example.org", name: "far" })).status).toBe(400);
});

/** A daemon socket of the machine that passed its key check (K-1704). */
const daemonSocket = () =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId: "vps",
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send() {},
    close() {},
  }) as unknown as WebSocket;

it("ends a wizard site as the owner who asked, who can undo it; a failed request of another owner leaves nothing (K-1131, K-212)", async () => {
  stubAccessCerts();
  await setup();
  const stub = env.KITSHN.getByName("kitshn");
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  const other = await accessToken("admin-aud", { email: "other@example.com" });
  const post = (token: string, path: string, body: object) =>
    send(path, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ask = async (token: string, endsAt: number | null) => {
    const response = await post(token, "/api/sites/live", {
      machineId: "vps",
      server: "5173",
      name: "trek",
      dev: false,
      endsAt,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { id: number }).id;
  };
  const daemon = (message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(), JSON.stringify(message)),
    );
  const result = async (id: number, ok: boolean) => {
    await runInDurableObject(
      stub,
      (_, state) => void state.storage.sql.exec("UPDATE jobs SET state = 'sent' WHERE id = ?", id),
    );
    await daemon({ type: "jobResult", id, result: { ok, exitCode: ok ? 0 : 1, output: "" } });
  };
  const seen = async () =>
    (await (await send("/api/state", { headers: { "cf-access-jwt-assertion": owner } })).json()) as {
      places: Record<string, { x: number; y: number }>;
      ends: Record<string, number>;
      resources: ReadonlyArray<Resource>;
      revisions: ReadonlyArray<{ id: number; summary: string; actor: unknown }>;
    };

  // A second person of the Owner circle, who may add sites too.
  const circles = (
    (await (await send("/api/state", { headers: { "cf-access-jwt-assertion": owner } })).json()) as {
      circles: ReadonlyArray<Circle>;
    }
  ).circles;
  const ownerCircle = circles.find((circle) => circle.id === OWNER_CIRCLE_ID);
  if (!ownerCircle) throw new Error("no Owner circle");
  const joined = await post(owner, "/api/apply", {
    edits: withActors([
      {
        _tag: "circle",
        id: OWNER_CIRCLE_ID,
        after: {
          ...ownerCircle,
          members: [...ownerCircle.members, person("other@example.com")],
        },
      },
    ]),
  });
  expect(joined.status, await joined.clone().text()).toBe(200);
  // The owner asks for an hour; another owner asks for the same name for two hours, and `expose --new` fails.
  const endsAt = Date.now() + 3_600_000;
  const mine = await ask(owner, endsAt);
  const theirs = await ask(other, endsAt + 3_600_000);
  await result(mine, true);
  await result(theirs, false);
  await daemon({
    type: "sites",
    sites: [{ name: "trek", target: "http://localhost:5173", dev: false, up: true, endsAt }],
  });
  // The address check finds the name free (no DNS record, no Worker domain), so kitshn makes the card.
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as { checkSites(api: () => Promise<[]>, budget: number): Promise<number> }
    ).checkSites(async () => [], 6);
  });
  const made = await seen();
  const card = made.resources.find((resource) => resource.addresses[0]?.startsWith("trek."));
  if (!card) throw new Error("no card for trek");
  expect(made.ends[card.id]).toBe(endsAt);

  // On the map in the Owner circle, the hour passes, and the end runs as the owner, who undoes it.
  const vps = made.places["vps"];
  if (!vps) throw new Error("no machine place");
  expect(
    (await post(owner, "/api/apply", { edits: [{ _tag: "place", id: card.id, after: vps }] })).status,
  ).toBe(200);
  await runInDurableObject(stub, (instance, state) => {
    state.storage.sql.exec("UPDATE card_ends SET ends_at = 1 WHERE id = ?", card.id);
    const kitshn = instance as unknown as { state: { ends: Map<string, number> } };
    kitshn.state = { ...kitshn.state, ends: new Map(kitshn.state.ends).set(card.id, 1) };
  });
  await runDurableObjectAlarm(stub);
  const ended = await seen();
  const [expiry] = ended.revisions;
  expect([ended.places[card.id], expiry?.actor]).toEqual([
    undefined,
    { _tag: "person", email: "owner@example.com" },
  ]);
  expect((await post(owner, "/api/undo", { revision: expiry?.id })).status).toBe(200);
  expect((await seen()).places[card.id]).toEqual(vps);
});

it("puts a card of expose --circle in that circle only when the machine controls it, else in the tray (K-1104, K-718)", async () => {
  stubAccessCerts();
  await agentSetup({ creates: { mode: "automatic" } });
  const stub = env.KITSHN.getByName("kitshn");
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  await runInDurableObject(stub, (instance) =>
    instance.webSocketMessage(
      daemonSocket(),
      JSON.stringify({
        type: "sites",
        sites: [
          { name: "shared", target: "http://localhost:5173", dev: false, up: true, circle: "Agents" },
          { name: "mine", target: "http://localhost:5174", dev: false, up: true, circle: OWNER_CIRCLE_ID },
        ],
      }),
    ),
  );
  await runInDurableObject(stub, async (instance) => {
    await (
      instance as unknown as { checkSites(api: () => Promise<[]>, budget: number): Promise<number> }
    ).checkSites(async () => [], 6);
  });
  const seen = (await (
    await send("/api/state", { headers: { "cf-access-jwt-assertion": owner } })
  ).json()) as {
    places: Record<string, { x: number; y: number }>;
    resources: ReadonlyArray<Resource>;
  };
  const placeOf = (name: string) =>
    seen.places[seen.resources.find((resource) => resource.name === name)?.id ?? ""] ?? null;
  const shared = placeOf("shared");
  // The machine has control in Agents (r 200 at 5000, 5000), not in the Owner circle.
  expect(shared && Math.hypot(shared.x - 5000, shared.y - 5000) < 200).toBe(true);
  expect(placeOf("mine")).toBeNull();
});

it("refuses on the server a change that would admit no one whom a circle admits now (K-539)", async () => {
  stubAccessCerts();
  await agentSetup({ creates: { mode: "automatic" } });
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  const apply = (circle: object) =>
    send("/api/apply", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
      body: JSON.stringify({
        edits: withActors([{ _tag: "circle", id: "people", after: circle as Circle }]),
      }),
    });
  const people = {
    id: "people",
    name: "People",
    color: "#FF5277",
    level: "view",
    members: [person("her@example.com")],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 9000,
    y: 9000,
    r: 200,
  };
  const made = await apply(people);
  expect(made.status, await made.clone().text()).toBe(200);
  const members = [...people.members, machineChip("vps")];
  // Any may match, so the machine joins; then the switch to "all must match" would lock her out.
  const joined = await apply({ ...people, members });
  expect(joined.status, await joined.clone().text()).toBe(200);
  const refused = await apply({ ...people, members, match: "all" });
  expect(await refused.text()).toContain("no one would get in");
  expect(refused.status).not.toBe(200);
});

it("puts a wizard site in the circle of its request, and a failed job leaves no wish for a later card (K-1131)", async () => {
  stubAccessCerts();
  await agentSetup({ creates: { mode: "automatic" } });
  const stub = env.KITSHN.getByName("kitshn");
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  const ask = async (name: string, circle: string | null) => {
    const response = await send("/api/sites/live", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "vps", server: "5173", name, dev: false, endsAt: null, circle }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { id: number }).id;
  };
  const daemon = (message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(), JSON.stringify(message)),
    );
  const finish = async (id: number, ok: boolean) => {
    await runInDurableObject(
      stub,
      (_, state) => void state.storage.sql.exec("UPDATE jobs SET state = 'sent' WHERE id = ?", id),
    );
    await daemon({ type: "jobResult", id, result: { ok, exitCode: ok ? 0 : 1, output: "" } });
  };
  // A report names every site of the machine, so a name that it leaves out goes.
  const reported: Array<string> = [];
  const arrive = async (name: string) => {
    reported.push(name);
    await daemon({
      type: "sites",
      sites: reported.map((each) => ({ name: each, target: "http://localhost:5173", dev: false, up: true })),
    });
    await runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as { checkSites(api: () => Promise<[]>, budget: number): Promise<number> }
      ).checkSites(async () => [], 6);
    });
  };
  const placeOf = async (name: string) => {
    const seen = (await (
      await send("/api/state", { headers: { "cf-access-jwt-assertion": owner } })
    ).json()) as { places: Record<string, { x: number; y: number }>; resources: ReadonlyArray<Resource> };
    const card = seen.resources.find((resource) => resource.name === name);
    if (!card) throw new Error(`no card ${name}`);
    return seen.places[card.id] ?? null;
  };

  // The owner chose the Agents circle (r 200 at 5000, 5000), whatever the rights of the machine are.
  await finish(await ask("wizard", "agents"), true);
  await arrive("wizard");
  const shared = await placeOf("wizard");
  expect(shared && Math.hypot(shared.x - 5000, shared.y - 5000) < 200).toBe(true);

  // The job of "Share with" fails, and the retry says Private: the card stays in the tray.
  await finish(await ask("retry", "agents"), false);
  await finish(await ask("retry", null), true);
  await arrive("retry");
  expect(await placeOf("retry")).toBeNull();
  const open = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ title: string }>("SELECT title FROM notifications WHERE source = 'site' AND state = 'open'")
      .toArray(),
  );
  expect(open.map((row) => row.title)).toContain("A live site was not shared with Agents");

  // A second site of the circle lands clear of the first.
  await finish(await ask("second", "agents"), true);
  await arrive("second");
  const second = await placeOf("second");
  expect(second && shared && (second.x !== shared.x || second.y !== shared.y)).toBe(true);

  // While paused, access only goes down, so a site that arrives stays in the tray, and the owner hears it.
  await finish(await ask("paused", "agents"), true);
  const paused = await send("/api/apply", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ _tag: "pause", after: "keep-public" }] }),
  });
  expect(paused.status, await paused.clone().text()).toBe(200);
  await arrive("paused");
  expect(await placeOf("paused")).toBeNull();

  // A circle that is gone refuses the request at once.
  const gone = await send("/api/sites/live", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
    body: JSON.stringify({
      machineId: "vps",
      server: "5173",
      name: "x",
      dev: false,
      endsAt: null,
      circle: "gone",
    }),
  });
  expect(gone.status).toBe(400);
});

it("never turns the site of a dropped instance into a card of its own (K-825)", async () => {
  await setup();
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, async (instance, state) => {
    const sql = state.storage.sql;
    const site = (name: string) =>
      sql.exec(
        `INSERT INTO live_sites (id, machine_id, name, address, target, dev, up, last_up, state)
         VALUES (?, 'vps', ?, ?, 'unix:/run/app.sock', 0, 1, 0, 'checking')`,
        `live-vps-${name}`,
        name,
        `${name}.example.com`,
      );
    // One instance address left its card (K-1124); the stop of another one waits for the machine.
    site("gone-vps");
    sql.exec("INSERT INTO old_addresses (address, card_id) VALUES ('gone-vps.example.com', 'gone-card')");
    site("stopping-vps");
    sql.exec(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
       VALUES ('vps', '[]', ?, 'queued', 0, ?, '{}', '{}', '')`,
      JSON.stringify({ kind: "compose-down", project: "stop-card", name: "stopping-vps", removeData: false }),
      Number.MAX_SAFE_INTEGER,
    );
    const kitshn = instance as unknown as {
      load(): void;
      checkSites(api: () => Promise<[]>, budget: number): Promise<number>;
    };
    kitshn.load();
    await kitshn.checkSites(async () => [], 6);
    const ids = ["live-vps-gone-vps", "live-vps-stopping-vps"];
    expect(
      sql.exec("SELECT id, state FROM live_sites WHERE id IN (?, ?) ORDER BY id", ...ids).toArray(),
    ).toEqual(ids.map((id) => ({ id, state: "checking" })));
    expect(sql.exec("SELECT id FROM resources WHERE id IN (?, ?)", ...ids).toArray()).toEqual([]);
    sql.exec("DELETE FROM live_sites WHERE id IN (?, ?)", ...ids);
    sql.exec("DELETE FROM old_addresses WHERE card_id = 'gone-card'");
    sql.exec("DELETE FROM jobs WHERE json_extract(command, '$.project') = 'stop-card'");
    kitshn.load();
  });
});
