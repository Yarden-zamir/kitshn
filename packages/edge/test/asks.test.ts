import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { AskOutcome, Machine, ServerToDaemon } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type RightMode } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { insertActors, machine as machineChip, tokenActor } from "./actors.ts";

afterEach(() => vi.restoreAllMocks());

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

/** A daemon socket of a machine that passed its key check (K-1704); it keeps what kitshn sends. */
const daemonSocket = (sent: Array<ServerToDaemon>, status: object | null = null) =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId: "vps",
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status,
      sample: null,
    }),
    serializeAttachment() {},
    send: (text: string) => sent.push(JSON.parse(text) as ServerToDaemon),
    close() {},
  }) as unknown as WebSocket;

/** One map where the machine vps sits in the agent circle "agents" with these rights. */
async function setup(rights: Partial<Record<string, RightMode>>, circle: Partial<Circle> = {}) {
  const stub = env.KITSHN.getByName("kitshn");
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [machineChip("vps", rights)],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
    ...circle,
  };
  await runInDurableObject(stub, (_, state) => {
    // The tests share one Durable Object, so each starts from the same machine, circle and empty asks.
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    state.storage.sql.exec("DELETE FROM proposals");
    state.storage.sql.exec("DELETE FROM notifications WHERE source = 'kitshn.ask'");
    state.storage.sql.exec("DELETE FROM ask_events");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
    insertActors(state.storage.sql, [...agents.members, machineChip("mac")]);
    // A card that the agent circle holds, for an ask that stays inside K-718.
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('managed', ?)",
      JSON.stringify({
        id: "managed",
        kind: "site.static",
        name: "managed",
        addresses: [],
        status: "unknown",
        group: null,
        machine: null,
      }),
    );
    state.storage.sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('managed', 5000, 5000)");
  });
  await evictDurableObject(stub);
  return stub;
}

type Instance = {
  webSocketMessage(socket: WebSocket, text: string): Promise<void>;
  decide(
    id: string,
    decision: "approved" | "denied",
    by: object,
    seen?: string | null,
    via?: "passkey" | "login" | null,
  ): Promise<{ ok: boolean; error?: string }>;
  expireProposals(now: number): void;
};

async function ask(stub: DurableObjectStub, action: string, target = "", extra: object = {}) {
  const sent: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).webSocketMessage(
      daemonSocket(sent),
      JSON.stringify({ type: "ask", requestId: "r1", ask: { action, target, ...extra } }),
    ),
  );
  const answer = sent.find((message) => message.type === "askAnswer");
  if (!answer) throw new Error("kitshn sent no askAnswer.");
  const {
    type: _type,
    requestId: _id,
    ...outcome
  } = answer as Extract<ServerToDaemon, { type: "askAnswer" }>;
  return outcome as AskOutcome;
}

const owner = {
  actor: { _tag: "person", email: "owner@example.com" },
  visitor: { email: "owner@example.com", clientId: null, ip: null },
  machineId: null,
  reason: null,
};

it("decides an apply that raises access by shares: automatic runs, ask waits, off refuses (K-1778)", async () => {
  const results: Array<unknown> = [];
  for (const shares of [
    { mode: "automatic" },
    { mode: "ask", circleId: "owner" },
    { mode: "off" },
  ] as const) {
    const rights = { maintains: { mode: "automatic" }, shares } as const;
    const stub = await setup(rights);
    // A circle edit is no card move, so it fails the rule of K-718 and raises access (K-715).
    const renamed = {
      id: "agents",
      name: "Builders",
      color: "#ffcc00",
      level: "control",
      members: [machineChip("vps", rights)],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: 5000,
      y: 5000,
      r: 200,
    };
    const outcome = await ask(stub, "apply", "", {
      body: { edits: [{ _tag: "circle", id: "agents", after: renamed }] },
    });
    const state = await runInDurableObject(stub, (_, storage) => ({
      name: (
        JSON.parse(
          storage.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one()
            .body,
        ) as Circle
      ).name,
      asks: storage.storage.sql.exec<{ right_name: string }>("SELECT right_name FROM proposals").toArray(),
    }));
    results.push([shares.mode, outcome.outcome, state.name, state.asks]);
  }
  // K-1777: apply and organize have the effect "changes", as on /op: an edit inside the rule waits or runs by
  // "changes", and "changes" off refuses also an edit that "shares" would take.
  const inside = { body: { edits: [{ _tag: "place", id: "managed", after: { x: 5010, y: 5000 } }] } };
  for (const [label, action, changes, extra] of [
    ["move, changes automatic", "apply", { mode: "automatic" }, inside],
    ["move, changes ask", "apply", { mode: "ask", circleId: OWNER_CIRCLE_ID }, inside],
    ["rename, changes off", "apply", { mode: "off" }, null],
    ["organize, changes off", "organize", { mode: "off" }, {}],
    ["organize, changes ask", "organize", { mode: "ask", circleId: OWNER_CIRCLE_ID }, {}],
  ] as const) {
    const rights = { shares: { mode: "automatic" }, changes } as const;
    const stub = await setup(rights);
    const body =
      extra ??
      ({
        body: {
          edits: [
            {
              _tag: "circle",
              id: "agents",
              after: {
                id: "agents",
                name: "Builders",
                color: "#ffcc00",
                level: "control",
                members: [machineChip("vps", rights)],
                match: "any",
                needsPasskey: false,
                endsAt: null,
                x: 5000,
                y: 5000,
                r: 200,
              },
            },
          ],
        },
      } as const);
    const outcome = await ask(stub, action, "", body);
    const asks = await runInDurableObject(stub, (_, storage) =>
      storage.storage.sql.exec<{ right_name: string }>("SELECT right_name FROM proposals").toArray(),
    );
    results.push([label, outcome.outcome, asks]);
  }
  expect(results).toEqual([
    ["automatic", "done", "Builders", []],
    ["ask", "waiting", "Agents", [{ right_name: "shares" }]],
    ["off", "refused", "Agents", []],
    ["move, changes automatic", "done", []],
    ["move, changes ask", "waiting", [{ right_name: "changes" }]],
    ["rename, changes off", "refused", []],
    ["organize, changes off", "refused", []],
    ["organize, changes ask", "waiting", [{ right_name: "changes" }]],
  ]);
});

