import {
  ADMIN_RESOURCE_ID,
  EFFECTS,
  type Actor,
  type Circle,
  type Directory,
  type Level,
  type Member,
  OWNER_CIRCLE_ID,
  type PauseMode,
  type Point,
  type Resource,
  type ShareSetting,
  type Stack,
  type State,
  type Time,
  circlesHolding,
  credentialKey,
  insideCircle,
  isPerson,
  isPublicCircle,
  levelRank,
  memberActor,
  shareKey,
  shareLevel,
  stackTitle,
} from "./model.ts";
import { circlePolicies } from "./access.ts";
import type { Machine } from "./machine.ts";

/** One edit that a client asks for. `after: null` deletes. */
export type Edit =
  | { readonly _tag: "circle"; readonly id: string; readonly after: Circle | null }
  /** K-1778: an actor and its credentials. Its rights sit on its chips in circles. */
  | { readonly _tag: "actor"; readonly id: string; readonly after: Actor | null }
  | { readonly _tag: "place"; readonly id: string; readonly after: Point | null }
  | {
      readonly _tag: "shareSetting";
      readonly resourceId: string;
      readonly circleId: string;
      readonly after: ShareSetting | null;
    }
  | { readonly _tag: "pause"; readonly after: PauseMode | null }
  | { readonly _tag: "stack"; readonly id: string; readonly after: Stack | null }
  /** K-212: the end time of a card, or null for a card that stays until someone stops it. */
  | { readonly _tag: "cardEnd"; readonly id: string; readonly after: Time | null };

/** K-909: the card kinds that a deploy makes; only these come and go as an app. */
export const APP_KINDS = ["site.static", "site.worker", "site.compose"] as const;

/** K-909: the card of a deployed app as History keeps it. Its status is live data, so History leaves it out. */
export type AppCard = Omit<Resource, "status"> & { readonly kind: (typeof APP_KINDS)[number] };

export const isAppCard = (card: Omit<Resource, "status">): card is AppCard =>
  (APP_KINDS as ReadonlyArray<string>).includes(card.kind);

const withoutStatus = ({ status: _status, ...card }: Resource): Omit<Resource, "status"> => card;

/** K-909: a restored app card; the next report or deploy sets its status. */
export const restoredResource = (card: AppCard): Resource => ({ ...card, status: "unknown" });

/** One stored change of a revision. Undo swaps `before` and `after`. */
export type Change =
  | {
      readonly _tag: "circle";
      readonly id: string;
      readonly before: Circle | null;
      readonly after: Circle | null;
    }
  | {
      readonly _tag: "actor";
      readonly id: string;
      readonly before: Actor | null;
      readonly after: Actor | null;
    }
  | {
      readonly _tag: "place";
      readonly id: string;
      readonly before: Point | null;
      readonly after: Point | null;
    }
  | {
      readonly _tag: "shareSetting";
      readonly id: string;
      readonly before: ShareSetting | null;
      readonly after: ShareSetting | null;
    }
  | {
      readonly _tag: "pause";
      readonly id: "pause";
      readonly before: PauseMode | null;
      readonly after: PauseMode | null;
    }
  | {
      readonly _tag: "stack";
      readonly id: string;
      readonly before: Stack | null;
      readonly after: Stack | null;
    }
  | {
      readonly _tag: "cardEnd";
      readonly id: string;
      readonly before: Time | null;
      readonly after: Time | null;
    }
  /** K-909: an app card goes (removal) or comes back (its undo). The worker runs the teardown or the start. */
  | {
      readonly _tag: "app";
      readonly id: string;
      readonly before: AppCard | null;
      readonly after: AppCard | null;
    }
  /**
   * K-704: a provider card goes ("Forget provider") or comes back (its undo). Its status is live data, so History
   * leaves it out; a card that comes back is offline until its provider reports it.
   */
  | {
      readonly _tag: "providerCard";
      readonly id: string;
      readonly before: Omit<Resource, "status"> | null;
      readonly after: Omit<Resource, "status"> | null;
    }
  /** K-1120: the main address of a page or a file card, `pages.<zone>/<name>` or `files.<zone>/<name>/<file>`. */
  | {
      readonly _tag: "address";
      readonly id: string;
      readonly before: string;
      readonly after: string;
    }
  /** K-626: "Update daemon automatically" of a machine; its id is the machine's, which is also its card's. */
  | {
      readonly _tag: "autoUpdate";
      readonly id: string;
      readonly before: boolean;
      readonly after: boolean;
    };

/**
 * K-1506: a card that kitshn deleted outside an edit (a live site that stopped, a closed preview, a removed
 * machine, a deleted page or file). It only marks the card for the undo rules; nothing applies or reverses it.
 */
export type Forget = {
  readonly _tag: "forget";
  readonly id: string;
  readonly before: null;
  readonly after: null;
};

/** K-1506: a revision with only forgets records an action, which has nothing to undo. */
export const isAction = (changes: ReadonlyArray<Change | Forget>) =>
  changes.every((change) => change._tag === "forget");

export type Author =
  | { readonly _tag: "person"; readonly email: string }
  | { readonly _tag: "device"; readonly clientId: string; readonly name: string }
  /** K-1717: a machine that acted for one of its agents. */
  | { readonly _tag: "machine"; readonly machineId: string; readonly name: string }
  | { readonly _tag: "kitshn"; readonly reason: string };

export interface Revision {
  readonly id: number;
  readonly at: number;
  readonly actor: Author;
  readonly summary: string;
  readonly changes: ReadonlyArray<Change>;
  readonly undoes: number | null;
}

