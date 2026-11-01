// K-722: exec on another machine through kitshn, and the data migration that ends the `t3.agents` kind. Pure, for
// tests; the Durable Object relays the frames and keeps the runs.
import { cardsControlledBy, machineRightMode } from "./agent.ts";
import { type Change, applyChanges } from "./changes.ts";
import {
  type Circle,
  type Level,
  type Right,
  type Member,
  type Point,
  type ShareSetting,
  type State,
  circlesHolding,
  insideCircle,
  machineOfMember,
  shareKey,
} from "./model.ts";

const RUNS_COMMANDS: Right = "runsCommands";

/**
 * K-722: machine A may run commands on machine B when an agent circle of A holds B's machine card, or a provider card
 * on B, at `control`. The mode of "runs commands" then decides: automatic, ask a circle, or off.
 */
export function mayExecOn(state: State, sourceId: string, targetId: string, now: number): boolean {
  const source = state.machines.get(sourceId);
  if (!source || sourceId === targetId || !state.machines.has(targetId)) return false;
  const managed = cardsControlledBy(state, { email: null, clientId: source.clientId, ip: null }, now);
  if (managed.has(targetId)) return true;
  for (const card of state.resources.values())
    if (card.machine === targetId && card.provider && managed.has(card.id)) return true;
  return false;
}

/**
 * K-722: the provider on B whose exec user runs a command of A. kitshn picks it from the cards that A controls, so A
 * never chooses a user on B beyond what it controls: the provider of the provider cards on B that A controls, or none
 * (B's own rule, the daemon user only on a machine without provider users) when A controls only B's machine card.
 * When A controls cards of several providers, A names one (`wanted`), and kitshn takes it only when A controls a card
 * of it.
 */
export function execProviderOn(
  state: State,
  sourceId: string,
  targetId: string,
  now: number,
  wanted: string | null = null,
): { readonly provider: string | null } | { readonly refused: string } {
  const source = state.machines.get(sourceId);
  if (!source || !mayExecOn(state, sourceId, targetId, now)) return { refused: "no card" };
  const managed = cardsControlledBy(state, { email: null, clientId: source.clientId, ip: null }, now);
  const providers = new Set(
    [...state.resources.values()].flatMap((card) =>
      card.machine === targetId && card.provider && managed.has(card.id) ? [card.provider.name] : [],
    ),
  );
  if (wanted !== null)
    return providers.has(wanted)
      ? { provider: wanted }
      : { refused: `${source.name} controls no card of the provider ${wanted} on that machine.` };
  if (providers.size > 1)
    return {
      refused: `${source.name} controls cards of ${[...providers].sort().join(" and ")} on that machine; name one with targetProvider.`,
    };
  return { provider: [...providers][0] ?? null };
}

/**
 * K-721, K-722: the machines whose "runs commands" covers `targetId` at automatic with no label conditions, sorted.
 * `check` gives their tokens the `exec` right, so one rule covers exec and a terminal that another machine starts.
 */
export function execMachinesOf(state: State, targetId: string, now: number): Array<string> {
  return [...state.machines.keys()]
    .filter((sourceId) => {
      if (!mayExecOn(state, sourceId, targetId, now)) return false;
      // A bare machine call carries no labels, so only a chip of the machine actor itself counts (K-1778).
      return machineRightMode(state, sourceId, RUNS_COMMANDS, now, null)?.mode === "automatic";
    })
    .sort();
}

const NAME_START = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";
const NAME_CHARS = `${NAME_START}0123456789`;
/** A shell assignment such as `GITHUB_TOKEN=x`: a variable name, then `=`. */
const isAssignment = (word: string) => {
  const equals = word.indexOf("=");
  return (
    equals > 0 &&
    NAME_START.includes(word[0]!) &&
    Array.from(word.slice(1, equals)).every((char) => NAME_CHARS.includes(char))
  );
};

