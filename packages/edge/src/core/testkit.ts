// Fixtures of actors and chips for tests. The Worker and the map never import this file.
import {
  EFFECTS,
  type Actor,
  type Credential,
  type Member,
  type Effect,
  type RightMode,
  type State,
  actorIdOf,
} from "./model.ts";

export const login = (email: string) => ({ _tag: "login", email }) as const;
export const token = (tokenId: string, clientId: string, name: string) =>
  ({ _tag: "token", tokenId, clientId, name }) as const;
export const machineKey = (machineId: string) => ({ _tag: "machine", machineId }) as const;

/** An actor of one credential, named after it unless `name` says otherwise. */
export function actorOf(credential: Credential, name?: string): Actor {
  const fallback =
    credential._tag === "login"
      ? credential.email
      : credential._tag === "token"
        ? credential.name
        : credential.machineId;
  return { id: actorIdOf(credential), name: name ?? fallback, credentials: [credential] };
}

/** The chip of the actor of a credential, with these rights. */
export const chip = (credential: Credential, rights?: Partial<Record<Effect, RightMode>>): Member => ({
  _tag: "actor",
  actorId: actorIdOf(credential),
  ...(rights ? { rights } : {}),
});

/** A key in its agent circle: the effects that it names automatic, every other effect off (K-1732). */
export const keyRights = (on: Readonly<Partial<Record<Effect, true>>> = {}) =>
  Object.fromEntries(
    EFFECTS.map((effect): [Effect, RightMode] => [
      effect,
      on[effect] ? { mode: "automatic" } : { mode: "off" },
    ]),
  );

/** The state with these actors added. */
export const withActors = (state: State, actors: ReadonlyArray<Actor>): State => ({
  ...state,
  actors: new Map([...state.actors, ...actors.map((actor) => [actor.id, actor] as const)]),
});