it("refuses an effect that is off and names it; an unset effect takes its default (K-1720, K-1730)", async () => {
  const stub = await setup({ changes: { mode: "automatic" }, runs: { mode: "off" } });
  expect(await ask(stub, "allow", "123")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining('"runs" is off'),
    need: "runs",
  });
  // "runs" starts at "ask the Owner", so an allow waits for the Owner (K-1730).
  const unset = await setup({ changes: { mode: "automatic" } });
  expect(await ask(unset, "allow", "123")).toMatchObject({ outcome: "waiting" });
  const asks = await runInDurableObject(unset, (_, state) =>
    state.storage.sql.exec<{ right_name: string }>("SELECT right_name FROM proposals").toArray(),
  );
  expect(asks).toEqual([{ right_name: "runs" }]);
  // `state` needs no right, and names the newest deploy, backup and uptime of each managed card (K-718).
  await runInDurableObject(stub, (_, state) => {
    const card = {
      id: "money",
      kind: "site.compose",
      name: "money",
      addresses: [],
      status: "running",
      group: null,
      machine: "vps",
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      card.id,
      JSON.stringify(card),
    );
    state.storage.sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('money', 5000, 5000)");
    // A machine card stores "unknown"; its connection is its live status.
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('vps', ?)",
      JSON.stringify({ ...card, id: "vps", kind: "machine", name: "vps", status: "unknown" }),
    );
    state.storage.sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('vps', 5010, 5010)");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO backups (run, card, machine_id, at, state, error) VALUES ('b1', 'money', 'vps', 7, 'done', NULL)",
    );
  });
  await evictDurableObject(stub);
  const answer = await ask(stub, "state");
  expect(answer).toMatchObject({ outcome: "done" });
  // K-1819: "back up now" of a managed card runs under "deploys"; a card that the machine does not manage refuses.
  expect(await ask(stub, "backup", "elsewhere")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining("does not manage"),
  });
  expect(await ask(stub, "backup", "money")).not.toMatchObject({
    reason: expect.stringContaining("does not manage"),
  });
  const cards =
    answer.outcome === "done" ? (answer.result as { cards: Array<Record<string, unknown>> }).cards : [];
  expect(cards.find((card) => card["id"] === "money")).toMatchObject({
    deploy: null,
    backup: { at: 7, state: "done", error: null },
    uptime: null,
    // Each circle of a card comes with its name, so no id is left to look up.
    circles: [{ id: "agents", name: expect.any(String) }],
  });
  expect(cards.find((card) => card["id"] === "vps")).toMatchObject({ status: "offline" });
  // The rights carry the names and modes of the map; servers and link events need `all`.
  const result = answer.outcome === "done" ? (answer.result as Record<string, unknown>) : {};
  expect(result["rights"]).toContainEqual({ id: "changes", name: "changes", mode: "automatic" });
  // An unset effect shows its default (K-1730).
  expect(result["rights"]).toContainEqual({ id: "creates", name: "creates", mode: "automatic" });
  expect(result["rights"]).toContainEqual({
    id: "shares",
    name: "shares",
    mode: "ask",
    circle: { id: "owner", name: "Owner" },
  });
  expect(result).not.toHaveProperty("linkEvents");
  const all = await ask(stub, "state", "", { body: { all: true } });
  expect(all.outcome === "done" ? all.result : null).toHaveProperty("linkEvents");
  await runInDurableObject(stub, (_, state) => {
    for (const table of ["resources", "places", "backups"])
      state.storage.sql.exec(
        `DELETE FROM ${table} WHERE ${table === "backups" ? "card" : "id"} IN ('money', 'vps')`,
      );
  });
  await evictDurableObject(stub);
});

it("refuses bad labels and asks during the pause (K-1750, K-1504)", async () => {
  const stub = await setup({});
  expect(await ask(stub, "state", "", { labels: { nokey: "x" } })).toMatchObject({ outcome: "refused" });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')"),
  );
  await evictDurableObject(stub);
  expect(await ask(stub, "state")).toEqual({ outcome: "refused", reason: expect.stringContaining("paused") });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'paused'"),
  );
  await evictDurableObject(stub);
});

it("waits for one answer of its approver circle; a second answer gets already decided (K-1722, K-1723)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card", { reason: "test" });
  expect(waiting).toMatchObject({ outcome: "waiting" });
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const decide = (by: object) =>
    runInDurableObject(stub, (instance) => (instance as unknown as Instance).decide(id, "denied", by));
  // A machine outside the approver circle does not answer.
  expect(
    await decide({ ...owner, visitor: { email: null, clientId: "vps.access", ip: null }, machineId: "vps" }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("approver circle") });
  expect(await decide(owner)).toEqual({ ok: true });
  expect(await decide(owner)).toMatchObject({ ok: false, error: expect.stringContaining("already decided") });
  const states = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ state: string }>("SELECT state FROM proposals").toArray(),
  );
  expect(states).toEqual([{ state: "denied" }]);
  // K-1727: in a passkey circle, a member machine answers only while "approves without passkey" is on.
  const locked = await setup({ changes: { mode: "ask", circleId: "approvers" } });
  await runInDurableObject(locked, (_, state) => {
    const agents = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one().body,
    ) as Circle;
    const approvers = {
      ...agents,
      id: "approvers",
      name: "Approvers",
      needsPasskey: true,
      x: -5000,
      members: [machineChip("vps")],
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES ('approvers', ?)",
      JSON.stringify(approvers),
    );
  });
  await evictDurableObject(locked);
  const asked = await ask(locked, "deploy", "managed");
  const machineAnswer = () =>
    runInDurableObject(locked, (instance) =>
      (instance as unknown as Instance).decide(
        asked.outcome === "waiting" ? asked.proposalId : "",
        "denied",
        {
          ...owner,
          visitor: { email: null, clientId: "vps.access", ip: null },
          machineId: "vps",
        },
      ),
    );
  expect(await machineAnswer()).toMatchObject({
    ok: false,
    error: expect.stringContaining("approves without passkey"),
  });
  await runInDurableObject(locked, (_, state) =>
    state.storage.sql.exec("DELETE FROM circles WHERE id = 'approvers'"),
  );
  await evictDurableObject(locked);
});

it("expires a proposal after its time, so no later answer runs it (K-1724)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).expireProposals(Date.now() + 25 * 60 * 60_000),
  );
  const late = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).decide(id, "approved", owner),
  );
  expect(late).toMatchObject({ ok: false, error: expect.stringContaining("already decided") });
});

it("writes one ask event for each ask, not a revision (K-1717)", async () => {
  const stub = await setup({ runs: { mode: "off" } });
  await ask(stub, "allow", "123");
  const events = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ action: string; outcome: string }>("SELECT action, outcome FROM ask_events")
      .toArray(),
  );
  expect(events).toEqual([{ action: "allow", outcome: "refused" }]);
});

