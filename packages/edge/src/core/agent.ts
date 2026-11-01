import type { Change } from "./changes.ts";
import type { Command } from "./machine.ts";
import {
  CIRCLE_ALONE_KEY,
  type Circle,
  type Directory,
  EVERYONE_CIRCLE_ID,
  type Right,
  type Member,
  type OpenRightMode,
  type Point,
  type RightMode,
  type State,
  activeShares,
  circlesHolding,
  isPublicCircle,
  isPerson,
  memberActor,
  shareKey,
  type CardKind,
} from "./model.ts";
import { placeInside } from "./place.ts";
import { coveringCards } from "./repoGroups.ts";
import { type Attested, type Visitor, actorMatches, circleMatches, visitorLevel } from "./visitor.ts";

/**
 * K-718, K-1730, K-1778: true when the member is an actor that the proof is, with at least one right set in this circle,
 * so an older circle of machines gives them nothing new.
 */
const namesAgent = (state: State, member: Member, visitor: Visitor, attested: Attested | null) => {
  const actor = memberActor(member, state);
  return (
    member._tag === "actor" &&
    actor !== undefined &&
    Object.values(member.rights ?? {}).some((mode) => mode !== undefined) &&
    actorMatches(actor, visitor, state.machines, attested)
  );
};

/** K-718, K-1778: an agent circle holds actors that are not people, and no rule, so an agent never shares with a person. */
export const isAgentCircle = (circle: Circle, directory: Directory) =>
  circle.members.every((member) => {
    const actor = memberActor(member, directory);
    return actor !== undefined && !isPerson(actor);
  });

/**
 * K-718, K-1730: the agent circles of a proof: agent circles that name one of its actors with a right set, have not ended,
 * and that it matches. A passkey circle is never one (K-1778). So an agent cannot move a card to anyone but other agents,
 * except a site that it added into Everyone (agentRefusal).
 */
export const circlesOf = (state: State, visitor: Visitor, now: number, attested: Attested | null = null) =>
  new Set(
    visitor.clientId === null
      ? []
      : [...state.circles.values()]
          .filter(
            (circle) =>
              !circle.needsPasskey &&
              isAgentCircle(circle, state) &&
              circle.members.some((member) => namesAgent(state, member, visitor, attested)) &&
              (circle.endsAt === null || circle.endsAt > now) &&
              circleMatches(circle, visitor, state, attested),
          )
          .map((circle) => circle.id),
  );

/** K-1778: the proof of a bare machine call, from its token. */
const machineVisitor = (state: State, machineId: string): Visitor | null => {
  const machine = state.machines.get(machineId);
  return machine ? { email: null, clientId: machine.clientId, ip: null } : null;
};

/**
 * K-1720, K-1730: the mode of one right of a proof through its agent circles: "automatic" from any matched chip wins,
 * else the first "ask <circle>". Null means that no chip opens it.
 */
export const rightMode = (
  state: State,
  visitor: Visitor,
  right: Right,
  now: number,
  attested: Attested | null,
): OpenRightMode | null => pickMode(rightModes(state, visitor, right, now, attested));

/** K-1776: true when a matched chip sets this right to "off" and no matched chip opens it. */
export const rightOff = (
  state: State,
  visitor: Visitor,
  right: Right,
  now: number,
  attested: Attested | null,
) =>
  rightModes(state, visitor, right, now, attested).some((mode) => mode.mode === "off") &&
  rightMode(state, visitor, right, now, attested) === null;

/** K-1720: `rightMode` for a call of a machine's daemon, with the verified labels of the call (null: none). */
export function machineRightMode(
  state: State,
  machineId: string,
  right: Right,
  now: number,
  attested: Attested | null,
): OpenRightMode | null {
  const visitor = machineVisitor(state, machineId);
  return visitor ? rightMode(state, visitor, right, now, attested) : null;
}

/** K-1776: `rightOff` for a call of a machine's daemon. */
export const machineRightOff = (
  state: State,
  machineId: string,
  right: Right,
  now: number,
  attested: Attested | null,
) => {
  const visitor = machineVisitor(state, machineId);
  return visitor !== null && rightOff(state, visitor, right, now, attested);
};

