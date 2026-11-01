import { describe, expect, it, vi } from "vitest";
import { desiredAccess } from "../core/access.ts";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import type { Circle, Resource, State } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import { CloudflareError } from "./cloudflare.ts";
import {
  type AccessRow,
  type Api,
  accessStates,
  CALLS_PER_RUN,
  fillAudiences,
  hasAccessWork,
  rowsWithoutAud,
  revokeSessions,
  readSignOutLeft,
  retryApps,
  signOutEverywhere,
  signOutSummary,
  signOutWarning,
  syncAccess,
  syncLauncher,
  RETRY_AFTER_MS,
  loginHeld,
  loginHeldAfter,
  loginWant,
  loginWarnings,
  syncLogins,
  syncWithLogins,
  verifyAccess,
} from "./access-sync.ts";

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  return {
    circles: new Map(s.circles.map((circle) => [circle.id, circle])),
    resources: new Map(s.resources.map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

function fakeCloudflare(existing: { policies?: Array<object>; apps?: Array<object> } = {}) {
  const calls: Array<string> = [];
  let next = 0;
  // What Cloudflare holds: each object that a POST or PUT wrote, which a GET of that one object and the lists read back.
  const objects = new Map<string, object>();
  const kinds = new Map<string, "policies" | "apps">();
  const listed = (kind: "policies" | "apps") =>
    [...objects.entries()].filter(([id]) => kinds.get(id) === kind).map(([, item]) => item);
  const api: Api = async <T>(method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path.replace("/accounts/a/access", "")}`);
    const last = path.split("/").pop() ?? "";
    if (method === "GET" && objects.has(last)) return objects.get(last) as T;
    if (method === "GET")
      return (
        path.includes("/policies")
          ? [...(existing.policies ?? []), ...listed("policies")]
          : [...(existing.apps ?? []), ...listed("apps")]
      ) as T;
    const id = method === "PUT" ? last : `id${++next}`;
    const result = path.includes("/apps") ? { id, aud: `aud-${id}` } : { id };
    if (method === "PUT" || (method === "POST" && !path.endsWith("/revoke_tokens"))) {
      objects.set(id, { ...(body as object), ...result });
      kinds.set(id, path.includes("/apps") ? "apps" : "policies");
    }
    return result as T;
  };
  const rows = new Map<string, AccessRow>();
  const store = {
    rows,
    put: (row: AccessRow) => rows.set(row.key, row),
    remove: (key: string) => rows.delete(key),
  };
  return { api, calls, store, rows };
}

describe("Access sync (K-406, K-408)", () => {
  it("creates the Owner policy, then the admin application, then does nothing more", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    expect(await syncAccess(desired, cf.store, cf.api, "a")).toBe(true);
    // The Owner policy, its two login copies (K-1004) and the passkey enrollment policy (K-113), then the
    // admin application.
    expect(cf.calls).toEqual([
      "GET /policies?per_page=1000",
      "POST /policies",
      "POST /policies",
      "POST /policies",
      "POST /policies",
      "GET /apps?per_page=1000",
      "POST /apps",
    ]);
    expect(hasAccessWork(desired, cf.rows)).toBe(false);
    expect(accessStates(desired, cf.rows)).toEqual({ "kitshn-admin": { state: "applied" } });

    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(cf.calls).toEqual([]);
  });

  it("adopts objects named kitshn and never others", async () => {
    const cf = fakeCloudflare({
      policies: [{ id: "p-old", name: "kitshn circle Owner" }],
      apps: [{ id: "app-t3", name: "T3 Code servers", domain: "kit.example.com" }],
    });
    await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a");
    expect(cf.calls).toContain("PUT /policies/p-old");
    expect(cf.calls).toContain("POST /apps");
    expect(cf.calls).not.toContain("PUT /apps/app-t3");
  });

  it("removes the application before the policies it uses", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const withoutAdmin: State = { ...state, resources: new Map() };
    cf.calls.length = 0;
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const ownerId = cf.rows.get("policy:owner:people")!.cfId;
    const loginId = cf.rows.get("policy:owner:login")!.cfId;
    const passkeyId = cf.rows.get("policy:owner:login-passkey")!.cfId;
    await syncAccess(desiredAccess(withoutAdmin, 0), cf.store, cf.api, "a");
    expect(cf.calls).toEqual([
      `DELETE /apps/${appId}`,
      `DELETE /policies/${ownerId}`,
      `DELETE /policies/${loginId}`,
      `DELETE /policies/${passkeyId}`,
    ]);
    // The Owner circle still needs a passkey, so its people keep the enrollment policy (K-113).
    expect([...cf.rows.keys()]).toEqual(["policy:enrollment"]);
  });

  it("keeps the audience tag of each application (K-603)", async () => {
    const cf = fakeCloudflare();
    await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a");
    const app = cf.rows.get("app:kitshn-admin:kit.example.com")!;
    expect(app.aud).toBe(`aud-${app.cfId}`);
    expect(cf.rows.get("policy:owner:people")!.aud).toBe("");
  });

  it("reads missing audience tags from one list of the applications, by id (K-603)", async () => {
    const cf = fakeCloudflare({
      apps: [
        { id: "app-1", name: "kitshn a", aud: "aud-1" },
        { id: "app-2", name: "kitshn b", aud: "aud-2" },
      ],
    });
    const row = (key: string, cfId: string, aud: string): AccessRow => ({
      key,
      cfId,
      aud,
      body: "{}",
      tried: "",
      error: null,
    });
    // Rows from before the audience tag column, as a deploy finds them.
    cf.store.put(row("app:x:x.example.com", "app-1", ""));
    cf.store.put(row("app:y:y.example.com", "app-gone", ""));
    cf.store.put(row("app:z:z.example.com", "app-2", "aud-2"));
    expect(await fillAudiences(cf.store, cf.api, "a")).toBe(1);
    expect(cf.calls).toEqual(["GET /apps?per_page=1000&page=1"]);
    expect(cf.rows.get("app:x:x.example.com")!.aud).toBe("aud-1");
    // The list does not have app-gone: someone deleted it, so the row forgets the id and the next sync
    // makes the application again, instead of holding up the tunnel of its machine.
    expect(cf.rows.get("app:y:y.example.com")).toMatchObject({ cfId: "", aud: "", body: "" });
    expect(rowsWithoutAud(cf.rows)).toEqual([]);

    cf.calls.length = 0;
    expect(await fillAudiences(cf.store, cf.api, "a")).toBe(0);
    expect(cf.calls).toEqual([]);
  });

  it("stops at the call budget and reports work left", async () => {
    const cf = fakeCloudflare();
    expect(await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a", 2)).toBe(false);
    expect(cf.calls).toHaveLength(2);
  });

  it("marks a card failed and does not retry the same body", async () => {
    const cf = fakeCloudflare();
    const refusal = "POST /accounts/a/access/apps failed (403): refused";
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/apps")) throw new CloudflareError(403, refusal);
      return cf.api(method, path, body);
    };
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, failing, "a");
    expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "failed", error: refusal });
    expect(hasAccessWork(desired, cf.rows)).toBe(false);
  });

  it("tries a write again 5 minutes after Cloudflare gave no clear answer, and shows it as retrying", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      let answered = false;
      const flaky: Api = async (method, path, body) => {
        if (!answered && method === "POST" && path.endsWith("/apps")) {
          answered = true;
          throw new CloudflareError(504, "POST /accounts/a/access/apps failed (504): error code: 504");
        }
        return cf.api(method, path, body);
      };
      const desired = desiredAccess(start(), 0);
      await syncAccess(desired, cf.store, flaky, "a");
      expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({
        state: "retrying",
        error: "POST /accounts/a/access/apps failed (504): error code: 504",
        at: 1_000_000 + RETRY_AFTER_MS,
      });
      expect(hasAccessWork(desired, cf.rows)).toBe(false);
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      expect(hasAccessWork(desired, cf.rows)).toBe(true);
      await syncAccess(desired, cf.store, flaky, "a");
      expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the wanted body again after an unclear answer that landed, and ends the sessions (K-408, K-409)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      const place = (x: number) =>
        applyChanges(
          state,
          resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x, y: 9000 } }]),
        );
      // A: the admin card in no circle, so its application has no policy.
      const narrow = desiredAccess(place(9000), 0);
      await syncAccess(narrow, cf.store, cf.api, "a");
      // B: the owner widens it into Owner; Cloudflare stores the write but answers 504.
      const wide = desiredAccess(state, 0);
      const writes: Array<{ path: string; policies: number }> = [];
      const landsThen504: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
        const answer = await cf.api<T>(method, path, body);
        if (method === "PUT" && path.includes("/apps/")) {
          writes.push({ path, policies: (body as { policies: Array<unknown> }).policies.length });
          if (writes.length === 1)
            throw new CloudflareError(504, `PUT ${path} failed (504): error code: 504`);
        }
        return answer;
      };
      await syncAccess(wide, cf.store, landsThen504, "a");
      expect(writes).toEqual([{ path: expect.any(String), policies: 1 }]);
      // The owner moves it back to A. Cloudflare may hold B, so kitshn writes A again and ends the sessions.
      cf.calls.length = 0;
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      await syncAccess(narrow, cf.store, landsThen504, "a");
      expect(writes.at(-1)).toEqual({ path: expect.any(String), policies: 0 });
      expect(cf.calls.some((call) => call.endsWith("/revoke_tokens"))).toBe(true);
      expect(accessStates(narrow, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a write and ends the sessions when the revoke after a read-back fails (K-409)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      const narrow = desiredAccess(
        applyChanges(
          state,
          resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
        ),
        0,
      );
      await syncAccess(narrow, cf.store, cf.api, "a");
      // The owner widens the card; Cloudflare stores the write but answers 504.
      let puts = 0;
      let revokes = 0;
      const flaky: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
        if (path.endsWith("/revoke_tokens") && revokes++ === 0)
          throw new CloudflareError(500, `POST ${path} failed (500): error`);
        const answer = await cf.api<T>(method, path, body);
        if (method === "PUT" && path.includes("/apps/") && puts++ === 0)
          throw new CloudflareError(504, `PUT ${path} failed (504): error code: 504`);
        return answer;
      };
      await syncAccess(desiredAccess(state, 0), cf.store, flaky, "a");
      // The owner moves it back: kitshn reads back the wide body, writes the narrow one, and the revoke fails.
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      await syncAccess(narrow, cf.store, flaky, "a");
      expect(revokes).toBe(1);
      expect(accessStates(narrow, cf.rows)["kitshn-admin"]).toMatchObject({ state: "failed" });
      // The next try writes again and ends the sessions, though Cloudflare already serves the narrow body.
      vi.setSystemTime(1_000_000 + 2 * 60 * 60_000);
      cf.calls.length = 0;
      await syncAccess(narrow, cf.store, flaky, "a");
      expect(cf.calls.filter((call) => !call.startsWith("GET"))).toEqual([
        expect.stringMatching(/^PUT \/apps\//),
        expect.stringMatching(/^POST \/apps\/.*\/revoke_tokens$/),
      ]);
      expect(accessStates(narrow, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the sessions of an application whose create landed after a 504 (K-409)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      // The create of the wide application lands, but Cloudflare answers 504.
      let posts = 0;
      const flaky: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
        const answer = await cf.api<T>(method, path, body);
        if (method === "POST" && path.endsWith("/apps") && posts++ === 0)
          throw new CloudflareError(504, `POST ${path} failed (504): error code: 504`);
        return answer;
      };
      await syncAccess(desiredAccess(state, 0), cf.store, flaky, "a");
      expect(cf.rows.get("app:kitshn-admin:kit.example.com")).toMatchObject({ cfId: "", body: "" });
      // The owner takes the card out of every circle: kitshn finds the application by name and ends its sessions.
      const narrow = desiredAccess(
        applyChanges(
          state,
          resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
        ),
        0,
      );
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      cf.calls.length = 0;
      await syncAccess(narrow, cf.store, flaky, "a");
      expect(cf.calls.some((call) => call.endsWith("/revoke_tokens"))).toBe(true);
      expect(accessStates(narrow, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a 504 that landed with a read-back and no second write, and backs off 5, then 15 minutes (K-408)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      const away = applyChanges(
        state,
        resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
      );
      await syncAccess(desiredAccess(away, 0), cf.store, cf.api, "a");
      const wide = desiredAccess(state, 0);
      let gets = 0;
      let puts = 0;
      // The PUT lands and answers 504; the first read-back gets no answer either.
      const flaky: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
        if (method === "GET" && path.includes("/apps/") && gets++ === 0)
          throw new CloudflareError(0, `GET ${path}: no answer from Cloudflare`);
        const answer = await cf.api<T>(method, path, body);
        if (method === "PUT" && path.includes("/apps/") && puts++ === 0)
          throw new CloudflareError(504, `PUT ${path} failed (504): error code: 504`);
        return answer;
      };
      await syncAccess(wide, cf.store, flaky, "a");
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      await syncAccess(wide, cf.store, flaky, "a");
      // The second unclear answer in a row waits 15 minutes.
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS + 10 * 60_000);
      expect(hasAccessWork(wide, cf.rows)).toBe(false);
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS + 15 * 60_000);
      expect(hasAccessWork(wide, cf.rows)).toBe(true);
      cf.calls.length = 0;
      await syncAccess(wide, cf.store, flaky, "a");
      // Cloudflare serves the wanted body: one read, no second write.
      expect(cf.calls.filter((call) => !call.startsWith("GET"))).toEqual([]);
      expect(puts).toBe(1);
      expect(accessStates(wide, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a removal at once after an earlier body was refused (K-407)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const owner = state.circles.get("owner")!;
    // A wider body (one more circle around the admin card) is refused.
    const wider = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "others", after: { ...owner, id: "others", name: "Others" } },
      ]),
    );
    const refusing: Api = async (method, path, body) => {
      if (method === "PUT" && path.includes("/apps/"))
        throw new CloudflareError(403, `PUT ${path} failed (403): refused`);
      return cf.api(method, path, body);
    };
    await syncAccess(desiredAccess(wider, 0), cf.store, refusing, "a");
    // The owner then takes the card out of every circle, which lowers access: it is written at once.
    const away = applyChanges(
      state,
      resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
    );
    cf.calls.length = 0;
    await syncAccess(desiredAccess(away, 0), cf.store, cf.api, "a");
    expect(cf.calls.some((call) => call.startsWith("PUT /apps/"))).toBe(true);
    expect(accessStates(desiredAccess(away, 0), cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
  });

  it("counts an error that is not Cloudflare's answer as a refusal: red, and no retry in five minutes", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const buggy: Api = async (method, path, body) => {
        if (method === "POST" && path.endsWith("/apps"))
          throw new TypeError("cannot read properties of undefined");
        return cf.api(method, path, body);
      };
      const desired = desiredAccess(start(), 0);
      await syncAccess(desired, cf.store, buggy, "a");
      expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({
        state: "failed",
        error: "cannot read properties of undefined",
      });
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      expect(hasAccessWork(desired, cf.rows)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a removal that Cloudflare refused after 5 minutes, and shows it in red until it lands (K-407)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
      // The admin card leaves every circle: its application loses the Owner policy, which lowers access.
      const away = applyChanges(
        state,
        resolveEdits(state, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
      );
      const desired = desiredAccess(away, 0);
      let refuse = true;
      const refusing: Api = async (method, path, body) => {
        if (refuse && method === "PUT" && path.includes("/apps/"))
          throw new CloudflareError(403, `PUT ${path} failed (403): refused`);
        return cf.api(method, path, body);
      };
      await syncAccess(desired, cf.store, refusing, "a");
      expect(accessStates(desired, cf.rows)["kitshn-admin"]).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/^Access not lowered yet: /),
      });
      // A refusal that lowers access does not wait for the daily retry.
      expect(hasAccessWork(desired, cf.rows)).toBe(false);
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      expect(hasAccessWork(desired, cf.rows)).toBe(true);
      refuse = false;
      await syncAccess(desired, cf.store, refusing, "a");
      expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "applied" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a refused policy write that takes a person out after 5 minutes, and lets a refused widening wait (K-407)", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    try {
      const cf = fakeCloudflare();
      const state = start();
      const owner = state.circles.get("owner")!;
      const withDomain = (domains: ReadonlyArray<string>) =>
        applyChanges(
          state,
          resolveEdits(state, [
            {
              _tag: "circle",
              id: "owner",
              after: {
                ...owner,
                members: [
                  ...owner.members,
                  ...domains.map((domain) => ({ _tag: "domain" as const, domain })),
                ],
              },
            },
          ]),
        );
      await syncAccess(desiredAccess(withDomain(["x.com"]), 0), cf.store, cf.api, "a");
      const refusing: Api = async (method, path, body) => {
        if (method === "PUT" && path.includes("/policies/"))
          throw new CloudflareError(400, `PUT ${path} failed (400): refused`);
        return cf.api(method, path, body);
      };
      // x.com leaves the circle: the refused policy write lowers access, so it shows in red and retries.
      const narrow = desiredAccess(state, 0);
      await syncAccess(narrow, cf.store, refusing, "a");
      expect(accessStates(narrow, cf.rows)["kitshn-admin"]).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/^Access not lowered yet: /),
      });
      vi.setSystemTime(1_000_000 + RETRY_AFTER_MS);
      expect(hasAccessWork(narrow, cf.rows)).toBe(true);
      // y.com joins instead: a refused widening waits for the daily retry.
      const wide = desiredAccess(withDomain(["x.com", "y.com"]), 0);
      for (const row of cf.rows.values()) cf.rows.set(row.key, { ...row, tried: row.body, error: null });
      await syncAccess(wide, cf.store, refusing, "a");
      expect(accessStates(wide, cf.rows)["kitshn-admin"]).toEqual({
        state: "failed",
        error: expect.stringMatching(/^PUT /),
      });
      vi.setSystemTime(1_000_000 + 2 * 60 * 60_000);
      expect(hasAccessWork(wide, cf.rows)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the sessions of the applications that share to a circle when a member leaves it (K-409)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const domain = { _tag: "domain" as const, domain: "x.com" };
    const withX = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, domain] } },
      ]),
    );
    await syncAccess(desiredAccess(withX, 0), cf.store, cf.api, "a");
    const app = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const people = cf.rows.get("policy:owner:people")!.cfId;
    cf.calls.length = 0;
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    // One change: the circle's four policies, and one revoke for the one application that uses the people policy.
    expect(cf.calls).toEqual([
      `PUT /policies/${people}`,
      `POST /apps/${app}/revoke_tokens`,
      `PUT /policies/${cf.rows.get("policy:owner:login")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:owner:login-passkey")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:enrollment")!.cfId}`,
    ]);
  });

  it("ends the sessions of every application of a narrowed policy at once (K-409)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const card: Resource = {
      id: "two",
      kind: "site.static",
      name: "two",
      addresses: ["two.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    const both: State = {
      ...state,
      resources: new Map([...state.resources, ["two", card]]),
      places: new Map([...state.places, ["two", state.places.get("kitshn-admin")!]]),
    };
    const domain = { _tag: "domain" as const, domain: "x.com" };
    const withX = applyChanges(
      both,
      resolveEdits(both, [
        { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, domain] } },
      ]),
    );
    await syncAccess(desiredAccess(withX, 0), cf.store, cf.api, "a");
    let inFlight = 0;
    let most = 0;
    const counting: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
      if (!path.endsWith("/revoke_tokens")) return cf.api<T>(method, path, body);
      most = Math.max(most, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return cf.api<T>(method, path, body);
    };
    cf.calls.length = 0;
    await syncAccess(desiredAccess(both, 0), cf.store, counting, "a");
    expect(cf.calls.filter((call) => call.endsWith("/revoke_tokens"))).toHaveLength(2);
    expect(most).toBe(2);
  });

  it("ends the sessions of more applications than one run reaches over several runs, each once (K-406, K-409)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const cards: Array<Resource> = ["two", "three"].map((id) => ({
      id,
      kind: "site.static",
      name: id,
      addresses: [`${id}.example.com`],
      status: "running",
      group: null,
      machine: null,
    }));
    const all: State = {
      ...state,
      resources: new Map([...state.resources, ...cards.map((card) => [card.id, card] as const)]),
      places: new Map([
        ...state.places,
        ...cards.map((card) => [card.id, state.places.get("kitshn-admin")!] as const),
      ]),
    };
    const domain = { _tag: "domain" as const, domain: "x.com" };
    const withX = applyChanges(
      all,
      resolveEdits(all, [
        { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, domain] } },
      ]),
    );
    await syncAccess(desiredAccess(withX, 0), cf.store, cf.api, "a");
    cf.calls.length = 0;
    // Each run has room for the policy write and one revoke; the circle's other policies take later runs.
    const desired = desiredAccess(all, 0);
    let runs = 0;
    while (!(await syncAccess(desired, cf.store, cf.api, "a", 2)) && runs < 10) runs++;
    expect(runs).toBeLessThan(10);
    const revokes = cf.calls.filter((call) => call.endsWith("/revoke_tokens"));
    expect(new Set(revokes).size).toBe(3);
    expect(revokes).toHaveLength(3);
    expect(cf.rows.get("policy:owner:people")).toMatchObject({
      body: cf.rows.get("policy:owner:people")!.tried,
    });
  });

  it("writes the application before it ends sessions and deletes the policy that it dropped (K-409, K-410)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const b: Circle = { ...owner, id: "b", name: "B", needsPasskey: false, x: 5000, y: 5000, r: 100 };
    const inB = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "b", after: b },
        { _tag: "place", id: "kitshn-admin", after: { x: 5000, y: 5000 } },
      ]),
    );
    await syncAccess(desiredAccess(inB, 0), cf.store, cf.api, "a");
    const app = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const policy = cf.rows.get("policy:b:people")!.cfId;
    const out = applyChanges(
      inB,
      resolveEdits(inB, [{ _tag: "place", id: "kitshn-admin", after: { x: 9000, y: 9000 } }]),
    );
    cf.calls.length = 0;
    await syncAccess(desiredAccess(out, 0), cf.store, cf.api, "a");
    const write = cf.calls.indexOf(`PUT /apps/${app}`);
    expect(write).toBeGreaterThanOrEqual(0);
    expect(cf.calls.indexOf(`POST /apps/${app}/revoke_tokens`)).toBeGreaterThan(write);
    expect(cf.calls.indexOf(`DELETE /policies/${policy}`)).toBeGreaterThan(write);
    expect(cf.rows.has("policy:b:people")).toBe(false);
    expect(cf.rows.get("app:kitshn-admin:kit.example.com")).toMatchObject({ error: null });
  });

  it.each([
    ["a passkey check", (owner: Circle) => ({ ...owner, needsPasskey: true }), true],
    [
      "a rule that all must match",
      (owner: Circle) => ({
        ...owner,
        match: "all" as const,
        members: [...owner.members, { _tag: "domain" as const, domain: "x.com" }],
      }),
      true,
    ],
    ["a new name", (owner: Circle) => ({ ...owner, name: "Renamed" }), false],
    [
      "Everyone",
      (owner: Circle) => ({ ...owner, members: [...owner.members, { _tag: "everyone" as const }] }),
      false,
    ],
  ])("a refused policy write with %s shows whether it lowers access (K-407)", async (_, edit, lowered) => {
    const cf = fakeCloudflare();
    // Owner starts without a passkey check, so that adding one is a change.
    const seeded = start();
    const state = applyChanges(
      seeded,
      resolveEdits(seeded, [
        { _tag: "circle", id: "owner", after: { ...seeded.circles.get("owner")!, needsPasskey: false } },
      ]),
    );
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const changed = applyChanges(
      state,
      resolveEdits(state, [{ _tag: "circle", id: "owner", after: edit(state.circles.get("owner")!) }]),
    );
    const desired = desiredAccess(changed, 0);
    const refusing: Api = async (method, path, body) => {
      if (method === "PUT" && path.includes("/policies/"))
        throw new CloudflareError(400, `PUT ${path} failed (400): refused`);
      return cf.api(method, path, body);
    };
    await syncAccess(desired, cf.store, refusing, "a");
    const card = accessStates(desired, cf.rows)["kitshn-admin"];
    expect(card).toMatchObject({ state: "failed" });
    expect(card && "error" in card && card.error.startsWith("Access not lowered yet: ")).toBe(lowered);
  });

  it("removes a share from the application even when the policy of a new share fails", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const owner = state.circles.get("owner")!;
    const moved = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "others", after: { ...owner, id: "others", name: "Others", x: 5000 } },
        { _tag: "place", id: "kitshn-admin", after: { x: 5000, y: 40 } },
      ]),
    );
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/policies")) throw new Error("refused");
      return cf.api(method, path, body);
    };
    await syncAccess(desiredAccess(moved, 0), cf.store, failing, "a");
    expect(JSON.parse(cf.rows.get("app:kitshn-admin:kit.example.com")!.body).policies).toEqual([]);
  });

  it("never empties an application when a policy create fails, and retries after the daily reset", async () => {
    const cf = fakeCloudflare({ apps: [{ id: "app-1", name: "kitshn admin", domain: "kit.example.com" }] });
    const desired = desiredAccess(start(), 0);
    const down: Api = async (method, path, body) => {
      if (path.includes("/policies")) throw new Error("503");
      return cf.api(method, path, body);
    };
    await syncAccess(desired, cf.store, down, "a");
    expect(cf.calls.filter((call) => call.includes("/apps/"))).toEqual([]);
    expect(hasAccessWork(desired, cf.rows)).toBe(false);

    for (const row of cf.rows.values()) cf.rows.set(row.key, { ...row, error: null });
    expect(hasAccessWork(desired, cf.rows)).toBe(true);
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(JSON.parse(cf.rows.get("app:kitshn-admin:kit.example.com")!.body).policies).toHaveLength(1);
  });

  it("updates the policy when the circle changes", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const owner = state.circles.get("owner")!;
    const changed = applyChanges(
      state,
      resolveEdits(state, [
        {
          _tag: "circle",
          id: "owner",
          after: { ...owner, members: [...owner.members, { _tag: "domain", domain: "x.com" }] },
        },
      ]),
    );
    const desired = desiredAccess(changed, 0);
    expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "applying" });
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    // The new domain also may enroll a passkey (K-113).
    expect(cf.calls).toEqual([
      `PUT /policies/${cf.rows.get("policy:owner:people")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:owner:login")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:owner:login-passkey")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:enrollment")!.cfId}`,
    ]);
  });
});

