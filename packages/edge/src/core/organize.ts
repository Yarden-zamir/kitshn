import { type Edit, applyChanges, describeDiff, resolveEdits, shareDiff } from "./changes.ts";
import {
  type CardKind,
  type Circle,
  type Point,
  RESOURCE_KINDS,
  type ResourceKind,
  type State,
  circlesHolding,
} from "./model.ts";
import {
  type Box,
  HEAD,
  USER_STACK,
  boxesOverlap,
  cardBox,
  circleBox,
  fits,
  headBox,
  headWidth,
  stacksOf,
  union,
} from "./place.ts";

/** K-532: the summary of an Organize revision. Moves never join a revision with this summary (K-1505). */
export const ORGANIZE_SUMMARY = "Organize";

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** K-532: what the map draws now. An entry that is missing gets the size of a plain card or an estimate. */
export interface DrawnSizes {
  /** The drawn box of a card or a stack, around the place of its first card, by the id of that card. */
  readonly units: ReadonlyMap<string, Box>;
  /** The drawn head of a circle (`.circle .head`) at the top of its edge. */
  readonly heads: ReadonlyMap<string, Size>;
  /** The drawn row of member chips of a circle (`.circle .members`). */
  readonly members: ReadonlyMap<string, Size>;
}

export const NO_SIZES: DrawnSizes = { units: new Map(), heads: new Map(), members: new Map() };

/** K-532: `DrawnSizes` as lists, for the organize message. */
export interface DrawnWire {
  readonly units: ReadonlyArray<Box & { readonly id: string }>;
  readonly heads: ReadonlyArray<Size & { readonly id: string }>;
  readonly members: ReadonlyArray<Size & { readonly id: string }>;
}

export const drawnSizes = (wire: DrawnWire): DrawnSizes => ({
  units: new Map(wire.units.map(({ id, ...box }) => [id, box])),
  heads: new Map(wire.heads.map(({ id, ...size }) => [id, size])),
  members: new Map(wire.members.map(({ id, ...size }) => [id, size])),
});

/** K-532: the History summary of an Organize that moved `moved` cards. */
export const organizeSummary = (moved: number) =>
  `${ORGANIZE_SUMMARY}: moved ${moved} ${moved === 1 ? "card" : "cards"}`;

/** The space between two cards, and between a card and a head or a chip row. */
const GAP = 16;
/** The extra columns that a grid may have, so its cards can pass a card that stays. */
const SPARE_COLUMNS = 4;
/** A row where no card fits moves this far down. */
const ROW_STEP = 24;
/** `.circle .members` sits this far below the top of its circle. */
const MEMBERS_TOP = 30;
/** The height of a chip row that the map did not measure. */
const MEMBERS_HEIGHT = 34;
const PLAIN_CARD: Box = cardBox({ x: 0, y: 0 });
const KIND_ORDER: ReadonlyArray<CardKind> = Object.keys(RESOURCE_KINDS) as Array<ResourceKind>;
/** The built-in kinds in the order of `RESOURCE_KINDS`, then the kinds of providers (K-704), by name. */
const kindRank = (kind: CardKind) =>
  KIND_ORDER.includes(kind) ? KIND_ORDER.indexOf(kind) : KIND_ORDER.length;

/** A card or a stack, which moves as one (K-521), and the exact set of circles that holds it. */
interface Unit {
  readonly ids: ReadonlyArray<string>;
  readonly area: ReadonlyArray<string>;
  readonly kind: number;
  readonly kindName: CardKind;
  readonly name: string;
  readonly box: Box;
}

const shift = (box: Box, at: Point): Box => ({
  left: box.left + at.x,
  top: box.top + at.y,
  right: box.right + at.x,
  bottom: box.bottom + at.y,
});
const grow = (box: Box, by: number): Box => ({
  left: box.left - by,
  top: box.top - by,
  right: box.right + by,
  bottom: box.bottom + by,
});
const widthOf = (box: Box) => box.right - box.left;
const heightOf = (box: Box) => box.bottom - box.top;

/** The heads at the top of their edges and the chip rows: no card may cover them (K-506). */
function circleParts(circles: ReadonlyArray<Circle>, sizes: DrawnSizes): Array<Box> {
  return circles.flatMap((circle) => {
    const head = headBox(circle, 0);
    const drawn = sizes.heads.get(circle.id);
    // The wider of the drawn head and the estimate, so `headShift` keeps each head in the middle of its top edge after Organize.
    const half = Math.max(headWidth(circle), drawn?.width ?? 0) / 2;
    const parts: Array<Box> = [
      {
        left: circle.x - half,
        top: head.top,
        right: circle.x + half,
        bottom: Math.max(head.bottom, head.top + (drawn?.height ?? HEAD.above + HEAD.below)),
      },
    ];
    const members = sizes.members.get(circle.id);
    // Without a measure, the chip row takes the full width of its circle.
    const chips =
      members ?? (circle.members.length > 0 ? { width: 2 * circle.r, height: MEMBERS_HEIGHT } : null);
    if (chips && chips.width > 0) {
      const top = circle.y - circle.r + MEMBERS_TOP;
      parts.push({
        left: circle.x - chips.width / 2,
        top,
        right: circle.x + chips.width / 2,
        bottom: top + chips.height,
      });
    }
    return parts;
  });
}