it("reads only what its own event write reads for a refused ask, and a few rows for a new proposal (K-1715)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" }, runs: { mode: "off" } });
  // Wake the object first, so its load does not count.
  await ask(stub, "allow", "123");
  const counted = async (run: (instance: Instance) => Promise<unknown>) =>
    runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      let rowsRead = 0;
      sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
        const cursor = exec(query, ...bindings);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = () => {
          const rows = toArray();
          rowsRead += cursor.rowsRead;
          return rows;
        };
        return cursor;
      }) as typeof sql.exec;
      try {
        await run(instance as unknown as Instance);
      } finally {
        sql.exec = exec;
      }
      return rowsRead;
    });
  const sent: Array<ServerToDaemon> = [];
  const message = (action: string) =>
    JSON.stringify({ type: "ask", requestId: "r", ask: { action, target: "card" } });
  // The event insert reads its AUTOINCREMENT counter, and the trim to 5,000 reads its last id.
  expect(
    await counted((instance) => instance.webSocketMessage(daemonSocket(sent), message("allow"))),
  ).toBeLessThanOrEqual(4);
  const proposalReads = await counted((instance) =>
    instance.webSocketMessage(daemonSocket(sent), message("deploy")),
  );
  // The proposal itself reads nothing; the alarm schedule reads its next due items (jobs, retries, the expiry), the
  // notification of the ask reads the open asks and its own row (K-1722), and its Web Push schedules once more (K-1907).
  expect(proposalReads).toBeLessThanOrEqual(40);
});

it("ends an approval that is no longer allowed, and refuses one for a text that the approver did not read (K-1712, K-1722)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const approve = (seen: string | null) =>
    runInDurableObject(stub, (instance) =>
      (instance as unknown as Instance).decide(id, "approved", owner, seen),
    );
  expect(await approve("0".repeat(64))).toMatchObject({
    ok: false,
    error: expect.stringContaining("changed"),
  });
  // The owner turns the right to automatic meanwhile: the ask no longer asks this circle.
  await setup({ changes: { mode: "automatic" } });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      `INSERT INTO proposals (id, machine_id, action, target, body, reason, labels, right_name, circle_id, shown, shown_hash, state, created_at, expires_at)
       VALUES ('p1', 'vps', 'deploy', 'card', 'null', NULL, '{}', 'deploys', 'owner', 'deploy card', 'h', 'pending', 0, ?)`,
      Date.now() + 60_000,
    ),
  );
  const late = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).decide("p1", "approved", owner, null),
  );
  expect(late).toMatchObject({ ok: false, error: expect.stringContaining("no longer allowed") });
});

it("refuses a new ask past 20 open asks of one machine (K-1722)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  for (let at = 0; at < 20; at++)
    expect(await ask(stub, "deploy", `card-${at}`)).toMatchObject({ outcome: "waiting" });
  expect(await ask(stub, "deploy", "card-20")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining("20 open asks"),
  });
});

it("lets only an owner email resume, also when an approver policy let another person in (K-1504)", async () => {
  const stub = await setup({});
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')"),
  );
  await evictDurableObject(stub);
  const resume = (email: string) =>
    runInDurableObject(stub, async (instance) => {
      const response = (instance as unknown as { resume(caller: object): Response }).resume({
        actor: { _tag: "person", email },
        visitor: { email, clientId: null, ip: null },
      });
      return response.status;
    });
  expect(await resume("approver@example.com")).toBe(403);
  expect(await resume("owner@example.com")).toBe(200);
});

it("refuses an approve of a passkey circle that came through the login path, and an ask too long to read (K-1723, K-1722)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const viaLogin = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        decide(
          id: string,
          d: string,
          by: object,
          seen: string | null,
          via: string,
        ): Promise<{ ok: boolean; error?: string }>;
      }
    ).decide(id, "approved", owner, null, "login"),
  );
  // The seeded Owner circle needs a passkey.
  expect(viaLogin).toMatchObject({ ok: false, error: expect.stringContaining("needs a passkey") });
});

it("refuses an ask whose text is too long for an approver to read (K-1722)", async () => {
  const stub = await setup({ runs: { mode: "ask", circleId: "owner" } });
  expect(
    await ask(stub, "job", "vps", { body: { command: { kind: "shell", script: "x".repeat(5000) } } }),
  ).toEqual({ outcome: "refused", reason: expect.stringContaining("too long") });
});

it("finds the ask events of one label, and keeps a caller's t3. label out (K-1756, K-1753)", async () => {
  const stub = await setup({ changes: { mode: "automatic" } });
  await ask(stub, "allow", "123", { labels: { "my.task": "42", "t3.thread.id": "forged" } });
  const found = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        askEventsWithLabel(k: string, v: string, m: string | null): Array<{ labels: object }>;
      }
    ).askEventsWithLabel("my.task", "42", null),
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.labels).toEqual({ "my.task": "42" });
  // K-1752: the verified mark is fixed at ask time; a later change of the providers does not change it.
  const sent: Array<ServerToDaemon> = [];
  const verified = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as Instance & {
      labelPrefixesOf(id: string): Array<string>;
      askEventsWithLabel(k: string, v: string, m: string | null): Array<{ verified: Array<string> }>;
    };
    const reported = kitshn.labelPrefixesOf.bind(kitshn);
    kitshn.labelPrefixesOf = () => ["acme."];
    await kitshn.webSocketMessage(
      daemonSocket(sent),
      JSON.stringify({
        type: "ask",
        requestId: "r",
        ask: { action: "allow", target: "124", attested: { "acme.task": "7" } },
      }),
    );
    kitshn.labelPrefixesOf = reported;
    return kitshn.askEventsWithLabel("acme.task", "7", null)[0]?.verified;
  });
  expect(verified).toEqual(["acme.task"]);
});

it("issues a pass only while passes are on and for a listed audience, and serves its key (K-1770, K-1774)", async () => {
  const stub = await setup({ shares: { mode: "automatic" } });
  expect(await ask(stub, "pass", "https://api.example.com")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("Passes are off"),
  });
  const wellKnown = (file: string) =>
    runInDurableObject(
      stub,
      async (instance) =>
        (
          await (instance as unknown as { fetch(r: Request): Promise<Response> }).fetch(
            new Request(`https://kitshn.internal/internal/well-known/${file}`),
          )
        ).status,
    );
  expect(await wellKnown("jwks.json")).toBe(404);
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('passes_on', '1')");
    state.storage.sql.exec("DELETE FROM pass_audiences");
  });
  await evictDurableObject(stub);
  expect(await ask(stub, "pass", "https://api.example.com")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("not in the pass audiences"),
  });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      "INSERT INTO pass_audiences (address, labels, added_by, added_at) VALUES ('https://api.example.com', 0, NULL, 0)",
    ),
  );
  expect(await ask(stub, "pass", "https://api.example.com")).toMatchObject({
    outcome: "done",
    result: { pass: expect.any(String) },
  });
  expect(await wellKnown("jwks.json")).toBe(200);
  // While paused, access only goes down: turning passes on is refused, turning them off works (K-1504).
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')"),
  );
  await evictDurableObject(stub);
  const setPasses = (on: boolean) =>
    runInDurableObject(stub, async (instance) => {
      const response = await (instance as unknown as { fetch(r: Request): Promise<Response> }).fetch(
        new Request("https://kitshn.internal/api/passes", {
          method: "POST",
          headers: {
            "x-kitshn-caller": JSON.stringify({ actor: owner.actor, visitor: owner.visitor }),
            "content-type": "application/json",
          },
          body: JSON.stringify({ on }),
        }),
      );
      return response.status;
    });
  expect(await setPasses(false)).toBe(200);
  expect(await setPasses(true)).toBe(409);
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'passes_on'");
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'paused'");
  });
  await evictDurableObject(stub);
});

