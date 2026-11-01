import type { Instance } from "./instances.ts";
import type { Machine } from "./machine.ts";
import type { Effect } from "kitshn/operations";
import type {
  ProviderCardSetting,
  ProviderFact,
  ProviderLevels,
  ProviderList,
  ProviderSticker,
} from "@kitshn/local";

/** All levels in one order, lowest first. A resource kind uses a subset (K-301, K-206). */
export const LEVELS = ["view", "use", "control"] as const;
export type Level = (typeof LEVELS)[number];

export const RESOURCE_KINDS = {
  "kitshn.admin": ["control"],
  machine: ["view", "use", "control"],
  "site.static": ["view"],
  "site.worker": ["view"],
  "site.compose": ["view"],
  "site.live": ["view"],
  page: ["view"],
  file: ["view"],
  repo: ["view"],
  /** K-1733: the repos of one owner, or of a name pattern with one `*`. */
  "repo.group": ["view"],
  /** K-2001: a port card on a machine; its connect page lets a person open the ports for their address. */
  port: ["view"],
} as const satisfies Record<string, ReadonlyArray<Level>>;
export type ResourceKind = keyof typeof RESOURCE_KINDS;
/** K-302: a kind of a provider has the provider prefix, for example `t3.thread`. */
export type CardKind = ResourceKind | `${string}.${string}`;

/**
 * K-704, K-705: what a provider card carries beyond a card: the provider, its own id of the resource, the names of
 * the levels of its kind (K-713), and its facts and stickers (K-1625).
 */
export interface ProviderCard {
  readonly name: string;
  readonly localId: string;
  readonly kindName: string;
  readonly levels: ProviderLevels;
  readonly facts: ReadonlyArray<ProviderFact>;
  readonly stickers: ReadonlyArray<ProviderSticker>;
  /** K-1625: the lists of the card, such as tasks or sessions. */
  readonly lists: ReadonlyArray<ProviderList>;
  /** K-717: the settings of its kind; their values live outside the card (`cardSettings` of the snapshot). */
  readonly settings: ReadonlyArray<ProviderCardSetting>;
  /** K-719: the Owner circle always holds this card at the top level of its kind. */
  readonly ownerControl?: true;
  /** K-705: the live site name of the card on its machine, or null. */
  readonly site: string | null;
  /** K-705: when its provider's report dropped it; kitshn forgets it a day later unless it comes back. */
  readonly droppedAt?: number;
}

/** FNV-1a, 32 bits, as 8 hex characters; `seed` gives a second, independent hash. */
export const fnv = (text: string, seed = 0x811c9dc5) => {
  let hash = seed;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
};

/**
 * K-704: the id of a provider card: 64 bits of hash of the machine, the provider and its own id, so it fits the card
 * id pattern of the map and two cards never meet.
 */
export const providerCardId = (machineId: string, provider: string, localId: string) => {
  const key = `${machineId}/${provider}/${localId}`;
  return `p-${fnv(key)}${fnv(key, 0x050c5d1f)}`;
};

export const ADMIN_RESOURCE_ID = "kitshn-admin";

/** K-1509: where a whole-revision Undo came from: its toast, History, or the HTTP API (an agent or a script). */
export const UNDO_SOURCES = ["toast", "history", "api"] as const;
export type UndoSource = (typeof UNDO_SOURCES)[number];
export const OWNER_CIRCLE_ID = "owner";
export const EVERYONE_CIRCLE_ID = "everyone";

/** Milliseconds since the epoch. */
export type Time = number;

/** K-1778: what proves one call. A login and a token belong to exactly one actor; a machine key may serve several. */
export type Credential =
  | { readonly _tag: "login"; readonly email: string }
  /** An Access service token (K-106). `tokenId` is the token id; `clientId` is what the JWT carries. */
  | { readonly _tag: "token"; readonly tokenId: string; readonly clientId: string; readonly name: string }
  /** K-107: the service token and key pair of a joined machine. */
  | { readonly _tag: "machine"; readonly machineId: string };

/**
 * K-1778: a name in the map that can act: a person, a script, a machine, or an agent on a machine. Only an actor with a
 * machine credential has conditions: attested labels that a call must carry to be this actor (K-1754).
 */
export interface Actor {
  readonly id: string;
  readonly name: string;
  readonly credentials: ReadonlyArray<Credential>;
  readonly conditions?: ReadonlyArray<RightCondition>;
}

