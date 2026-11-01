import { circlePolicies } from "../core/access.ts";
import { type Edit, type ShareDiff, applyChanges, resolveEdits, shareDiff } from "../core/changes.ts";
import {
  type Circle,
  type Directory,
  type Point,
  type Resource,
  type State,
  circlesHolding,
  insideCircle,
  levelName,
  stackTitle,
} from "../core/model.ts";
import { placeInside } from "../core/place.ts";
import { leaveStacks, refusal, stackOntoEdits } from "./actions.ts";
import { joinPlan, machineMember } from "./members.ts";

/**
 * Where a drag of cards ends: on a card (K-522), on the title of a circle (K-539), over the tray (K-509), on the map,
 * or away: over the side panel or the toolbar, where a card would land out of sight, so nothing changes.
 */
export type DropTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "title"; readonly id: string }
  | { readonly _tag: "tray" }
  | { readonly _tag: "map" }
  | { readonly _tag: "away" };

/**
 * The edits of a drop with the toast text, why kitshn refuses it, or null when nothing changes. `note` follows the
 * share changes on the toast; `rightsIn` and `ask` come from `joinPlan`.
 */
export type DropPlan =
  | {
      readonly edits: Array<Edit>;
      readonly done: string | undefined;
      readonly note?: string;
      readonly rightsIn?: string | null;
      readonly ask?: string | null;
    }
  | { readonly refused: string }
  | null;

const machinesOf = (state: State, ids: ReadonlyArray<string>) =>
  ids.filter((id) => state.resources.get(id)?.kind === "machine");

/** One line of the label beside a drag. */
export interface DropLine {
  readonly text: string;
  readonly minus?: true;
}

const MAX_LINES = 6;

/** What a share in a circle that ended, or that Access has no policy for, really gives; null for any other circle. */
export function givesNoOne(
  resource: Resource,
  circle: Circle,
  directory: Directory,
  now = Date.now(),
): string | null {
  if (circle.endsAt !== null && circle.endsAt <= now)
    return `${circle.name} has ended: it gives no one ${resource.name}`;
  return circlePolicies(circle, directory).size === 0
    ? `${circle.name} lets no one in, so it gives no one ${resource.name}`
    : null;
}

/**
 * What one share change means, in the words of the card's kind (K-205). A circle that ended, or that Access has no
 * policy for, holds the card and lets no one in, so it never says "can".
 */
export function shareLines(
  diffs: ReadonlyArray<ShareDiff>,
  directory: Directory,
  now = Date.now(),
): ReadonlyArray<DropLine> {
  const lines = diffs.slice(0, MAX_LINES).map(({ resource, circle, to }): DropLine => {
    if (to === null)
      return { text: `\u2212 ${circle.name} can no longer open ${resource.name}`, minus: true };
    const nobody = givesNoOne(resource, circle, directory, now);
    if (nobody) return { text: nobody };
    return { text: `+ ${circle.name} can ${levelName(resource, to)} ${resource.name}` };
  });
  return diffs.length > MAX_LINES ? [...lines, { text: `and ${diffs.length - MAX_LINES} more` }] : lines;
}

/**
 * K-539: the label beside a drag of cards, from the plan that the drop runs, so a hover never says what the drop does
 * not do. `joins` marks a title that takes a machine now.
 */
export function dropHover(
  state: State,
  moves: ReadonlyMap<string, Point>,
  target: DropTarget,
  now = Date.now(),
): { readonly lines: ReadonlyArray<DropLine>; readonly joins: boolean } {
  const quiet = { joins: false };
  if (target._tag === "away") return { lines: [{ text: "Not here: nothing changes" }], ...quiet };
  const plan = dropPlan(state, moves, target, "hover");
  if (plan && "refused" in plan) return { lines: [{ text: plan.refused, minus: true }], ...quiet };
  const ids = [...moves.keys()];
  if (target._tag === "tray")
    return {
      lines: [
        plan
          ? { text: "To the tray: out of every circle, private", minus: true }
          : { text: "Back to the tray: nothing changes" },
      ],
      ...quiet,
    };
  if (!plan) {
    const circle = target._tag === "title" ? state.circles.get(target.id) : undefined;
    const members = circle ? machinesOf(state, ids).filter((id) => machineMember(circle, id)) : [];
    if (!circle || members.length === 0) return { lines: [], ...quiet };
    const name = members.map((id) => state.resources.get(id)?.name ?? id).join(", ");
    return {
      lines: [
        { text: `${name} ${members.length === 1 ? "is a member" : "are members"} of ${circle.name} already` },
      ],
      ...quiet,
    };
  }
  if (target._tag === "card") {
    const stack = [...state.stacks.values()].find((each) => each.members.includes(target.id));
    const name = stack ? stackTitle(state, stack) : (state.resources.get(target.id)?.name ?? "this card");
    return { lines: [{ text: `Stack with ${name}` }], ...quiet };
  }
  const shares = shareLines(
    shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))),
    state,
    now,
  );
  const circle = target._tag === "title" ? state.circles.get(target.id) : undefined;
  const joining = circle ? machinesOf(state, ids).filter((id) => !machineMember(circle, id)) : [];
  if (!circle || joining.length === 0) return { lines: shares, ...quiet };
  const name = joining.map((id) => state.resources.get(id)?.name ?? id).join(", ");
  return {
    lines: [{ text: `+ ${name} ${joining.length === 1 ? "joins" : "join"} ${circle.name}` }, ...shares],
    joins: true,
  };
}

