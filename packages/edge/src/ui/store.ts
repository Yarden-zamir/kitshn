import { useEffect, useState } from "preact/hooks";
import type { Edit } from "../core/changes.ts";
import type { CardKind, State, UndoSource } from "../core/model.ts";
import type { DrawnWire } from "../core/organize.ts";
import type { LogLine, TailAnswer } from "../core/logs.ts";
import type { ServerMessage, Snapshot } from "../core/protocol.ts";
import { type Held, isNewer, settle } from "./held.ts";

export type Connection = "connecting" | "live" | "offline" | "refused";

interface StoreState {
  readonly snapshot: Snapshot | null;
  readonly connection: Connection;
  readonly reason: string | null;
  /** Edits shown before the server holds them (see held.ts). */
  readonly held: ReadonlyArray<Held>;
}

type Result =
  | {
      readonly ok: true;
      readonly revision: number | null;
      readonly notes: ReadonlyArray<string>;
      readonly summary: string | null;
    }
  | { readonly ok: false; readonly error: string; readonly lost?: true };

let current: StoreState = { snapshot: null, connection: "connecting", reason: null, held: [] };
const listeners = new Set<() => void>();
const waiting = new Map<string, (result: Result) => void>();
let socket: WebSocket | null = null;

/** K-1805: what a Compose tail of this map sends after it started. */
export type TailEvent =
  | { readonly type: "lines"; readonly lines: ReadonlyArray<LogLine>; readonly skipped: number }
  | { readonly type: "end"; readonly reason: string };
const tailStarts = new Map<string, (answer: TailAnswer) => void>();
const tailListeners = new Map<string, (event: TailEvent) => void>();
let retryDelay = 1000;

const set = (next: Partial<StoreState>) => {
  current = { ...current, ...next };
  for (const listener of listeners) listener();
};

const CHECKLISTS_KEY = "kitshn.hiddenChecklists";
let hidden: ReadonlySet<string> | null = null;

/** K-633: the machines whose connect steps this device hides. Read once; every card asks on every frame of a pan. */
export const hiddenChecklists = (): ReadonlySet<string> =>
  (hidden ??= new Set(JSON.parse(localStorage.getItem(CHECKLISTS_KEY) ?? "[]") as Array<string>));

export function setChecklistHidden(machine: string, on: boolean) {
  const next = new Set(hiddenChecklists());
  if (on) next.add(machine);
  else next.delete(machine);
  hidden = next;
  localStorage.setItem(CHECKLISTS_KEY, JSON.stringify([...next]));
  set({});
}

export function useStore(): StoreState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  return current;
}

/** K-604 style backoff: 1 s, doubled after each failure, at most 30 s. */
export function connect() {
  const url = new URL("/api/ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  socket = ws;
  // A new socket starts with the newest state, also when the server state was reset to a lower revision.
  let first = true;
  set({ connection: "connecting" });
  ws.onopen = () => {
    retryDelay = 1000;
    set({ connection: "live", reason: null });
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.type === "snapshot") {
      if (!first && !isNewer(message.snapshot.revision, current.snapshot?.revision ?? null)) return;
      first = false;
      set({ snapshot: message.snapshot, held: settle(current.held, message.snapshot.revision) });
    } else if (message.type === "machine") {
      const snapshot = current.snapshot;
      if (snapshot) {
        const machines = snapshot.machines.map((view) =>
          view.machine.id === message.view.machine.id ? message.view : view,
        );
        set({ snapshot: { ...snapshot, machines } });
      }
    } else if (message.type === "tail") {
      tailStarts.get(message.requestId)?.(message.answer);
      tailStarts.delete(message.requestId);
    } else if (message.type === "tailLines") {
      tailListeners.get(message.tail)?.({ type: "lines", lines: message.lines, skipped: message.skipped });
    } else if (message.type === "tailEnd") {
      tailListeners.get(message.tail)?.({ type: "end", reason: message.reason });
      tailListeners.delete(message.tail);
    } else {
      waiting.get(message.requestId)?.(
        message.ok
          ? { ok: true, revision: message.revision, notes: message.notes, summary: message.summary }
          : message,
      );
      waiting.delete(message.requestId);
    }
  };
  ws.onclose = (event) => {
    for (const resolve of waiting.values()) {
      resolve({
        ok: false,
        lost: true,
        error:
          "The connection closed before kitshn answered. The map shows what kitshn saved when it reconnects.",
      });
    }
    waiting.clear();
    const lost = "The connection to kitshn closed. Turn Live on again when it is back.";
    for (const resolve of tailStarts.values()) resolve({ kind: "error", error: lost });
    tailStarts.clear();
    for (const listener of tailListeners.values()) listener({ type: "end", reason: lost });
    tailListeners.clear();
    if (event.code === 4003 || event.code === 1008) {
      set({ connection: "refused", reason: event.reason || "kitshn refused the connection." });
      return;
    }
    set({ connection: "offline" });
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
}

/** Reports why the map cannot open, from the HTTP API, when the WebSocket closes at once. */
export async function explainRefusal() {
  const response = await fetch("/api/state");
  if (response.ok) return null;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `kitshn answered ${response.status}.`;
}

function request(message: object, requestId: string = crypto.randomUUID()): Promise<Result> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ ok: false, error: "kitshn is not connected. Wait for the live sticker." });
  }
  socket.send(JSON.stringify({ ...message, requestId }));
  return new Promise((resolve) => waiting.set(requestId, resolve));
}

