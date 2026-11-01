// Fixtures of actors and chips for tests. The Worker and the map never import this file.
import {
  RIGHTS,
  type Actor,
  type Credential,
  type Member,
  type Right,
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
export const chip = (credential: Credential, rights?: Partial<Record<Right, RightMode>>): Member => ({
  _tag: "actor",
  actorId: actorIdOf(credential),
  ...(rights ? { rights } : {}),
});

/** The rights that migration 44 gives an agent key: its flags automatic, every other right off (K-1732). */
export const keyRights = (on: { readonly addsApps?: true; readonly publishes?: true } = {}) =>
  Object.fromEntries(
    RIGHTS.map((right): [Right, RightMode] => [
      right,
      (right === "addsApps" && on.addsApps) || (right === "publishes" && on.publishes)
        ? { mode: "automatic" }
        : { mode: "off" },
    ]),
  ) as Partial<Record<Right, RightMode>>;

/** The state with these actors added. */
export const withActors = (state: State, actors: ReadonlyArray<Actor>): State => ({
  ...state,
  actors: new Map([...state.actors, ...actors.map((actor) => [actor.id, actor] as const)]),
});