describe("daily compare and sessions (K-408, K-409, K-110)", () => {
  it("rewrites an object that someone changed, and warns about a foreign application", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const adminId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const enrollment = cf.rows.get("policy:enrollment")!;
    const login = cf.rows.get("policy:owner:login")!;
    const loginPasskey = cf.rows.get("policy:owner:login-passkey")!;
    const live: Api = async <T>(method: string, path: string) => {
      if (path.includes("/policies?"))
        return [
          {
            id: "id1",
            name: "kitshn circle Owner",
            decision: "allow",
            include: [{ everyone: {} }],
            require: [],
            exclude: [],
          },
          { id: enrollment.cfId, ...JSON.parse(enrollment.body) },
          { id: login.cfId, ...JSON.parse(login.body) },
          { id: loginPasskey.cfId, ...JSON.parse(loginPasskey.body) },
        ] as T;
      if (path.includes("/apps?"))
        return [
          {
            id: adminId,
            name: "kitshn admin",
            domain: "kit.example.com",
            session_duration: "24h",
            policies: [{ id: "id1" }],
          },
          { id: "x", name: "Someone else", domain: "kit.example.com" },
        ] as T;
      return cf.api(method as "GET", path);
    };
    const warnings = await verifyAccess(desired, cf.store, live, "a");
    expect(warnings).toEqual([expect.stringContaining("Someone else")]);
    expect(hasAccessWork(desired, cf.rows)).toBe(true);
    cf.calls.length = 0;
    // Cloudflare serves the changed policy: the read-back sees it, and kitshn writes the wanted one.
    const changedOwner: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) =>
      method === "GET" && path.endsWith("/policies/id1")
        ? ({ id: "id1", name: "kitshn circle Owner", decision: "allow", include: [{ everyone: {} }] } as T)
        : cf.api<T>(method, path, body);
    await syncAccess(desired, cf.store, changedOwner, "a");
    // The rewrite takes "everyone" out again, so the sessions of the admin application end (K-409).
    expect(cf.calls).toEqual(["PUT /policies/id1", `POST /apps/${adminId}/revoke_tokens`]);
  });

  it("ends the sessions of an application that loses a policy, and of every kitshn application on sign out", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const two = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "b", after: { ...owner, id: "b", name: "B", x: 0, y: 0, r: 100 } },
      ]),
    );
    await syncAccess(desiredAccess(two, 0), cf.store, cf.api, "a");
    cf.calls.length = 0;
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    expect(cf.calls).toContain(
      `POST /apps/${cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId}/revoke_tokens`,
    );
    cf.calls.length = 0;
    expect(await signOutEverywhere(cf.store, cf.api, "a")).toEqual({ ended: 1, left: [] });
    expect(cf.calls).toEqual([
      `POST /apps/${cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId}/revoke_tokens`,
    ]);
  });

  it("ends no admin session when a machine goes, because its service token goes with it (K-615, K-1777)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const machine = (id: string) =>
      [
        id,
        { id, name: id, labels: [], order: 0, serviceTokenId: `t-${id}`, clientId: `c-${id}`, tunnelId: id },
      ] as const;
    const two: State = { ...state, machines: new Map([machine("m1"), machine("m2")]) };
    await syncAccess(desiredAccess(two, 0), cf.store, cf.api, "a");
    for (const left of [new Map([machine("m1")]), new Map()]) {
      cf.calls.length = 0;
      await syncAccess(desiredAccess({ ...state, machines: left }, 0), cf.store, cf.api, "a");
      expect(cf.calls.length).toBeGreaterThan(0);
      expect(cf.calls.filter((call) => call.endsWith("/revoke_tokens"))).toEqual([]);
    }
  });

  it("retries a failed session revoke after the daily compare", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const two = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "b", after: { ...owner, id: "b", name: "B", x: 0, y: 0, r: 100 } },
      ]),
    );
    await syncAccess(desiredAccess(two, 0), cf.store, cf.api, "a");
    const revokeFails: Api = async (method, path, body) => {
      if (path.endsWith("/revoke_tokens")) throw new Error("500");
      return cf.api(method, path, body);
    };
    const desired = desiredAccess(state, 0);
    await syncAccess(desired, cf.store, revokeFails, "a");
    for (const row of cf.rows.values()) cf.rows.set(row.key, { ...row, error: null });
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const live: Api = async <T>(method: string, path: string) => {
      if (path.includes("/policies?")) return [] as T;
      if (path.includes("/apps?"))
        return [{ id: appId, name: "kitshn admin", domain: "kit.example.com", policies: [] }] as T;
      return cf.api(method as "GET", path);
    };
    await verifyAccess(desired, cf.store, live, "a");
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(cf.calls).toContain(`POST /apps/${appId}/revoke_tokens`);
  });

  it("keeps the Access app while a route can still reach its address (K-410)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const gone: State = { ...state, resources: new Map() };
    const desired = desiredAccess(gone, 0);
    // The ingress update that removes the site failed, so the old ingress still reaches kit.example.com.
    const reachable = new Set(["kit.example.com"]);
    cf.calls.length = 0;
    const loginId = cf.rows.get("policy:owner:login")!.cfId;
    const passkeyId = cf.rows.get("policy:owner:login-passkey")!.cfId;
    await syncAccess(desired, cf.store, cf.api, "a", 40, reachable);
    // Only the login copies go: no Access application of a card holds them (K-1004).
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE /policies/${loginId}`,
      `DELETE /policies/${passkeyId}`,
    ]);
    cf.calls.length = 0;
    expect(hasAccessWork(desired, cf.rows, reachable)).toBe(false);
    // Once the route is confirmed gone, the app goes, and then its policy.
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const ownerId = cf.rows.get("policy:owner:people")!.cfId;
    await syncAccess(desired, cf.store, cf.api, "a", 40, new Set());
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE /apps/${appId}`,
      `DELETE /policies/${ownerId}`,
    ]);
  });

  it("keeps a reachable app also after an unclear answer left its body unknown (K-410)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const key = "app:kitshn-admin:kit.example.com";
    cf.rows.set(key, { ...cf.rows.get(key)!, body: "", tried: "" });
    const desired = desiredAccess({ ...state, resources: new Map() }, 0);
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a", 40, new Set(["kit.example.com"]));
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
  });
});