/**
 * The middle of an area of circles: the mean of a fixed lattice of points inside exactly those circles. It
 * depends on the circles alone, so a second Organize finds the same middle.
 */
function areaMiddle(circles: ReadonlyArray<Circle>, area: ReadonlySet<string>): Point | null {
  const smallest = circles.filter((circle) => area.has(circle.id)).sort((a, b) => a.r - b.r)[0];
  if (!smallest) throw new Error("areaMiddle needs an area of circles.");
  const step = Math.max(8, Math.round(smallest.r / 20));
  let count = 0;
  let x = 0;
  let y = 0;
  for (let dx = -smallest.r; dx <= smallest.r; dx += step)
    for (let dy = -smallest.r; dy <= smallest.r; dy += step) {
      const point = { x: smallest.x + dx, y: smallest.y + dy };
      if (!fits(point, circles, area)) continue;
      count++;
      x += point.x;
      y += point.y;
    }
  return count === 0 ? null : { x: Math.round(x / count), y: Math.round(y / count) };
}

/**
 * Rows of `columns` slots from `start`, left to right and top to bottom, in the order of `units`. A slot where a
 * unit does not fit stays empty, and a row where nothing fits moves down. Null when `bottom` comes first.
 */
function grid(
  units: ReadonlyArray<Unit>,
  start: Point,
  columns: number,
  bottom: number,
  fitsAt: (unit: Unit, at: Point) => boolean,
): Map<Unit, Point> | null {
  const column = Math.max(...units.map((unit) => widthOf(unit.box))) + GAP;
  const spots = new Map<Unit, Point>();
  let next = 0;
  let y = start.y;
  while (next < units.length) {
    if (y > bottom) return null;
    let row = 0;
    for (let slot = 0; slot < columns && next < units.length; slot++) {
      const unit = units[next] as Unit;
      const at = { x: start.x + slot * column - unit.box.left, y: y - unit.box.top };
      if (!fitsAt(unit, at)) continue;
      spots.set(unit, at);
      row = Math.max(row, heightOf(unit.box));
      next++;
    }
    y += row > 0 ? row + GAP : ROW_STEP;
  }
  return spots;
}

/**
 * K-532: Organize. Puts the cards and stacks of each area (the exact set of circles that holds them, or no circle)
 * in a grid, by kind and then by name: in the middle of the area for circles, and to the right of all circles for
 * cards in none. Circles do not move. No card covers another card, a circle head or a chip row, by the sizes in
 * `sizes`. Only the cards in `movable` move; the others stay and keep their room. The result depends on the
 * circles, the sizes and the cards alone, so a second Organize moves nothing. Refuses, and moves nothing, when an
 * area has no room or when any share would change.
 */