it("opens a high-priority notification for each ask and closes it when the ask is answered (K-1722)", async () => {
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const state = () =>
    runInDurableObject(stub, (_, durable) =>
      durable.storage.sql
        .exec<{ state: string; priority: string; recipients: string; actions: string }>(
          "SELECT state, priority, recipients, actions FROM notifications WHERE source = 'kitshn.ask' AND key = ?",
          id,
        )
        .toArray(),
    );
  const [open] = await state();
  expect(open).toMatchObject({ state: "open", priority: "high" });
  // Only the approver circle gets it; an owner outside that circle reads asks in History.
  expect(JSON.parse(open?.recipients ?? "{}")).toEqual({ _tag: "approvers", circle: "owner" });
  expect(JSON.parse(open?.actions ?? "[]").map((action: { id: string }) => action.id)).toEqual([
    "approve",
    "deny",
  ]);
  await runInDurableObject(stub, (instance) => (instance as unknown as Instance).decide(id, "denied", owner));
  expect((await state())[0]?.state).toBe("closed");
  // A Deny from the notification that decide refuses answers with its error, not ok.
  const late = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      actionHandlers: Map<string, (n: object, action: string, caller: object) => Promise<string | null>>;
    };
    return kitshn.actionHandlers.get("kitshn.ask")?.({ key: id }, "deny", owner);
  });
  expect(late).toMatch(/already decided/);
});

it("runs an approved Owner ask of an unset right, and refuses it once the owner sets the right to off (K-1776)", async () => {
  const approve = (stub: DurableObjectStub, id: string) =>
    runInDurableObject(stub, (instance) => (instance as unknown as Instance).decide(id, "approved", owner));
  const waitingId = (outcome: AskOutcome) => (outcome.outcome === "waiting" ? outcome.proposalId : "");
  // "runs" asks the Owner: the approval allows the waiting repo. "creates" is no longer the effect of an allow.
  const stub = await setup({
    changes: { mode: "automatic" },
    creates: { mode: "off" },
    runs: { mode: "ask", circleId: "owner" },
  });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen) VALUES ('123', 'Yarden-zamir/x', 'waiting', 0)",
    ),
  );
  const allow = await ask(stub, "allow", "123");
  expect(allow).toMatchObject({ outcome: "waiting" });
  expect(await approve(stub, waitingId(allow))).toMatchObject({ ok: true });
  const repo = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ state: string }>("SELECT state FROM repos WHERE repo_id = '123'").one(),
  );
  expect(repo.state).toBe("allowed");
  // "shares" unset: a page that the machine added goes into Everyone after the approval.
  const near = await setup({ changes: { mode: "automatic" } }, { x: 1000, y: 0 });
  await runInDurableObject(near, (_, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO library (id, kind, title, size, content_type, created_at, added_by) VALUES ('pg', 'page', 'pg', 1, 'text/html', 0, 'vps.access')",
    );
    const page = {
      id: "pg",
      kind: "page",
      name: "pg",
      addresses: [],
      status: "running",
      group: null,
      machine: null,
    };
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES ('pg', ?)", JSON.stringify(page));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('pg', 1150, 0)");
  });
  await evictDurableObject(near);
  const publish = await ask(near, "publish", "pg");
  expect(publish).toMatchObject({ outcome: "waiting" });
  // K-1723: an ask of "shares" takes a person's passkey.
  expect(await approve(near, waitingId(publish))).toMatchObject({
    ok: false,
    error: expect.stringContaining("passkey"),
  });
  const viaPasskey = await runInDurableObject(near, (instance) =>
    (instance as unknown as Instance).decide(waitingId(publish), "approved", owner, null, "passkey"),
  );
  expect(viaPasskey).toMatchObject({ ok: true });
  // K-1711: "public": false moves the page out of Everyone into the agent circle that holds it, also when the
  // machine has an earlier agent circle elsewhere.
  await runInDurableObject(near, (_, state) => {
    const earlier = {
      id: "aa-earlier",
      name: "Earlier",
      color: "#00ccff",
      level: "control",
      members: [machineChip("vps", { reads: { mode: "automatic" } })],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: -3000,
      y: -3000,
      r: 200,
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES ('aa-earlier', ?)",
      JSON.stringify(earlier),
    );
    // Circles load in row order, so the Agents row goes after Earlier.
    const agents = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'")
      .one();
    state.storage.sql.exec("DELETE FROM circles WHERE id = 'agents'");
    state.storage.sql.exec("INSERT INTO circles (id, body) VALUES ('agents', ?)", agents.body);
  });
  await evictDurableObject(near);
  expect(await ask(near, "publish", "pg", { body: { public: false } })).toMatchObject({ outcome: "done" });
  const landed = await runInDurableObject(near, (_, state) => {
    const place = state.storage.sql
      .exec<{ x: number; y: number }>("SELECT x, y FROM places WHERE id = 'pg'")
      .one();
    state.storage.sql.exec("DELETE FROM circles WHERE id = 'aa-earlier'");
    return place;
  });
  await evictDurableObject(near);
  expect(Math.hypot(landed.x - 1000, landed.y)).toBeLessThan(200);
  // The reviewer's deploy probe: "changes" unset waits for the Owner; set to off meanwhile, the approval refuses.
  const offLater = await setup({ creates: { mode: "automatic" } });
  const deploy = await ask(offLater, "deploy", "card");
  expect(deploy).toMatchObject({ outcome: "waiting" });
  await runInDurableObject(offLater, (_, state) => {
    const [row] = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'")
      .toArray();
    const circle = JSON.parse(row?.body ?? "{}") as Circle;
    const members = [machineChip("vps", { creates: { mode: "automatic" }, changes: { mode: "off" } })];
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = 'agents'",
      JSON.stringify({ ...circle, members }),
    );
  });
  await evictDurableObject(offLater);
  expect(await approve(offLater, waitingId(deploy))).toMatchObject({
    ok: false,
    error: expect.stringContaining('"changes" to off'),
  });
  // A backup of a card that the machine does not manage refuses at once, with no Owner ask.
  expect(await ask(offLater, "backup", "elsewhere")).toMatchObject({ outcome: "refused" });
  const open = await runInDurableObject(offLater, (_, state) =>
    state.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE state = 'pending'")
      .one(),
  );
  expect(open.n).toBe(0);
  await runInDurableObject(offLater, (_, state) => {
    for (const sql of [
      "DELETE FROM library WHERE id = 'pg'",
      "DELETE FROM resources WHERE id = 'pg'",
      "DELETE FROM places WHERE id = 'pg'",
      "DELETE FROM repos WHERE repo_id = '123'",
    ])
      state.storage.sql.exec(sql);
  });
});

