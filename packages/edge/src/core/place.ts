import type { Edit } from "./changes.ts";
import { type Circle, type Point, type State, circlesHolding, edgeDistance, insideCircle } from "./model.ts";

/** A card on the map, around its place: the width and the top margin come from `.card` in styles.css. */
export const CARD_BOX = { half: 95, above: 36, below: 50 } as const;

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A circle head sits this far above the top edge of its square and is about this tall (`.circle .head`). */
export const HEAD = { above: 20, below: 16 } as const;

/**
 * The width of a circle head, estimated from its name: about 11px for each letter at 1rem, and 130px for the
 * level sticker, the "⋯" button and the padding. Known limit: very wide or narrow letters miss by a few
 * pixels. Revisit when heads get more stickers or a different font size.
 */
export const headWidth = (circle: Circle) =>
  11 * circle.name.length + 130 + (circle.needsPasskey ? 24 : 0) + (circle.match === "all" ? 24 : 0);

export const cardBox = (at: Point): Box => ({
  left: at.x - CARD_BOX.half,
  top: at.y - CARD_BOX.above,
  right: at.x + CARD_BOX.half,
  bottom: at.y + CARD_BOX.below,
});

/**
 * The head of a circle `shift` along its top edge (K-506, K-536): 0 is the middle, -1 the left corner and 1 the
 * right corner, in map units.
 */
export const headBox = (circle: Circle, shift: number): Box => {
  const x = circle.x + circle.r * shift;
  const y = circle.y - circle.r;
  const half = headWidth(circle) / 2;
  return { left: x - half, top: y - HEAD.above, right: x + half, bottom: y + HEAD.below };
};

export const boxesOverlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The spots that a head tries along its top edge, in this order: the middle, then further to each side. */
const HEAD_SHIFTS = [0, -0.5, 0.5, -0.9, 0.9];

/**
 * Where a circle head sits (K-506): the first spot along the top edge whose head covers no card. When every
 * spot covers a card, the head stays in the middle; heads draw above cards, so the head stays readable.
 */
export function headShift(circle: Circle, cards: ReadonlyArray<Box>): number {
  return HEAD_SHIFTS.find((shift) => !cards.some((card) => boxesOverlap(headBox(circle, shift), card))) ?? 0;
}

/** A circle with its head at every spot that the head can slide to (`headShift`). */
export const circleBox = (circle: Circle): Box =>
  union([
    {
      left: circle.x - circle.r,
      top: circle.y - circle.r,
      right: circle.x + circle.r,
      bottom: circle.y + circle.r,
    },
    ...HEAD_SHIFTS.map((shift) => headBox(circle, shift)),
  ]);

export const union = (boxes: ReadonlyArray<Box>): Box => ({
  left: Math.min(...boxes.map((box) => box.left)),
  top: Math.min(...boxes.map((box) => box.top)),
  right: Math.max(...boxes.map((box) => box.right)),
  bottom: Math.max(...boxes.map((box) => box.bottom)),
});

/** The key prefix of a stack that the owner made, as opposed to a stack by group (K-508). */
export const USER_STACK = "stack:";

/** Cards with one group stack when they share the same circles (K-508). */
export function stacksOf(state: State): Map<string, Array<string>> {
  const stacks = new Map<string, Array<string>>();
  // K-521: the owner's stacks come first; their cards leave the stacks by group.
  const owned = new Set<string>();
  for (const stack of state.stacks.values()) {
    const placed = stack.members.filter((id) => state.places.has(id));
    for (const id of placed) owned.add(id);
    if (placed.length > 1) stacks.set(`${USER_STACK}${stack.id}`, placed);
  }
  for (const resource of state.resources.values()) {
    if (!resource.group || owned.has(resource.id) || !state.places.has(resource.id)) continue;
    const circles = circlesHolding(state, resource.id)
      .map((circle) => circle.id)
      .sort()
      .join(",");
    const key = `${resource.group}|${circles}`;
    stacks.set(key, [...(stacks.get(key) ?? []), resource.id]);
  }
  for (const [key, ids] of stacks) if (ids.length < 2) stacks.delete(key);
  return stacks;
}

