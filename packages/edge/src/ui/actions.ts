import {
  type Edit,
  type Item,
  RuleError,
  applyChanges,
  isAppCard,
  refuseRaiseWhilePaused,
  resolveEdits,
  ruleViolation,
} from "../core/changes.ts";
import { keepsScript } from "../core/apps.ts";
import { isRelease } from "../core/autoUpdate.ts";
import type { Command } from "../core/machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Level,
  OWNER_CIRCLE_ID,
  type Point,
  type Resource,
  type Stack,
  type State,
  circlesHolding,
  shareKey,
  stackTitle,
  levelName,
  levelsOf,
} from "../core/model.ts";
import { USER_STACK, circleForCards, placeInside } from "../core/place.ts";
import type { MachineView, Snapshot } from "../core/protocol.ts";
import { commandsFor } from "../core/providers.ts";
import { kindInfo } from "./kinds.ts";
import { ROLLBACK_DATA } from "./Rollback.tsx";
import { hasLogs } from "../core/logs.ts";

/** K-1801 */
export const LOGS_TIP = "Logs: search what the app writes and its deploy runs, or follow new lines live.";
import type { Selection } from "./Map.tsx";

/**
 * K-523: the actions of one card, stack, circle or spot on the map. The context menu and the command palette
 * both show these lists, so neither has an action that the other lacks.
 */
export type Action = {
  /** Stable within one list, for tests and keys. */
  readonly id: string;
  readonly label: string;
  /** A shorter label for a place that already names the items, such as the buttons of the selection panel. */
  readonly short?: string;
  /** One sentence: what happens. */
  readonly tip: string;
  readonly danger?: true;
  /** More words that the palette search finds, such as the words of an older label. */
  readonly keywords?: string;
  /** The choice of a group of options, such as a level, that is the current one (a radio item). */
  readonly checked?: boolean;
  /** Why kitshn refuses this action now; the menu shows it disabled with this as its tooltip. */
  readonly refused?: string;
} & ({ readonly run: () => void } | { readonly items: ReadonlyArray<Action> });

/** Groups that the menu splits with a separator. */
export type ActionGroups = ReadonlyArray<ReadonlyArray<Action>>;

export type MenuTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "stack"; readonly id: string }
  | { readonly _tag: "circle"; readonly id: string }
  | { readonly _tag: "map"; readonly at: Point }
  /** K-526: the "+" of the toolbar. */
  | { readonly _tag: "add" };

export interface ActionContext {
  readonly state: State;
  /** K-909: the cards that a deploy made. */
  readonly deployed: ReadonlySet<string>;
  /** K-821: preview cards, which have no rollback. */
  readonly previews: ReadonlySet<string>;
  readonly machines: ReadonlyMap<string, MachineView>;
  /** K-617: the release of this kitshn, or a local build. */
  readonly version: string;
  /** K-1507: the per-item undo that the open menu or palette asked the server about, or null. */
  readonly undoCheck: UndoCheck | null;
  /** The cards selected on the map now, for actions on all of them (K-529). */
  readonly selected: ReadonlySet<string>;
  /** K-1117: the pages and files that have a previous version. */
  readonly previousVersions: ReadonlySet<string>;
  /** K-1127: the cards that an agent key can hand over to a repo. */
  readonly handoverCards: ReadonlySet<string>;
  /** K-1623: provider cards whose address something else serves, or that kitshn takes over or took over. */
  readonly addressHolds: Snapshot["addressHolds"];
  /** K-508, K-521: the stacks that show as a column on the map now, by their key (`USER_STACK` and the id). */
  readonly openStacks: ReadonlySet<string>;
  /** K-1129: the folder sites that a folder from the owner can give a new version. */
  readonly folderSites: ReadonlySet<string>;
  /** K-707: the commands of the providers of each machine, by machine id. */
  readonly providerCommands: Snapshot["providerCommands"];
}

export interface ActionHandlers {
  readonly select: (selection: Selection) => void;
  readonly openAddress: (address: string) => void;
  readonly copyAddress: (address: string) => void;
  /** K-1127: copies the `kitshn repo` command of a page or a folder site, which an agent runs where `gh` works. */
  readonly copyRepoCommand: (resource: Resource) => void;
  /** `part` says whether a stacked card leaves alone (and leaves its stack) or takes its stack along. */
  readonly reshare: (resource: Resource, circle: Circle, share: boolean, part: StackPart) => void;
  readonly setLevel: (resource: Resource, circle: Circle, level: Level | null) => void;
  readonly place: (resource: Resource) => void;
  readonly toTray: (resource: Resource) => void;
  /** K-212: a new end time, null for no end, or "now" to end the card at once. */
  readonly setTime: (resource: Resource, endsAt: number | null | "now") => void;
  readonly stackOnto: (ids: Array<string>, target: string) => void;
  readonly pullOut: (stackId: string, id: string) => void;
  readonly unstack: (stackId: string) => void;
  /** K-521: opens a closed stack as a column on the map, or closes an open one. */
  readonly toggleStack: (key: string) => void;
  readonly renameStack: (stackId: string) => void;
  readonly removeApp: (resource: Resource) => void;
  /** K-534: removes a port card with its doors and records, after a confirm. */
  readonly removePortCard: (resource: Resource) => void;
  /** K-1623: moves the address of a provider card from what serves it now to kitshn, after a confirm. */
  readonly takeAddress: (resource: Resource) => void;
  /** K-1623: gives a taken address back to what served it before, after a confirm. */
  readonly giveAddressBack: (resource: Resource) => void;
  /** K-704: forgets the provider of a card on its machine, or with `card` only that dropped card (K-705), with Undo. */
  readonly forgetProvider: (machineId: string, provider: string, card: Resource | null) => void;
  /** K-821: opens the rollback of one card, or of the run that made its current deploy. */
  readonly rollback: (resource: Resource, mode: "card" | "run") => void;
  /** K-1117: swaps a page or a file with its previous version. */
  readonly restorePrevious: (resource: Resource) => void;
  /** K-1120: shows the address name field of a page or a file card. */
  readonly editAddress: (resource: Resource) => void;
  /** K-1128: shows the redirect address field of a site card. */
  readonly editRedirects: (resource: Resource) => void;
  /** K-1801: opens the logs of a Compose or Worker card. */
  readonly logs: (resource: Resource) => void;
  /** K-1819: opens the backups of a Compose card. */
  readonly backups: (resource: Resource) => void;
  readonly runJob: (view: MachineView, command: Command) => void;
  /** K-626: "Update daemon automatically" of a machine. */
  readonly setAutoUpdate: (view: MachineView, on: boolean) => void;
  /** K-707, K-1615: a provider command; `confirm` asks first. */
  readonly runProviderCommand: (view: MachineView, command: Command, confirm: string | null) => void;
  readonly removeMachine: (view: MachineView) => void;
  readonly editCircle: (circleId: string) => void;
  readonly renameCircle: (circleId: string) => void;
  readonly addMember: (circleId: string) => void;
  readonly deleteCircle: (circle: Circle) => void;
  readonly newCircle: (at: Point | null) => void;
  readonly upload: (at: Point | null) => void;
  /** K-1129: picks a folder: a new folder site at `at` (null: the tray), or a new version of the card `card`. */
  readonly uploadFolder: (target: { readonly at: Point | null } | { readonly card: Resource }) => void;
  readonly addSite: () => void;
  /** K-1733: a new repo group card. */
  readonly addRepoGroup: () => void;
  readonly addMachine: () => void;
  /** K-529: one new circle around these cards (the selection, or one card from "Share with"). */
  readonly newCircleFor: (ids: ReadonlyArray<string>) => void;
  readonly fit: () => void;
  /** K-532: puts the cards in a tidy grid in their own circles. */
  readonly organize: () => void;
  readonly undoItem: (item: Item) => void;
}

