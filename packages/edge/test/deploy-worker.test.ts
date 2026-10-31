import {
  createExecutionContext,
  evictDurableObject,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORWARD_HEADERS,
  type Machine,
  type MachineStatus,
  forwardText,
  newMachineKey,
  signText,
} from "../src/core/machine.ts";
import { setup } from "./machine-http.ts";
import type { Resource } from "../src/core/model.ts";
import { type ActionProgress, currentStep } from "../src/core/progress.ts";
import { environmentNames } from "../src/worker/deploys.ts";
import worker from "../src/worker/index.ts";

/** K-806, K-909: Worker deploys, their removal and their storage, through the Worker and its Durable Object. */

const github = await generateKeyPair("RS256");
const team = await generateKeyPair("RS256");
const githubJwk = { ...(await exportJWK(github.publicKey)), kid: "gh", alg: "RS256" };
const teamJwk = { ...(await exportJWK(team.publicKey)), kid: "team", alg: "RS256" };
const API = "https://api.cloudflare.com/client/v4";

/**
 * A fake of the Cloudflare API with state. Like Cloudflare, it refuses a `new_sqlite_classes` migration for a class
 * that the script already has, and a script whose `exports` drop a class. `failDomains` fails the next custom domain
 * calls, `onDelete` runs before a script or KV delete answers, and `others` are scripts with crons of someone else.
 */
