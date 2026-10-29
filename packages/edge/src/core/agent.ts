import type { Change } from "./changes.ts";
import type { Command } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type AgentRight,
  CIRCLE_ALONE_KEY,
  type Circle,
  EVERYONE_CIRCLE_ID,
  type MachineRight,
  type Member,
  type OpenRightMode,
  type Point,
  type RightMode,
  type State,
  activeShares,
  circlesHolding,
  circlesOverlap,
  isPublicCircle,
  shareKey,
  type CardKind,
} from "./model.ts";
import { placeInside } from "./place.ts";
import { coveringCards } from "./repoGroups.ts";
import { type Visitor, circleMatches, visitorLevel } from "./visitor.ts";

/** K-718, K-1730: true when the member is the agent that the visitor is: an agent key, or a machine by its token. */
/**
 * K-718, K-1730: true when the member is the agent that the visitor is: an agent key, or a machine by its token. A machine
 * counts only where the owner set one of its rights, so an older circle of machines gives them nothing new.
 */
const namesAgent = (state: State, member: Member, visitor: Visitor) =>
  (member._tag === "device" && member.clientId === visitor.clientId) ||
  (member._tag === "machine" &&
    visitor.clientId !== null &&
    state.machines.get(member.machineId)?.clientId === visitor.clientId &&
    Object.values(member.rights ?? {}).some((mode) => mode !== undefined));

/**
 * K-718: the agent circles of a device: circles of devices only that name it, have not ended, and that it matches.
 * K-1730: a machine's agent circles may also hold machines; an agent key keeps exactly its old circles, so a machine
 * in a circle gives a key no new control. A circle with people, networks, domains or Everyone is never an agent
 * circle, so an agent cannot move a card to anyone but other devices and machines, except a site that it added
 * into Everyone (agentRefusal).
 */
export const circlesOf = (state: State, visitor: Visitor, now: number) => {
  const machine = machineOf(state, visitor) !== undefined;
  return new Set(
    visitor.clientId === null
      ? []
      : [...state.circles.values()]
          .filter(
            (circle) =>
              circle.members.every(
                (member) => member._tag === "device" || (machine && member._tag === "machine"),
              ) &&
              circle.members.some((member) => namesAgent(state, member, visitor)) &&
              (circle.endsAt === null || circle.endsAt > now) &&
              circleMatches(circle, visitor, state.machines),
          )
          .map((circle) => circle.id),
  );
};

/**
 * K-1720, K-1730: the mode of one right of a machine through its agent circles: "automatic" from any circle wins,
 * else the first "ask <circle>". Null means off.
 */
export function machineRightMode(
  state: State,
  machineId: string,
  right: MachineRight,
  now: number,
): OpenRightMode | null {
  return pickMode(machineModes(state, machineId, right, now));
}

/** K-1776: true when a circle of the machine sets this right to "off", so a call refuses instead of asking the Owner. */
export const machineRightOff = (state: State, machineId: string, right: MachineRight, now: number) =>
  machineModes(state, machineId, right, now).some((mode) => mode.mode === "off") &&
  machineRightMode(state, machineId, right, now) === null;

function machineModes(state: State, machineId: string, right: MachineRight, now: number): Array<RightMode> {
  const machine = state.machines.get(machineId);
  if (!machine) return [];
  const visitor = { email: null, clientId: machine.clientId, ip: null };
  return [...circlesOf(state, visitor, now)].flatMap((id) =>
    (state.circles.get(id)?.members ?? []).flatMap((member) => {
      const mode =
        member._tag === "machine" && member.machineId === machineId ? member.rights?.[right] : undefined;
      return mode ? [mode] : [];
    }),
  );
}

/** K-1720: automatic wins over ask; "off" never lets a call through. */
const pickMode = (modes: ReadonlyArray<RightMode>): OpenRightMode | null => {
  const open = modes.filter((mode): mode is OpenRightMode => mode.mode !== "off");
  return open.find((mode) => mode.mode === "automatic") ?? open[0] ?? null;
};

/** K-1730: the machine whose token the visitor carries, or undefined for a person or an agent key. */
export const machineOf = (state: State, visitor: Visitor) =>
  visitor.clientId === null
    ? undefined
    : [...state.machines.values()].find((machine) => machine.clientId === visitor.clientId);

/**
 * K-718: a key has a right when one of its agent circles names it with that right. Both are off by default.
 * K-1720: a machine has it when the right is "automatic", or when an approval of its circle (`approved`) gave it
 * for this one ask.
 */
