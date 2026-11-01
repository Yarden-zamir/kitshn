import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Change, type Edit, type ShareDiff, applyChanges, shareDiff } from "../core/changes.ts";
import {
  type Circle,
  type Point,
  type Resource,
  type State,
  circleAloneKey,
  circlesHolding,
  insideCircle,
  memberLabel,
  type CardKind,
} from "../core/model.ts";
import type { AccessState, MachineView, Snapshot } from "../core/protocol.ts";
import type { ActionProgress } from "../core/progress.ts";
import { ProgressSticker } from "./Progress.tsx";
import { LEVEL_TIPS, MATCH_TIPS, MEMBER_HELP, PASSKEY_TIP } from "./Circle.tsx";
import { RightStickers } from "./ActorRights.tsx";
import { type KindInfo, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS, kindInfo } from "./kinds.ts";
import { KeySticker, MachineLive, PresenceSticker, QueuedSticker } from "./Machines.tsx";
import { type MenuTarget, untilText } from "./actions.ts";
import { type DropTarget, dropHover, landingPoints, shareLines } from "./drop.ts";
import { isAgentCircle, memberKind } from "./members.ts";
import type { DrawnWire } from "../core/organize.ts";
import { USER_STACK, headAngle, stacksOf } from "../core/place.ts";
import { parseSiteInput } from "../core/sites.ts";
import { openToAll } from "../core/library.ts";
import { MoreButton } from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { CircleChips, ReachLayer, ShareChips, useShareClock } from "./Reach.tsx";
import { reachOf } from "../core/reach.ts";
import { FRAMED_KINDS, peekable } from "./frames.ts";
import { CardPreview, type FramePhase, KindSticker, PeekFrame, usePeek } from "./Peek.tsx";
import type { Rect } from "./popover.ts";
import { HOLD_MS, type Press, fingerDown, startPress, stepPress } from "./press.ts";
import {
  type Fingers,
  HEAD_LAYER,
  type View,
  ZOOM,
  cardLayer,
  pinchView,
  shownCardBoxes,
  stackOffsets,
  type DrawnCard,
  steadyBox,
} from "./layout.ts";
import { whenText } from "./time.ts";

export type { View };

export type Selection = { readonly cards: ReadonlySet<string>; readonly circle: string | null };

type Drag =
  | { readonly type: "pan"; readonly sx: number; readonly sy: number; readonly view: View }
  /** A finger on a tray card scrolls the tray list, as a finger on the map pans it. */
  | { readonly type: "scroll"; readonly list: HTMLElement; readonly sy: number; readonly top: number }
  | {
      readonly type: "cards";
      readonly start: Point;
      readonly origins: ReadonlyMap<string, Point>;
      readonly clicked: string;
      /** The card under the grab point, which a drop never stacks onto, so a nudge stays a move. */
      under: string | null;
      moved: boolean;
    }
  | {
      readonly type: "circle";
      readonly start: Point;
      readonly origin: Circle;
      readonly carry: ReadonlyMap<string, Point>;
      moved: boolean;
    }
  | { readonly type: "resize"; readonly origin: Circle }
  /** K-516: two fingers zoom and pan; the cards stay where they are. */
  | { readonly type: "pinch"; readonly from: Fingers; readonly view: View }
  | { readonly type: "box"; readonly start: Point; readonly end: Point; readonly base: ReadonlySet<string> };

/**
 * K-532: the sizes that the map draws now, for Organize: each card or stack around the place of its first card,
 * each circle head and each chip row. A zoomed-out map draws dots, so then the server takes plain card sizes.
 */
export function measureMap(state: State, previews: boolean): DrawnWire {
  const world = document.querySelector<HTMLElement>(".viewport > .world");
  if (!world) throw new Error("measureMap: the map is not on screen.");
  const columnOf = new Map<string, ReadonlyArray<string>>();
  for (const ids of stacksOf(state).values()) for (const id of ids) columnOf.set(id, ids);
  const cards = [...world.querySelectorAll<HTMLElement>(":scope > .card[data-card]")];
  const frameOf = (card: HTMLElement) => {
    const frame = card.querySelector<HTMLElement>(".preview-frame");
    return frame ? frame.offsetHeight + FRAME_MARGIN : 0;
  };
  // K-520: with Previews on, a frame goes to the cards near the centre of the view. Every card that can get one
  // counts with the tallest frame room, also in an open stack, so the grid does not depend on the view.
  const frameRoom = previews ? Math.max(FRAME_ROOM, ...cards.map(frameOf)) : 0;
  const drawn = new Map<string, Array<{ readonly id: string; readonly card: DrawnCard }>>();
  for (const element of cards) {
    const id = element.dataset["card"] ?? "";
    const column = columnOf.get(id) ?? [id];
    const first = column[0] ?? id;
    const place = state.places.get(first);
    if (!place) continue;
    const card: DrawnCard = {
      left: element.offsetLeft - place.x,
      top: element.offsetTop - place.y,
      width: element.offsetWidth,
      height: element.offsetHeight,
      frame: frameOf(element),
      framable:
        previews &&
        FRAMED_KINDS.has(state.resources.get(id)?.kind ?? "file") &&
        !element.classList.contains("stack-card"),
    };
    drawn.set(first, [...(drawn.get(first) ?? []), { id, card }]);
  }
  const boxes = [...drawn].map(([first, entries]) => {
    const column = columnOf.get(first) ?? [first];
    const ordered = [...entries].sort((a, b) => column.indexOf(a.id) - column.indexOf(b.id));
    return [
      first,
      steadyBox(
        ordered.map((entry) => entry.card),
        frameRoom,
        STACK_ROW,
        STACK_GAP,
      ),
    ] as const;
  });
  const sizeOf = (element: HTMLElement | null) =>
    element ? { width: element.offsetWidth, height: element.offsetHeight } : null;
  return {
    units: [...boxes].map(([id, box]) => ({ id, ...box })),
    heads: [...world.querySelectorAll<HTMLElement>(".circle > .head[data-head]")].flatMap((head) => {
      const size = sizeOf(head);
      return size ? [{ id: head.dataset["head"] ?? "", ...size }] : [];
    }),
    members: [...world.querySelectorAll<HTMLElement>(".circle > .members")].flatMap((members) => {
      const id = members.parentElement?.querySelector<HTMLElement>(":scope > .head")?.dataset["head"];
      const size = sizeOf(members);
      return id && size ? [{ id, ...size }] : [];
    }),
  };
}

/** K-407 */
export const ACCESS_TIPS = {
  applying: "Applying: Cloudflare does not have this change yet.",
  retrying: "Retrying: Cloudflare gave no clear answer, so kitshn tries again by itself.",
  applied: "Applied: Cloudflare has this change.",
} as const;