/** Two cards whose boxes overlap on the map; a card keeps this clear of the spots in `taken`. */
const cardsOverlap = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) < 2 * CARD_BOX.half && Math.abs(a.y - b.y) < CARD_BOX.above + CARD_BOX.below;

/** Distance a card centre keeps from every circle edge, so a small move does not change its shares. */
const EDGE_MARGIN = 24;

export const fits = (point: Point, circles: Iterable<Circle>, wanted: ReadonlySet<string>) => {
  for (const circle of circles) {
    if (Math.abs(edgeDistance(point, circle) - circle.r) < EDGE_MARGIN) return false;
    if (insideCircle(point, circle) !== wanted.has(circle.id)) return false;
  }
  return true;
};

/**
 * Finds the point nearest to `from` that sits inside exactly the wanted circles (K-511, K-209), and, when
 * `taken` names card spots, where the card box overlaps none of them. Returns null when no candidate fits.
 * It tries a fixed set of candidates, so it can miss a very thin overlap. Revisit if users report that.
 */
export function placeInside(
  state: State,
  from: Point,
  wanted: ReadonlySet<string>,
  taken: ReadonlyArray<Point> = [],
): Point | null {
  const circles = [...state.circles.values()];
  const candidates: Array<Point> = [from];
  const anchors = wanted.size > 0 ? circles.filter((circle) => wanted.has(circle.id)) : circles;
  for (const anchor of anchors) {
    for (const fraction of [0, 0.25, 0.5, 0.7, 0.85]) {
      for (let step = 0; step < 24; step++) {
        // Spots on a smaller square inside the anchor (K-536), so the corners count too.
        const angle = (step / 24) * 2 * Math.PI;
        const onSquare =
          (anchor.r * fraction) / Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
        candidates.push({
          x: anchor.x + Math.cos(angle) * onSquare,
          y: anchor.y + Math.sin(angle) * onSquare,
        });
      }
    }
  }
  if (wanted.size === 0 || taken.length > 0) {
    // Outside every circle, or clear of other cards: walk outward from the card on rings.
    for (let ring = 1; ring <= 40; ring++) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * 2 * Math.PI;
        candidates.push({ x: from.x + Math.cos(angle) * ring * 60, y: from.y + Math.sin(angle) * ring * 60 });
      }
    }
  }
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (!fits(candidate, circles, wanted) || taken.some((spot) => cardsOverlap(candidate, spot))) continue;
    const distance = Math.hypot(candidate.x - from.x, candidate.y - from.y);
    if (distance < bestDistance) {
      best = { x: Math.round(candidate.x), y: Math.round(candidate.y) };
      bestDistance = distance;
    }
  }
  return best;
}

/** K-529: how far past a card's centre the new circle reaches, so the whole card shows inside it. */
const CARD_REACH = EDGE_MARGIN + 100;
/** K-529: the new circle is at most this many times as wide as the widest circle on the map. */
export const NEW_CIRCLE_CAP = 3;

/** The smallest square around the points (K-536): the middle of their bounding box, to its wider side. */
export function enclosingSquare(points: ReadonlyArray<Point>): { x: number; y: number; r: number } {
  if (points.length === 0) throw new Error("enclosingSquare needs at least one point.");
  const box = union(
    points.map((point) => ({ left: point.x, top: point.y, right: point.x, bottom: point.y })),
  );
  return {
    x: (box.left + box.right) / 2,
    y: (box.top + box.bottom) / 2,
    r: Math.max(widthOf(box), heightOf(box)) / 2,
  };
}

const widthOf = (box: Box) => box.right - box.left;
const heightOf = (box: Box) => box.bottom - box.top;

