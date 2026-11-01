/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { MACHINE_RIGHTS } from "./model.ts";
import { OPERATIONS, OP_IDS, type Operation, decide, isPersonGate, opRequest } from "./operations.ts";

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
  "/api/state": "the snapshot that kitshn state reads",
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
  it("lets an agent reach every owner action: each call runs, waits for a person, or refuses as for the owner", () => {
    const refusals: Array<string> = [];
    for (const [id, op] of rows)
      for (const scope of [true, false])
        for (const inAgentCircle of [true, false]) {
          const decision = decide(
            op,
            { admin: false, paused: false, mode: null, inAgentCircle, scope, approved: false },
            OWNER,
          );
          if (decision.outcome === "refuse") refusals.push(id);
        }
    // Only a person gate refuses a machine whose rights are unset; a review sees each in this list.
    expect([...new Set(refusals)]).toEqual(rows.filter(([, op]) => isPersonGate(op.gate)).map(([id]) => id));
    expect(rows.filter(([, op]) => isPersonGate(op.gate)).map(([id]) => id)).toEqual([
      "resume",
      "restore-time",
      "notifications",
      "push",
    ]);
  });

  it("asks the Owner for a failed scope, whatever the mode, and runs an approved call", () => {
    const shell = OPERATIONS["machine-shell"];
    const base = { admin: false, paused: false, inAgentCircle: true, approved: false } as const;
    expect(decide(shell, { ...base, mode: { mode: "automatic" }, scope: false }, OWNER)).toEqual({
      outcome: "ask",
      circleId: OWNER,
    });
    expect(decide(shell, { ...base, mode: { mode: "automatic" }, scope: true }, OWNER)).toEqual({
      outcome: "run",
    });
    expect(decide(shell, { ...base, mode: { mode: "ask", circleId: "c" }, scope: true }, OWNER)).toEqual({
      outcome: "ask",
      circleId: "c",
    });
    expect(decide(shell, { ...base, mode: { mode: "off" }, scope: true }, OWNER).outcome).toBe("refuse");
    expect(decide(shell, { ...base, mode: null, scope: false, approved: true }, OWNER)).toEqual({
      outcome: "run",
    });
    expect(
      decide(shell, { ...base, mode: null, scope: true, paused: true, approved: true }, OWNER).outcome,
    ).toBe("refuse");
  });

  it("runs machine care at once for a machine in an agent circle, and asks for one in the tray (Y2)", () => {
    const update = OPERATIONS["machine-update"];
    const base = { admin: false, paused: false, mode: null, scope: true, approved: false } as const;
    expect(decide(update, { ...base, inAgentCircle: true }, OWNER)).toEqual({ outcome: "run" });
    expect(decide(update, { ...base, inAgentCircle: false }, OWNER)).toEqual({
      outcome: "ask",
      circleId: OWNER,
    });
    expect(decide(OPERATIONS["machine-shell"], { ...base, inAgentCircle: true }, OWNER)).toEqual({
      outcome: "ask",
      circleId: OWNER,
    });
  });

  it("keeps the fixed command of a row, so a caller cannot turn one operation into another", () => {
    expect(
      opRequest(OPERATIONS["machine-update"], "m1", { command: { kind: "shell", script: "id" } }),
    ).toEqual({
      method: "POST",
      path: "/api/jobs",
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
      body: { machineId: "m1", command: { kind: "shell", script: "id" } },
    });
    expect(
      opRequest(OPERATIONS["machine-labels"], "a/b", { labels: ["gpu"], allow: ["privileged"] }),
    ).toEqual({
      method: "POST",
      path: "/api/machines/a%2Fb",
      body: { labels: ["gpu"] },
    });
    expect(opRequest(OPERATIONS["provider-forget"], "m1", {})).toBe(
      'This operation needs the body field "provider".',
    );
  });

  it("names every right of MACHINE_RIGHTS that a row uses", () => {
    for (const [, op] of rows)
      if (!isPersonGate(op.gate) && op.gate.right !== null) expect(MACHINE_RIGHTS).toContain(op.gate.right);
  });

  it("has a row for every owner route of the Durable Object", () => {
    const start = kitshn.indexOf("private async ownerRoute(");
    const end = kitshn.indexOf("override async webSocketMessage", start);
    const messages = kitshn.slice(
      kitshn.indexOf("const API_MESSAGES"),
      kitshn.indexOf("};", kitshn.indexOf("const API_MESSAGES")),
    );
    expect(start).toBeGreaterThan(0);
    const missing: Array<string> = [];
    for (const { value, line } of [
      ...literals(kitshn.slice(start, end), "/api/"),
      ...literals(messages, "/api/"),
    ]) {
      if (Object.hasOwn(READS, value)) continue;
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
