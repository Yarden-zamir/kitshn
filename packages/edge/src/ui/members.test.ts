import { describe, expect, it } from "vitest";
import { type Circle, actorIdOf } from "../core/model.ts";
import { memberFrom, tokenOpensNothing } from "./members.ts";

const NO_ONE = { actors: new Map(), machines: new Map() };
const rule = (text: string, kind: Parameters<typeof memberFrom>[0] = "auto") => {
  const typed = memberFrom(kind, text, NO_ONE);
  return typeof typed === "string" ? typed : typed.member;
};

describe("the Add member input", () => {
  it("tells a person, a domain and a network apart from the text", () => {
    // K-1778: an email makes its person actor once; an existing one is reused.
    const login = { _tag: "login", email: "her@example.com" } as const;
    const her = { id: actorIdOf(login), name: "her@example.com", credentials: [login] };
    expect(memberFrom("auto", " Her@Example.com ", NO_ONE)).toEqual({
      member: { _tag: "actor", actorId: her.id },
      actor: her,
    });
    const known = { ...her, id: "a-known", name: "Her" };
    expect(
      memberFrom("auto", "her@example.com", { ...NO_ONE, actors: new Map([[known.id, known]]) }),
    ).toEqual({
      member: { _tag: "actor", actorId: "a-known" },
      actor: null,
    });
    expect(rule("@qlik.com", "auto")).toEqual({ _tag: "domain", domain: "qlik.com" });
    expect(rule("qlik.com", "auto")).toEqual({ _tag: "domain", domain: "qlik.com" });
    expect(rule("10.0.0.0/8", "auto")).toEqual({ _tag: "ip", range: "10.0.0.0/8" });
    expect(rule("203.0.113.9", "auto")).toEqual({ _tag: "ip", range: "203.0.113.9/32" });
    expect(rule("2001:db8::/32", "auto")).toEqual({ _tag: "ip", range: "2001:db8::/32" });
  });

  it("refuses what it cannot read, also when the kind is picked", () => {
    expect(rule("her", "auto")).toBeTypeOf("string");
    expect(rule("qlik.com", "email")).toBeTypeOf("string");
    expect(rule("10.0.0.0/40", "ip")).toBeTypeOf("string");
    expect(rule("", "auto")).toBeTypeOf("string");
    // A broken address is a broken network, not a domain.
    for (const text of ["999.1.1.1", "10.0.0.0/33", "1.2.3", "10.0.0.0/", "1.2.3.4/8/9", "10.0.0.0/8.0"])
      expect(rule(text)).toBe("A network looks like 10.0.0.0/8 or 203.0.113.9.");
  });

  it("adds everyone without text", () => {
    expect(rule("", "everyone")).toEqual({ _tag: "everyone" });
  });
});

describe("the Add device warning", () => {
  const circle = (id: string, needsPasskey: boolean, actorIds: ReadonlyArray<string>): Circle => ({
    id,
    name: id,
    color: "#000000",
    level: "view",
    members: actorIds.map((actorId) => ({ _tag: "actor", actorId })),
    match: "any",
    needsPasskey,
    endsAt: null,
    x: 0,
    y: 0,
    r: 1,
  });
  const circles = (...list: ReadonlyArray<Circle>) => ({
    circles: new Map(list.map((each) => [each.id, each])),
  });

  it("warns only when the actor is in a circle and every circle of it needs a passkey (K-1778)", () => {
    expect(tokenOpensNothing(circles(circle("owner", true, ["a"])), "a")).toBe(true);
    expect(tokenOpensNothing(circles(circle("owner", true, ["a"]), circle("home", false, ["a"])), "a")).toBe(
      false,
    );
    expect(tokenOpensNothing(circles(circle("owner", true, ["b"])), "a")).toBe(false);
  });
});
