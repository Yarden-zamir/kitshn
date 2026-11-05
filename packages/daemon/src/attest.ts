// K-1752, K-1753: a provider vouches for the agent that asks (`attest`); only that provider sets the labels of its
// prefix, so a caller's own label never takes a name that a provider owns.

/** K-1755: `t3.` stays reserved also on a machine where T3 never registered. */
const RESERVED_PREFIXES: ReadonlyArray<string> = ["t3."];

/** K-1753: the label prefix of each registered provider, and the reserved ones. */
export const labelPrefixes = (providers: Iterable<string>): ReadonlyArray<string> => [
  ...new Set([...RESERVED_PREFIXES, ...[...providers].map((name) => `${name}.`)]),
];

/** K-1753: the caller's labels without the ones that a provider sets. */
export const dropAttested = (
  labels: Readonly<Record<string, string>>,
  prefixes: ReadonlyArray<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels).filter(([key]) => !prefixes.some((prefix) => key.startsWith(prefix))),
  );