interface Props {
  /** K-1101: files dropped from the computer, with the map point under the pointer, or null over the tray. */
  onDropFiles: (files: Array<File>, at: Point | null) => void;
  /** K-1129: folders dropped on the map, each a new folder site; null over the tray. */
  onDropFolders: (folders: Array<FileSystemDirectoryEntry>, at: Point | null) => void;
  /**
   * K-509, K-522: cards let go after a drag, from the map or from the tray, with the point of each and what is under
   * the pointer. `dropPlan` (drop.ts) says what that does.
   */
  readonly onDrop: (moves: ReadonlyMap<string, Point>, target: DropTarget) => void;
  /** K-509: the tray, drawn inside the map so that its cards take the map's drag; it gets the dragged card ids. */
  readonly tray: ((dragging: ReadonlySet<string>) => ComponentChildren) | null;
  /** K-1131: a dropped address or port, such as `localhost:5565`, opens the site wizard with it. */
  onDropSite: (text: string) => void;
  readonly state: State;
  readonly access: Readonly<Record<string, AccessState>>;
  /** K-1125: up or down of each checked card. */
  readonly uptime: Snapshot["uptime"];
  /** K-538: the action of each card that runs, failed, or ended a moment ago. */
  readonly progress: Snapshot["progress"];
  readonly machines: ReadonlyMap<string, MachineView>;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly hidden: ReadonlySet<CardKind>;
  readonly view: View;
  /** Live previews of site and page cards (when the zoom allows). */
  readonly previews: boolean;
  /** K-520: the selected card offers its preview on its kind sticker (a wide screen; a phone has it in the card sheet). */
  readonly peek: boolean;
  readonly zone: string;
  readonly onView: (view: View) => void;
  /** The left edge of a panel that floats over the map, or null; live previews skip cards under it. */
  readonly panelLeft: number | null;
  /** The right edge of the shelf (K-525), or 0 without one; live previews skip cards under it too. */
  readonly trayRight: number;
  /** K-1508: `itemKey`s of the cards and circles that a History row highlights now. */
  readonly flash: ReadonlySet<string>;
  readonly openStacks: ReadonlySet<string>;
  /** K-303: the pull request number of each preview card. */
  readonly pullRequests: Readonly<Record<string, number>>;
  readonly onToggleStack: (key: string) => void;
  /** A circle that moved or changed size, with the cards it carries. */
  readonly onCommit: (edits: Array<Edit>, diffs: Array<ShareDiff>) => void;
  /** K-523: opens the context menu of a target next to `anchor`, or closes it with null. */
  readonly onMenu: (menu: { readonly target: MenuTarget; readonly anchor: Rect } | null) => void;
}

/** K-504: the circle-alone key of this device. */
export const ALONE_KEY = circleAloneKey(navigator.platform);

/** K-532: the room of a preview frame that no card shows now: the thumbnail at card width and its button row. */
const FRAME_ROOM = 140;
/** `.preview-frame` has `margin-top: 6px`. */
const FRAME_MARGIN = 6;

/** Preact 11 does not add a unit to numeric style values. */
const px = (value: number) => `${value}px`;
/** The row step of an open stack: a card with a row of stickers, such as a machine, plus a gap. */
const STACK_ROW = 124;
/** The gap under a card of an open stack that is taller than `STACK_ROW`, such as one with a preview frame. */
const STACK_GAP = 16;

/** Live previews: at most this many frames, for these kinds, from this zoom on. */
const MAX_PREVIEWS = 4;
const PREVIEW_SCALE = 0.8;

/** Cards from the tray fan out from the pointer, so several never cover each other. */
const fanOut = (at: Point, index: number): Point => ({
  x: Math.round(at.x + (index % 2) * 30),
  y: Math.round(at.y + index * 90),
});
const ZOOMED_OUT = 0.4;

