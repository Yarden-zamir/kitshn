// K-830 to K-836: value sets, the resolution of the names that a deploy needs, and the texts about them.
import { PREVIEWS, type ValueKind } from "kitshn/values";
import { isPreview } from "./agent.ts";
import type { Author } from "./changes.ts";

export type { ValueKind } from "kitshn/values";

/**
 * K-830: the key of a value set: `<repo id>:<app key>:<environment>`, with `previews` for every `pr-<n>`. It keys on
 * the GitHub repository id, as the repo gate does (K-819), so a rename or a transfer keeps the values.
 */
export const valueSetKey = (repoId: string, appKey: string, environment: string) =>
  `${repoId}:${appKey}:${isPreview(environment) ? PREVIEWS : environment}`;

export interface ValueSetParts {
  readonly repoId: string;
  readonly appKey: string;
  /** A push environment, or `previews`. */
  readonly environment: string;
}

/** K-830: the parts of a set key, or null when the text is none. */
export function parseValueSet(key: string): ValueSetParts | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  const [repoId = "", appKey = "", environment = ""] = parts;
  const digits = (text: string) => text !== "" && [...text].every((char) => char >= "0" && char <= "9");
  const label = (text: string) =>
    text !== "" &&
    [...text].every((char) => char === "-" || (char >= "a" && char <= "z") || (char >= "0" && char <= "9"));
  return digits(repoId) && label(appKey) && label(environment) && !isPreview(environment)
    ? { repoId, appKey, environment }
    : null;
}

/** K-830: where a needed value came from in one deploy. A GitHub value wins over the store (K-831). */
export type ValueSource = "kitshn" | "github";

/** K-831: one name that a deploy delivered: never the value. `version` names the store row; null for GitHub. */
export interface UsedValue {
  readonly name: string;
  readonly kind: ValueKind;
  readonly source: ValueSource;
  readonly version: number | null;
}

/** K-831: a needed name that has no value, or a value of the other kind. */
export interface MissingValue {
  readonly name: string;
  readonly kind: ValueKind;
  readonly why: "missing" | "kind";
}

/** K-831: what the store holds of one name; never the value. */
export interface StoredName {
  readonly kind: ValueKind;
  readonly version: number;
}

export interface Needed {
  readonly secrets?: ReadonlyArray<string>;
  readonly vars?: ReadonlyArray<string>;
}

/**
 * K-831: the source of each needed name: a GitHub value of the run first, then the store row of its value set with the
 * same kind. A store row of the other kind counts as missing, so a secret never reaches an app as a plain var.
 */
export function resolveValues(
  needs: Needed,
  stored: ReadonlyMap<string, StoredName>,
  github: ReadonlySet<string>,
): { readonly used: ReadonlyArray<UsedValue>; readonly missing: ReadonlyArray<MissingValue> } {
  const used: Array<UsedValue> = [];
  const missing: Array<MissingValue> = [];
  const wanted = [
    ...(needs.secrets ?? []).map((name) => ({ name, kind: "secret" as const })),
    ...(needs.vars ?? []).map((name) => ({ name, kind: "var" as const })),
  ];
  for (const { name, kind } of wanted) {
    if (github.has(name)) {
      used.push({ name, kind, source: "github", version: null });
      continue;
    }
    const row = stored.get(name);
    if (row === undefined) missing.push({ name, kind, why: "missing" });
    else if (row.kind !== kind) missing.push({ name, kind, why: "kind" });
    else used.push({ name, kind, source: "kitshn", version: row.version });
  }
  return { used, missing };
}

/** K-831: the command that sets one missing value. */
export const setCommand = (setKey: string, missing: Pick<MissingValue, "name" | "kind">) =>
  `kitshn secret set ${setKey} ${missing.name}${missing.kind === "var" ? " --var" : ""} < value-file`;

/**
 * K-831: the refusal of a deploy with missing names: each name with the command that sets it. `label` names the app
 * and its environment for people, for example `riffle prod`.
 */
