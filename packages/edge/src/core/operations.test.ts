/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import {
  EFFECTS,
  EFFECT_DEFAULTS,
  type Effect,
  OPERATIONS,
  OP_IDS,
  type OpId,
  type Operation,
  decide,
  isPersonGate,
  opRequest,
} from "./operations.ts";

const OWNER = "owner";
const rows = OP_IDS.map((id) => [id, OPERATIONS[id] as Operation] as const);

// K-1777: the guard. A route of the owner, or a call of the map, with no operation fails here.
const kitshn = import.meta.glob<string>("../worker/kitshn.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["../worker/kitshn.ts"] as string;
const ui = import.meta.glob<string>(["../ui/**/*.{ts,tsx}", "!../ui/**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The reads that `kitshn state` carries, so they need no operation. */
const READS: Readonly<Record<string, string>> = {
  "/api/ws": "the map socket sends the snapshot that kitshn state reads",
  "/api/icons/": "card icons, which kitshn state leaves out",
};
/** Map calls of the Worker's passkey path: the person rows resume and restore-time. */
const UI_PERSON_PATHS = ["/api/fresh"];

/** The text of each literal in `text` that starts with `start`, up to its closing quote; `${...}` becomes `:x`. */
function literals(text: string, start: string): Array<{ readonly value: string; readonly line: string }> {
  const found: Array<{ value: string; line: string }> = [];
  for (const quote of ['"', "`"]) {
    let at = text.indexOf(quote + start);
    while (at >= 0) {
      let end = at + 1;
      let value = "";
      while (end < text.length && text[end] !== quote) {
        if (quote === "`" && text.startsWith("${", end)) {
          value += ":x";
          end = text.indexOf("}", end) + 1;
          continue;
        }
        value += text[end];
        end++;
      }
      const lineStart = text.lastIndexOf("\n", at) + 1;
      const lineEnd = text.indexOf("\n", at);
      found.push({ value: value.split("?")[0] ?? value, line: text.slice(lineStart, lineEnd) });
      at = text.indexOf(quote + start, end + 1);
    }
  }
  return found;
}

/** Each quoted argument of `call(` in a line, for example the suffixes of `path.endsWith("/settings")`. */
function args(line: string, call: string): Array<string> {
  const found: Array<string> = [];
  let at = line.indexOf(`${call}("`);
  while (at >= 0) {
    const start = at + call.length + 2;
    found.push(line.slice(start, line.indexOf('"', start)));
    at = line.indexOf(`${call}("`, start);
  }
  return found;
}

const segments = (path: string) => path.split("/").filter((part) => part !== "");
/** True when `path` names `route`, or a part of it up to a placeholder; `:` matches any one segment. */
function names(path: string, route: string): boolean {
  const a = segments(path);
  const b = segments(route);
  if (a.length > b.length) return false;
  return a.every((part, index) => part === b[index] || part.startsWith(":") || b[index]?.startsWith(":"));
}

describe("operations (K-1777)", () => {
  const unset = { admin: false, paused: false, mode: null, shares: null, approved: false } as const;

  it("lets an agent reach every owner action: each call runs, waits for a person, or refuses as for the owner", () => {
    const refusals: Array<string> = [];
    for (const [id, op] of rows)
      for (const scope of [true, false])
        for (const inAgentCircle of [true, false]) {
          const decision = decide(op, { ...unset, inAgentCircle, scope }, OWNER);
          if (decision.outcome === "refuse") refusals.push(id);
        }
    // With every effect unset, only a person gate and a secret (default off) refuse; a review sees each in this list.
    expect([...new Set(refusals)]).toEqual(
      rows.filter(([, op]) => isPersonGate(op.gate) || op.effect === "secrets").map(([id]) => id),
    );
    expect(rows.filter(([, op]) => isPersonGate(op.gate)).map(([id]) => id)).toEqual([
      "resume",
      "restore-time",
      "notifications",
      "push",
    ]);
  });

  it("gives each row exactly one effect of EFFECTS (K-1730)", () => {
    expect(rows.filter(([, op]) => !EFFECTS.includes(op.effect)).map(([id]) => id)).toEqual([]);
  });

  it("starts each effect at its default: reads, maintains and creates run in an agent circle (K-1730)", () => {
    expect(EFFECT_DEFAULTS).toEqual({
      reads: "automatic",
      maintains: "automatic",
      creates: "automatic",
      changes: "ask the Owner",
      runs: "ask the Owner",
      destroys: "ask the Owner",
      shares: "ask the Owner",
      secrets: "off",
    });
    const byEffect = (effect: Effect) =>
      rows.find(([, op]) => op.effect === effect && !isPersonGate(op.gate));
    const outcome = (effect: Effect, inAgentCircle: boolean) => {
      const row = byEffect(effect);
      if (!row) throw new Error(`No row has the effect ${effect}.`);
      return decide(row[1], { ...unset, scope: true, inAgentCircle }, OWNER).outcome;
    };
    expect(EFFECTS.map((effect) => [effect, outcome(effect, true), outcome(effect, false)])).toEqual([
      ["reads", "run", "ask"],
      ["maintains", "run", "ask"],
      ["creates", "run", "ask"],
      ["changes", "ask", "ask"],
      ["runs", "ask", "ask"],
      ["destroys", "ask", "ask"],
      ["shares", "ask", "ask"],
      ["secrets", "refuse", "refuse"],
    ]);
  });

  it("decides a target out of scope by the caller's shares, whatever the mode, and runs an approved call", () => {
    const shell = OPERATIONS["machine-shell"];
    const base = { ...unset, inAgentCircle: true } as const;
    expect(decide(shell, { ...base, mode: { mode: "automatic" }, scope: false }, OWNER)).toEqual({
      outcome: "ask",
      circleId: OWNER,
    });
    expect(
      decide(
        shell,
        { ...base, mode: { mode: "automatic" }, shares: { mode: "automatic" }, scope: false },
        OWNER,
      ),
    ).toEqual({ outcome: "run" });
    expect(
      decide(shell, { ...base, shares: { mode: "ask", circleId: "admins" }, scope: false }, OWNER),
    ).toEqual({ outcome: "ask", circleId: "admins" });
    expect(decide(shell, { ...base, shares: { mode: "off" }, scope: false }, OWNER).outcome).toBe("refuse");
    expect(decide(shell, { ...base, mode: { mode: "automatic" }, scope: true }, OWNER)).toEqual({
      outcome: "run",
    });
    expect(decide(shell, { ...base, mode: { mode: "ask", circleId: "c" }, scope: true }, OWNER)).toEqual({
      outcome: "ask",
      circleId: "c",
    });
    expect(decide(shell, { ...base, mode: { mode: "off" }, scope: true }, OWNER).outcome).toBe("refuse");
    // An approval from before the owner set the effect "off" no longer runs.
    expect(
      decide(shell, { ...base, mode: { mode: "off" }, scope: false, approved: true }, OWNER).outcome,
    ).toBe("refuse");
    expect(decide(shell, { ...base, scope: false, approved: true }, OWNER)).toEqual({ outcome: "run" });
    // A target out of scope with "shares" off refuses, also with an approval of this call.
    expect(
      decide(shell, { ...base, shares: { mode: "off" }, scope: false, approved: true }, OWNER).outcome,
    ).toBe("refuse");
    // The default "off" of "secrets" holds out of scope too: "shares" alone never hands out a secret.
    const shares = { mode: "automatic" } as const;
    expect(decide(OPERATIONS["machine-add"], { ...base, shares, scope: false }, OWNER).outcome).toBe(
      "refuse",
    );
    expect(
      decide(OPERATIONS["machine-add"], { ...base, shares, mode: shares, scope: false }, OWNER).outcome,
    ).toBe("run");
    expect(decide(shell, { ...base, scope: true, paused: true, approved: true }, OWNER).outcome).toBe(
      "refuse",
    );
    // A person gate stays a person gate, also with every effect automatic.
    for (const id of ["resume", "restore-time", "notifications", "push"] as const)
      expect(
        decide(
          OPERATIONS[id],
          { ...base, scope: true, mode: { mode: "automatic" }, shares: { mode: "automatic" } },
          OWNER,
        ).outcome,
      ).toBe("refuse");
  });

  it("gives secrets to every row that answers with a secret, and shares to every row that raises access (K-715)", () => {
    // `apply` raises access only by edits that fail its rule scope, which "shares" then decides.
    const raisesAccess: ReadonlyArray<OpId> = [
      "undo", // an Undo can bring back a share or a member
      "undo-item",
      "machine-labels", // the label deploy is the owner's consent (K-610)
      "site-live-add", // it may name any circle
      "repo-group-add", // a repo group gives its effects to every repo that it matches (K-1733)
      "repo-group-edit",
      "github-way",
      "passes-set",
      "audience-add",
      "audience-labels",
    ];
    expect(rows.filter(([, op]) => op.secret === true && op.effect !== "secrets").map(([id]) => id)).toEqual(
      [],
    );
    expect(
      rows.filter(([id, op]) => raisesAccess.includes(id) && op.effect !== "shares").map(([id]) => id),
    ).toEqual([]);
  });

  it("keeps the fixed command of a row, so a caller cannot turn one operation into another", () => {
    expect(
      opRequest(OPERATIONS["machine-update"], "m1", { command: { kind: "shell", script: "id" } }),
    ).toEqual({
      method: "POST",
      path: "/api/jobs",
      search: "",
      body: { machineId: "m1", command: { kind: "update" } },
    });
    expect(
      opRequest(OPERATIONS["machine-shell"], "m1", {
        command: { kind: "update", script: "id" },
        machineId: "m2",
      }),
    ).toEqual({
      method: "POST",
      path: "/api/jobs",
      search: "",
      body: { machineId: "m1", command: { kind: "shell", script: "id" } },
    });
    expect(
      opRequest(OPERATIONS["machine-labels"], "a/b", { labels: ["gpu"], allow: ["privileged"] }),
    ).toEqual({
      method: "POST",
      path: "/api/machines/a%2Fb",
      search: "",
      body: { labels: ["gpu"] },
    });
    // A GET sends no body, so the text fields of its body go in the query (K-1756).
    expect(opRequest(OPERATIONS["ask-events"], "", { label: "t3.thread.id=a b", other: "x" })).toEqual({
      method: "GET",
      path: "/api/ask-events",
      search: "?label=t3.thread.id%3Da+b",
      body: null,
    });
    expect(opRequest(OPERATIONS["provider-forget"], "m1", {})).toBe(
      'This operation needs the body field "provider".',
    );
  });

  it("has a row for every owner route of the Durable Object", () => {
    const start = kitshn.indexOf("private async ownerRoute(");
    const end = kitshn.indexOf("override async webSocketMessage", start);
    const messages = kitshn.slice(
      kitshn.indexOf("const API_MESSAGES"),
      kitshn.indexOf("};", kitshn.indexOf("const API_MESSAGES")),
    );
    expect(start).toBeGreaterThan(0);
    // The handlers that `ownerRoute` gives a whole path to read the rest of it, so a new route there needs a row too.
    const handlers = ["inviteRequest", "notificationRequest", "pushRequest", "ownerSite"].map((name) => {
      const at = kitshn.indexOf(`private async ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      return kitshn.slice(at, kitshn.indexOf("\n  }\n", at));
    });
    const missing: Array<string> = [];
    for (const { value, line } of [
      ...literals(kitshn.slice(start, end), "/api/"),
      ...literals(messages, "/api/"),
      ...handlers.flatMap((text) => literals(text, "/api/")),
    ]) {
      if (Object.hasOwn(READS, value)) continue;
      // A person row covers its whole path: the Inbox and the push key of one browser.
      if (rows.some(([, op]) => isPersonGate(op.gate) && value.startsWith(op.route))) continue;
      const suffixes = [...args(line, "endsWith"), ...args(line, "includes")];
      const methods = line
        .split('request.method === "')
        .slice(1)
        .map((part) => part.slice(0, part.indexOf('"')));
      // The Undo checks before the menu offers Undo are reads of History.
      if (methods.join() === "GET" && (value === "/api/undo" || value === "/api/undo-item")) continue;
      const covered = rows.some(
        ([, op]) =>
          op.route.startsWith(value.endsWith("/") ? value.slice(0, -1) : value) &&
          suffixes.every((suffix) => op.route.includes(suffix)) &&
          (methods.length === 0 || methods.includes(op.method)),
      );
      if (!covered) missing.push(`${methods.join("|") || "any"} ${value} ${suffixes.join(" ")}`.trim());
    }
    expect(missing).toEqual([]);
  });

  it("has a row for every call of the map", () => {
    const missing: Array<string> = [];
    for (const [file, text] of Object.entries(ui))
      for (const { value } of literals(text, "/api/")) {
        if (Object.hasOwn(READS, value) || UI_PERSON_PATHS.some((path) => value.startsWith(path))) continue;
        // A person row covers its whole path: the Inbox and the push key of one browser.
        const person = rows.some(([, op]) => isPersonGate(op.gate) && value.startsWith(op.route));
        if (!person && !rows.some(([, op]) => names(value, op.route))) missing.push(`${file}: ${value}`);
      }
    expect(missing).toEqual([]);
  });
});
