import { describe, expect, it } from "vitest";
import type { Edit } from "../../core/changes.ts";
import type { ServerMessage, Snapshot } from "../../core/protocol.ts";
import { DemoServer, hintOf } from "./server.ts";

/** Sends one message as the map does and returns the answer and the newest snapshot. */
function send(server: DemoServer, message: object) {
  let snapshot: Snapshot | null = null;
  const close = server.open((sent) => {
    if (sent.type === "snapshot") snapshot = sent.snapshot;
  });
  let answer: ServerMessage | null = null;
  server.receive(JSON.stringify({ requestId: "r", ...message }), (sent) => (answer = sent));
  close();
  return { answer: answer as ServerMessage | null, snapshot: snapshot as Snapshot | null };
}

const intoFriends: Array<Edit> = [{ _tag: "place", id: "habits", after: { x: 40, y: -140 } }];

describe("the kitshn of the site demo", () => {
  it("saves a drop into a circle as one revision, which Undo reverses", () => {
    const server = new DemoServer();
    const { answer, snapshot } = send(server, { type: "apply", edits: intoFriends });
    expect(answer).toMatchObject({ type: "result", ok: true, revision: 1 });
    expect(snapshot?.places["habits"]).toEqual({ x: 40, y: -140 });
    expect(snapshot?.revisions[0]?.summary).toContain("Friends");

    const undone = send(server, { type: "undo", revision: 1 });
    expect(undone.answer).toMatchObject({ ok: true, revision: 2 });
    expect(undone.snapshot?.places["habits"]).toEqual({ x: 280, y: -180 });
    expect(undone.snapshot?.revisions[1]).toMatchObject({ id: 1, undoneBy: 2 });
  });

  it("joins a move that follows a move of the same card into its revision (K-1505)", () => {
    const server = new DemoServer();
    send(server, { type: "apply", edits: intoFriends });
    const { answer, snapshot } = send(server, {
      type: "apply",
      edits: [{ _tag: "place", id: "habits", after: { x: 50, y: -130 } }],
    });
    expect(answer).toMatchObject({ ok: true, revision: 1 });
    expect(snapshot?.revisions).toHaveLength(1);
  });

  it("refuses what the real rules refuse, such as the admin card in a public circle (K-105)", () => {
    const server = new DemoServer();
    const { answer, snapshot } = send(server, {
      type: "apply",
      edits: [{ _tag: "place", id: "kitshn-admin", after: { x: 230, y: 90 } }],
    });
    expect(answer).toMatchObject({ ok: false });
    expect(snapshot?.places["kitshn-admin"]).toEqual({ x: -200, y: -120 });
    expect(snapshot?.revisions).toHaveLength(0);
  });

  it("answers the undo check of History and says what the demo does not do", () => {
    const server = new DemoServer();
    send(server, { type: "apply", edits: intoFriends });
    expect(server.request("GET", new URL("https://kitshn.com/api/undo?revision=1"))).toEqual({
      status: 200,
      body: { allowed: true },
    });
    expect(server.request("POST", new URL("https://kitshn.com/api/pages")).status).toBe(501);
  });

  it("starts the company map of /enterprise/ with the hint card in no circle, and shares it by the same rules", () => {
    const server = new DemoServer("company");
    const hint = hintOf("company");
    // A message with no answer: only the snapshot that a new map gets.
    const { snapshot: first } = send(server, { type: "tailStop", tail: "none" });
    expect(first?.resources.map((card) => card.name)).toEqual([
      "kitshn admin",
      "Status page",
      "Internal docs",
      "Sales report",
    ]);
    const sales = first?.circles.find((circle) => circle.id === hint.circle);
    expect(sales?.name).toBe("Sales");
    const { answer, snapshot } = send(server, {
      type: "apply",
      edits: [{ _tag: "place", id: hint.card, after: { x: sales?.x ?? 0, y: sales?.y ?? 0 } }],
    });
    expect(answer).toMatchObject({ ok: true });
    expect(snapshot?.revisions[0]?.summary).toContain("Sales");
  });
});