/** K-1778: the chips of the actors that the proof is, in its agent circles. */
const matchedChips = (state: State, visitor: Visitor, now: number, attested: Attested | null) =>
  [...circlesOf(state, visitor, now, attested)].flatMap((id) =>
    (state.circles.get(id)?.members ?? []).flatMap((member) => {
      const actor = memberActor(member, state);
      return member._tag === "actor" && actor && actorMatches(actor, visitor, state.machines, attested)
        ? [{ circleId: id, member }]
        : [];
    }),
  );

function rightModes(
  state: State,
  visitor: Visitor,
  right: Right,
  now: number,
  attested: Attested | null,
): Array<RightMode> {
  return matchedChips(state, visitor, now, attested).flatMap(({ member }) => {
    const mode = member._tag === "actor" ? member.rights?.[right] : undefined;
    return mode ? [mode] : [];
  });
}

/** K-1720: automatic wins over ask; "off" never lets a call through. */
const pickMode = (modes: ReadonlyArray<RightMode>): OpenRightMode | null => {
  const open = modes.filter((mode): mode is OpenRightMode => mode.mode !== "off");
  return open.find((mode) => mode.mode === "automatic") ?? open[0] ?? null;
};

/** K-1730: the machine whose token the visitor carries, or undefined for a person or a token actor. */
export const machineOf = (state: State, visitor: Visitor) =>
  visitor.clientId === null
    ? undefined
    : [...state.machines.values()].find((machine) => machine.clientId === visitor.clientId);

/**
 * K-1720: a proof has a right when the right is "automatic" on a chip of its actors, or when an approval of its circle
 * (`approved`) gave it for this one call. K-1723, K-1776: an approval of exactly this call counts also for a right that
 * no circle sets; "off" never gets this far, because the approval refuses first (proposalGone).
 */
export function agentHas(
  state: State,
  visitor: Visitor,
  right: Right,
  now: number,
  attested: Attested | null,
  approved: ReadonlyArray<Right> = [],
) {
  return approved.includes(right) || rightMode(state, visitor, right, now, attested)?.mode === "automatic";
}

/**
 * K-819, K-1711: the agent circle of a key or a machine at the level `control` where its card goes: the first of
 * `holding` (the circles that hold the card now), else its first one. Undefined sends the card to the tray.
 */
export const agentHomeCircle = (
  state: State,
  clientId: string,
  now: number,
  holding: ReadonlyArray<Circle> = [],
  attested: Attested | null = null,
) => {
  const homes = controlCircles(state, { email: null, clientId, ip: null }, now, attested);
  return homes.find((home) => holding.some((circle) => circle.id === home.id)) ?? homes[0];
};

