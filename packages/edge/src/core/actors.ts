// K-1778: the one migration of circle members into actors (migration 44). Pure, for tests: it reads the stored circle
// bodies of before the actor model and gives the actors and the new circle bodies.
import type { Machine } from "./machine.ts";
import {
  RIGHTS,
  RIGHT_NAMES,
  type Actor,
  type Circle,
  type Credential,
  type Member,
  type Point,
  type Right,
  type RightCondition,
  type RightMode,
  actorIdOf,
  insideCircle,
  machineActorId,
} from "./model.ts";

type LegacyMode =
  | { readonly mode: "automatic"; readonly conditions?: ReadonlyArray<RightCondition> }
  | { readonly mode: "ask"; readonly circleId: string; readonly conditions?: ReadonlyArray<RightCondition> }
  | { readonly mode: "off" };

/** The members of a stored circle before migration 44. */
export type LegacyMember =
  | { readonly _tag: "email"; readonly email: string }
  | { readonly _tag: "domain"; readonly domain: string }
  | { readonly _tag: "ip"; readonly range: string }
  | {
      readonly _tag: "device";
      readonly tokenId: string;
      readonly clientId: string;
      readonly name: string;
      readonly addsApps?: true;
      readonly publishes?: true;
    }
  | {
      readonly _tag: "machine";
      readonly machineId: string;
      readonly rights?: Readonly<Partial<Record<Right, LegacyMode>>>;
    }
  | { readonly _tag: "everyone" };

export type LegacyCircle = Omit<Circle, "members" | "approvesWithoutPasskey"> & {
  readonly members: ReadonlyArray<LegacyMember>;
  readonly machinesMayApprove?: boolean;
};

export interface ActorMigration {
  readonly actors: ReadonlyArray<Actor>;
  readonly circles: ReadonlyArray<Circle>;
  /** What the owner reads in History: each token that joined a person, each new agent actor. */
  readonly notes: ReadonlyArray<string>;
}

type Device = Extract<LegacyMember, { _tag: "device" }>;

/** The agent rights of a key before the actor model (K-718); every other right was off for a key (K-1732). */
const KEY_RIGHTS = ["addsApps", "publishes"] as const;

/**
 * K-1778: the actors of the stored circles.
 * - An email becomes a person actor, one per email across circles.
 * - A machine becomes a machine actor; its rights without conditions stay on its chip. Each set of conditions becomes an
 *   agent actor "<machine> <rights>" with those rights, and the machine chip keeps them at default (break 5).
 * - An agent key (a device in a circle of devices and machines only, and in no circle that holds the admin) becomes a
 *   token actor. Its flags become "automatic" and its other rights "off", as before (K-1732).
 * - Another device becomes a token of the one person that every circle of the device also holds, else its own actor.
 *   So no circle lets in anyone new, except that the person's token now opens the person's other circles (decision 1).
 */
