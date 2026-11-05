import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { AskOutcome, Machine, ServerToDaemon } from "../src/core/machine.ts";
import type { Circle, Resource, RightMode } from "../src/core/model.ts";
import { insertActors, machine as machineChip } from "./actors.ts";

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

/** The machine in the agent circle "agents" with these rights, and an owner group of Yarden-zamir inside it. */
async function setup(rights: Partial<Record<string, RightMode>>) {
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
  };
  const group: Resource = {
    id: "repo-group-yarden-zamir",
    kind: "repo.group",
    name: "Yarden-zamir",
    addresses: [],
    status: "unknown",
    group: null,
    machine: null,
    match: "Yarden-zamir",
    githubWay: "app",
  };
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)", "vps", JSON.stringify(machine));
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)", "agents", JSON.stringify(agents));
    insertActors(sql, agents.members);
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)", group.id, JSON.stringify(group));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 5000, 5000)", group.id);
    sql.exec("DELETE FROM proposals");
    sql.exec("DELETE FROM github_tokens");
  });
  await evictDurableObject(stub);
  return stub;
}

/** A fake GitHub: the installation of the repo, a token, and its revocation. */
function fakeGitHub() {
  const calls: Array<string> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/repos/Yarden-zamir/riffle/installation") return Response.json({ id: 7 });
    if (url.pathname === "/app/installations/7/access_tokens")
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

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

async function askToken(stub: DurableObjectStub, repo: string, extra: object = {}) {
  const sent: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as { webSocketMessage(s: WebSocket, t: string): Promise<void> }).webSocketMessage(
      daemonSocket(sent),
      JSON.stringify({
        type: "ask",
        requestId: "r",
        ask: { action: "github-token", target: repo, body: { permission: "auto" }, ...extra },
      }),
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

it("gives a write token for one repo of an App owner, and revokes it when the key resets (K-1762, K-1716)", async () => {
  const calls = fakeGitHub();
  const stub = await setup({ changes: { mode: "automatic" } });
  expect(await askToken(stub, "Yarden-zamir/riffle")).toEqual({
    outcome: "done",
    result: { token: "ghs_test", expiresAt: expect.any(String), permission: "write" },
  });
  expect(calls).toContain("POST /app/installations/7/access_tokens");
  // The sealed copy survives a sleep of the Durable Object, so the reset still revokes the token.
  const stored = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ sealed: string }>("SELECT sealed FROM github_tokens").toArray(),
  );
  expect(stored).toHaveLength(1);
  expect(stored[0]?.sealed).not.toContain("ghs_test");
  await evictDurableObject(stub);
  const dropped: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as {
      openSocket(id: string): WebSocket | null;
      denyOpenProposals(id: string, why: string): void;
    };
    kitshn.openSocket = () => daemonSocket(dropped);
    kitshn.denyOpenProposals("vps", "reset");
  });
  expect(calls).toContain("DELETE /installation/token");
  // The daemon drops its kept copy too.
  expect(dropped).toContainEqual({ type: "dropTokens", repo: "Yarden-zamir/riffle" });
});

it("opens the one-hour window on approval with no token; the next ask of the machine gets it (K-1723)", async () => {
  fakeGitHub();
  const stub = await setup({ changes: { mode: "ask", circleId: "owner" } });
  const waiting = await askToken(stub, "Yarden-zamir/riffle");
  if (waiting.outcome !== "waiting") throw new Error(`The ask did not wait: ${waiting.outcome}`);
  const sent: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      openSocket(id: string): WebSocket | null;
      decide(id: string, d: string, by: object): Promise<{ ok: boolean; result?: unknown }>;
    };
    kitshn.openSocket = () => daemonSocket(sent);
    expect(
      await kitshn.decide(waiting.proposalId, "approved", {
        actor: { _tag: "person", email: "owner@example.com" },
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        machineId: null,
        reason: null,
      }),
    ).toEqual({ ok: true });
  });
  expect(sent).toEqual([{ type: "askResult", proposalId: waiting.proposalId, outcome: "approved" }]);
  const rows = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ result: string | null }>("SELECT result FROM proposals").toArray(),
  );
  expect(rows).toEqual([{ result: null }]);
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({
    outcome: "done",
    result: { token: "ghs_test" },
  });
  // An approval of another circle opens no window: the right now asks "agents", so the ask waits again.
  await runInDurableObject(stub, (_, state) => {
    const [row] = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'")
      .toArray();
    const agents = JSON.parse(row?.body ?? "null") as Circle;
    const members = [machineChip("vps", { changes: { mode: "ask", circleId: "agents" } })];
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = 'agents'",
      JSON.stringify({ ...agents, members }),
    );
  });
  await evictDurableObject(stub);
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({ outcome: "waiting" });
});

it("gives a read token at once when only changes is off, because reads starts automatic on a repo in scope (K-1730)", async () => {
  fakeGitHub();
  const stub = await setup({ changes: { mode: "off" } });
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({
    outcome: "done",
    result: { permission: "read" },
  });
  const asks = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT id FROM proposals").toArray(),
  );
  expect(asks).toEqual([]);
});

it("answers not kitshn for another owner, and refuses an App owner's repo whose code rights are off (K-1760, K-1733)", async () => {
  fakeGitHub();
  const stub = await setup({ reads: { mode: "off" }, changes: { mode: "off" } });
  expect(await askToken(stub, "qlik-trial/app")).toMatchObject({ outcome: "not-kitshn" });
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining('"reads" is off'),
    need: "reads",
  });
});

it("asks the Owner for a token when no code right is set; the approval opens the hour for git's auto ask (K-1776)", async () => {
  fakeGitHub();
  const stub = await setup({});
  // git asks "auto"; with no code right set, the Owner approves write.
  const waiting = await askToken(stub, "Yarden-zamir/riffle");
  if (waiting.outcome !== "waiting") throw new Error(`The ask did not wait: ${waiting.outcome}`);
  const decided = await runInDurableObject(stub, async (instance, state) => {
    const kitshn = instance as unknown as {
      openSocket(id: string): WebSocket | null;
      decide(id: string, d: string, by: object): Promise<{ ok: boolean; error?: string }>;
    };
    kitshn.openSocket = () => null;
    const circle = state.storage.sql
      .exec<{ circle_id: string }>("SELECT circle_id FROM proposals WHERE id = ?", waiting.proposalId)
      .one().circle_id;
    const result = await kitshn.decide(waiting.proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    });
    return { circle, result };
  });
  expect(decided).toEqual({ circle: "owner", result: { ok: true } });
  // git asks with "auto" and no askOwner; the open hour gives it the write token.
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({
    outcome: "done",
    result: { token: "ghs_test", permission: "write" },
  });
});
