// K-724: the wire schema of this package as JSON Schema, and the bump that a change of it needs.
// Known limit: JSON Schema shows no custom filter (such as `isLabelKey`) and no meaning of a field, so a narrower
// filter or a new meaning of the same shape looks like no change. Revisit when such a change breaks a peer.
import { Schema } from "effect";
import { Answer, Request } from "./index.ts";
import { GrantTables, ProviderAccess, ProviderClient, ProviderReport, ProviderResource } from "./provider.ts";
import { parseProtocol } from "./protocol.ts";

/** Every message of the local socket, and what the daemon and kitshn exchange with the schemas of this package. */
const Wire = Schema.Struct({
  request: Request,
  answer: Answer,
  resource: ProviderResource,
  client: ProviderClient,
  report: ProviderReport,
  grants: GrantTables,
  access: ProviderAccess,
});

export const wireSchema = (): unknown => JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(Wire).schema));

export interface WireChange {
  /** Removed or narrowed parts: a major bump. */
  readonly major: Array<string>;
  /** Added or widened parts: a minor bump. */
  readonly minor: Array<string>;
}

type Json = Record<string, unknown>;
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const UPPER = ["maxLength", "maxItems", "maximum", "exclusiveMaximum"];
const LOWER = ["minLength", "minItems", "minimum", "exclusiveMinimum"];

/** The name of a union member in a message: its `type` tag, and its `outcome` when it has one. */
function label(schema: unknown): string {
  if (isJson(schema) && Array.isArray(schema["enum"])) return JSON.stringify(schema["enum"]);
  if (!isJson(schema) || !isJson(schema["properties"])) return "a member";
  const tag = (field: string) => {
    const value = (schema["properties"] as Json)[field];
    return isJson(value) && Array.isArray(value["enum"]) ? String(value["enum"][0]) : null;
  };
  return [tag("type"), tag("outcome")].filter((item) => item !== null).join(" ") || "a member";
}

/** K-724: what changed from `before` to `after`, as the reasons of a major and of a minor bump. */
export function wireChange(before: unknown, after: unknown, path = "wire"): WireChange {
  const change: WireChange = { major: [], minor: [] };
  compare(before, after, path, change);
  return change;
}

/** Effect writes a union of one member as `anyOf` of one, such as `Literals(["on"])`. */
const single = (schema: unknown) =>
  isJson(schema) &&
  Array.isArray(schema["anyOf"]) &&
  schema["anyOf"].length === 1 &&
  Object.keys(schema).length === 1
    ? (schema["anyOf"][0] as unknown)
    : schema;

function compare(beforeSchema: unknown, afterSchema: unknown, path: string, change: WireChange) {
  const before = single(beforeSchema);
  const after = single(afterSchema);
  if (same(before, after)) return;
  if (!isJson(before) || !isJson(after)) {
    change.major.push(`${path} changed`);
    return;
  }
  if (Array.isArray(before["anyOf"]) || Array.isArray(after["anyOf"])) {
    compareUnion(before, after, path, change);
    return;
  }
  let fieldsCompared = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key];
    const now = after[key];
    if (same(old, now)) continue;
    // An optional field that turns required changes only `required`, so either key compares the fields, once.
    if (key === "properties" || key === "required") {
      if (fieldsCompared) continue;
      fieldsCompared = true;
      compareFields(before, after, path, change);
    } else if (key === "enum" && Array.isArray(old) && Array.isArray(now))
      if (old.every((value) => now.some((item) => same(item, value))))
        change.minor.push(
          `${path}: new values ${JSON.stringify(now.filter((item) => !old.some((value) => same(value, item))))}`,
        );
      else change.major.push(`${path}: values removed`);
    else if (UPPER.includes(key))
      if (now === undefined || (typeof old === "number" && typeof now === "number" && now > old))
        change.minor.push(`${path}: ${key} wider`);
      else change.major.push(`${path}: ${key} narrower`);
    else if (LOWER.includes(key))
      if (now === undefined || (typeof old === "number" && typeof now === "number" && now < old))
        change.minor.push(`${path}: ${key} wider`);
      else change.major.push(`${path}: ${key} narrower`);
    else if ((key === "items" || key === "additionalProperties") && isJson(old) && isJson(now))
      compare(old, now, `${path}[]`, change);
    else change.major.push(`${path}: ${key} changed`);
  }
}