export function MapView(props: Props) {
  const { state, view } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The fingers on the map now, by pointer id, for a pinch. */
  const fingers = useRef(new Map<number, Point>());
  const twoFingers = (): Fingers | null => {
    const [a, b] = [...fingers.current.values()];
    return a && b ? { a, b } : null;
  };
  /** A touch on a card that selects it on release, unless it moved, held or became a pinch. */
  const tap = useRef<{
    readonly choose: () => void;
    readonly stack: string | null;
    readonly world: Point;
    /** A tap on a tray card never zooms the map. */
    readonly inTray: boolean;
  } | null>(null);
  /** What a drop of the dragged cards lands on now, for the hover feedback. */
  const [hover, setHover] = useState<(ReturnType<typeof dropHover> & { readonly target: DropTarget }) | null>(
    null,
  );
  const stackTarget = hover?.target._tag === "card" ? hover.target.id : null;
  const [draft, setDraft] = useState<{ state: State; diffs: Array<ShareDiff>; pointer: Point } | null>(null);
  /** K-523: a right press or a touch that may open the context menu. */
  const hold = useRef<{ press: Press; readonly target: MenuTarget; timer: number | null } | null>(null);
  /**
   * A right release that the browser's `contextmenu` follows (Windows): that event opens the menu, unless the
   * press panned. On macOS and Linux `contextmenu` comes with the press instead, while `hold` is set.
   */
  const rightRelease = useRef<{ readonly panned: boolean } | null>(null);
  useEffect(() => {
    // A press anywhere else, or leaving the window, ends a right release that no `contextmenu` followed.
    const forget = () => {
      rightRelease.current = null;
    };
    addEventListener("pointerdown", forget, true);
    addEventListener("blur", forget);
    return () => {
      removeEventListener("pointerdown", forget, true);
      removeEventListener("blur", forget);
    };
  }, []);
  const viewport = useRef<HTMLDivElement>(null);
  /** The cards that had a frame in the last render (live previews keep them, see below). */
  const previewed = useRef<ReadonlySet<string>>(new Set());

  const shown = draft?.state ?? state;
  const now = useShareClock(state);
  // A head slides along its circle off the cards (layout.ts). It follows the stored map, not a drag in flight,
  // so a head never jumps while a card passes it.
  const headAngles = useMemo(() => {
    const cards = shownCardBoxes(state, props.hidden);
    return new Map([...state.circles.values()].map((circle) => [circle.id, headAngle(circle, cards)]));
  }, [state, props.hidden]);
  const toWorld = (clientX: number, clientY: number): Point => ({
    x: (clientX - view.x) / view.s,
    y: (clientY - view.y) / view.s,
  });
  const stacks = stacksOf(shown);
  const stackOf = (id: string) => [...stacks.entries()].find(([, ids]) => ids.includes(id));
  // K-508, K-521: an open stack spaces its cards by their drawn heights, which a preview frame or an opened preview
  // arrow changes without a render of the map, so a ResizeObserver reports them.
  const openIds = [...stacks].flatMap(([key, ids]) => (props.openStacks.has(key) ? ids : []));
  const [cardHeights, setCardHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const openKey = openIds.join(",");

  /**
   * What a drop at this point lands on, from what is on screen: a drawn card to stack onto (K-522), the tray (K-509)
   * or the map. `grabbed` is the card under the grab point, which a drop never stacks onto, so a nudge stays a move.
   */
  const dropTargetAt = (
    clientX: number,
    clientY: number,
    dragged: ReadonlySet<string>,
    grabbed: string | null,
  ): DropTarget => {
    const top = document
      .elementsFromPoint(clientX, clientY)
      .find((element) => !dragged.has(element.closest<HTMLElement>("[data-card]")?.dataset["card"] ?? ""));
    if (top?.closest(".tray")) return { _tag: "tray" };
    if (top?.closest(".overlay-panel, header.bar")) return { _tag: "away" };
    const title = top?.closest<HTMLElement>(".world .head[data-head]")?.dataset["head"];
    if (title) return { _tag: "title", id: title };
    const id = top?.closest<HTMLElement>(".world [data-card]")?.dataset["card"];
    if (!id || id === grabbed) return { _tag: "map" };
    // A stack by group (K-508) keeps its cards; a drop there moves instead.
    const stack = stackOf(id);
    return stack && !stack[0].startsWith(USER_STACK) ? { _tag: "map" } : { _tag: "card", id };
  };

  const preview = (changes: Array<Change>, pointer: Point) => {
    const next = applyChanges(state, changes);
    setDraft({ state: next, diffs: shareDiff(state, next), pointer });
  };

  /** K-523: what a context menu at this element and map point is for. */
  const targetAt = (element: Element | null, at: Point): MenuTarget => {
    const head = element?.closest<HTMLElement>("[data-head]")?.dataset["head"];
    if (head) return { _tag: "circle", id: head };
    const card = element?.closest<HTMLElement>("[data-card]")?.dataset["card"];
    if (!card) return { _tag: "map", at };
    // A closed stack of the owner draws as one card, so its menu is the stack's.
    const stack = stackOf(card);
    return stack && stack[0].startsWith(USER_STACK) && !props.openStacks.has(stack[0])
      ? { _tag: "stack", id: stack[0].slice(USER_STACK.length) }
      : { _tag: "card", id: card };
  };
  const openMenu = (target: MenuTarget, at: Point) =>
    props.onMenu({ target, anchor: { left: at.x, top: at.y, width: 0, height: 0 } });

  /** A right press opens the menu on release; a touch opens it after `HOLD_MS` and then `then` runs. */
  const beginPress = (event: PointerEvent, then?: () => void) => {
    // A second finger ends the first press, so its timer never opens a menu after it lifts.
    endPress();
    const start = { x: event.clientX, y: event.clientY };
    const entry = {
      press: startPress(start),
      target: targetAt(event.target as Element, toWorld(event.clientX, event.clientY)),
      timer: null as number | null,
    };
    if (event.pointerType === "touch")
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        entry.press = stepPress(entry.press, { type: "elapsed" });
        then?.();
        openMenu(entry.target, start);
      }, HOLD_MS);
    hold.current = entry;
  };

  const endPress = () => {
    const entry = hold.current;
    hold.current = null;
    if (entry?.timer != null) window.clearTimeout(entry.timer);
    return entry;
  };

  const placeChanges = (moves: Iterable<[string, Point]>): Array<Change> =>
    [...moves].map(([id, after]) => ({ _tag: "place", id, before: state.places.get(id) ?? null, after }));

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    const world = toWorld(event.clientX, event.clientY);
    const inTray = target.closest(".tray") !== null;
    // The tray's own controls, its list and its edge are not the map's; only its cards drag as map cards do.
    if (inTray && !target.closest("[data-card]")) return;
    // A new press ends an older one, also a touch whose release never came.
    endPress();
    try {
      // Every pointer, also each finger of a pinch, so its release always reaches the map.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone cannot be captured; the drag still works inside the viewport.
    }
    if (event.pointerType === "touch") {
      // A second finger turns any one-finger gesture into a pinch; a card drag in progress drops nothing, and
      // the card under the first finger is not selected.
      const both = fingerDown(
        fingers.current,
        event.pointerId,
        { x: event.clientX, y: event.clientY },
        event.isPrimary,
      );
      if (both) {
        tap.current = null;
        props.onMenu(null);
        setHover(null);
        setDraft(null);
        setDrag({ type: "pinch", from: both, view });
        return;
      }
    }
    if (event.button === 1 || event.button === 2) {
      if (event.button === 2) beginPress(event);
      setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
      return;
    }
    if (event.pointerType === "touch" && !target.closest("[data-card]")) beginPress(event);
    const grip = target.closest<HTMLElement>("[data-grip]");
    const head = target.closest<HTMLElement>("[data-head]");
    const cardElement = target.closest<HTMLElement>("[data-card]");
    if (grip) {
      const origin = state.circles.get(grip.dataset["grip"] ?? "");
      if (origin) setDrag({ type: "resize", origin });
      return;
    }
    if (head) {
      const origin = state.circles.get(head.dataset["head"] ?? "");
      if (!origin) return;
      props.onSelect({ cards: new Set(), circle: origin.id });
      // K-504: the head carries the cards inside the circle; the modifier moves the circle alone.
      const carry = new Map<string, Point>();
      if (!event[ALONE_KEY.property]) {
        for (const [id, place] of state.places) if (insideCircle(place, origin)) carry.set(id, place);
      }
      setDrag({ type: "circle", start: world, origin, carry, moved: false });
      return;
    }
    if (cardElement) {
      const id = cardElement.dataset["card"] ?? "";
      if (event.shiftKey) {
        const cards = new Set(props.selection.cards);
        if (cards.has(id)) cards.delete(id);
        else cards.add(id);
        props.onSelect({ cards, circle: null });
        return;
      }
      const ids = new Set(props.selection.cards.has(id) ? props.selection.cards : [id]);
      const stack = stackOf(id);
      if (stack && !props.openStacks.has(stack[0])) for (const member of stack[1]) ids.add(member);
      // K-521: an owner's stack moves as one, also when it is open; Pull out takes a card out.
      for (const card of ids) {
        const own = stackOf(card);
        if (own?.[0].startsWith(USER_STACK)) for (const member of own[1]) ids.add(member);
      }
      // A closed stack of the owner is selected whole, so its panel shows (K-521).
      const whole = stack && !props.openStacks.has(stack[0]) && stack[0].startsWith(USER_STACK);
      // In an open stack a click picks the one card, also when the whole stack was selected (K-521).
      const wholeOpenStack =
        stack !== undefined &&
        props.openStacks.has(stack[0]) &&
        props.selection.cards.size > 1 &&
        [...props.selection.cards].every((card) => stack[1].includes(card));
      const choose = () => {
        if (!props.selection.cards.has(id) || wholeOpenStack)
          props.onSelect({ cards: whole ? new Set(ids) : new Set([id]), circle: null });
      };
      const origins = new Map<string, Point>();
      let fresh = 0;
      for (const card of ids) origins.set(card, state.places.get(card) ?? fanOut(world, fresh++));
      const found = dropTargetAt(event.clientX, event.clientY, ids, null);
      const under = found._tag === "card" ? found.id : null;
      const carry = () => setDrag({ type: "cards", start: world, origins, clicked: id, under, moved: false });
      const start = () => {
        choose();
        carry();
      };
      // K-516, K-523: on touch, a long press opens the menu and starts the drag, so a swipe still pans; a tap
      // selects on release, so a pinch that starts on a card does not select it.
      if (event.pointerType === "touch") {
        const list = inTray ? target.closest<HTMLElement>(".tray-list") : null;
        setDrag(
          list
            ? { type: "scroll", list, sy: event.clientY, top: list.scrollTop }
            : { type: "pan", sx: event.clientX, sy: event.clientY, view },
        );
        // K-521: a tap opens a closed stack; in an open one it only selects the card, so the stack stays open.
        tap.current = {
          choose,
          stack: stack && !props.openStacks.has(stack[0]) ? stack[0] : null,
          world,
          inTray,
        };
        // A selection opens the sheet over half of a phone's map, so a tray card selects when it lands (App.tsx).
        beginPress(event, inTray ? carry : start);
      } else start();
      return;
    }
    if (event.pointerType === "touch") {
      setDrag({ type: "pan", sx: event.clientX, sy: event.clientY, view });
      return;
    }
    const base = event.shiftKey ? props.selection.cards : new Set<string>();
    props.onSelect({ cards: base, circle: null });
    setDrag({ type: "box", start: world, end: world, base });
  };

  const onPointerMove = (event: PointerEvent) => {
    const pointer = { x: event.clientX, y: event.clientY };
    if (fingers.current.has(event.pointerId)) fingers.current.set(event.pointerId, pointer);
    if (drag?.type === "pinch") {
      const both = twoFingers();
      if (both) props.onView(pinchView(drag.view, drag.from, both));
      return;
    }
    const entry = hold.current;
    if (entry) {
      const was = entry.press.phase;
      entry.press = stepPress(entry.press, { type: "move", at: pointer });
      // A move before the hold is a pan; a move after it is a drag, which closes the menu.
      if (entry.press.phase === "moved" && was !== "moved") {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
        entry.timer = null;
        if (was === "held") props.onMenu(null);
      }
    }
    if (!drag) return;
    const world = toWorld(event.clientX, event.clientY);
    if (drag.type === "scroll") {
      drag.list.scrollTop = drag.top - (event.clientY - drag.sy);
      return;
    }
    if (drag.type === "pan") {
      props.onView({
        ...drag.view,
        x: drag.view.x + event.clientX - drag.sx,
        y: drag.view.y + event.clientY - drag.sy,
      });
      return;
    }
    if (drag.type === "box") {
      const box = { ...drag, end: world };
      setDrag(box);
      const [x1, x2] = [Math.min(box.start.x, world.x), Math.max(box.start.x, world.x)];
      const [y1, y2] = [Math.min(box.start.y, world.y), Math.max(box.start.y, world.y)];
      const cards = new Set(drag.base);
      for (const [id, place] of state.places) {
        const kind = state.resources.get(id)?.kind;
        if (kind && !props.hidden.has(kind) && place.x > x1 && place.x < x2 && place.y > y1 && place.y < y2) {
          cards.add(id);
        }
      }
      props.onSelect({ cards, circle: null });
      return;
    }
    if (drag.type === "cards") {
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4 / view.s) drag.moved = true;
      if (!drag.moved) return;
      const moves = [...drag.origins].map(([id, origin]): [string, Point] => [
        id,
        { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) },
      ]);
      preview(placeChanges(landingPoints(state, new Map(moves))), pointer);
      const target = dropTargetAt(event.clientX, event.clientY, new Set(drag.origins.keys()), null);
      const onGrabbed = target._tag === "card" && target.id === drag.under;
      // Once the pointer leaves the card it was grabbed over, that card is a target like any other.
      if (!onGrabbed) drag.under = null;
      const over: DropTarget = onGrabbed ? { _tag: "map" } : target;
      setHover({ target: over, ...dropHover(state, new Map(moves), over) });
      return;
    }
    if (drag.type === "circle") {
      const dx = world.x - drag.start.x;
      const dy = world.y - drag.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4 / view.s) drag.moved = true;
      if (!drag.moved) return;
      const after = { ...drag.origin, x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) };
      const moves = [...drag.carry].map(([id, origin]): [string, Point] => [
        id,
        { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) },
      ]);
      preview(
        [{ _tag: "circle", id: after.id, before: drag.origin, after }, ...placeChanges(moves)],
        pointer,
      );
      return;
    }
    const r = Math.max(60, Math.round(Math.hypot(world.x - drag.origin.x, world.y - drag.origin.y) * 1.2));
    preview(
      [{ _tag: "circle", id: drag.origin.id, before: drag.origin, after: { ...drag.origin, r } }],
      pointer,
    );
  };

  const onPointerUp = (event: PointerEvent) => {
    fingers.current.delete(event.pointerId);
    // The pinch ends with the first finger that lifts; the other one starts nothing until it lifts too.
    if (drag?.type === "pinch") {
      endPress();
      setDrag(null);
      return;
    }
    const pending = tap.current;
    tap.current = null;
    const press = endPress();
    // A touch on a card that neither moved nor held is a tap: it selects, and opens a stack as a click does.
    // Zoomed out, a card is a dot too small to read, so the tap first zooms to it under the finger.
    if (pending && press?.press.phase === "waiting") {
      if (view.s < ZOOMED_OUT && !pending.inTray)
        props.onView({ x: event.clientX - pending.world.x, y: event.clientY - pending.world.y, s: 1 });
      else pending.choose();
      if (pending.stack) props.onToggleStack(pending.stack);
    }
    // No `contextmenu` came during the press, so it follows the release; a press that opened the menu is done.
    if (event.button === 2 && press && press.press.phase !== "held")
      rightRelease.current = { panned: press.press.phase === "moved" };
    // A touch that opened the menu does not also open a stack.
    const held = press?.press.phase === "held";
    // K-509, K-522: cards from the map and from the tray drop the same way (drop.ts).
    if (drag?.type === "cards" && drag.moved) {
      const world = toWorld(event.clientX, event.clientY);
      const moves = new Map(
        [...drag.origins].map(([id, origin]): [string, Point] => [
          id,
          {
            x: Math.round(origin.x + world.x - drag.start.x),
            y: Math.round(origin.y + world.y - drag.start.y),
          },
        ]),
      );
      props.onDrop(moves, dropTargetAt(event.clientX, event.clientY, new Set(moves.keys()), drag.under));
      setHover(null);
      setDrag(null);
      setDraft(null);
      return;
    }
    if (drag?.type === "cards" && !drag.moved && !held) {
      const stack = stackOf(drag.clicked);
      if (stack && !props.openStacks.has(stack[0])) props.onToggleStack(stack[0]);
    }
    if (draft) {
      const edits = editsOf(state, draft.state);
      if (edits.length > 0) props.onCommit(edits, draft.diffs);
    }
    setDrag(null);
    setDraft(null);
  };

  const onWheel = (event: WheelEvent) => {
    // The tray list scrolls on its own; the wheel there never moves the map.
    if ((event.target as Element).closest(".tray")) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const world = toWorld(event.clientX, event.clientY);
      const s = Math.min(ZOOM.max, Math.max(ZOOM.min, view.s * Math.exp(-event.deltaY / 300)));
      props.onView({ x: event.clientX - world.x * s, y: event.clientY - world.y * s, s });
    } else props.onView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
  };

  const previewCircles = new Set(draft?.diffs.map((diff) => diff.circle.id));
  // A few frames at most, for the site cards nearest the centre of the view, and only when they are readable.
  // Candidates: drawn site and page cards whose centre is in the open part of the map (not under the tray
  // or the panel). A card keeps its frame while it stays a candidate, so a pan never reloads a frame.
  const visible =
    props.previews && view.s >= PREVIEW_SCALE
      ? [...shown.places]
          .filter(([id]) => {
            const kind = shown.resources.get(id)?.kind;
            const stack = stackOf(id);
            // A closed owner's stack draws a list, not a frame.
            const drawn =
              !stack ||
              props.openStacks.has(stack[0]) ||
              (stack[1][0] === id && !stack[0].startsWith(USER_STACK));
            return kind !== undefined && FRAMED_KINDS.has(kind) && !props.hidden.has(kind) && drawn;
          })
          .map(([id, place]) => ({ id, x: place.x * view.s + view.x, y: place.y * view.s + view.y }))
          .filter(
            (card) =>
              card.x > props.trayRight &&
              card.y > 120 &&
              card.x < (props.panelLeft ?? innerWidth) &&
              card.y < innerHeight,
          )
          .sort(
            (a, b) =>
              Math.hypot(a.x - innerWidth / 2, a.y - innerHeight / 2) -
              Math.hypot(b.x - innerWidth / 2, b.y - innerHeight / 2),
          )
          .map((card) => card.id)
      : [];
  const kept = [...previewed.current].filter((id) => visible.includes(id));
  const previewIds = new Set([...kept, ...visible.filter((id) => !kept.includes(id))].slice(0, MAX_PREVIEWS));
  previewed.current = previewIds;
  const zoomedOut = view.s < ZOOMED_OUT;

  useEffect(() => {
    const world = viewport.current?.querySelector(".world");
    if (!world || openIds.length === 0 || zoomedOut) return;
    const elements = openIds.flatMap(
      (id) => world.querySelector<HTMLElement>(`:scope > [data-card="${CSS.escape(id)}"]`) ?? [],
    );
    const measure = () =>
      setCardHeights((before) => {
        const next = new Map(before);
        for (const element of elements) next.set(element.dataset["card"] ?? "", element.offsetHeight);
        const same =
          next.size === before.size && [...next].every(([id, height]) => before.get(id) === height);
        return same ? before : next;
      });
    const observer = new ResizeObserver(measure);
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [openKey, zoomedOut]);
  const draggedIds = drag?.type === "cards" && drag.moved ? new Set(drag.origins.keys()) : new Set<string>();
  // A drag of cards says what its drop does (`dropHover`); a drag of a circle says what its move changes.
  const labelLines = hover?.lines ?? (draft ? shareLines(draft.diffs, state) : []);
  // K-537: the lens follows the stored map, so a drag only moves its lines.
  const lens = props.selection.cards.size === 1 && !zoomedOut ? [...props.selection.cards][0] : undefined;
  const lensLines = useMemo(() => (lens ? reachOf(state, lens, now) : []), [state, lens, now]);
  const lit = lens
    ? new Set([
        lens,
        ...lensLines.flatMap((line) => [line.to, ...(line.from._tag === "card" ? [line.from.id] : [])]),
      ])
    : null;
  /** Where each shown card draws, filled while the cards render, for the lens lines. */
  const drawn = new Map<string, Point>();

  return (
    <div
      class="viewport"
      ref={viewport}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={(event) => {
        // A finger that the page lost ends a pinch, so it never turns a later touch into one.
        fingers.current.delete(event.pointerId);
        if (drag?.type === "pinch") setDrag(null);
      }}
      onPointerCancel={(event) => {
        // A cancelled pointer drops nothing; the cards go back.
        tap.current = null;
        fingers.current.delete(event.pointerId);
        endPress();
        rightRelease.current = null;
        setHover(null);
        setDrag(null);
        setDraft(null);
      }}
      onWheel={onWheel}
      onContextMenu={(event) => {
        // The tray's filter and head are not the map's; only its cards have the map's menu.
        const inTray = (event.target as Element).closest(".tray");
        if (inTray && !(event.target as Element).closest("[data-card]")) return;
        event.preventDefault();
        const press = hold.current;
        if (press) {
          // A touch opens its menu after HOLD_MS. A right press on macOS opens it now, unless it panned;
          // a move after this closes it, as after a long press.
          if (press.timer === null && press.press.phase === "waiting") {
            press.press = stepPress(press.press, { type: "elapsed" });
            openMenu(press.target, press.press.start);
          }
          return;
        }
        const release = rightRelease.current;
        rightRelease.current = null;
        if (release?.panned) return;
        // A right release, Ctrl and a click on macOS, the menu key or Shift+F10: the clicked or focused item.
        const element = event.target as HTMLElement;
        const box = element.getBoundingClientRect();
        const at =
          event.clientX || event.clientY
            ? { x: event.clientX, y: event.clientY }
            : { x: box.left, y: box.bottom };
        setDrag(null);
        setDraft(null);
        props.onMenu({
          target: targetAt(element, toWorld(at.x, at.y)),
          anchor: event.clientX || event.clientY ? { left: at.x, top: at.y, width: 0, height: 0 } : box,
        });
      }}
      onDragOver={(event) => {
        const types = event.dataTransfer?.types ?? [];
        const site = types.includes("text/uri-list") || types.includes("text/plain");
        if (!types.includes("Files") && !site) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
      }}
      onDrop={(event) => {
        // K-509: files let go over the tray wait there, private.
        const at = (event.target as Element).closest(".tray") ? null : toWorld(event.clientX, event.clientY);
        // The entries exist only while the drop event runs; a folder shows up in `files` too, as an empty file.
        const folders = [...(event.dataTransfer?.items ?? [])]
          .map((item) => item.webkitGetAsEntry())
          .filter((entry): entry is FileSystemDirectoryEntry => entry?.isDirectory === true);
        const names = new Set(folders.map((folder) => folder.name));
        const files = [...(event.dataTransfer?.files ?? [])].filter((file) => !names.has(file.name));
        if (files.length === 0 && folders.length === 0) {
          // K-1131: a link or text such as `localhost:5565`; a uri-list may carry comment lines that start with "#".
          const link = (event.dataTransfer?.getData("text/uri-list") ?? "")
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "" && !line.startsWith("#"));
          const text = link ?? event.dataTransfer?.getData("text/plain").trim() ?? "";
          // A bare word, such as a dragged card name, is no site.
          const input = parseSiteInput(text);
          if (input.kind === "invalid" || (input.kind === "remote" && !input.host.includes("."))) return;
          event.preventDefault();
          props.onDropSite(text);
          return;
        }
        event.preventDefault();
        if (files.length > 0) props.onDropFiles(files, at);
        if (folders.length > 0) props.onDropFolders(folders, at);
      }}
    >
      <div
        class="world"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          "--head-layer": HEAD_LAYER,
        }}
      >
        {[...shown.circles.values()].map((circle) => (
          <CircleView
            key={circle.id}
            circle={circle}
            state={shown}
            selected={props.selection.circle === circle.id}
            preview={previewCircles.has(circle.id)}
            titleTarget={
              hover?.joins === true && hover.target._tag === "title" && hover.target.id === circle.id
            }
            flash={props.flash.has(`circle:${circle.id}`)}
            headAngle={headAngles.get(circle.id) ?? 0}
            zoomedOut={zoomedOut}
            hidden={props.hidden}
            onMenu={(anchor) => props.onMenu({ target: { _tag: "circle", id: circle.id }, anchor })}
          />
        ))}
        {[...shown.resources.values()].map((resource) => {
          const place = shown.places.get(resource.id);
          if (!place || props.hidden.has(resource.kind)) return null;
          const stack = stackOf(resource.id);
          const open = stack ? props.openStacks.has(stack[0]) : false;
          const index = stack ? stack[1].indexOf(resource.id) : 0;
          const own = stack?.[0].startsWith(USER_STACK) ?? false;
          // A closed owner's stack shows through its first card of a shown kind.
          const face = own
            ? stack?.[1].find((id) => !props.hidden.has(shown.resources.get(id)?.kind ?? resource.kind))
            : stack?.[1][0];
          if (stack && !open && resource.id !== face) return null;
          const head = stack ? shown.places.get(stack[1][0] ?? "") : undefined;
          // A stack opens downwards as a column, so its cards stay near the circles that hold them (K-508, K-521).
          const at =
            stack && open && head
              ? {
                  x: head.x,
                  y:
                    head.y +
                    (stackOffsets(
                      stack[1].map((id) => cardHeights.get(id)),
                      STACK_ROW,
                      STACK_GAP,
                    )[index] ?? 0),
                }
              : place;
          for (const id of stack && !open ? stack[1] : [resource.id]) drawn.set(id, at);
          const selected = props.selection.cards.has(resource.id);
          // A closed stack shows the highlight of any of its cards.
          const flash = (stack && !open ? stack[1] : [resource.id]).some((id) =>
            props.flash.has(`card:${id}`),
          );
          // A closed stack draws through its face card, so a selection of any of its cards raises it.
          const shownIds = stack && !open ? stack[1] : [resource.id];
          const layer = cardLayer({
            dragging: draggedIds.has(resource.id),
            selected: shownIds.some((id) => props.selection.cards.has(id)),
            framed: previewIds.has(resource.id),
          });
          if (zoomedOut) {
            return (
              <div
                key={resource.id}
                data-card={resource.id}
                class={`mini${selected ? " sel" : ""}${stackTarget === resource.id ? " stack-target" : ""}${flash ? " flash" : ""}`}
                style={{
                  left: px(at.x),
                  top: px(at.y),
                  background: kindInfo(resource).color,
                  ...(layer === null ? {} : { "--layer": layer }),
                }}
                tabIndex={0}
                role="img"
                aria-label={resource.name}
                data-tip={`${resource.name}: ${kindInfo(resource).help} Zoom in to see its card.`}
              />
            );
          }
          if (stack && own && !open) {
            const userStack = shown.stacks.get(stack[0].slice(USER_STACK.length));
            return (
              <StackCard
                key={resource.id}
                id={resource.id}
                name={userStack?.name ?? ""}
                members={stack[1].flatMap((id) => shown.resources.get(id) ?? [])}
                state={shown}
                at={at}
                selected={stack[1].some((id) => props.selection.cards.has(id))}
                dragging={draggedIds.has(resource.id)}
                target={stackTarget === resource.id}
                flash={flash}
                dim={lit !== null && !stack[1].some((id) => lit.has(id))}
                layer={layer}
                onMenu={(anchor) =>
                  props.onMenu({ target: { _tag: "stack", id: stack[0].slice(USER_STACK.length) }, anchor })
                }
              />
            );
          }
          return (
            <CardView
              key={resource.id}
              resource={resource}
              state={shown}
              at={at}
              selected={selected}
              dragging={draggedIds.has(resource.id)}
              target={stackTarget === resource.id}
              flash={flash}
              dim={lit !== null && !(stack && !open ? stack[1] : [resource.id]).some((id) => lit.has(id))}
              layer={layer}
              count={stack && index === 0 ? stack[1].length : null}
              open={open}
              access={props.access[resource.id] ?? null}
              progress={props.progress[resource.id] ?? null}
              downSince={
                props.uptime[resource.id]?.up === false ? (props.uptime[resource.id]?.since ?? null) : null
              }
              machine={props.machines.get(resource.id) ?? null}
              pullRequest={props.pullRequests[resource.id] ?? null}
              preview={previewIds.has(resource.id)}
              peek={props.peek && props.selection.cards.size === 1}
              zone={props.zone}
              now={now}
              onMenu={(anchor) => props.onMenu({ target: { _tag: "card", id: resource.id }, anchor })}
              onClose={() => stack && props.onToggleStack(stack[0])}
            />
          );
        })}
        {lens ? <ReachLayer state={shown} selected={lens} lines={lensLines} drawn={drawn} /> : null}
      </div>
      {props.tray?.(draggedIds)}
      {drag?.type === "box" ? (
        <div
          class="box"
          style={{
            left: px(Math.min(drag.start.x, drag.end.x) * view.s + view.x),
            top: px(Math.min(drag.start.y, drag.end.y) * view.s + view.y),
            width: px(Math.abs(drag.end.x - drag.start.x) * view.s),
            height: px(Math.abs(drag.end.y - drag.start.y) * view.s),
          }}
        />
      ) : null}
      {draft && labelLines.length > 0 ? (
        <div class="drop-label" style={{ left: px(draft.pointer.x), top: px(draft.pointer.y) }}>
          {labelLines.map((line, index) => (
            <span key={index} class={line.minus ? "minus" : ""}>
              {line.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The edits that turn `from` into `to`, for circles and places only. */
function editsOf(from: State, to: State): Array<Edit> {
  const edits: Array<Edit> = [];
  for (const [id, circle] of to.circles)
    if (from.circles.get(id) !== circle) edits.push({ _tag: "circle", id, after: circle });
  for (const [id, place] of to.places)
    if (from.places.get(id) !== place) edits.push({ _tag: "place", id, after: place });
  return edits;
}

export function CircleView(props: {
  circle: Circle;
  state: State;
  selected: boolean;
  preview: boolean;
  /** K-539: a machine card hangs over the title, so a drop adds it as a member. */
  titleTarget?: boolean;
  flash: boolean;
  /** Where the head sits on the edge, in radians from the top (layout.ts). */
  headAngle: number;
  zoomedOut: boolean;
  hidden: ReadonlySet<CardKind>;
  onMenu: (anchor: Rect) => void;
}) {
  const { circle } = props;
  const shown = circle.members.slice(0, 4);
  // K-718, K-1778: rights count only in an agent circle: actors that are not people, and no rule.
  const agentCircle = isAgentCircle(circle, props.state);
  const extra = circle.members.length - shown.length;
  const counts = new Map<CardKind, { readonly count: number; readonly info: KindInfo }>();
  if (props.zoomedOut) {
    for (const resource of props.state.resources.values()) {
      const place = props.state.places.get(resource.id);
      if (place && insideCircle(place, circle))
        counts.set(resource.kind, {
          count: (counts.get(resource.kind)?.count ?? 0) + 1,
          info: kindInfo(resource),
        });
    }
  }
  return (
    <div
      class={`circle${props.selected ? " sel" : ""}${props.preview ? " preview" : ""}${props.flash ? " flash" : ""}`}
      style={{
        left: px(circle.x - circle.r),
        top: px(circle.y - circle.r),
        width: px(circle.r * 2),
        height: px(circle.r * 2),
        "--c": circle.color,
      }}
    >
      <div
        class={`head${props.titleTarget ? " stack-target" : ""}`}
        data-head={circle.id}
        style={{
          left: px(circle.r + circle.r * Math.sin(props.headAngle)),
          top: px(circle.r - circle.r * Math.cos(props.headAngle) - 20),
        }}
        tabIndex={0}
        role="group"
        aria-label={`Circle ${circle.name}`}
        data-tip={`${circle.name}: a click edits the circle. A drag moves it with its cards; ${ALONE_KEY.label} and a drag moves the circle alone.`}
      >
        <span>{circle.name}</span>
        <span
          class="sticker"
          data-tip={LEVEL_TIPS[circle.level]}
          style={{ "--tilt": LEVEL_TILTS[circle.level], background: LEVEL_COLORS[circle.level] }}
        >
          {circle.level}
        </span>
        {circle.needsPasskey ? (
          <span role="img" aria-label="Needs a passkey" data-tip={PASSKEY_TIP}>
            🔑
          </span>
        ) : null}
        {circle.match === "all" ? (
          <span role="img" aria-label="All must match" data-tip={MATCH_TIPS.all}>
            ∧
          </span>
        ) : null}
        <MoreButton name={circle.name} onOpen={props.onMenu} />
      </div>
      {props.zoomedOut ? (
        <div class="counts">
          {[...counts].map(([kind, { count, info }]) => (
            <span
              key={kind}
              data-tip={`${count} ${info.label.toLowerCase()} in ${circle.name}. Zoom in to see the cards.`}
            >
              {info.icon} {count}
            </span>
          ))}
        </div>
      ) : (
        <div class="members">
          {shown.map((member, index) => {
            const kind = memberKind(member, props.state);
            return (
              <span class="chip" key={index} data-tip={MEMBER_HELP[kind]}>
                {MEMBER_ICONS[kind]} {memberLabel(member, props.state)}
                {member._tag === "actor" && agentCircle ? <RightStickers member={member} /> : null}
              </span>
            );
          })}
          {extra > 0 ? (
            <span
              class="chip"
              data-head={circle.id}
              data-tip={`Also ${circle.members
                .slice(4)
                .map((member) => memberLabel(member, props.state))
                .join(", ")}. A click opens the full list.`}
            >
              +{extra}
            </span>
          ) : null}
        </div>
      )}
      <div
        class="grip"
        data-grip={circle.id}
        data-tip="Drag to resize the circle. The preview names every card that gains or loses it."
      />
    </div>
  );
}

/** K-538: the progress sticker says this Access error already, so the K-407 sticker would repeat it. */
const progressSays = (progress: ActionProgress | null, error: string) =>
  progress?.retry?.reason === error ||
  (progress?.outcome.state === "failed" && progress.outcome.reason === error);

export function CardView(props: {
  resource: Resource;
  /** `cardLayer`: its z-index on the map, or null for document order. */
  layer: number | null;
  state: State;
  /** Its point on the map, or null in the tray, which lays it out. */
  at: Point | null;
  selected: boolean;
  dragging: boolean;
  target: boolean;
  flash: boolean;
  /** K-537: the lens of another card is on, and this card has no line. */
  dim?: boolean;
  count: number | null;
  open: boolean;
  access: AccessState | null;
  /** K-538: the action that runs on the card, failed, or ended a moment ago. */
  progress: ActionProgress | null;
  /** K-1125: when the card went down, or null while it is up or unchecked. */
  downSince: number | null;
  machine: MachineView | null;
  pullRequest: number | null;
  preview: boolean;
  /** A fixed phase of its preview frame, for the style guide (`/neo-brutalism`). */
  previewStill?: FramePhase;
  /** The preview of the ▾ starts open, for the style guide; the map never sets it. */
  previewOpen?: boolean;
  /** K-520: the selected card offers its preview on its kind sticker; a phone has it in the card sheet instead. */
  peek: boolean;
  zone: string;
  /** The time that the share chips are drawn for (`useShareClock`). */
  now: number;
  onMenu: (anchor: Rect) => void;
  onClose: () => void;
}) {
  const { resource, state } = props;
  const endsAt = state.ends.get(resource.id);
  // K-520: the selected card offers its preview on its kind sticker, unless a live preview already shows.
  const peek = usePeek(
    props.selected && props.peek && peekable(resource) && !(props.preview && resource.addresses[0]),
    props.previewOpen,
  );
  return (
    <div
      class={`card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}${props.target ? " stack-target" : ""}${props.flash ? " flash" : ""}${props.dim ? " dim" : ""}`}
      data-card={resource.id}
      style={{
        ...(props.at === null ? {} : { left: px(props.at.x), top: px(props.at.y) }),
        ...(props.layer === null ? {} : { "--layer": props.layer }),
      }}
    >
      {props.count !== null && props.open ? (
        <button
          type="button"
          class="sticker count"
          aria-label={`Close the stack of ${props.count} cards`}
          data-tip={`${props.count} cards. Close them into one card again.`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={props.onClose}
        >
          {props.count} ▴
        </button>
      ) : props.count !== null ? (
        <span
          class="sticker count"
          data-tip={`${props.count} cards of one group. A click spreads them; a drag moves them all.`}
        >
          {props.count}
        </span>
      ) : null}
      <div class="states">
        {props.progress ? (
          <ProgressSticker progress={props.progress} panel={`#map/${encodeURIComponent(resource.id)}`} />
        ) : null}
        {props.access?.state === "applying" && !props.progress ? (
          <span class="sticker wait state" data-tip={ACCESS_TIPS.applying}>
            applying
          </span>
        ) : null}
        {props.access?.state === "retrying" && !progressSays(props.progress, props.access.error) ? (
          <span class="sticker wait state" data-tip={`${ACCESS_TIPS.retrying} ${props.access.error}`}>
            retrying
          </span>
        ) : null}
        {props.access?.state === "failed" && !progressSays(props.progress, props.access.error) ? (
          <span
            class="sticker state"
            data-tip={`Failed: Cloudflare refused the change. ${props.access.error}`}
          >
            failed
          </span>
        ) : null}
        {props.downSince !== null ? (
          <span
            class="sticker state"
            data-tip={`Down since ${whenText(props.downSince)}: the uptime check of kitshn gets no good answer.`}
          >
            down
          </span>
        ) : null}
      </div>
      <div class="name">
        <ItemIcon resource={resource} />
        {resource.name}
      </div>
      <div class="sub">{resource.addresses[0] ?? kindInfo(resource).name}</div>
      {endsAt !== undefined ? (
        <div
          class="sub ends"
          data-tip={`K-212: at this time ${resource.name} moves to the tray, out of every circle. Its menu extends it, makes it permanent or ends it now.`}
        >
          ⏱ {untilText(endsAt)}
        </div>
      ) : null}
      {props.machine ? <MachineLive view={props.machine} state={state} /> : null}
      <div class="foot">
        <KindSticker resource={resource} peek={peek} />
        {props.pullRequest !== null ? (
          <span
            class="sticker info"
            data-tip={`A preview of pull request #${props.pullRequest}. It goes when the pull request closes; its panel links the pull request.`}
          >
            PR #{props.pullRequest}
          </span>
        ) : null}
        {resource.kind === "port" && openToAll(state, resource, Date.now()) ? (
          <span
            class="sticker info"
            data-tip="Open to all: a share in Everyone opens the gated ports to every address, with no door and no login (K-2005)."
          >
            open to all
          </span>
        ) : null}
        {props.machine ? <PresenceSticker view={props.machine} time={false} /> : null}
        {props.machine ? <KeySticker view={props.machine} /> : null}
        {props.machine ? <QueuedSticker view={props.machine} /> : null}
        <MoreButton name={resource.name} onOpen={props.onMenu} />
      </div>
      <ShareChips state={state} resource={resource} now={props.now} />
      {props.preview && resource.addresses[0] ? (
        <CardPreview
          resource={resource}
          state={state}
          zone={props.zone}
          {...(props.previewStill ? { still: props.previewStill } : {})}
        />
      ) : (
        <PeekFrame peek={peek} resource={resource} state={state} zone={props.zone} />
      )}
    </div>
  );
}

/**
 * K-509: a card in the tray, private until it lands on the map. It is the map's card, so it drags, drops and opens
 * its menu (K-523) as one; only the tray lays it out.
 */
export function TrayCard(props: {
  readonly resource: Resource;
  readonly state: State;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly access: AccessState | null;
  readonly progress: ActionProgress | null;
  readonly machine: MachineView | null;
  readonly zone: string;
  readonly onMenu: (anchor: Rect) => void;
}) {
  return (
    <CardView
      {...props}
      layer={null}
      at={null}
      target={false}
      flash={false}
      count={null}
      open={false}
      downSince={null}
      pullRequest={null}
      preview={false}
      peek={false}
      now={0}
      onClose={() => undefined}
    />
  );
}

/** K-521: a closed stack of the owner, as one card that lists its cards. A click opens it. */
export function StackCard(props: {
  id: string;
  layer: number | null;
  name: string;
  members: ReadonlyArray<Resource>;
  state: State;
  at: Point;
  selected: boolean;
  dragging: boolean;
  target: boolean;
  flash: boolean;
  /** K-537: the lens of another card is on, and no card of this stack has a line. */
  dim?: boolean;
  onMenu: (anchor: Rect) => void;
}) {
  const holding = circlesHolding(props.state, props.id);
  return (
    <div
      class={`card stack-card${props.selected ? " sel" : ""}${props.dragging ? " dragging" : ""}${props.target ? " stack-target" : ""}${props.flash ? " flash" : ""}${props.dim ? " dim" : ""}`}
      data-card={props.id}
      style={{
        left: px(props.at.x),
        top: px(props.at.y),
        ...(props.layer === null ? {} : { "--layer": props.layer }),
      }}
    >
      <span
        class="sticker count"
        data-tip={`${props.members.length} cards in this stack. A click opens it as a column.`}
      >
        {props.members.length} ▸
      </span>
      {props.name ? <div class="name">{props.name}</div> : null}
      <ul>
        {props.members.slice(0, 6).map((member) => (
          <li key={member.id}>
            <ItemIcon resource={member} />
            {member.name}
          </li>
        ))}
        {props.members.length > 6 ? <li class="muted">and {props.members.length - 6} more</li> : null}
      </ul>
      <div class="foot">
        <MoreButton name={props.name} onOpen={props.onMenu} />
      </div>
      <CircleChips circles={holding} />
    </div>
  );
}