it("shows a live ask only to who may answer it, on /api/state and on the socket (K-1902, K-1723, K-1727)", async () => {
  stubAccessCerts();
  const stub = await setup({ changes: { mode: "ask", circleId: "agents" } });
  const mac: Machine = {
    ...machine,
    id: "mac",
    name: "mac",
    clientId: "mac.access",
    serviceTokenId: "token-mac",
  };
  // A token and a second machine in the Owner circle: the passkey line keeps both out of it (K-1778), and neither is in Agents.
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "mac",
      JSON.stringify(mac),
    );
    const [row] = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID)
      .toArray();
    const ownerCircle = JSON.parse(row!.body) as Circle;
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = ?",
      JSON.stringify({
        ...ownerCircle,
        members: [
          ...ownerCircle.members,
          tokenActor("token-laptop", "laptop.access", "laptop"),
          machineChip("mac"),
        ],
      }),
      OWNER_CIRCLE_ID,
    );
    insertActors(state.storage.sql, [
      tokenActor("token-laptop", "laptop.access", "laptop"),
      machineChip("mac"),
    ]);
  });
  await evictDurableObject(stub);
  expect(await ask(stub, "deploy", "managed")).toMatchObject({ outcome: "waiting" });
  const token = (claims: { email: string } | { common_name: string }) => accessToken("admin-aud", claims);
  const person = await token({ email: "owner@example.com" });
  const live = async (jwt: string) => {
    const answer = await send("/api/state", { headers: { "cf-access-jwt-assertion": jwt } });
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { proposals: Array<{ machineId: string }> }).proposals;
  };
  // Outside Agents: no live ask for the owner. History keeps the ask for the owner (K-1717).
  expect(await live(person)).toEqual([]);
  // K-1778: a token or a machine in the Owner circle holds no admin, because the Owner circle needs a passkey.
  for (const jwt of [
    await token({ common_name: "laptop.access" }),
    await token({ common_name: "mac.access" }),
  ])
    expect((await send("/api/state", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(403);
  const socket = await send("/api/ws", {
    headers: { upgrade: "websocket", "cf-access-jwt-assertion": person },
  });
  const ws = socket.webSocket;
  if (!ws) throw new Error("kitshn opened no socket.");
  ws.accept();
  const snapshot = await new Promise<{ proposals: Array<unknown> }>((resolve) =>
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        snapshot?: { proposals: Array<unknown> };
      };
      if (message.type === "snapshot" && message.snapshot) resolve(message.snapshot);
    }),
  );
  ws.close();
  expect(snapshot.proposals).toEqual([]);

  // A machine in a passkey approver circle answers only while "approves without passkey" is on, so only then it sees
  // the ask. The machine reads the asks of its circles through its own ask path, because it holds no admin (K-1778).
  const approvers = async (approvesWithoutPasskey: boolean) => {
    const stubbed = await setup({ changes: { mode: "ask", circleId: "approvers" } });
    await runInDurableObject(stubbed, (_, state) => {
      const circle = {
        ...JSON.parse(
          state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one().body,
        ),
        id: "approvers",
        name: "Approvers",
        needsPasskey: true,
        approvesWithoutPasskey,
        x: -5000,
        members: [machineChip("mac")],
      };
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO circles (id, body) VALUES ('approvers', ?)",
        JSON.stringify(circle),
      );
    });
    await evictDurableObject(stubbed);
    expect(await ask(stubbed, "deploy", "managed")).toMatchObject({ outcome: "waiting" });
    const seen = await runInDurableObject(stubbed, (instance) =>
      (
        instance as unknown as {
          answerableProposals(visitor: object, attested: null): Array<{ machineId: string }>;
        }
      ).answerableProposals({ email: null, clientId: "mac.access", ip: null }, null),
    );
    await runInDurableObject(stubbed, (_, state) =>
      state.storage.sql.exec("DELETE FROM circles WHERE id = 'approvers'"),
    );
    await evictDurableObject(stubbed);
    return seen;
  };
  expect(await approvers(false)).toEqual([]);
  expect(await approvers(true)).toMatchObject([{ machineId: "vps" }]);
});

/**
 * K-718: the machine vps with its card `vps` and the Compose card `shop` that runs on it. A card inside `inCircle` is in
 * the agent circle, so the machine manages it. The daemon connection takes jobs, and `sent` keeps them.
 */
async function machineWithCards(stub: DurableObjectStub, inCircle: ReadonlyArray<"vps" | "shop">) {
  const place = (id: "vps" | "shop") => (inCircle.includes(id) ? 5000 : 9000);
  await runInDurableObject(stub, (_, state) => {
    const { sql } = state.storage;
    const card = { addresses: [], status: "running", group: null, machine: "vps" };
    sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)",
      JSON.stringify({ ...machine, labels: ["deploy"] }),
    );
    for (const [id, kind] of [
      ["vps", "machine"],
      ["shop", "site.compose"],
    ] as const) {
      sql.exec(
        "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
        id,
        JSON.stringify({ ...card, id, kind, name: id }),
      );
      sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)", id, place(id), place(id));
    }
    sql.exec(
      "INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen) VALUES ('77', 'o/shop', 'allowed', 0)",
    );
    sql.exec(
      `INSERT OR REPLACE INTO deploys (id, repo, repo_id, environment, resource_id, address, script, kind, sha, state, expires_at,
         app, machine_id, compose_file)
       VALUES ('d-shop', 'o/shop', '77', 'prod', 'shop', 'shop.example.com', '', 'deploy', 'abc', 'done', 1, 'compose', 'vps', 'compose.yml')`,
    );
    sql.exec("DELETE FROM jobs");
  });
  await evictDurableObject(stub);
  const sent: Array<ServerToDaemon> = [];
  const socket = daemonSocket(sent, {
    os: "linux-x64",
    capabilities: ["compose-redeploy", "compose-guard", "tunnel-restart"],
  });
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { openSocket(id: string): WebSocket }).openSocket = () => socket;
  });
  const jobs = () => sent.flatMap((message) => (message.type === "job" ? [message.command.kind] : []));
  return { jobs };
}

const askedCircle = (stub: DurableObjectStub, id: string) =>
  runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ circle_id: string }>("SELECT circle_id FROM proposals WHERE id = ?", id).one()
        .circle_id,
  );

