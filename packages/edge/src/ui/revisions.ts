import { type Author, type RevisionKind, deepEqual } from "../core/changes.ts";
import type { RevisionView } from "../core/protocol.ts";

/** K-1508: History as plain sentences, grouped by day and by actor, with filters. Pure, for tests. */

export function actorLabel(actor: Author): string {
  switch (actor._tag) {
    case "person":
      return actor.email;
    case "device":
      return `📱 ${actor.name}`;
    case "machine":
      return `🖥️ ${actor.name}`;
    case "kitshn":
      return `kitshn (${actor.reason})`;
  }
}

/** One filter value per actor; every kitshn reason (an expiry, a deploy) is the same actor "kitshn". */
export function actorKey(actor: Author): string {
  switch (actor._tag) {
    case "person":
      return `person:${actor.email}`;
    case "device":
      return `device:${actor.clientId}`;
    case "machine":
      return `machine:${actor.machineId}`;
    case "kitshn":
      return "kitshn";
  }
}

/** The first words of summaries that are a verb, so a row under its actor reads "<verb> …". */
const VERBS = new Set([
  "Added",
  "Changed",
  "Closed",
  "Created",
  "Deleted",
  "Deployed",
  "Forgot",
  "Gave",
  "Made",
  "Moved",
  "Paused",
  "Ran",
  "Redeployed",
  "Removed",
  "Renamed",
  "Restored",
  "Resumed",
  "Set",
  "Stacked",
  "Started",
  "Took",
  "Unstacked",
]);

/**
 * A part of a share summary (describeDiff) in words, else null: "tick3d: + Everyone · view" is "shared tick3d with
 * Everyone at view", and "tick3d: Her · view → use" is "changed the level of tick3d in Her from view to use".
 */
function shareSentence(part: string): string | null {
  const arrow = part.lastIndexOf(" → ");
  if (arrow > 0) {
    const name = part.lastIndexOf(": ", arrow);
    const dot = part.lastIndexOf(" · ", arrow);
    if (name <= 0 || dot <= name) return null;
    return `changed the level of ${part.slice(0, name)} in ${part.slice(name + 2, dot)} from ${part.slice(dot + 3, arrow)} to ${part.slice(arrow + 3)}`;
  }
  const added = part.lastIndexOf(": + ");
  if (added > 0) {
    const rest = part.slice(added + 4);
    const dot = rest.lastIndexOf(" · ");
    if (dot <= 0) return null;
    return `shared ${part.slice(0, added)} with ${rest.slice(0, dot)} at ${rest.slice(dot + 3)}`;
  }
  const removed = part.lastIndexOf(": − ");
  return removed > 0 ? `removed ${part.slice(0, removed)} from ${part.slice(removed + 4)}` : null;
}

const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** The verb phrase of a summary, or null when the summary has no shape that this knows. */
function phrase(summary: string): string | null {
  if (summary.startsWith("Undo #")) {
    const colon = summary.indexOf(": ");
    const rest = colon > 0 ? phrase(summary.slice(colon + 2)) : null;
    // "Undo #12" or "Undo #12 for tick3d"; the rest says what the undo changed.
    const head = `undid #${summary.slice("Undo #".length, colon > 0 ? colon : undefined)}`;
    return rest === null ? null : `${head} and so ${rest}`;
  }
  const parts = summary.split("; ");
  // summarize() ends a long list with "and 3 more".
  const last = parts.at(-1) ?? "";
  const more = parts.length > 1 && last.startsWith("and ") && last.endsWith(" more") ? last : null;
  const shares = (more === null ? parts : parts.slice(0, -1)).map(shareSentence);
  if (shares.every((part) => part !== null))
    return more === null ? listed(shares) : `${shares.join(", ")} ${more}`;
  const first = summary.split(" ", 1)[0] ?? "";
  return VERBS.has(first) ? summary.charAt(0).toLowerCase() + summary.slice(1) : null;
}

/**
 * The text of a History row under its actor, from the summary alone, so it adds no fact: "shared tick3d with
 * Everyone at view". A summary of a shape that this does not know stays as it is.
 */
export const rowText = (summary: string): string => phrase(summary) ?? summary;

/**
 * K-1502: the toast of an undo says what came back in the words of its History row. The server sends the summary
 * of the change without the "Undo #n" label, so a card name with ": " never cuts it.
 */
export function undoneText(summary: string): string {
  const text = rowText(summary);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type Day = "Today" | "Yesterday" | "Older";

export interface HistoryGroup {
  readonly day: Day;
  readonly actor: Author;
  readonly revisions: ReadonlyArray<RevisionView>;
}

/** By local calendar dates, so a day of 23 or 25 hours (a DST change) still splits at midnight. */
export function dayOf(at: number, now: number): Day {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return at >= today.getTime() ? "Today" : at >= yesterday.getTime() ? "Yesterday" : "Older";
}

/** Newest first: the revisions of one day and one actor in a row make one group. */
export function groupHistory(revisions: ReadonlyArray<RevisionView>, now: number): Array<HistoryGroup> {
  const groups: Array<{ day: Day; actor: Author; revisions: Array<RevisionView> }> = [];
  for (const revision of revisions) {
    const day = dayOf(revision.at, now);
    const last = groups.at(-1);
    if (last && last.day === day && actorKey(last.actor) === actorKey(revision.actor))
      last.revisions.push(revision);
    else groups.push({ day, actor: revision.actor, revisions: [revision] });
  }
  return groups;
}

export interface HistoryFilter {
  readonly kind: RevisionKind | null;
  /** An `actorKey`, or null for every actor. */
  readonly actor: string | null;
  /** Words that the sentence or the name of a changed card or circle has. */
  readonly item: string;
}

export function filterHistory(
  revisions: ReadonlyArray<RevisionView>,
  filter: HistoryFilter,
  nameOf: (item: RevisionView["items"][number]) => string,
): Array<RevisionView> {
  const words = filter.item.toLowerCase().split(" ").filter(Boolean);
  return revisions.filter((revision) => {
    if (filter.kind !== null && revision.kind !== filter.kind) return false;
    if (filter.actor !== null && actorKey(revision.actor) !== filter.actor) return false;
    if (words.length === 0) return true;
    const text = [revision.summary, ...revision.items.map(nameOf)].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * K-1506, K-1508: the one History row that can take Undo: the caller's own newest revision that changes
 * something and is not undone. kitshn answers whether its undo works now (GET /api/undo).
 */
export const undoableRow = (revisions: ReadonlyArray<RevisionView>, me: Author): number | null =>
  revisions.find(
    (revision) =>
      revision.undoable &&
      revision.undoes === null &&
      revision.undoneBy === null &&
      deepEqual(revision.actor, me),
  )?.id ?? null;
