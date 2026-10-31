import { circlePolicies } from "./access.ts";
import { type State, activeShares } from "./model.ts";
import { circleMatches } from "./visitor.ts";

/**
 * The machine a signed caller may reach for a live-site card, or null when the share no longer admits it.
 * This chooses only a machine: the caller cannot supply the destination's local address. The relay must also
 * bind the card to a live registration on that machine and check both signed connections before opening it.
 */
export function siteRelayDestination(
  state: State,
  sourceId: string,
  cardId: string,
  now: number,
): string | null {
  // A relay is a machine-to-machine capability. A pause ends it even when public sites stay visible to people.
  if (state.paused !== null) return null;
  const source = state.machines.get(sourceId);
  const card = state.resources.get(cardId);
  if (
    !source ||
    !card ||
    card.kind !== "site.live" ||
    !card.machine ||
    card.machine === sourceId ||
    !state.machines.has(card.machine)
  )
    return null;
  const visitor = { email: null, clientId: source.clientId, ip: null };
  const allowed = activeShares(state, card, now).some(({ circle }) => {
    if (!circleMatches(circle, visitor, state.machines)) return false;
    // A circle can match the local model yet be impossible to enforce in Access (e.g. an all-of circle
    // containing a person and a service token). Never silently turn such a circle into a machine grant.
    return [...circlePolicies(circle, state.machines).values()].some(
      (policy) => policy.decision === "non_identity" || policy.decision === "bypass",
    );
  });
  return allowed ? card.machine : null;
}

/** Per-direction bounds for a stream. A receiver returns credit only after its local consumer drains bytes. */
export const SITE_RELAY_FRAME_BYTES = 16 * 1024;
export const SITE_RELAY_WINDOW_BYTES = 64 * 1024;

/** Bounds bytes in flight; duplicate, oversized and malformed credits cannot grow the window. */
export class SiteRelayWindow {
  private available = SITE_RELAY_WINDOW_BYTES;

  remaining(): number {
    return this.available;
  }

  take(bytes: number): boolean {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > SITE_RELAY_FRAME_BYTES ||
      bytes > this.available
    )
      return false;
    this.available -= bytes;
    return true;
  }

  give(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.available + bytes > SITE_RELAY_WINDOW_BYTES)
      return false;
    this.available += bytes;
    return true;
  }
}