const proposalOf = (answer: AskOutcome) => {
  if (answer.outcome !== "waiting") throw new Error(`The ask did not wait: ${JSON.stringify(answer)}`);
  return answer.proposalId;
};

const decideAs = (stub: DurableObjectStub, id: string, by: object) =>
  runInDurableObject(stub, (instance) => (instance as unknown as Instance).decide(id, "approved", by));

const shell = { body: { command: { kind: "shell", script: "uptime" } } };
const restart = { body: { command: { kind: "restart" } } };

it("asks the Owner for a shell job outside K-718, and the approved job goes out (K-718, K-1776)", async () => {
  for (const rights of [
    { runs: { mode: "automatic" } },
    { runs: { mode: "ask", circleId: "agents" } },
    {},
  ] as const) {
    const stub = await setup(rights);
    const { jobs } = await machineWithCards(stub, ["vps"]);
    const id = proposalOf(await ask(stub, "job", "vps", shell));
    expect(await askedCircle(stub, id)).toBe(OWNER_CIRCLE_ID);
    expect(jobs()).toEqual([]);
    expect(await decideAs(stub, id, owner)).toMatchObject({ ok: true });
    expect(jobs()).toEqual(["shell"]);
  }
  // A machine in no agent circle, such as a new machine in the tray, gets the same ask.
  const tray = await setup({}, { members: [] });
  const fresh = await machineWithCards(tray, []);
  const asked = proposalOf(await ask(tray, "job", "vps", restart));
  expect(await decideAs(tray, asked, owner)).toMatchObject({ ok: true });
  expect(fresh.jobs()).toEqual(["restart"]);
  // Inside K-718 the same right runs at once; "off" refuses, whatever the cards.
  const inside = await setup({ runs: { mode: "automatic" } });
  const running = await machineWithCards(inside, ["vps", "shop"]);
  expect(await ask(inside, "job", "vps", shell)).toMatchObject({ outcome: "done" });
  expect(running.jobs()).toEqual(["shell"]);
  const off = await setup({ runs: { mode: "off" } });
  await machineWithCards(off, ["vps"]);
  expect(await ask(off, "job", "vps", shell)).toMatchObject({ outcome: "refused", need: "runs" });
});

it("runs a closed command with only the machine card, and asks the Owner without it (K-718)", async () => {
  const stub = await setup({ runs: { mode: "automatic" } });
  const { jobs } = await machineWithCards(stub, ["vps"]);
  expect(await ask(stub, "job", "vps", restart)).toMatchObject({ outcome: "done" });
  for (const kind of ["diagnostics", "tunnel-restart"])
    expect(await ask(stub, "job", "vps", { body: { command: { kind } } })).toMatchObject({ outcome: "done" });
  expect(jobs()).toEqual(["restart", "diagnostics", "tunnel-restart"]);
  const outside = await setup({ runs: { mode: "automatic" } });
  const other = await machineWithCards(outside, []);
  const id = proposalOf(await ask(outside, "job", "vps", restart));
  expect(await askedCircle(outside, id)).toBe(OWNER_CIRCLE_ID);
  expect(await decideAs(outside, id, owner)).toMatchObject({ ok: true });
  expect(other.jobs()).toEqual(["restart"]);
});

it("asks the Owner for a deploy of a card that the machine does not manage, and the approved one goes out (K-718)", async () => {
  const stub = await setup({ changes: { mode: "automatic" } });
  const { jobs } = await machineWithCards(stub, []);
  const id = proposalOf(await ask(stub, "deploy", "shop"));
  expect(await askedCircle(stub, id)).toBe(OWNER_CIRCLE_ID);
  expect(await decideAs(stub, id, owner)).toMatchObject({ ok: true });
  expect(jobs()).toEqual(["compose-redeploy"]);
  const state = await runInDurableObject(
    stub,
    (_, durable) => durable.storage.sql.exec<{ state: string }>("SELECT state FROM jobs").one().state,
  );
  expect(state).toBe("sent");
});

it("only a person lifts the K-718 limit of a machine (K-718, K-1723)", async () => {
  // The scope held at the ask, and the circle that answers has no person: the card left, so the ask ends.
  const stub = await setup({ runs: { mode: "ask", circleId: "agents" } });
  await machineWithCards(stub, ["vps", "shop"]);
  const id = proposalOf(await ask(stub, "job", "vps", shell));
  expect(await askedCircle(stub, id)).toBe("agents");
  await machineWithCards(stub, ["vps"]);
  const asMachine = {
    ...owner,
    visitor: { email: null, clientId: "vps.access", ip: null },
    machineId: "vps",
  };
  // K-1778: the machine that asked never approves its own ask, whatever its circle.
  expect(await decideAs(stub, id, asMachine)).toMatchObject({
    ok: false,
    error: expect.stringContaining("never approves its own ask"),
  });
  // A machine in the Owner circle does not approve a call outside K-718, and the ask stays for a person.
  const held = await setup({});
  await machineWithCards(held, ["vps"]);
  const ownerCircle = await runInDurableObject(held, (_, state) => {
    const { sql } = state.storage;
    const before = sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID)
      .one().body;
    const circle = JSON.parse(before) as Circle;
    sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES ('mac', ?)",
      JSON.stringify({
        ...machine,
        id: "mac",
        name: "mac",
        clientId: "mac.access",
        serviceTokenId: "token-mac",
      }),
    );
    sql.exec(
      "UPDATE circles SET body = ? WHERE id = ?",
      JSON.stringify({
        ...circle,
        needsPasskey: false,
        members: [...circle.members, machineChip("mac")],
      }),
      OWNER_CIRCLE_ID,
    );
    insertActors(sql, [machineChip("mac")]);
    return before;
  });
  await evictDurableObject(held);
  const asked = proposalOf(await ask(held, "job", "vps", shell));
  expect(
    await decideAs(held, asked, {
      ...owner,
      visitor: { email: null, clientId: "mac.access", ip: null },
      machineId: "mac",
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("Only a person") });
  expect(await decideAs(held, asked, owner)).toMatchObject({ ok: true });
  await runInDurableObject(held, (_, state) => {
    state.storage.sql.exec("UPDATE circles SET body = ? WHERE id = ?", ownerCircle, OWNER_CIRCLE_ID);
    state.storage.sql.exec("DELETE FROM machines WHERE id = 'mac'");
  });
  await evictDurableObject(held);
});

