import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "../src/core/changes.ts";
import type { Circle } from "../src/core/model.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker/index.ts";
import { accessToken, send, strangerKeys, stubAccessCerts } from "./access.ts";
import { key, withActors } from "./actors.ts";

const call = (path: string, token: string | null, body?: object) => {
  const headers = new Headers(token ? { "cf-access-jwt-assertion": token } : {});
  if (body) headers.set("content-type", "application/json");
  return send(path, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

afterEach(() => vi.restoreAllMocks());

describe("owner route /api/state", () => {
  it("answers the owner with the map", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("admin-aud", { email: "owner@example.com" }));
    expect(response.status).toBe(200);
    const state = (await response.json()) as { circles: ReadonlyArray<{ name: string }> };
    expect(state.circles.map((circle) => circle.name)).toContain("Owner");
  });

  it("refuses a person outside the Owner circle", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("admin-aud", { email: "guest@example.com" }));
    expect(response.status).toBe(403);
  });

  it("refuses a token of another Access application", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("agent-aud", { email: "owner@example.com" }));
    expect(response.status).toBe(401);
  });

  it("refuses a token signed by another key with the same key id", async () => {
    stubAccessCerts();
    const token = await accessToken(
      "admin-aud",
      { email: "owner@example.com" },
      { key: strangerKeys.privateKey },
    );
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    stubAccessCerts();
    // Older than the 60 seconds of clock tolerance.
    const expiresAt = Math.floor(Date.now() / 1000) - 120;
    const token = await accessToken("admin-aud", { email: "owner@example.com" }, { expiresAt });
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses a token of another issuer", async () => {
    stubAccessCerts();
    const token = await accessToken(
      "admin-aud",
      { email: "owner@example.com" },
      { issuer: "https://other.example.com" },
    );
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses a request without an Access token", async () => {
    expect((await call("/api/state", null)).status).toBe(401);
  });

  it("refuses a stack name with spaces around it, so no stack shows a blank name (K-521)", async () => {
    stubAccessCerts();
    const owner = await accessToken("admin-aud", { email: "owner@example.com" });
    const stack = (name: string): ReadonlyArray<Edit> => [
      { _tag: "stack", id: "s-blank", after: { id: "s-blank", name, members: [] } },
    ];
    expect((await call("/api/apply", owner, { edits: stack("   ") })).status).toBe(400);
    expect((await call("/api/apply", owner, { edits: stack(" Sites") })).status).toBe(400);
  });

  it("records where each Undo came from, and calls an Undo over HTTP without a source the API (K-1509)", async () => {
    stubAccessCerts();
    const owner = await accessToken("admin-aud", { email: "owner@example.com" });
    const undone = async (id: string, source?: string) => {
      const circle: Circle = {
        id,
        name: id,
        color: "#7c3aed",
        level: "view",
        members: [],
        match: "any",
        needsPasskey: false,
        endsAt: null,
        x: 4000,
        y: 4000,
        r: 100,
      };
      const applied = (await (
        await call("/api/apply", owner, { edits: [{ _tag: "circle", id, after: circle }] })
      ).json()) as {
        revision: number;
      };
      const undo = await call("/api/undo", owner, {
        revision: applied.revision,
        ...(source ? { source } : {}),
      });
      expect(undo.status).toBe(200);
      return ((await undo.json()) as { revision: number }).revision;
    };
    const fromHistory = await undone("undo-history", "history");
    const fromApi = await undone("undo-api");
    const state = (await (await call("/api/state", owner)).json()) as {
      revisions: ReadonlyArray<{ id: number; undoSource: string | null }>;
    };
    const sourceOf = (id: number) => state.revisions.find((revision) => revision.id === id)?.undoSource;
    expect([sourceOf(fromHistory), sourceOf(fromApi)]).toEqual(["history", "api"]);
    expect((await call("/api/undo", owner, { revision: fromApi, source: "keyboard" })).status).toBe(400);
  });
});

describe("agent route /agent/state (K-718)", () => {
  it("answers a service token that the owner put in an agent circle", async () => {
    stubAccessCerts();
    const owner = await accessToken("admin-aud", { email: "owner@example.com" });
    const agents: Circle = {
      id: "agents",
      name: "Agents",
      color: "#7c3aed",
      level: "control",
      members: [key("t1", "agent-1.access", "Agent")],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: 2000,
      y: 2000,
      r: 200,
    };
    const edits = withActors([{ _tag: "circle", id: agents.id, after: agents }]);
    expect((await call("/api/apply", owner, { edits })).status).toBe(200);
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { common_name: "agent-1.access" }),
    );
    expect(response.status).toBe(200);
    const state = (await response.json()) as { circles: ReadonlyArray<{ id: string }> };
    expect(state.circles.map((circle) => circle.id)).toEqual(["agents"]);
  });

  it("refuses a person's token", async () => {
    stubAccessCerts();
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { email: "owner@example.com" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a service token in no agent circle", async () => {
    stubAccessCerts();
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { common_name: "stranger.access" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("no agent circle") });
  });
});

describe("public join paths (K-617, K-625)", () => {
  it("serves the Windows join script from its asset, with no login", async () => {
    const asked: Array<string> = [];
    const assets = {
      fetch: async (request: Request) => {
        asked.push(new URL(request.url).pathname);
        return new Response("param([string]$Code, [string]$Server)", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://kit.example.com/join/windows.ps1"),
      { ...env, ASSETS: assets as unknown as Fetcher },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(asked).toEqual(["/join.ps1"]);
    expect(await response.text()).toContain("param(");
  });
});
