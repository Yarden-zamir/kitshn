import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { KITSHN_PROTOCOL, PROVIDER_PROTOCOL, matchProtocol, parseProtocol } from "./index.ts";
import { bumpProblem, wireChange, wireSchema } from "./wire.ts";
import lockFile from "../protocol.lock.json" with { type: "json" };

const side = (name: string, version: string) => ({ name, version, update: `update ${name}` });

describe("kitshn protocol (K-724)", () => {
  it("keeps the wire schema and KITSHN_PROTOCOL in step with protocol.lock.json", () => {
    const lock: { readonly version: string; readonly wire: unknown } = lockFile;
    const fix = "Set KITSHN_PROTOCOL, then run pnpm --filter @kitshn/local run protocol-lock.";
    const problem = bumpProblem(lock.version, KITSHN_PROTOCOL, wireChange(lock.wire, wireSchema()));
    expect(problem === null ? null : `${problem}. ${fix}`).toBeNull();
    expect(lock.version, `the lock records ${lock.version}. ${fix}`).toBe(KITSHN_PROTOCOL);
    expect(JSON.stringify(lock.wire) === JSON.stringify(wireSchema()), fix).toBe(true);
    expect(parseProtocol(KITSHN_PROTOCOL)?.major).toBe(PROVIDER_PROTOCOL);
  });

  it("is silent within a minor, tolerates another minor, and refuses another major or no version", () => {
    expect(matchProtocol(side("the daemon", "2.1.0"), side("t3", "2.1.7"))).toEqual({ outcome: "same" });
    const minor = matchProtocol(side("the daemon", "2.3.0"), side("t3", "2.1.0"));
    expect(minor).toMatchObject({ outcome: "tolerate" });
    expect(minor.outcome === "tolerate" && minor.warning).toContain(
      "the daemon speaks kitshn protocol 2.3.0 and t3 speaks 2.1.0: t3 ignores what it does not know. Update t3: update t3",
    );
    const major = matchProtocol(side("kitshn", "3.0.0"), side("the daemon", "2.4.1"));
    expect(major.outcome === "refuse" && major.reason).toContain(
      "kitshn speaks kitshn protocol 3.0.0 and the daemon speaks 2.4.1: the major versions differ, so kitshn refuses the daemon. Update the daemon",
    );
    for (const bad of ["2", "2.1", "02.1.0", "2.1.0-beta", "", "x.y.z"])
      expect(matchProtocol(side("the daemon", "2.1.0"), side("t3", bad)).outcome).toBe("refuse");
  });

  it("asks a major bump for a removed or narrowed part, and a minor bump for an addition", () => {
    const Old = Schema.Union([
      Schema.Struct({
        type: Schema.Literal("status"),
        state: Schema.Literals(["on", "off"]),
        name: Schema.String.check(Schema.isMaxLength(10)),
        note: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({ type: Schema.Literal("ping") }),
    ]);
    const change = (next: Schema.Top) =>
      wireChange(Schema.toJsonSchemaDocument(Old).schema, Schema.toJsonSchemaDocument(next).schema);
    const member = (fields: Record<string, Schema.Top>) =>
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("status"),
          state: Schema.Literals(["on", "off"]),
          name: Schema.String.check(Schema.isMaxLength(10)),
          note: Schema.optionalKey(Schema.String),
          ...fields,
        }),
        Schema.Struct({ type: Schema.Literal("ping") }),
      ]);
    const widened = Schema.Union([
      Schema.Struct({
        type: Schema.Literal("status"),
        state: Schema.Literals(["on", "off", "busy"]),
        name: Schema.String.check(Schema.isMaxLength(20)),
        note: Schema.optionalKey(Schema.String),
        since: Schema.optionalKey(Schema.Number),
      }),
      Schema.Struct({ type: Schema.Literal("ping") }),
      Schema.Struct({ type: Schema.Literal("pong") }),
    ]);
    expect(change(widened).major).toEqual([]);
    expect(change(widened).minor).toHaveLength(4);
    expect(change(Schema.Struct({ type: Schema.Literal("ping") })).major).toEqual(["wire: status removed"]);
    expect(change(member({ at: Schema.Number })).major).toEqual(["wire status.at: new required field"]);
    // Only `required` changes here, also inside a union member.
    expect(change(member({ note: Schema.String })).major).toEqual(["wire status.note now required"]);
    expect(
      change(member({ name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(10))) })).major,
    ).toEqual(["wire status.name now optional"]);
    const narrowed = Schema.Union([
      Schema.Struct({
        type: Schema.Literal("status"),
        state: Schema.Literals(["on"]),
        name: Schema.String.check(Schema.isMaxLength(10)),
      }),
      Schema.Struct({ type: Schema.Literal("ping") }),
    ]);
    expect(change(narrowed).major).toEqual(["wire status.state: values removed", "wire status.note removed"]);
    expect(bumpProblem("2.1.0", "2.2.0", change(narrowed))).toContain("a major bump is needed");
    expect(bumpProblem("2.1.0", "3.0.0", change(narrowed))).toBeNull();
    expect(bumpProblem("2.1.0", "2.1.0", change(widened))).toContain("needs a minor bump from 2.1.0");
    expect(bumpProblem("2.1.0", "2.1.1", change(Old))).toBeNull();
  });
});
