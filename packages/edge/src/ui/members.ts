import { type Edit, lockoutReason } from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Actor,
  type Circle,
  type Directory,
  type Member,
  type State,
  actorIdOf,
  circlesHolding,
  isPerson,
  isPublicCircle,
  machineActorId,
  machineIdOf,
  memberActor,
} from "../core/model.ts";
import { isAgentCircle } from "../core/agent.ts";
import { ipInRange } from "../core/visitor.ts";

/**
 * K-1778: what the map calls a member. The icon comes from the credentials (person, token, machine, agent); no rule
 * reads it.
 */
export type MemberKind = "person" | "token" | "machine" | "agent" | "domain" | "ip" | "everyone";

export function memberKind(member: Member, directory: Directory): MemberKind {
  if (member._tag !== "actor") return member._tag;
  const actor = memberActor(member, directory);
  if (!actor) return "token";
  if ((actor.conditions ?? []).length > 0) return "agent";
  if (isPerson(actor)) return "person";
  return machineIdOf(actor) !== null ? "machine" : "token";
}

/** The kinds the "Add member" input can make. Tokens come from the token list; machines from the map. */
export const TYPED_KINDS = ["auto", "email", "domain", "ip", "everyone"] as const;
export type TypedKind = (typeof TYPED_KINDS)[number];

/** An address or a CIDR range that the Worker can match (K-202). */
function networkRange(text: string): string | null {
  const parts = text.split("/");
  if (parts.length > 2) return null;
  const [base = "", bits] = parts;
  if (
    bits !== undefined &&
    (bits.length === 0 || bits.length > 3 || ![...bits].every((c) => c >= "0" && c <= "9"))
  )
    return null;
  const range = `${base}/${bits ?? (base.includes(":") ? 128 : 32)}`;
  return ipInRange(base, range) ? range : null;
}

/** Text that can only be meant as a network: digits and dots, or a colon or a slash. */
const looksLikeNetwork = (text: string) =>
  text.includes(":") || text.includes("/") || [...text].every((c) => c === "." || (c >= "0" && c <= "9"));

/** What a typed member adds: the member, and the person actor to make when the email has none yet (K-1778). */
export interface Typed {
  readonly member: Member;
  readonly actor: Actor | null;
}

/**
 * What the owner typed, as a member. With `auto`, the text decides: `name@x.com` is a person, `@x.com` or
 * `x.com` is an email domain, an address or a CIDR range is a network. Returns a reason string otherwise.
 */
export function memberFrom(kind: TypedKind, value: string, directory: Directory): Typed | string {
  const text = value.trim().toLowerCase();
  if (kind === "everyone") return { member: { _tag: "everyone" }, actor: null };
  if (!text) return "Type an email, a domain or a network first.";
  const at = text.indexOf("@");
  const network = networkRange(text);
  const resolved: TypedKind =
    kind !== "auto"
      ? kind
      : at > 0
        ? "email"
        : network || looksLikeNetwork(text)
          ? "ip"
          : at === 0 || text.includes(".")
            ? "domain"
            : "auto";
  switch (resolved) {
    case "email": {
      if (!(at > 0 && text.indexOf(".", at) > at + 1 && !text.includes(" ")))
        return "An email looks like name@example.com.";
      // K-1778: one person actor per email; a token of that person may hold the email as a login already.
      const login = { _tag: "login", email: text } as const;
      const existing = [...directory.actors.values()].find((actor) =>
        actor.credentials.some((credential) => credential._tag === "login" && credential.email === text),
      );
      const id = existing?.id ?? actorIdOf(login);
      return {
        member: { _tag: "actor", actorId: id },
        actor: existing ? null : { id, name: text, credentials: [login] },
      };
    }
    case "domain": {
      const domain = text.startsWith("@") ? text.slice(1) : text;
      return domain.includes(".") && !domain.includes("@") && !domain.includes(" ")
        ? { member: { _tag: "domain", domain }, actor: null }
        : "A domain looks like example.com.";
    }
    case "ip":
      return network
        ? { member: { _tag: "ip", range: network }, actor: null }
        : "A network looks like 10.0.0.0/8 or 203.0.113.9.";
    default:
      return "kitshn cannot tell what this is. Type an email, a domain or a network, or pick the kind.";
  }
}

/** Whether the machine actor of `machineId` is a member of `circle`. */
export const machineMember = (circle: Circle, machineId: string) =>
  circle.members.some((member) => member._tag === "actor" && member.actorId === machineActorId(machineId));