/** A JSON call to the admin API. Returns the body, or an error with the reason. */
export async function callApi<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: object,
): Promise<T | { error: string }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { error: `kitshn is not reachable: ${String(error)}` };
  }
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || data === null) return { error: data?.error ?? `kitshn answered ${response.status}.` };
  return data;
}

/** The JSON answer of an upload, or null when it is not JSON, for example an Access login page. */
type Answer = { id?: string; address?: string; revision?: number; error?: string };

function parseAnswer(text: string): Answer | null {
  try {
    return JSON.parse(text) as Answer;
  } catch {
    return null;
  }
}

/**
 * K-1101: an HTML file becomes a page (section 10); any other file stays a file. With `at`, the card lands
 * there on the map, so it gets the shares of the circles around that point (K-204); without, in the tray.
 * XMLHttpRequest, not fetch, because only it reports upload progress.
 */
export function upload(
  file: File,
  at: { readonly x: number; readonly y: number } | null = null,
  onProgress: (fraction: number) => void = () => undefined,
): Promise<{ id: string; address: string; revision: number } | { error: string }> {
  const lower = file.name.toLowerCase();
  const extension = [".html", ".htm"].find((ending) => lower.endsWith(ending));
  const name = extension ? file.name.slice(0, -extension.length) : file.name;
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", extension ? "/api/pages" : "/api/files");
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-kitshn-name", encodeURIComponent(name));
    if (at) {
      xhr.setRequestHeader("x-kitshn-x", String(Math.round(at.x)));
      xhr.setRequestHeader("x-kitshn-y", String(Math.round(at.y)));
    }
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
    xhr.onerror = () => resolve({ error: `kitshn is not reachable for ${file.name}.` });
    xhr.onload = () => {
      const data = parseAnswer(xhr.responseText);
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        data?.id &&
        data.address &&
        typeof data.revision === "number"
      )
        resolve({ id: data.id, address: data.address, revision: data.revision });
      else resolve({ error: data?.error ?? `kitshn answered ${xhr.status} for ${file.name}.` });
    };
    xhr.send(file);
  });
}

/**
 * Sends edits and shows them at once: they stay on the map until a snapshot reaches the revision that
 * saved them, and go only when the server refuses them (the caller shows the reason).
 */
export async function applyEdits(edits: ReadonlyArray<Edit>, requestId = hold(edits)): Promise<Result> {
  const result = await request({ type: "apply", edits }, requestId);
  const others = current.held.filter((item) => item.requestId !== requestId);
  if (!result.ok && result.lost) {
    // Saved or not is unknown: keep the edit in its place until the next snapshot shows what kitshn has.
    set({
      held: current.held.map((item) => (item.requestId === requestId ? { ...item, revision: 0 } : item)),
    });
  } else if (!result.ok || result.revision === null) set({ held: others });
  else {
    const saved: Held = { requestId, edits, revision: result.revision };
    set({ held: settle([...others, saved], current.snapshot?.revision ?? 0) });
  }
  return result;
}

/** Shows edits on the map before they are sent, for example while a confirmation is open. */
export function hold(edits: ReadonlyArray<Edit>): string {
  const requestId = crypto.randomUUID();
  set({ held: [...current.held, { requestId, edits, revision: null }] });
  return requestId;
}

/** Takes back held edits that were never sent, because the owner cancelled. */
export function release(requestId: string) {
  set({ held: current.held.filter((item) => item.requestId !== requestId) });
}
/** K-1509: `source` says which button sent the Undo, so History can show where it came from. */
export const undoRevision = (revision: number, source: UndoSource) =>
  request({ type: "undo", revision, source });
/** K-532: Organize, with the sizes that the map draws now. */
export const organizeMap = (sizes: DrawnWire, hiddenKinds: ReadonlyArray<CardKind>) =>
  request({ type: "organize", ...sizes, hiddenKinds });

export function toState(snapshot: Snapshot): State {
  return {
    circles: new Map(snapshot.circles.map((circle) => [circle.id, circle])),
    resources: new Map(snapshot.resources.map((resource) => [resource.id, resource])),
    places: new Map(Object.entries(snapshot.places)),
    shareSettings: new Map(Object.entries(snapshot.shareSettings)),
    ends: new Map(Object.entries(snapshot.ends)),
    stacks: new Map(snapshot.stacks.map((stack) => [stack.id, stack])),
    paused: snapshot.paused,
    machines: new Map(snapshot.machines.map((view) => [view.machine.id, view.machine])),
    actors: new Map(snapshot.actors.map((actor) => [actor.id, actor])),
  };
}

/** K-1805, K-1807: starts "Live" for a card. A Compose tail then sends its lines to `listener`. */
export function startTail(card: string, listener: (event: TailEvent) => void): Promise<TailAnswer> {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    return Promise.resolve({ kind: "error", error: "kitshn is not connected. Wait for the live sticker." });
  const requestId = crypto.randomUUID();
  socket.send(JSON.stringify({ type: "tail", requestId, card }));
  return new Promise((resolve) =>
    tailStarts.set(requestId, (answer) => {
      if (answer.kind === "compose") tailListeners.set(answer.tail, listener);
      resolve(answer);
    }),
  );
}

/** K-1805, K-1807: kitshn stops the tail; a closed connection stops it too. */
export function stopTail(tail: string) {
  tailListeners.delete(tail);
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "tailStop", tail }));
}