function compareFields(before: Json, after: Json, path: string, change: WireChange) {
  const old = isJson(before["properties"]) ? before["properties"] : {};
  const now = isJson(after["properties"]) ? after["properties"] : {};
  const wasRequired = new Set(Array.isArray(before["required"]) ? before["required"] : []);
  const isRequired = new Set(Array.isArray(after["required"]) ? after["required"] : []);
  for (const field of Object.keys(old)) {
    if (!(field in now)) change.major.push(`${path}.${field} removed`);
    else {
      // A reader of either side counts on a required field, and an older sender omits a newly required one.
      if (wasRequired.has(field) !== isRequired.has(field))
        change.major.push(`${path}.${field} ${isRequired.has(field) ? "now required" : "now optional"}`);
      compare(old[field], now[field], `${path}.${field}`, change);
    }
  }
  for (const field of Object.keys(now))
    if (!(field in old))
      if (isRequired.has(field)) change.major.push(`${path}.${field}: new required field`);
      else change.minor.push(`${path}.${field}: new optional field`);
}

/** Each old member needs a new member that only widens it; a new member with no old one is an addition. */
function compareUnion(before: Json, after: Json, path: string, change: WireChange) {
  const old = Array.isArray(before["anyOf"]) ? before["anyOf"] : [before];
  const now = Array.isArray(after["anyOf"]) ? after["anyOf"] : [after];
  const matched = new Set<number>();
  for (const member of old) {
    const name = label(member);
    const compared = now.map((candidate, index) => ({
      index,
      label: label(candidate),
      change: wireChange(member, candidate, `${path} ${name}`),
    }));
    const best = compared
      .filter((option) => option.change.major.length === 0)
      .toSorted((a, b) => a.change.minor.length - b.change.minor.length)[0];
    if (best === undefined) {
      // A member of the same tag that changed names its fields; a member with no tag left is gone.
      const namesake = name === "a member" ? undefined : compared.find((option) => option.label === name);
      change.major.push(...(namesake?.change.major ?? [`${path}: ${name} removed`]));
    } else {
      matched.add(best.index);
      change.minor.push(...best.change.minor);
    }
  }
  now.forEach((member, index) => {
    if (!matched.has(index)) change.minor.push(`${path}: new ${label(member)}`);
  });
}

/** K-724: the bump from `from` to `to`, or null when `to` is not newer. */
export function bumpOf(from: string, to: string): "major" | "minor" | "patch" | null {
  const a = parseProtocol(from);
  const b = parseProtocol(to);
  if (a === null || b === null) return null;
  if (b.major !== a.major) return b.major > a.major ? "major" : null;
  if (b.minor !== a.minor) return b.minor > a.minor ? "minor" : null;
  return b.patch > a.patch ? "patch" : null;
}

/** K-724: the bump that a change needs. */
export const neededBump = (change: WireChange): "major" | "minor" | "patch" =>
  change.major.length > 0 ? "major" : change.minor.length > 0 ? "minor" : "patch";

const RANK = { patch: 0, minor: 1, major: 2 } as const;

/**
 * K-724: why the version `to` does not fit the change from the lock of `from`, or null when it does. The same version
 * fits only no change.
 */
export function bumpProblem(from: string, to: string, change: WireChange): string | null {
  const needed = neededBump(change);
  const reasons = [...change.major, ...change.minor].slice(0, 12).join("; ");
  if (from === to)
    return needed === "patch" && reasons === ""
      ? null
      : `the wire changed (${reasons}), so KITSHN_PROTOCOL needs a ${needed} bump from ${from}`;
  const bump = bumpOf(from, to);
  if (bump === null) return `KITSHN_PROTOCOL ${to} is not newer than the lock's ${from}`;
  if (RANK[bump] < RANK[needed])
    return `the wire changed (${reasons}), so ${from} to ${to} is a ${bump} bump where a ${needed} bump is needed`;
  return null;
}
