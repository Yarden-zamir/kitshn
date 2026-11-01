import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { newMachineKey } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource, providerCardId } from "../src/core/model.ts";
import {
  OPERATIONS,
  OP_IDS,
  type OpId,
  type Operation,
  isPersonGate,
  opRequest,
} from "../src/core/operations.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";
import { forwarded, setup, withDaemon } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

const ADMIN = "admin-aud";
const call = (target: string, body: unknown = {}) => JSON.stringify({ target, body, reason: "test" });

it("lets an agent do owner actions through /op: care runs, a circle edit waits for the Owner, and the approval runs that call once (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // A right set makes "agents" an agent circle of the machine (K-1730).
  await setup({ deploys: { mode: "automatic" } }, key);
  const op = (id: string, nonce: string, body: string) =>
    forwarded(key, "POST", `/op/${id}`, `${nonce}-0123456789abcdef`, body, {}, ADMIN);

  // "maintains" starts automatic for a machine in an agent circle (Y2), so the setting changes at once (K-626).
  const care = await op("machine-auto-update", "care", call("vps", { autoUpdate: false }));
  expect(care.status, await care.clone().text()).toBe(200);
  expect(await care.json()).toMatchObject({ outcome: "done", result: { id: "vps", autoUpdate: false } });

  // A circle edit raises access, so it asks the Owner (K-715); the proposal names no right.
  const renamed: Circle = {
    id: "agents",
    name: "Builders",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights: { deploys: { mode: "automatic" } } }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  const edit = call("", { edits: [{ _tag: "circle", id: "agents", after: renamed }] });
  const first = await op("apply", "edit-1", edit);
  expect(first.status).toBe(409);
  const waiting = (await first.json()) as { outcome: string; proposalId: string };
  expect(waiting.outcome).toBe("waiting");
  const stub = env.KITSHN.getByName("kitshn");
  const right = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ right_name: string }>("SELECT right_name FROM proposals WHERE id = ?", waiting.proposalId)
      .one(),
  );
  expect(right.right_name).toBe("owner");
  await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
    ).decide(waiting.proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    }),
  );
  const second = await op("apply", "edit-2", edit);
  expect(second.status, await second.clone().text()).toBe(200);
  const name = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
  );
  expect((JSON.parse(name.body) as Circle).name).toBe("Builders");
  // The approval covers only the call that it named: another edit asks again.
  const other = call("", {
    edits: [{ _tag: "circle", id: "agents", after: { ...renamed, name: "Others" } }],
  });
  const third = await op("apply", "edit-3", other);
  expect(third.status).toBe(409);

  // Only a person resumes; the refusal says why.
  const resume = await op("resume", "resume", call(""));
  expect(resume.status).toBe(403);
  expect(await resume.json()).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("passkey"),
  });
});

it("runs an owner call at once, and refuses a service token that is no machine (K-1732, K-1777)", async () => {
  stubAccessCerts();
  await setup({});
  const post = async (claims: { email: string } | { common_name: string }) =>
    send("/op/machine-order", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessToken(ADMIN, claims),
        "content-type": "application/json",
      },
      body: call("vps", { order: 7 }),
    });
  const owner = await post({ email: "owner@example.com" });
  expect(owner.status, await owner.clone().text()).toBe(200);
  expect(await owner.json()).toMatchObject({ outcome: "done", result: { order: 7 } });
  const key = await post({ common_name: "someone.access" });
  expect(key.status).toBe(403);
  // The owner goes through the gate too: a person row has its own passkey path.
  const resume = await send("/op/resume", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken(ADMIN, { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: call(""),
  });
  expect(resume.status).toBe(403);
  expect(await resume.json()).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("passkey"),
  });
});

it("refuses an unsigned call of a machine token on /op (K-1714)", async () => {
  stubAccessCerts();
  await setup({});
  const answer = await send("/op/machine-order", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken(ADMIN, { common_name: "vps.access" }),
      "content-type": "application/json",
    },
    body: call("vps", { order: 3 }),
  });
  expect(answer.status).toBe(403);
});

/** The approval of a machine call: what the jobs of a gated call carry (K-1777). */
type Approved = { readonly op: string; readonly approval: object };
type Instance = {
  env: Record<string, unknown>;
  deliverJobs(): number;
  ownerRoute(
    path: string,
    request: Request,
    caller: { visitor: object; actor: object; gated?: Approved },
  ): Promise<Response>;
};
const machineCaller = {
  visitor: { email: null, clientId: "vps.access", ip: null },
  actor: { _tag: "machine", machineId: "vps", name: "vps" },
};
const ownerCaller = {
  visitor: { email: "owner@example.com", clientId: null, ip: null },
  actor: { _tag: "person", email: "owner@example.com" },
};
const appId = providerCardId("vps", "t3", "app");
/** A job that the owner queued on vps. */
const queueOwnerJob = (state: DurableObjectState, id: number) =>
  state.storage.sql.exec(
    `INSERT OR REPLACE INTO jobs (id, machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, when_idle)
     VALUES (?, 'vps', '[]', '{"kind":"restart"}', 'queued', 0, ?, ?, ?, NULL, '', 0)`,
    id,
    Date.now() + 60_000,
    JSON.stringify(ownerCaller.actor),
    JSON.stringify(ownerCaller.visitor),
  );