/**
 * K-529: one new circle that holds the selected cards (with their stacks, K-521), with each card still in exactly
 * the circles it is in now. Unselected cards that fall inside move out to their nearest spot in exactly their own
 * circles. Of two plans (the cards where they are, or each pulled towards the middle of the selection) the one
 * that moves fewer cards wins, then the smaller circle. Refuses when no plan works, and changes nothing.
 */
export function circleForCards(
  state: State,
  selected: Iterable<string>,
  template: Omit<Circle, "x" | "y" | "r">,
):
  | { readonly edits: Array<Edit>; readonly moved: number; readonly cards: number }
  | { readonly refused: string } {
  const ids = new Set(selected);
  for (const stack of state.stacks.values())
    if (stack.members.some((id) => ids.has(id))) for (const id of stack.members) ids.add(id);
  const missing = [...ids].find((id) => !state.places.has(id));
  if (missing) return { refused: `Place ${state.resources.get(missing)?.name ?? missing} on the map first.` };
  const circles = [...state.circles.values()];
  const cap = NEW_CIRCLE_CAP * Math.max(0, ...circles.map((circle) => circle.r));
  const holding = (id: string) =>
    new Set(
      circles
        .filter((circle) => insideCircle(state.places.get(id) as Point, circle))
        .map((circle) => circle.id),
    );
  const nameOf = (id: string) => state.resources.get(id)?.name ?? id;
  /** A stack sits on one spot, so it moves as one unit (K-521). */
  const unitsOf = (cards: Iterable<string>) => {
    const units = new Map<string, Array<string>>();
    for (const id of cards) {
      const stack = [...state.stacks.values()].find((each) => each.members.includes(id));
      const key = stack ? `stack:${stack.id}` : id;
      units.set(key, [...(units.get(key) ?? []), id]);
    }
    return [...units.values()];
  };
  /** Where every card sits in a plan; a moving unit keeps clear of all the others, so no two cards overlap. */
  const others = (spots: ReadonlyMap<string, Point>, unit: ReadonlyArray<string>) =>
    [...spots].filter(([id]) => !unit.includes(id)).map(([, spot]) => spot);

  type Plan = { readonly circle: Circle; readonly moves: Map<string, Point> } | { readonly refused: string };
  const plan = (moves: ReadonlyMap<string, Point>): Plan => {
    const spots = new Map([...state.places, ...moves]);
    const around = enclosingSquare([...ids].map((id) => spots.get(id) as Point));
    const r = Math.ceil(around.r + CARD_REACH);
    if (circles.length > 0 && r > cap)
      return {
        refused: `The new circle would be wider than ${NEW_CIRCLE_CAP} times the widest circle. Select cards that sit closer together.`,
      };
    const circle: Circle = { ...template, x: Math.round(around.x), y: Math.round(around.y), r };
    const withCircle: State = { ...state, circles: new Map(state.circles).set(circle.id, circle) };
    const all = new Map(moves);
    const inside = [...state.places]
      .filter(([id, place]) => !ids.has(id) && insideCircle(place, circle))
      .map(([id]) => id);
    for (const unit of unitsOf(inside)) {
      const first = unit[0] as string;
      const to = placeInside(
        withCircle,
        state.places.get(first) as Point,
        holding(first),
        others(spots, unit),
      );
      if (!to)
        return {
          refused: `${nameOf(first)} cannot leave the new circle without changing its circles. Move it, then try again.`,
        };
      for (const id of unit) {
        spots.set(id, to);
        all.set(id, to);
      }
    }
    return { circle, moves: all };
  };

  const asIs = plan(new Map());
  const middle = enclosingSquare([...ids].map((id) => state.places.get(id) as Point));
  const distance = (point: Point) => Math.hypot(point.x - middle.x, point.y - middle.y);
  // The units nearest to the middle choose first; each keeps clear of every other card where it sits now.
  const ordered = unitsOf(ids).sort(
    (a, b) =>
      distance(state.places.get(a[0] as string) as Point) -
      distance(state.places.get(b[0] as string) as Point),
  );
  const spots = new Map(state.places);
  const pulled = new Map<string, Point>();
  for (const unit of ordered) {
    const first = unit[0] as string;
    const place = state.places.get(first) as Point;
    const to = placeInside(state, middle, holding(first), others(spots, unit));
    // A card that sits as close to the middle as it could get stays where it is, so the count of moves is honest.
    if (!to || distance(to) >= distance(place)) continue;
    for (const id of unit) {
      spots.set(id, to);
      pulled.set(id, to);
    }
  }
  const together = pulled.size > 0 ? plan(pulled) : asIs;
  const options = [asIs, together].flatMap((option) => ("refused" in option ? [] : [option]));
  const best = options.sort((a, b) => a.moves.size - b.moves.size || a.circle.r - b.circle.r)[0];
  if (!best) {
    // Both plans refused; the plan with the cards where they are names the reason the owner can act on.
    const reason = "refused" in asIs ? asIs : "refused" in together ? together : null;
    if (!reason) throw new Error("circleForCards: no plan and no reason.");
    return reason;
  }
  return {
    edits: [
      { _tag: "circle", id: best.circle.id, after: best.circle },
      ...[...best.moves].map(([id, after]): Edit => ({ _tag: "place", id, after })),
    ],
    moved: best.moves.size,
    cards: ids.size,
  };
}