export function agentHas(
  state: State,
  visitor: Visitor,
  right: AgentRight,
  now: number,
  approved: MachineRight | null = null,
) {
  const machine = machineOf(state, visitor);
  // K-1723, K-1776: an approval of exactly this call counts also for a right that no circle sets; "off" never gets
  // this far, because the approval refuses first (proposalGone).
  if (machine)
    return approved === right || machineRightMode(state, machine.id, right, now)?.mode === "automatic";
  return [...circlesOf(state, visitor, now)].some((id) =>
    state.circles
      .get(id)
      ?.members.some(
        (member) => member._tag === "device" && member.clientId === visitor.clientId && member[right],
      ),
  );
}

/**
 * K-819: the circle where a new card of a repo that an agent key allowed starts: its first agent circle at
 * the level `control`, so the key manages the card. Undefined sends the card to the tray.
 */
export const agentHomeCircle = (state: State, clientId: string, now: number) =>
  controlCircles(state, { email: null, clientId, ip: null }, now)[0];

/** K-718: the agent circles of a key at the level `control`, in map order. */
const controlCircles = (state: State, visitor: Visitor, now: number) =>
  [...circlesOf(state, visitor, now)]
    .flatMap((id) => state.circles.get(id) ?? [])
    .filter((circle) => circle.level === "control");

/**
 * K-819: a Compose app of a repo that an agent key allowed runs only on a machine where that key may run jobs
 * (K-718). A repo that the owner allowed (`allowedBy` null) may use every machine with the label `deploy`.
 */
export const mayDeployOn = (state: State, allowedBy: string | null, machineId: string, now: number) =>
  allowedBy === null || agentMayRunOn(state, { email: null, clientId: allowedBy, ip: null }, machineId, now);

/**
 * K-718: the cards that a device manages: one of its own circles holds the card at the circle level
 * `control` (or a `control` override). This is the level of the circle, before a kind cuts it down: a site
 * has only `view` (K-301), and an agent key still manages it.
 */
export function cardsControlledBy(state: State, visitor: Visitor, now: number) {
  const own = circlesOf(state, visitor, now);
  return new Set(
    [...state.resources.values()]
      .filter((resource) =>
        activeShares(state, resource, now).some(
          (share) => own.has(share.circle.id) && levelIn(state, resource.id, share.circle) === "control",
        ),
      )
      .map((resource) => resource.id),
  );
}

/** The level a circle gives a card: its override, or the circle level, before the kind cuts it down. */
const levelIn = (state: State, resourceId: string, circle: Circle) =>
  state.shareSettings.get(shareKey(resourceId, circle.id))?.level ?? circle.level;

/**
 * K-718: an agent key runs jobs on a machine only when it manages the machine card, every card that runs on
 * the machine, and every card that the machine's own token opens (K-107), because a shell there reaches all.
 */
export function agentMayRunOn(state: State, visitor: Visitor, machineId: string, now: number) {
  const managed = cardsControlledBy(state, visitor, now);
  const machine = state.machines.get(machineId);
  const token = { email: null, clientId: machine?.clientId ?? null, ip: null };
  return (
    machine !== undefined &&
    managed.has(machineId) &&
    [...state.resources.values()].every(
      (resource) =>
        managed.has(resource.id) ||
        (resource.machine !== machineId && visitorLevel(state, resource, token, now) === null),
    )
  );
}

/** K-718: the kinds that an agent key may publish. A live site serves a dev server on a machine, so never. */
// K-1116: a page or a file that the key published itself may become public too, as an app of a repo that it allowed.
const PUBLISHABLE: ReadonlySet<CardKind> = new Set([
  "site.static",
  "site.worker",
  "site.compose",
  "page",
  "file",
]);

/** K-718: the Everyone circle as the seed makes it: public to all, with no other member, not repurposed. */
export const isEveryoneCircle = (circle: Circle) =>
  circle.id === EVERYONE_CIRCLE_ID &&
  isPublicCircle(circle) &&
  circle.match === "any" &&
  circle.members.length === 1;

/**
 * K-718: why an agent key may not make these changes, or null. It may only move cards that it controls, and
 * only from and to places inside its agent circles at the level `control`, or out of every circle. Circles,
 * members, stacks, levels and the pause stay with the admin. These are the resolved changes, so the other
 * cards of a stack that a move takes along (K-521) pass the same check.
 *
 * A card that the key added (`added`: the cards of repos that it allowed, K-819) may also sit in the Everyone
 * circle, but only together with one of its agent circles at `control`, so the key keeps managing it. Only a
 * key that "publishes" moves such a card into Everyone; any key may take it out again.
 */