/** Targets and bodies that reach the checks of each owner route; a row with none takes the machine vps. */
const TARGETS: Partial<Record<OpId, string>> = {
  "job-cancel": "9001",
  "device-invite-cancel": "token-x",
  "proposal-deny": "proposal-x",
  desired: "t3.settings",
  "desired-set": "t3.settings",
};
const BODIES: Partial<Record<OpId, unknown>> = {
  apply: { edits: [] },
  "card-setting": { key: "updateChannel", value: "daily" },
  "card-redirect-remove": { address: "old.example.com" },
  "machine-shell": { command: { script: "true" } },
  "machine-provider-command": { command: { provider: "t3", command: "restart", resource: appId } },
  "machine-labels": { labels: ["gpu"] },
  "machine-order": { order: 2 },
  "machine-auto-update": { autoUpdate: false },
  "machine-compose-allow": { allow: [] },
  "provider-forget": { provider: "t3" },
  "site-live-add": { machineId: "vps", name: "live1", server: "5173" },
  "app-restore": { run: "run-1" },
  "port-add": { machine: "vps", name: "p1", port: "22/tcp" },
  "port-door-close": { address: "p1.example.com" },
  "desired-set": { machineId: "vps", value: {} },
};
/** A provider card of vps with one setting (K-717), the target of the card rows. */
const provider = {
  name: "t3",
  online: true,
  kinds: [
    {
      id: "t3.app",
      name: "T3 app",
      levels: { view: "view", use: "use", control: "control" },
      ownerControl: true,
      settings: [
        { id: "updateChannel", title: "Update channel", values: ["nightly", "daily"], default: "nightly" },
      ],
    },
  ],
  commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
  resources: [{ id: "app", kind: "t3.app", name: "T3 on vps", status: "running" }],
};
/** Rows that end the machine or its key run last, so the other rows still meet it. */
const LAST: ReadonlyArray<OpId> = ["machine-reset-key", "machine-remove", "sign-out"];

it("runs each gated row through the owner code: it fails only where the owner fails, and its job goes out (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // The machine is in an agent circle that controls no card, so only the gate lets its calls run. The owner controls
  // the machine card and the provider card, so a refusal of the agent alone shows.
  await setup({ deploys: { mode: "automatic" } }, key);
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: "vps",
      kind: "machine",
      name: "vps",
      addresses: [],
      status: "running",
      group: null,
      machine: "vps",
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('vps', ?)",
      JSON.stringify(card),
    );
    state.storage.sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('vps', ?, ?)", owner.x, owner.y);
  });
  await evictDurableObject(stub);
  const problems = await withDaemon(
    async (instance, state, daemon) => {
      const kitshn = instance as Instance;
      // The Worker of a release, so there is a release to update to (K-617).
      kitshn.env = { ...kitshn.env, KITSHN_VERSION: "aaaaaaaaaaaa" };
      await daemon({ type: "providers", providers: [provider] });
      const rows = OP_IDS.filter((id) => {
        const op: Operation = OPERATIONS[id];
        return !isPersonGate(op.gate) && op.shortOnly !== true;
      }).sort((a, b) => Number(LAST.includes(a)) - Number(LAST.includes(b)));
      const found: Array<string> = [];
      for (const id of rows) {
        // A queued job of the owner, for job-cancel; no delivery runs before the cancel.
        if (id === "job-cancel") queueOwnerJob(state, 9001);
        const op: Operation = OPERATIONS[id];
        const right = isPersonGate(op.gate) ? null : op.gate.right;
        const onCard = !isPersonGate(op.gate) && (op.gate.scope === "card" || op.gate.scope === "own");
        const built = opRequest(op, TARGETS[id] ?? (onCard ? appId : "vps"), BODIES[id] ?? {});
        if (typeof built === "string") {
          found.push(`${id}: ${built}`);
          continue;
        }
        const request = () =>
          new Request(`https://kit.example.com${built.path}`, {
            method: built.method,
            headers: { "content-type": "application/json" },
            ...(built.body === null ? {} : { body: JSON.stringify(built.body) }),
          });
        const gated = { op: id, approval: { machineId: "vps", key: `f 0`, right } };
        const answer = await kitshn
          .ownerRoute(built.path, request(), { ...machineCaller, gated })
          .catch((error: unknown) => Response.json({ error: String(error) }, { status: 599 }));
        if (!answer.ok) {
          // A missing target or a rule that also binds the owner (K-105, K-1504) fails both calls. A failed call
          // changes nothing, so the owner call meets the same state; only a refusal of the agent alone is a gap.
          const owner = await kitshn.ownerRoute(built.path, request(), ownerCaller).catch(() => null);
          if (owner?.ok === true) found.push(`${id}: ${answer.status} ${await answer.text()}`);
          continue;
        }
        const result: unknown = await answer.json().catch(() => null);
        const jobId =
          answer.ok && typeof result === "object" && result !== null && "id" in result ? result.id : null;
        if (
          (built.path === "/api/jobs" || id === "site-live-add") &&
          answer.ok &&
          typeof jobId === "number"
        ) {
          kitshn.deliverJobs();
          const job = state.storage.sql
            .exec<{ state: string; output: string }>("SELECT state, output FROM jobs WHERE id = ?", jobId)
            .one();
          if (job.state !== "sent") found.push(`${id}: job ${job.state} ${job.output}`);
        }
      }
      return found;
    },
    ["tunnel-restart", "update", "update-gz", "health"],
  );
  expect(problems).toEqual([]);
});

