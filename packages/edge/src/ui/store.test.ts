// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { LinkEventView, Snapshot } from "../core/protocol.ts";
import { IDLE_MS, connect, withLinkEvents } from "./store.ts";

/** A map socket whose kitshn answers each visible `watching`, as long as `answering` holds. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly opened: Array<FakeSocket> = [];
  readyState = FakeSocket.OPEN;
  answering = true;
  closed = false;
  readonly sent: Array<unknown> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor() {
    FakeSocket.opened.push(this);
  }
  send(data: string) {
    const message = JSON.parse(data) as { type: string; visible?: false };
    this.sent.push(message);
    if (message.type === "watching" && message.visible === undefined && this.answering)
      setTimeout(() => this.receive({ type: "watched" }), 0);
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.closed = true;
  }
}

const snapshot = (running: boolean) =>
  ({
    revision: 1,
    proposals: [],
    progress: running ? { card: { outcome: { state: "running" } } } : {},
  }) as unknown as Snapshot;

/** A map that kitshn accepted, with input just now. */
function openMap() {
  connect();
  const socket = FakeSocket.opened.at(-1)!;
  socket.onopen?.();
  socket.receive({ type: "snapshot", snapshot: snapshot(false) });
  window.dispatchEvent(new Event("pointerdown"));
  return socket;
}

const stopped = { type: "watching", visible: false };

/** K-605: a map that nobody uses stops its watch, so an open window costs no samples and no snapshots. */
it("stops the watch after 10 to 12 minutes with no input, but not while an action runs, and watches again at the next input", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  try {
    const socket = openMap();
    const last = () => socket.sent.at(-1);
    vi.advanceTimersByTime(IDLE_MS - 60_000);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(IDLE_MS - 60_000);
    expect(last()).toEqual({ type: "watching" });
    // The renewal after 10 minutes with no input ends the watch, once.
    vi.advanceTimersByTime(2 * 60_000);
    expect(last()).toEqual(stopped);
    const count = socket.sent.length;
    vi.advanceTimersByTime(IDLE_MS);
    expect(socket.sent).toHaveLength(count);
    // The next input watches again at once, so kitshn sends the current state (K-1302).
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(socket.sent.slice(count)).toEqual([{ type: "watching" }]);
    // K-538: a running action keeps the watch with no input; the first renewal after it ends stops it.
    socket.receive({ type: "snapshot", snapshot: snapshot(true) });
    vi.advanceTimersByTime(IDLE_MS + 4 * 60_000);
    expect(socket.sent.slice(count)).not.toContainEqual(stopped);
    socket.receive({ type: "snapshot", snapshot: snapshot(false) });
    vi.advanceTimersByTime(2 * 60_000);
    expect(last()).toEqual(stopped);
    socket.onclose?.({ code: 4003, reason: "" });
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

/** K-605: a wake of an idle map checks its socket, so a half-open one does not show old state as live. */
it("watches again on a wake while idle, and closes a socket that does not answer", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  try {
    const socket = openMap();
    vi.advanceTimersByTime(IDLE_MS + 2 * 60_000);
    expect(socket.sent.at(-1)).toEqual(stopped);
    socket.answering = false;
    window.dispatchEvent(new Event("pageshow"));
    expect(socket.sent.at(-1)).toEqual({ type: "watching" });
    vi.advanceTimersByTime(10_000);
    expect(socket.closed).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

it("adds new link events on top of History once, newest first, and keeps the newest 50", () => {
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
  const history = {
    linkEvents: Array.from({ length: 50 }, (_, i) => event(50 - i)),
  } as unknown as Snapshot;
  const next = withLinkEvents(history, [event(50), event(51), event(52)]);
  expect(next.linkEvents.slice(0, 3).map((item) => item.id)).toEqual([52, 51, 50]);
  expect(next.linkEvents).toHaveLength(50);
  // The snapshot that a map gets on `watching` can already hold the events.
  expect(withLinkEvents(next, [event(51), event(52)])).toBe(next);
});
