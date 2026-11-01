import type { Machine } from "./machine.ts";
import {
  type Actor,
  type Circle,
  type Credential,
  type Directory,
  type Level,
  type Member,
  type RightCondition,
  type Resource,
  type State,
  activeShares,
  isPublicCircle,
  levelRank,
} from "./model.ts";

/** Who sent a request, as Access and Cloudflare tell the Worker (K-404). */
export interface Visitor {
  readonly email: string | null;
  /** The service token client id, from the `common_name` claim. */
  readonly clientId: string | null;
  readonly ip: string | null;
}

function ipBytes(ip: string): Array<number> | null {
  if (ip.includes(".") && !ip.includes(":")) {
    const parts = ip.split(".").map(Number);
    return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      ? parts
      : null;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const all = [...head, ...Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  return all.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

export function ipInRange(ip: string, range: string): boolean {
  const [base, bitsText] = range.split("/");
  const address = ipBytes(ip);
  const network = base ? ipBytes(base) : null;
  const bits = Number(bitsText);
  if (!address || !network || address.length !== network.length) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > network.length * 8) return false;
  for (let bit = 0; bit < bits; bit++) {
    const mask = 0x80 >> (bit % 8);
    if (((address[bit >> 3] ?? 0) & mask) !== ((network[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

/** K-1754: the verified labels of a machine call, and the label prefixes of the providers of its machine. */
export interface Attested {
  readonly labels: Readonly<Record<string, string>>;
  readonly prefixes: ReadonlyArray<string>;
}

/**
 * K-1754: every condition holds on a verified label. A condition counts only on the prefix of a provider of the machine,
 * because only then the daemon dropped the caller's own labels of it (K-1753).
 */
export const conditionsHold = (conditions: ReadonlyArray<RightCondition>, attested: Attested | null) =>
  conditions.every((condition) => {
    const value = attested?.labels[condition.key];
    return (
      attested !== null &&
      attested.prefixes.some((prefix) => condition.key.startsWith(prefix)) &&
      value !== undefined &&
      condition.values.includes(value)
    );
  });

export function credentialMatches(
  credential: Credential,
  visitor: Visitor,
  machines: ReadonlyMap<string, Machine>,
): boolean {
  switch (credential._tag) {
    case "login":
      return visitor.email !== null && visitor.email.toLowerCase() === credential.email.toLowerCase();
    case "token":
      return visitor.clientId !== null && visitor.clientId === credential.clientId;
    case "machine": {
      const machine = machines.get(credential.machineId);
      return machine !== undefined && visitor.clientId === machine.clientId;
    }
  }
}

/**
 * K-1778: a proof is this actor when one of its credentials proved the call, and every condition holds on a verified
 * label. Access sees no label, so an actor with conditions never matches there (`attested` null).
 */
export const actorMatches = (
  actor: Actor,
  visitor: Visitor,
  machines: ReadonlyMap<string, Machine>,
  attested: Attested | null,
) =>
  actor.credentials.some((credential) => credentialMatches(credential, visitor, machines)) &&
  ((actor.conditions ?? []).length === 0 || conditionsHold(actor.conditions ?? [], attested));

export function memberMatches(
  member: Member,
  visitor: Visitor,
  directory: Directory,
  attested: Attested | null = null,
): boolean {
  const email = visitor.email?.toLowerCase() ?? null;
  switch (member._tag) {
    case "actor": {
      const actor = directory.actors.get(member.actorId);
      return actor !== undefined && actorMatches(actor, visitor, directory.machines, attested);
    }
    case "domain":
      return email !== null && email.endsWith(`@${member.domain.toLowerCase()}`);
    case "ip":
      return typeof visitor.ip === "string" && ipInRange(visitor.ip, member.range);
    case "everyone":
      return true;
  }
}

/** K-203. An empty circle matches nobody. The passkey check runs in Access (K-103); see `passkeyHolds`. */
export function circleMatches(
  circle: Circle,
  visitor: Visitor,
  directory: Directory,
  attested: Attested | null = null,
): boolean {
  if (circle.members.length === 0) return false;
  return circle.match === "all"
    ? circle.members.every((member) => memberMatches(member, visitor, directory, attested))
    : circle.members.some((member) => memberMatches(member, visitor, directory, attested));
}

/**
 * K-1778: the passkey line. A circle that needs a passkey holds a visitor only with a login, because only a person at a
 * device proves a passkey (K-103). So no token, machine or network holds such a circle, also a token of the owner.
 */
export const passkeyHolds = (circle: Circle, visitor: Visitor) =>
  !circle.needsPasskey || visitor.email !== null;

/** K-207: the highest level of the shares whose circle matches the visitor, or null. */
export function visitorLevel(state: State, resource: Resource, visitor: Visitor, now: number): Level | null {
  let best: Level | null = null;
  for (const share of activeShares(state, resource, now)) {
    // K-1504: during a pause only people and public circles pass, as in Access: no device, machine or network-only visitor.
    if (state.paused && visitor.email === null && !isPublicCircle(share.circle)) continue;
    if (!passkeyHolds(share.circle, visitor)) continue;
    if (!circleMatches(share.circle, visitor, state)) continue;
    if (best === null || levelRank(share.level) > levelRank(best)) best = share.level;
  }
  return best;
}
