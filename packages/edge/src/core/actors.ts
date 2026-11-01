// K-1778: the one migration of circle members into actors (migration 44). Pure, for tests: it reads the stored circle
// bodies of before the actor model and gives the actors and the new circle bodies.
import type { Machine } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  OWNER_CIRCLE_ID,
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
  type ShareSetting,
  actorIdOf,
  insideCircle,
  machineActorId,
  shareKey,
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
  | { readonly _tag: "everyone" }
  // A chip of after migration 44 stays as it is.
  | Extract<Member, { _tag: "actor" }>;

export type LegacyCircle = Omit<Circle, "members" | "approvesWithoutPasskey"> & {
  readonly members: ReadonlyArray<LegacyMember>;
  readonly machinesMayApprove?: boolean;
};

export interface ActorMigration {
  readonly actors: ReadonlyArray<Actor>;
  /** The stored circles, then each new devices circle of a token that left a passkey circle. */
  readonly circles: ReadonlyArray<Circle>;
  /** The share settings of the new devices circles, by `shareKey`. */
  readonly shareSettings: ReadonlyArray<readonly [string, ShareSetting]>;
  /** What the owner reads in History: each token that joined a person, each new agent actor, each devices circle. */
  readonly notes: ReadonlyArray<string>;
}

type Device = Extract<LegacyMember, { _tag: "device" }>;

/** The agent rights of a key before the actor model (K-718); every other right was off for a key (K-1732). */
const KEY_RIGHTS = ["addsApps", "publishes"] as const;

/**
 * K-1778: the actors of the stored circles.
 * - An email becomes a person actor, one per email across circles.
 * - A machine becomes a machine actor; its rights without conditions stay on its chip. Each set of conditions becomes an
 *   agent actor "<machine> <rights>" with those rights. The machine chip asks the Owner for them, so a call without the
 *   labels waits for the Owner, and no default of K-1777 runs it at once (break 5).
 * - An agent key (a device in a circle of devices and machines only, and in no circle that holds the admin) becomes a
 *   token actor. Its flags become "automatic" and its other rights "off", as before (K-1732).
 * - Another device becomes a token of the one person that every circle of the device also holds, else its own actor.
 *   The person's token then also opens the person's other circles (decision 1).
 * - A token in a circle that needs a passkey gets nothing there (the passkey line), and it stays its own actor. Its
 *   actor goes into a new circle "<actor>'s devices" without a passkey, with the place, the level and the share
 *   settings of that circle. The token keeps its cards; no login gets them without a passkey.
 * - A circle of devices and machines only was an agent circle. Now a circle needs a right set on a chip for that, so
 *   each machine chip there gets the rights that ran at once before, "maintains" and "reads the map", as automatic.
 * - A token or a machine that held the admin through a circle keeps it, with "raises access" automatic on its chip, so it
 *   still acts as the owner. Without the admin, a devices circle gets no share of it.
 */
