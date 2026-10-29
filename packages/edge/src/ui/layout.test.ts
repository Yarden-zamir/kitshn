import { describe, expect, it } from "vitest";
import type { Circle } from "../core/model.ts";
import { type Box, cardBox, circleBox, headShift, headBox } from "../core/place.ts";
import {
  cardLayer,
  stackOffsets,
  toastPlace,
  FOCUS_LAYER,
  HEAD_LAYER,
  fitMap,
  fitView,
  MAP_MIN_WIDTH,
  keyWidth,
  mapBox,
  openArea,
  panInto,
  pinchView,
  ZOOM,
  shownWidths,
  storedWidth,
  steadyBox,
  type DrawnCard,
} from "./layout.ts";

const circle = (x: number, y: number, r: number, name = "Agents"): Circle => ({
  id: name,
  name,
  color: "#6C5CE7",
  level: "view",
  members: [],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y,
  r,
});

const inside = (box: Box, area: Box, view: { x: number; y: number; s: number }) =>
  box.left * view.s + view.x >= area.left - 0.001 &&
  box.right * view.s + view.x <= area.right + 0.001 &&
  box.top * view.s + view.y >= area.top - 0.001 &&
  box.bottom * view.s + view.y <= area.bottom + 0.001;

describe("fit and pan leave an open panel free", () => {
  const screen = { width: 1440, height: 900, top: 70, left: 0, narrow: false };

  it("fits every circle head and card left of the panel", () => {
    const circles = [circle(0, 0, 200), circle(900, 0, 200, "Her")];
    const box = mapBox(circles, [{ x: 1100, y: 100 }]);
    if (!box) throw new Error("A map with circles has a box.");
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = fitView(box, area, 0.15, 2);
    expect(area.right).toBeLessThan(960);
    for (const item of circles) expect(inside(headBox(item, 0), area, view)).toBe(true);
    expect(inside(cardBox({ x: 1100, y: 100 }), area, view)).toBe(true);
  });

  it("fits a map wider than the free area whole: every head and card is left of the panel and right of the tray", () => {
    // The demo map on a 1512×982 laptop, with the tray, a two-row toolbar and the panel open.
    const circles = [
      circle(-200, 0, 520, "Owner"),
      circle(1150, -150, 380, "Everyone"),
      circle(500, 600, 400, "Her"),
      circle(-900, 900, 450, "Qlik"),
      circle(1250, 900, 300, "Agents"),
    ];
    const places = [
      { x: -500, y: -300 },
      { x: 0, y: -350 },
      { x: 1100, y: -100 },
      { x: 300, y: 100 },
    ];
    const area = openArea({ width: 1512, height: 982, top: 104, left: 220, panelLeft: 1032, narrow: false });
    const view = fitMap(circles, places, area);
    if (!view) throw new Error("A map with circles fits.");
    expect(view.s).toBeLessThan(0.85);
    for (const item of circles) expect(inside(circleBox(item), area, view)).toBe(true);
    for (const place of places) expect(inside(cardBox(place), area, view)).toBe(true);
    expect(area.left).toBeGreaterThan(220);
    expect(area.right).toBeLessThan(1032);
  });

  it("keeps a given minimum zoom, so a big map is centred in the area instead of shown whole", () => {
    const box = mapBox([circle(0, 0, 3000)], []);
    if (!box) throw new Error("A map with circles has a box.");
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = fitView(box, area, 0.85, 2);
    expect(view.s).toBe(0.85);
    expect(((box.left + box.right) / 2) * view.s + view.x).toBeCloseTo((area.left + area.right) / 2);
  });

  it("uses the upper half on a narrow screen, where the panel is a bottom sheet", () => {
    const area = openArea({ ...screen, width: 400, height: 800, narrow: true, panelLeft: 12 });
    expect(area.right).toBe(380);
    expect(area.bottom).toBe(380);
  });

  it("does not move a box that is in the area already, and centres one that is under the panel", () => {
    const area = openArea({ ...screen, panelLeft: 960 });
    const view = { x: 0, y: 0, s: 1 };
    const free = cardBox({ x: 400, y: 400 });
    expect(panInto(free, area, view)).toBe(view);
    const under = cardBox({ x: 1200, y: 400 });
    const moved = panInto(under, area, view);
    expect(moved.s).toBe(1);
    expect(inside(under, area, moved)).toBe(true);
  });
});

