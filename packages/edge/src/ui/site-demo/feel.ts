/**
 * The site demo's feel, on top of the real map: a held card stays inside the frame and leans into its motion
 * (neo.css turns `--lean` into a rotation and eases the card after the pointer), and once the map is on screen a
 * pointer shows the first drag, by sending the map the same pointer events that a mouse sends. A press or a key of
 * the visitor stops the hint.
 */

/** The card that the first-drag hint drags, and the circle it drags it into (server.ts `hintOf`). */
interface Hint {
  readonly card: string;
  readonly circle: string;
}
/** The room that a held card keeps from the edge of the frame. */
const EDGE = 8;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The visitor pressed or typed in the map; the hint then never starts, or stops where it is. */
let used = false;

export function startFeel(root: HTMLElement, hint: Hint) {
  for (const type of ["pointerdown", "keydown"])
    addEventListener(type, (event) => (used ||= event.isTrusted), true);
  keepInFrame();
  lean();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) hintWhenSeen(root, hint);
}

/**
 * The map has no pan or zoom here, so a card or a circle that left the frame would be gone: a pointer that would take
 * the held card, or the circle with its head, past an edge reaches the map at the edge instead. It runs before the
 * lean, which then sees the same pointer.
 */
function keepInFrame() {
  let held: { readonly dx: number; readonly dy: number; readonly w: number; readonly h: number } | null =
    null;
  addEventListener(
    "pointerdown",
    (event) => {
      const target = event.button === 0 ? (event.target as Element) : null;
      const box = target ? heldBox(target) : null;
      if (!box) return void (held = null);
      held = { dx: event.clientX - box.left, dy: event.clientY - box.top, w: box.width, h: box.height };
    },
    true,
  );
  const keep = (event: PointerEvent) => {
    if (!held || !event.isTrusted) return;
    const x = clamp(event.clientX, EDGE + held.dx, innerWidth - EDGE - held.w + held.dx);
    const y = clamp(event.clientY, EDGE + held.dy, innerHeight - EDGE - held.h + held.dy);
    if (event.type !== "pointermove") held = null;
    if (x === event.clientX && y === event.clientY) return;
    event.stopImmediatePropagation();
    event.target?.dispatchEvent(
      new PointerEvent(event.type, { ...pointerInit(event), clientX: x, clientY: y }),
    );
  };
  for (const type of ["pointermove", "pointerup"]) addEventListener(type, keep as EventListener, true);
  addEventListener("pointercancel", () => (held = null), true);
}

/** What a press holds: a card, or a circle by its head, with the head itself, which sits on the circle's edge. */
function heldBox(target: Element) {
  const card = target.closest?.("[data-card]");
  if (card) return card.getBoundingClientRect();
  const head = target.closest?.("[data-head]");
  const circle = head?.closest(".circle");
  if (!head || !circle) return null;
  const [a, b] = [head.getBoundingClientRect(), circle.getBoundingClientRect()];
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return { left, top, width: Math.max(a.right, b.right) - left, height: Math.max(a.bottom, b.bottom) - top };
}

const pointerInit = (event: PointerEvent): PointerEventInit => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  pointerId: event.pointerId,
  pointerType: event.pointerType,
  isPrimary: event.isPrimary,
  button: event.button,
  buttons: event.buttons,
  shiftKey: event.shiftKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  altKey: event.altKey,
});

/** The cards in a drag tilt by the speed of the pointer, and settle back when it stops. */
function lean() {
  let tilt = 0;
  let lastX: number | null = null;
  let frame = 0;
  const paint = () => {
    for (const card of document.querySelectorAll<HTMLElement>(".card.dragging"))
      card.style.setProperty("--lean", `${tilt.toFixed(2)}deg`);
  };
  const relax = () => {
    tilt *= 0.82;
    paint();
    frame = Math.abs(tilt) > 0.05 ? requestAnimationFrame(relax) : 0;
  };
  addEventListener(
    "pointermove",
    (event) => {
      if (lastX !== null) tilt += (clamp((event.clientX - lastX) * 0.9, -9, 9) - tilt) * 0.3;
      lastX = event.clientX;
      paint();
      if (!frame) frame = requestAnimationFrame(relax);
    },
    true,
  );
  addEventListener(
    "pointerup",
    () => {
      lastX = null;
      tilt = 0;
      for (const card of document.querySelectorAll<HTMLElement>(".card")) card.style.removeProperty("--lean");
    },
    true,
  );
}

function hintWhenSeen(root: HTMLElement, wanted: Hint) {
  const seen = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      seen.disconnect();
      setTimeout(() => void hint(root, wanted), 900);
    },
    { threshold: 0.6 },
  );
  // The map draws after its first snapshot; the hint waits for the card it drags.
  const ready = new MutationObserver(() => {
    if (!document.querySelector(`[data-card="${wanted.card}"]`)) return;
    ready.disconnect();
    // The map's root has no height (its layers are fixed), so the page itself is what shows in the frame.
    seen.observe(document.documentElement);
  });
  ready.observe(root, { childList: true, subtree: true });
}

async function hint(root: HTMLElement, wanted: Hint) {
  const card = document.querySelector<HTMLElement>(`[data-card="${wanted.card}"]`);
  const circle = document.querySelector(`[data-head="${wanted.circle}"]`)?.closest(".circle");
  if (!card || !circle || used) return;

  const cursor = document.createElement("div");
  cursor.className = "demo-cursor";
  cursor.innerHTML =
    '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 2l15 9.5-6.6 1.3 3.9 7.3-2.9 1.5-3.9-7.3L4 19z" fill="#19191b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  root.append(cursor);

  const from = card.getBoundingClientRect();
  const to = circle.getBoundingClientRect();
  const grip = { x: from.left + from.width * 0.4, y: from.top + from.height * 0.5 };
  // The card's centre goes to the middle of the circle, which holds no card: a drop on a card stacks.
  const drop = {
    x: to.left + to.width * 0.5 + (grip.x - from.left - from.width / 2),
    y: to.top + to.height * 0.55 + (grip.y - from.top - from.height / 2),
  };
  const send = (type: string, at: { x: number; y: number }, target: Element) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: at.x,
        clientY: at.y,
      }),
    );
  const glide = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    ms: number,
    step?: (at: { x: number; y: number }) => void,
  ) =>
    new Promise<boolean>((done) => {
      const began = performance.now();
      const frame = (now: number) => {
        if (used) return done(false);
        const t = Math.min(1, (now - began) / ms);
        const at = { x: a.x + (b.x - a.x) * ease(t), y: a.y + (b.y - a.y) * ease(t) };
        cursor.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
        step?.(at);
        if (t < 1) requestAnimationFrame(frame);
        else done(true);
      };
      requestAnimationFrame(frame);
    });

  let held = false;
  try {
    cursor.classList.add("on");
    if (!(await glide({ x: innerWidth - 40, y: innerHeight - 30 }, grip, 900))) return;
    cursor.classList.add("press");
    send("pointerdown", grip, card);
    held = true;
    if (!(await glide(grip, drop, 1400, (at) => send("pointermove", at, card)))) return;
    await wait(700);
    if (used) return;
    cursor.classList.remove("press");
    send("pointerup", drop, card);
    held = false;
    await wait(600);
  } finally {
    // A visitor who takes over mid-drag gets the card back where it was, as after a cancelled pointer.
    if (held) send("pointercancel", grip, card);
    cursor.classList.remove("on", "press");
    setTimeout(() => cursor.remove(), 400);
  }
}