export function organize(
  state: State,
  sizes: DrawnSizes,
  movable: (id: string) => boolean = () => true,
): { readonly edits: Array<Edit>; readonly moved: number } | { readonly refused: string } {
  const circles = [...state.circles.values()];
  const nameOf = (id: string) => state.resources.get(id)?.name ?? id;
  const areaOf = (id: string) =>
    circlesHolding(state, id)
      .map((circle) => circle.id)
      .sort();
  const stacks = stacksOf(state);
  const inStack = new Set([...stacks.values()].flat());
  const groups = [
    ...stacks.entries(),
    ...[...state.places.keys()].filter((id) => !inStack.has(id)).map((id) => [id, [id]] as const),
  ];

  const units: Array<Unit> = [];
  for (const [key, ids] of groups) {
    const first = ids[0];
    if (first === undefined) throw new Error(`organize: the stack ${key} has no card.`);
    const area = areaOf(first);
    const stackName = key.startsWith(USER_STACK)
      ? state.stacks.get(key.slice(USER_STACK.length))?.name
      : null;
    if (ids.some((id) => areaOf(id).join() !== area.join()))
      return {
        refused: `The stack ${stackName || nameOf(first)} has cards in different circles. Move them together, then organize.`,
      };
    const resource = state.resources.get(first);
    if (!resource) throw new Error(`organize: the placed card ${first} has no resource.`);
    const drawn = sizes.units.get(first);
    units.push({
      ids,
      area,
      kind: kindRank(resource.kind),
      kindName: resource.kind,
      name: stackName || resource.group || resource.name,
      box: drawn ? union([drawn, PLAIN_CARD]) : PLAIN_CARD,
    });
  }
  const placeOf = (unit: Unit) => {
    const place = state.places.get(unit.ids[0] as string);
    if (!place) throw new Error(`organize: ${unit.ids[0]} has no place.`);
    return place;
  };
  const moving = units.filter((unit) => unit.ids.every(movable));
  const taken: Array<Box> = [
    ...circleParts(circles, sizes),
    ...units.filter((unit) => !moving.includes(unit)).map((unit) => shift(unit.box, placeOf(unit))),
  ];

  const areas = new Map<string, Array<Unit>>();
  for (const unit of moving) areas.set(unit.area.join(), [...(areas.get(unit.area.join()) ?? []), unit]);
  // The areas of circles first, in a fixed order; the cards in no circle last, outside all of them.
  const order = [...areas.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "en")));
  const spots = new Map<Unit, Point>();
  for (const key of order) {
    const members = (areas.get(key) ?? []).sort(
      (a, b) =>
        a.kind - b.kind ||
        a.kindName.localeCompare(b.kindName, "en") ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        (a.ids[0] as string).localeCompare(b.ids[0] as string, "en"),
    );
    const wanted = new Set(key === "" ? [] : key.split(","));
    const fitsAt = (unit: Unit, at: Point) => {
      if (!fits(at, circles, wanted)) return false;
      const box = grow(shift(unit.box, at), GAP / 2);
      return !taken.some((other) => boxesOverlap(box, other));
    };
    const tallest = Math.max(...members.map((unit) => heightOf(unit.box))) + GAP;
    const widest = Math.max(...members.map((unit) => widthOf(unit.box))) + GAP;
    const square = Math.ceil(Math.sqrt(members.length));
    let found: Map<Unit, Point> | null = null;
    if (wanted.size === 0) {
      // Cards in no circle line up to the right of every circle, or, on a map without circles, from the top left
      // corner of the cards now, which is where the first card lands, so a second Organize starts there again.
      const around = union(
        circles.length > 0 ? circles.map(circleBox) : members.map((unit) => shift(unit.box, placeOf(unit))),
      );
      const corner =
        circles.length > 0
          ? { x: Math.round(around.right + 2 * GAP), y: Math.round(around.top) }
          : { x: around.left, y: around.top };
      found = grid(members, corner, square, corner.y + members.length * tallest + 100 * ROW_STEP, fitsAt);
    } else {
      const middle = areaMiddle(circles, wanted);
      if (!middle)
        return { refused: `The circles ${namesOf(state, wanted)} have no room inside. Nothing moved.` };
      const own = circles.filter((circle) => wanted.has(circle.id));
      const smallest = Math.min(...own.map((circle) => circle.r));
      // The area lies inside every one of its circles: below the lowest top and above the highest bottom.
      const top = Math.max(...own.map((circle) => circle.y - circle.r));
      const bottom = Math.min(...own.map((circle) => circle.y + circle.r));
      // The square grid first, then wider and narrower ones, never wider than the circle; each starts centred on
      // the middle, then at the top of the area. Up to SPARE_COLUMNS more columns than cards leave slots free, so
      // cards can go around a card that stays.
      const most = members.length + SPARE_COLUMNS;
      const widths = [square];
      for (let step = 1; widths.length < most; step++)
        for (const columns of [square + step, square - step])
          if (columns >= 1 && columns <= most) widths.push(columns);
      for (const columns of widths.filter((columns) => (columns - 1) * widest <= 2 * smallest)) {
        const rows = Math.ceil(members.length / columns);
        const left = Math.round(middle.x - (columns * widest - GAP) / 2);
        found =
          grid(
            members,
            { x: left, y: Math.round(middle.y - (rows * tallest - GAP) / 2) },
            columns,
            bottom,
            fitsAt,
          ) ?? grid(members, { x: left, y: top }, columns, bottom, fitsAt);
        if (found) break;
      }
    }
    if (!found)
      return {
        refused: `${wanted.size === 0 ? "The cards in no circle" : `The cards in ${namesOf(state, wanted)}`} do not fit without overlap. Make the circle bigger or move cards out, then organize. Nothing moved.`,
      };
    for (const [unit, at] of found) {
      spots.set(unit, at);
      taken.push(shift(unit.box, at));
    }
  }

  const edits: Array<Edit> = [];
  for (const [unit, at] of spots)
    for (const id of unit.ids) {
      const place = state.places.get(id);
      if (!place || place.x !== at.x || place.y !== at.y) edits.push({ _tag: "place", id, after: at });
    }
  // K-532: position decides sharing, so Organize checks that no card gains or loses a circle or a level.
  const diffs = shareDiff(state, applyChanges(state, resolveEdits(state, edits)));
  if (diffs.length > 0)
    return {
      refused: `Organize would change shares (${diffs.slice(0, 3).map(describeDiff).join("; ")}${diffs.length > 3 ? `; and ${diffs.length - 3} more` : ""}). Nothing moved.`,
    };
  return { edits, moved: edits.length };
}

const namesOf = (state: State, ids: ReadonlySet<string>) =>
  [...ids].map((id) => state.circles.get(id)?.name ?? id).join(" and ");