export function agentRefusal(
  state: State,
  after: State,
  visitor: Visitor,
  changes: ReadonlyArray<Change>,
  now: number,
  added: ReadonlySet<string>,
  approved: MachineRight | null = null,
) {
  const controlled = cardsControlledBy(state, visitor, now);
  const own = circlesOf(state, visitor, now);
  const publishes = agentHas(state, visitor, "publishes", now, approved);
  for (const edit of changes) {
    if (edit._tag !== "place") return `An agent key may only move cards; it cannot change a ${edit._tag}.`;
    if (!controlled.has(edit.id))
      return `This key has no control on the card "${state.resources.get(edit.id)?.name ?? edit.id}".`;
    const kind = state.resources.get(edit.id)?.kind;
    const publishable = added.has(edit.id) && kind !== undefined && PUBLISHABLE.has(kind);
    for (const side of [state, after]) {
      const holding = circlesHolding(side, edit.id);
      const mayBePublic = publishable && (side === state || publishes);
      const foreign = holding.find(
        (circle) =>
          !(mayBePublic && isEveryoneCircle(circle)) &&
          (!own.has(circle.id) || levelIn(side, edit.id, circle) !== "control"),
      );
      if (foreign)
        return `An agent key moves cards only between its own agent circles with control${publishes ? ", and the sites that it added into Everyone" : ""}, and "${foreign.name}" is not one of them.`;
      const keeps = holding.some(
        (circle) => own.has(circle.id) && levelIn(side, edit.id, circle) === "control",
      );
      if (side === after && holding.some(isEveryoneCircle) && !keeps)
        return publishRefusal(state, visitor, now);
    }
  }
  return null;
}

/** K-718: why a published card would leave every agent circle of the key. */
function publishRefusal(state: State, visitor: Visitor, now: number) {
  const everyone = [...state.circles.values()].find(isEveryoneCircle);
  const overlaps = controlCircles(state, visitor, now).some(
    (circle) => everyone !== undefined && circlesOverlap(circle, everyone),
  );
  return overlaps
    ? "Publish into the overlap of an agent circle and Everyone, so the key keeps managing the card."
    : `No agent circle of this key overlaps Everyone. Ask the owner to ${CIRCLE_ALONE_KEY.mac.label}-drag (on a Mac, iPad or iPhone) or ${CIRCLE_ALONE_KEY.other.label}-drag (on other systems) the head of the Agents circle, which moves the circle alone, so it overlaps Everyone and its cards stay in place.`;
}

/**
 * K-1116: where a page or a file that an agent key publishes lands: in the tray without a circle, else inside exactly
 * `circleId`, which must be one of its agent circles at `control`. With `publish`, in the overlap of that circle (or
 * its first agent circle) and Everyone, which needs "may publish" (K-718). It keeps clear of the cards on the map.
 * A string names why not.
 */
export function agentUploadPlace(
  state: State,
  visitor: Visitor,
  circleId: string | null,
  publish: boolean,
  now: number,
  approved: MachineRight | null = null,
): Point | null | string {
  if (circleId === null && !publish) return null;
  const homes = controlCircles(state, visitor, now);
  const home =
    circleId === null ? homes[0] : homes.find((circle) => circle.id === circleId || circle.name === circleId);
  if (!home)
    return circleId === null
      ? "This key has no agent circle with control to publish from (K-718)."
      : `"${circleId}" is not an agent circle of this key with control (K-718).`;
  const taken = [...state.places.values()];
  if (!publish)
    return (
      placeInside(state, home, new Set([home.id]), taken) ??
      `kitshn finds no free spot inside "${home.name}".`
    );
  if (!agentHas(state, visitor, "publishes", now, approved))
    return 'This key may not publish. The owner turns on "may publish" for it (K-718).';
  const everyone = [...state.circles.values()].find(isEveryoneCircle);
  if (!everyone) return "The map has no Everyone circle.";
  return (
    placeInside(state, home, new Set([home.id, everyone.id]), taken) ?? publishRefusal(state, visitor, now)
  );
}

/** K-718: a device member in an agent circle, without the admin card. The map calls it an agent. */
export function isAgentKey(state: State, member: Member, now: number): boolean {
  if (member._tag !== "device") return false;
  const visitor = { email: null, clientId: member.clientId, ip: null };
  const admin = state.resources.get(ADMIN_RESOURCE_ID);
  // The pause takes every device off the admin for a while; that does not make the owner's devices agents.
  const unpaused = { ...state, paused: null };
  return (
    circlesOf(state, visitor, now).size > 0 &&
    (!admin || visitorLevel(unpaused, admin, visitor, now) !== "control")
  );
}

/** A pull request environment is always `pr-<n>` (K-807). */
export const isPreview = (environment: string) => /^pr-\d+$/.test(environment);