it("refuses at once a job that no approval can run, and decides a volume removal by destroys (K-718, K-909, K-1722)", async () => {
  const volume = { body: { command: { kind: "compose-volume-remove", project: "p", volume: "v" } } };
  const outcomes: Array<unknown> = [];
  for (const destroys of [{ mode: "off" }, { mode: "automatic" }, null] as const) {
    const stub = await setup(destroys === null ? {} : { destroys });
    // The agent circle manages the machine and every card on it, so K-718 holds (K-909).
    await machineWithCards(stub, ["vps", "shop"]);
    const outcome = await ask(stub, "job", "vps", volume);
    const asks = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ right_name: string }>("SELECT right_name FROM proposals").toArray(),
    );
    const reason = outcome.outcome === "refused" ? outcome.reason.slice(0, 30) : null;
    outcomes.push([destroys?.mode ?? "default", outcome.outcome, reason, asks]);
  }
  // Automatic passes the gate, and the job then needs a volume that the machine reports as orphaned (K-909).
  expect(outcomes).toEqual([
    ["off", "refused", 'The effect "destroys" is off f', []],
    ["automatic", "refused", "v is not an orphaned volume of", []],
    ["default", "waiting", null, [{ right_name: "destroys" }]],
  ]);
  const stub = await setup({});
  await machineWithCards(stub, ["vps"]);
  expect(await ask(stub, "job", "vps", { body: { command: { kind: "nothing" } } })).toMatchObject({
    outcome: "refused",
  });
  const open = await runInDurableObject(
    stub,
    (_, state) => state.storage.sql.exec("SELECT id FROM proposals").toArray().length,
  );
  expect(open).toBe(0);
});

const RELEASE = "aaaaaaaaaaaa";
const asker = { ...machine, key: { kind: "public", publicKey: "k1", fingerprint: "f1", since: 1 } };
const target: Machine = {
  ...machine,
  id: "mac",
  name: "mac",
  clientId: "mac.access",
  serviceTokenId: "token-mac",
};
const windowsDaemon = { version: "bbbbbbbbbbbb", os: "win32-x64", arch: "x64", capabilities: ["update-gz"] };
const linuxDaemon = { ...windowsDaemon, os: "linux-x64" };

/**
 * The machine vps with a key asks for a job on mac, which is offline, and the Owner approves. Answers with the job row
 * and a way to bring mac online with this daemon status, which delivers the queue. `env` stays on a release.
 */
async function approvedJobFor(
  rights: Partial<Record<string, RightMode>>,
  command: object,
  status: object | null = null,
) {
  const stub = await setup(rights);
  await runInDurableObject(stub, (_, state) => {
    const { sql } = state.storage;
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(asker));
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES ('mac', ?)", JSON.stringify(target));
    sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('mac', ?)",
      JSON.stringify({
        id: "mac",
        kind: "machine",
        name: "mac",
        addresses: [],
        status: "unknown",
        group: null,
        machine: "mac",
      }),
    );
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('mac', 9000, 9000)");
    sql.exec("DELETE FROM jobs");
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as {
      env: object;
      openSocket(id: string): WebSocket | null;
    };
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: RELEASE };
    kitshn.openSocket = () => null;
  });
  const id = proposalOf(await ask(stub, "job", "mac", { body: { command } }));
  expect(await decideAs(stub, id, owner)).toMatchObject({ ok: true });
  const job = () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ state: string; output: string; created_at: number; expires_at: number }>(
          "SELECT state, output, created_at, expires_at FROM jobs",
        )
        .one(),
    );
  const deliver = async () => {
    await evictDurableObject(stub);
    const sent: Array<ServerToDaemon> = [];
    await runInDurableObject(stub, (instance) => {
      const kitshn = instance as unknown as {
        env: object;
        openSocket(id: string): WebSocket | null;
        deliverJobs(): number;
      };
      const socket = daemonSocket(sent, status);
      kitshn.env = { ...kitshn.env, KITSHN_VERSION: RELEASE };
      kitshn.openSocket = (machineId) => (machineId === "mac" ? socket : null);
      kitshn.deliverJobs();
    });
    return sent.filter((message) => message.type === "job");
  };
  return { stub, job, deliver };
}

const setMachineBody = (stub: DurableObjectStub, body: object) =>
  runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("UPDATE machines SET body = ? WHERE id = 'vps'", JSON.stringify(body));
  });

it("delivers an approved job only while the machine that asked keeps its access (K-1776, K-1712)", async () => {
  const runs = { runs: { mode: "automatic" } } as const;
  const shellCommand = { kind: "shell", script: "uptime" };
  const kept = await approvedJobFor(runs, shellCommand);
  expect(await kept.deliver()).toHaveLength(1);
  for (const [change, reason] of [
    [
      (stub: DurableObjectStub) =>
        runInDurableObject(stub, (_, state) => {
          state.storage.sql.exec("DELETE FROM machines WHERE id = 'vps'");
        }),
      "the machine that asked is gone",
    ],
    [
      (stub: DurableObjectStub) => setMachineBody(stub, { ...asker, key: { kind: "waiting", since: 2 } }),
      "the key of the machine that asked changed",
    ],
    [
      (stub: DurableObjectStub) =>
        setMachineBody(stub, { ...asker, key: { ...asker.key, fingerprint: "f2", since: 2 } }),
      "the key of the machine that asked changed",
    ],
    [
      (stub: DurableObjectStub) =>
        runInDurableObject(stub, (_, state) => {
          state.storage.sql.exec(
            "UPDATE circles SET body = json_set(body, '$.members[0].rights.runs.mode', 'off') WHERE id = 'agents'",
          );
        }),
      '"runs" to off',
    ],
  ] as const) {
    const { stub, job, deliver } = await approvedJobFor(runs, shellCommand);
    await change(stub);
    expect(await deliver()).toEqual([]);
    expect(await job()).toMatchObject({
      state: "failed",
      output: expect.stringContaining("no longer allowed"),
    });
    expect((await job()).output).toContain(reason);
  }
});