export class RuleError extends Error {
  override readonly name = "RuleError";
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const current = (state: State, change: Pick<Change, "_tag" | "id">) => {
  switch (change._tag) {
    case "circle":
      return state.circles.get(change.id) ?? null;
    case "actor":
      return state.actors.get(change.id) ?? null;
    case "place":
      return state.places.get(change.id) ?? null;
    case "shareSetting":
      return state.shareSettings.get(change.id) ?? null;
    case "pause":
      return state.paused;
    case "stack":
      return state.stacks.get(change.id) ?? null;
    case "cardEnd":
      return state.ends.get(change.id) ?? null;
    case "app":
    case "providerCard": {
      const resource = state.resources.get(change.id);
      return resource ? withoutStatus(resource) : null;
    }
    case "address":
      return state.resources.get(change.id)?.addresses[0] ?? null;
    case "autoUpdate": {
      const machine = state.machines.get(change.id);
      return machine ? machine.autoUpdate !== false : null;
    }
  }
};

/** Turns edits into changes against the current state. Edits that change nothing drop out (K-1302). */
export function resolveEdits(state: State, edits: ReadonlyArray<Edit>): Array<Change> {
  const seen = new Set<string>();
  const changes: Array<Change> = [];
  for (const edit of edits) {
    const id =
      edit._tag === "shareSetting"
        ? shareKey(edit.resourceId, edit.circleId)
        : edit._tag === "pause"
          ? "pause"
          : edit.id;
    const key = `${edit._tag}:${id}`;
    if (seen.has(key)) throw new RuleError(`The same ${edit._tag} "${id}" is edited twice in one change.`);
    seen.add(key);
    if ((edit._tag === "circle" || edit._tag === "actor") && edit.after && edit.after.id !== edit.id) {
      throw new RuleError(`A ${edit._tag} edit cannot change the ${edit._tag} id "${edit.id}".`);
    }
    if (edit._tag === "stack" && edit.after) {
      if (edit.after.id !== edit.id)
        throw new RuleError(`A stack edit cannot change the stack id "${edit.id}".`);
      if (edit.after.members.length < 2) throw new RuleError("A stack holds at least two cards.");
      const missing = edit.after.members.find((id) => !state.resources.has(id));
      if (missing) throw new RuleError(`No card "${missing}" exists.`);
    }
    if ((edit._tag === "place" || edit._tag === "cardEnd") && !state.resources.has(edit.id)) {
      throw new RuleError(`No card "${edit.id}" exists.`);
    }
    if (edit._tag === "shareSetting" && edit.after) {
      if (!state.resources.has(edit.resourceId)) throw new RuleError(`No card "${edit.resourceId}" exists.`);
      if (!state.circles.has(edit.circleId)) throw new RuleError(`No circle "${edit.circleId}" exists.`);
    }
    const before = current(state, { _tag: edit._tag, id });
    if (deepEqual(before, edit.after)) continue;
    changes.push({ _tag: edit._tag, id, before, after: edit.after } as Change);
  }
  return withStackMates(state, changes);
}

/**
 * K-521: a stack moves as one, so a change that moves one of its cards also moves the others of the stack
 * after the change. Edits and undo both go through this.
 */
export function withStackMates(state: State, changes: ReadonlyArray<Change>): Array<Change> {
  const stacks = new Map(state.stacks);
  for (const change of changes) {
    if (change._tag !== "stack") continue;
    if (change.after) stacks.set(change.id, change.after);
    else stacks.delete(change.id);
  }
  const placed = new Set(changes.flatMap((change) => (change._tag === "place" ? [change.id] : [])));
  const mates: Array<Change> = [];
  for (const change of changes) {
    if (change._tag !== "place") continue;
    // A card that goes back to the tray leaves its stack, as a deleted card does; the stack stays put.
    if (change.after === null) {
      for (const left of stacksWithout(stacks.values(), change.id)) {
        mates.push({ _tag: "stack", id: left.id, before: stacks.get(left.id) ?? null, after: left.after });
        if (left.after) stacks.set(left.id, left.after);
        else stacks.delete(left.id);
      }
      continue;
    }
    const stack = [...stacks.values()].find((candidate) => candidate.members.includes(change.id));
    for (const mate of stack?.members ?? []) {
      if (placed.has(mate)) continue;
      placed.add(mate);
      const before = state.places.get(mate) ?? null;
      if (!deepEqual(before, change.after))
        mates.push({ _tag: "place", id: mate, before, after: change.after });
    }
  }
  return [...changes, ...mates];
}

/**
 * K-704: the changes that forget one provider of a machine: each card, its place, its share settings and its place
 * in a stack. Undo brings the cards back in the same places and circles.
 */
export function forgetProviderChanges(
  state: State,
  machineId: string,
  provider: string,
  /** One card only, a card that its provider dropped (K-705); null for every card of the provider. */
  only: string | null = null,
): Array<Change> {
  const cards = [...state.resources.values()].filter(
    (resource) =>
      resource.machine === machineId &&
      resource.provider?.name === provider &&
      (only === null || resource.id === only),
  );
  if (cards.length === 0) throw new RuleError(`The machine has no such card of the provider ${provider}.`);
  const edits: Array<Edit> = cards.flatMap((card) => [
    ...(state.places.has(card.id) ? [{ _tag: "place", id: card.id, after: null } as const] : []),
    // K-212: the end time goes with the card, and its undo brings it back.
    ...(state.ends.has(card.id) ? [{ _tag: "cardEnd", id: card.id, after: null } as const] : []),
    ...[...state.shareSettings.keys()]
      .filter((key) => key.startsWith(`${card.id}/`))
      .map((key): Edit => ({
        _tag: "shareSetting",
        resourceId: card.id,
        circleId: key.slice(card.id.length + 1),
        after: null,
      })),
  ]);
  return [
    ...resolveEdits(state, edits),
    ...cards.map((card): Change => ({
      _tag: "providerCard",
      id: card.id,
      before: withoutStatus(card),
      after: null,
    })),
  ];
}

/**
 * K-909: the changes that remove a deployed app: its card, its place, its share settings and its place in a
 * stack. Undo of them restores the card in the same place and circles.
 */
export function removeAppChanges(state: State, id: string): Array<Change> {
  const resource = state.resources.get(id);
  if (!resource) throw new RuleError(`No card "${id}" exists.`);
  const card = withoutStatus(resource);
  if (!isAppCard(card)) throw new RuleError(`${resource.name} is not an app that a deploy made (K-909).`);
  const edits: Array<Edit> = [
    ...(state.places.has(id) ? [{ _tag: "place", id, after: null } as const] : []),
    // K-212: the end time goes with the card, and its undo brings it back.
    ...(state.ends.has(id) ? [{ _tag: "cardEnd", id, after: null } as const] : []),
    ...[...state.shareSettings.keys()]
      .filter((key) => key.startsWith(`${id}/`))
      .map((key): Edit => ({
        _tag: "shareSetting",
        resourceId: id,
        circleId: key.slice(id.length + 1),
        after: null,
      })),
  ];
  return [...resolveEdits(state, edits), { _tag: "app", id, before: card, after: null }];
}

/**
 * K-209, K-212: in the Undo of an expiry, which gives the card its place back (`placed`), an end time that passed
 * already goes, so the shares come back for good. Any other Undo keeps a passed end, so the card ends at once.
 */
function withoutPastEnd(change: Change, now: number, placed: ReadonlySet<string>): Change {
  if (change._tag === "cardEnd" && placed.has(change.id) && change.after !== null && change.after <= now)
    return { ...change, after: null };
  if (
    change._tag === "shareSetting" &&
    placed.has(change.id.slice(0, change.id.lastIndexOf("/"))) &&
    change.after?.endsAt != null &&
    change.after.endsAt <= now
  )
    return { ...change, after: change.after.level === null ? null : { ...change.after, endsAt: null } };
  return change;
}

export const invert = (changes: ReadonlyArray<Change>): Array<Change> =>
  changes.map((change) => ({ ...change, before: change.after, after: change.before }) as Change);

/**
 * K-1505: moves of the same cards or circles by the same actor join the revision of the move or drop that
 * started them, while each comes within this time of the one before. Two minutes covers the nudges after a
 * drop, and a later rearrangement gets its own History entry.
 */
export const MOVE_MERGE_MS = 2 * 60 * 1000;

const onlyMoved = (before: Circle, after: Circle) =>
  deepEqual({ ...before, x: 0, y: 0 }, { ...after, x: 0, y: 0 });

/** K-1505: a card or circle that lands somewhere: a drop from the tray, a new circle, or a move. */
const lands = (change: Change) =>
  (change._tag === "place" && change.after !== null) ||
  (change._tag === "circle" &&
    change.after !== null &&
    (change.before === null || onlyMoved(change.before, change.after)));

const isMove = (change: Change) => change.before !== null && lands(change);

/**
 * K-1505: the changes of `previous` with the moves of `changes` merged in (first `before`, last `after`), or
 * null when the moves start a revision of their own. `previous` must be the newest revision.
 */
export function mergeMoves(
  previous: Pick<Revision, "actor" | "at" | "changes" | "undoes">,
  actor: Author,
  now: number,
  changes: ReadonlyArray<Change>,
): Array<Change> | null {
  if (previous.undoes !== null || !deepEqual(previous.actor, actor) || now - previous.at > MOVE_MERGE_MS)
    return null;
  if (previous.changes.length === 0 || !previous.changes.every(lands) || !changes.every(isMove)) return null;
  const key = (change: Change) => `${change._tag}:${change.id}`;
  const merged = new Map(previous.changes.map((change) => [key(change), change]));
  for (const change of changes) {
    const first = merged.get(key(change));
    if (!first) return null;
    merged.set(key(change), { ...first, after: change.after } as Change);
  }
  return [...merged.values()];
}

/**
 * K-1505: the summary of a revision that moves joined. A move that changes a share gives the net summary
 * from `start` (History is the audit trail); a pure move keeps the first summary and says that it moved.
 */
export function mergedSummary(
  first: string,
  start: State,
  before: State,
  after: State,
  merged: ReadonlyArray<Change>,
): string {
  if (shareDiff(before, after).length > 0) return summarize(start, after, merged);
  if (first.startsWith("Moved ") || first.endsWith(" and moved it") || first.endsWith(" and moved them"))
    return first;
  return `${first}${merged.length === 1 ? " and moved it" : " and moved them"}`;
}

/** K-1507: a card or a circle that a per-item undo names. */
export interface Item {
  readonly kind: "card" | "circle";
  readonly id: string;
}

/** K-1508: what a History entry is about, for its kind filter. "action" changes nothing that Undo reverses. */
export type RevisionKind = "card" | "share" | "circle" | "stack" | "app" | "pause" | "action";

/** K-1508: the tag and id of a change, and for a stack the members before and after. */
export type RevisionTarget = Pick<Change | Forget, "_tag" | "id"> & {
  readonly members?: ReadonlyArray<ReadonlyArray<string> | null>;
};

export const targetOf = (change: Change | Forget): RevisionTarget =>
  change._tag === "stack"
    ? {
        _tag: "stack",
        id: change.id,
        members: [change.before?.members ?? null, change.after?.members ?? null],
      }
    : { _tag: change._tag, id: change.id };

/** A big revision (the setup) sends at most this many items, so the snapshot stays small. */
const MAX_REVISION_ITEMS = 30;

/**
 * K-1508: the kind of a revision and the cards and circles that it changes, from the tag and id of each change.
 * The first kind in the order app, pause, circle, share, stack, card wins, so a share that ends and takes its card
 * out of a stack is a share.
 */
export function revisionTargets(changes: ReadonlyArray<RevisionTarget>): {
  readonly kind: RevisionKind;
  readonly items: ReadonlyArray<Item>;
} {
  const tags = new Set(changes.map((change) => change._tag));
  const kind: RevisionKind = tags.has("app")
    ? "app"
    : tags.has("pause")
      ? "pause"
      : tags.has("circle") || tags.has("actor")
        ? "circle"
        : tags.has("shareSetting")
          ? "share"
          : tags.has("stack")
            ? "stack"
            : tags.has("place") || tags.has("address") || tags.has("cardEnd") || tags.has("autoUpdate")
              ? "card"
              : "action";
  const items = new Map<string, Item>();
  const add = (item: Item) => items.set(`${item.kind}:${item.id}`, item);
  for (const change of changes) {
    if (change._tag === "circle") add({ kind: "circle", id: change.id });
    else if (
      change._tag === "place" ||
      change._tag === "app" ||
      change._tag === "providerCard" ||
      change._tag === "address" ||
      change._tag === "cardEnd" ||
      change._tag === "autoUpdate" ||
      change._tag === "forget"
    )
      add({ kind: "card", id: change.id });
    else if (change._tag === "stack")
      for (const id of (change.members ?? []).flatMap((members) => members ?? [])) add({ kind: "card", id });
    else if (change._tag === "shareSetting") {
      // A share setting id is `card/circle` (shareKey). Circle ids have no slash, so the last one splits it.
      const cut = change.id.lastIndexOf("/");
      add({ kind: "card", id: change.id.slice(0, cut) });
      add({ kind: "circle", id: change.id.slice(cut + 1) });
    }
  }
  return { kind, items: [...items.values()].slice(0, MAX_REVISION_ITEMS) };
}

/** K-1507: whether a change is part of an item: a card's place, shares, app and stack membership; a circle and its shares. */
export function touches(change: Change, item: Item): boolean {
  if (item.kind === "circle")
    return (
      (change._tag === "circle" && change.id === item.id) ||
      (change._tag === "shareSetting" && change.id.endsWith(`/${item.id}`))
    );
  switch (change._tag) {
    case "place":
    case "app":
    case "providerCard":
    case "address":
    case "cardEnd":
    case "autoUpdate":
      return change.id === item.id;
    case "shareSetting":
      return change.id.startsWith(`${item.id}/`);
    case "stack":
      return (
        (change.before?.members.includes(item.id) ?? false) !==
        (change.after?.members.includes(item.id) ?? false)
      );
    case "circle":
    case "actor":
    case "pause":
      return false;
  }
}

/**
 * K-1507: the part of a revision for one item. A circle that the revision dragged by its head (K-504) takes
 * the cards that moved with it.
 */
export function itemParts(changes: ReadonlyArray<Change>, item: Item): Array<Change> {
  const dragged =
    item.kind === "circle" &&
    changes.some(
      (change) =>
        change._tag === "circle" &&
        change.id === item.id &&
        change.before !== null &&
        change.after !== null &&
        (change.before.x !== change.after.x || change.before.y !== change.after.y),
    );
  // K-504: the cards that moved with the circle are the ones that sat inside it before the drag.
  const circleBefore = changes.flatMap((change) =>
    change._tag === "circle" && change.id === item.id && change.before ? [change.before] : [],
  )[0];
  const inside = (change: Change) =>
    change._tag === "place" &&
    change.before !== null &&
    circleBefore !== undefined &&
    insideCircle(change.before, circleBefore);
  return changes.filter((change) => touches(change, item) || (dragged && inside(change)));
}

/**
 * K-1506: what changes touch. `changed` holds the circles that they change, also through a share setting;
 * `all` adds every circle that holds or held one of their cards, at any point that the changes or `state`
 * give it. `pool` holds every circle shape to test, also shapes that no longer exist.
 */
function footprint(changes: ReadonlyArray<Change | Forget>, state: State, pool: ReadonlyArray<Circle>) {
  const cards = new Set<string>();
  const changed = new Set<string>();
  const points: Array<Point> = [];
  for (const change of changes) {
    if (
      change._tag === "place" ||
      change._tag === "app" ||
      change._tag === "providerCard" ||
      change._tag === "address" ||
      change._tag === "cardEnd" ||
      change._tag === "autoUpdate" ||
      change._tag === "forget"
    )
      cards.add(change.id);
    if (change._tag === "place")
      points.push(...[change.before, change.after].filter((point) => point !== null));
    if (change._tag === "circle") changed.add(change.id);
    // K-1778: an actor change reaches every circle that names the actor.
    if (change._tag === "actor")
      for (const circle of pool)
        if (circle.members.some((member) => member._tag === "actor" && member.actorId === change.id))
          changed.add(circle.id);
    if (change._tag === "stack")
      for (const id of [...(change.before?.members ?? []), ...(change.after?.members ?? [])]) cards.add(id);
    if (change._tag === "shareSetting") {
      const [card = "", circle = ""] = change.id.split("/");
      cards.add(card);
      changed.add(circle);
    }
  }
  for (const card of cards) {
    const place = state.places.get(card);
    if (place) points.push(place);
  }
  const all = new Set(changed);
  for (const circle of pool) if (points.some((point) => insideCircle(point, circle))) all.add(circle.id);
  return { cards, changed, all };
}

const circleShapes = (changes: ReadonlyArray<Change | Forget>) =>
  changes.flatMap((change) =>
    change._tag === "circle" ? [change.before, change.after].filter((c) => c !== null) : [],
  );

/**
 * K-1506: whether two sets of changes depend on each other: they touch the same card, or one changes a
 * circle that a card of the other is or was in.
 */
export function overlaps(
  a: ReadonlyArray<Change | Forget>,
  b: ReadonlyArray<Change | Forget>,
  state: State,
): boolean {
  const pool = [...state.circles.values(), ...circleShapes(a), ...circleShapes(b)];
  const one = footprint(a, state, pool);
  const two = footprint(b, state, pool);
  const meets = (x: ReadonlySet<string>, y: ReadonlySet<string>) => [...x].some((id) => y.has(id));
  return meets(one.cards, two.cards) || meets(one.changed, two.all) || meets(two.changed, one.all);
}

/** A revision as the undo rules read it. */
export interface StoredRevision {
  readonly id: number;
  readonly actor: Author;
  readonly summary: string;
  readonly changes: ReadonlyArray<Change | Forget>;
  readonly undoes: number | null;
}

const isChange = (change: Change | Forget): change is Change => change._tag !== "forget";

/**
 * K-1506, K-1507: what an undo by `actor` reverses: its own newest revision that is in effect (or, with an
 * item, its own newest one that touched the item), and the changes to invert. Refuses when a later revision
 * by anyone touched the same cards or circles. An undo and the revision that it undid cancel out.
 */
export function undoTarget(
  state: State,
  revisions: ReadonlyArray<StoredRevision>,
  actor: Author,
  target: { readonly revision: number } | { readonly item: Item },
): { readonly revision: number; readonly changes: ReadonlyArray<Change> } {
  const undone = new Set(
    revisions.flatMap((revision) => (revision.undoes === null ? [] : [revision.undoes])),
  );
  const own = revisions
    .filter(
      (revision) =>
        !isAction(revision.changes) &&
        revision.undoes === null &&
        !undone.has(revision.id) &&
        deepEqual(revision.actor, actor),
    )
    .sort((a, b) => b.id - a.id);
  let found: StoredRevision | undefined;
  let changes: ReadonlyArray<Change>;
  if ("revision" in target) {
    const asked = revisions.find((revision) => revision.id === target.revision);
    if (!asked)
      throw new RuleError(
        `Revision #${target.revision} does not exist, or it is older than the history keeps.`,
      );
    if (isAction(asked.changes))
      throw new RuleError(
        `Revision #${asked.id} records an action, not a change, so it has nothing to undo.`,
      );
    if (asked.undoes !== null)
      throw new RuleError(`Revision #${asked.id} is an undo. Make the change again instead.`);
    if (undone.has(asked.id)) throw new RuleError(`Revision #${asked.id} is undone already.`);
    found = own[0];
    if (found?.id !== asked.id)
      throw new RuleError(
        found
          ? `Only your newest change can be undone: #${found.id} "${found.summary}".`
          : `Revision #${asked.id} is not yours, and only your own newest change can be undone.`,
      );
    changes = found.changes.filter(isChange);
  } else {
    const item = target.item;
    found = own.find((revision) => itemParts(revision.changes.filter(isChange), item).length > 0);
    if (!found) throw new RuleError("You have no change to this item left to undo.");
    const all = found.changes.filter(isChange);
    changes = itemParts(all, item);
    // The rest of the revision can depend on this part, such as a circle that opened while the card left it.
    const rest = all.filter((change) => !changes.includes(change));
    if (rest.length > 0 && overlaps(changes, rest, state))
      throw new RuleError(
        `#${found.id} "${found.summary}" changed more that depends on this item: undo the whole change instead.`,
      );
  }
  const start = found.id;
  const later = revisions
    .filter(
      (revision) =>
        revision.id > start &&
        revision.changes.length > 0 &&
        !undone.has(revision.id) &&
        !(revision.undoes !== null && revision.undoes > start),
    )
    .sort((a, b) => a.id - b.id)
    .find((revision) => overlaps(changes, revision.changes, state));
  if (later)
    throw new RuleError(
      `#${later.id} "${later.summary}" changed the same cards or circles later, so this undo no longer fits. Change it by hand.`,
    );
  // A card that is gone gets nothing back, also when a later card has its id; an app removal restores its card.
  const restored = new Set(
    changes.flatMap((change) =>
      (change._tag === "app" || change._tag === "providerCard") && change.before ? [change.id] : [],
    ),
  );
  const missing = changes
    .flatMap((change) =>
      (change._tag === "place" && change.before) || change._tag === "address" || change._tag === "autoUpdate"
        ? [change.id]
        : change._tag === "shareSetting" && change.before
          ? [change.id.split("/")[0] ?? ""]
          : change._tag === "stack"
            ? (change.before?.members ?? [])
            : [],
    )
    .find((id) => !state.resources.has(id) && !restored.has(id));
  if (missing !== undefined)
    throw new RuleError(`The card "${missing}" no longer exists, so this undo no longer fits.`);
  return { revision: start, changes };
}

/** The first change whose current value is not its `before`, or null. */
export function conflictOf(state: State, changes: ReadonlyArray<Change>): Change | null {
  return changes.find((change) => !deepEqual(current(state, change), change.before)) ?? null;
}

export function applyChanges(state: State, changes: ReadonlyArray<Change>): State {
  const circles = new Map(state.circles);
  const actors = new Map(state.actors);
  const resources = new Map(state.resources);
  const places = new Map(state.places);
  const shareSettings = new Map(state.shareSettings);
  const stacks = new Map(state.stacks);
  const ends = new Map(state.ends);
  const machines = new Map(state.machines);
  let paused = state.paused;
  const put = <V>(map: Map<string, V>, id: string, value: V | null) =>
    value === null ? map.delete(id) : map.set(id, value);
  for (const change of changes) {
    if (change._tag === "circle") put(circles, change.id, change.after);
    else if (change._tag === "actor") put(actors, change.id, change.after);
    else if (change._tag === "place") put(places, change.id, change.after);
    else if (change._tag === "shareSetting") put(shareSettings, change.id, change.after);
    else if (change._tag === "stack") put(stacks, change.id, change.after);
    else if (change._tag === "cardEnd") put(ends, change.id, change.after);
    else if (change._tag === "app") put(resources, change.id, change.after && restoredResource(change.after));
    else if (change._tag === "providerCard")
      put(resources, change.id, change.after && { ...change.after, status: "offline" });
    else if (change._tag === "address") {
      const resource = resources.get(change.id);
      if (!resource) throw new RuleError(`No card "${change.id}" exists.`);
      resources.set(change.id, { ...resource, addresses: [change.after, ...resource.addresses.slice(1)] });
    } else if (change._tag === "autoUpdate") {
      const machine = machines.get(change.id);
      if (!machine) throw new RuleError(`No machine "${change.id}" exists.`);
      machines.set(change.id, withAutoUpdate(machine, change.after));
    } else paused = change.after;
  }
  return { ...state, circles, actors, resources, places, shareSettings, stacks, ends, machines, paused };
}

/**
 * The rules that every write must keep (K-105, K-211). Returns the reason a state is refused, or null.
 * K-105 also refuses a public admin: a circle with "everyone" would compile to an Access Bypass policy.
 */
export function ruleViolation(state: State): string | null {
  if (!state.circles.has(OWNER_CIRCLE_ID)) return "The Owner circle cannot be deleted.";
  const actorProblem = actorViolation(state);
  if (actorProblem) return actorProblem;
  // K-521: a card is in one stack at most, and the cards of a stack share one point.
  const stacked = new Set<string>();
  for (const stack of state.stacks.values()) {
    for (const id of stack.members) {
      if (!state.resources.has(id))
        return `The stack "${stackTitle(state, stack)}" holds a card that no longer exists.`;
      if (stacked.has(id)) return `The card "${state.resources.get(id)?.name ?? id}" is in two stacks.`;
      stacked.add(id);
    }
    const points = new Set(stack.members.map((id) => JSON.stringify(state.places.get(id) ?? null)));
    if (points.size > 1) return `The cards of the stack "${stackTitle(state, stack)}" must share one place.`;
  }
  // K-719: the Owner circle's share of an owner-control card has no override and no end date.
  for (const [key, setting] of state.shareSettings) {
    if (!key.endsWith(`/${OWNER_CIRCLE_ID}`) || (setting.level === null && setting.endsAt === null)) continue;
    const card = state.resources.get(key.slice(0, -`/${OWNER_CIRCLE_ID}`.length));
    if (card?.provider?.ownerControl)
      return `The Owner circle keeps control of ${card.name}: its share has no other level and no end date (K-719).`;
  }
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  if (!admin) return "The kitshn admin card is missing.";
  // K-212: a timed admin would lock the owner out at its end.
  if (state.ends.has(admin.id)) return "The kitshn admin cannot have an end time.";
  const all = circlesHolding(state, admin.id);
  const publicCircle = all.find((circle) => isPublicCircle(circle) && shareLevel(state, admin, circle));
  const holding = all.filter((circle) => !state.paused || circle.id === OWNER_CIRCLE_ID);
  if (publicCircle) return `The kitshn admin cannot be shared with "${publicCircle.name}", which is public.`;
  const guarded = holding.some(
    (circle) =>
      circle.needsPasskey &&
      circle.endsAt === null &&
      circle.members.some((member) => {
        const actor = memberActor(member, state);
        return actor !== undefined && isPerson(actor);
      }) &&
      (circle.match === "any" || allCircleCanMatch(circle, state)) &&
      shareLevel(state, admin, circle) === "control" &&
      (state.shareSettings.get(shareKey(admin.id, circle.id))?.endsAt ?? null) === null,
  );
  if (!guarded && state.paused) {
    return "A pause keeps only the Owner circle's share of the admin, so the Owner circle must hold the admin at control with a person and a passkey.";
  }
  if (!guarded) {
    return "The kitshn admin must stay shared at control with a circle that has a person and needs a passkey.";
  }
  return null;
}

/**
 * K-1778: every actor that a member names exists, a login or a token belongs to one actor, and only an actor with exactly
 * one machine credential has conditions (K-1754).
 */
function actorViolation(state: State): string | null {
  for (const circle of state.circles.values())
    for (const member of circle.members)
      if (member._tag === "actor" && !state.actors.has(member.actorId))
        return `The circle ${circle.name} names an actor that does not exist.`;
  const owners = new Map<string, string>();
  for (const actor of state.actors.values()) {
    if (actor.credentials.length === 0) return `The actor ${actor.name} has no credential.`;
    if ((actor.conditions ?? []).length > 0) {
      const [only] = actor.credentials;
      if (actor.credentials.length !== 1 || only?._tag !== "machine")
        return `The actor ${actor.name} has conditions, so it has exactly one machine credential and nothing else (K-1754).`;
      continue;
    }
    for (const credential of actor.credentials) {
      const key = credentialKey(credential);
      const other = owners.get(key);
      if (other !== undefined && other !== actor.id)
        return `${actor.name} and ${state.actors.get(other)?.name ?? other} have the same credential; a login, a token or a machine belongs to one actor (K-1778).`;
      owners.set(key, actor.id);
    }
  }
  return null;
}

/** An "all" circle matches someone only with one person of one login, no other actor, and domains of that person. */
function allCircleCanMatch(circle: Circle, directory: Directory): boolean {
  const actors = circle.members.flatMap((member) => {
    const actor = memberActor(member, directory);
    return actor ? [actor] : [];
  });
  const [person] = actors;
  const logins = (person?.credentials ?? []).flatMap((credential) =>
    credential._tag === "login" ? [credential.email.toLowerCase()] : [],
  );
  const [email] = logins;
  if (actors.length !== 1 || logins.length !== 1 || !email) return false;
  return circle.members.every((member) =>
    member._tag === "domain" ? email.endsWith(`@${member.domain.toLowerCase()}`) : true,
  );
}

export interface ShareDiff {
  readonly resource: Resource;
  readonly circle: Circle;
  readonly from: Level | null;
  readonly to: Level | null;
}

/** Every share that differs between two states (K-502 preview, K-503 toast). */
export function shareDiff(before: State, after: State): Array<ShareDiff> {
  const diffs: Array<ShareDiff> = [];
  const circleIds = new Set([...before.circles.keys(), ...after.circles.keys()]);
  for (const resource of after.resources.values()) {
    const was = new Set(circlesHolding(before, resource.id).map((circle) => circle.id));
    const is = new Set(circlesHolding(after, resource.id).map((circle) => circle.id));
    for (const circleId of circleIds) {
      const oldCircle = before.circles.get(circleId);
      const newCircle = after.circles.get(circleId);
      const from = was.has(circleId) && oldCircle ? shareLevel(before, resource, oldCircle) : null;
      const to = is.has(circleId) && newCircle ? shareLevel(after, resource, newCircle) : null;
      const circle = newCircle ?? oldCircle;
      if (from !== to && circle) diffs.push({ resource, circle, from, to });
    }
  }
  return diffs;
}

/** "riffle: + Her · view", "riffle: − Her", or for a new level of a share "riffle: Her · view → use". */
export const describeDiff = (diff: ShareDiff) =>
  diff.to === null
    ? `${diff.resource.name}: − ${diff.circle.name}`
    : diff.from === null
      ? `${diff.resource.name}: + ${diff.circle.name} · ${diff.to}`
      : `${diff.resource.name}: ${diff.circle.name} · ${diff.from} → ${diff.to}`;

export function summarize(before: State, after: State, changes: ReadonlyArray<Change>): string {
  const app = changes.find((change) => change._tag === "app");
  if (app?.after) return `Restored the app ${app.after.name} (K-909)`;
  if (app?.before) return `Removed the app ${app.before.name} (K-909)`;
  const cards = changes.flatMap((change) => (change._tag === "providerCard" ? [change] : []));
  const card = cards[0];
  if (card) {
    const provider = (card.before ?? card.after)?.provider?.name ?? "a provider";
    return card.before
      ? `Forgot ${cards.length} ${cards.length === 1 ? "card" : "cards"} of the provider ${provider} (K-704)`
      : `Brought back ${cards.length} ${cards.length === 1 ? "card" : "cards"} of the provider ${provider} (K-704)`;
  }
  const autoUpdate = changes.find((change) => change._tag === "autoUpdate");
  if (autoUpdate)
    return `Turned ${autoUpdate.after ? "on" : "off"} Update daemon automatically for ${after.machines.get(autoUpdate.id)?.name ?? autoUpdate.id} (K-626)`;
  const address = changes.find((change) => change._tag === "address");
  if (address)
    return `Moved ${after.resources.get(address.id)?.name ?? address.id} to ${address.after} (K-1120)`;
  const pause = changes.find((change) => change._tag === "pause");
  if (pause) {
    if (pause.after === null) return "Resumed all shares";
    if (pause.after === "keep-public")
      return "Paused all shares except public sites, apps, pages and files (K-1504)";
    return pause.before
      ? "Closed public sites too: lockdown (K-1504)"
      : "Paused all shares: lockdown (K-1504)";
  }
  const diffs = shareDiff(before, after);
  if (diffs.length > 0) {
    const shown = diffs.slice(0, 3).map(describeDiff).join("; ");
    return diffs.length > 3 ? `${shown}; and ${diffs.length - 3} more` : shown;
  }
  const actors = changes.flatMap((change) => (change._tag === "actor" ? [change] : []));
  const circles = changes.filter((change) => change._tag === "circle");
  const [actor] = actors;
  if (actor && circles.length === 0) {
    const name = (actor.after ?? actor.before)?.name ?? actor.id;
    return !actor.before
      ? `Added the actor ${name}`
      : !actor.after
        ? `Deleted the actor ${name}`
        : `Changed the actor ${name}`;
  }
  if (circles.length === 1 && circles[0]) {
    const rights = rightChanges(after, circles[0].before, circles[0].after);
    if (rights.length > 0) return rights.join("; ");
    const circle = circles[0].after ?? circles[0].before;
    const verb = !circles[0].before ? "Created" : !circles[0].after ? "Deleted" : "Changed";
    return `${verb} circle ${circle?.name ?? circles[0].id}`;
  }
  const stacks = changes.filter((change) => change._tag === "stack");
  if (stacks.length > 0) {
    const name = (id: string) => after.resources.get(id)?.name ?? before.resources.get(id)?.name ?? id;
    const names = (ids: ReadonlyArray<string>) => ids.map(name).join(", ");
    return stacks
      .map(({ before: was, after: is }) => {
        if (!was) return `Stacked ${names(is?.members ?? [])}`;
        if (!is) return `Unstacked ${was.name || names(was.members)}`;
        const added = is.members.filter((member) => !was.members.includes(member));
        const removed = was.members.filter((member) => !is.members.includes(member));
        // A stack without a name goes by its cards, as before the change.
        const title = (stack: Stack) => stack.name || `the stack of ${names(stack.members)}`;
        if (added.length > 0) return `Added ${names(added)} to ${title(was)}`;
        if (removed.length > 0) return `Took ${names(removed)} out of ${title(was)}`;
        if (was.name === is.name) return `Changed ${title(is)}`;
        if (!is.name) return `Took the name ${was.name} off ${title(is)}`;
        return `Renamed ${title(was)} to ${is.name}`;
      })
      .join("; ");
  }
  const end = changes.find((change) => change._tag === "cardEnd");
  if (end && changes.length === 1) {
    const name = after.resources.get(end.id)?.name ?? end.id;
    return end.after === null
      ? `${name} stays until someone stops it (K-212)`
      : `${name} ends at ${endText(end.after)} (K-212)`;
  }
  const moved = changes.filter((change) => change._tag === "place").length;
  if (moved > 0 && moved === changes.length) return moved === 1 ? "Moved a card" : `Moved ${moved} cards`;
  return `Changed ${changes.length} items`;
}

/** K-626: on is the default, so the machine body holds only `autoUpdate: false`. */
export function withAutoUpdate(machine: Machine, on: boolean): Machine {
  const { autoUpdate: _autoUpdate, ...rest } = machine;
  return on ? rest : { ...rest, autoUpdate: false };
}

/** K-212: an end time in History, which every reader reads in UTC: "2026-10-29 15:40 UTC". */
export const endText = (time: number) => `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** K-1720: "Set runs of vps to ask Owner in Agents" for each effect that a circle edit changes. */
function rightChanges(state: State, before: Circle | null, after: Circle | null): Array<string> {
  if (!before || !after) return [];
  return after.members.flatMap((member) => {
    if (member._tag !== "actor") return [];
    const old = before.members.find((other) => other._tag === "actor" && other.actorId === member.actorId);
    if (old?._tag !== "actor") return [];
    const name = state.actors.get(member.actorId)?.name ?? member.actorId;
    return EFFECTS.filter((right) => !deepEqual(old.rights?.[right], member.rights?.[right])).map((right) => {
      const mode = member.rights?.[right];
      const text = !mode
        ? "default"
        : mode.mode === "ask"
          ? `ask ${state.circles.get(mode.circleId)?.name ?? mode.circleId}`
          : mode.mode;
      return `Set ${right} of ${name} to ${text} in ${after.name}`;
    });
  });
}

/** K-522: the stacks that change when a card is gone; a stack left with fewer than two cards goes. */
export function stacksWithout(
  stacks: Iterable<Stack>,
  id: string,
): Array<{ id: string; after: Stack | null }> {
  return [...stacks]
    .filter((stack) => stack.members.includes(id))
    .map((stack) => {
      const members = stack.members.filter((member) => member !== id);
      return { id: stack.id, after: members.length > 1 ? { ...stack, members } : null };
    });
}

/**
 * K-1504: only "Resume" with a fresh passkey ends a pause or reopens public sites after a lockdown; an edit or
 * an undo never does.
 */
export function refuseResume(changes: Array<Change>): Array<Change> {
  const opens = (change: Change) =>
    change._tag === "pause" &&
    (!change.after || (change.before === "lockdown" && change.after === "keep-public"));
  if (changes.some(opens)) throw new RuleError("Resume needs your passkey again: press Resume on the map.");
  return changes;
}

/**
 * K-539: why a circle's new members or new match would admit no one whom it admits now, or null. A member who leaves
 * is the owner's choice, so this looks only at what a change adds. Access cannot ask for a person and a token, or for
 * two tokens, so such a circle gets no policy (K-402); a token added to a network means that only the token gets in.
 */
export function lockoutReason(before: Circle, after: Circle, directory: Directory): string | null {
  const keyOf = (member: Member) =>
    member._tag === "actor" ? `actor:${member.actorId}` : JSON.stringify(member);
  const had = before.members.map(keyOf);
  const has = after.members.map(keyOf);
  if (had.some((key) => !has.includes(key))) return null;
  if (before.match === after.match && has.length === had.length) return null;
  const actorOf = (member: Member) => memberActor(member, directory);
  const tokens = after.members.filter((member) => {
    const actor = actorOf(member);
    return actor !== undefined && !isPerson(actor);
  });
  const people = after.members.some((member) => {
    const actor = actorOf(member);
    return member._tag === "domain" || (actor !== undefined && isPerson(actor));
  });
  const start = `${after.name} must match all its members, and`;
  if (circlePolicies(after, directory).size === 0) {
    if (after.match === "any") return `${after.name} names an actor that Access cannot see.`;
    if (tokens.length > 1)
      return `${start} Access cannot ask for two machines or tokens at once, so no one would get in.`;
    if (people && tokens.length > 0)
      return `${start} Access cannot ask for a person and a machine or token at once, so no one would get in.`;
    return `${start} it names an actor that Access cannot see, so no one would get in.`;
  }
  const newToken = tokens.some((member) => !had.includes(keyOf(member)));
  if (after.match === "all" && newToken && circlePolicies(before, directory).size > 0)
    return `${start} a machine or token cannot stand in for the others, so only it would get in, and the visitors who get in now would not.`;
  return null;
}

/** K-539: a change that adds to a circle keeps someone it admits now in. */
export function refuseLockout(before: State, after: State): void {
  for (const [id, circle] of after.circles) {
    const old = before.circles.get(id);
    const reason = old && old !== circle ? lockoutReason(old, circle, after) : null;
    if (reason) throw new RuleError(reason);
  }
}

/**
 * K-1504, MM-711: while paused, a change that would raise access when Resume returns the shares is refused:
 * a new share or a higher level, a new circle member, "needs passkey" off, "all must match" to "any", or a
 * later or removed end date. Changes that lower access still work.
 */
export function refuseRaiseWhilePaused(before: State, after: State): void {
  if (!before.paused || !after.paused) return;
  const raised = shareDiff(before, after).find(
    (diff) => diff.to !== null && (diff.from === null || levelRank(diff.to) > levelRank(diff.from)),
  );
  if (raised)
    throw new RuleError(
      `While paused, access only goes down: ${raised.resource.name} would gain ${raised.circle.name}.`,
    );
  const ends = (time: number | null | undefined) => time ?? Number.POSITIVE_INFINITY;
  for (const key of new Set([...before.shareSettings.keys(), ...after.shareSettings.keys()]))
    if (ends(after.shareSettings.get(key)?.endsAt) > ends(before.shareSettings.get(key)?.endsAt))
      throw new RuleError("While paused, access only goes down: a share would end later.");
  // K-212: an end that goes with its card off the map (the expiry, End now) lowers access.
  for (const id of new Set([...before.ends.keys(), ...after.ends.keys()]))
    if (ends(after.ends.get(id)) > ends(before.ends.get(id)) && after.places.has(id))
      throw new RuleError("While paused, access only goes down: a card would end later.");
  // K-1778: an actor that gains a credential or loses a condition lets in more.
  for (const actor of after.actors.values()) {
    const old = before.actors.get(actor.id);
    if (!old) continue;
    const had = new Set(old.credentials.map(credentialKey));
    if (
      actor.credentials.some((credential) => !had.has(credentialKey(credential))) ||
      !deepEqual(old.conditions ?? [], actor.conditions ?? [])
    )
      throw new RuleError(`While paused, access only goes down: the actor ${actor.name} would let in more.`);
  }
  for (const circle of after.circles.values()) {
    const old = before.circles.get(circle.id);
    if (!old) continue;
    // An actor stays the same member when a right changes; only a right that opens raises.
    const key = (member: Member) =>
      member._tag === "actor" ? `actor:${member.actorId}` : JSON.stringify(member);
    const rights = (members: ReadonlyArray<Member>) =>
      members.flatMap((member) =>
        member._tag === "actor"
          ? EFFECTS.flatMap((right) => {
              const mode = member.rights?.[right];
              return mode && mode.mode !== "off" ? [`${key(member)}/${right}/${JSON.stringify(mode)}`] : [];
            })
          : [],
      );
    const had = new Set([...old.members.map(key), ...rights(old.members)]);
    const has = new Set(circle.members.map(key));
    if (
      [...circle.members.map(key), ...rights(circle.members)].some((entry) => !had.has(entry)) ||
      // In an "all must match" circle, a member that goes lets more visitors in.
      (old.match === "all" && old.members.some((member) => !has.has(key(member)))) ||
      (old.needsPasskey && !circle.needsPasskey) ||
      (old.approvesWithoutPasskey !== true && circle.approvesWithoutPasskey === true) ||
      (old.match === "all" && circle.match === "any") ||
      ends(circle.endsAt) > ends(old.endsAt) ||
      levelRank(circle.level) > levelRank(old.level)
    )
      throw new RuleError(
        `While paused, access only goes down: the circle ${circle.name} would let in more.`,
      );
  }
}

/**
 * K-1502: the changes that an undo of `original` commits, after every check that a write runs: the values are
 * still the ones the revision set, no card becomes public without the question of K-210 (which an undo does
 * not ask), the rules of K-105 and K-521, and the pause (K-1504). The Compose stop of K-909 depends on live
 * jobs, so the worker checks it when it commits. In the undo of an expiry, a passed end time goes (K-209, K-212).
 */
export function prepareUndo(state: State, original: ReadonlyArray<Change>, now: number): Array<Change> {
  const reversed = invert(original);
  const placed = new Set(
    reversed.flatMap((change) => (change._tag === "place" && change.after !== null ? [change.id] : [])),
  );
  const inverted = reversed.map((change) => withoutPastEnd(change, now, placed));
  const conflict = conflictOf(state, inverted);
  if (conflict?._tag === "app")
    throw new RuleError(
      `A later deploy or removal changed the app "${conflict.id}", so this undo no longer fits (K-909).`,
    );
  if (conflict)
    throw new RuleError(`${conflict._tag} "${conflict.id}" changed since, so this undo no longer fits.`);
  // A card that joined a stack since then takes its stack along (K-521).
  const changes = refuseResume(withStackMates(state, inverted));
  const after = applyChanges(state, changes);
  const own = new Set(inverted.flatMap((change) => (change._tag === "place" ? [change.id] : [])));
  const goingPublic = shareDiff(state, after).find(
    (diff) => !own.has(diff.resource.id) && diff.to && !diff.from && isPublicCircle(diff.circle),
  );
  if (goingPublic) {
    const { resource, circle } = goingPublic;
    const stacked = [...state.stacks.values()].some((stack) => stack.members.includes(resource.id));
    throw new RuleError(
      stacked
        ? `This undo would make ${resource.name} public in ${circle.name} through its stack. Move the stack by hand.`
        : `This undo would make ${resource.name} public in ${circle.name}. An undo never does that without asking; share it by hand.`,
    );
  }
  const violation = ruleViolation(after);
  if (violation) throw new RuleError(violation);
  refuseRaiseWhilePaused(state, after);
  return changes;
}

/**
 * K-523, K-1507, K-1508: whether the undo of a revision or the per-item undo of `actor` works now, or why
 * kitshn refuses it.
 */
export function undoAnswer(
  state: State,
  revisions: ReadonlyArray<StoredRevision>,
  actor: Author,
  target: { readonly revision: number } | { readonly item: Item },
  now: number,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  try {
    prepareUndo(state, undoTarget(state, revisions, actor, target).changes, now);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof RuleError)) throw error;
    return { allowed: false, reason: error.message };
  }
}