/** The last finished deploy of a card, as kitshn stores it (K-807, K-812). */
export interface LastDeploy {
  readonly app: "static" | "compose" | "worker";
  readonly repo: string;
  readonly branch: string;
  readonly resourceId: string;
  readonly environment: string;
  /** The address without the zone, which the daemon exposes. */
  readonly name: string;
  readonly composeFile: string | null;
}

/**
 * K-718: what a deploy by an agent key does. `redeploy` starts the last build that came up, from the copy
 * on the machine; `build` runs the repo's own workflow on the environment's branch. Neither takes code from
 * the key (K-812).
 */
export function agentDeployPlan(
  last: LastDeploy | null,
  mode: "redeploy" | "build",
  machine: {
    /** The daemon knows `compose-redeploy`. */
    readonly canRedeploy: boolean;
    /** The owner still lets deploys run there (K-610). */
    readonly takesDeploys: boolean;
    /** The card still runs on that machine (K-611). */
    readonly runsCard: boolean;
    /** K-818: the risky Compose settings that the machine allows for this repo. */
    readonly allowed: ReadonlyArray<string>;
  } | null,
):
  | { readonly kind: "redeploy"; readonly command: Extract<Command, { kind: "compose-redeploy" }> }
  | { readonly kind: "build"; readonly repo: string; readonly branch: string }
  | { readonly kind: "refused"; readonly status: 409; readonly error: string } {
  const refused = (error: string) => ({ kind: "refused", status: 409, error }) as const;
  if (!last) return refused("kitshn has no finished deploy of this card to start again.");
  if (mode === "build") {
    // A pull request environment is always `pr-<n>` (K-807); its build comes from a push to the pull request.
    if (isPreview(last.environment))
      return refused("A preview builds again on a new push to its pull request, not from an agent key.");
    return last.branch
      ? { kind: "build", repo: last.repo, branch: last.branch }
      : refused("kitshn does not know the branch of this environment.");
  }
  if (last.app !== "compose")
    return refused(
      "A static site or Worker app keeps serving its last build; a new build comes from the repo (build).",
    );
  if (!machine || !machine.runsCard)
    return refused("This app no longer runs on the machine of its last deploy.");
  if (!machine.takesDeploys)
    return refused("The machine of this app no longer has the label deploy (K-610).");
  if (!machine.canRedeploy)
    return refused("The daemon of this app cannot redeploy yet. Update the daemon first.");
  return {
    kind: "redeploy",
    command: {
      kind: "compose-redeploy",
      allowed: machine.allowed,
      project: last.resourceId,
      name: last.name,
      environment: last.environment,
      repo: last.repo,
      file: last.composeFile,
    },
  };
}

/**
 * K-1733, K-1761: the mode of a code right of a machine for one repo. A right counts only in an agent circle that holds a
 * card covering the repo (a repo group or its repo card) at `control`. "writes code" includes "reads code". Automatic
 * from any such circle wins, else the first "ask <circle>"; null is off.
 */
export const codeRightMode = (
  state: State,
  machineId: string,
  right: "readsCode" | "writesCode",
  fullName: string,
  now: number,
): OpenRightMode | null => pickMode(codeModes(state, machineId, right, fullName, now));

/** K-1776: true when a card that covers the repo sets the code right to "off" and none lets it through. */
export const codeRightOff = (
  state: State,
  machineId: string,
  right: "readsCode" | "writesCode",
  fullName: string,
  now: number,
) =>
  codeModes(state, machineId, right, fullName, now, true).some((mode) => mode.mode === "off") &&
  codeRightMode(state, machineId, right, fullName, now) === null;

function codeModes(
  state: State,
  machineId: string,
  right: "readsCode" | "writesCode",
  fullName: string,
  now: number,
  exact = false,
): Array<RightMode> {
  const machine = state.machines.get(machineId);
  if (!machine) return [];
  const covering = coveringCards(state, fullName);
  // "writes code" includes reading for an open mode; "off" counts only for its own right (K-1776).
  const rights: ReadonlyArray<MachineRight> =
    right === "readsCode" && !exact ? ["readsCode", "writesCode"] : [right];
  const modes = [...circlesOf(state, { email: null, clientId: machine.clientId, ip: null }, now)].flatMap(
    (id) => {
      const circle = state.circles.get(id);
      if (!circle) return [];
      const holds = covering.some(
        (card) =>
          circlesHolding(state, card.id).some((held) => held.id === id) &&
          levelIn(state, card.id, circle) === "control",
      );
      if (!holds) return [];
      return circle.members.flatMap((member) =>
        member._tag === "machine" && member.machineId === machineId
          ? rights.flatMap((each) => (member.rights?.[each] ? [member.rights[each]] : []))
          : [],
      );
    },
  );
  return modes;
}
