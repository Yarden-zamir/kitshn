import { describe, expect, it, vi } from "vitest";
import {
  type AgentState,
  type AgentTransport,
  forwardWaiting,
  parseState,
  reachText,
  runAgentCommand,
  waitingLine,
} from "./agent.ts";

const state: AgentState = {
  rights: [{ id: "addsPages", name: "adds pages", mode: "ask", circle: { id: "owner", name: "Owner" } }],
  circles: [{ id: "agents", name: "Agents", level: "control" }],
  cards: [
    {
      id: "p1",
      kind: "page",
      name: "p",
      addresses: ["pages.example.com/p"],
      status: "running",
      endsAt: null,
      circles: [{ id: "agents", name: "Agents" }],
    },
  ],
};

/** A transport that answers each path from `answers` and records the calls. */
function fakeTransport(answers: Record<string, unknown>) {
  const calls: Array<string> = [];
  const transport: AgentTransport = {
    server: async () => "https://kit.example.com",
    state: async () => state,
    call: async (path, init) => {
      calls.push(`${init.method} ${path}`);
      return Response.json(answers[path] ?? { error: "no such path" }, {
        status: path in answers ? 200 : 404,
      });
    },
  };
  return { calls, transport: () => transport };
}

/** Runs one command; process.exit throws its code, so the test reads it. */
async function run(
  command: Parameters<typeof runAgentCommand>[0],
  args: Array<string>,
  t: () => AgentTransport,
) {
  const lines: Array<string> = [];
  using _log = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
  using _error = vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(line));
  using _exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  const exit = await runAgentCommand(command, args, t).then(
    () => 0,
    (error: Error) => Number(error.message.slice("exit ".length)),
  );
  return { exit, lines };
}

describe("agent state (K-718, K-1711)", () => {
  it("reads rights with their mode and circle, and cards with their circles by name", () => {
    expect(parseState({ ...state, servers: [] })).toEqual(state);
  });

  it("names the next step for an answer of the old shape", () => {
    expect(() => parseState({ ...state, rights: ["publishes"] })).toThrow("Update kitshn on this machine");
  });
});

describe("who opens a card (UX audit C2)", () => {
  it("names the circles, public for Everyone, private for the tray, and the map when none is the agent's", () => {
    expect(reachText([{ id: "agents", name: "Agents" }])).toBe("who opens it: Agents.");
    expect(reachText([{ id: "everyone", name: "Everyone" }])).toBe("public: anyone opens it.");
    expect(reachText([])).toMatch(/^private: only you open it\. Add --circle/);
    expect(reachText(null)).toMatch(/the map shows where it is/);
  });
});

describe("a forwarded call that waits (K-1776, UX audit C4)", () => {
  it("reads only a 409 with outcome waiting", () => {
    const body = JSON.stringify({
      outcome: "waiting",
      proposalId: "p-1",
      circle: "Owner",
      expiresAt: 5,
      error: "x",
    });
    expect(forwardWaiting(409, body)).toEqual({ proposalId: "p-1", circle: "Owner", expiresAt: 5 });
    expect(forwardWaiting(409, JSON.stringify({ error: "kitshn is paused" }))).toBeNull();
    expect(forwardWaiting(200, body)).toBeNull();
  });

  it("names the circle, the expiry and what happens when the command ends first", () => {
    const wait = { proposalId: "p-1", circle: "Owner", expiresAt: 23 * 3_600_000 };
    expect(waitingLine(wait, 0, true)).toBe(
      "waiting: Owner must approve proposal p-1 (expires in 23 h). This command waits and then runs the call. If it ends first, run the same command again within 1 hour after the approval (K-1776).",
    );
    expect(waitingLine({ ...wait, expiresAt: null }, 0, false)).toMatch(/approval still runs it/);
  });
});

describe("agent commands (UX audit C5, C6, C8)", () => {
  it("removes a card and takes one back to its previous version through the routes of K-1117", async () => {
    const { calls, transport } = fakeTransport({
      "/agent/cards/p1": { ok: true },
      "/agent/cards/p1/previous": { id: "p1" },
    });
    expect((await run("unpublish", ["p1"], transport)).exit).toBe(0);
    expect((await run("publish", ["--previous", "p1"], transport)).exit).toBe(0);
    expect(calls).toEqual(["DELETE /agent/cards/p1", "POST /agent/cards/p1/previous"]);
  });

  it("ends a publish line with who opens the card", async () => {
    const { transport } = fakeTransport({
      "/agent/library": { id: "p1", address: "pages.example.com/p", updated: true, revision: 2 },
    });
    const { exit, lines } = await run("publish", [new URL(import.meta.url).pathname], transport);
    expect(exit).toBe(0);
    expect(lines.at(-1)).toMatch(/at https:\/\/pages\.example\.com\/p\. who opens it: Agents\.$/);
  });

  it("exits 2 with the help of the command on bad arguments, before it calls kitshn", async () => {
    const transport = vi.fn<() => AgentTransport>();
    const { exit, lines } = await run("time", ["p1"], transport);
    expect(exit).toBe(2);
    expect(lines.join("\n")).toContain("kitshn time <card> <30m|1h|4h|1d|stop|now>");
    expect((await run("unpublish", [], transport)).exit).toBe(2);
    expect((await run("port", ["dance"], transport)).exit).toBe(2);
    expect(transport).not.toHaveBeenCalled();
  });
});
