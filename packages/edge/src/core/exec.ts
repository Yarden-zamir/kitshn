// K-722: exec on another machine through kitshn, and the data migration that ends the `t3.agents` kind. Pure, for
// tests; the Durable Object relays the frames and keeps the runs.
import { cardsControlledBy, machineRightMode } from "./agent.ts";
import type { Change } from "./changes.ts";
import {
  type Circle,
  type Level,
  type MachineRight,
  type Member,
  type Point,
  type RightMode,
  type ShareSetting,
  type State,
  circlesHolding,
  insideCircle,
  shareKey,
} from "./model.ts";

const RUNS_COMMANDS: MachineRight = "runsCommands";

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
 * K-721, K-722: the machines whose "runs commands" covers `targetId` at automatic with no label conditions, sorted.
 * `check` gives their tokens the `exec` right, so one rule covers exec and a terminal that another machine starts.
 */
export function execMachinesOf(state: State, targetId: string, now: number): Array<string> {
  return [...state.machines.keys()]
    .filter((sourceId) => {
      if (!mayExecOn(state, sourceId, targetId, now)) return false;
      const mode = machineRightMode(state, sourceId, RUNS_COMMANDS, now);
      return mode?.mode === "automatic" && (mode.conditions ?? []).length === 0;
    })
    .sort();
}

/** K-1610: the audit names the command, never its arguments: its first word, at most 100 characters. */
export const commandName = (command: string) =>
  (command.trim().split(/\s+/)[0] ?? "").slice(0, 100) || "(empty)";

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
 * K-722, migration 43: each circle that holds a `t3.agents` card now holds the `t3.app` card of the same machine, at
 * the same level, so each link stays. Where that share was at `control` (the old `exec` level), each machine of the
 * circle gets "runs commands" at automatic, unless the owner set it to off. A card in a stack does not move: its
 * stack shares one point, so the migration names it in `unmet` for the owner.
 */
export function migrateAgentShares(state: State): AgentsMigration {
  const places = new Map<string, Point>();
  const shareSettings = new Map<string, ShareSetting>();
  const circles = new Map<string, Circle>();
  const unmet: Array<string> = [];
  const stacked = new Set([...state.stacks.values()].flatMap((stack) => stack.members));
  for (const agents of state.resources.values()) {
    if (agents.kind !== "t3.agents" || agents.machine === null) continue;
    const holding = circlesHolding(state, agents.id);
    if (holding.length === 0) continue;
    const app = [...state.resources.values()].find(
      (card) => card.kind === "t3.app" && card.machine === agents.machine && card.provider?.name === "t3",
    );
    const machineName = state.machines.get(agents.machine)?.name ?? agents.machine;
    if (!app) {
      unmet.push(`${machineName} has no T3 app card, so its T3 agents shares end.`);
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
          `The T3 app card of ${machineName} could not move into ${holding.map((circle) => circle.name).join(", ")}; share it there by hand.`,
        );
        continue;
      }
      places.set(app.id, point);
    }
    for (const circle of holding) {
      const level = levelIn(circle);
      // The app keeps its own level where a circle held both cards.
      if (!appCircles.has(circle.id) && level !== circle.level)
        shareSettings.set(shareKey(app.id, circle.id), {
          level,
          endsAt: state.shareSettings.get(shareKey(agents.id, circle.id))?.endsAt ?? null,
        });
      if (level !== "control") continue;
      const current = circles.get(circle.id) ?? circle;
      const next = {
        ...current,
        members: current.members.map((member): Member => {
          if (member._tag !== "machine" || member.machineId === agents.machine) return member;
          const mode: RightMode | undefined = member.rights?.runsCommands;
          if (mode?.mode === "off" || mode?.mode === "automatic") return member;
          return { ...member, rights: { ...member.rights, runsCommands: { mode: "automatic" } } };
        }),
      };
      if (next.members.some((member, index) => member !== current.members[index]))
        circles.set(circle.id, next);
    }
  }
  return {
    changes: [
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