/** K-1507: the answer of `GET /api/undo-item`. */
export type UndoAnswer = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * K-523, K-1507: the per-item undo that a menu or the palette asked about. `answer` is null while the request
 * runs; `slow` turns on after 150 ms, so a quick answer never shows the checking state.
 */
export interface UndoCheck {
  readonly key: string;
  readonly answer: UndoAnswer | null;
  readonly slow: boolean;
}

export const itemKey = (item: Item) => `${item.kind}:${item.id}`;

export const CHECKING_TIP = "Checking whether this can be undone";

/** K-1507: the check with its answer, or unchanged when the answer is for another item or a closed menu. */
export const settleUndoCheck = (check: UndoCheck | null, key: string, answer: UndoAnswer) =>
  check?.key === key ? { ...check, answer } : check;

/** K-1507: the check in its visible checking state, unless it has its answer or is for another item. */
export const slowUndoCheck = (check: UndoCheck | null, key: string) =>
  check?.key === key && check.answer === null ? { ...check, slow: true } : check;

/**
 * K-523, K-1507: "Undo last change to this card" or "… circle", only for the item that the server was asked
 * about: disabled while it checks, then enabled, or disabled with the reason when kitshn refuses it.
 */
function undoItemAction(ctx: ActionContext, h: ActionHandlers, item: Item): Array<Action> {
  const check = ctx.undoCheck;
  if (check?.key !== itemKey(item)) return [];
  const label = `Undo last change to this ${item.kind}`;
  const base = {
    id: "undo-item",
    tip: `Undo your newest change to this ${item.kind}, and only its part of that change.`,
    run: () => h.undoItem(item),
  };
  if (check.answer === null)
    return [{ ...base, label: check.slow ? `${label} (checking…)` : label, refused: CHECKING_TIP }];
  return [{ ...base, label, ...(check.answer.allowed ? {} : { refused: check.answer.reason }) }];
}

export const MACHINE_TIPS = {
  restart: "Restart the daemon. The tunnel keeps running, so apps and sites keep serving.",
  update: (version: string) => `Update daemon: install the daemon of release ${version}.`,
  autoUpdate:
    "Update daemon automatically: kitshn installs each new release on this machine, one machine at a time, when no provider is busy (K-626).",
  remove:
    "Remove machine: deletes its service token, its tunnel and its queue at once. History records it; Undo cannot bring it back.",
} as const;

/** K-523, K-909: the label of "Remove app" names what goes and what stays, by the kind of the card. */
export const removeAppTip = (resource: Pick<Resource, "kind">, folderSite: boolean) =>
  resource.kind === "site.worker"
    ? "Remove app: take its addresses off and keep the Worker, its Durable Objects and its KV. Undo puts the addresses back."
    : keepsScript(resource, folderSite)
      ? "Remove app: take its address off and keep its files in the Worker. Undo puts the address back."
      : "Remove app: take down what the deploy made and keep the volumes. Undo starts it again.";

/** K-205: the edit that gives a card its own level in a circle, or with null follows the circle again. */
export function levelEdit(state: State, resource: Resource, circle: Circle, level: Level | null): Edit {
  const endsAt = state.shareSettings.get(shareKey(resource.id, circle.id))?.endsAt ?? null;
  return {
    _tag: "shareSetting",
    resourceId: resource.id,
    circleId: circle.id,
    after: level === null && endsAt === null ? null : { level, endsAt },
  };
}

/** The reason why kitshn refuses these edits (K-105, K-521, K-1504), or null. The server checks the same. */
export function refusal(state: State, edits: ReadonlyArray<Edit>): string | null {
  try {
    const after = applyChanges(state, resolveEdits(state, edits));
    refuseRaiseWhilePaused(state, after);
    return ruleViolation(after);
  } catch (error) {
    if (error instanceof RuleError) return error.message;
    throw error;
  }
}

/** K-527: a stacked card that leaves a circle leaves alone, out of its stack, or takes its stack along. */
export type StackPart = "card" | "stack";

/**
 * K-511: the edit that shares or unshares a card without a drag, or why no spot on the map fits. With `part`
 * "card", a stacked card also leaves its stack (K-527), and a stack left with one card goes.
 */