function fakeCloudflare(others: Record<string, number> = {}) {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const scripts = new Map<string, { classes: Set<string>; crons: Array<string> }>();
  for (const [id, count] of Object.entries(others))
    scripts.set(id, { classes: new Set(), crons: Array.from({ length: count }, () => "0 * * * *") });
  const domains: Array<{ id: string; hostname: string; service: string }> = [];
  const uploads: Array<Record<string, unknown>> = [];
  const assets: Array<string> = [];
  /** K-821: each rollback of a script to a version, in order. */
  const rollbacks: Array<{ script: string; version: string }> = [];
  const state: {
    failDomains: number;
    failUploads: number;
    refuseRollbacks: Array<string>;
    onDelete: (() => Promise<void>) | null;
  } = {
    failDomains: 0,
    failUploads: 0,
    refuseRollbacks: [],
    onDelete: null,
  };
  let next = 1;
  const collection = (path: string) => {
    const found = collections.get(path) ?? new Map<string, Record<string, unknown>>();
    collections.set(path, found);
    return found;
  };
  collection("/accounts/acct/access/apps").set("launcher", {
    id: "launcher",
    type: "app_launcher",
    policies: [],
  });
  const ok = (result: unknown) => Response.json({ success: true, result });
  const refuse = (message: string) =>
    Response.json({ success: false, errors: [{ code: 10000, message }] }, { status: 400 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (request.url === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({ keys: [githubJwk] });
    if (request.url === "https://team.example.com/cdn-cgi/access/certs")
      return Response.json({ keys: [teamJwk] });
    if (!request.url.startsWith(API)) return new Response(null, { status: 302 });
    const path = url.pathname.slice("/client/v4".length);
    const method = request.method;
    const script = /^\/accounts\/acct\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
    if (script && method === "PUT") {
      const form = await request.formData();
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
      uploads.push(metadata);
      if (state.failUploads > 0) {
        state.failUploads--;
        return refuse("the upload failed");
      }
      const known = scripts.get(script)?.classes ?? new Set<string>();
      const migration = metadata["migrations"] as { new_sqlite_classes?: Array<string> } | undefined;
      const added = migration?.new_sqlite_classes?.find((name) => known.has(name));
      if (added)
        return refuse(
          `Cannot apply new-sqlite-class migration to class '${added}' that is already depended on`,
        );
      const declared = Object.keys((metadata["exports"] as Record<string, unknown> | undefined) ?? {});
      const dropped = [...known].find((name) => !declared.includes(name) && !migration);
      if (dropped) return refuse(`The class ${dropped} has a namespace but no exports entry`);
      scripts.set(script, {
        classes: new Set([...known, ...declared, ...(migration?.new_sqlite_classes ?? [])]),
        crons: scripts.get(script)?.crons ?? [],
      });
      return ok({ id: script });
    }
    if (script && method === "DELETE") {
      await state.onDelete?.();
      scripts.delete(script);
      return ok({});
    }
    if (path === "/accounts/acct/workers/scripts" && method === "GET")
      return ok(
        [...scripts].map(([id, item]) => ({
          id,
          handlers: item.crons.length > 0 ? ["fetch", "scheduled"] : ["fetch"],
        })),
      );
    const schedules = /^\/accounts\/acct\/workers\/scripts\/([^/]+)\/schedules$/.exec(path)?.[1];
    if (schedules) {
      const item = scripts.get(schedules);
      if (!item)
        return Response.json(
          { success: false, errors: [{ code: 10007, message: "no such script" }] },
          { status: 404 },
        );
      if (method === "PUT")
        item.crons = ((await request.json()) as Array<{ cron: string }>).map((entry) => entry.cron);
      return ok({ schedules: item.crons.map((cron) => ({ cron })) });
    }
    const deployed = /^\/accounts\/acct\/workers\/scripts\/([^/]+)\/deployments$/.exec(path)?.[1];
    if (deployed && method === "POST") {
      const body = (await request.json()) as { versions: Array<{ version_id: string }> };
      if (state.refuseRollbacks.includes(deployed))
        return refuse("a Durable Object class changed since that version");
      rollbacks.push({ script: deployed, version: body.versions[0]?.version_id ?? "" });
      return ok({});
    }
    if (deployed) return ok({ deployments: [{ versions: [{ version_id: `version-${uploads.length}` }] }] });
    // K-1129: each file of the manifest goes up in one bucket, with the session token; the last part ends it.
    if (path.endsWith("/assets-upload-session") && method === "POST") {
      const body = (await request.json()) as { manifest: Record<string, { hash: string }> };
      return ok({ jwt: "session", buckets: [Object.values(body.manifest).map((file) => file.hash)] });
    }
    if (path === "/accounts/acct/workers/assets/upload" && method === "POST") {
      if (request.headers.get("authorization") !== "Bearer session") return refuse("not the session token");
      assets.push(...(await request.formData()).keys());
      return ok({ jwt: "done" });
    }
    if (path.startsWith("/accounts/acct/workers/scripts/")) return ok({});
    if (path === "/accounts/acct/workers/domains") {
      if (method === "GET")
        return ok(
          domains.filter(
            (item) =>
              item.hostname === url.searchParams.get("hostname") ||
              item.service === url.searchParams.get("service"),
          ),
        );
      if (state.failDomains > 0) {
        state.failDomains--;
        return refuse("the custom domain failed");
      }
      const body = (await request.json()) as { hostname: string; service: string };
      // Like Cloudflare, an attach of a hostname replaces the custom domain that it had.
      const known = domains.findIndex((item) => item.hostname === body.hostname);
      if (known >= 0) domains.splice(known, 1);
      domains.push({ id: `d${next++}`, hostname: body.hostname, service: body.service });
      return ok({});
    }
    if (path.startsWith("/accounts/acct/workers/domains/") && method === "DELETE") {
      const index = domains.findIndex((item) => item.id === path.split("/").at(-1));
      if (index >= 0) domains.splice(index, 1);
      return ok({});
    }
    if (path.startsWith("/accounts/acct/storage/kv/namespaces/") && method === "DELETE")
      await state.onDelete?.();
    // Every other call: a collection of objects with ids, such as Access applications, policies and KV namespaces.
    const parts = path.split("/");
    const last = parts.at(-1) ?? "";
    const items = collection(path);
    if (method === "GET" && collections.has(path)) return ok([...items.values()]);
    const parent = collection(parts.slice(0, -1).join("/"));
    if (method === "GET") return ok(parent.get(last) ?? []);
    if (method === "POST" && !parent.has(last)) {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const id = `id${next++}`;
      const item = { ...body, id, aud: `aud-${id}` };
      items.set(id, item);
      return ok(item);
    }
    if (method === "PUT") {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      parent.set(last, { ...parent.get(last), ...body, id: last });
      return ok(parent.get(last));
    }
    if (method === "DELETE") parent.delete(last);
    return ok({});
  });
  const served = (hostname: string) =>
    domains.filter((item) => item.hostname === hostname).map((item) => item.service);
  /** Deletes a KV namespace behind kitshn's back, as a restart in the middle of an orphan delete can leave it. */
  const dropKv = (id: string) => collection("/accounts/acct/storage/kv/namespaces").delete(id);
  /** The Access applications in the account, by id. */
  const accessApps = collection("/accounts/acct/access/apps");
  return { uploads, assets, state, scripts, served, dropKv, rollbacks, accessApps };
}

/** One repo of the test, so each test has its own cards. */
function repo(id: string, name: string) {
  const card = environmentNames(id, `owner/${name}`, "prod").resourceId;
  /** The workflow run and the commit that the next token names. */
  const run = {
    id: "100",
    sha: "0123456789abcdef",
    actor: "owner",
    event: "push",
    ref: "refs/heads/main",
    headRef: "",
  };
  const token = () =>
    new SignJWT({
      repository: `owner/${name}`,
      repository_id: id,
      repository_owner_id: "1",
      sha: run.sha,
      run_id: run.id,
      run_attempt: "1",
      event_name: run.event,
      ref: run.ref,
      head_ref: run.headRef,
      actor: run.actor,
    })
      .setProtectedHeader({ alg: "RS256", kid: "gh" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience("https://kit.example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(github.privateKey);
  return { id, name, card, script: `kitshn-${card}`, address: `${name}.example.com`, token, run };
}

async function call(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://kit.example.com${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const step = async (app: ReturnType<typeof repo>, path: string, body: unknown) =>
  call(path, "POST", { authorization: `Bearer ${await app.token()}` }, body);

const ownerHeaders = async () => ({
  "cf-access-jwt-assertion": await new SignJWT({ email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "team" })
    .setIssuer("https://team.example.com")
    .setAudience("admin-aud")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(team.privateKey),
  origin: "https://kit.example.com",
});

/** A request of the owner to the admin API, with an Access token. */
const admin = async (path: string, method: string, body?: unknown) =>
  call(path, method, await ownerHeaders(), body);

/** K-1129: one part of an owner's folder upload, as the browser sends it. */
const ownerPart = async (deployId: string, files: Record<string, string>) => {
  const form = new FormData();
  for (const [hash, text] of Object.entries(files)) form.set(hash, btoa(text));
  const body = new Response(form);
  const bytes = await body.arrayBuffer();
  const request = new Request<unknown, IncomingRequestCfProperties>(
    "https://kit.example.com/api/sites/upload",
    {
      method: "POST",
      headers: {
        ...(await ownerHeaders()),
        "x-kitshn-deploy": deployId,
        "content-type": body.headers.get("content-type") ?? "",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    },
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const recipe = (worker: Record<string, unknown> = {}, name = "prod", needs?: ReadonlyArray<string>) => ({
  ...(needs ? { needs: { apps: needs } } : {}),
  worker: {
    main: "worker.js",
    compatibilityDate: "2026-10-01",
    durableObjects: { ROOMS: "Room" },
    ...worker,
  },
  deploy: [{ on: "push", branch: "main", name, startsIn: "Everyone" }],
});

async function allow(app: ReturnType<typeof repo>) {
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
    durable.storage.sql.exec(
      "INSERT INTO repos (repo_id, name, state, first_seen) VALUES (?, ?, 'allowed', 0)",
      app.id,
      `owner/${app.name}`,
    );
  });
}

/** One deploy from the plan to the finish. The Access sync has a budget per step, so a 503 finish runs again. */
async function deploy(
  app: ReturnType<typeof repo>,
  worker: Record<string, unknown> = {},
  key?: string,
  needs?: ReadonlyArray<string>,
) {
  const plan = await step(app, "/deploy/plan", {
    recipe: recipe(worker, "prod", needs),
    event: {},
    ...(key ? { key } : {}),
  });
  const deployId = plan.body["deployId"];
  expect(deployId, JSON.stringify(plan.body)).toEqual(expect.any(String));
  const storage = await step(app, "/deploy/storage", { deployId });
  if (storage.status !== 200) return storage;
  for (let attempt = 0; attempt < 10; attempt++) {
    const finish = await step(app, "/deploy/finish", {
      deployId,
      module: "export class Room {} export default {};",
    });
    if (finish.status !== 503) return finish;
  }
  throw new Error("The Access applications never became ready.");
}

const storageRows = (card: string) =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
    durable.storage.sql
      .exec("SELECT kind, name FROM worker_storage WHERE card_id = ? ORDER BY kind", card)
      .toArray(),
  );

/** K-538: the action that a card shows: its name, step labels, the step that runs and how it ended. */
const shown = (card: string) =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) => {
    const row = (instance as unknown as { progressRows(): Map<string, { progress: ActionProgress }> })
      .progressRows()
      .get(card)?.progress;
    return row
      ? {
          action: row.action,
          steps: row.steps.map((step) => step.label),
          step: currentStep(row),
          outcome: row.outcome.state,
          reason: row.outcome.state === "failed" ? row.outcome.reason : null,
          retry: row.retry?.reason ?? null,
        }
      : null;
  });

afterEach(() => vi.restoreAllMocks());

describe("Worker deploys (K-806, K-909)", () => {
  it("shows the steps of a deploy onto its card, a 503 as a retry, and a failed step with its reason (K-538)", async () => {
    fakeCloudflare();
    const app = repo("91", "steps");
    await allow(app);
    expect((await deploy(app)).status).toBe(200);
    const plan = await step(app, "/deploy/plan", { recipe: recipe(), event: {} });
    const deployId = plan.body["deployId"];
    expect(await shown(app.card)).toEqual({
      action: "Deploy",
      steps: ["Build in GitHub Actions", "Make the KV namespaces", "Make the new version live"],
      step: 0,
      outcome: "running",
      reason: null,
      retry: null,
    });
    expect((await step(app, "/deploy/storage", { deployId })).status).toBe(200);
    expect(await shown(app.card)).toMatchObject({ step: 1, outcome: "running" });
    const module = "export class Room {} export default {};";
    let finish = await step(app, "/deploy/finish", { deployId, module });
    // The Access application of a new address is not ready yet: the step waits, and the next call goes on.
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++) {
      expect(await shown(app.card)).toMatchObject({ step: 2, outcome: "running", retry: expect.any(String) });
      finish = await step(app, "/deploy/finish", { deployId, module });
    }
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    expect(await shown(app.card)).toMatchObject({ step: 3, outcome: "done", retry: null });
    // The CLI gives up after the KV step and says why.
    const third = (await step(app, "/deploy/plan", { recipe: recipe(), event: {} })).body["deployId"];
    await step(app, "/deploy/storage", { deployId: third });
    await step(app, "/deploy/fail", { deployId: third, reason: "The build failed." });
    expect(await shown(app.card)).toMatchObject({ step: 1, outcome: "failed", reason: "The build failed." });
    // A runner that dies says nothing: a map update reads no deploy row, and the alarm ends the action at its expiry.
    const dead = (await step(app, "/deploy/plan", { recipe: recipe(), event: {} })).body["deployId"];
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance, durable) => {
      durable.storage.sql.exec("UPDATE deploys SET expires_at = 0 WHERE id = ?", String(dead));
      (instance as unknown as { broadcast(): void }).broadcast();
    });
    expect(await shown(app.card)).toMatchObject({ step: 0, outcome: "running" });
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) => instance.alarm());
    expect(await shown(app.card)).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/expired/),
    });
  });

  it("deploys again after a step that failed after the upload", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("42", "rooms");
    await allow(app);
    cloudflare.state.failDomains = 1;
    expect((await deploy(app)).status).toBe(502);
    expect(cloudflare.uploads).toHaveLength(1);
    const second = await deploy(app);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(cloudflare.uploads[1]?.["exports"]).toEqual({
      Room: { type: "durable-object", storage: "sqlite" },
    });
    expect(cloudflare.uploads[1]).not.toHaveProperty("migrations");
  });

  it("turns the crons off on Remove app, keeps the script, and Undo brings addresses and crons back", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("43", "clock");
    await allow(app);
    expect((await deploy(app, { crons: ["*/30 * * * *"], kv: ["DATA"] })).status).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([app.script]);
    const removed = await admin(`/api/apps/${app.card}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([]);
    expect(cloudflare.scripts.get(app.script)?.crons).toEqual([]);
    const undone = await admin("/api/undo", "POST", { revision: removed.body["revision"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([app.script]);
    expect(cloudflare.scripts.get(app.script)?.crons).toEqual(["*/30 * * * *"]);
  });

  it("keeps a pre-existing reserved address but does not let Undo reclaim it after removal", async () => {
    fakeCloudflare();
    const app = repo("4301", "legacy-link-address");
    await allow(app);
    expect((await deploy(app)).status).toBe(200);
    const reserved = "kitshn-link-mac.example.com";
    const stub = env.KITSHN.getByName("kitshn");
    // Simulate a site that already had this name before the namespace was reserved.
    await runInDurableObject(stub, (_, durable) => {
      const row = durable.storage.sql
        .exec<{ body: string }>("SELECT body FROM resources WHERE id = ?", app.card)
        .one();
      const card = JSON.parse(row.body) as Resource;
      durable.storage.sql.exec(
        "UPDATE resources SET body = ? WHERE id = ?",
        JSON.stringify({ ...card, addresses: [reserved] }),
        app.card,
      );
    });
    await evictDurableObject(stub);
    const removed = await admin(`/api/apps/${app.card}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const undone = await admin("/api/undo", "POST", { revision: removed.body["revision"] });
    expect(undone.status).toBe(409);
    expect(String(undone.body["error"])).toContain("reserved for a kitshn machine link");
  });

  it("removes an app whose first upload failed, so it has no script", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("46", "broken");
    await allow(app);
    cloudflare.state.failUploads = 1;
    expect((await deploy(app)).status).toBe(502);
    expect(cloudflare.scripts.has(app.script)).toBe(false);
    // K-1908: a failed deploy keeps no notify token.
    const tokens = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, state) =>
      state.storage.sql.exec("SELECT hash FROM notify_tokens WHERE card_id = ?", app.card).toArray(),
    );
    expect(tokens).toEqual([]);
    const removed = await admin(`/api/apps/${app.card}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await storageRows(app.card)).toEqual([]);
  });

  it("makes a KV namespace again when its row points to one that is gone", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("47", "notes");
    await allow(app);
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    const bound = (index: number) => {
      const bindings = cloudflare.uploads[index]?.["bindings"] as Array<Record<string, string>> | undefined;
      if (!bindings) throw new Error(`There is no upload ${index}.`);
      return bindings.find((item) => item["name"] === "DATA")?.["namespace_id"];
    };
    const first = bound(0);
    cloudflare.dropKv(first ?? "");
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    expect(bound(1)).toEqual(expect.any(String));
    expect(bound(1)).not.toBe(first);
    // K-1908: each deploy gives the app the notify address and a new token; the older token still works (rollback).
    const notify = (index: number) => {
      const bindings = cloudflare.uploads[index]?.["bindings"] as Array<Record<string, string>> | undefined;
      const text = (name: string) => bindings?.find((item) => item["name"] === name)?.["text"];
      return { url: text("KITSHN_NOTIFY_URL"), token: text("KITSHN_NOTIFY_TOKEN") ?? "" };
    };
    expect(notify(0).url).toBe("https://kit.example.com/notify");
    expect(notify(1).token).not.toBe(notify(0).token);
    const sent = await call(
      "/notify",
      "POST",
      { authorization: `Bearer ${notify(0).token}` },
      { title: "Backup done" },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await call("/notify", "POST", { authorization: "Bearer wrong" }, { title: "x" })).status).toBe(
      401,
    );
  });

  it("deletes orphaned storage only while no deploy runs, and refuses a deploy that starts during the delete", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("44", "vault");
    await allow(app);
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    expect((await admin(`/api/apps/${app.card}`, "DELETE")).status).toBe(200);
    // A deploy that is planned and not finished keeps the storage.
    const planned = await step(app, "/deploy/plan", { recipe: recipe({ kv: ["DATA"] }), event: {} });
    expect((await admin(`/api/worker-storage/${app.card}`, "DELETE")).status).toBe(409);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec("UPDATE deploys SET expires_at = 0 WHERE id = ?", planned.body["deployId"]);
    });
    const during: Array<number> = [];
    cloudflare.state.onDelete = async () => {
      during.push((await step(app, "/deploy/plan", { recipe: recipe({ kv: ["DATA"] }), event: {} })).status);
    };
    const deleted = await admin(`/api/worker-storage/${app.card}`, "DELETE");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body["deleted"]).toEqual([
      `the Worker ${app.script} with its Durable Objects`,
      "the KV DATA",
    ]);
    expect(during).toEqual([409, 409]);
    expect(await storageRows(app.card)).toEqual([]);
    expect(cloudflare.scripts.has(app.script)).toBe(false);
  });

  it("refuses crons that would take the account over 5 before the upload", async () => {
    const cloudflare = fakeCloudflare({ "someone-else": 4 });
    const app = repo("45", "ticker");
    await allow(app);
    const refused = await deploy(app, { crons: ["0 * * * *", "30 * * * *"] });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toMatch(/run 4 crons/);
    expect(cloudflare.uploads).toHaveLength(0);
    expect((await deploy(app, { crons: ["0 * * * *"] })).status).toBe(200);
  });
});

describe("several apps per repo (K-804, K-820)", () => {
  const plan = (app: ReturnType<typeof repo>, body: Record<string, unknown>) =>
    step(app, "/deploy/plan", { recipe: recipe(), event: {}, ...body });
  const state = async () =>
    (await admin("/api/state", "GET")).body as {
      resources: Array<{ id: string; name: string }>;
      deployNotes: Record<string, { state: string; reason: string }>;
    };

  it("refuses a card of another app of the repo, and a key that is not a plain name", async () => {
    fakeCloudflare();
    const app = repo("50", "multi");
    await allow(app);
    // The app `app` with the environment cv-prod and the app `cv` with prod make the same card id.
    expect((await step(app, "/deploy/plan", { recipe: recipe({}, "cv-prod"), event: {} })).status).toBe(200);
    const clash = await plan(app, { key: "cv" });
    expect(clash.status).toBe(409);
    expect(String(clash.body["error"])).toMatch(/belongs to another app \(app\)/);
    expect((await plan(app, { key: "Bad-Key" })).status).toBe(400);
  });

  it("makes a push of the kitshn App wait for a deploy ask (K-1767)", async () => {
    fakeCloudflare();
    const app = repo("1767", "bot-push");
    await allow(app);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
      durable.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('github_app_bot', 'kitshn-test[bot]')",
      ),
    );
    app.run.actor = "kitshn-test[bot]";
    const waits = await step(app, "/deploy/plan", { recipe: recipe(), event: {} });
    expect(waits.status).toBe(409);
    expect(String(waits.body["error"])).toMatch(/waits for a deploy ask/);
    // A pull request of the App waits for the owner's Deploy of its run's commit; that commit then deploys.
    app.run.event = "pull_request";
    app.run.ref = "refs/pull/7/merge";
    app.run.headRef = "agent-branch";
    const prRun = {
      recipe: { ...recipe(), deploy: [{ on: "pull_request", name: "pr-{pr}", ephemeral: true }] },
      event: { action: "opened" },
    };
    const waitsPr = await step(app, "/deploy/plan", prRun);
    expect(waitsPr.status).toBe(409);
    expect(String(waitsPr.body["error"])).toMatch(/waits for a deploy click/);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
      durable.storage.sql.exec("UPDATE bot_runs SET approved = 1 WHERE repo_id = '1767' AND pr = 7"),
    );
    expect((await step(app, "/deploy/plan", prRun)).status).not.toBe(409);
    app.run.event = "push";
    app.run.ref = "refs/heads/main";
    // Another bot, such as Dependabot, deploys as before.
    app.run.actor = "dependabot[bot]";
    expect((await step(app, "/deploy/plan", { recipe: recipe(), event: {} })).status).toBe(200);
    // With an App whose bot name GitHub does not give, every bot run waits, because it can be the App's.
    const withApp = (on: boolean) =>
      runInDurableObject(env.KITSHN.getByName("kitshn"), (instance, durable) => {
        const own = (instance as unknown as { env: Record<string, string | undefined> }).env;
        own["GITHUB_APP_ID"] = on ? "1" : undefined;
        own["GITHUB_APP_KEY"] = on ? "not a key" : undefined;
        durable.storage.sql.exec("DELETE FROM meta WHERE key = 'github_app_bot'");
      });
    await withApp(true);
    try {
      const unknown = await step(app, "/deploy/plan", { recipe: recipe(), event: {} });
      expect(unknown.status).toBe(409);
      expect(String(unknown.body["error"])).toMatch(/cannot read the bot name/);
    } finally {
      await withApp(false);
    }
  });

  it("refuses an admin host as the main or an extra address, also the old host during the move (K-817, K-1209)", async () => {
    fakeCloudflare();
    const app = repo("1209", "hosts");
    await allow(app);
    const withAddress = (address: string | ReadonlyArray<string>) => {
      const body = recipe();
      return step(app, "/deploy/plan", {
        recipe: { ...body, deploy: [{ ...body.deploy[0], address }] },
        event: {},
      });
    };
    for (const address of ["old.example.com", ["hosts.example.com", "old.example.com"]]) {
      const refused = await withAddress(address);
      expect(refused.status).toBe(409);
      expect(String(refused.body["error"])).toMatch(/old\.example\.com is the kitshn admin host/);
    }
  });

  it("names the card with its key, and shows a skipped and a failed deploy on it", async () => {
    fakeCloudflare();
    const app = repo("51", "shop");
    await allow(app);
    expect((await deploy(app, {}, "cv")).status).toBe(200);
    const card = environmentNames(app.id, `owner/${app.name}`, "prod", "cv").resourceId;
    expect((await state()).resources.find((item) => item.id === card)?.name).toBe("shop-cv");
    const skipped = await plan(app, {
      key: "cv",
      skip: "not deployed, because it needs api, which did not deploy (K-820).",
    });
    expect(skipped.body["plan"]).toMatchObject({ kind: "skip" });
    expect((await state()).deployNotes[card]).toEqual({
      state: "skipped",
      reason: "not deployed, because it needs api, which did not deploy (K-820).",
    });
    const planned = await plan(app, { key: "cv" });
    expect(
      (await step(app, "/deploy/fail", { deployId: planned.body["deployId"], reason: "the build failed." }))
        .status,
    ).toBe(200);
    expect((await state()).deployNotes[card]).toEqual({ state: "failed", reason: "the build failed." });
  });

  it("keeps a running deploy running when the CLI gives up, so its machine result still lands", async () => {
    fakeCloudflare();
    const app = repo("52", "slow");
    await allow(app);
    const planned = await plan(app, {});
    const deployId = String(planned.body["deployId"]);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec(
        "UPDATE deploys SET state = 'running', app = 'compose' WHERE id = ?",
        deployId,
      );
    });
    expect(
      (await step(app, "/deploy/fail", { deployId, reason: "the deploy did not end within 38 minutes." }))
        .status,
    ).toBe(200);
    const row = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
      durable.storage.sql.exec("SELECT state, reason FROM deploys WHERE id = ?", deployId).one(),
    );
    expect(row).toEqual({ state: "running", reason: "the deploy did not end within 38 minutes." });
  });
});

describe("DNS records at plan time (K-817, K-901)", () => {
  type Run = { card: string; addresses: Array<string>; machineId: string | null; expiresAt: number };
  // The alarm may sync DNS between the steps of this test, so it reads the deploys memo, which the alarm never writes;
  // live.test.ts checks which records those runs want.
  const runs = () =>
    runInDurableObject(
      env.KITSHN.getByName("kitshn"),
      (instance) => (instance as unknown as { deploys(): { composeRuns: Array<Run> } }).deploys().composeRuns,
    );

  it("counts a planned Compose deploy for the DNS of its address, and no failed one", async () => {
    fakeCloudflare();
    const app = repo("97", "early");
    await allow(app);
    const planned = await step(app, "/deploy/plan", { recipe: recipe(), event: {} });
    const deployId = String(planned.body["deployId"]);
    const stub = env.KITSHN.getByName("kitshn");
    await runInDurableObject(stub, (_instance, durable) =>
      durable.storage.sql.exec(
        "UPDATE deploys SET app = 'compose', machine_id = 'm-97' WHERE id = ?",
        deployId,
      ),
    );
    // The Durable Object reads the deploy rows again when it starts.
    await evictDurableObject(stub);
    expect(await runs()).toContainEqual(
      expect.objectContaining({ card: app.card, addresses: [app.address], machineId: "m-97" }),
    );
    expect((await step(app, "/deploy/fail", { deployId, reason: "the build failed." })).status).toBe(200);
    expect((await runs()).map((run) => run.card)).not.toContain(app.card);
  });
});

describe("rollback (K-821)", () => {
  type Choice = { deployId: string; sha: string; why: string | null };
  const choices = async (card: string) =>
    ((await admin(`/api/apps/${card}/rollbacks`, "GET")).body["choices"] ?? []) as Array<Choice>;

  it("serves an earlier Cloudflare version again, and the card then counts it as its current deploy", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("60", "board");
    await allow(app);
    app.run.sha = "1111111aaaaaaa";
    expect((await deploy(app)).status).toBe(200);
    app.run.sha = "2222222bbbbbbb";
    app.run.id = "101";
    expect((await deploy(app)).status).toBe(200);
    const [current, before] = await choices(app.card);
    expect(current?.sha).toBe("2222222bbbbbbb");
    expect(before).toMatchObject({ sha: "1111111aaaaaaa", why: null });
    const rolled = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect(String(rolled.body["note"])).toMatch(/data did not roll back/);
    expect(cloudflare.rollbacks).toEqual([{ script: app.script, version: "version-1" }]);
    expect((await choices(app.card))[0]?.sha).toBe("1111111aaaaaaa");
  });

  it("shows the refusal of Cloudflare and changes nothing", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("61", "rooms2");
    await allow(app);
    expect((await deploy(app)).status).toBe(200);
    app.run.id = "101";
    expect((await deploy(app)).status).toBe(200);
    cloudflare.state.refuseRollbacks = [app.script];
    const before = (await choices(app.card))[1];
    const refused = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toMatch(/Durable Object class changed/);
    expect((await choices(app.card))[0]?.deployId).not.toBe(before?.deployId);
  });

  it("rolls a run back app by app, each before the apps that it needs, and stops at the first refusal", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("62", "pair");
    const cv = { ...app, card: environmentNames("62", "owner/pair", "prod", "cv").resourceId };
    await allow(app);
    for (const run of ["100", "101"]) {
      app.run.id = run;
      expect((await deploy(app, {}, "app")).status).toBe(200);
      expect((await deploy(app, {}, "cv", ["app"])).status).toBe(200);
    }
    const plan = await admin(`/api/apps/${app.card}/run-rollback`, "GET");
    expect((plan.body["steps"] as Array<{ card: string }>).map((step) => step.card)).toEqual([
      cv.card,
      app.card,
    ]);
    cloudflare.state.refuseRollbacks = [`kitshn-${app.card}`];
    const result = await admin(`/api/apps/${app.card}/run-rollback`, "POST");
    expect(result.body["state"]).toBe("failed");
    expect(cloudflare.rollbacks.map((item) => item.script)).toEqual([`kitshn-${cv.card}`]);
    expect((result.body["notes"] as Array<string>).at(-1)).toMatch(/stopped here/);
    // K-538: the card where it started shows one step per card, and the step that failed.
    expect(await shown(app.card)).toMatchObject({
      action: "Roll back this run",
      steps: [expect.any(String), expect.any(String)],
      step: 1,
      outcome: "failed",
      reason: expect.stringMatching(/stopped here/),
    });
  });

  /**
   * A Compose card on machine `machineId` with two finished deploys of runs 100 and 101, and an open daemon socket
   * that can roll back. `result` answers the newest job; `commands` lists the rollback jobs in order.
   */
  const IMAGE = `sha256:${"a".repeat(64)}`;

  async function composeApp(id: string, name: string, keys: ReadonlyArray<string> = ["app"]) {
    const cloudflare = fakeCloudflare();
    const app = repo(id, name);
    const machineId = `m-${id}`;
    const stub = env.KITSHN.getByName("kitshn");
    const cardOf = (key: string) => environmentNames(id, `owner/${name}`, "prod", key).resourceId;
    await allow(app);
    await runInDurableObject(stub, (_instance, durable) => {
      const sql = durable.storage.sql;
      const machine: Machine = {
        id: machineId,
        name: machineId,
        labels: ["deploy"],
        order: 0,
        serviceTokenId: `token-${machineId}`,
        clientId: `${machineId}.access`,
        tunnelId: `tunnel-${machineId}`,
      };
      sql.exec("INSERT INTO machines (id, body) VALUES (?, ?)", machineId, JSON.stringify(machine));
      for (const key of keys) {
        const card = cardOf(key);
        const resource: Resource = {
          id: card,
          kind: "site.compose",
          name: `${name}-${key}`,
          addresses: [`${key}.${app.address}`],
          status: "running",
          group: null,
          machine: machineId,
        };
        sql.exec("INSERT INTO resources (id, body) VALUES (?, ?)", card, JSON.stringify(resource));
        sql.exec("INSERT INTO places (id, x, y) VALUES (?, 0, 0)", card);
        for (const [index, run] of ["100", "101"].entries())
          sql.exec(
            `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, kind, sha, state, expires_at,
               app, machine_id, compose_file, images, run_id, run_attempt, app_key)
             VALUES (?, ?, ?, 'prod', ?, ?, '', 'deploy', ?, 'done', ?, 'compose', ?, 'compose.yml', ?, ?, '1', ?)`,
            key === "app" ? `d${index + 1}-${id}` : `d${index + 1}-${id}-${key}`,
            `owner/${name}`,
            id,
            card,
            `${key}.${app.address}`,
            `${index + 1}`.repeat(14),
            1000 + index,
            machineId,
            JSON.stringify({ web: IMAGE }),
            run,
            key,
          );
      }
    });
    // The Durable Object reads machines and cards again when it starts.
    await evictDurableObject(stub);
    const status: MachineStatus = {
      version: "0123456789ab",
      os: "linux",
      arch: "x64",
      hostname: machineId,
      tunnel: "running",
      capabilities: ["compose-rollback"],
    };
    /** What the daemon received. */
    const received: Array<{ type: string; access?: unknown }> = [];
    /** The daemon connects. Sockets belong to the Durable Object that made them, so the pair comes from inside it. */
    const open = () =>
      runInDurableObject(stub, (_instance, durable) => {
        const pair = new WebSocketPair();
        durable.acceptWebSocket(pair[1], [machineId, "machines"]);
        pair[0].accept();
        pair[0].addEventListener("message", (event) => {
          received.push(JSON.parse(String(event.data)));
        });
        pair[1].serializeAttachment({
          kind: "machine",
          machineId,
          // The alarm closes a socket without a ping for 30 seconds.
          since: Date.now(),
          challenge: "",
          check: "signed",
          answered: true,
          rotateBy: null,
          status,
          sample: null,
        });
        return pair[1];
      });
    let socket = await open();
    const jobs = () =>
      runInDurableObject(stub, (_instance, durable) =>
        durable.storage.sql
          .exec<{ id: number; command: string }>(
            "SELECT id, command FROM jobs WHERE json_extract(command, '$.kind') = 'compose-rollback' AND machine_id = ? ORDER BY id",
            machineId,
          )
          .toArray(),
      );
    const result = async (ok: boolean) => {
      const job = (await jobs()).at(-1);
      if (!job) throw new Error("no rollback job");
      await runInDurableObject(stub, (instance) =>
        instance.webSocketMessage(
          socket,
          JSON.stringify({
            type: "jobResult",
            id: job.id,
            result: ok
              ? { ok: true, exitCode: 0, output: "", images: { web: IMAGE } }
              : { ok: false, exitCode: 1, output: "[kitshn: docker compose up failed]" },
          }),
        ),
      );
    };
    const commands = async () =>
      (await jobs()).map((job) => (JSON.parse(job.command) as { deployId: string }).deployId);
    /** The daemon goes offline. `evictDurableObject` waits while any socket is open, so each test closes its own. */
    const close = () =>
      runInDurableObject(stub, async (instance) => {
        socket.close(1001, "gone");
        await instance.webSocketClose(socket);
      });
    const reconnect = async () => {
      socket = await open();
    };
    return { app, stub, cardOf, result, commands, close, reconnect, received, cloudflare };
  }

  it("rolls a Compose card back, forward and back again, each time to the build that its machine keeps", async () => {
    const { app, stub, result, commands, close, received, cloudflare } = await composeApp("63", "compose-a");
    const d1 = "d1-63";
    const d2 = "d2-63";
    const back = async () => {
      const before = (await choices(app.card))[1];
      expect(before?.why ?? null).toBeNull();
      const rolled = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
      expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
      expect(String(rolled.body["note"])).toMatch(/params of that deploy/);
      // K-821: while the rollback runs, the card takes no second one.
      const again = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
      expect(String(again.body["error"])).toMatch(/runs now/);
      await result(true);
    };
    /** K-822: the audience of the card's Access application in Cloudflare. */
    const audience = (aud: string) =>
      runInDurableObject(stub, (instance, durable) => {
        cloudflare.accessApps.set("cf-app", { id: "cf-app", aud });
        durable.storage.sql.exec(
          "INSERT OR REPLACE INTO access_objects (key, cf_id, aud, body, tried, error) VALUES (?, 'cf-app', ?, '{}', '', NULL)",
          `app:${app.card}:app.${app.address}`,
          aud,
        );
        (instance as unknown as { accessCache: unknown }).accessCache = null;
      });
    await audience("aud-old");
    await back();
    // kitshn made the application again. The next rollback gets its new audience, not the one of that deploy.
    await audience("aud-new");
    await back();
    await back();
    expect(received.filter((message) => message.type === "job").map((message) => message.access)).toEqual([
      { teamDomain: env.ACCESS_TEAM_DOMAIN, audiences: ["aud-old"] },
      { teamDomain: env.ACCESS_TEAM_DOMAIN, audiences: ["aud-new"] },
      { teamDomain: env.ACCESS_TEAM_DOMAIN, audiences: ["aud-new"] },
    ]);
    // The daemon keeps builds by the deploy that built them, so the third job names d1 again, not a rollback row.
    expect(await commands()).toEqual([d1, d2, d1]);
    expect((await choices(app.card))[0]?.sha).toBe("11111111111111");
    await close();
  });

  it("goes on with a run rollback after a job result, stops at a failed job, and waits for a machine that was offline", async () => {
    const { app, stub, cardOf, result, close, reconnect } = await composeApp("64", "compose-b", [
      "app",
      "cv",
    ]);
    const rollbackRow = () =>
      runInDurableObject(stub, (_instance, durable) =>
        durable.storage.sql
          .exec<{ state: string; notes: string }>(
            "SELECT state, notes FROM rollbacks ORDER BY rowid DESC LIMIT 1",
          )
          .one(),
      );
    /** A failed or settled step leaves its rollback row running until it expires; the next run rollback needs it gone. */
    const endRunningRows = () =>
      runInDurableObject(stub, (_instance, durable) =>
        durable.storage.sql.exec("UPDATE deploys SET state = 'failed' WHERE state = 'running'"),
      );
    /** A restart of the Durable Object, which settles the run rollbacks that wait for nothing. */
    const restart = async () => {
      await close();
      await evictDurableObject(stub);
      await choices(app.card);
    };
    const started = await admin(`/api/apps/${app.card}/run-rollback`, "POST");
    expect(started.body["state"]).toBe("running");
    // K-538: the Compose job of the step does not take the card from the run rollback's own action.
    expect(await shown(app.card)).toMatchObject({ action: "Roll back this run", outcome: "running" });
    // A second run rollback of the same cards waits until the first ends.
    expect((await admin(`/api/apps/${app.card}/run-rollback`, "POST")).status).toBe(409);
    await result(false);
    expect(await rollbackRow()).toMatchObject({ state: "failed" });
    expect(JSON.parse((await rollbackRow()).notes).at(-1)).toMatch(/stopped here/);
    expect(await shown(app.card)).toMatchObject({
      outcome: "failed",
      reason: expect.stringMatching(/stopped here/),
    });

    // The machine goes offline and its job expires with no result: the run rollback stops.
    await endRunningRows();
    expect((await admin(`/api/apps/${app.card}/run-rollback`, "POST")).body["state"]).toBe("running");
    await close();
    await runInDurableObject(stub, (_instance, durable) =>
      durable.storage.sql.exec("UPDATE jobs SET expires_at = 0 WHERE state = 'failed'"),
    );
    await evictDurableObject(stub);
    await choices(app.card);
    expect(await rollbackRow()).toMatchObject({ state: "failed" });
    expect(JSON.parse((await rollbackRow()).notes).at(-1)).toMatch(/no result/);

    // A short drop: the job failed only because the machine went offline, so the run rollback waits. The late result
    // of the reconnected machine goes on, and the next card rolls back too.
    await endRunningRows();
    await reconnect();
    expect((await admin(`/api/apps/${app.card}/run-rollback`, "POST")).body["state"]).toBe("running");
    await restart();
    expect(await rollbackRow()).toMatchObject({ state: "running" });
    await reconnect();
    await result(true);
    await result(true);
    expect(await rollbackRow()).toMatchObject({ state: "done" });
    expect(await shown(app.card)).toMatchObject({ action: "Roll back this run", outcome: "done" });
    for (const key of ["app", "cv"]) expect((await choices(cardOf(key)))[0]?.sha).toBe("11111111111111");
    await close();
  });
});

/** An agent key's call, with the Access token of its service token. */
const agentStep = async (clientId: string, path: string, body: unknown) =>
  call(
    path,
    "POST",
    {
      "cf-access-jwt-assertion": await new SignJWT({ common_name: clientId })
        .setProtectedHeader({ alg: "RS256", kid: "team" })
        .setIssuer("https://team.example.com")
        .setAudience("agent-aud")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(team.privateKey),
    },
    body,
  );

const agentCircle = (id: string, clientId: string, addsApps: boolean) => ({
  id,
  name: id,
  color: "#7c3aed",
  level: "control",
  members: [{ _tag: "device", tokenId: `t-${id}`, clientId, name: id, ...(addsApps ? { addsApps } : {}) }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: id === "folders" ? 4000 : 5000,
  y: 4000,
  r: 300,
});

/** The fake Cloudflare of each test starts empty, so the old addresses of an earlier test go too (K-1124). */
const noOldAddresses = () =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
    durable.storage.sql.exec("DELETE FROM old_addresses");
    durable.storage.sql.exec("DELETE FROM meta WHERE key IN ('redirects_map', 'redirects_done')");
  });

describe("folder sites (K-1123)", () => {
  it("publishes a folder with may add apps, keeps its script on Remove app, and Undo brings it back", async () => {
    const cloudflare = fakeCloudflare();
    const edits = [
      { _tag: "circle", id: "folders", after: agentCircle("folders", "folder-key.access", true) },
      { _tag: "circle", id: "plain", after: agentCircle("plain", "plain-key.access", false) },
    ];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    expect((await agentStep("plain-key.access", "/agent/sites/plan", { folder: "demo" })).status).toBe(403);

    const plan = await agentStep("folder-key.access", "/agent/sites/plan", {
      folder: "demo",
      address: "demo-site",
    });
    expect(plan.body, JSON.stringify(plan.body)).toMatchObject({
      address: "demo-site.example.com",
      updated: false,
    });
    const deployId = plan.body["deployId"];
    // While the plan waits for its files, the same folder and the same address are held.
    expect((await agentStep("folder-key.access", "/agent/sites/plan", { folder: "demo" })).status).toBe(409);
    expect(
      (await agentStep("folder-key.access", "/agent/sites/plan", { folder: "other", address: "demo-site" }))
        .status,
    ).toBe(409);
    const manifest = { "/index.html": { hash: "0".repeat(32), size: 5 } };
    expect((await agentStep("folder-key.access", "/agent/sites/assets", { deployId, manifest })).status).toBe(
      200,
    );
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await agentStep("folder-key.access", "/agent/sites/finish", { deployId, jwt: "done" });
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    const state = await admin("/api/state", "GET");
    const card = (state.body["resources"] as Array<{ id: string; name: string }>).find(
      (resource) => resource.name === "demo",
    );
    if (!card) throw new Error("The folder site has no card.");
    const script = `kitshn-${card.id}`;
    expect(cloudflare.served("demo-site.example.com")).toEqual([script]);
    // The same folder again deploys the same card.
    const update = await agentStep("folder-key.access", "/agent/sites/plan", { folder: "demo" });
    expect(update.body).toMatchObject({
      address: "demo-site.example.com",
      updated: true,
    });
    // K-538: a folder site has no build in Actions; its card shows the upload, then the checkmark.
    expect(await shown(card.id)).toMatchObject({
      steps: ["Upload the files to Cloudflare", "Make the new version live"],
      step: 0,
      outcome: "running",
    });
    const updateId = update.body["deployId"];
    await agentStep("folder-key.access", "/agent/sites/assets", { deployId: updateId, manifest });
    expect(
      (await agentStep("folder-key.access", "/agent/sites/finish", { deployId: updateId, jwt: "done" }))
        .status,
    ).toBe(200);
    expect(await shown(card.id)).toMatchObject({ step: 2, outcome: "done" });

    const removed = await admin(`/api/apps/${card.id}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(cloudflare.served("demo-site.example.com")).toEqual([]);
    expect(cloudflare.scripts.has(script)).toBe(true);
    const undone = await admin("/api/undo", "POST", { revision: removed.body["revision"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(cloudflare.served("demo-site.example.com")).toEqual([script]);

    // Removed again, the site counts for nothing: a new publish of the folder is a first publish, with the right.
    const again = await admin(`/api/apps/${card.id}`, "DELETE");
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    // Another site takes the free address; the Undo of the removal then no longer fits, and that site stays.
    const other = await agentStep("folder-key.access", "/agent/sites/plan", {
      folder: "other",
      address: "demo-site",
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const otherId = other.body["deployId"];
    expect(
      (await agentStep("folder-key.access", "/agent/sites/assets", { deployId: otherId, manifest })).status,
    ).toBe(200);
    let otherFinish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && otherFinish.status === 503; attempt++)
      otherFinish = await agentStep("folder-key.access", "/agent/sites/finish", {
        deployId: otherId,
        jwt: "done",
      });
    expect(otherFinish.status, JSON.stringify(otherFinish.body)).toBe(200);
    const served = cloudflare.served("demo-site.example.com");
    const refused = await admin("/api/undo", "POST", { revision: again.body["revision"] });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("is taken");
    expect(cloudflare.served("demo-site.example.com")).toEqual(served);
    const noRight = [
      { _tag: "circle", id: "folders", after: agentCircle("folders", "folder-key.access", false) },
    ];
    expect((await admin("/api/apply", "POST", { edits: noRight })).status).toBe(200);
    expect((await agentStep("folder-key.access", "/agent/sites/plan", { folder: "demo" })).status).toBe(403);
    const right = [
      { _tag: "circle", id: "folders", after: agentCircle("folders", "folder-key.access", true) },
    ];
    expect((await admin("/api/apply", "POST", { edits: right })).status).toBe(200);
    expect(
      (await agentStep("folder-key.access", "/agent/sites/plan", { folder: "demo" })).body,
    ).toMatchObject({
      updated: false,
    });

    // A key has at most 10 folder sites: the new plan holds 1, and 9 live plans fill it. Rows without a card or a
    // live plan count for nothing.
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      for (let index = 0; index < 12; index++) {
        durable.storage.sql.exec(
          `INSERT INTO agent_sites (card_id, client_id, folder, address, created_at)
           VALUES (?, 'folder-key.access', ?, ?, 0)`,
          `folder-fill${index}`,
          `fill${index}`,
          `fill${index}.example.com`,
        );
        if (index < 9)
          durable.storage.sql.exec(
            `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
             VALUES (?, 'folder fill', 'folder', ?, ?, 'kitshn-fill', 'deploy', 'folder', 'planned', ?)`,
            `fill-plan-${index}`,
            `folder-fill${index}`,
            `fill${index}.example.com`,
            Date.now() + 60_000,
          );
      }
    });
    expect((await agentStep("folder-key.access", "/agent/sites/plan", { folder: "one-more" })).status).toBe(
      409,
    );
  });

  it("moves a folder site, and its old address sends visitors on through the redirect Worker (K-1124)", async () => {
    const cloudflare = fakeCloudflare();
    await noOldAddresses();
    const edits = [{ _tag: "circle", id: "folders", after: agentCircle("folders", "move-key.access", true) }];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    const plan = await agentStep("move-key.access", "/agent/sites/plan", {
      folder: "moving",
      address: "first",
    });
    const deployId = plan.body["deployId"];
    expect(
      (
        await agentStep("move-key.access", "/agent/sites/assets", {
          deployId,
          manifest: { "/a.html": { hash: "1".repeat(32), size: 1 } },
        })
      ).status,
    ).toBe(200);
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await agentStep("move-key.access", "/agent/sites/finish", { deployId, jwt: "done" });
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    const state = await admin("/api/state", "GET");
    const card = (state.body["resources"] as Array<{ id: string; name: string }>).find(
      (resource) => resource.name === "moving",
    );
    if (!card) throw new Error("The folder site has no card.");

    let moved = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && moved.status === 503; attempt++)
      moved = await agentStep("move-key.access", "/agent/cards/moving/address", { address: "second" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(cloudflare.served("second.example.com")).toEqual([`kitshn-${card.id}`]);
    expect(cloudflare.served("first.example.com")).toEqual([]);
    const durable = env.KITSHN.getByName("kitshn");
    const alarm = () =>
      runInDurableObject(durable, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
    const redirectWork = () =>
      runInDurableObject(durable, (instance) =>
        (instance as unknown as { redirectWork(): boolean }).redirectWork(),
      );
    // A failed upload waits for its retry time instead of running the alarm again at once.
    // workerd also runs the alarms that kitshn schedules, and every alarm runs the redirect step whatever its back-off
    // says. So the uploads fail for as long as the test needs, and the test reads redirectWork only while they fail.
    cloudflare.state.failUploads = 1000;
    await alarm();
    expect(cloudflare.served("first.example.com")).toEqual([]);
    expect(await redirectWork()).toBe(false);
    cloudflare.state.failUploads = 0;
    // The alarm hands the old address to the redirect Worker, with the map of where it goes.
    await alarm();
    expect(cloudflare.served("first.example.com")).toEqual(["kitshn-redirects"]);
    const bindings = (cloudflare.uploads.at(-1)?.["bindings"] ?? []) as Array<{ name: string; text: string }>;
    const map = bindings.find((binding) => binding.name === "MAP");
    expect(JSON.parse(map?.text ?? "{}")).toEqual({ "first.example.com": "second.example.com" });
    // Another card cannot take the old address while it sends visitors on.
    const taken = await agentStep("move-key.access", "/agent/sites/plan", {
      folder: "other",
      address: "first",
    });
    expect(taken.status).toBe(409);

    // A move back takes the old address off the redirect Worker; the address it leaves becomes the old one.
    const backAgain = await agentStep("move-key.access", "/agent/cards/moving/address", { address: "first" });
    expect(backAgain.status, JSON.stringify(backAgain.body)).toBe(200);
    expect(cloudflare.served("first.example.com")).toEqual([`kitshn-${card.id}`]);
    expect(cloudflare.served("second.example.com")).toEqual([]);
    await alarm();
    expect(cloudflare.served("second.example.com")).toEqual(["kitshn-redirects"]);

    // A failed move puts the redirect addresses of the card back as they were (K-1128).
    const kept = await admin(`/api/cards/${card.id}/redirects`, "POST", { address: "kept.example.com" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    // One alarm has 5 calls for redirects: a new map costs 3, and each new address 2. So each address gets its own
    // alarm here, also when no auto alarm ran in between.
    await alarm();
    expect(cloudflare.served("kept.example.com")).toEqual(["kitshn-redirects"]);
    // A removal in progress stays removed. The alarm first puts the address on the redirect Worker, so the removal
    // changes the map; then the upload of the new map fails, and no alarm takes the domain off yet. Without the
    // attach, a removal that leaves the old map unchanged would skip the upload and drop the row at once.
    expect(
      (await admin(`/api/cards/${card.id}/redirects`, "POST", { address: "gone.example.com" })).status,
    ).toBe(200);
    await alarm();
    expect(cloudflare.served("gone.example.com")).toEqual(["kitshn-redirects"]);
    cloudflare.state.failUploads = 1000;
    expect((await admin(`/api/cards/${card.id}/redirects/gone.example.com`, "DELETE")).status).toBe(200);
    cloudflare.state.failDomains = 1000;
    let failed = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && failed.status === 503; attempt++)
      failed = await agentStep("move-key.access", "/agent/cards/moving/address", { address: "third" });
    expect(failed.status).not.toBe(200);
    cloudflare.state.failDomains = 0;
    expect((await admin("/api/state", "GET")).body["redirects"]).toEqual({ [card.id]: ["kept.example.com"] });
    const going = await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql
        .exec("SELECT going FROM old_addresses WHERE address = 'gone.example.com'")
        .toArray(),
    );
    expect(going).toEqual([{ going: 1 }]);
    cloudflare.state.failUploads = 0;

    // Removed, the site lets its old address go; another site takes it, and the Undo of the removal then refuses.
    const removed = await admin(`/api/apps/${card.id}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    await alarm();
    const other = await agentStep("move-key.access", "/agent/sites/plan", {
      folder: "taker",
      address: "second",
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const otherId = other.body["deployId"];
    const manifest = { "/b.html": { hash: "2".repeat(32), size: 1 } };
    expect(
      (await agentStep("move-key.access", "/agent/sites/assets", { deployId: otherId, manifest })).status,
    ).toBe(200);
    let otherFinish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && otherFinish.status === 503; attempt++)
      otherFinish = await agentStep("move-key.access", "/agent/sites/finish", {
        deployId: otherId,
        jwt: "done",
      });
    expect(otherFinish.status, JSON.stringify(otherFinish.body)).toBe(200);
    const undone = await admin("/api/undo", "POST", { revision: removed.body["revision"] });
    expect(undone.status).toBe(409);
    expect(String(undone.body["error"])).toContain("second.example.com is taken");
  });

  it("moves a Worker app to a new main address, and the old one sends visitors on (K-817, K-1124)", async () => {
    const cloudflare = fakeCloudflare();
    await noOldAddresses();
    const app = repo("70", "mover");
    await allow(app);
    const deployAt = async (address: string) => {
      const plan = await step(app, "/deploy/plan", {
        recipe: {
          ...recipe(),
          deploy: [{ on: "push", branch: "main", name: "prod", startsIn: "Everyone", address }],
        },
        event: {},
      });
      const deployId = plan.body["deployId"];
      expect(deployId, JSON.stringify(plan.body)).toEqual(expect.any(String));
      expect((await step(app, "/deploy/storage", { deployId })).status).toBe(200);
      let finish = { status: 503, body: {} as Record<string, unknown> };
      for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
        finish = await step(app, "/deploy/finish", {
          deployId,
          module: "export class Room {} export default {};",
        });
      return finish;
    };
    expect((await deployAt("mover-one.example.com")).status).toBe(200);
    const second = await deployAt("mover-two.example.com");
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(cloudflare.served("mover-two.example.com")).toEqual([app.script]);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
      (instance as unknown as { alarm(): Promise<void> }).alarm(),
    );
    expect(cloudflare.served("mover-one.example.com")).toEqual(["kitshn-redirects"]);
    // The address comes back: it leaves the redirect Worker and serves the app again.
    expect((await deployAt("mover-one.example.com")).status).toBe(200);
    expect(cloudflare.served("mover-one.example.com")).toEqual([app.script]);
  });
});

describe("owner folder sites (K-1129)", () => {
  it("puts a dropped folder at the drop point and a new version on the same card", async () => {
    const cloudflare = fakeCloudflare();
    const plan = await admin("/api/sites/plan", "POST", { folder: "dropped", x: 7000, y: 7000 });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const { deployId, card, address } = plan.body as { deployId: string; card: string; address: string };
    expect(card.startsWith("folder-")).toBe(true);
    const [page, style] = ["a".repeat(32), "b".repeat(32)];
    const manifest = { "/index.html": { hash: page, size: 4 }, "/style.css": { hash: style, size: 3 } };
    const assets = await admin("/api/sites/assets", "POST", { deployId, manifest });
    expect(assets.status, JSON.stringify(assets.body)).toBe(200);
    // The browser gets the buckets but never the session token.
    expect(assets.body).toEqual({ buckets: [[page, style]] });

    expect((await ownerPart(deployId, { ["c".repeat(32)]: "evil" })).status).toBe(400);
    expect((await ownerPart("no-such-plan", { [page]: "page" })).status).toBe(404);
    expect((await ownerPart(deployId, { [page]: "page", [style]: "css" })).status).toBe(200);
    expect(cloudflare.assets).toEqual([page, style]);

    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await admin("/api/sites/finish", "POST", { deployId });
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    expect(cloudflare.served(address)).toEqual([`kitshn-${card}`]);
    const state = await admin("/api/state", "GET");
    expect((state.body["places"] as Record<string, unknown>)[card]).toEqual({ x: 7000, y: 7000 });

    const again = await admin("/api/sites/plan", "POST", { card });
    expect(again.body).toMatchObject({ card, address, updated: true });
    // Only a folder site takes a new version from a folder.
    expect((await admin("/api/sites/plan", "POST", { card: "no-such-card" })).status).toBe(409);
  });

  it("replaces a key's folder site, and ends an upload that fails or that a repo took over", async () => {
    const cloudflare = fakeCloudflare();
    const edits = [
      { _tag: "circle", id: "folders", after: agentCircle("folders", "owned-key.access", true) },
    ];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    const published = await agentStep("owned-key.access", "/agent/sites/plan", { folder: "keysite" });
    const keyDeploy = published.body["deployId"];
    const manifest = { "/index.html": { hash: "d".repeat(32), size: 4 } };
    expect(
      (await agentStep("owned-key.access", "/agent/sites/assets", { deployId: keyDeploy, manifest })).status,
    ).toBe(200);
    let keyFinish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && keyFinish.status === 503; attempt++)
      keyFinish = await agentStep("owned-key.access", "/agent/sites/finish", {
        deployId: keyDeploy,
        jwt: "done",
      });
    expect(keyFinish.status, JSON.stringify(keyFinish.body)).toBe(200);
    const card = String(published.body["card"]);
    const durable = env.KITSHN.getByName("kitshn");
    const deployState = (id: string) =>
      runInDurableObject(durable, (_instance, storage) =>
        storage.storage.sql.exec("SELECT state FROM deploys WHERE id = ?", id).toArray(),
      );

    // The owner owns every card, so a new version of the key's site goes through all three steps.
    const version = async () => {
      const plan = await admin("/api/sites/plan", "POST", { card });
      expect(plan.body).toMatchObject({ card, updated: true });
      const deployId = String(plan.body["deployId"]);
      expect((await admin("/api/sites/assets", "POST", { deployId, manifest })).status).toBe(200);
      expect((await ownerPart(deployId, { ["d".repeat(32)]: "page" })).status).toBe(200);
      return deployId;
    };
    const replaced = await version();
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await admin("/api/sites/finish", "POST", { deployId: replaced });
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    expect(cloudflare.served(String(published.body["address"]))).toEqual([`kitshn-${card}`]);

    // A failed upload ends its plan, and a new site that has no card yet lets its name go.
    const fresh = await admin("/api/sites/plan", "POST", { folder: "never" });
    const freshId = String(fresh.body["deployId"]);
    expect((await admin("/api/sites/cancel", "POST", { deployId: freshId })).status).toBe(200);
    expect(await deployState(freshId)).toEqual([{ state: "failed" }]);
    const kept = await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql
        .exec("SELECT 1 FROM agent_sites WHERE card_id = ?", String(fresh.body["card"]))
        .toArray(),
    );
    expect(kept).toEqual([]);
    expect((await admin("/api/sites/cancel", "POST", { deployId: freshId })).status).toBe(404);

    // A repo that takes the site over during an upload stops its finish (K-1127).
    const late = await version();
    await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql.exec(
        "INSERT INTO repo_cards (repo_id, app_key, environment, card_id) VALUES ('99', 'app', 'prod', ?)",
        card,
      ),
    );
    expect((await admin("/api/sites/finish", "POST", { deployId: late })).status).toBe(409);
    expect(await deployState(late)).toEqual([{ state: "failed" }]);
    await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql.exec("DELETE FROM repo_cards WHERE card_id = ?", card),
    );
  });
});

describe("make it a repo (K-1127)", () => {
  /** One static deploy of a repo, from the plan to the finish. */
  const staticDeploy = async (app: ReturnType<typeof repo>, address: string) => {
    const plan = await step(app, "/deploy/plan", {
      recipe: { static: { output: "site" }, deploy: [{ on: "push", branch: "main", name: "prod", address }] },
      event: {},
    });
    const deployId = plan.body["deployId"];
    if (typeof deployId !== "string") return plan;
    const manifest = { "/index.html": { hash: "3".repeat(32), size: 3 } };
    expect((await step(app, "/deploy/assets", { deployId, manifest })).status).toBe(200);
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await step(app, "/deploy/finish", { deployId, jwt: "done" });
    return finish;
  };

  it("hands a folder site over to a new repo, whose first push deploys the same card", async () => {
    const cloudflare = fakeCloudflare();
    const edits = [
      { _tag: "circle", id: "handers", after: agentCircle("handers", "hand-key.access", true) },
      { _tag: "circle", id: "plain", after: agentCircle("plain", "plain-key.access", false) },
    ];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    const plan = await agentStep("hand-key.access", "/agent/sites/plan", {
      folder: "hand",
      address: "hand-site",
    });
    const deployId = plan.body["deployId"];
    const manifest = { "/index.html": { hash: "4".repeat(32), size: 2 } };
    expect((await agentStep("hand-key.access", "/agent/sites/assets", { deployId, manifest })).status).toBe(
      200,
    );
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await agentStep("hand-key.access", "/agent/sites/finish", { deployId, jwt: "done" });
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    const cards = async () =>
      (await admin("/api/state", "GET")).body["resources"] as Array<{
        id: string;
        name: string;
        kind: string;
      }>;
    const card = (await cards()).find((resource) => resource.name === "hand");
    if (!card) throw new Error("The folder site has no card.");

    // A key without "may add apps" cannot hand a card over; this key can.
    expect(
      (
        await agentStep("plain-key.access", `/agent/cards/${card.id}/handover`, {
          repo: "owner/handrepo",
          repoId: "80",
          ownerId: "1",
        })
      ).status,
    ).toBe(403);
    const handover = await agentStep("hand-key.access", `/agent/cards/${card.id}/handover`, {
      repo: "owner/handrepo",
      repoId: "80",
      ownerId: "1",
    });
    expect(handover.body, JSON.stringify(handover.body)).toMatchObject({ address: "hand-site.example.com" });

    // Another repo cannot use the handover; it waits at the gate as any new repo does.
    const stranger = repo("81", "strangerrepo");
    expect((await staticDeploy(stranger, "hand-site.example.com")).status).not.toBe(200);

    // The repo's first push deploys the same card, its script and its address, with no Allow on the map.
    const app = repo("80", "handrepo");
    const deployed = await staticDeploy(app, "hand-site.example.com");
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    expect(cloudflare.served("hand-site.example.com")).toEqual([`kitshn-${card.id}`]);
    expect((await cards()).filter((resource) => resource.name === "hand")).toHaveLength(1);
    // The folder no longer updates the site; the repo does.
    expect((await agentStep("hand-key.access", "/agent/sites/plan", { folder: "hand" })).body).toMatchObject({
      updated: false,
    });
    // The repo can build it again, so Remove app deletes its script as for any static site (K-909).
    expect((await admin(`/api/apps/${card.id}`, "DELETE")).status).toBe(200);
    expect(cloudflare.scripts.has(`kitshn-${card.id}`)).toBe(false);
  });

  it("turns a page into a repo's site, its old address redirects, and an expired handover does nothing", async () => {
    const cloudflare = fakeCloudflare();
    const edits = [{ _tag: "circle", id: "pagers", after: agentCircle("pagers", "page-key.access", true) }];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    const page = await call(
      "/agent/library",
      "POST",
      {
        "cf-access-jwt-assertion": await new SignJWT({ common_name: "page-key.access" })
          .setProtectedHeader({ alg: "RS256", kid: "team" })
          .setIssuer("https://team.example.com")
          .setAudience("agent-aud")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(team.privateKey),
        "x-kitshn-name": "story.html",
        "x-kitshn-address": "story",
      },
      "<p>story</p>",
    );
    expect(page.status, JSON.stringify(page.body)).toBe(201);
    const id = String(page.body["id"]);

    // An expired handover lets no repo take the card.
    expect(
      (
        await agentStep("page-key.access", `/agent/cards/${id}/handover`, {
          repo: "owner/late",
          repoId: "82",
          ownerId: "1",
        })
      ).status,
    ).toBe(200);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec("UPDATE handovers SET expires_at = 0");
    });
    expect((await staticDeploy(repo("82", "late"), "story.example.com")).status).not.toBe(200);

    const handover = await agentStep("page-key.access", `/agent/cards/${id}/handover`, {
      repo: "owner/storyrepo",
      repoId: "83",
      ownerId: "1",
    });
    expect(handover.body, JSON.stringify(handover.body)).toMatchObject({
      kind: "page",
      address: "story.example.com",
    });
    const storyRepo = repo("83", "storyrepo");
    const planned = await step(storyRepo, "/deploy/plan", {
      recipe: {
        static: { output: "site" },
        deploy: [{ on: "push", branch: "main", name: "prod", address: "story.example.com" }],
      },
      event: {},
    });
    const deployId = planned.body["deployId"];
    expect(deployId, JSON.stringify(planned.body)).toEqual(expect.any(String));
    // Between the takeover and the first finish, no library write changes the page: no update, no restore.
    const update = await call(
      "/agent/library",
      "POST",
      {
        "cf-access-jwt-assertion": await new SignJWT({ common_name: "page-key.access" })
          .setProtectedHeader({ alg: "RS256", kid: "team" })
          .setIssuer("https://team.example.com")
          .setAudience("agent-aud")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(team.privateKey),
        "x-kitshn-name": "story.html",
      },
      "<p>story two</p>",
    );
    expect([update.status, String(update.body["error"]).includes("repo's site")]).toEqual([409, true]);
    expect((await admin(`/api/library/${id}/previous`, "POST", {})).status).toBe(409);
    const manifest = { "/index.html": { hash: "3".repeat(32), size: 3 } };
    expect((await step(storyRepo, "/deploy/assets", { deployId, manifest })).status).toBe(200);
    let deployed = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && deployed.status === 503; attempt++)
      deployed = await step(storyRepo, "/deploy/finish", { deployId, jwt: "done" });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    expect(cloudflare.served("story.example.com")).toEqual([`kitshn-${id}`]);
    const state = await admin("/api/state", "GET");
    const card = (
      state.body["resources"] as Array<{ id: string; kind: string; addresses: Array<string> }>
    ).find((resource) => resource.id === id);
    expect(card).toMatchObject({ kind: "site.static", addresses: ["story.example.com"] });
    // The old page address sends who may open the card on to the site.
    const everyone = (state.body["circles"] as Array<{ id: string; x: number; y: number }>).find(
      (circle) => circle.id === "everyone",
    );
    if (!everyone) throw new Error("The seed has no Everyone circle.");
    expect(
      (
        await admin("/api/apply", "POST", {
          edits: [{ _tag: "place", id, after: { x: everyone.x, y: everyone.y } }],
        })
      ).status,
    ).toBe(200);
    const ctx = createExecutionContext();
    const visit = await worker.fetch(new Request("https://pages.example.com/story"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect([visit.status, visit.headers.get("location")]).toEqual([302, "https://story.example.com/"]);
  });

  it("changes nothing when the first push is refused, and ends a handover whose key lost its right", async () => {
    fakeCloudflare();
    const edits = [
      { _tag: "circle", id: "probers", after: agentCircle("probers", "probe-key.access", true) },
    ];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    const page = await call(
      "/agent/library",
      "POST",
      {
        "cf-access-jwt-assertion": await new SignJWT({ common_name: "probe-key.access" })
          .setProtectedHeader({ alg: "RS256", kid: "team" })
          .setIssuer("https://team.example.com")
          .setAudience("agent-aud")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(team.privateKey),
        "x-kitshn-name": "probe.html",
        "x-kitshn-address": "probe",
      },
      "<p>probe</p>",
    );
    const id = String(page.body["id"]);
    const snapshot = () =>
      runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => ({
        handovers: durable.storage.sql.exec("SELECT card_id FROM handovers WHERE card_id = ?", id).toArray()
          .length,
        cards: durable.storage.sql.exec("SELECT 1 FROM repo_cards WHERE card_id = ?", id).toArray().length,
        repos: durable.storage.sql
          .exec("SELECT 1 FROM repos WHERE repo_id IN ('84', '85') AND state = 'allowed'")
          .toArray().length,
      }));
    const kindOf = async () =>
      ((await admin("/api/state", "GET")).body["resources"] as Array<{ id: string; kind: string }>).find(
        (resource) => resource.id === id,
      )?.kind;

    // The first push sends a Worker recipe: the plan refuses, and the card, the handover and the gate stay as they were.
    expect(
      (
        await agentStep("probe-key.access", `/agent/cards/${id}/handover`, {
          repo: "owner/proberepo",
          repoId: "84",
          ownerId: "1",
        })
      ).status,
    ).toBe(200);
    const refused = await step(repo("84", "proberepo"), "/deploy/plan", { recipe: recipe(), event: {} });
    expect(refused.status).toBe(409);
    expect(await kindOf()).toBe("page");
    expect(await snapshot()).toEqual({ handovers: 1, cards: 0, repos: 0 });

    // The key loses "may add apps" within the hour: the handover ends unused, and the repo is not allowed.
    expect(
      (
        await agentStep("probe-key.access", `/agent/cards/${id}/handover`, {
          repo: "owner/lostright",
          repoId: "85",
          ownerId: "1",
        })
      ).status,
    ).toBe(200);
    const noRight = [
      { _tag: "circle", id: "probers", after: agentCircle("probers", "probe-key.access", false) },
    ];
    expect((await admin("/api/apply", "POST", { edits: noRight })).status).toBe(200);
    expect((await staticDeploy(repo("85", "lostright"), "probe.example.com")).status).not.toBe(200);
    expect(await kindOf()).toBe("page");
    expect(await snapshot()).toEqual({ handovers: 0, cards: 0, repos: 0 });
  });
});

describe("redirect addresses (K-1128)", () => {
  it("adds a hostname that sends visitors on to an app, keeps the limit, and removes it again", async () => {
    const cloudflare = fakeCloudflare();
    await noOldAddresses();
    const app = repo("90", "aliased");
    await allow(app);
    expect((await deploy(app)).status).toBe(200);
    const durable = env.KITSHN.getByName("kitshn");
    const alarm = () =>
      runInDurableObject(durable, (instance) => (instance as unknown as { alarm(): Promise<void> }).alarm());
    const add = (address: string) => admin(`/api/cards/${app.card}/redirects`, "POST", { address });

    expect((await add("kit.example.com")).status).toBe(400);
    // A row of another card holds its hostname, also one that oldAddresses() skips.
    await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql.exec(
        "INSERT INTO old_addresses (address, card_id, attached, going) VALUES ('held.example.com', 'gone', 1, 1)",
      ),
    );
    expect((await add("held.example.com")).status).toBe(409);
    const added = await add("alias.example.com");
    expect(added.body, JSON.stringify(added.body)).toMatchObject({
      address: "alias.example.com",
      to: app.address,
    });
    await alarm();
    expect(cloudflare.served("alias.example.com")).toEqual(["kitshn-redirects"]);
    const bindings = (cloudflare.uploads.at(-1)?.["bindings"] ?? []) as Array<{ name: string; text: string }>;
    expect(JSON.parse(bindings.find((binding) => binding.name === "MAP")?.text ?? "{}")).toEqual({
      "alias.example.com": app.address,
    });

    // At most 5 per card.
    for (const name of ["alias-two", "alias-three", "alias-four", "alias-five"])
      expect((await add(`${name}.example.com`)).status).toBe(200);
    expect((await add("alias-six.example.com")).status).toBe(409);

    // A key that does not control the card cannot add one.
    const edits = [
      { _tag: "circle", id: "strangers", after: agentCircle("strangers", "stranger-key.access", true) },
    ];
    expect((await admin("/api/apply", "POST", { edits })).status).toBe(200);
    expect(
      (
        await agentStep("stranger-key.access", `/agent/cards/${app.card}/redirects`, {
          address: "x.example.com",
        })
      ).status,
    ).toBe(403);

    // Remove: the custom domain goes, then the row.
    expect((await admin(`/api/cards/${app.card}/redirects/alias.example.com`, "DELETE")).status).toBe(200);
    await alarm();
    expect(cloudflare.served("alias.example.com")).toEqual([]);
    const left = await runInDurableObject(durable, (_instance, storage) =>
      storage.storage.sql
        .exec("SELECT address FROM old_addresses WHERE address = 'alias.example.com'")
        .toArray(),
    );
    expect(left).toEqual([]);
    expect((await add("alias-six.example.com")).status).toBe(200);
  });
});

describe("forwarded folder site (K-1714, K-1776)", () => {
  it("lets one Owner approval of the plan cover its files and its finish", async () => {
    fakeCloudflare();
    await noOldAddresses();
    const key = await newMachineKey();
    // "adds pages" is unset, so the plan asks the Owner; the site is new, so it also needs "adds apps".
    await setup({ deploys: { mode: "automatic" }, addsApps: { mode: "automatic" } }, key);
    const forward = async (path: string, body: unknown, nonce: string) => {
      const at = Date.now();
      const labels = "{}";
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(labels)));
      const labelsHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return call(
        path,
        "POST",
        {
          "cf-access-jwt-assertion": await new SignJWT({ common_name: "vps.access" })
            .setProtectedHeader({ alg: "RS256", kid: "team" })
            .setIssuer("https://team.example.com")
            .setAudience("agent-aud")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(team.privateKey),
          [FORWARD_HEADERS.signature]: await signText(
            key,
            forwardText("kit.example.com", "vps", { method: "POST", path, at, nonce, labelsHash }),
          ),
          [FORWARD_HEADERS.at]: String(at),
          [FORWARD_HEADERS.nonce]: nonce,
          [FORWARD_HEADERS.labels]: labels,
        },
        body,
      );
    };
    const planBody = { folder: "fwd", address: "fwd-site" };
    const waiting = await forward("/agent/sites/plan", planBody, "nonce-fwd-plan-0123456789");
    expect(waiting.status, JSON.stringify(waiting.body)).toBe(409);
    const proposalId = String(waiting.body["proposalId"]);
    const stub = env.KITSHN.getByName("kitshn");
    await runInDurableObject(stub, (instance) =>
      (
        instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
      ).decide(proposalId, "approved", {
        actor: { _tag: "person", email: "owner@example.com" },
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        machineId: null,
        reason: null,
      }),
    );
    const plan = await forward("/agent/sites/plan", planBody, "nonce-fwd-plan-1123456789");
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const deployId = plan.body["deployId"];
    const manifest = { "/index.html": { hash: "0".repeat(32), size: 5 } };
    const assets = await forward(
      "/agent/sites/assets",
      { deployId, manifest },
      "nonce-fwd-assets-0123456789",
    );
    expect(assets.status, JSON.stringify(assets.body)).toBe(200);
    let finish = { status: 503, body: {} as Record<string, unknown> };
    for (let attempt = 0; attempt < 10 && finish.status === 503; attempt++)
      finish = await forward(
        "/agent/sites/finish",
        { deployId, jwt: "done" },
        `nonce-fwd-finish-${attempt}-0123456789`,
      );
    expect(finish.status, JSON.stringify(finish.body)).toBe(200);
    // One approval covered the whole publish: no second proposal waits.
    const proposals = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE action = 'forward'")
        .one(),
    );
    expect(proposals.n).toBe(1);
  });
});
