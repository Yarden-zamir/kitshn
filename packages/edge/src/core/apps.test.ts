import { describe, expect, it } from "vitest";
import type { LastDeploy } from "./agent.ts";
import { appRestart, appTeardown, composeUndo, orphanVolumes } from "./apps.ts";
import type { AppCard } from "./changes.ts";
import { seed } from "./seed.ts";

const compose: AppCard = {
  id: "app-riffle-1-prod",
  kind: "site.compose",
  name: "riffle",
  addresses: ["riffle.example.com"],
  group: "riffle",
  machine: "vps",
};
const last: LastDeploy = {
  app: "compose",
  repo: "o/riffle",
  branch: "main",
  resourceId: compose.id,
  environment: "prod",
  name: "riffle",
  composeFile: null,
};
const ready = { canRedeploy: true, takesDeploys: true, runsCard: true, allowed: [] };

describe("app removal (K-909)", () => {
  it("takes down the Worker of a site, and stops a Compose app with its data kept", () => {
    expect(appTeardown({ ...compose, kind: "site.static", machine: null }, "example.com", false)).toEqual({
      kind: "worker",
      addresses: ["riffle.example.com"],
      script: `kitshn-${compose.id}`,
    });
    // K-817: every address of the card loses its custom domain; the Compose down keeps the main name.
    const several = { ...compose, addresses: ["riffle.example.com", "riffle.org"] };
    expect(
      appTeardown({ ...several, kind: "site.static", machine: null }, "example.com", false),
    ).toMatchObject({
      addresses: ["riffle.example.com", "riffle.org"],
    });
    expect(appTeardown(several, "example.com", false)).toMatchObject({ command: { name: "riffle" } });
    expect(appTeardown(compose, "example.com", false)).toEqual({
      kind: "compose",
      machineId: "vps",
      command: { kind: "compose-down", project: compose.id, name: "riffle", removeData: false },
    });
  });

  it("takes only the addresses of a Worker app off, so its Durable Objects and KV keep their data", () => {
    // K-1123, K-1127: a folder site keeps its script too, until a repo takes its card.
    expect(
      appTeardown({ ...compose, kind: "site.static", machine: null }, "example.com", true),
    ).toMatchObject({
      kind: "domains",
    });
    expect(appTeardown({ ...compose, kind: "site.worker", machine: null }, "example.com", false)).toEqual({
      kind: "domains",
      addresses: ["riffle.example.com"],
      script: `kitshn-${compose.id}`,
    });
  });

  it("starts a Compose app from its last good build and builds a site again on its branch", () => {
    expect(appRestart(last, null, false, ready)).toMatchObject({
      kind: "redeploy",
      command: { kind: "compose-redeploy", project: compose.id, name: "riffle" },
    });
    expect(appRestart({ ...last, environment: "pr-3" }, null, false, ready)).toMatchObject({
      kind: "redeploy",
    });
    expect(appRestart({ ...last, app: "static" }, null, false, null)).toEqual({
      kind: "build",
      repo: "o/riffle",
      branch: "main",
    });
  });

  it("says why it starts nothing", () => {
    expect(appRestart({ ...last, app: "static", environment: "pr-3" }, null, false, null)).toEqual({
      kind: "none",
      reason: "The preview pr-3 comes back on the next push to its pull request.",
    });
    expect(appRestart(last, "kitshn is paused.", false, ready)).toEqual({
      kind: "none",
      reason: "kitshn is paused.",
    });
    expect(appRestart(last, null, false, { ...ready, takesDeploys: false })).toMatchObject({
      kind: "none",
      reason: /label deploy/,
    });
    expect(appRestart(null, null, false, null)).toMatchObject({ kind: "none", reason: /next deploy/ });
    expect(appRestart({ ...last, environment: "pr-3" }, null, true, ready)).toMatchObject({
      kind: "none",
      reason: /closed, so the preview does not come back/,
    });
  });

  it("refuses an undo only while the machine runs the compose-down", () => {
    expect(composeUndo({ state: "sent" })).toBe("refuse");
    for (const state of ["queued", "done", "failed", "expired"] as const)
      expect(composeUndo({ state })).toBe("start");
    expect(composeUndo(null)).toBe("start");
  });

  it("lists as orphaned only the idle volumes whose app has no card", () => {
    const s = seed(["owner@example.com"], "kit.example.com");
    const state = {
      circles: new Map(),
      resources: new Map([...s.resources, { ...compose, status: "stopped" as const }].map((r) => [r.id, r])),
      places: new Map(),
      shareSettings: new Map(),
      ends: new Map(),
      stacks: new Map(),
      paused: null,
      machines: new Map(),
      actors: new Map(),
    };
    const kept = { name: `${compose.id}_data`, project: compose.id };
    const orphan = { name: "app-old-2-prod_data", project: "app-old-2-prod" };
    expect(orphanVolumes([kept, orphan], state)).toEqual([orphan]);
  });
});