/**
 * K-509: several cards from the tray fan out from the pointer, each in exactly the circles at the pointer, so none
 * falls out of a circle or into a neighbour. A card from the map keeps its own offset, as a group move does.
 */
export function landingPoints(state: State, moves: ReadonlyMap<string, Point>): ReadonlyMap<string, Point> {
  const fresh = [...moves.keys()].filter((id) => !state.places.has(id));
  const anchor = moves.get(fresh[0] ?? "");
  if (!anchor || fresh.length < 2) return moves;
  const wanted = new Set(
    [...state.circles.values()].filter((circle) => insideCircle(anchor, circle)).map((circle) => circle.id),
  );
  return new Map(
    [...moves].map(([id, point]): [string, Point] => [
      id,
      fresh.includes(id) ? (placeInside(state, point, wanted) ?? anchor) : point,
    ]),
  );
}

/**
 * K-509, K-522: what a drop of cards does. Cards from the map and from the tray take the same path: onto a card
 * they stack with it, over the tray they leave every circle, elsewhere each lands at its point in `moves`.
 */
export function dropPlan(
  state: State,
  moves: ReadonlyMap<string, Point>,
  target: DropTarget,
  newStackId: string,
): DropPlan {
  const ids = [...moves.keys()].filter((id) => state.resources.has(id));
  const names = (list: ReadonlyArray<string>) =>
    list.flatMap((id) => state.resources.get(id)?.name ?? []).join(", ");
  if (target._tag === "away") return null;
  if (target._tag === "title") return titlePlan(state, moves, ids, target.id, newStackId);
  if (target._tag === "card")
    return withShareNote(state, ids, stackOntoEdits(state, ids, target.id, newStackId));
  if (target._tag === "tray") {
    const placed = ids.filter((id) => state.places.has(id));
    if (placed.length === 0) return null;
    const edits: Array<Edit> = [
      ...placed.map((id): Edit => ({ _tag: "place", id, after: null })),
      ...leaveStacks(state, placed),
    ];
    return checked(state, edits, `Moved ${names(placed)} to the tray.`);
  }
  const landing = landingPoints(state, moves);
  const edits = ids.flatMap((id): Array<Edit> => {
    const after = landing.get(id);
    const before = state.places.get(id);
    return after && (!before || before.x !== after.x || before.y !== after.y)
      ? [{ _tag: "place", id, after }]
      : [];
  });
  if (edits.length === 0) return null;
  // A move on the map shows its share changes; a card that comes from the tray says that it is on the map now.
  const fresh = ids.filter((id) => !state.places.has(id));
  return withShareNote(
    state,
    ids,
    checked(state, edits, fresh.length > 0 ? `Placed ${names(fresh)} on the map.` : undefined),
  );
}

/**
 * K-539: a machine on a circle's title joins it and goes back to where the drag started, because control is not a
 * place. Other cards of the same drag land where they were dropped, as in the circle's body.
 */
function titlePlan(
  state: State,
  moves: ReadonlyMap<string, Point>,
  ids: ReadonlyArray<string>,
  circleId: string,
  newStackId: string,
): DropPlan {
  const circle = state.circles.get(circleId);
  const machines = machinesOf(state, ids);
  // A stack moves as one, so a card that shares a stack with one of these machines stays with it.
  const stuck = [...state.stacks.values()]
    .filter((stack) => stack.members.some((id) => machines.includes(id)))
    .flatMap((stack) => stack.members);
  const others = new Map([...moves].filter(([id]) => !machines.includes(id) && !stuck.includes(id)));
  const shared = others.size > 0 ? dropPlan(state, others, { _tag: "map" }, newStackId) : null;
  // The drop is one revision, so a refusal of the other cards refuses the join too, and it says why.
  if (shared && "refused" in shared) return shared;
  const joining = circle ? machines.filter((id) => !machineMember(circle, id)) : [];
  if (!circle || joining.length === 0) return shared;
  const join = joinPlan(state, joining, circle);
  if ("refused" in join) return join;
  const edits = [...(shared?.edits ?? []), ...join.edits];
  const refused = refusal(state, edits);
  // `note` keeps the join in the toast when the other cards' share changes lead it.
  return refused
    ? { refused }
    : { edits, done: join.done, note: join.done, rightsIn: join.rightsIn, ask: join.ask };
}

/** K-539: a machine card in the body of a circle is shared with it, and the toast says that it is no member. */
function withShareNote(state: State, ids: ReadonlyArray<string>, plan: DropPlan): DropPlan {
  if (!plan || "refused" in plan) return plan;
  const next = applyChanges(state, resolveEdits(state, plan.edits));
  const entered = machinesOf(state, ids).some((id) => {
    const before = circlesHolding(state, id);
    return circlesHolding(next, id).some(
      (circle) => !before.some((each) => each.id === circle.id) && !machineMember(circle, id),
    );
  });
  return entered ? { ...plan, note: "Shared, not a member: its title takes members." } : plan;
}

const checked = (state: State, edits: Array<Edit>, done: string | undefined): DropPlan => {
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits, done };
};
