// K-723: the scenarios wait for events, never for time. A deadline only turns a missing event into a failure.

/** The longest that a scenario waits for one event; the slowest event, a provider drop, takes the grace time. */
export const DEADLINE_MS = 10_000;

/**
 * Resolves with what `start` gives to its `resolve`; rejects with what was missing after `ms`. `start` returns a
 * clean-up that runs either way.
 */
export function waitFor<T>(
  start: (resolve: (value: T) => void) => () => void,
  what: string,
  ms = DEADLINE_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no ${what} within ${ms / 1000} s`));
    }, ms);
    stop = start((value) => {
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}