describe("passkey enrollment on the App Launcher (K-113)", () => {
  function launcherCloudflare(policies: Array<{ id: string; precedence?: number }>) {
    const cf = fakeCloudflare();
    const puts: Array<unknown> = [];
    const launcher = {
      id: "launcher",
      uid: "u",
      type: "app_launcher",
      name: "App Launcher",
      domain: "team",
      policies,
    };
    const api: Api = async <T>(method: string, path: string, body?: unknown) => {
      if (path.endsWith("/apps/launcher") && method === "GET") return launcher as T;
      if (path.includes("/apps?")) return [{ id: "other", type: "self_hosted" }, launcher] as T;
      if (method === "PUT" && path.endsWith("/apps/launcher")) {
        puts.push(body);
        return {} as T;
      }
      return cf.api(method as "GET", path, body);
    };
    return { ...cf, api, puts };
  }

  it("keeps the precedence of the other policies and goes after them", async () => {
    const cf = launcherCloudflare([
      { id: "block", precedence: 3 },
      { id: "t3-owner", precedence: 1 },
    ]);
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const enrollment = cf.rows.get("policy:enrollment")!.cfId;
    await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", null, false);
    expect(cf.puts).toEqual([
      expect.objectContaining({
        policies: [
          { id: "block", precedence: 3 },
          { id: "t3-owner", precedence: 1 },
          { id: enrollment, precedence: 4 },
        ],
      }),
    ]);
  });

  it("leaves out circles that would let in more people, and keeps only Owner during a pause", () => {
    const state = start();
    const owner = state.circles.get("owner")!;
    const strict = {
      ...owner,
      id: "strict",
      name: "Strict",
      match: "all" as const,
      members: [{ _tag: "domain" as const, domain: "corp.com" }],
    };
    const withStrict = { ...state, circles: new Map(state.circles).set("strict", strict) };
    expect(desiredAccess(withStrict, 0).policies.get("policy:enrollment")?.include).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
    const guests = {
      ...owner,
      id: "guests",
      name: "Guests",
      members: [{ _tag: "email" as const, email: "g@x.com" }],
    };
    const paused = {
      ...state,
      paused: "lockdown" as const,
      circles: new Map(state.circles).set("guests", guests),
    };
    expect(desiredAccess(paused, 0).policies.get("policy:enrollment")?.include).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
  });

  it("adds the policy next to the old ones, keeps every other field, and takes back only its own", async () => {
    const cf = launcherCloudflare([{ id: "t3-owner" }]);
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const enrollment = cf.rows.get("policy:enrollment")!.cfId;
    const added = await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", null, false);
    expect(added.attached).toBe(enrollment);
    expect(cf.puts).toEqual([
      {
        type: "app_launcher",
        name: "App Launcher",
        domain: "team",
        policies: [
          { id: "t3-owner", precedence: 1 },
          { id: enrollment, precedence: 2 },
        ],
      },
    ]);
    // Nothing changed: no Cloudflare call.
    expect(await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", enrollment, false)).toEqual({
      attached: enrollment,
      calls: 0,
    });
    // No passkey circle any more: only the kitshn policy leaves the App Launcher.
    const owner = state.circles.get("owner")!;
    const relaxed = {
      ...state,
      circles: new Map(state.circles).set("owner", { ...owner, needsPasskey: false }),
    };
    const launcher = launcherCloudflare([{ id: "t3-owner" }, { id: enrollment }]);
    const removed = await syncLauncher(
      desiredAccess(relaxed, 0),
      cf.store,
      launcher.api,
      "a",
      enrollment,
      false,
    );
    expect(removed.attached).toBeNull();
    expect(launcher.puts).toEqual([
      expect.objectContaining({ policies: [{ id: "t3-owner", precedence: 1 }] }),
    ]);
  });
});