export function reshareEdits(
  state: State,
  resource: Resource,
  circle: Circle,
  share: boolean,
  part: StackPart = "stack",
): { readonly edits: Array<Edit> } | { readonly refused: string } {
  const wanted = new Set(circlesHolding(state, resource.id).map((held) => held.id));
  if (share) wanted.add(circle.id);
  else wanted.delete(circle.id);
  const to = placeInside(state, state.places.get(resource.id) ?? { x: circle.x, y: circle.y }, wanted);
  if (!to)
    return {
      refused: `No spot on the map is inside exactly those circles. Move "${circle.name}" so it overlaps the others, or drag the card.`,
    };
  // A stacked card takes its stack along (K-521); resolveEdits adds its mates. A card that leaves its stack
  // in the same change moves alone, because the mates follow the stack as it is after the change.
  const edits: Array<Edit> = [{ _tag: "place", id: resource.id, after: to }];
  const stack = part === "card" ? ownStack(state, resource.id) : undefined;
  if (stack) {
    const rest = stack.members.filter((id) => id !== resource.id);
    edits.push({ _tag: "stack", id: stack.id, after: rest.length > 1 ? { ...stack, members: rest } : null });
  }
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits };
}

/**
 * K-522: the edits that put cards onto `target` (into its stack, or a new stack `newId`), with the toast text,
 * or null when no card moves. A card leaves its old stack; a stack left with one card goes.
 */
export function stackOntoEdits(
  state: State,
  ids: ReadonlyArray<string>,
  target: string,
  newId: string,
): { readonly edits: Array<Edit>; readonly done: string } | { readonly refused: string } | null {
  const place = state.places.get(target);
  if (!place) return { refused: "Put one of the cards on the map first." };
  const into = [...state.stacks.values()].find((stack) => stack.members.includes(target));
  const moving = ids.filter((id) => id !== target && !into?.members.includes(id));
  if (moving.length === 0) return null;
  const edits: Array<Edit> = moving.map((id) => ({ _tag: "place", id, after: place }));
  for (const stack of state.stacks.values()) {
    if (stack === into || !stack.members.some((id) => moving.includes(id))) continue;
    const rest = stack.members.filter((id) => !moving.includes(id));
    edits.push({ _tag: "stack", id: stack.id, after: rest.length > 1 ? { ...stack, members: rest } : null });
  }
  const targetName = state.resources.get(target)?.name;
  const id = into?.id ?? newId;
  edits.push({
    _tag: "stack",
    id,
    after: {
      id,
      name: into?.name ?? "",
      members: [...(into?.members ?? [target]), ...moving],
    },
  });
  const names = moving.flatMap((card) => state.resources.get(card)?.name ?? []).join(", ");
  const refused = refusal(state, edits);
  return refused
    ? { refused }
    : {
        edits,
        done: `Stacked ${names} with ${into ? stackTitle(state, into) : (targetName ?? "the card")}.`,
      };
}

/**
 * The refusal of these edits as an action field. Cached per state, so an open palette does not check every
 * card again on each render; a new state (a broadcast) is a new cache.
 */
const refusals = new WeakMap<State, Map<string, string | null>>();
const refusedBy = (state: State, edits: ReadonlyArray<Edit>) => {
  const cache = refusals.get(state) ?? new Map<string, string | null>();
  refusals.set(state, cache);
  const key = JSON.stringify(edits);
  const refused = cache.has(key) ? (cache.get(key) ?? null) : refusal(state, edits);
  cache.set(key, refused);
  return refused ? { refused } : {};
};

/** The first card of a stack; a stack always holds two or more (K-521). */
const firstOf = (stack: Stack): string => {
  const first = stack.members[0];
  if (first === undefined) throw new Error(`The stack ${stack.id} has no card.`);
  return first;
};

const ownStack = (state: State, id: string): Stack | undefined =>
  [...state.stacks.values()].find((stack) => stack.members.includes(id));

/** K-527: the two answers when a stacked card leaves a circle, worded for the menu and the panel's Remove. */
export const stackChoice = (state: State, stack: Stack) =>
  [
    { part: "card", label: "This card", tip: "Take only this card out of its stack and" },
    {
      part: "stack",
      label: `${stackTitle(state, stack)} (${stack.members.length})`,
      tip: `Move all ${stack.members.length} cards of ${stackTitle(state, stack)}`,
    },
  ] as const satisfies ReadonlyArray<{ part: StackPart; label: string; tip: string }>;

const plans = new WeakMap<State, Map<string, ReturnType<typeof reshareEdits>>>();
/** `reshareEdits`, cached per state like `refusedBy`. */
const cachedReshare = (
  state: State,
  resource: Resource,
  circle: Circle,
  share: boolean,
  part: StackPart = "stack",
) => {
  const cache = plans.get(state) ?? new Map<string, ReturnType<typeof reshareEdits>>();
  plans.set(state, cache);
  const key = `${resource.id}/${circle.id}/${share}/${part}`;
  const plan = cache.get(key) ?? reshareEdits(state, resource, circle, share, part);
  cache.set(key, plan);
  return plan;
};