it("sends the job of a gated call once its machine is online, and the right off or the pause ends it (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ deploys: { mode: "automatic" } }, key);
  const restart = async (nonce: string) => {
    const answer = await forwarded(
      key,
      "POST",
      "/op/machine-restart",
      `${nonce}-0123456789abcdef`,
      call("vps"),
      {},
      ADMIN,
    );
    expect(answer.status, await answer.clone().text()).toBe(200);
    return ((await answer.json()) as { result: { id: number } }).result.id;
  };
  const deliver = (id: number) =>
    withDaemon(async (instance, state) => {
      (instance as Instance).deliverJobs();
      return state.storage.sql
        .exec<{ state: string; output: string }>("SELECT state, output FROM jobs WHERE id = ?", id)
        .one();
    });
  // The machine is offline at the call, so the job waits, and goes out when the daemon is back.
  expect(await deliver(await restart("sent"))).toMatchObject({ state: "sent" });
  const off = await restart("off");
  await setup({ deploys: { mode: "automatic" }, maintains: { mode: "off" } }, key);
  expect(await deliver(off)).toMatchObject({ state: "failed", output: expect.stringContaining("off") });

  await setup({ deploys: { mode: "automatic" } }, key);
  const paused = await restart("paused");
  const pause = await send("/api/apply", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken(ADMIN, { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ edits: [{ _tag: "pause", after: "keep-public" }] }),
  });
  expect(pause.status, await pause.clone().text()).toBe(200);
  const stub = env.KITSHN.getByName("kitshn");
  const after = await runInDurableObject(stub, (_, state) => {
    const job = state.storage.sql
      .exec<{ state: string }>("SELECT state FROM jobs WHERE id = ?", paused)
      .one();
    state.storage.sql.exec("DELETE FROM meta WHERE key IN ('paused', 'paused_by', 'paused_at')");
    return job.state;
  });
  await evictDurableObject(stub);
  expect(after).toBe("failed");
});

it("asks the Owner when the scope fails or a secret goes out, and the Owner's approval runs the call (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // Both rights run at once, so only a failed scope asks.
  await setup({ maintains: { mode: "automatic" }, addsApps: { mode: "automatic" } }, key);
  const stub = env.KITSHN.getByName("kitshn");
  const op = (id: string, nonce: string, body: string) =>
    forwarded(key, "POST", `/op/${id}`, `${nonce}-0123456789abcdef`, body, {}, ADMIN);
  const waits = async (answer: Response) => {
    expect(answer.status, await answer.clone().text()).toBe(409);
    const body = (await answer.json()) as { outcome: string; proposalId: string };
    expect(body.outcome).toBe("waiting");
    return body.proposalId;
  };
  await runInDurableObject(stub, (_, state) => queueOwnerJob(state, 9002));

  // A job that another member queued on a machine that the agent does not control.
  const cancel = call("9002");
  const asked = await waits(await op("job-cancel", "cancel-1", cancel));
  const approved = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        decide(id: string, decision: "approved", by: object): Promise<{ ok: boolean; error?: string }>;
      }
    ).decide(asked, "approved", {
      actor: ownerCaller.actor,
      visitor: ownerCaller.visitor,
      machineId: null,
      reason: null,
    }),
  );
  expect(approved).toEqual({ ok: true });
  const ran = await op("job-cancel", "cancel-2", cancel);
  expect(ran.status, await ran.clone().text()).toBe(200);

  // K-2007: a port card only on machines that the agent controls.
  await waits(await op("port-add", "port", call("", { machine: "vps", name: "p1", port: "22/tcp" })));
  // An edit that does not resolve cannot pass the rule.
  await waits(
    await op(
      "apply",
      "apply",
      call("", { edits: [{ _tag: "place", id: "no-card", after: { x: 1, y: 1 } }] }),
    ),
  );
  // The approver reads what the secret gives.
  const reset = await waits(await op("machine-reset-key", "reset", call("vps")));
  const shown = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ shown: string }>("SELECT shown FROM proposals WHERE id = ?", reset).one(),
  );
  expect(shown.shown).toContain("gives: a key code that can act as the machine vps");
});
