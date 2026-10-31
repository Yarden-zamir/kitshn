import { describe, expect, it } from "vitest";
import { DOWN_AFTER_MS, UP, cardsOfRun, nextUptime, probeUp, stored } from "./uptime.ts";

describe("uptime (K-1125, K-1126)", () => {
  it("counts a server error or no answer as a failure, and an Access login as up", () => {
    expect([200, 302, 404, 499].map(probeUp)).toEqual([true, true, true, true]);
    expect([500, 502, 530, null].map(probeUp)).toEqual([false, false, false, false]);
  });

  it("makes a card down only when it still fails 5 minutes after its first failure, and up after one success", () => {
    const once = nextUptime(UP, false, 1_000);
    expect(once).toEqual({ up: true, failingSince: 1_000, since: 0 });
    // A spike that still fails on the next turns, for example a daemon that reconnects, does not make the card down.
    expect(nextUptime(once, false, 1_000 + 4 * 60_000)).toBe(once);
    expect(nextUptime(once, true, 5_000)).toEqual(UP);
    const down = nextUptime(once, false, 1_000 + DOWN_AFTER_MS);
    // The card is down since its first failure, so the strip shows the full down time.
    expect(down).toEqual({ up: false, failingSince: null, since: 1_000 });
    expect(nextUptime(down, true, 900_000)).toEqual({ up: true, failingSince: null, since: 900_000 });
  });

  it("returns the same state when nothing changes, and keeps a row only for a card that is down or failing", () => {
    const down = { up: false, failingSince: null, since: 5 };
    expect(nextUptime(UP, true, 10)).toBe(UP);
    expect(nextUptime(down, false, 10)).toBe(down);
    expect(stored(UP)).toBe(false);
    expect(stored({ ...UP, since: 30 })).toBe(false);
    expect(stored({ ...UP, failingSince: 1 })).toBe(true);
    expect(stored(down)).toBe(true);
  });

  it("gives each card a turn, with all its addresses in the same run", () => {
    const card = (id: string, count: number) => ({
      id,
      addresses: Array.from({ length: count }, (_, i) => `${id}${i}`),
    });
    const cards = [card("a", 5), card("b", 4), card("c", 3), card("d", 1)];
    const runs = [0, 1, 2].map((slot) => cardsOfRun(cards, slot, 8).map((each) => each.id));
    expect(runs).toEqual([["a"], ["b", "c", "d"], ["a"]]);
    for (const run of runs)
      expect(
        run.reduce((total, id) => total + (cards.find((each) => each.id === id)?.addresses.length ?? 0), 0),
      ).toBeLessThanOrEqual(8);
  });
});