describe("page and file logins (K-1004)", () => {
  const anyLogin = { id: "any", name: "kitshn any login" };
  const anyPasskey = { id: "any-passkey", name: "kitshn any login (passkey)" };

  function loginCloudflare(
    fail: (path: string) => boolean = () => false,
    attachMachines = true,
    listMachines = true,
  ) {
    const cf = fakeCloudflare();
    const puts: Array<{ path: string; body: unknown }> = [];
    const machines = { id: "machines", name: "kitshn machines", precedence: 2 };
    const apps = ["pages", "files"].flatMap((host) => [
      {
        id: `${host}-login`,
        uid: `${host}-login`,
        aud: "x",
        created_at: "2026-10-27T00:00:00Z",
        updated_at: "2026-10-27T00:00:00Z",
        type: "self_hosted",
        name: `kitshn ${host} login`,
        domain: `${host}.example.com/login`,
        destinations: [{ type: "public", uri: `${host}.example.com/login` }],
        self_hosted_domains: [`${host}.example.com/login`],
        session_duration: "720h",
        same_site_cookie_attribute: "lax",
        allowed_idps: ["otp"],
        scim_config: { enabled: false },
        policies: attachMachines
          ? [{ ...anyLogin, precedence: 1 }, machines]
          : [{ ...anyLogin, precedence: 1 }],
      },
      {
        id: `${host}-passkey`,
        aud: "y",
        name: `kitshn ${host} login (passkey)`,
        domain: `${host}.example.com/login/passkey`,
        policies: [{ ...anyPasskey, precedence: 1 }],
      },
    ]);
    const api: Api = async <T>(method: string, path: string, body?: unknown) => {
      if (path.includes("/apps?")) return apps as T;
      if (path.includes("/policies?"))
        return (listMachines ? [anyLogin, anyPasskey, machines] : [anyLogin, anyPasskey]) as T;
      if (fail(path)) throw new Error("refused");
      if (method === "PUT") puts.push({ path, body });
      return cf.api(method as "GET", path, body);
    };
    return { ...cf, api, puts, apps };
  }

  it("replaces the any-login policies with the circles' people, keeps machines, and deletes the old ones", async () => {
    const cf = loginCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const plain = cf.rows.get("policy:owner:login")!.cfId;
    const passkey = cf.rows.get("policy:owner:login-passkey")!.cfId;
    cf.calls.length = 0;
    const result = await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts).toEqual([
      {
        path: "/accounts/a/access/apps/pages-login",
        body: {
          type: "self_hosted",
          name: "kitshn pages login",
          domain: "pages.example.com/login",
          destinations: [{ type: "public", uri: "pages.example.com/login" }],
          self_hosted_domains: ["pages.example.com/login"],
          session_duration: "720h",
          same_site_cookie_attribute: "lax",
          allowed_idps: ["otp"],
          policies: [
            { id: "machines", precedence: 1 },
            { id: plain, precedence: 2 },
          ],
        },
      },
      expect.objectContaining({
        body: expect.objectContaining({ policies: [{ id: passkey, precedence: 1 }] }),
      }),
      expect.objectContaining({ path: "/accounts/a/access/apps/files-login" }),
      expect.objectContaining({ path: "/accounts/a/access/apps/files-passkey" }),
    ]);
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      "DELETE /policies/any",
      "DELETE /policies/any-passkey",
    ]);
    expect(result.calls).toBe(8);
    // Nothing changed: no Cloudflare call.
    expect(await syncLogins(desired, cf.store, cf.api, "a", "example.com", result.attached, false)).toEqual({
      attached: result.attached,
      calls: 0,
    });
    // K-1130: with the kitshn pages, each login application gets the kitshn sign-in page, also with its policies right.
    for (const put of cf.puts) {
      const app = cf.apps.find((item) => put.path.endsWith(`/${item.id}`));
      if (app) app.policies = (put.body as { policies: typeof app.policies }).policies;
    }
    cf.puts.length = 0;
    const pages = { chef: "chef-page", closed: "closed-page", login: "login-page" };
    const withPages = desiredAccess(start(), 0, [], [], pages);
    const paged = await syncLogins(withPages, cf.store, cf.api, "a", "example.com", result.attached, false);
    expect(cf.puts.map((put) => (put.body as { custom_pages?: unknown }).custom_pages)).toEqual([
      ["login-page"],
      ["login-page"],
      ["login-page"],
      ["login-page"],
    ]);
    expect(paged.attached).not.toBe(result.attached);
  });

  it("writes the other applications when one fails, keeps the old policy it still uses, and throws", async () => {
    const cf = loginCloudflare((path) => path.endsWith("/apps/files-login"));
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    cf.calls.length = 0;
    await expect(syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false)).rejects.toThrow(
      "files.example.com/login: refused",
    );
    expect(cf.puts.map((put) => put.path)).toEqual([
      "/accounts/a/access/apps/pages-login",
      "/accounts/a/access/apps/pages-passkey",
      "/accounts/a/access/apps/files-passkey",
    ]);
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual(["DELETE /policies/any-passkey"]);
  });

  it("leaves out a policy that Cloudflare does not hold as written", async () => {
    const cf = loginCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const row = cf.rows.get("policy:owner:login")!;
    cf.rows.set(row.key, { ...row, body: "" });
    await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ policies: [{ id: "machines", precedence: 1 }] }),
      }),
    );
  });

  it("puts the machines policy back on /login when someone took it off", async () => {
    const cf = loginCloudflare(undefined, false);
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          policies: [
            { id: "machines", precedence: 1 },
            { id: cf.rows.get("policy:owner:login")!.cfId, precedence: 2 },
          ],
        }),
      }),
    );
  });

  it("runs the login step before the sync, inside one budget (K-406)", async () => {
    const order: Array<string> = [];
    const logins = async () => {
      order.push("logins");
      return 8;
    };
    const access = async (budget: number) => {
      order.push(`access ${budget}`);
      return true;
    };
    expect(await syncWithLogins(21, true, logins, access)).toBe(8);
    expect(order).toEqual(["logins", "access 13"]);
    order.length = 0;
    // No room for the whole login step: it waits for the next alarm, and the sync keeps its budget.
    expect(await syncWithLogins(7, true, logins, access)).toBe(0);
    expect(await syncWithLogins(21, false, logins, access)).toBe(0);
    expect(order).toEqual(["access 7", "access 21"]);
  });

  it("leaves /login alone without the machines policy, so service tokens keep their login", async () => {
    const cf = loginCloudflare(undefined, true, false);
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    await expect(syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false)).rejects.toThrow(
      'no policy "kitshn machines"',
    );
    expect(cf.puts.map((put) => put.path)).toEqual([
      "/accounts/a/access/apps/pages-passkey",
      "/accounts/a/access/apps/files-passkey",
    ]);
  });

  it("never deletes a policy that a login application holds", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const held = loginHeld(loginWant(desiredAccess(state, 0), cf.rows));
    const gone = desiredAccess({ ...state, resources: new Map() }, 0);
    cf.calls.length = 0;
    await syncAccess(gone, cf.store, cf.api, "a", 40, new Set(), held);
    const deleted = cf.calls.filter((call) => call.startsWith("DELETE /policies"));
    for (const id of held) expect(deleted).not.toContain(`DELETE /policies/${id}`);
    expect(hasAccessWork(gone, cf.rows, new Set(), held)).toBe(false);
  });

  it("keeps a policy off the passkey login while Cloudflare holds a body without its passkey check", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const row = cf.rows.get("policy:owner:login-passkey")!;
    const { mfa_config: _, ...old } = JSON.parse(row.body) as Record<string, unknown>;
    cf.rows.set(row.key, { ...row, body: JSON.stringify(old) });
    expect(JSON.parse(loginWant(desired, cf.rows))).toMatchObject({
      login: [cf.rows.get("policy:owner:login")!.cfId],
      passkey: [],
    });
  });

  it("warns on the map about a login policy that Cloudflare refused", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/policies")) throw new Error("refused");
      return cf.api(method, path, body);
    };
    await syncAccess(desired, cf.store, failing, "a");
    expect(loginWarnings(desired, cf.rows)).toEqual([
      expect.stringContaining('"kitshn circle Owner (login)" of pages and files failed: refused'),
      expect.stringContaining('"kitshn circle Owner (passkey login)" of pages and files failed: refused'),
    ]);
  });

  it("holds only the login copies, so a site policy still changes while the login step waits (K-409)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const held = loginHeld(loginWant(desiredAccess(state, 0), cf.rows));
    const people = cf.rows.get("policy:owner:people")!;
    const passkeyCopy = cf.rows.get("policy:owner:login-passkey")!;
    // "Needs passkey" turns off, and the login step was skipped or failed.
    const owner = state.circles.get("owner")!;
    const relaxed = desiredAccess(
      { ...state, circles: new Map(state.circles).set("owner", { ...owner, needsPasskey: false }) },
      0,
    );
    cf.calls.length = 0;
    await syncAccess(relaxed, cf.store, cf.api, "a", 40, new Set(), held);
    expect(cf.calls).toContain(`PUT /policies/${people.cfId}`);
    expect(cf.calls).not.toContain(`DELETE /policies/${passkeyCopy.cfId}`);
    expect(cf.rows.get(passkeyCopy.key)!.body).toBe(passkeyCopy.body);
    // Once the login step lets go of it, the copy goes.
    await syncAccess(relaxed, cf.store, cf.api, "a", 40, new Set(), loginHeld(loginWant(relaxed, cf.rows)));
    expect(cf.calls).toContain(`DELETE /policies/${passkeyCopy.cfId}`);
  });

  it("holds the earlier and the new ids after a login step that failed part way", () => {
    const before = JSON.stringify({ login: ["a"], passkey: ["p"] });
    const want = JSON.stringify({ login: ["a", "b"], passkey: [] });
    expect(JSON.parse(loginHeldAfter(before, want, false))).toEqual({ login: ["a", "b"], passkey: ["p"] });
    expect(loginHeldAfter(before, want, true)).toBe(want);
    expect(loginHeldAfter("", want, false)).toBe(want);
  });
});