/** Share with or unshare from circles, without a drag (K-511). A stacked card takes its stack along. */
function shareActions(state: State, h: ActionHandlers, resource: Resource): Array<Action> {
  if (!state.places.has(resource.id)) return [];
  const holding = new Set(circlesHolding(state, resource.id).map((circle) => circle.id));
  const circles = [...state.circles.values()];
  const others = circles.filter((circle) => !holding.has(circle.id));
  const held = circles.filter((circle) => holding.has(circle.id));
  const refused = newCircleRefusal(state, [resource.id]);
  return [
    {
      id: "share",
      label: "Share with",
      tip: `Put ${resource.name} where one more circle holds it, without a drag.`,
      items: [
        ...others.map((circle) => {
          const plan = cachedReshare(state, resource, circle, true);
          return {
            id: `share:${circle.id}`,
            label: circle.name,
            tip: `Share ${resource.name} with ${circle.name} at ${circle.level}. Its other circles stay.`,
            ...("refused" in plan ? { refused: plan.refused } : {}),
            run: () => h.reshare(resource, circle, true, "stack"),
          };
        }),
        {
          id: "share:new-circle",
          label: "New circle…",
          tip: `Make a new circle with no members around ${resource.name}; add its members next. Its other circles stay.`,
          ...(refused ? { refused } : {}),
          run: () => h.newCircleFor([resource.id]),
        },
      ],
    },
    ...(held.length > 0
      ? [
          {
            id: "unshare",
            label: "Unshare from",
            tip: `Move ${resource.name} out of one circle, without a drag. Its other circles stay.`,
            items: held.map((circle): Action => {
              const stack = ownStack(state, resource.id);
              const option = (part: StackPart, label: string, tip: string): Action => {
                const plan = cachedReshare(state, resource, circle, false, part);
                return {
                  id: stack ? `unshare:${circle.id}:${part}` : `unshare:${circle.id}`,
                  label,
                  tip,
                  ...("refused" in plan ? { refused: plan.refused } : {}),
                  run: () => h.reshare(resource, circle, false, part),
                };
              };
              if (!stack)
                return option(
                  "stack",
                  circle.name,
                  `Move ${resource.name} out of ${circle.name}. Its other circles stay.`,
                );
              // K-527: a stacked card asks which part leaves; it is a choice, not a confirm.
              return {
                id: `unshare:${circle.id}`,
                label: circle.name,
                tip: `Move ${resource.name} or its whole stack out of ${circle.name}.`,
                items: stackChoice(state, stack).map(({ part, label, tip }) =>
                  option(part, label, `${tip} out of ${circle.name}.`),
                ),
              };
            }),
          },
        ]
      : []),
  ];
}

/** K-205: a level override per circle, only for a kind with more than one level. */
function levelActions(state: State, h: ActionHandlers, resource: Resource): Array<Action> {
  const levels = levelsOf(resource);
  if (levels.length < 2) return [];
  return circlesHolding(state, resource.id).map((circle) => {
    const current = state.shareSettings.get(shareKey(resource.id, circle.id))?.level ?? null;
    return {
      id: `level:${circle.id}`,
      label: `Level in ${circle.name}`,
      tip: `Give ${resource.name} its own level in ${circle.name}, or follow the circle.`,
      items: [null, ...levels].map((level) => ({
        id: `level:${circle.id}:${level ?? "default"}`,
        label: level === null ? `default (${levelName(resource, circle.level)})` : levelName(resource, level),
        checked: level === current,
        ...(level === current ? {} : refusedBy(state, [levelEdit(state, resource, circle, level)])),
        tip:
          level === null
            ? `Default: ${resource.name} follows the level of ${circle.name}, now ${circle.level}.`
            : `${resource.name} gets ${levelName(resource, level)} in ${circle.name}, whatever the default.`,
        run: () => h.setLevel(resource, circle, level),
      })),
    };
  });
}

/** A new circle matches nobody until the owner adds members, so making one changes no access. */
export const NEW_CIRCLE = {
  name: "New circle",
  level: "view",
  members: [],
  match: "any",
  needsPasskey: false,
  endsAt: null,
} as const satisfies Omit<Circle, "id" | "color" | "x" | "y" | "r">;

/** The ids of `selectionActions`, which the palette lists once and not under each selected card. */
const SELECTION_IDS = new Set(["stack-these", "new-circle-for"]);

const circlePlans = new WeakMap<State, Map<string, { readonly refused: string | null }>>();
/** K-529: why no new circle fits around these cards, or null. Only the refusal is kept: the handler plans again. */
const newCircleRefusal = (state: State, ids: ReadonlyArray<string>) =>
  cached(circlePlans, state, [...ids].sort().join(","), () => {
    const plan = circleForCards(state, ids, { ...NEW_CIRCLE, id: "preview", color: "#6C5CE7" });
    return { refused: "refused" in plan ? plan.refused : refusal(state, plan.edits) };
  }).refused;
const stackPlans = new WeakMap<State, Map<string, ReturnType<typeof stackOntoEdits>>>();
/** A plan per state and key, so an open menu or palette does not plan the same action again on each render. */
function cached<T>(plans: WeakMap<State, Map<string, T>>, state: State, key: string, make: () => T): T {
  const cache = plans.get(state) ?? new Map<string, T>();
  plans.set(state, cache);
  const plan = cache.has(key) ? (cache.get(key) as T) : make();
  cache.set(key, plan);
  return plan;
}

/**
 * K-521, K-529: the actions on every selected card at once, for the selection panel, the menu of a selected card
 * and the palette. Both plans are cached per state and selection.
 */
export function selectionActions(ctx: ActionContext, h: ActionHandlers): Array<Action> {
  // A card that another device removed while it was selected drops out, as it does from the panel.
  const ids = [...ctx.selected].filter((id) => ctx.state.resources.has(id));
  if (ids.length < 2) return [];
  const refused = newCircleRefusal(ctx.state, ids);
  // K-521: the first selected card on the map is the one the others stack onto, as a drop onto it would. The
  // target depends on the order of the selection, so its cache key keeps that order.
  const target = ids.find((id) => ctx.state.places.has(id)) ?? ids[0] ?? "";
  const stack = cached(stackPlans, ctx.state, ids.join(","), () =>
    stackOntoEdits(ctx.state, ids, target, "preview"),
  );
  return [
    // No entry when the cards already are one stack: there is nothing to stack.
    ...(stack
      ? [
          {
            id: "stack-these",
            label: `Stack these (${ids.length})`,
            short: "Stack these",
            tip: "Stack the selected cards: they sit on one point, move as one and get the same circles.",
            ...("refused" in stack ? { refused: stack.refused } : {}),
            run: () => h.stackOnto(ids, target),
          },
        ]
      : []),
    {
      id: "new-circle-for",
      label: `New circle for these (${ids.length})`,
      short: "New circle for these",
      tip: "Make one new circle with no members around the selected cards. Every card keeps its circles; cards in the way move out. Undo takes it all back.",
      ...(refused ? { refused } : {}),
      run: () => h.newCircleFor(ids),
    },
  ];
}