/** K-718: the agent circles of a key at the level `control`, in map order. */
const controlCircles = (state: State, visitor: Visitor, now: number, attested: Attested | null) =>
  [...circlesOf(state, visitor, now, attested)]
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
export function cardsControlledBy(
  state: State,
  visitor: Visitor,
  now: number,
  attested: Attested | null = null,
) {
  const own = circlesOf(state, visitor, now, attested);
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
export function agentMayRunOn(
  state: State,
  visitor: Visitor,
  machineId: string,
  now: number,
  attested: Attested | null = null,
) {
  const managed = cardsControlledBy(state, visitor, now, attested);
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

/** K-718: these commands of a machine give no shell: the Worker names the release of `update`, the rest take no input. */
export const CLOSED_COMMANDS: ReadonlySet<Command["kind"]> = new Set([
  "restart",
  "tunnel-restart",
  "update",
  "diagnostics",
]);

/**
 * K-718: whether this sender may run this command on a machine without a person. For a closed command, an agent on a
 * machine needs only the machine card. A token actor stays under the full limit.
 */
export function agentMayCommand(
  state: State,
  visitor: Visitor,
  machineId: string,
  kind: Command["kind"],
  now: number,
  attested: Attested | null = null,
) {
  return CLOSED_COMMANDS.has(kind) && machineOf(state, visitor) !== undefined
    ? state.machines.has(machineId) && cardsControlledBy(state, visitor, now, attested).has(machineId)
    : agentMayRunOn(state, visitor, machineId, now, attested);
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
  attested: Attested | null,
  approved: ReadonlyArray<Right> = [],
) {
  const controlled = cardsControlledBy(state, visitor, now, attested);
  const own = circlesOf(state, visitor, now, attested);
  const publishes = agentHas(state, visitor, "publishes", now, attested, approved);
  for (const edit of changes) {
    if (edit._tag !== "place") return `An agent may only move cards; it cannot change a ${edit._tag}.`;
    if (!controlled.has(edit.id))
      return `This agent has no control on the card "${state.resources.get(edit.id)?.name ?? edit.id}".`;
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
        return `An agent moves cards only between its own agent circles with control${publishes ? ", and the sites that it added into Everyone" : ""}, and "${foreign.name}" is not one of them.`;
      const keeps = holding.some(
        (circle) => own.has(circle.id) && levelIn(side, edit.id, circle) === "control",
      );
      if (side === after && holding.some(isEveryoneCircle) && !keeps)
        return publishRefusal(state, visitor, now, attested);
    }
  }
  return null;
}

/** K-718: why a published card would leave every agent circle of the key. */
function publishRefusal(state: State, visitor: Visitor, now: number, attested: Attested | null) {
  const everyone = [...state.circles.values()].find(isEveryoneCircle);
  const overlaps = controlCircles(state, visitor, now, attested).some(
    (circle) =>
      everyone !== undefined &&
      Math.hypot(circle.x - everyone.x, circle.y - everyone.y) < circle.r + everyone.r,
  );
  return overlaps
    ? "Publish into the overlap of an agent circle and Everyone, so the key keeps managing the card."
    : `No agent circle of this agent overlaps Everyone. Ask the owner to ${CIRCLE_ALONE_KEY.mac.label}-drag (on a Mac, iPad or iPhone) or ${CIRCLE_ALONE_KEY.other.label}-drag (on other systems) the head of the Agents circle, which moves the circle alone, so it overlaps Everyone and its cards stay in place.`;
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
  attested: Attested | null,
  approved: ReadonlyArray<Right> = [],
): Point | null | string {
  if (circleId === null && !publish) return null;
  const homes = controlCircles(state, visitor, now, attested);
  const home =
    circleId === null ? homes[0] : homes.find((circle) => circle.id === circleId || circle.name === circleId);
  if (!home)
    return circleId === null
      ? "This agent has no agent circle with control to publish from (K-718)."
      : `"${circleId}" is not an agent circle of this agent with control (K-718).`;
  const taken = [...state.places.values()];
  if (!publish)
    return (
      placeInside(state, home, new Set([home.id]), taken) ??
      `kitshn finds no free spot inside "${home.name}".`
    );
  if (!agentHas(state, visitor, "publishes", now, attested, approved))
    return 'This agent may not publish. The owner turns on "may publish" for it (K-718).';
  const everyone = [...state.circles.values()].find(isEveryoneCircle);
  if (!everyone) return "The map has no Everyone circle.";
  return (
    placeInside(state, home, new Set([home.id, everyone.id]), taken) ??
    publishRefusal(state, visitor, now, attested)
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
      return refused("A preview builds again on a new push to its pull request, not from an agent.");
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
  attested: Attested | null,
): OpenRightMode | null => pickMode(codeModes(state, machineId, right, fullName, now, attested));

/** K-1776: true when a card that covers the repo sets the code right to "off" and none lets it through. */
export const codeRightOff = (
  state: State,
  machineId: string,
  right: "readsCode" | "writesCode",
  fullName: string,
  now: number,
  attested: Attested | null,
) =>
  codeModes(state, machineId, right, fullName, now, attested, true).some((mode) => mode.mode === "off") &&
  codeRightMode(state, machineId, right, fullName, now, attested) === null;

function codeModes(
  state: State,
  machineId: string,
  right: "readsCode" | "writesCode",
  fullName: string,
  now: number,
  attested: Attested | null,
  exact = false,
): Array<RightMode> {
  const machine = state.machines.get(machineId);
  if (!machine) return [];
  const covering = coveringCards(state, fullName);
  // "writes code" includes reading for an open mode; "off" counts only for its own right (K-1776).
  const rights: ReadonlyArray<Right> =
    right === "readsCode" && !exact ? ["readsCode", "writesCode"] : [right];
  const visitor = { email: null, clientId: machine.clientId, ip: null };
  return matchedChips(state, visitor, now, attested).flatMap(({ circleId, member }) => {
    const circle = state.circles.get(circleId);
    if (!circle || member._tag !== "actor") return [];
    const holds = covering.some(
      (card) =>
        circlesHolding(state, card.id).some((held) => held.id === circleId) &&
        levelIn(state, card.id, circle) === "control",
    );
    return holds ? rights.flatMap((each) => (member.rights?.[each] ? [member.rights[each]] : [])) : [];
  });
}
