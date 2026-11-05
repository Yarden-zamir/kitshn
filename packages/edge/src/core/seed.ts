import {
  ADMIN_RESOURCE_ID,
  type Actor,
  type Credential,
  type Member,
  type Circle,
  EVERYONE_CIRCLE_ID,
  OWNER_CIRCLE_ID,
  type Point,
  type Resource,
  actorIdOf,
} from "./model.ts";

/**
 * K-211, K-104: the Owner and Everyone circles, and the admin card inside Owner. Each owner email is a person actor; the
 * owner tokens of the bootstrap are credentials of the first one (K-1778).
 */
export function seed(
  ownerEmails: ReadonlyArray<string>,
  adminHost: string,
  ownerTokens: ReadonlyArray<Extract<Credential, { _tag: "token" }>> = [],
) {
  const actors = ownerEmails.map((email, index): Actor => ({
    id: actorIdOf({ _tag: "login", email }),
    name: email,
    credentials: [{ _tag: "login", email }, ...(index === 0 ? ownerTokens : [])],
  }));
  const owner: Circle = {
    id: OWNER_CIRCLE_ID,
    name: "Owner",
    color: "#6C5CE7",
    level: "control",
    members: actors.map((actor): Member => ({ _tag: "actor", actorId: actor.id })),
    match: "any",
    needsPasskey: true,
    endsAt: null,
    x: 0,
    y: 0,
    r: 360,
  };
  const everyone: Circle = {
    id: EVERYONE_CIRCLE_ID,
    name: "Everyone",
    color: "#7CFF8A",
    level: "view",
    members: [{ _tag: "everyone" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 760,
    y: 0,
    r: 260,
  };
  const admin: Resource = {
    id: ADMIN_RESOURCE_ID,
    kind: "kitshn.admin",
    name: "kitshn admin",
    addresses: [adminHost],
    status: "running",
    group: null,
    machine: null,
  };
  const adminPlace: Point = { x: 0, y: 40 };
  return {
    actors,
    circles: [owner, everyone],
    resources: [admin],
    places: [[admin.id, adminPlace] as const],
  };
}