describe("sign out everywhere (K-110)", () => {
  const apps = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ key: `app${index}`, cfId: `id${index}` }));
  const failing =
    (bad: string): Api =>
    async <T>(_method: string, path: string) => {
      if (path.includes(`/${bad}/`)) throw new Error("Cloudflare said no");
      return {} as T;
    };

  it("keeps each failed application and each one past the call limit for a retry", async () => {
    const outcome = await revokeSessions(failing("id1"), "a", apps(CALLS_PER_RUN + 2));
    expect(outcome).toEqual({
      ended: CALLS_PER_RUN - 1,
      left: [
        { key: "app1", cfId: "id1", reason: "Cloudflare said no" },
        { key: `app${CALLS_PER_RUN}`, cfId: `id${CALLS_PER_RUN}`, reason: "the call limit of one request" },
        {
          key: `app${CALLS_PER_RUN + 1}`,
          cfId: `id${CALLS_PER_RUN + 1}`,
          reason: "the call limit of one request",
        },
      ],
    });
    expect(signOutSummary(outcome, false)).toContain(`failed for: app1, app${CALLS_PER_RUN}`);
    expect(signOutWarning(outcome)).toContain("app1 (Cloudflare said no)");
  });

  it("clears the warning once a retry ends every session left", async () => {
    const first = await revokeSessions(failing("id1"), "a", apps(2));
    expect(signOutWarning(first)).not.toBeNull();
    const retry = await revokeSessions(failing("none"), "a", "left" in first ? first.left : []);
    expect(retry).toEqual({ ended: 1, left: [] });
    expect(signOutWarning(retry)).toBeNull();
    expect(signOutSummary(retry, true)).toBe(
      "Retry of sign-out everywhere ended the sessions of 1 application",
    );
  });

  it("counts an application that Cloudflare no longer has as ended", async () => {
    const gone: Api = async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    };
    expect(await revokeSessions(gone, "a", apps(1))).toEqual({ ended: 1, left: [] });
  });

  it("retries only applications that kitshn still has, with their current id", () => {
    const left = [
      { key: "app0", cfId: "old0", reason: "x" },
      { key: "removed", cfId: "old1", reason: "x" },
    ];
    expect(
      retryApps(left, [
        { key: "app0", cfId: "new0" },
        { key: "other", cfId: "o" },
      ]),
    ).toEqual([{ key: "app0", cfId: "new0" }]);
  });

  it("reads a broken stored outcome as nothing left", () => {
    expect(readSignOutLeft('{"ended":"x"}')).toBeNull();
    expect(readSignOutLeft("")).toBeNull();
    expect(readSignOutLeft('{"ended":0,"listFailed":"HTTP 500"}')).toEqual({
      ended: 0,
      listFailed: "HTTP 500",
    });
  });

  it("warns with Retry when the list of applications failed, as no session ended", () => {
    const outcome = { ended: 0, listFailed: "HTTP 500" } as const;
    expect(signOutWarning(outcome)).toContain("ended no Access session");
    expect(signOutSummary(outcome, false)).toContain("could not list");
    expect(signOutWarning(null)).toBeNull();
  });
});

