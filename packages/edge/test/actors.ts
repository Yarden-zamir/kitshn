// K-1778: the actors of the Worker tests. A chip that a helper makes names its actor, and `withActors` puts the edits
// of those actors before the edits that use them, as the map does when it adds a member.
import type { Edit } from "../src/core/changes.ts";
import {
  type Actor,
  type Member,
  type Right,
  type RightCondition,
  type RightMode,
  actorIdOf,
} from "../src/core/model.ts";
import { actorOf, keyRights, login, machineKey, token } from "../src/core/testkit.ts";

const known = new Map<string, Actor>();

const chipOf = (actor: Actor, rights?: Partial<Record<Right, RightMode>>): Member => {
  known.set(actor.id, actor);
  return { _tag: "actor", actorId: actor.id, ...(rights ? { rights } : {}) };
};

/** A person by an email. */
export const person = (email: string) => chipOf(actorOf(login(email)));

/** A machine actor, with these rights in the circle. */
export const machine = (machineId: string, rights?: Partial<Record<Right, RightMode>>) =>
  chipOf(actorOf(machineKey(machineId), machineId), rights);

/** An agent actor of a machine: the calls with these verified labels (K-1754). */
export const agent = (
  machineId: string,
  conditions: ReadonlyArray<RightCondition>,
  rights?: Partial<Record<Right, RightMode>>,
) =>
  chipOf(
    {
      ...actorOf(machineKey(machineId), `${machineId} agent`),
      id: actorIdOf(machineKey(machineId), conditions),
      conditions,
    },
    rights,
  );

/** An agent key as migration 44 makes it: a token actor whose flags are automatic and other rights off (K-1732). */
export const key = (
  tokenId: string,
  clientId: string,
  name: string,
  flags: { readonly addsApps?: true; readonly publishes?: true } = {},
) => chipOf(actorOf(token(tokenId, clientId, name)), keyRights(flags));

/** A token actor with no right set, such as a phone of its own. */
export const tokenActor = (tokenId: string, clientId: string, name: string) =>
  chipOf(actorOf(token(tokenId, clientId, name)));

/** The edits of the actors that the circle edits name, then the edits. It reads loose test literals too. */
export function withActors<T extends object>(edits: ReadonlyArray<T>): Array<T | Edit> {
  const named = new Set(
    edits.flatMap((edit) => {
      const circle = edit as Partial<Extract<Edit, { _tag: "circle" }>>;
      return circle._tag === "circle" && circle.after
        ? circle.after.members.flatMap((member) => (member._tag === "actor" ? [member.actorId] : []))
        : [];
    }),
  );
  const actors = [...named].flatMap((id): Array<Edit> => {
    const actor = known.get(id);
    return actor ? [{ _tag: "actor", id, after: actor }] : [];
  });
  return [...actors, ...edits];
}

/** The rows of the actors that these members name, for a test that writes circle rows itself. */
export const actorRows = (members: ReadonlyArray<Member>): Array<[string, string]> =>
  members.flatMap((member) => {
    const actor = member._tag === "actor" ? known.get(member.actorId) : undefined;
    return actor ? [[actor.id, JSON.stringify(actor)] as [string, string]] : [];
  });

export const ACTOR_ROW = "INSERT OR REPLACE INTO actors (id, body) VALUES (?, ?)";

/** Writes the rows of the actors that these members name. */
export function insertActors(sql: SqlStorage, members: ReadonlyArray<Member>) {
  for (const [id, body] of actorRows(members)) sql.exec(ACTOR_ROW, id, body);
}