export function missingText(label: string, setKey: string, missing: ReadonlyArray<MissingValue>): string {
  const lines = missing.map((item) => {
    const why =
      item.why === "kind"
        ? ` is set as a ${item.kind === "secret" ? "var" : "secret"}; the recipe needs a ${item.kind}`
        : "";
    return `  ${item.name} (${item.kind})${why}: ${setCommand(setKey, item)}`;
  });
  const count = missing.length === 1 ? "1 value" : `${missing.length} values`;
  return [
    `${label} is missing ${count}, so nothing was deployed (K-831). Set them in the map (Values…) or with:`,
    ...lines,
  ].join("\n");
}

/** K-831: the used names of a deploy row, as its `values_used` column holds them; null and older rows have none. */
export function parseUsed(text: string | null): ReadonlyArray<UsedValue> {
  if (text === null) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("values_used is not a list (K-831).");
  return value.map((item: unknown) => {
    const row = item as Record<string, unknown>;
    const { name, kind, source, version } = row;
    if (
      typeof name !== "string" ||
      (kind !== "secret" && kind !== "var") ||
      (source !== "kitshn" && source !== "github") ||
      (version !== null && typeof version !== "number")
    )
      throw new Error(`values_used holds an entry of an unknown shape: ${JSON.stringify(item)} (K-831).`);
    return { name, kind, source, version };
  });
}

/**
 * K-835: the names of a card that a change of `name` in its value set makes stale: only a name that its live build got
 * from the store. A GitHub value wins, so a store change does not reach it.
 */
export const staleAfter = (live: ReadonlyArray<UsedValue>, name: string): boolean =>
  live.some((used) => used.name === name && used.source === "kitshn");

/**
 * K-835: the state of one name of a value set in the Values view. `github`: the newest live build got it from a GitHub
 * `KITSHN_<NAME>`, which wins over the store. `kind`: the store holds it as the other kind. `unused`: the store holds
 * it, and the newest plan of the set did not need it.
 */
export type NameState = "set" | "missing" | "github" | "kind" | "unused";

export interface NameView {
  readonly name: string;
  readonly kind: ValueKind;
  readonly state: NameState;
  readonly version: number | null;
  readonly setAt: number | null;
  readonly setBy: Author | null;
  /** A var only: its value. */
  readonly value?: string;
}

/** K-835: one value set in the Values view, with its cards and the names that they still need to get. */
export interface ValueSetView {
  readonly key: string;
  readonly label: string;
  readonly repo: string;
  readonly appKey: string;
  readonly environment: string;
  readonly cards: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly stale: ReadonlyArray<string>;
  }>;
  /** Null while no deploy planned this set. */
  readonly needs: { readonly secrets: ReadonlyArray<string>; readonly vars: ReadonlyArray<string> } | null;
  readonly names: ReadonlyArray<NameView>;
}

/** K-835: the names of a set for the Values view: the needed names first, then the ones that no plan needs. */
export function nameViews(
  needs: ValueSetView["needs"],
  stored: ReadonlyArray<
    Omit<NameView, "state" | "version" | "setAt" | "setBy"> & {
      readonly version: number;
      readonly setAt: number;
      readonly setBy: Author;
    }
  >,
  github: ReadonlySet<string>,
): Array<NameView> {
  const byName = new Map(stored.map((row) => [row.name, row]));
  const needed = [
    ...(needs?.secrets ?? []).map((name) => ({ name, kind: "secret" as const })),
    ...(needs?.vars ?? []).map((name) => ({ name, kind: "var" as const })),
  ];
  const views: Array<NameView> = needed.map(({ name, kind }) => {
    const row = byName.get(name);
    const state: NameState = github.has(name)
      ? "github"
      : row === undefined
        ? "missing"
        : row.kind === kind
          ? "set"
          : "kind";
    return row === undefined
      ? { name, kind, state, version: null, setAt: null, setBy: null }
      : { ...row, kind, state };
  });
  for (const row of stored)
    if (!needed.some((item) => item.name === row.name)) views.push({ ...row, state: "unused" });
  return views;
}

/** K-831: the names of the `KITSHN_<NAME>` values that the deploy step got from GitHub, as the CLI sends them. */
export function githubNames(value: unknown): ReadonlySet<string> | string {
  if (value === undefined) return new Set();
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((name) => typeof name !== "string" || name.length > 100)
  )
    return "github is a list of at most 200 value names (K-831).";
  return new Set(value as Array<string>);
}
