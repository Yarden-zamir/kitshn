import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { AskOutcome, Machine, ServerToDaemon } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type RightMode } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

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
const daemonSocket = (sent: Array<ServerToDaemon>) =>
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
    members: [{ _tag: "machine", machineId: "vps", rights }],
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
    state.storage.sql.exec("DELETE FROM ask_events");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
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

it("refuses a right that is off and names it; a right that no circle sets asks the Owner (K-1720, K-1776)", async () => {
  const stub = await setup({ deploys: { mode: "automatic" }, addsApps: { mode: "off" } });
  expect(await ask(stub, "allow", "123")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining('"adds apps" is off'),
    need: "addsApps",
  });
  const unset = await setup({ deploys: { mode: "automatic" } });
  const waiting = await ask(unset, "allow", "123");
  expect(waiting).toMatchObject({ outcome: "waiting" });
  const circle = await runInDurableObject(
    unset,
    (_, state) =>
      state.storage.sql.exec<{ circle_id: string }>("SELECT circle_id FROM proposals").one().circle_id,
  );
  expect(circle).toBe("owner");
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
  expect(result["rights"]).toContainEqual({ id: "deploys", name: "deploys", mode: "automatic" });
  expect(result["rights"]).toContainEqual({
    id: "addsPages",
    name: "adds pages",
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  // K-1727: in a passkey circle, a member machine answers only while "machines may approve" is on.
  const locked = await setup({ deploys: { mode: "ask", circleId: "agents" } }, { needsPasskey: true });
  const asked = await ask(locked, "deploy", "card");
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
    error: expect.stringContaining("machines may approve"),
  });
});

it("expires a proposal after its time, so no later answer runs it (K-1724)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  const stub = await setup({ addsApps: { mode: "off" } });
  await ask(stub, "allow", "123");
  const events = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ action: string; outcome: string }>("SELECT action, outcome FROM ask_events")
      .toArray(),
  );
  expect(events).toEqual([{ action: "allow", outcome: "refused" }]);
});

it("reads only what its own event write reads for a refused ask, and a few rows for a new proposal (K-1715)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" }, addsApps: { mode: "off" } });
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  await setup({ deploys: { mode: "automatic" } });
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  const stub = await setup({ runsCommands: { mode: "ask", circleId: "owner" } });
  expect(
    await ask(stub, "job", "vps", { body: { command: { kind: "shell", script: "x".repeat(5000) } } }),
  ).toEqual({ outcome: "refused", reason: expect.stringContaining("too long") });
});

it("finds the ask events of one label, and keeps a caller's t3. label out (K-1756, K-1753)", async () => {
  const stub = await setup({ deploys: { mode: "automatic" } });
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
  const stub = await setup({ getsPasses: { mode: "automatic" } });
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
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
  // "adds apps" unset: the approval allows the waiting repo.
  const stub = await setup({ deploys: { mode: "automatic" } });
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
  // "publishes" unset: a page that the machine added goes into Everyone after the approval.
  const near = await setup({ deploys: { mode: "automatic" } }, { x: 1000, y: 0 });
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
  expect(await approve(near, waitingId(publish))).toMatchObject({ ok: true });
  // K-1711: "public": false moves the page out of Everyone into the agent circle that holds it, also when the
  // machine has an earlier agent circle elsewhere.
  await runInDurableObject(near, (_, state) => {
    const earlier = {
      id: "aa-earlier",
      name: "Earlier",
      color: "#00ccff",
      level: "control",
      members: [{ _tag: "machine", machineId: "vps", rights: { readsCode: { mode: "automatic" } } }],
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
  // The reviewer's deploy probe: "deploys" unset waits for the Owner; set to off meanwhile, the approval refuses.
  const offLater = await setup({ addsApps: { mode: "automatic" } });
  const deploy = await ask(offLater, "deploy", "card");
  expect(deploy).toMatchObject({ outcome: "waiting" });
  await runInDurableObject(offLater, (_, state) => {
    const [row] = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'")
      .toArray();
    const circle = JSON.parse(row?.body ?? "{}") as Circle;
    const members = [
      {
        _tag: "machine",
        machineId: "vps",
        rights: { addsApps: { mode: "automatic" }, deploys: { mode: "off" } },
      },
    ];
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = 'agents'",
      JSON.stringify({ ...circle, members }),
    );
  });
  await evictDurableObject(offLater);
  expect(await approve(offLater, waitingId(deploy))).toMatchObject({
    ok: false,
    error: expect.stringContaining('"deploys" to off'),
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
  const stub = await setup({ deploys: { mode: "ask", circleId: "agents" } });
  const mac: Machine = {
    ...machine,
    id: "mac",
    name: "mac",
    clientId: "mac.access",
    serviceTokenId: "token-mac",
  };
  // A device and a second machine in the Owner circle, so both may read the map, but neither is in Agents.
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
          ...ownerCircle.members.filter((member) => member._tag === "email"),
          { _tag: "device", tokenId: "token-laptop", clientId: "laptop.access", name: "laptop" },
          { _tag: "machine", machineId: "mac" },
        ],
      }),
      OWNER_CIRCLE_ID,
    );
  });
  await evictDurableObject(stub);
  expect(await ask(stub, "deploy", "card")).toMatchObject({ outcome: "waiting" });
  const token = (claims: { email: string } | { common_name: string }) => accessToken("admin-aud", claims);
  const person = await token({ email: "owner@example.com" });
  const live = async (jwt: string) => {
    const answer = await send("/api/state", { headers: { "cf-access-jwt-assertion": jwt } });
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { proposals: Array<{ machineId: string }> }).proposals;
  };
  // Outside Agents: no live ask, though each may read the map. History keeps the ask for the owner (K-1717).
  for (const jwt of [
    person,
    await token({ common_name: "laptop.access" }),
    await token({ common_name: "mac.access" }),
  ])
    expect(await live(jwt)).toEqual([]);
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

  // A machine in a passkey circle answers only while "machines may approve" is on, so only then it sees the ask.
  const members = [
    { _tag: "machine", machineId: "vps", rights: { deploys: { mode: "ask", circleId: "agents" } } },
    { _tag: "machine", machineId: "mac" },
  ];
  const locked = await setup({ deploys: { mode: "ask", circleId: "agents" } }, {
    needsPasskey: true,
    members,
  } as Partial<Circle>);
  expect(await ask(locked, "deploy", "card")).toMatchObject({ outcome: "waiting" });
  expect(await live(await token({ common_name: "mac.access" }))).toEqual([]);
  const open = await setup({ deploys: { mode: "ask", circleId: "agents" } }, {
    needsPasskey: true,
    machinesMayApprove: true,
    members,
  } as Partial<Circle>);
  expect(await ask(open, "deploy", "card")).toMatchObject({ outcome: "waiting" });
  expect(await live(await token({ common_name: "mac.access" }))).toMatchObject([{ machineId: "vps" }]);
});