/** K-707: the commands that the providers of the card's machine have for it, or for the machine card itself. */
function providerActions(ctx: ActionContext, h: ActionHandlers, resource: Resource): Array<Action> {
  const machineId = resource.provider ? resource.machine : resource.kind === "machine" ? resource.id : null;
  const view = machineId === null ? undefined : ctx.machines.get(machineId);
  if (!view) return [];
  return commandsFor(ctx.providerCommands[view.machine.id] ?? [], resource).map(({ provider, command }) => ({
    id: `provider:${provider}:${command.id}`,
    label: command.confirm ? `${command.title}…` : command.title,
    tip: `${provider} runs ${command.title} on ${view.machine.name}; an offline machine runs it when it connects (K-613).`,
    run: () =>
      h.runProviderCommand(
        view,
        { kind: "provider", provider, command: command.id, resource: resource.provider ? resource.id : null },
        command.confirm ? `${command.title} on ${resource.name}?` : null,
      ),
  }));
}

const HOUR = 60 * 60 * 1000;
/** K-212: the end times that the card menu, the palette and the card panel offer. */
export const TIME_PRESETS = [
  { label: "Until I stop it", after: null },
  { label: "1 h", after: HOUR },
  { label: "4 h", after: 4 * HOUR },
  { label: "1 day", after: 24 * HOUR },
] as const;

