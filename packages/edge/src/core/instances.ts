import type { Placement } from "kitshn/recipe";
import { fnv } from "./model.ts";
import type { RESOURCE_STATUSES, Resource } from "./model.ts";

export type { Placement } from "kitshn/recipe";

/** K-824: an instance of a Compose card with its own address; the home one keeps its status on the card. */
export interface Instance {
  readonly machine: string;
  readonly address: string;
  /** K-827: from the live site of its machine, as the card status comes from the home one. */
  readonly status: (typeof RESOURCE_STATUSES)[number];
  /** K-827: its last job failed or expired, so it may run an old build until the next deploy. */
  readonly stale?: true;
}

/**
 * K-823, K-825: a machine as placement sees it. `fit` is "yes" when every rule of K-823 holds now, "no" when one
 * fails, and "unknown" for an offline machine, whose fact labels are unknown (K-635).
 */
export interface Candidate {
  readonly id: string;
  readonly order: number;
  readonly fit: "yes" | "no" | "unknown";
  /** K-826: its daemon checks that a spread app has no volumes. */
  readonly spreadReady: boolean;
  /** K-823: the higher of CPU and memory in the newest sample, or null without one. */
  readonly load: number | null;
}

export const placementOf = (compose: { readonly placement?: Placement } | null): Placement =>
  compose?.placement ?? "one";

/** K-823: the number of instances that a placement wants, or null for "every". */
const wanted = (placement: Placement): number | null =>
  placement === "one" ? 1 : placement === "every" ? null : placement.spread;

const byOrder = (a: Candidate, b: Candidate) => a.order - b.order;
/** K-823: the least busy first; a machine without a sample counts as the busiest, and ties go by order. */
const byLoad = (a: Candidate, b: Candidate) =>
  (a.load ?? Number.POSITIVE_INFINITY) - (b.load ?? Number.POSITIVE_INFINITY) || byOrder(a, b);

/**
 * K-823, K-825: the machines of a deploy, the home one first. `current` holds the machines of the card now, the home
 * one first; a machine that is not among the candidates left. The home machine stays even when it does not fit,
 * because the caller refuses that case (K-825). Returns no machine when nothing fits.
 */
export function placeMachines(
  placement: Placement,
  candidates: ReadonlyArray<Candidate>,
  current: ReadonlyArray<string>,
): Array<string> {
  const known = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const [home, ...others] = current;
  const count = wanted(placement);
  const kept = [
    ...(home === undefined ? [] : [home]),
    ...others.filter((id) => (known.get(id)?.fit ?? "no") !== "no"),
  ].slice(0, count ?? undefined);
  const free = candidates.filter(
    (candidate) =>
      candidate.fit === "yes" &&
      !kept.includes(candidate.id) &&
      (typeof placement === "string" || candidate.spreadReady),
  );
  const added = [...free]
    .sort(typeof placement === "string" ? byOrder : byLoad)
    .map((candidate) => candidate.id);
  return [...kept, ...added].slice(0, count ?? undefined);
}

/**
 * K-825: what a placement wants of a card with a finished deploy, between deploys: the other instances whose machine
 * no longer qualifies, and whether a build adds an instance (a free machine for "every", a gap for spread).
 */
export function placementDrift(
  placement: Placement,
  candidates: ReadonlyArray<Candidate>,
  current: ReadonlyArray<string>,
): { readonly drop: ReadonlyArray<string>; readonly build: boolean } {
  const [, ...others] = current;
  const fitOf = (id: string) => candidates.find((candidate) => candidate.id === id)?.fit ?? "no";
  if (placement === "one") return { drop: others, build: false };
  const drop = others.filter((id) => fitOf(id) === "no");
  const next = placeMachines(placement, candidates, current);
  return { drop, build: next.some((id) => !current.includes(id)) };
}

/** K-824: a DNS label, as a machine name gives it: lowercase letters, digits and single dashes. */
const label = (name: string) =>
  name
    .toLowerCase()
    .split("")
    .map((char) => ((char >= "a" && char <= "z") || (char >= "0" && char <= "9") ? char : "-"))
    .join("")
    .split("-")
    .filter((part) => part !== "")
    .join("-");

/**
 * K-824: the address of an instance: `<main name>-<machine name>.<zone>`, or a hash of the machine id when that name
 * is too long, empty, or `taken` holds it.
 */
export function instanceAddress(
  main: string,
  machine: { readonly id: string; readonly name: string },
  zone: string,
  taken: ReadonlyArray<string>,
): string {
  const mainName = main.slice(0, -zone.length - 1);
  const named = label(machine.name);
  const first = `${mainName}-${named}`;
  if (named !== "" && first.length <= 63 && !taken.includes(`${first}.${zone}`)) return `${first}.${zone}`;
  return `${mainName.slice(0, 63 - 9)}-${fnv(machine.id)}.${zone}`;
}

/** K-824: an instance of a card, with `home` for the one on the card's machine. */
export type CardInstance = Instance & { readonly home: boolean };

/** K-824: the instances of a card other than the home one. */
export const otherInstances = (card: Pick<Resource, "machine" | "instances">): ReadonlyArray<Instance> =>
  (card.instances ?? []).filter((instance) => instance.machine !== card.machine);

/**
 * K-824, K-827: every instance of a Compose card, the home one first. The home one has the card status and its own
 * address when it has one, else the main address.
 */
export function cardInstances(
  card: Pick<Resource, "machine" | "addresses" | "status" | "instances">,
): Array<CardInstance> {
  if (card.machine === null) return [];
  const own = card.instances?.find((instance) => instance.machine === card.machine);
  return [
    {
      machine: card.machine,
      address: own?.address ?? card.addresses[0] ?? "",
      status: card.status,
      home: true,
    },
    ...otherInstances(card).map((instance) => ({ ...instance, home: false })),
  ];
}

/**
 * K-828: the primary, the instance that the main address goes to. Without failover, the home one. With failover, the
 * current one while it stays healthy, else the first healthy one in the owner's order of machines. Healthy is an
 * online machine and a running instance that is not stale. With none healthy, the records stay where they are.
 */
export function primaryInstance<T extends Pick<CardInstance, "machine" | "status" | "stale" | "home">>(
  instances: ReadonlyArray<T>,
  order: (machineId: string) => number,
  online: (machineId: string) => boolean,
  options: { readonly failover: boolean; readonly current: string | null },
): T | undefined {
  const home = instances.find((instance) => instance.home) ?? instances[0];
  if (!options.failover) return home;
  const healthy = (instance: T) =>
    online(instance.machine) && instance.status === "running" && instance.stale !== true;
  const current = instances.find((instance) => instance.machine === options.current);
  if (current && healthy(current)) return current;
  const sorted = [...instances].sort((a, b) => order(a.machine) - order(b.machine));
  return sorted.find(healthy) ?? current ?? home;
}

/**
 * K-826: why a spread deploy cannot go to these machines: one of them has a daemon that does not check for volumes.
 * Null for any other placement, or when every machine has the capability `compose-spread`.
 */
export function spreadRefusal(
  placement: Placement,
  candidates: ReadonlyArray<Pick<Candidate, "id" | "spreadReady">>,
  machineIds: ReadonlyArray<string>,
  nameOf: (machineId: string) => string,
): string | null {
  if (typeof placement === "string") return null;
  const old = machineIds.filter(
    (id) => !candidates.some((candidate) => candidate.id === id && candidate.spreadReady),
  );
  return old.length === 0
    ? null
    : `A spread app runs only where the daemon checks that it has no volumes; update the daemon on ${old.map(nameOf).join(", ")} first (K-826).`;
}