export function migrateMembers(
  circles: ReadonlyArray<LegacyCircle>,
  machines: ReadonlyMap<string, Machine>,
  adminPlace: Point | null,
): ActorMigration {
  const actors = new Map<string, Actor>();
  const notes: Array<string> = [];
  const add = (actor: Actor) => {
    if (!actors.has(actor.id)) actors.set(actor.id, actor);
    return actor.id;
  };
  for (const machine of machines.values())
    add({
      id: machineActorId(machine.id),
      name: machine.name,
      credentials: [{ _tag: "machine", machineId: machine.id }],
    });
  const person = (email: string) =>
    add({
      id: actorIdOf({ _tag: "login", email }),
      name: email.toLowerCase(),
      credentials: [{ _tag: "login", email: email.toLowerCase() }],
    });
  const machineActor = (machineId: string) =>
    add({
      id: machineActorId(machineId),
      name: machines.get(machineId)?.name ?? machineId,
      credentials: [{ _tag: "machine", machineId }],
    });

  const holdsAdmin = (circle: LegacyCircle) =>
    adminPlace !== null && insideCircle(adminPlace, circle as unknown as Circle);
  const isAgentCircle = (circle: LegacyCircle) =>
    circle.members.every((member) => member._tag === "device" || member._tag === "machine");
  const emailsOf = (circle: LegacyCircle) =>
    new Set(
      circle.members.flatMap((member) => (member._tag === "email" ? [member.email.toLowerCase()] : [])),
    );

  // Each token across circles: its circles, and whether it is an agent key.
  const devices = new Map<string, { device: Device; circles: Array<LegacyCircle> }>();
  for (const circle of circles)
    for (const member of circle.members)
      if (member._tag === "device") {
        const entry = devices.get(member.tokenId) ?? { device: member, circles: [] };
        entry.circles.push(circle);
        devices.set(member.tokenId, entry);
      }
  /** By token id: the person actor that takes the token, or null when the token is its own actor. */
  const owners = new Map<string, string | null>();
  const keys = new Set<string>();
  for (const [tokenId, { device, circles: held }] of devices) {
    const token: Credential = { _tag: "token", tokenId, clientId: device.clientId, name: device.name };
    const key = held.some(isAgentCircle) && !held.some(holdsAdmin);
    if (key) keys.add(tokenId);
    const [first, ...rest] = held.map(emailsOf);
    const shared =
      key || !first ? [] : [...first].filter((email) => rest.every((emails) => emails.has(email)));
    const [email] = shared;
    if (email !== undefined && shared.length === 1) {
      const id = person(email);
      const owner = actors.get(id);
      if (owner) actors.set(id, { ...owner, credentials: [...owner.credentials, token] });
      owners.set(tokenId, id);
      notes.push(`The token ${device.name} is now a credential of ${email}.`);
    } else {
      add({ id: actorIdOf(token), name: device.name, credentials: [token] });
      owners.set(tokenId, null);
    }
  }

  // Agent actors: one per machine and set of conditions, named after the rights that need them.
  const agentRights = new Map<string, Set<Right>>();
  const agentId = (machineId: string, conditions: ReadonlyArray<RightCondition>) =>
    actorIdOf({ _tag: "machine", machineId }, conditions);
  for (const circle of circles)
    for (const member of circle.members) {
      if (member._tag !== "machine") continue;
      for (const right of RIGHTS) {
        const mode = member.rights?.[right];
        if (!mode || mode.mode === "off" || (mode.conditions ?? []).length === 0) continue;
        const id = agentId(member.machineId, mode.conditions ?? []);
        const named = agentRights.get(id) ?? new Set();
        named.add(right);
        agentRights.set(id, named);
        if (!actors.has(id)) {
          actors.set(id, {
            id,
            name: "",
            credentials: [{ _tag: "machine", machineId: member.machineId }],
            conditions: mode.conditions ?? [],
          });
        }
      }
    }
  for (const [id, rights] of agentRights) {
    const actor = actors.get(id);
    const machineId = actor?.credentials[0]?._tag === "machine" ? actor.credentials[0].machineId : id;
    const name =
      `${machines.get(machineId)?.name ?? machineId} ${[...rights].map((right) => RIGHT_NAMES[right]).join(", ")}`.slice(
        0,
        80,
      );
    if (actor) actors.set(id, { ...actor, name });
    notes.push(
      `The rights with conditions of ${machines.get(machineId)?.name ?? machineId} moved to the new agent actor ${name}.`,
    );
  }

  const migrated = circles.map((circle): Circle => {
    const members: Array<Member> = [];
    const chips = new Map<string, Extract<Member, { _tag: "actor" }>>();
    const chip = (actorId: string, rights: Partial<Record<Right, RightMode>>) => {
      const old = chips.get(actorId);
      const merged = { ...rights, ...old?.rights };
      const next: Extract<Member, { _tag: "actor" }> =
        Object.keys(merged).length === 0
          ? { _tag: "actor", actorId }
          : { _tag: "actor", actorId, rights: merged };
      if (old) members[members.indexOf(old)] = next;
      else members.push(next);
      chips.set(actorId, next);
    };
    for (const member of circle.members) {
      switch (member._tag) {
        case "email":
          chip(person(member.email), {});
          break;
        case "domain":
        case "ip":
        case "everyone":
          members.push(member);
          break;
        case "device": {
          const owner = owners.get(member.tokenId);
          if (owner) break;
          const id = actorIdOf({
            _tag: "token",
            tokenId: member.tokenId,
            clientId: member.clientId,
            name: member.name,
          });
          const rights: Partial<Record<Right, RightMode>> = {};
          if (keys.has(member.tokenId) && isAgentCircle(circle))
            for (const right of RIGHTS)
              rights[right] =
                (KEY_RIGHTS as ReadonlyArray<Right>).includes(right) &&
                member[right as (typeof KEY_RIGHTS)[number]]
                  ? { mode: "automatic" }
                  : { mode: "off" };
          chip(id, rights);
          break;
        }
        case "machine": {
          const own: Partial<Record<Right, RightMode>> = {};
          const byAgent = new Map<string, Partial<Record<Right, RightMode>>>();
          for (const right of RIGHTS) {
            const mode = member.rights?.[right];
            if (!mode) continue;
            const plain: RightMode =
              mode.mode === "ask" ? { mode: "ask", circleId: mode.circleId } : { mode: mode.mode };
            if (mode.mode === "off" || (mode.conditions ?? []).length === 0) {
              own[right] = plain;
              continue;
            }
            const id = agentId(member.machineId, mode.conditions ?? []);
            byAgent.set(id, { ...byAgent.get(id), [right]: plain });
          }
          chip(machineActor(member.machineId), own);
          for (const [id, rights] of byAgent) chip(id, rights);
          break;
        }
      }
    }
    const { machinesMayApprove, ...rest } = circle;
    return { ...rest, members, ...(machinesMayApprove === true ? { approvesWithoutPasskey: true } : {}) };
  });
  return { actors: [...actors.values()], circles: migrated, notes };
}