describe("a circle head slides along its top edge off the cards (K-506, K-536)", () => {
  const her = circle(0, 0, 220, "Her");

  it("stays in the middle when no card is there", () => {
    expect(headShift(her, [cardBox({ x: 0, y: 100 })])).toBe(0);
  });

  it("moves to the first free spot beside a card that sits on the middle of the top edge", () => {
    const card = cardBox({ x: 0, y: -220 });
    const shift = headShift(her, [card]);
    expect(shift).not.toBe(0);
    const head = headBox(her, shift);
    // The head stays on the top edge; it only slides sideways.
    expect(head.bottom - head.top).toBe(36);
    expect(head.top).toBe(-240);
    expect(head.right <= card.left || head.left >= card.right || head.bottom <= card.top).toBe(true);
  });

  it("stays in the middle when every spot covers a card, where it draws above them", () => {
    const cards = [-300, -200, -100, 0, 100, 200, 300].flatMap((x) =>
      [-240, -200, -160, -120].map((y) => cardBox({ x, y })),
    );
    expect(headShift(her, cards)).toBe(0);
  });
});

describe("resizable widths (K-525)", () => {
  const limits = { panel: { min: 324, max: 828, initial: 468 }, tray: { min: 160, max: 420, initial: 210 } };
  const mapWidth = (screen: number, widths: { panel: number; tray: number }) =>
    screen - 12 - widths.panel - (10 + widths.tray);

  it("keeps the wanted widths when the screen has room", () => {
    expect(shownWidths(1512, { panel: 500, tray: 300 }, limits)).toEqual({ panel: 500, tray: 300 });
  });
  it("never lets the panel and the shelf cover the map's minimum width", () => {
    const widths = shownWidths(1200, { panel: 828, tray: 420 }, limits);
    expect(mapWidth(1200, widths)).toBeGreaterThanOrEqual(MAP_MIN_WIDTH);
    expect(widths.panel + widths.tray).toBeLessThan(828 + 420);
    // The panel keeps room for the shelf's minimum.
    expect(widths.tray).toBeGreaterThanOrEqual(160);
  });
  it("gives a hidden element no room, so the other can grow", () => {
    expect(shownWidths(1200, { panel: 828, tray: null }, limits)).toEqual({ panel: 818, tray: 0 });
    expect(shownWidths(1200, { panel: null, tray: 420 }, limits)).toEqual({ panel: 0, tray: 420 });
  });
  it("shrinks both below their minimums on a cramped screen, never below the floor", () => {
    const widths = shownWidths(800, { panel: 600, tray: 400 }, limits);
    expect(widths.panel).toBeGreaterThanOrEqual(120);
    expect(widths.tray).toBeGreaterThanOrEqual(120);
    expect(widths.panel).toBeLessThan(324);
  });
  it("falls back to the initial width for a missing, empty or broken stored value", () => {
    expect(storedWidth(null, limits.tray)).toBe(210);
    expect(storedWidth("", limits.tray)).toBe(210);
    expect(storedWidth("wide", limits.tray)).toBe(210);
    expect(storedWidth("9999", limits.tray)).toBe(420);
    expect(storedWidth("300", limits.tray)).toBe(300);
  });
  it("moves the edge with the arrow keys towards the side the element grows to", () => {
    expect(keyWidth("ArrowLeft", 300, limits.tray, "left")).toBe(324);
    expect(keyWidth("ArrowLeft", 300, limits.tray, "right")).toBe(276);
    expect(keyWidth("Home", 300, limits.tray, "left")).toBe(160);
    expect(keyWidth("End", 300, limits.tray, "right")).toBe(420);
    expect(keyWidth("a", 300, limits.tray, "left")).toBeNull();
  });
});