/** Whether the actor `actorId` is a member of `circle`. */
export const actorMember = (circle: Circle, actorId: string) =>
  circle.members.some((member) => member._tag === "actor" && member.actorId === actorId);

/** K-1778: every circle of the actor needs a passkey, so a new token of it opens nothing. An actor in no circle is not. */
export const tokenOpensNothing = (state: Pick<State, "circles">, actorId: string) => {
  const circles = [...state.circles.values()].filter((circle) => actorMember(circle, actorId));
  return circles.length > 0 && circles.every((circle) => circle.needsPasskey);
};

/** K-1778: the edits that delete an actor: its chip in every circle goes first, so no circle names it after. */
export const deleteActorEdits = (state: State, actorId: string): Array<Edit> => [
  ...[...state.circles.values()]
    .filter((circle) => actorMember(circle, actorId))
    .map((circle): Edit => ({
      _tag: "circle",
      id: circle.id,
      after: {
        ...circle,
        members: circle.members.filter((member) => !(member._tag === "actor" && member.actorId === actorId)),
      },
    })),
  { _tag: "actor", id: actorId, after: null },
];

/** What a machine joining a circle does: the edit, what to say, and a question for a circle that holds kitshn itself. */
export type JoinPlan =
  | {
      readonly edits: Array<Edit>;
      readonly done: string;
      /** The rights of the machines are in this circle's panel; null when the circle gives none. */
      readonly rightsIn: string | null;
      readonly ask: string | null;
    }
  | { readonly refused: string };

/**
 * K-539: every outcome of a machine joining a circle, for a drop on the title, the menus and the panels. A change of
 * what joining means is a change here. A member joins with no right set, so its agents gain nothing yet (K-1730).
 */
export function joinPlan(
  state: State,
  machines: ReadonlyArray<string>,
  circle: Circle,
  now = Date.now(),
): JoinPlan {
  if (isPublicCircle(circle))
    return {
      refused: `${circle.name} is public: anyone opens what it holds, so a machine needs no membership there.`,
    };
  const added = machines.map((machineId): Member => ({ _tag: "actor", actorId: machineActorId(machineId) }));
  const after: Circle = { ...circle, members: [...circle.members, ...added] };
  // K-1778: a machine whose actor was deleted gets it back.
  const actors = machines.flatMap((machineId): Array<Edit> =>
    state.actors.has(machineActorId(machineId))
      ? []
      : [
          {
            _tag: "actor",
            id: machineActorId(machineId),
            after: {
              id: machineActorId(machineId),
              name: state.machines.get(machineId)?.name ?? machineId,
              credentials: [{ _tag: "machine", machineId }],
            },
          },
        ],
  );
  const names = machines.map((id) => state.resources.get(id)?.name ?? id).join(", ");
  const directory = {
    ...state,
    actors: new Map([
      ...state.actors,
      ...actors.flatMap((edit) =>
        edit._tag === "actor" && edit.after ? [[edit.id, edit.after] as const] : [],
      ),
    ]),
  };
  const lockout = lockoutReason(circle, after, directory);
  if (lockout) return { refused: lockout };
  const one = machines.length === 1;
  const opens =
    circle.endsAt !== null && circle.endsAt <= now
      ? `${circle.name} has ended, so ${one ? "it opens" : "they open"} nothing.`
      : `${one ? "It opens" : "They open"} what ${circle.name} holds.`;
  const agents = isAgentCircle(circle, state);
  const holdsAdmin = circlesHolding(state, ADMIN_RESOURCE_ID).some((held) => held.id === circle.id);
  return {
    edits: [...actors, { _tag: "circle", id: circle.id, after }],
    done: `${names} joined ${circle.name}. ${opens} ${agents ? "Its effects take their defaults." : "Outside an agent circle, an unset effect asks the Owner."}`,
    rightsIn: agents ? circle.id : null,
    ask: holdsAdmin
      ? `${circle.name} holds kitshn itself, so ${names} would change everything in kitshn. Add ${one ? "it" : "them"} anyway?`
      : null,
  };
}

/** The edit that takes a machine out of a circle; Undo puts it back with its rights. */
export const leaveEdit = (circle: Circle, machineId: string): Edit => ({
  _tag: "circle",
  id: circle.id,
  after: {
    ...circle,
    members: circle.members.filter(
      (member) => !(member._tag === "actor" && member.actorId === machineActorId(machineId)),
    ),
  },
});
