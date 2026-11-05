import { circlePolicies } from "./access.ts";
import {
  type Level,
  type Resource,
  type State,
  activeShares,
  isPublicCircle,
  machineOfMember,
} from "./model.ts";
import { type Visitor, circleMatches, visitorLevel } from "./visitor.ts";

/** Where a reach line starts: a card on the map, or the head of a circle for its members without a card. */
export type ReachEnd =
  { readonly _tag: "card"; readonly id: string } | { readonly _tag: "circle"; readonly id: string };

/** K-537: one line of the relationship lens. */
export interface ReachLine {
  readonly from: ReachEnd;
  readonly to: string;
  /** What `from` gets on `to`, or null when `from` only runs `to`. */
  readonly level: Level | null;
  /** `from` is the machine that `to` runs on (K-304). */
  readonly runs: boolean;
  /** The circles that give the level. */
  readonly via: ReadonlyArray<string>;
  /** For a line from a circle head: how many members of the circle it stands for. */
  readonly members: number;
}

const machineVisitor = (clientId: string): Visitor => ({ email: null, clientId, ip: null });

/**
 * K-537: what reaches the card and what the card reaches. Levels come from the check that Access mirrors
 * (`visitorLevel`), so the lens never shows more than kitshn lets through. Only cards on the map count, and
 * each pair of ends has one line.
 */
export function reachOf(state: State, cardId: string, now: number): Array<ReachLine> {
  const card = state.resources.get(cardId);
  if (!card || !state.places.has(cardId)) return [];
  const lines = new Map<string, ReachLine>();
  const add = (line: ReachLine) => {
    const key = `${line.from._tag}:${line.from.id}>${line.to}`;
    const before = lines.get(key);
    lines.set(
      key,
      before ? { ...before, level: before.level ?? line.level, runs: before.runs || line.runs } : line,
    );
  };
  // A machine line names the circles that give its level. A level that only public circles give is no line: the
  // Everyone head already says that anyone reaches the card.
  const reached = (from: ReachEnd, to: Resource, visitor: Visitor) => {
    const level = visitorLevel(state, to, visitor, now);
    const via = activeShares(state, to, now)
      .filter((share) => share.level === level && circleMatches(share.circle, visitor, state))
      .map((share) => share.circle);
    if (level && !via.every(isPublicCircle))
      add({ from, to: to.id, level, runs: false, via: via.map((circle) => circle.name), members: 0 });
  };

  // In: each machine with a card on the map by its own token, then one line per circle for its other members.
  const placedMachines = [...state.machines.values()].filter(
    (machine) => machine.id !== cardId && state.places.has(machine.id),
  );
  for (const machine of placedMachines)
    reached({ _tag: "card", id: machine.id }, card, machineVisitor(machine.clientId));
  const placed = new Set(placedMachines.map((machine) => machine.id));
  for (const share of activeShares(state, card, now)) {
    // K-402: a circle that Access makes no policy for, such as "all must match" a machine and a person, lets no one in.
    if (circlePolicies(share.circle, state).size === 0) continue;
    // K-203: "all must match" members get in only together, so the line stands for all of them.
    const others =
      share.circle.match === "all"
        ? share.circle.members
        : share.circle.members.filter((member) => {
            const machineId = machineOfMember(state, member);
            return machineId === null || (machineId !== cardId && !placed.has(machineId));
          });
    if (others.length === 0) continue;
    add({
      from: { _tag: "circle", id: share.circle.id },
      to: cardId,
      level: share.level,
      runs: false,
      via: [share.circle.name],
      members: others.length,
    });
  }
  if (card.machine !== null && state.places.has(card.machine)) {
    add({
      from: { _tag: "card", id: card.machine },
      to: cardId,
      level: null,
      runs: true,
      via: [],
      members: 0,
    });
  }

  // Out: what the machine's token opens, and the cards that run on it.
  const self = card.kind === "machine" ? state.machines.get(cardId) : undefined;
  if (!self) return [...lines.values()];
  const from: ReachEnd = { _tag: "card", id: cardId };
  for (const other of state.resources.values()) {
    if (other.id === cardId || !state.places.has(other.id)) continue;
    reached(from, other, machineVisitor(self.clientId));
    if (other.machine === cardId) add({ from, to: other.id, level: null, runs: true, via: [], members: 0 });
  }
  return [...lines.values()];
}

/** K-537: what a level lets its holder do on a built-in kind. A provider kind names its own (K-005), so none. */
export type Capability = "open" | "exec";

export function capabilitiesOf(
  resource: Pick<Resource, "kind" | "provider" | "addresses">,
  level: Level,
): Array<Capability> {
  if (resource.provider) return [];
  // K-614: a shell command needs `control` on the machine.
  if (resource.kind === "machine") return level === "control" ? ["exec"] : [];
  return resource.addresses.length > 0 ? ["open"] : [];
}

/**
 * The next time after `now` that a share ends: a circle end (K-201), a share end (K-209) or a card end (K-212). The
 * map draws shares again then, because the expiry revision can come later than the end.
 */
export function nextEnd(state: State, now: number): number | null {
  const ends = [
    ...[...state.circles.values()].map((circle) => circle.endsAt),
    ...[...state.shareSettings.values()].map((setting) => setting.endsAt),
    ...state.ends.values(),
  ].filter((end): end is number => end !== null && end > now);
  return ends.length > 0 ? Math.min(...ends) : null;
}