describe("the approve applications (K-1723)", () => {
  it("puts a passkey circle on the passkey application, alone with its 10-minute check, with its cookie on the path", () => {
    const state = start();
    const agents = {
      ...state.circles.get("owner")!,
      id: "agents",
      name: "Agents",
      members: [
        {
          _tag: "machine" as const,
          machineId: "vps",
          rights: { deploys: { mode: "ask" as const, circleId: "owner" } },
        },
      ],
    };
    const desired = desiredAccess({ ...state, circles: new Map(state.circles).set("agents", agents) }, 0);
    expect(desired.apps.get("app:approve:passkey")).toMatchObject({
      domain: "kit.example.com/api/approve/passkey",
      session_duration: "10m",
      path_cookie_attribute: true,
      policyKeys: ["policy:approve-passkey:owner"],
    });
    expect(desired.policies.get("policy:approve-passkey:owner")).toMatchObject({
      mfa_config: { session_duration: "10m" },
    });
    expect(desired.apps.has("app:approve:login")).toBe(false);
    // No machine: no approve application.
    expect(desiredAccess(state, 0).apps.has("app:approve:passkey")).toBe(false);
    // K-1776: a joined machine in the tray, in no circle, asks the Owner for each unset right.
    const tray = {
      id: "vps",
      name: "vps",
      labels: [],
      order: 0,
      serviceTokenId: "t",
      clientId: "c",
      tunnelId: "u",
    };
    const joined = desiredAccess({ ...state, machines: new Map([["vps", tray]]) }, 0);
    expect(joined.apps.get("app:approve:passkey")).toMatchObject({
      policyKeys: ["policy:approve-passkey:owner"],
    });
  });
});