/** K-212: "until 15:40" today, "until Oct 30, 15:40" on another day, in the owner's local time. */
export function untilText(endsAt: number, now = Date.now()): string {
  const end = new Date(endsAt);
  const time = end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return end.toDateString() === new Date(now).toDateString()
    ? `until ${time}`
    : `until ${end.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** K-212: a card on the map gets a time, or a timed card is extended, made permanent or ended now. */
function timeAction(state: State, h: ActionHandlers, resource: Resource): Action {
  const endsAt = state.ends.get(resource.id);
  if (endsAt === undefined)
    return {
      id: "time",
      label: "Set a time",
      keywords: "timer timed expire end temporary",
      tip: `Keep ${resource.name} in its circles for a while; at the end it moves to the tray, out of every circle.`,
      items: TIME_PRESETS.flatMap((preset) =>
        preset.after === null
          ? []
          : [
              {
                id: `time:${preset.label}`,
                label: `For ${preset.label}`,
                tip: `${resource.name} moves to the tray ${preset.label} from now. Undo puts it back.`,
                run: () => h.setTime(resource, Date.now() + preset.after),
              },
            ],
      ),
    };
  return {
    id: "time",
    label: `Time (${untilText(endsAt)})`,
    keywords: "timer timed expire end extend permanent",
    tip: `${resource.name} moves to the tray, out of every circle, ${untilText(endsAt).replace("until", "at")}.`,
    items: [
      {
        id: "time:extend",
        label: "Extend 1 h",
        tip: "Move the end one hour later.",
        run: () => h.setTime(resource, Math.max(endsAt, Date.now()) + HOUR),
      },
      {
        id: "time:permanent",
        label: "Make permanent",
        tip: `Take the end time away: ${resource.name} stays until someone moves it.`,
        run: () => h.setTime(resource, null),
      },
      {
        id: "time:now",
        label: "End now",
        tip: `Move ${resource.name} to the tray now, out of every circle. Undo puts it back.`,
        run: () => h.setTime(resource, "now"),
      },
    ],
  };
}

export function cardActions(ctx: ActionContext, h: ActionHandlers, resource: Resource): ActionGroups {
  const { state } = ctx;
  const address = resource.addresses[0];
  const placed = state.places.has(resource.id);
  const stack = ownStack(state, resource.id);
  const stacks = [...state.stacks.values()].filter((other) => other !== stack);
  const machine = ctx.machines.get(resource.id);
  const kind = kindInfo(resource).label.toLowerCase();
  const forSelection = ctx.selected.has(resource.id) ? selectionActions(ctx, h) : [];
  return [
    ...(forSelection.length > 0 ? [forSelection] : []),
    [
      {
        id: "details",
        label: "Show details",
        tip: `Select ${resource.name} and show its panel.`,
        run: () => h.select({ cards: new Set([resource.id]), circle: null }),
      },
      ...(address
        ? [
            {
              id: "open",
              label: "Open",
              tip: `Open https://${address} in a new tab.`,
              run: () => h.openAddress(address),
            },
            {
              id: "copy",
              label: "Copy address",
              tip: `Copy https://${address} to the clipboard.`,
              run: () => h.copyAddress(address),
            },
          ]
        : []),
      ...(ctx.handoverCards.has(resource.id)
        ? [
            {
              id: "make-repo",
              label: "Make it a repo…",
              tip: `Copy the command for the agent key that published ${resource.name}: it makes a new GitHub repo with gh, and the repo's first push then deploys this card. The key needs "may add apps".`,
              run: () => h.copyRepoCommand(resource),
            },
          ]
        : []),
      ...(ctx.folderSites.has(resource.id)
        ? [
            {
              id: "upload-version",
              label: "Upload a new version…",
              tip: `Pick a folder: its files replace the files of ${resource.name}, at the same address.`,
              run: () => h.uploadFolder({ card: resource }),
            },
          ]
        : []),
      ...(resource.kind === "page" || resource.kind === "file"
        ? [
            {
              id: "set-address",
              label: "Set address…",
              tip: `Give ${resource.name} a new address name. The old address keeps working and sends visitors on.`,
              run: () => h.editAddress(resource),
            },
          ]
        : []),
      ...(resource.kind.startsWith("site.")
        ? [
            {
              id: "add-redirect",
              label: "Add redirect address…",
              tip: `Add a hostname that only sends visitors on to ${resource.name}, such as an old name of the site.`,
              run: () => h.editRedirects(resource),
            },
          ]
        : []),
    ],
    [
      ...(placed
        ? []
        : [
            {
              id: "place",
              label: "Place on the map",
              tip: "Place the card in the middle of the view, outside every circle, so it stays private.",
              run: () => h.place(resource),
            },
          ]),
      ...shareActions(state, h, resource),
      ...levelActions(state, h, resource),
      {
        id: "select-kind",
        label: `Select all ${kind}`,
        tip: `Select every card of ${kind} on the map, so they move as one.`,
        run: () =>
          h.select({
            cards: new Set(
              [...state.resources.values()]
                .filter((other) => other.kind === resource.kind && state.places.has(other.id))
                .map((other) => other.id),
            ),
            circle: null,
          }),
      },
    ],
    [
      ...(stack
        ? [
            {
              id: "leave-stack",
              label: `Leave stack ${stackTitle(state, stack)}`,
              tip: "The card lands next to the stack, in the same circles, so no share changes.",
              run: () => h.pullOut(stack.id, resource.id),
            },
          ]
        : []),
      ...(stacks.length > 0
        ? [
            {
              id: "add-to-stack",
              label: "Add to stack",
              tip: `Put ${resource.name} into a stack: it moves to the stack and gets its circles.`,
              items: stacks.map((other) => {
                const plan = stackOntoEdits(state, [resource.id], firstOf(other), other.id);
                return {
                  id: `add-to-stack:${other.id}`,
                  label: other.name,
                  tip: `Put ${resource.name} into ${other.name}. It gets the circles of ${other.name}.`,
                  ...(plan && "refused" in plan ? { refused: plan.refused } : {}),
                  run: () => h.stackOnto([resource.id], firstOf(other)),
                };
              }),
            },
          ]
        : []),
      ...(placed && resource.id !== ADMIN_RESOURCE_ID
        ? [
            {
              id: "tray",
              label: "Move to tray",
              tip: "Take the card off the map. It leaves every circle, so it is private. Undo puts it back.",
              ...refusedBy(state, [{ _tag: "place", id: resource.id, after: null }]),
              run: () => h.toTray(resource),
            },
            timeAction(state, h, resource),
          ]
        : []),
    ],
    machine
      ? [
          {
            id: "restart",
            label: "Restart daemon",
            tip: MACHINE_TIPS.restart,
            run: () => h.runJob(machine, { kind: "restart" }),
          },
          ...(isRelease(ctx.version)
            ? [
                {
                  id: "update",
                  label: "Update daemon",
                  tip: MACHINE_TIPS.update(ctx.version),
                  run: () => h.runJob(machine, { kind: "update", version: ctx.version }),
                },
                machine.machine.autoUpdate === false
                  ? {
                      id: "auto-update-on",
                      label: "Turn on Update daemon automatically",
                      tip: MACHINE_TIPS.autoUpdate,
                      run: () => h.setAutoUpdate(machine, true),
                    }
                  : {
                      id: "auto-update-off",
                      label: "Turn off Update daemon automatically",
                      tip: MACHINE_TIPS.autoUpdate,
                      run: () => h.setAutoUpdate(machine, false),
                    },
              ]
            : []),
        ]
      : [],
    providerActions(ctx, h, resource),
    // K-1117: an update keeps one previous version; restoring it twice gets the newer one back.
    ctx.previousVersions.has(resource.id)
      ? [
          {
            id: "restore-previous",
            label: "Restore previous version",
            tip: `Put the previous version of ${resource.name} back. The current one becomes the previous version, so a second restore swaps them back.`,
            run: () => h.restorePrevious(resource),
          },
        ]
      : [],
    undoItemAction(ctx, h, { kind: "card", id: resource.id }),
    [
      ...(hasLogs(resource.kind) && ctx.deployed.has(resource.id)
        ? [{ id: "logs", label: "Logs…", tip: LOGS_TIP, run: () => h.logs(resource) }]
        : []),
      ...(isAppCard(resource) && ctx.deployed.has(resource.id) && !ctx.previews.has(resource.id)
        ? [
            {
              id: "rollback",
              label: "Roll back…",
              tip: `Roll back: serve an earlier deploy of this card again. ${ROLLBACK_DATA}`,
              run: () => h.rollback(resource, "card"),
            },
            // K-1123: a folder site comes from no workflow run; one that a repo took over does (K-1127).
            ...(ctx.folderSites.has(resource.id)
              ? []
              : [
                  {
                    id: "rollback-run",
                    label: "Roll back this run…",
                    tip: `Roll back every card of the workflow run that made this deploy. ${ROLLBACK_DATA}`,
                    run: () => h.rollback(resource, "run"),
                  },
                ]),
            ...(resource.kind === "site.compose"
              ? [
                  {
                    id: "backups",
                    label: "Backups…",
                    tip: "List the backups of this app, and restore one.",
                    run: () => h.backups(resource),
                  },
                ]
              : []),
          ]
        : []),
      // K-704: only a provider that does not run can go; a running one brings its cards back at once.
      ...(resource.provider && resource.machine !== null && resource.status === "offline"
        ? [
            {
              id: "forget-provider",
              label: `Forget provider ${resource.provider.name}`,
              tip: `Remove every card of ${resource.provider.name} on this machine, with their shares. Undo brings them back.`,
              danger: true as const,
              run: () => h.forgetProvider(resource.machine!, resource.provider!.name, null),
            },
          ]
        : []),
      // K-1623: the owner takes over an address that something else serves, and gives it back while that waits.
      ...(ctx.addressHolds[resource.id] === "in-use"
        ? [
            {
              id: "take-address",
              label: "Take the address…",
              tip: `Move the address of ${resource.name} from what serves it now to kitshn. kitshn asks first; "Give the address back" undoes it.`,
              run: () => h.takeAddress(resource),
            },
          ]
        : ctx.addressHolds[resource.id] !== undefined
          ? [
              {
                id: "give-address-back",
                label: "Give the address back…",
                tip: `Point ${resource.addresses[0] ?? "the address"} at what served it before, and let kitshn let go of it.`,
                danger: true as const,
                run: () => h.giveAddressBack(resource),
              },
            ]
          : []),
      // K-705: a card that its provider dropped goes alone, also while the provider runs.
      ...(resource.provider?.droppedAt !== undefined && resource.machine !== null
        ? [
            {
              id: "forget-card",
              label: "Forget this card",
              tip: `Remove ${resource.name}, which ${resource.provider!.name} no longer reports, with its shares. Undo brings it back.`,
              danger: true as const,
              run: () => h.forgetProvider(resource.machine!, resource.provider!.name, resource),
            },
          ]
        : []),
      ...(resource.kind === "port"
        ? [
            {
              id: "remove-port card",
              label: "Remove ports…",
              tip: `Remove ${resource.name}: its doors close for everyone at once, its records go, and its ports stay closed. kitshn asks first; there is no Undo.`,
              danger: true as const,
              run: () => h.removePortCard(resource),
            },
          ]
        : []),
      ...(isAppCard(resource) && ctx.deployed.has(resource.id)
        ? [
            {
              id: "remove-app",
              label: "Remove app",
              tip: removeAppTip(resource, ctx.folderSites.has(resource.id)),
              danger: true as const,
              run: () => h.removeApp(resource),
            },
          ]
        : []),
      ...(machine
        ? [
            {
              id: "remove-machine",
              label: "Remove machine: deletes its token and tunnel",
              tip: MACHINE_TIPS.remove,
              danger: true as const,
              run: () => h.removeMachine(machine),
            },
          ]
        : []),
    ],
  ].filter((group) => group.length > 0);
}

