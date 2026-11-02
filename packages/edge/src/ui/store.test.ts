// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LinkEventView, Snapshot } from "../core/protocol.ts";
import { IDLE_MS, connect, withLinkEvent } from "./store.ts";

class FakeSocket {
  static readonly OPEN = 1;
  static readonly opened: Array<FakeSocket> = [];
  readyState = FakeSocket.OPEN;
  readonly sent: Array<unknown> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor() {
    FakeSocket.opened.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

/** K-605: a map that nobody uses stops its watch, so an open window costs no samples and no snapshots. */
it("stops the watch after 10 minutes with no input, and watches again at the next input", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  try {
    connect();
    const socket = FakeSocket.opened.at(-1)!;
    socket.onopen?.();
    const last = () => socket.sent.at(-1);
    expect(last()).toEqual({ type: "watching" });
    vi.advanceTimersByTime(IDLE_MS - 60_000);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(IDLE_MS - 60_000);
    expect(last()).toEqual({ type: "watching" });
    // The renewal after 10 minutes with no input ends the watch, once.
    vi.advanceTimersByTime(2 * 60_000);
    expect(last()).toEqual({ type: "watching", visible: false });
    const stopped = socket.sent.length;
    vi.advanceTimersByTime(IDLE_MS);
    expect(socket.sent).toHaveLength(stopped);
    // The next input watches again at once, so kitshn sends the current state (K-1302).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(socket.sent.slice(stopped)).toEqual([{ type: "watching" }]);
    // A refusal ends the socket with no reconnect timer.
    socket.onclose?.({ code: 4003, reason: "" });
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("adds a new link event on top of History once, and keeps the newest 50", () => {
  const event = (id: number): LinkEventView => ({
    id,
    at: id,
    source: "vps",
    target: "mac",
    kind: "tool",
    thread: null,
    name: "proxy-probe",
    cwd: null,
    outcome: "succeeded",
    exitCode: null,
  });
  const snapshot = {
    linkEvents: Array.from({ length: 50 }, (_, i) => event(50 - i)),
  } as unknown as Snapshot;
  const next = withLinkEvent(snapshot, event(51));
  expect(next.linkEvents.map((item) => item.id).slice(0, 2)).toEqual([51, 50]);
  expect(next.linkEvents).toHaveLength(50);
  // The snapshot that a map gets on `watching` can already hold the event.
  expect(withLinkEvent(next, event(51))).toBe(next);
});