describe("pinch (K-516)", () => {
  const view = { x: 100, y: 50, s: 1 };
  const at = (view: { x: number; y: number; s: number }, point: { x: number; y: number }) => ({
    x: (point.x - view.x) / view.s,
    y: (point.y - view.y) / view.s,
  });
  it("zooms by the spread of the fingers and keeps the map point between them", () => {
    const from = { a: { x: 150, y: 200 }, b: { x: 250, y: 200 } };
    const to = { a: { x: 100, y: 200 }, b: { x: 300, y: 200 } };
    const next = pinchView(view, from, to);
    expect(next.s).toBe(2);
    expect(at(next, { x: 200, y: 200 })).toEqual(at(view, { x: 200, y: 200 }));
  });
  it("pans when both fingers move together", () => {
    const from = { a: { x: 150, y: 200 }, b: { x: 250, y: 200 } };
    const to = { a: { x: 150, y: 140 }, b: { x: 250, y: 140 } };
    expect(pinchView(view, from, to)).toEqual({ x: 100, y: -10, s: 1 });
  });
  it("stays inside the zoom range of the wheel", () => {
    const from = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    expect(pinchView(view, from, { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } }).s).toBe(ZOOM.max);
    expect(pinchView(view, from, { a: { x: 0, y: 0 }, b: { x: 0.1, y: 0 } }).s).toBe(ZOOM.min);
  });
});

describe("cardLayer", () => {
  it("puts a dragged card on top, then focused, selected and framed cards, all under the circle heads (K-506)", () => {
    const card = (flags: Partial<Parameters<typeof cardLayer>[0]>) =>
      cardLayer({ dragging: false, selected: false, framed: false, ...flags });
    const layers = [
      card({ dragging: true, selected: true, framed: true }),
      FOCUS_LAYER,
      card({ selected: true, framed: true }),
      card({ framed: true }),
    ];
    expect(layers).toEqual([6, 5, 4, 3]);
    expect(card({})).toBeNull();
    expect(Math.max(...layers.map(Number))).toBeLessThan(HEAD_LAYER);
  });
});

describe("toastPlace (K-503)", () => {
  it("keeps the toast in the half of the open map away from the changed card", () => {
    // A wide screen: the toolbar ends at 120, the hint line starts at 940 of 982.
    const wide = { top: 120, bottom: 940 };
    expect(toastPlace(880, wide, 982)).toEqual({ top: 130 });
    expect(toastPlace(150, wide, 982)).toEqual({ bottom: 52 });
    // A phone with its card sheet open from 464: a card just under the toolbar gets the toast above the sheet.
    const phone = { top: 100, bottom: 464 };
    expect(toastPlace(140, phone, 844)).toEqual({ bottom: 390 });
    expect(toastPlace(400, phone, 844)).toEqual({ top: 110 });
  });
});

describe("stackOffsets (K-508, K-521)", () => {
  it("keeps the row step for plain cards and moves the next card below a taller one", () => {
    // Plain cards and cards not measured yet keep the step of 124.
    expect(stackOffsets([90, undefined, 100], 124, 16)).toEqual([0, 124, 248]);
    // A card with a preview frame (260 high) pushes the card below it to 260 + 16.
    expect(stackOffsets([90, 260, 90], 124, 16)).toEqual([0, 124, 400]);
    expect(stackOffsets([], 124, 16)).toEqual([]);
  });
});

describe("steadyBox (K-532)", () => {
  /** An open stack of three page cards of 86 px, as the map draws it, with frames on the cards in `framed`. */
  const column = (framed: ReadonlySet<number>, frame: number): Array<DrawnCard> => {
    const heights = [0, 1, 2].map((index) => 86 + (framed.has(index) ? frame : 0));
    const offsets = stackOffsets(heights, 124, 16);
    return heights.map((height, index) => ({
      left: -95,
      top: -36 + (offsets[index] ?? 0),
      width: 190,
      height,
      frame: framed.has(index) ? frame : 0,
      framable: true,
    }));
  };

  it("gives an open stack the same box whichever cards show a frame now", () => {
    const none = steadyBox(column(new Set(), 0), 150, 124, 16);
    expect(steadyBox(column(new Set([0, 2]), 150), 150, 124, 16)).toEqual(none);
    // A frame with login help is taller; the room of the tallest frame counts for every card.
    expect(steadyBox(column(new Set([1]), 170), 170, 124, 16).bottom).toBeGreaterThan(none.bottom);
  });
});