export function migrateMembers(
  circles: ReadonlyArray<LegacyCircle>,
  machines: ReadonlyMap<string, Machine>,
  adminPlace: Point | null,
  shareSettings: ReadonlyMap<string, ShareSetting>,
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
  // The admin has only the level "control" (K-104), so any other level gives it no share.
  const givesAdmin = (circle: Pick<Circle, "id" | "level">) =>
    holdsAdmin(circle as LegacyCircle) &&
    (shareSettings.get(shareKey(ADMIN_RESOURCE_ID, circle.id))?.level ?? circle.level) === "control";
  const ACTS_AS_OWNER: Partial<Record<Right, RightMode>> = { raisesAccess: { mode: "automatic" } };
  // K-1777: the rights whose default ran at once for a machine in an agent circle. A set mode stays as it is.
  const RAN_AT_ONCE: Partial<Record<Right, RightMode>> = {
    maintains: { mode: "automatic" },
    readsMap: { mode: "automatic" },
  };
  const keptAgentCircles = new Set<string>();
  const machineDefaults = (circle: LegacyCircle): Partial<Record<Right, RightMode>> => {
    if (circle.needsPasskey || !isAgentCircle(circle)) return {};
    keptAgentCircles.add(circle.name);
    return RAN_AT_ONCE;
  };
  const actsAsOwner = (actorId: string, circleName: string) =>
    notes.push(
      `${actors.get(actorId)?.name ?? actorId} held the kitshn admin, so it has "raises access" automatic in ${circleName} and acts as the owner, as before. Set the right to default, and its access changes wait for a person.`,
    );
  const isAgentCircle = (circle: LegacyCircle) =>
    circle.members.every((member) => member._tag === "device" || member._tag === "machine");
  const emailsOf = (circle: LegacyCircle) =>
    new Set(
      circle.members.flatMap((member) => (member._tag === "email" ? [member.email.toLowerCase()] : [])),
    );

  // K-107: a device member with the token of a joined machine is that machine, as in the grant tables.
  const machineOfToken = new Map([...machines.values()].map((machine) => [machine.clientId, machine.id]));
  // Each token across circles: its circles, and whether it is an agent key.
  const devices = new Map<string, { device: Device; circles: Array<LegacyCircle> }>();
  for (const circle of circles)
    for (const member of circle.members)
      if (member._tag === "device" && !machineOfToken.has(member.clientId)) {
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
    // A token in a passkey circle stays its own actor, so its devices circle never opens the login without a passkey.
    const [first, ...rest] = held.map(emailsOf);
    const shared =
      key || !first || held.some((circle) => circle.needsPasskey)
        ? []
        : [...first].filter((email) => rest.every((emails) => emails.has(email)));
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

  /** By passkey circle id: the actors of the tokens that left it, each with the names of those tokens. */
  const tokensLeft = new Map<string, Map<string, Array<string>>>();
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
          const tokenMachine = machineOfToken.get(member.clientId);
          if (tokenMachine !== undefined && !circle.needsPasskey) {
            const id = machineActor(tokenMachine);
            chip(id, { ...machineDefaults(circle), ...(givesAdmin(circle) ? ACTS_AS_OWNER : {}) });
            if (givesAdmin(circle)) actsAsOwner(id, circle.name);
            break;
          }
          const owner = tokenMachine === undefined ? owners.get(member.tokenId) : machineActor(tokenMachine);
          const id =
            owner ??
            actorIdOf({
              _tag: "token",
              tokenId: member.tokenId,
              clientId: member.clientId,
              name: member.name,
            });
          if (circle.needsPasskey) {
            const left = tokensLeft.get(circle.id) ?? new Map<string, Array<string>>();
            left.set(id, [...(left.get(id) ?? []), member.name]);
            tokensLeft.set(circle.id, left);
            break;
          }
          if (owner) break;
          const rights: Partial<Record<Right, RightMode>> = givesAdmin(circle) ? { ...ACTS_AS_OWNER } : {};
          if (givesAdmin(circle)) actsAsOwner(id, circle.name);
          // A key never raised access by itself, so "raises access" stays at default: it asks the Owner, as before.
          if (keys.has(member.tokenId) && isAgentCircle(circle))
            for (const right of RIGHTS)
              if (right !== "raisesAccess")
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
            own[right] = { mode: "ask", circleId: OWNER_CIRCLE_ID };
          }
          for (const [right, mode] of Object.entries(machineDefaults(circle)) as Array<[Right, RightMode]>)
            own[right] ??= mode;
          if (givesAdmin(circle)) {
            Object.assign(own, ACTS_AS_OWNER);
            actsAsOwner(machineActor(member.machineId), circle.name);
          }
          chip(machineActor(member.machineId), own);
          for (const [id, rights] of byAgent) chip(id, rights);
          break;
        }
        case "actor":
          chip(member.actorId, member.rights ?? {});
          break;
        default:
          throw new Error(`Migration 44 does not know the member ${JSON.stringify(member satisfies never)}.`);
      }
    }
    const { machinesMayApprove, ...rest } = circle;
    return { ...rest, members, ...(machinesMayApprove === true ? { approvesWithoutPasskey: true } : {}) };
  });

  for (const name of keptAgentCircles)
    notes.push(
      `${name} stays an agent circle: its machines have "maintains" and "reads the map" set to automatic, as they ran before.`,
    );
  const ids = new Set(circles.map((circle) => circle.id));
  const names = new Set(circles.map((circle) => circle.name));
  const unique = (base: string, taken: Set<string>, max: number) => {
    let value = base.slice(0, max);
    for (let n = 2; taken.has(value); n++) value = `${base.slice(0, max - `-${n}`.length)}-${n}`;
    taken.add(value);
    return value;
  };
  const added: Array<Circle> = [];
  const settings: Array<readonly [string, ShareSetting]> = [];
  for (const circle of migrated) {
    const keepsAdmin = givesAdmin(circle);
    for (const [actorId, tokens] of tokensLeft.get(circle.id) ?? []) {
      const actorName = actors.get(actorId)?.name ?? actorId;
      const base =
        circle.id === OWNER_CIRCLE_ID ? `${actorName}'s devices` : `${actorName}'s devices in ${circle.name}`;
      const id = unique(`${circle.id}-devices`, ids, 63);
      const name = unique(base, names, 80);
      // In "all must match" the rules of the circle still narrow it; in "any" they would let others in.
      const rules = circle.match === "all" ? circle.members.filter((member) => member._tag !== "actor") : [];
      const { approvesWithoutPasskey: _, ...shape } = circle;
      added.push({
        ...shape,
        id,
        name,
        needsPasskey: false,
        members: [{ _tag: "actor", actorId, ...(keepsAdmin ? { rights: ACTS_AS_OWNER } : {}) }, ...rules],
      });
      for (const [key, setting] of shareSettings) {
        const prefix = key.slice(0, -`/${circle.id}`.length);
        if (key.endsWith(`/${circle.id}`) && (keepsAdmin || prefix !== ADMIN_RESOURCE_ID))
          settings.push([shareKey(prefix, id), setting]);
      }
      // The admin has only the level "control" (K-104), so "view" gives it no share here.
      if (!keepsAdmin) settings.push([shareKey(ADMIN_RESOURCE_ID, id), { level: "view", endsAt: null }]);
      notes.push(
        `${tokens.join(", ")} got nothing in ${circle.name}, which needs a passkey, so ${actorName} is in the new circle ${name}, with the same cards and levels${keepsAdmin ? "" : ", except the admin"}.`,
      );
      if (keepsAdmin) actsAsOwner(actorId, name);
    }
  }
  return { actors: [...actors.values()], circles: [...migrated, ...added], shareSettings: settings, notes };
}
