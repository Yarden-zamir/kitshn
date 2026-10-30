import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Machine, ServerToDaemon } from "../src/core/machine.ts";
import type { Circle, Resource, RightMode } from "../src/core/model.ts";

const machineOf = (id: string): Machine => ({
  id,
  name: id,
  labels: [],
  order: 0,
  serviceTokenId: `token-${id}`,
  clientId: `${id}.access`,
  tunnelId: `tunnel-${id}`,
});

/** A daemon socket of a machine that passed its key check (K-1704); it keeps what kitshn sends. */
const daemonSocket = (
  machineId: string,
  sent: Array<ServerToDaemon>,
  capabilities: ReadonlyArray<string> = ["protocol-2"],
) =>
  ({
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => ({
      kind: "machine",
      machineId,
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: { capabilities },
      sample: null,
    }),
    serializeAttachment() {},
    send: (text: string) => sent.push(JSON.parse(text) as ServerToDaemon),
    close() {},
  }) as unknown as WebSocket;

type Instance = {
  webSocketMessage(socket: WebSocket, text: string): Promise<void>;
  openSocket(machineId: string): WebSocket | null;
  endExecRuns(machineId: string): void;
  decide(id: string, decision: "approved" | "denied", by: object): Promise<{ ok: boolean; error?: string }>;
};

const owner = {
  actor: { _tag: "person", email: "owner@example.com" },
  visitor: { email: "owner@example.com", clientId: null, ip: null },
  machineId: null,
  reason: null,
};

/** mac's agent circle holds the machine card of vps at control, with "runs commands" as given. */
async function setup(runsCommands: RightMode) {
  const stub = env.KITSHN.getByName("kitshn-exec");
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "mac", rights: { runsCommands } }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  const card: Resource = {
    id: "vps",
    kind: "machine",
    name: "vps",
    addresses: [],
    status: "running",
    group: null,
    machine: "vps",
  };
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    for (const id of ["mac", "vps"])
      sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)", id, JSON.stringify(machineOf(id)));
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES ('vps', ?)", JSON.stringify(card));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('vps', 5000, 5000)");
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES ('agents', ?)", JSON.stringify(agents));
    for (const table of ["exec_runs", "link_events", "proposals"]) sql.exec(`DELETE FROM ${table}`);
  });
  await evictDurableObject(stub);
  return stub;
}

/** Runs `steps` with both daemons connected, unless `online` names fewer; returns what each got. */
async function relay(
  stub: DurableObjectStub,
  steps: (say: (from: "mac" | "vps", message: object) => Promise<void>, instance: Instance) => Promise<void>,
  online: ReadonlyArray<string> = ["mac", "vps"],
  targetCapabilities: ReadonlyArray<string> = ["protocol-2"],
) {
  const sent = { mac: [] as Array<ServerToDaemon>, vps: [] as Array<ServerToDaemon> };
  const sockets = {
    mac: daemonSocket("mac", sent.mac),
    vps: daemonSocket("vps", sent.vps, targetCapabilities),
  };
  await runInDurableObject(stub, async (raw) => {
    const instance = raw as unknown as Instance;
    // The tests hold no real hibernatable sockets, so the open socket of a machine is the fake one.
    instance.openSocket = (machineId) =>
      online.includes(machineId) ? (sockets[machineId as "mac" | "vps"] ?? null) : null;
    await steps(
      (from, message) => instance.webSocketMessage(sockets[from], JSON.stringify(message)),
      instance,
    );
  });
  return sent;
}

const run = (execId: string) => ({
  type: "execStart",
  execId,
  target: "vps",
  provider: "t3",
  run: { execId, command: "git status --short", cwd: "~/x", timeoutSeconds: 30, stdin: false },
  attested: { "t3.thread.id": "th-1" },
});

it("relays a run from A to B and back, and records one History event at its exit (K-722, K-1610)", async () => {
  const stub = await setup({ mode: "automatic" });
  const sent = await relay(stub, async (say) => {
    await say("mac", run("e1"));
    await say("vps", {
      type: "execFrame",
      execId: "e1",
      frame: { type: "output", stream: "stdout", data: "aGk=" },
    });
    await say("mac", { type: "execFrame", execId: "e1", frame: { type: "credit", bytes: 2 } });
    await say("vps", {
      type: "execFrame",
      execId: "e1",
      frame: { type: "exit", exitCode: 0, signal: null, durationMs: 12, reason: null },
    });
  });
  expect(sent.vps).toEqual([
    { type: "execRun", provider: null, run: run("e1").run },
    { type: "execFrame", execId: "e1", frame: { type: "credit", bytes: 2 } },
  ]);
  expect(sent.mac).toEqual([
    { type: "execState", execId: "e1", state: "running" },
    { type: "execFrame", execId: "e1", frame: { type: "output", stream: "stdout", data: "aGk=" } },
    expect.objectContaining({
      type: "execFrame",
      frame: expect.objectContaining({ type: "exit", exitCode: 0 }),
    }),
  ]);
  const events = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec("SELECT source, target, kind, thread, name, cwd, outcome FROM link_events")
      .toArray(),
  );
  // The command name only, never its arguments.
  expect(events).toEqual([
    {
      source: "mac",
      target: "vps",
      kind: "exec",
      thread: "th-1",
      name: "git",
      cwd: "~/x",
      outcome: "succeeded",
    },
  ]);
});