it("checks the machine that asked also for an approved redeploy that waits (K-1776)", async () => {
  const stub = await setup({});
  const { jobs } = await machineWithCards(stub, []);
  const row = (state: DurableObjectState, approval: object) =>
    state.storage.sql.exec(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
       VALUES ('vps', '[]', ?, 'queued', 0, ?, '{}', ?, NULL, '')`,
      JSON.stringify({
        kind: "compose-redeploy",
        project: "shop",
        name: "shop",
        environment: "prod",
        repo: "o/shop",
      }),
      Date.now() + 60_000,
      JSON.stringify({
        email: null,
        clientId: "vps.access",
        ip: null,
        kitshn: true,
        ownerApproved: approval,
      }),
    );
  const answer = await runInDurableObject(stub, (instance, state) => {
    row(state, { machineId: "vps", key: "old", right: "deploys" });
    (instance as unknown as { deliverJobs(): number }).deliverJobs();
    return state.storage.sql.exec<{ state: string; output: string }>("SELECT state, output FROM jobs").one();
  });
  expect(jobs()).toEqual([]);
  expect(answer).toMatchObject({ state: "failed", output: expect.stringContaining("no longer allowed") });
});

it("lets an approved job wait 1 hour, not 24 (K-613, K-718)", async () => {
  const { job } = await approvedJobFor({}, { kind: "shell", script: "uptime" });
  const { created_at: created, expires_at: expires } = await job();
  expect(expires - created).toBe(60 * 60_000);
});

it("refuses an agent update of a Windows daemon that cannot start its task again, with the manual way (K-622, K-627)", async () => {
  const update = { body: { command: { kind: "update" } } };
  const stub = await setup({ runs: { mode: "automatic" } });
  const sent: Array<ServerToDaemon> = [];
  await machineWithCards(stub, ["vps"]);
  await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as { env: object; openSocket(id: string): WebSocket };
    const socket = daemonSocket(sent, windowsDaemon);
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: RELEASE };
    kitshn.openSocket = () => socket;
  });
  expect(await ask(stub, "job", "vps", update)).toEqual({
    outcome: "refused",
    reason: expect.stringContaining("schtasks /run"),
  });
  expect(sent.filter((message) => message.type === "job")).toEqual([]);
  // The status is unknown while the machine is offline, so delivery checks it again.
  const offline = await approvedJobFor({}, { kind: "update" }, windowsDaemon);
  expect(await offline.deliver()).toEqual([]);
  expect(await offline.job()).toMatchObject({
    state: "failed",
    output: expect.stringContaining("schtasks /run"),
  });
  const linux = await approvedJobFor({}, { kind: "update" }, linuxDaemon);
  expect(await linux.deliver()).toHaveLength(1);
  // The owner may still update such a daemon by hand (K-627).
  const manual = await approvedJobFor({}, { kind: "shell", script: "x" }, windowsDaemon);
  await runInDurableObject(manual.stub, (_, state) => {
    const { sql } = state.storage;
    sql.exec(
      "UPDATE jobs SET command = ?, visitor = ?",
      JSON.stringify({ kind: "update", version: RELEASE }),
      JSON.stringify(owner.visitor),
    );
    const body = sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one();
    const circle = JSON.parse(body.body) as Circle;
    sql.exec("UPDATE places SET x = ?, y = ? WHERE id = 'mac'", circle.x, circle.y);
  });
  expect(await manual.deliver()).toHaveLength(1);
});

it("keeps a stopped rollout through an agent update, and names who dropped the automatic update (K-627)", async () => {
  const stub = await setup({ runs: { mode: "automatic" } });
  await machineWithCards(stub, ["vps"]);
  const stopped = { version: RELEASE, step: null, failed: { machineId: "vps", reason: "x" }, updated: [] };
  const read = await runInDurableObject(stub, async (instance, state) => {
    const { sql } = state.storage;
    sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_rollout', ?)",
      JSON.stringify(stopped),
    );
    sql.exec(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
       VALUES ('vps', '[]', ?, 'queued', 0, ?, '{}', ?, NULL, '')`,
      JSON.stringify({ kind: "update", version: RELEASE }),
      Date.now() + 60_000,
      JSON.stringify({ email: null, clientId: null, ip: null, kitshn: true }),
    );
    const kitshn = instance as unknown as {
      env: object;
      rolloutCache: unknown;
      addJob(caller: object, body: object): Response;
    };
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: RELEASE };
    kitshn.rolloutCache = null;
    kitshn.addJob(
      {
        visitor: { email: null, clientId: "vps.access", ip: null },
        actor: { _tag: "machine", machineId: "vps", name: "vps" },
      },
      { machineId: "vps", command: { kind: "update" } },
    );
    return {
      rollout: JSON.parse(
        sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'daemon_rollout'").one().value,
      ) as {
        failed: unknown;
      },
      dropped: sql
        .exec<{ output: string }>("SELECT output FROM jobs WHERE state = 'failed' ORDER BY id LIMIT 1")
        .one().output,
    };
  });
  expect(read.rollout.failed).toMatchObject({ machineId: "vps" });
  expect(read.dropped).toContain("vps sent Update daemon");
  expect(read.dropped).not.toContain("owner");
});

it("keeps the no-circle check for an approved allow (K-718, K-819)", async () => {
  const stub = await setup({}, { members: [] });
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen) VALUES ('123', 'o/x', 'waiting', 0)",
    );
  });
  const id = proposalOf(await ask(stub, "allow", "123"));
  expect(await decideAs(stub, id, owner)).toMatchObject({
    ok: false,
    error: expect.stringContaining("no agent circle"),
  });
  const repo = await runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql.exec<{ state: string }>("SELECT state FROM repos WHERE repo_id = '123'").one().state,
  );
  expect(repo).toBe("waiting");
});

it("shows only the state and the reason of a job for a card that the machine does not manage (K-718)", async () => {
  const stub = await setup({ changes: { mode: "automatic" } });
  await machineWithCards(stub, []);
  const id = proposalOf(await ask(stub, "deploy", "shop"));
  expect(await decideAs(stub, id, owner)).toMatchObject({ ok: true });
  const jobId = await runInDurableObject(
    stub,
    (_, state) => state.storage.sql.exec<{ id: number }>("SELECT id FROM jobs").one().id,
  );
  const read = () => ask(stub, "job-read", String(jobId));
  expect(await read()).toEqual({ outcome: "done", result: { state: "sent", reason: null } });
  const fail = (output: string) =>
    runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE jobs SET state = 'failed', output = ?", output);
    });
  await fail("compose log of o/shop");
  const hidden = await read();
  expect(JSON.stringify(hidden)).not.toContain("o/shop");
  expect(hidden).toMatchObject({ result: { state: "failed", reason: expect.stringContaining("the map") } });
  await fail("no longer allowed: the machine that asked is gone.");
  expect(await read()).toMatchObject({
    result: { reason: "no longer allowed: the machine that asked is gone." },
  });
  // A card that it manages keeps the full job, and a machine in the tray reads its own job.
  const managed = await setup({ changes: { mode: "automatic" } });
  await machineWithCards(managed, ["shop"]);
  const done = await ask(managed, "deploy", "shop");
  const job = done.outcome === "done" ? (done.result as { job: number }).job : 0;
  expect(await ask(managed, "job-read", String(job))).toMatchObject({
    result: { machineId: "vps", command: { repo: "o/shop" } },
  });
  const tray = await setup({}, { members: [] });
  await machineWithCards(tray, []);
  const asked = proposalOf(await ask(tray, "job", "vps", restart));
  await decideAs(tray, asked, owner);
  const own = await runInDurableObject(
    tray,
    (_, state) => state.storage.sql.exec<{ id: number }>("SELECT id FROM jobs").one().id,
  );
  expect(await ask(tray, "job-read", String(own))).toMatchObject({ result: { state: "sent" } });
});