/** The inside test while circles were round, before K-536; only `squareMoves` reads it. */
const insideRound = (point: Point, circle: Circle) =>
  Math.hypot(point.x - circle.x, point.y - circle.y) < circle.r;

/**
 * K-536: when circles became squares, a card in the corner of a square, outside the round circle, would gain that
 * circle and its level. These moves keep every card in exactly the circles that held it while they were round:
 * each card or stack (K-521) whose circles change goes to its nearest spot inside exactly its round circles, clear
 * of the other cards, or, when no such spot is clear, on top of one. `stuck` names the cards with no spot at all;
 * they stay where they are.
 */
export function squareMoves(state: State): {
  readonly moves: Array<{ readonly id: string; readonly before: Point; readonly after: Point }>;
  readonly stuck: Array<string>;
} {
  const circles = [...state.circles.values()];
  const units: Array<Array<string>> = [];
  const stacked = new Set<string>();
  for (const stack of state.stacks.values()) {
    const placed = stack.members.filter((id) => state.places.has(id));
    for (const id of placed) stacked.add(id);
    if (placed.length > 0) units.push(placed);
  }
  for (const id of state.places.keys()) if (!stacked.has(id)) units.push([id]);
  const holding = (point: Point, inside: (point: Point, circle: Circle) => boolean) =>
    new Set(circles.filter((circle) => inside(point, circle)).map((circle) => circle.id));
  const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
    a.size === b.size && [...a].every((id) => b.has(id));
  const spots = new Map(state.places);
  const moves: Array<{ readonly id: string; readonly before: Point; readonly after: Point }> = [];
  const stuck: Array<string> = [];
  for (const unit of units) {
    const changed = unit.filter((id) => {
      const place = state.places.get(id) as Point;
      return !same(holding(place, insideRound), holding(place, insideCircle));
    });
    const first = changed[0];
    if (first === undefined) continue;
    const from = state.places.get(first) as Point;
    const wanted = holding(from, insideRound);
    const others = [...spots].filter(([id]) => !unit.includes(id)).map(([, spot]) => spot);
    const to = placeInside(state, from, wanted, others) ?? placeInside(state, from, wanted);
    if (!to) {
      stuck.push(...changed);
      continue;
    }
    for (const id of unit) {
      spots.set(id, to);
      moves.push({ id, before: state.places.get(id) as Point, after: to });
    }
  }
  return { moves, stuck };
}
