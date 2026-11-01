import { describe, expect, it } from "vitest";
import { type Request, readAnswer, readRequest } from "./index.ts";

describe("local socket framing (K-702)", () => {
  it("keeps one request member per desired type, so a caller can narrow by type (K-709)", () => {
    // A member with both literals made Extract<Request, { type: "desired-set" }> never, so this did not typecheck.
    const set: Extract<Request, { type: "desired-set" }> = {
      id: "s",
      type: "desired-set",
      provider: "t3",
      kind: "t3.settings",
      part: "machine",
      value: {},
    };
    const init: Extract<Request, { type: "desired-init" }> = { ...set, id: "i", type: "desired-init" };
    expect([readRequest(JSON.stringify(set)).ok, readRequest(JSON.stringify(init)).ok]).toEqual([true, true]);
  });

  it("reads a request with its id", () => {
    expect(readRequest('{"id":"a","type":"status"}')).toEqual({
      ok: true,
      request: { id: "a", type: "status" },
    });
  });

  it("turns a bad line into an error answer, with the id when the line has a valid one", () => {
    expect(readRequest("{")).toMatchObject({ ok: false, answer: { id: null, type: "error" } });
    expect(readRequest('{"id":"a","type":"pass"}')).toMatchObject({
      ok: false,
      answer: { id: "a", type: "error" },
    });
    expect(readRequest('{"id":"","type":"status"}')).toMatchObject({ ok: false, answer: { id: null } });
    expect(readRequest('{"type":"status"}')).toMatchObject({ ok: false, answer: { id: null } });
  });

  it("reads an ask, and its waiting answer and result event (K-1710, K-1722)", () => {
    expect(
      readRequest('{"id":"a","type":"ask","action":"deploy","target":"card","labels":{"t3.thread.id":"x"}}'),
    ).toMatchObject({
      ok: true,
    });
    expect(readRequest('{"id":"a","type":"ask","action":"steal","target":""}')).toMatchObject({ ok: false });
    expect(readAnswer('{"id":"a","type":"ask","outcome":"waiting","proposalId":"p"}')).toMatchObject({
      outcome: "waiting",
    });
    expect(readAnswer('{"type":"ask-result","proposalId":"p","outcome":"denied"}')).toMatchObject({
      type: "ask-result",
    });
  });

  it("reads a health answer, and refuses a report with an error longer than its limit (K-630)", () => {
    const link = {
      provider: "t3",
      machineId: "b",
      status: 403,
      ms: 12,
      failures: 2,
      since: 1,
      error: "refused",
    };
    const report = {
      at: 5,
      providers: [{ provider: "t3", failures: 0, since: null, error: null }],
      links: [link],
    };
    expect(readAnswer(JSON.stringify({ id: "h", type: "health", report }))).toEqual({
      id: "h",
      type: "health",
      report,
    });
    expect(readAnswer('{"id":"h","type":"health","report":null}')).toEqual({
      id: "h",
      type: "health",
      report: null,
    });
    const long = { ...report, links: [{ ...link, error: "x".repeat(161) }] };
    expect(() => readAnswer(JSON.stringify({ id: "h", type: "health", report: long }))).toThrow();
  });

  it("throws on an answer that does not match, since daemon and client then disagree", () => {
    expect(() => readAnswer('{"id":"a","type":"status"}')).toThrow();
    expect(readAnswer('{"id":"a","type":"reconnect"}')).toEqual({ id: "a", type: "reconnect" });
  });
});