/** K-521, K-522: a closed stack of the owner. Shares go through its first card, which takes the stack along. */
export function stackActions(ctx: ActionContext, h: ActionHandlers, stack: Stack): ActionGroups {
  const { state } = ctx;
  const key = `${USER_STACK}${stack.id}`;
  const open = ctx.openStacks.has(key);
  const first = state.resources.get(firstOf(stack));
  const members = stack.members.flatMap((id) => state.resources.get(id) ?? []);
  return [
    [
      {
        id: "details",
        label: "Show details",
        tip: `Select ${stackTitle(state, stack)} and show its panel.`,
        run: () => h.select({ cards: new Set(stack.members), circle: null }),
      },
      {
        id: "rename",
        label: "Rename",
        tip: `Rename ${stackTitle(state, stack)} in its panel.`,
        run: () => h.renameStack(stack.id),
      },
      {
        id: "open-stack",
        label: open ? "Close the column" : "Open as a column",
        tip: open
          ? `Show ${stackTitle(state, stack)} as one card again.`
          : `Show the cards of ${stackTitle(state, stack)} as a column on the map, as a click does.`,
        run: () => h.toggleStack(key),
      },
    ],
    first ? shareActions(state, h, first) : [],
    [
      {
        id: "pull-out",
        label: "Pull out",
        tip: "Take one card out. It lands next to the stack, in the same circles, so no share changes.",
        items: members.map((member) => ({
          id: `pull-out:${member.id}`,
          label: `${kindInfo(member).icon} ${member.name}`,
          tip: `Take ${member.name} out of ${stackTitle(state, stack)}.`,
          run: () => h.pullOut(stack.id, member.id),
        })),
      },
      {
        id: "unstack",
        label: "Unstack",
        tip: "Spread all cards in the same circles.",
        run: () => h.unstack(stack.id),
      },
    ],
  ].filter((group) => group.length > 0);
}

export function circleActions(ctx: ActionContext, h: ActionHandlers, circle: Circle): ActionGroups {
  return [
    [
      {
        id: "edit",
        label: "Edit",
        tip: `Edit ${circle.name}: its members, level, match and end.`,
        run: () => h.editCircle(circle.id),
      },
      {
        id: "rename",
        label: "Rename",
        tip: `Rename ${circle.name} in its panel.`,
        run: () => h.renameCircle(circle.id),
      },
      {
        id: "add-member",
        label: "Add a member",
        tip: "Add a person, a domain, a device or a network to the circle.",
        run: () => h.addMember(circle.id),
      },
    ],
    undoItemAction(ctx, h, { kind: "circle", id: circle.id }),
    // K-211: the Owner circle cannot be deleted.
    circle.id === OWNER_CIRCLE_ID
      ? []
      : [
          {
            id: "delete",
            label: "Delete circle",
            tip: `Delete ${circle.name} at once. Its cards stay where they are and lose this share; Undo brings it back.`,
            danger: true as const,
            ...refusedBy(ctx.state, [{ _tag: "circle", id: circle.id, after: null }]),
            run: () => h.deleteCircle(circle),
          },
        ],
  ].filter((group) => group.length > 0);
}

/**
 * K-526: everything that the owner can add. The toolbar "+" and the menu of an empty spot both show this one
 * list, so they never differ. `at` is the spot, or null for the middle of the view.
 */
export function addActions(ctx: ActionContext, h: ActionHandlers, at: Point | null): ReadonlyArray<Action> {
  const here = at ? " here" : "";
  return [
    {
      id: "new-circle",
      label: `New circle${here}`,
      tip: `Make a new circle${at ? " at this spot" : " in the middle of the view"}. It matches nobody until you add members.`,
      run: () => h.newCircle(at),
    },
    // K-1101, K-1129: one entry for every upload; a browser picks files or a folder, never both in one dialog.
    {
      id: "upload",
      label: `Upload${here}…`,
      keywords: "upload page file folder html static site",
      tip: "Upload pages, files or a folder. You can also drop them on the map.",
      items: [
        {
          id: "upload-files",
          label: "Pages or files",
          tip: at
            ? "Upload files to this spot: they land in exactly the circles here, so they get those shares. An HTML file becomes a page, any other file stays a file, at most 100 MB."
            : "Upload files: they wait in the tray, private. An HTML file becomes a page, any other file stays a file, at most 100 MB.",
          run: () => h.upload(at),
        },
        {
          id: "upload-folder",
          label: "A folder, as a site",
          tip: at
            ? "Upload a folder as a new static site with a random address. Its card lands in exactly the circles here."
            : "Upload a folder as a new static site with a random address. Its card waits in the tray, private.",
          run: () => h.uploadFolder({ at }),
        },
      ],
    },
    {
      id: "add-site",
      label: "Add a site",
      keywords: "live from a machine or static from a repo",
      tip: "Share a local server of a machine, or set up a static site from a repo. Its card starts in the tray, private.",
      run: h.addSite,
    },
    {
      id: "add-repo-group",
      label: "Add a repo group",
      keywords: "github owner pattern agent code rights",
      tip: "The repos of an owner, or of a name pattern with one *. In an agent circle, its code rights cover each repo that it matches.",
      run: h.addRepoGroup,
    },
    {
      id: "add-machine",
      label: "Add a machine",
      keywords: "join code",
      tip: "Make a join command for a new machine. Its card starts in the tray, private.",
      run: h.addMachine,
    },
    {
      id: "add-member",
      label: "Add a member",
      keywords: "person domain device network",
      tip: "Add a person, a domain, a device or a network to a circle.",
      items: [...ctx.state.circles.values()].map((circle) => ({
        id: `add-member:${circle.id}`,
        label: circle.name,
        tip: `Add a person, a domain, a device or a network to ${circle.name}.`,
        run: () => h.addMember(circle.id),
      })),
    },
  ];
}