/**
 * K-1610: the audit names the command, never its arguments: its first word after any leading `NAME=value`
 * assignments, whose values can be secrets, at most 100 characters.
 */
export const commandName = (command: string) =>
  (
    command
      .trim()
      .split(/\s+/)
      .find((word) => !isAssignment(word)) ?? ""
  ).slice(0, 100) || "(empty)";

/** K-722: how an exec run ended, for History. */
export const execOutcome = (exit: { readonly exitCode: number | null; readonly reason: string | null }) =>
  exit.exitCode === 0 ? "succeeded" : exit.reason?.startsWith("refused") ? "refused" : "failed";

/** K-722: the edits of the `t3.agents` migration, as one History revision; `unmet` names each share that it left. */
export interface AgentsMigration {
  readonly changes: ReadonlyArray<Change>;
  readonly unmet: ReadonlyArray<string>;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/** A point that lies inside exactly the circles of `wanted`, near `start`; null when the circles leave none. */
function pointIn(state: State, wanted: ReadonlySet<string>, start: Point): Point | null {
  const circles = [...state.circles.values()];
  const fits = (point: Point) =>
    sameSet(
      new Set(circles.filter((circle) => insideCircle(point, circle)).map((circle) => circle.id)),
      wanted,
    );
  if (fits(start)) return start;
  const inner = circles.filter((circle) => wanted.has(circle.id));
  // A search on a grid over the smallest wanted circle; circles are few, so this stays cheap.
  const smallest = inner.reduce<Circle | null>(
    (best, circle) => (best && best.r <= circle.r ? best : circle),
    null,
  );
  if (!smallest) return null;
  const steps = 40;
  let best: Point | null = null;
  for (let row = 0; row <= steps; row++)
    for (let column = 0; column <= steps; column++) {
      const point = {
        x: smallest.x - smallest.r + (2 * smallest.r * column) / steps,
        y: smallest.y - smallest.r + (2 * smallest.r * row) / steps,
      };
      if (!fits(point)) continue;
      if (
        !best ||
        Math.hypot(point.x - start.x, point.y - start.y) < Math.hypot(best.x - start.x, best.y - start.y)
      )
        best = point;
    }
  return best;
}

/**
 * K-722, migration 42: each circle of machines only that holds a `t3.agents` card now holds the `t3.app` card of the
 * same machine, at the same level, so each link stays. A circle that also holds people, devices, networks or
 * Everyone gets nothing, because `t3.app` would give them T3 itself. Where the share was at `control` (the old
 * `exec` level), a machine of the circle gets "runs commands" at automatic only when the right is unset there, and
 * only when that covers no machine but the old targets; the right belongs to the source machine, not to one target.
 * A card in a stack does not move, because its stack shares one point. `unmet` names each share and right that it
 * left, for the owner.
 */
export function migrateAgentShares(state: State): AgentsMigration {
  const places = new Map<string, Point>();
  const shareSettings = new Map<string, ShareSetting>();
  const unmet: Array<string> = [];
  /** By source machine: the circles where its right would turn on, and the machines that it ran commands on. */
  const rights = new Map<string, { circles: Set<string>; targets: Set<string> }>();
  const stacked = new Set([...state.stacks.values()].flatMap((stack) => stack.members));
  const nameOf = (machineId: string) => state.machines.get(machineId)?.name ?? machineId;
  for (const agents of state.resources.values()) {
    if (agents.kind !== "t3.agents" || agents.machine === null) continue;
    const target = agents.machine;
    const all = circlesHolding(state, agents.id);
    const holding = all.filter((circle) =>
      circle.members.every((member) => machineOfMember(state, member) !== null),
    );
    for (const circle of all)
      if (!holding.includes(circle))
        unmet.push(
          `${circle.name} holds more than machines, so the T3 app card of ${nameOf(target)} does not move into it; share it there by hand if its members need T3.`,
        );
    if (holding.length === 0) continue;
    const app = [...state.resources.values()].find(
      (card) => card.kind === "t3.app" && card.machine === target && card.provider?.name === "t3",
    );
    if (!app) {
      unmet.push(`${nameOf(target)} has no T3 app card, so its T3 agents shares end.`);
      continue;
    }
    const levelIn = (circle: Circle): Level =>
      state.shareSettings.get(shareKey(agents.id, circle.id))?.level ?? circle.level;
    const appCircles = new Set(circlesHolding(state, app.id).map((circle) => circle.id));
    const wanted = new Set([...appCircles, ...holding.map((circle) => circle.id)]);
    if (!sameSet(wanted, appCircles)) {
      const point = stacked.has(app.id)
        ? null
        : pointIn(state, wanted, state.places.get(app.id) ?? state.places.get(agents.id)!);
      if (!point) {
        unmet.push(
          `The T3 app card of ${nameOf(target)} could not move into ${holding.map((circle) => circle.name).join(", ")}; share it there by hand.`,
        );
        continue;
      }
      places.set(app.id, point);
    }
    for (const circle of holding) {
      const level = levelIn(circle);
      // The app keeps its own share where a circle held both cards. Else it gets the level and the end date of the
      // agents share; a share that ended at a date must not become permanent.
      const endsAt = state.shareSettings.get(shareKey(agents.id, circle.id))?.endsAt ?? null;
      if (!appCircles.has(circle.id) && (level !== circle.level || endsAt !== null))
        shareSettings.set(shareKey(app.id, circle.id), {
          level: level === circle.level ? null : level,
          endsAt,
        });
      if (level !== "control") continue;
      for (const member of circle.members) {
        const source = machineOfMember(state, member);
        if (
          member._tag === "actor" &&
          source !== null &&
          source !== target &&
          member.rights?.runsCommands === undefined
        ) {
          const entry = rights.get(source) ?? { circles: new Set(), targets: new Set() };
          entry.circles.add(circle.id);
          entry.targets.add(target);
          rights.set(source, entry);
        }
      }
    }
  }
  const moved: ReadonlyArray<Change> = [
    ...[...places].map(([id, after]): Change => ({
      _tag: "place",
      id,
      before: state.places.get(id) ?? null,
      after,
    })),
    ...[...shareSettings].map(([id, after]): Change => ({
      _tag: "shareSetting",
      id,
      before: state.shareSettings.get(id) ?? null,
      after,
    })),
  ];
  const circles = new Map<string, Circle>();
  for (const [source, { circles: ids, targets }] of rights) {
    const withRight = (circle: Circle): Circle => ({
      ...circle,
      members: circle.members.map((member): Member =>
        member._tag === "actor" && machineOfMember(state, member) === source
          ? { ...member, rights: { ...member.rights, runsCommands: { mode: "automatic" } } }
          : member,
      ),
    });
    const changed = [...ids].map((id) => withRight(circles.get(id) ?? state.circles.get(id)!));
    const after = applyChanges(state, [
      ...moved,
      ...changed.map((circle): Change => ({
        _tag: "circle",
        id: circle.id,
        before: state.circles.get(circle.id) ?? null,
        after: circle,
      })),
    ]);
    const covered = [...after.machines.keys()].filter((machineId) => mayExecOn(after, source, machineId, 0));
    const extra = covered.filter((machineId) => !targets.has(machineId));
    if (extra.length > 0) {
      unmet.push(
        `"Runs commands" of ${nameOf(source)} stays unset: automatic would also cover ${extra.map(nameOf).join(", ")}. Set it by hand.`,
      );
      continue;
    }
    for (const circle of changed) circles.set(circle.id, circle);
  }
  return {
    changes: [
      ...moved,
      ...[...circles].map(([id, after]): Change => ({
        _tag: "circle",
        id,
        before: state.circles.get(id) ?? null,
        after,
      })),
    ],
    unmet,
  };
}