/** K-1778: one key per credential, so kitshn finds a second owner of a login or a token. */
export const credentialKey = (credential: Credential) => {
  switch (credential._tag) {
    case "login":
      return `login/${credential.email.toLowerCase()}`;
    case "token":
      return `token/${credential.tokenId}`;
    case "machine":
      return `machine/${credential.machineId}`;
  }
};

/** K-1778: an actor id comes from its first credential and conditions, so one email gets one actor id. */
export const actorIdOf = (credential: Credential, conditions: ReadonlyArray<RightCondition> = []) => {
  const key =
    conditions.length === 0
      ? credentialKey(credential)
      : `${credentialKey(credential)}/${JSON.stringify(conditions)}`;
  return `a-${fnv(key)}${fnv(key, 0x050c5d1f)}`;
};

/** K-1778: a person can log in; passkey circles (K-103) and approver policies (K-1723) let only people in. */
export const isPerson = (actor: Actor) => actor.credentials.some((credential) => credential._tag === "login");

/** K-1778: the actor of a machine itself: its machine credential and no conditions. */
export const machineActorId = (machineId: string) => actorIdOf({ _tag: "machine", machineId });

/** K-1778: the machine of an actor with a machine credential, or null. */
export const machineIdOf = (actor: Actor) =>
  actor.credentials.find((credential) => credential._tag === "machine")?.machineId ?? null;

/**
 * K-1778: a circle holds actors, each with its rights in this circle (K-1720), and rules that match many visitors and
 * name nobody: an email domain, a network and everyone (K-202).
 */
export type Member =
  | {
      readonly _tag: "actor";
      readonly actorId: string;
      /** K-1730: the mode of each effect that this chip sets. */
      readonly rights?: Readonly<Partial<Record<Effect, RightMode>>>;
    }
  | { readonly _tag: "domain"; readonly domain: string }
  | { readonly _tag: "ip"; readonly range: string }
  | { readonly _tag: "everyone" };

export { EFFECTS, type Effect } from "kitshn/operations";

/** K-1725: the effects that the map warns about when no person approves them. */
export const HIGH_RISK_EFFECTS: ReadonlySet<Effect> = new Set([
  "creates",
  "changes",
  "runs",
  "destroys",
  "shares",
  "secrets",
]);

/** K-1754: an attested label must have one of these values. */
export interface RightCondition {
  readonly key: string;
  readonly values: ReadonlyArray<string>;
}

/** K-1720, K-1776: the mode of one right. A right that no circle sets asks the Owner; only "off" refuses. */
export type RightMode =
  | { readonly mode: "automatic" }
  | { readonly mode: "ask"; readonly circleId: string }
  | { readonly mode: "off" };
/** A mode that lets a call through, now or after an approval. */
export type OpenRightMode = Exclude<RightMode, { readonly mode: "off" }>;

