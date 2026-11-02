/** K-1125, K-1126: uptime of app and live site cards. */

export interface Uptime {
  readonly up: boolean;
  /** When an up card first failed in a row of failures, or null. */
  readonly failingSince: number | null;
  /** When `up` last changed; 0 for a card that kitshn never saw down. */
  readonly since: number;
}

export interface UptimeChange {
  readonly at: number;
  readonly up: boolean;
}

/** A card with no row: up, with no failure. kitshn keeps rows only for cards that are down or failing (K-1126). */
export const UP: Uptime = { up: true, failingSince: null, since: 0 };

/** True when the state needs a row; a card that is up with no failure has none. */
export const stored = (uptime: Uptime) => !uptime.up || uptime.failingSince !== null;

/**
 * K-1125: a card goes down when it still fails 5 minutes after its first failure, so a short error, a deploy of
 * kitshn or a daemon that reconnects never makes it down. kitshn counts by time, not by alarm runs. Known limit: a
 * card that comes back and fails again between two turns counts as one failure. Revisit if that hides real outages.
 */
export const DOWN_AFTER_MS = 5 * 60_000;
/** K-1126: fetches per alarm run, inside the 50 subrequests of one run (K-406). */
export const UPTIME_FETCHES_PER_RUN = 8;
/** K-1126: the length of one turn; an alarm in the same turn fetches nothing. */
export const UPTIME_RUN_MS = 2 * 60_000;
/**
 * K-1126: uptime runs at least this often, and each UPTIME_RUN_MS while a card fails but is not down yet. A run fetches
 * one group of at most 8 addresses, so a card waits groups × 5 minutes (40 one-address cards: 5 groups, 25 minutes).
 */
export const UPTIME_TURN_MS = 5 * 60_000;
/** K-1126: changes stay this long. */
export const UPTIME_KEEP_MS = 30 * 24 * 60 * 60_000;

/** K-1125: a status of 500 or higher, or no answer (null), is a failure. Access answers a login, so 3xx counts as up. */
export const probeUp = (status: number | null) => status !== null && status < 500;

/**
 * The next state of a card after one probe, the same rule for every card kind. A card that goes down is down since
 * its first failure. It returns the same object when nothing changes, so the caller writes no row.
 */
export function nextUptime(before: Uptime, probe: boolean, now: number): Uptime {
  if (probe)
    return before.up && before.failingSince === null
      ? before
      : { up: true, failingSince: null, since: before.up ? before.since : now };
  if (!before.up) return before;
  const first = before.failingSince ?? now;
  if (now - first >= DOWN_AFTER_MS) return { up: false, failingSince: null, since: first };
  return before.failingSince === null ? { ...before, failingSince: now } : before;
}

/**
 * K-1126: the cards whose addresses run number `run` fetches. The cards go into groups of at most `perRun` addresses,
 * in order, and each run takes the next group, so each card gets a turn with all its addresses in the same run (K-817
 * allows at most 5, which fit in one group).
 */
export function cardsOfRun<T extends { readonly addresses: ReadonlyArray<string> }>(
  cards: ReadonlyArray<T>,
  run: number,
  perRun: number,
): Array<T> {
  const groups: Array<Array<T>> = [];
  let size = perRun;
  for (const card of cards) {
    if (card.addresses.length > perRun)
      throw new Error(
        `A card has ${card.addresses.length} addresses; one uptime run fetches at most ${perRun}.`,
      );
    if (size + card.addresses.length > perRun) {
      groups.push([]);
      size = 0;
    }
    groups.at(-1)?.push(card);
    size += card.addresses.length;
  }
  return groups.length === 0 ? [] : (groups[run % groups.length] ?? []);
}

/**
 * K-1126: what one run fetches: the failing cards first, so K-1125 decides about 5 minutes after a first failure for
 * any number of groups, then the cards of the run's group that still fit in `perRun` addresses. `whole` is false
 * when a card of the group did not fit; the run counter then stays, so that group comes again. Known limit: failing
 * cards beyond `perRun` addresses wait for their own group. Revisit if many cards fail at once often.
 */
export function cardsToFetch<T extends { readonly id: string; readonly addresses: ReadonlyArray<string> }>(
  failing: ReadonlyArray<T>,
  group: ReadonlyArray<T>,
  perRun: number,
): { readonly cards: Array<T>; readonly whole: boolean } {
  const cards: Array<T> = [];
  let size = 0;
  const take = (card: T) => {
    if (cards.some((each) => each.id === card.id)) return true;
    if (size + card.addresses.length > perRun) return false;
    cards.push(card);
    size += card.addresses.length;
    return true;
  };
  for (const card of failing) take(card);
  const whole = group.map(take).every(Boolean);
  return { cards, whole };
}