/** K-532: the tooltip of Organize, in the toolbar, the "☰" menu, the map menu and the palette. */
export const ORGANIZE_TIP =
  "Put the cards of each circle in a tidy grid, by kind and then by name. No card changes its circles, and one Undo puts them back.";

/** An empty spot of the map, or `at: null` for the palette, which adds in the middle of the view. */
export function mapActions(ctx: ActionContext, h: ActionHandlers, at: Point | null): ActionGroups {
  const forSelection = selectionActions(ctx, h);
  return [
    ...(forSelection.length > 0 ? [forSelection] : []),
    addActions(ctx, h, at),
    [
      { id: "fit", label: "Fit the map", tip: "Fit every circle and card in the view.", run: h.fit },
      {
        id: "organize",
        label: "Organize the cards",
        keywords: "tidy arrange sort grid",
        tip: ORGANIZE_TIP,
        run: h.organize,
      },
    ],
  ];
}

/** The groups for a menu target, or null when its item is gone. */
export function actionsFor(ctx: ActionContext, h: ActionHandlers, target: MenuTarget): ActionGroups | null {
  switch (target._tag) {
    case "card": {
      const resource = ctx.state.resources.get(target.id);
      return resource ? cardActions(ctx, h, resource) : null;
    }
    case "stack": {
      const stack = ctx.state.stacks.get(target.id);
      return stack ? stackActions(ctx, h, stack) : null;
    }
    case "circle": {
      const circle = ctx.state.circles.get(target.id);
      return circle ? circleActions(ctx, h, circle) : null;
    }
    case "map":
      return mapActions(ctx, h, target.at);
    case "add":
      return [addActions(ctx, h, null)];
  }
}

export interface PaletteEntry {
  readonly label: string;
  readonly tip: string;
  readonly danger?: true;
  readonly keywords?: string;
  readonly run: () => void;
}

/**
 * One entry per action, with sub-lists spelled out and the item name in front, so a search finds them. A
 * refused action and the current choice of a radio group have no entry: there is nothing to run.
 */
export function flatten(groups: ActionGroups, prefix: string): Array<PaletteEntry> {
  const walk = (action: Action, label: string): Array<PaletteEntry> =>
    action.refused !== undefined || action.checked
      ? []
      : "items" in action
        ? action.items.flatMap((item) => walk(item, `${label}: ${item.label}`))
        : [
            {
              label,
              tip: action.tip,
              run: action.run,
              ...(action.danger ? { danger: action.danger } : {}),
              ...(action.keywords ? { keywords: action.keywords } : {}),
            },
          ];
  return groups
    .flat()
    .flatMap((action) => walk(action, prefix ? `${prefix} · ${action.label}` : action.label));
}

/**
 * What Enter runs in the palette: the active entry, unless it is dangerous and the owner did not pick it with
 * the arrows or the pointer while other entries match. Then Enter does nothing, so a typo never removes.
 */
export function paletteEnter(
  matches: ReadonlyArray<Pick<PaletteEntry, "danger">>,
  active: number,
  picked: boolean,
): number | null {
  const entry = matches[active];
  if (!entry) return null;
  return entry.danger && matches.length > 1 && !picked ? null : active;
}

/**
 * The palette's active entry, kept by label so a broadcast that reorders the matches never changes what Enter
 * runs. `picked` is true only after the arrows moved to it; a hover or a new query clears it.
 */
export interface PaletteCursor {
  readonly label: string | null;
  readonly picked: boolean;
}

/** The index of the active entry: the one with the cursor's label, else the first match. */
export function paletteActive(
  labels: ReadonlyArray<string>,
  cursor: PaletteCursor,
): { index: number; picked: boolean } {
  const index = cursor.label === null ? -1 : labels.indexOf(cursor.label);
  return index === -1 ? { index: 0, picked: false } : { index, picked: cursor.picked };
}

/** ArrowDown and ArrowUp move the cursor; a key that does not move it changes nothing. */
export function paletteArrow(
  key: "ArrowDown" | "ArrowUp",
  labels: ReadonlyArray<string>,
  cursor: PaletteCursor,
): PaletteCursor {
  const { index } = paletteActive(labels, cursor);
  const next = key === "ArrowDown" ? Math.min(index + 1, labels.length - 1) : Math.max(index - 1, 0);
  const label = labels[next];
  return next === index || label === undefined ? cursor : { label, picked: true };
}

/** K-511: every card, stack and circle action, after the actions of the whole map. */
export function paletteEntries(ctx: ActionContext, h: ActionHandlers): Array<PaletteEntry> {
  const { state } = ctx;
  return [
    ...flatten(mapActions(ctx, h, null), ""),
    ...[...state.resources.values()].flatMap((resource) =>
      // The selection's actions come once, with the map's, not once per selected card.
      flatten(
        cardActions(ctx, h, resource).map((group) => group.filter((action) => !SELECTION_IDS.has(action.id))),
        `${kindInfo(resource).icon} ${resource.name}`,
      ),
    ),
    ...[...state.stacks.values()].flatMap((stack) =>
      flatten(stackActions(ctx, h, stack), `Stack ${stackTitle(state, stack)}`),
    ),
    ...[...state.circles.values()].flatMap((circle) =>
      flatten(circleActions(ctx, h, circle), `⭕ ${circle.name}`),
    ),
  ];
}
