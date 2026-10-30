import { render } from "preact";
import { App } from "../App.tsx";
import { connect } from "../store.ts";
import "../styles.css";
import "./neo.css";
import { startFeel } from "./feel.ts";
import { type DemoMap, DemoServer, hintOf } from "./server.ts";

/**
 * The map on kitshn.com: the real map (App.tsx and store.ts, unchanged) on a kitshn that lives in this page
 * (server.ts). It swaps the WebSocket and the fetch of /api for that kitshn before the map connects, wears the
 * site's neo-brutal skin (neo.css), and adds the held feel of a drag and the hint of the first drag (feel.ts).
 */

/** The home page shows a person's map; /enterprise/ asks for a company's with `?map=company`. */
const map: DemoMap = new URLSearchParams(location.search).get("map") === "company" ? "company" : "personal";
const server = new DemoServer(map);
/** The time that a real kitshn takes to answer, so the map's held edits and stickers show as they do live. */
const LATENCY_MS = 140;

class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private close_: (() => void) | null = null;

  constructor(_url: string | URL) {
    super();
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.close_ = server.open((message) => this.deliver(message));
    }, LATENCY_MS);
  }

  send(data: string) {
    setTimeout(() => server.receive(data, (message) => this.deliver(message)), LATENCY_MS);
  }

  close() {
    this.close_?.();
    this.readyState = 3;
  }

  private deliver(message: unknown) {
    if (this.readyState === 1)
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  await new Promise((done) => setTimeout(done, LATENCY_MS));
  const { status, body } = server.request(init?.method ?? "GET", url);
  return Response.json(body, { status });
};
globalThis.WebSocket = DemoSocket as unknown as typeof WebSocket;

// Each visit starts fresh: no view, panel width or shelf that an earlier visit of the site left behind.
for (const key of Object.keys(localStorage)) if (key.startsWith("kitshn.")) localStorage.removeItem(key);

const root = document.getElementById("app");
if (!root) throw new Error("The page has no #app element.");
const app = root;
connect();

// The map fits once, when it loads (K-514). The frame can still be the default 300 by 150 then, and the visitor can
// resize the window, so the map mounts at the frame's real size and mounts again on a resize, with a new fit, until
// the visitor touches it.
let mounts = 0;
let touched = false;
const mount = () => render(<App key={mounts++} panels={false} />, app);
const sized = () => innerWidth >= 240 && innerHeight >= 240;
for (const type of ["pointerdown", "keydown"])
  addEventListener(type, (event) => (touched ||= event.isTrusted), true);
// A panel that opens takes the focus (K-519). In a frame that would take the keyboard from the site around it, at
// load and in the hint, so the demo takes the focus only once the visitor uses it.
const focus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
  if (touched) focus.call(this, options);
};
// The frame is part of the page: the wheel scrolls the page, not the map, which neither pans nor zooms.
addEventListener("wheel", (event) => event.stopPropagation(), { capture: true });
// The view stays as it is: a right or middle drag would pan it. A circle moves by its head (feel.ts keeps it in the
// frame), but its edge grip, which resizes it, is off. neo.css gives a swipe to the page too.
addEventListener(
  "pointerdown",
  (event) => {
    const fixed = (event.target as Element).closest?.("[data-grip]");
    if (event.button === 1 || event.button === 2 || fixed) event.stopPropagation();
  },
  { capture: true },
);
// The menu of a card or a circle offers what the demo cannot do, such as deploys and settings.
addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
    event.stopPropagation();
  },
  { capture: true },
);
let resizing = 0;
addEventListener("resize", () => {
  if (mounts === 0 ? !sized() : touched) return;
  clearTimeout(resizing);
  resizing = window.setTimeout(mount, mounts === 0 ? 0 : 150);
});
if (sized()) mount();
startFeel(app, hintOf(map));