it("ends a run at once when the target is offline, and both sides when a connection or the run goes (C-15)", async () => {
  const stub = await setup({ mode: "automatic" });
  const offline = await relay(stub, (say) => say("mac", run("e2")), ["mac"]);
  expect(offline.mac).toEqual([
    {
      type: "execFrame",
      execId: "e2",
      frame: { type: "exit", exitCode: null, signal: null, durationMs: 0, reason: "the target is offline" },
    },
  ]);
  const lost = await relay(stub, async (say, instance) => {
    await say("mac", run("e3"));
    instance.endExecRuns("vps");
    // A frame of a run that kitshn no longer knows ends on its sender's side.
    await say("vps", { type: "execFrame", execId: "e3", frame: { type: "stdin-credit", bytes: 1 } });
  });
  expect(lost.mac.at(-1)).toMatchObject({
    execId: "e3",
    frame: { type: "exit", reason: "the relay was lost" },
  });
  expect(lost.vps.at(-1)).toEqual({
    type: "execFrame",
    execId: "e3",
    frame: { type: "close", what: "kill" },
  });
});

it("asks the approver circle in ask mode, keeps the exec id, and refuses without control of a card on B (K-722)", async () => {
  const stub = await setup({ mode: "ask", circleId: "owner" });
  const waiting = await relay(stub, (say) => say("mac", run("e4")));
  expect(waiting.mac).toEqual([
    { type: "execState", execId: "e4", state: "waiting", proposalId: expect.any(String) },
  ]);
  expect(waiting.vps).toEqual([]);
  await runInDurableObject(stub, (_, state) => state.storage.sql.exec("DELETE FROM places WHERE id = 'vps'"));
  await evictDurableObject(stub);
  const refused = await relay(stub, (say) => say("mac", run("e5")));
  expect(refused.mac).toEqual([
    expect.objectContaining({
      frame: expect.objectContaining({
        reason: expect.stringMatching(/^refused: mac controls no card on vps/),
      }),
    }),
  ]);
});

it("closes the proposal of a run that its caller ended or lost, so a later approval starts nothing on B (K-722)", async () => {
  const stub = await setup({ mode: "ask", circleId: "owner" });
  const proposalOf = (sent: Array<ServerToDaemon>) =>
    (sent.find((message) => message.type === "execState") as { proposalId: string }).proposalId;
  const killed = await relay(stub, async (say) => {
    await say("mac", run("e6"));
    await say("mac", { type: "execFrame", execId: "e6", frame: { type: "close", what: "kill" } });
  });
  const lost = await relay(stub, async (say, instance) => {
    await say("mac", run("e7"));
    instance.endExecRuns("mac");
  });
  for (const sent of [killed, lost]) {
    const approved = await relay(stub, async (_say, instance) => {
      expect(await instance.decide(proposalOf(sent.mac), "approved", owner)).toMatchObject({ ok: false });
    });
    expect(approved.vps).toEqual([]);
  }
  const states = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT state FROM proposals WHERE action = 'exec' ORDER BY created_at").toArray(),
  );
  expect(states.slice(-2)).toEqual([{ state: "denied" }, { state: "denied" }]);
});

it("runs the t3.agents step of migration 42 once, by its own mark, so a later start keeps an owner's Undo (K-722)", async () => {
  const stub = env.KITSHN.getByName("kitshn-agents-migration");
  const provider = (id: string, kind: string) => ({
    id: `vps/t3/${id}`,
    kind,
    name: id,
    addresses: [],
    status: "running",
    group: null,
    machine: "vps",
    provider: {
      name: "t3",
      localId: id,
      kindName: kind,
      levels: { view: "view", use: "use", control: "control" },
      facts: [],
      stickers: [],
      lists: [],
      settings: [],
      site: null,
    },
  });
  const circle = (rights: object): Circle => ({
    id: "machines",
    name: "Machines",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "mac", rights }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 9000,
    y: 9000,
    r: 200,
  });
  const machinesCircle = () =>
    runInDurableObject(stub, (_, state) =>
      JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'machines'").one().body,
      ),
    );
  const revisions = () =>
    runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM revisions WHERE summary LIKE 'Moved the T3 agents%'",
          )
          .one().n,
    );
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    for (const id of ["mac", "vps"])
      sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)", id, JSON.stringify(machineOf(id)));
    for (const card of [provider("agents", "t3.agents"), provider("app", "t3.app")]) {
      sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)", card.id, JSON.stringify(card));
      sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 9000, 9000)", card.id);
    }
    sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES ('machines', ?)",
      JSON.stringify(circle({ readsCode: { mode: "automatic" } })),
    );
    sql.exec("DELETE FROM meta WHERE key = 'agents-migrated'");
  });
  await evictDurableObject(stub);
  expect((await machinesCircle()).members[0].rights).toMatchObject({ runsCommands: { mode: "automatic" } });
  expect(await revisions()).toBe(1);
  // The owner takes the right back, as an Undo does; a second start must not set it again.
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = 'machines'",
      JSON.stringify(circle({ readsCode: { mode: "automatic" } })),
    ),
  );
  await evictDurableObject(stub);
  expect((await machinesCircle()).members[0].rights).not.toHaveProperty("runsCommands");
  expect(await revisions()).toBe(1);
});

it("refuses a run at once on a daemon of protocol 1, which would ignore it and leave the caller waiting (K-722)", async () => {
  const stub = await setup({ mode: "automatic" });
  const sent = await relay(stub, (say) => say("mac", run("e8")), ["mac", "vps"], ["applied", "access"]);
  expect(sent.vps).toEqual([]);
  expect(sent.mac).toEqual([
    expect.objectContaining({
      frame: expect.objectContaining({
        type: "exit",
        reason: expect.stringMatching(/^refused: the daemon of vps is too old/),
      }),
    }),
  ]);
});
