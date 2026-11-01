import type { Answer, Request } from "@kitshn/local";
import type { AgentState } from "kitshn/agent";
import { describe, expect, it } from "vitest";
import {
  type LocalAsk,
  forwardAndWait,
  helpText,
  liveAddress,
  rightLines,
  serverTable,
  unexposeRefusal,
} from "./cli.ts";

const request: Extract<Request, { type: "forward" }> = {
  id: "1",
  type: "forward",
  method: "POST",
  path: "/agent/library",
  body: "eA==",
};

const forwardAnswer = (status: number, body: object): Answer => ({
  id: "1",
  type: "forward",
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(body)).toString("base64"),
});

const waiting = forwardAnswer(409, {
  outcome: "waiting",
  proposalId: "p-1",
  circle: "Owner",
  expiresAt: 3_600_000,
  error: "waiting: …",
});

/** A daemon that answers the first call with a wait and then `result`, and every later call with `again`. */
function waitingDaemon(result: Answer, again: Answer) {
  const sent: Array<Request> = [];
  const ask: LocalAsk = async (sentRequest, follow = () => false, onLine = () => {}) => {
    sent.push(sentRequest);
    if (sent.length > 1) return again;
    onLine(waiting);
    expect(follow(waiting)).toBe(true);
    return result;
  };
  return { ask, sent };
}

describe("a forwarded call that waits for an approval (K-1776)", () => {
  it("prints the waiting line, and after the approval sends the same call once more", async () => {
    const lines: Array<string> = [];
    const { ask, sent } = waitingDaemon(
      { type: "ask-result", proposalId: "p-1", outcome: "approved" },
      forwardAnswer(200, { id: "card" }),
    );
    const answer = await forwardAndWait(
      ask,
      request,
      (line) => lines.push(line),
      () => 0,
    );
    expect(answer.status).toBe(200);
    expect(sent).toEqual([request, request]);
    expect(lines).toEqual([
      expect.stringMatching(/^waiting: Owner must approve proposal p-1 \(expires in 1 h\)/),
    ]);
  });

  it("says in one line that a denied call did not run, and sends nothing more", async () => {
    const { ask, sent } = waitingDaemon(
      { type: "ask-result", proposalId: "p-1", outcome: "denied", reason: "not now" },
      forwardAnswer(200, {}),
    );
    await expect(
      forwardAndWait(
        ask,
        request,
        () => {},
        () => 0,
      ),
    ).rejects.toThrow(
      "denied: proposal p-1 (not now). Nothing ran; run the command again to ask again (K-1776).",
    );
    expect(sent).toHaveLength(1);
  });

  it("gives any other answer back at once, also a refusal", async () => {
    const refused = forwardAnswer(403, { error: "off" });
    const ask: LocalAsk = async (_request, follow = () => false) => {
      expect(follow(refused)).toBe(false);
      return refused;
    };
    expect(
      await forwardAndWait(
        ask,
        request,
        () => {},
        () => 0,
      ),
    ).toBe(refused);
  });
});

const card = (name: string, address: string) => ({
  id: `live-vps-${name}`,
  kind: "site.live",
  name,
  addresses: [address],
  status: "running",
  endsAt: null,
  circles: [],
});
const withCards = (cards: AgentState["cards"]): AgentState => ({ rights: [], circles: [], cards });

describe("the address of kitshn expose (UX audit C1)", () => {
  it("takes the card's address, else the zone of another live site, else a pending guess", () => {
    expect(
      liveAddress("trek", withCards([card("trek", "trek.real.dev")]), "https://kit.example.com"),
    ).toEqual({
      address: "trek.real.dev",
      pending: false,
    });
    expect(liveAddress("new", withCards([card("trek", "trek.real.dev")]), "https://kit.example.com")).toEqual(
      {
        address: "new.real.dev",
        pending: true,
      },
    );
    expect(liveAddress("new", null, "https://kit.example.com")).toEqual({
      address: "new.example.com",
      pending: true,
    });
  });
});

describe("command text (UX audit C5, C10, C11, C12)", () => {
  it("lists dev servers first, with a header and the name each port is exposed as", () => {
    const lines = serverTable(
      [
        { port: 443, process: "OneDrive", status: 404, title: null },
        { port: 9000, process: "okta", status: null, title: null },
        { port: 5173, process: "node", status: 200, title: "Trek" },
      ],
      [{ name: "trek", target: "http://localhost:5173", dev: false }],
    );
    expect(lines.map((line) => line.split(/ +/).slice(0, 4))).toEqual([
      ["PORT", "PROCESS", "HTTP", "EXPOSED"],
      ["5173", "node", "200", "trek"],
      ["443", "OneDrive", "404", "-"],
      ["9000", "okta", "no", "http"],
    ]);
  });

  it("names the rights by their map names, with the circle that an ask goes to", () => {
    expect(
      rightLines([
        { id: "creates", name: "creates", mode: "automatic" },
        { id: "changes", name: "changes", mode: "ask", circle: { id: "owner", name: "Owner" } },
      ]),
    ).toEqual(["creates: automatic", "changes: asks Owner"]);
  });

  it("lists the exposed names when unexpose finds no site", () => {
    expect(unexposeRefusal("x", [{ name: "trek", target: "http://localhost:1", dev: false }])).toBe(
      "no site of this machine is named x. Exposed here: trek.",
    );
    expect(unexposeRefusal(undefined, [])).toBe("name the site to stop. Nothing is exposed on this machine.");
  });

  it("gives the help of one command, and of all commands for an unknown one", () => {
    expect(helpText("unpublish", "1")).toMatch(/^kitshn unpublish <card>/);
    expect(helpText("agent", "1")).toContain("job-read");
    expect(helpText(null, "1")).toContain("kitshn expose <port|socket>");
  });
});