export interface Circle {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly level: Level;
  readonly members: ReadonlyArray<Member>;
  readonly match: "any" | "all";
  readonly needsPasskey: boolean;
  /** K-1727: in a circle that needs a passkey, a proof without a passkey approves only while this is on. */
  readonly approvesWithoutPasskey?: boolean;
  readonly endsAt: Time | null;
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export const RESOURCE_STATUSES = ["running", "stopped", "deploying", "failed", "offline", "unknown"] as const;

export interface Resource {
  readonly id: string;
  readonly kind: CardKind;
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
  readonly status: (typeof RESOURCE_STATUSES)[number];
  /** Cards with the same group stack together (K-508). */
  readonly group: string | null;
  readonly machine: string | null;
  /** K-824: the instances of a Compose card beyond the home one on `machine`; their addresses are in `addresses`. */
  readonly instances?: ReadonlyArray<Instance>;
  /** K-828: the machine that the main address goes to now. Only the snapshot sets it; kitshn never stores it. */
  readonly primary?: string;
  /** K-1733: what a `repo.group` card matches: an owner (`Yarden-zamir`) or a pattern with one `*`. */
  readonly match?: string;
  /** K-1760: the GitHub way of an owner group (a match with no `/`). */
  readonly githubWay?: GitHubWay;
  /** K-704: present on the card of a provider resource. */
  readonly provider?: ProviderCard;
  /** K-2009: the machine that relays a port card behind NAT; its relay host is the second address. */
  readonly relay?: string;
}

/** K-301, K-713: the levels of a card's kind, lowest first; a provider kind names which of them it has. */
export function levelsOf(resource: Pick<Resource, "kind" | "provider">): ReadonlyArray<Level> {
  if (resource.provider) {
    const named = resource.provider.levels;
    return LEVELS.filter((level) => named[level] !== undefined);
  }
  return RESOURCE_KINDS[resource.kind as ResourceKind] ?? [];
}

/** K-713: the name that a card's kind gives a level: its own name for a provider kind. */
export const levelName = (resource: Pick<Resource, "provider">, level: Level) =>
  resource.provider?.levels[level] ?? level;

/** K-1760: kitshn makes App tokens for the repos of an owner, or the machine uses its own login. */
export type GitHubWay = "app" | "not-kitshn";
export const GITHUB_WAYS: ReadonlyArray<GitHubWay> = ["app", "not-kitshn"];

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** An override and an end date for one card in one circle (K-205, K-209). */
export interface ShareSetting {
  readonly level: Level | null;
  readonly endsAt: Time | null;
}

export const shareKey = (resourceId: string, circleId: string) => `${resourceId}/${circleId}`;

/**
 * K-521: a stack that the owner makes. Its cards sit on one point, so they share the same circles (K-204),
 * move as one, and show as one list card. A card is in at most one stack.
 */
export interface Stack {
  readonly id: string;
  /** Empty for a stack without a name, which shows only its cards. */
  readonly name: string;
  readonly members: ReadonlyArray<string>;
}

/** The name of a stack, or the names of its cards when it has none. */
export const stackTitle = (state: State, stack: Stack) =>
  stack.name || stack.members.map((id) => state.resources.get(id)?.name ?? id).join(", ");

export interface State {
  readonly circles: ReadonlyMap<string, Circle>;
  readonly resources: ReadonlyMap<string, Resource>;
  /** Card centres. A resource without a place sits in the tray (K-509). */
  readonly places: ReadonlyMap<string, Point>;
  readonly shareSettings: ReadonlyMap<string, ShareSetting>;
  /** K-212: the end time of a timed card, by card id. At its end, every share of the card ends. */
  readonly ends: ReadonlyMap<string, Time>;
  readonly stacks: ReadonlyMap<string, Stack>;
  /**
   * K-1504: null when not paused. While paused, the Owner circle keeps its share of the admin, and
   * "keep-public" also keeps the shares of public circles; "lockdown" closes those too.
   */
  readonly paused: PauseMode | null;
  /** Joined machines (K-602); a machine credential matches its service token (K-107). */
  readonly machines: ReadonlyMap<string, Machine>;
  /** K-1778: the actors that circles name. */
  readonly actors: ReadonlyMap<string, Actor>;
}

export type PauseMode = "keep-public" | "lockdown";

/** K-1504: the stored pause; any value other than empty or "keep-public" fails closed as a lockdown. */
export function pauseModeOf(stored: string | null): PauseMode | null {
  if (stored === null || stored === "" || stored === "false") return null;
  return stored === "keep-public" ? "keep-public" : "lockdown";
}

/** K-1504: the kinds whose public shares a pause keeps open; machines, repos and the admin always close. */
const KEPT_PUBLIC: ReadonlySet<CardKind> = new Set([
  "site.static",
  "site.worker",
  "site.compose",
  "site.live",
  "page",
  "file",
]);

export const levelRank = (level: Level) => LEVELS.indexOf(level);

/** K-206: the highest level of the kind that is not above the wanted level, or null for none. */
export function levelForKind(
  kind: Pick<Resource, "kind" | "provider"> | ResourceKind,
  wanted: Level,
): Level | null {
  const levels = levelsOf(typeof kind === "string" ? { kind } : kind);
  let best: Level | null = null;
  for (const level of levels) if (levelRank(level) <= levelRank(wanted)) best = level;
  return best;
}

/**
 * K-504: the modifier key that drags a circle head without the cards inside: ⌘ on macOS and iOS (on macOS,
 * Ctrl and a click opens the context menu), and Ctrl elsewhere.
 */
export const CIRCLE_ALONE_KEY = {
  mac: { property: "metaKey", label: "⌘" },
  other: { property: "ctrlKey", label: "Ctrl" },
} as const satisfies Record<
  "mac" | "other",
  { readonly property: "altKey" | "ctrlKey" | "metaKey" | "shiftKey"; readonly label: string }
>;

/** The circle-alone key of a platform, from `navigator.platform` ("MacIntel", "iPad", "Win32", …). */
export const circleAloneKey = (platform: string) =>
  CIRCLE_ALONE_KEY[platform.startsWith("Mac") || platform.startsWith("iP") ? "mac" : "other"];

export const insideCircle = (point: Point, circle: Circle) =>
  Math.hypot(point.x - circle.x, point.y - circle.y) < circle.r;

/** K-204: a card is shared with every circle that it sits inside. */
export function circlesHolding(state: State, resourceId: string): Array<Circle> {
  const place = state.places.get(resourceId);
  if (!place) return [];
  return [...state.circles.values()].filter((circle) => insideCircle(place, circle));
}

/** The level that one circle gives on one resource (K-205, K-206), or null for none. */
export function shareLevel(state: State, resource: Resource, circle: Circle): Level | null {
  const override = state.shareSettings.get(shareKey(resource.id, circle.id))?.level;
  return levelForKind(resource, override ?? circle.level);
}

export interface Share {
  readonly circle: Circle;
  readonly level: Level;
}

/** Every share of a resource with a level above none. */
export function sharesOf(state: State, resource: Resource): Array<Share> {
  const held = circlesHolding(state, resource.id).flatMap((circle) => {
    const level = shareLevel(state, resource, circle);
    return level ? [{ circle, level }] : [];
  });
  // K-719: the Owner circle holds such a card at its top level wherever the card sits, so the owner is never locked out.
  const owner = state.circles.get(OWNER_CIRCLE_ID);
  const top = levelsOf(resource).at(-1);
  if (!resource.provider?.ownerControl || !owner || !top) return held;
  return [...held.filter((share) => share.circle.id !== OWNER_CIRCLE_ID), { circle: owner, level: top }];
}

/**
 * The shares that give access now: not past an end date (K-209, K-201), and during a pause only the
 * admin share of the Owner circle and, unless it is a lockdown, the shares of public circles (K-1504).
 */
export function activeShares(state: State, resource: Resource, now: number): Array<Share> {
  return sharesOf(state, resource).filter((share) => {
    if (share.circle.endsAt !== null && share.circle.endsAt <= now) return false;
    // K-719: the Owner share of an owner-control card has no end date, also when an older setting has one.
    const ownerKept = resource.provider?.ownerControl === true && share.circle.id === OWNER_CIRCLE_ID;
    const shareEnds = ownerKept
      ? null
      : (state.shareSettings.get(shareKey(resource.id, share.circle.id))?.endsAt ?? null);
    if (shareEnds !== null && shareEnds <= now) return false;
    const cardEnds = state.ends.get(resource.id) ?? null;
    if (cardEnds !== null && cardEnds <= now) return false;
    if (!state.paused || (resource.id === ADMIN_RESOURCE_ID && share.circle.id === OWNER_CIRCLE_ID))
      return true;
    return (
      state.paused === "keep-public" &&
      KEPT_PUBLIC.has(resource.kind) &&
      isPublicCircle(share.circle) &&
      share.circle.match === "any"
    );
  });
}

/** K-1504: what one press of the big red button closes and keeps, in shares that give access now. */
export interface PauseReach {
  /** Shares that close in every pause. */
  readonly closes: number;
  /** Cards that have such a share. */
  readonly cards: number;
  /** Public shares of sites, pages and files that a pause keeps and a lockdown closes. */
  readonly keptPublic: number;
}

/** K-1504: the reach of a pause, from the shares the state gives without a pause; works while paused too. */
export function pauseReach(state: State, now: number): PauseReach {
  const count = (paused: PauseMode | null, resource: Resource) =>
    activeShares({ ...state, paused }, resource, now).length;
  let closes = 0;
  let cards = 0;
  let keptPublic = 0;
  for (const resource of state.resources.values()) {
    const open = count(null, resource);
    const kept = count("keep-public", resource);
    closes += open - kept;
    if (open > kept) cards += 1;
    keptPublic += kept - count("lockdown", resource);
  }
  return { closes, cards, keptPublic };
}

export const isPublicCircle = (circle: Circle) => circle.members.some((member) => member._tag === "everyone");

/** K-1778: the actors and machines that a member names, so a match or a label needs no whole state. */
export type Directory = Pick<State, "actors" | "machines">;

export const memberLabel = (member: Member, directory: Directory): string => {
  switch (member._tag) {
    case "actor":
      return directory.actors.get(member.actorId)?.name ?? member.actorId;
    case "domain":
      return `@${member.domain}`;
    case "ip":
      return member.range;
    case "everyone":
      return "everyone";
  }
};

/** K-1778: the actor that a member names, or undefined for a rule or a missing actor. */
export const memberActor = (member: Member, directory: Directory) =>
  member._tag === "actor" ? directory.actors.get(member.actorId) : undefined;

/** K-1778: the machine of a member that names a machine actor itself (no conditions), or null. */
export const machineOfMember = (directory: Directory, member: Member) => {
  const actor = memberActor(member, directory);
  return actor && (actor.conditions ?? []).length === 0 && actor.credentials.length === 1
    ? machineIdOf(actor)
    : null;
};
