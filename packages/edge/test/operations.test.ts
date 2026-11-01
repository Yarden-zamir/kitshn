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
import {
  ACTOR_ROW,
  actorRows,
  insertActors,
  key as keyChip,
  machine as machineChip,
  tokenActor,
} from "./actors.ts";
import { forwarded, setup, withDaemon } from "./machine-http.ts";

afterEach(() => vi.restoreAllMocks());

const ADMIN = "admin-aud";
const call = (target: string, body: unknown = {}) => JSON.stringify({ target, body, reason: "test" });

it("lets an agent do owner actions through /op: care runs, a circle edit waits for the Owner, and the approval runs that call once (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // A right set makes "agents" an agent circle of the machine (K-1730).
  await setup({ changes: { mode: "automatic" } }, key);
  const op = (id: string, nonce: string, body: string) =>
    forwarded(key, "POST", `/op/${id}`, `${nonce}-0123456789abcdef`, body, {}, ADMIN);

  // "maintains" starts automatic for a machine in an agent circle (Y2), so the setting changes at once (K-626).
  const care = await op("machine-auto-update", "care", call("vps", { autoUpdate: false }));
  expect(care.status, await care.clone().text()).toBe(200);
  expect(await care.json()).toMatchObject({ outcome: "done", result: { id: "vps", autoUpdate: false } });

  // A circle edit raises access, so it asks the Owner (K-715) for the effect "shares" (K-1778).
  const renamed: Circle = {
    id: "agents",
    name: "Builders",
    color: "#ffcc00",
    level: "control",
    members: [machineChip("vps", { changes: { mode: "automatic" } })],
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
  expect(right.right_name).toBe("shares");
  // K-1723, K-1778: an ask that raises access needs a passkey proof, also where the Owner circle lets a token approve.
  const script = tokenActor("t-script", "script.access", "Script");
  const ownerBody = await runInDurableObject(stub, (_, state) => {
    const { body } = state.storage.sql
      .exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID)
      .one();
    const open = JSON.parse(body) as Circle;
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = ?",
      JSON.stringify({ ...open, members: [...open.members, script], approvesWithoutPasskey: true }),
      OWNER_CIRCLE_ID,
    );
    insertActors(state.storage.sql, [script]);
    return body;
  });
  await evictDurableObject(stub);
  const byToken = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
    ).decide(waiting.proposalId, "approved", {
      actor: { _tag: "kitshn", reason: "test" },
      visitor: { email: null, clientId: "script.access", ip: null },
      machineId: null,
      reason: null,
    }),
  );
  expect(byToken).toMatchObject({
    ok: false,
    error: expect.stringMatching(/"shares", so only a person approves/),
  });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("UPDATE circles SET body = ? WHERE id = ?", ownerBody, OWNER_CIRCLE_ID),
  );
  await evictDurableObject(stub);
  await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        decide(id: string, decision: "approved", by: object, hash: null, via: "passkey"): Promise<unknown>;
      }
    ).decide(
      waiting.proposalId,
      "approved",
      {
        actor: { _tag: "person", email: "owner@example.com" },
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        machineId: null,
        reason: null,
      },
      null,
      "passkey",
    ),
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

it("refuses a machine token on an owner route, also when the machine holds the admin (K-1714, M3)", async () => {
  stubAccessCerts();
  // The circle holds the admin card of the seed at (0, 40), and "shares" and "secrets" are automatic (K-1778).
  const automatic = { mode: "automatic" } as const;
  await setup({ shares: automatic, secrets: automatic }, null, { x: 0, y: 40 });
  const answer = await send("/api/state", {
    headers: { "cf-access-jwt-assertion": await accessToken(ADMIN, { common_name: "vps.access" }) },
  });
  expect(answer.status).toBe(403);
  expect(await answer.json()).toMatchObject({ error: expect.stringContaining("/op") });
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
  "repo-allow": "1002",
  "repo-block": "1002",
  "repo-forget": "1003",
  "device-invite-cancel": "token-x",
  "proposal-deny": "proposal-x",
  desired: "t3.settings",
  "desired-set-shared": "t3.settings",
};
const BODIES: Partial<Record<OpId, unknown>> = {
  "card-time": { endsAt: null },
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
  "port-add": { machine: "vps", name: "p1", ports: ["25565/tcp"] },
  "port-door-close": { address: "p1.example.com" },
  "desired-set-machine": { kind: "t3.settings", value: {} },
  "desired-set-shared": { value: {} },
  "repo-group-add": { match: "acme" },
  "github-way": { githubWay: "not-kitshn" },
  "passes-set": { on: false },
  "audience-add": { address: "https://aud.example.com" },
  "audience-labels": { address: "https://aud.example.com", labels: false },
  "ask-events": { label: "t3.thread.id=nothing" },
};
/**
 * Rows whose fixture fails for the owner too, so the test cannot see a refusal of the agent alone. Each reason says
 * why. A row that starts or stops failing for both callers fails the test, so this list stays true.
 */
const BOTH_FAIL: Partial<Record<OpId, string>> = {
  organize: "needs the drawn sizes of the map",
  undo: "needs a revision id of this run",
  "undo-item": "needs an item with History",
  "card-address": "only a page or a file has an address that kitshn sets",
  "card-redirect-add": "only a site card has redirects",
  "card-redirect-remove": "only a site card has redirects",
  "card-progress-dismiss": "needs a failed action",
  "card-take-address": "calls the Cloudflare API",
  "card-give-address-back": "calls the Cloudflare API",
  "machine-volume-remove": "needs an orphaned volume that the daemon reports",
  "machine-add": "calls the Cloudflare API",
  "machine-remove": "calls the Cloudflare API",
  "provider-forget": "the provider still runs on the machine",
  "app-logs": "needs a card with logs: a Worker site or a Compose app",
  "app-backup": "needs a Compose card",
  "app-restore": "needs a Compose card",
  "app-rollbacks": "needs a card that a deploy made",
  "app-rollback": "needs a card that a deploy made",
  "app-run-rollback-plan": "needs a deploy of a workflow run",
  "app-run-rollback": "needs a deploy of a workflow run",
  "app-remove": "needs a card that a deploy made",
  "worker-storage-remove": "needs orphaned Worker storage",
  "bot-run-deploy": "needs a waiting run of the kitshn App bot",
  "port-remove": "needs a port card",
  "port-door-close": "needs an open door",
  "library-content": "needs a page or a file",
  "library-previous": "needs a page, file or folder site of the library",
  "library-delete": "needs a page, file or folder site of the library",
  "device-token-add": "calls the Cloudflare API",
  "device-invite": "calls the Cloudflare API",
  "device-invite-cancel": "needs a waiting invite",
  "device-list": "calls the Cloudflare API",
  "repo-group-edit": "needs the id of a repo group",
  "repo-group-remove": "needs the id of a repo group",
  "proposal-deny": "needs an open proposal",
  usage: "calls the Cloudflare API",
  desired: "needs a provider that registered the state",
  "desired-set-machine": "needs a provider that registered the state",
  "desired-set-shared": "needs a provider that registered the state",
  "sign-out": "calls the Cloudflare API",
  "sign-out-retry": "needs a sign-out with sessions left",
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
  await setup({ changes: { mode: "automatic" } }, key);
  const stub = env.KITSHN.getByName("kitshn");
  const owner = await runInDurableObject(stub, (_, state) => {
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    // Waiting repos, the targets of the repo rows (K-819). Forget gets its own, because block runs before it.
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen) VALUES ('1002', 'acme/app', 'waiting', 1), ('1003', 'acme/other', 'waiting', 1)",
    );
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
    return owner;
  });
  await evictDurableObject(stub);
  // A map edit that both callers may make: the machine card stays where it is.
  const bodies = {
    ...BODIES,
    apply: { edits: [{ _tag: "place", id: "vps", after: { x: owner.x, y: owner.y } }] },
  };
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
        const right = op.effect;
        const onCard = !isPersonGate(op.gate) && (op.gate.scope === "card" || op.gate.scope === "own");
        const built = opRequest(op, TARGETS[id] ?? (onCard ? appId : "vps"), bodies[id] ?? {});
        if (typeof built === "string") {
          found.push(`${id}: ${built}`);
          continue;
        }
        const request = () =>
          new Request(`https://kit.example.com${built.path}${built.search}`, {
            method: built.method,
            headers: { "content-type": "application/json" },
            ...(built.body === null ? {} : { body: JSON.stringify(built.body) }),
          });
        // The machine controls no card, so each scope fails and the call runs only with the Owner's approval.
        const gated = { op: id, approval: { machineId: "vps", key: `f 0`, right, person: true } };
        const answer = await kitshn
          .ownerRoute(built.path, request(), { ...machineCaller, gated })
          .catch((error: unknown) => Response.json({ error: String(error) }, { status: 599 }));
        if (!answer.ok) {
          // A missing target or a rule that also binds the owner (K-105, K-1504) fails both calls. A failed call
          // changes nothing, so the owner call meets the same state; only a refusal of the agent alone is a gap.
          const owner = await kitshn.ownerRoute(built.path, request(), ownerCaller).catch(() => null);
          if (owner?.ok === true) found.push(`${id}: ${answer.status} ${await answer.text()}`);
          else if (BOTH_FAIL[id] === undefined) found.push(`${id}: fails for both, ${await answer.text()}`);
          continue;
        }
        if (BOTH_FAIL[id] !== undefined) {
          found.push(`${id}: runs now, so take it out of BOTH_FAIL`);
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
    ["tunnel-restart", "update", "update-gz", "health", "doors"],
  );
  expect(problems).toEqual([]);
});

/**
 * The rows of scope "never" before effects (K-1730): each asked the Owner always. `desired-set` is now two rows. Each
 * has a real scope or the scope "owner", so a target out of scope still waits, whatever "shares" says (K-1778).
 * `desired` has the scope "any" now, because desired state holds no secret (K-709).
 */
const FORMER_NEVER: ReadonlyArray<OpId> = [
  "organize",
  "undo",
  "undo-item",
  "card-take-address",
  "card-give-address-back",
  "machine-volume-remove",
  "machine-labels",
  "machine-compose-allow",
  "machine-reset-key",
  "machine-add",
  "machine-remove",
  "provider-forget",
  "site-live-add",
  "worker-storage-remove",
  "bot-run-deploy",
  "device-token-add",
  "device-invite",
  "repo-block",
  "repo-forget",
  "repo-group-add",
  "repo-group-edit",
  "repo-group-remove",
  "github-way",
  "passes-set",
  "passes-rotate",
  "audience-labels",
  "audience-remove",
  "state-export",
  "jobs",
  "desired-set-machine",
  "desired-set-shared",
  "sign-out",
];

it.each([
  ["ask", { mode: "ask", circleId: OWNER_CIRCLE_ID }],
  ["automatic", { mode: "automatic" }],
] as const)(
  "still asks the Owner for each former never row out of scope, with shares %s and every other effect automatic (K-1730, K-1778)",
  async (name, shares) => {
    stubAccessCerts();
    const key = await newMachineKey();
    const automatic = { mode: "automatic" } as const;
    await setup(
      {
        reads: automatic,
        maintains: automatic,
        creates: automatic,
        changes: automatic,
        runs: automatic,
        destroys: automatic,
        secrets: automatic,
        shares,
      },
      key,
    );
    const stub = env.KITSHN.getByName("kitshn");
    // The machine card of vps sits in the Owner circle only, so a card or machine target is out of scope.
    await runInDurableObject(stub, (_, state) => {
      const owner = JSON.parse(
        state.storage.sql
          .exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID)
          .one().body,
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
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO places (id, x, y) VALUES ('vps', ?, ?)",
        owner.x,
        owner.y,
      );
    });
    await evictDurableObject(stub);
    const bodies: Partial<Record<OpId, unknown>> = {
      ...BODIES,
      "machine-volume-remove": { command: { volume: "old" } },
      "desired-set-machine": { kind: "t3.settings", value: {} },
    };
    const outcomes: Array<string> = [];
    for (const id of FORMER_NEVER) {
      const answer = await forwarded(
        key,
        "POST",
        `/op/${id}`,
        `never-${name}-${id}-0123456789abcdef`,
        call(TARGETS[id] ?? "vps", bodies[id] ?? {}),
        {},
        ADMIN,
      );
      const result = (await answer.json()) as { outcome: string; reason?: string };
      const [proposal] = await runInDurableObject(stub, (_, state) => {
        const rows = state.storage.sql
          .exec<{ right_name: string }>("SELECT right_name FROM proposals")
          .toArray();
        // At most 20 open asks per credential (K-1722): each row starts with none.
        state.storage.sql.exec("DELETE FROM proposals");
        return rows;
      });
      outcomes.push(`${id}: ${result.outcome} ${proposal?.right_name ?? result.reason ?? ""}`);
    }
    expect(outcomes).toEqual(FORMER_NEVER.map((id) => `${id}: waiting shares`));
  },
);

it("never lets an actor set its own effects: with every effect automatic but secrets, the edit and the secrets wait for the Owner (K-1778)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  const automatic = { mode: "automatic" } as const;
  const rights = {
    reads: automatic,
    maintains: automatic,
    creates: automatic,
    changes: automatic,
    runs: automatic,
    destroys: automatic,
    shares: automatic,
  };
  await setup(rights, key);
  const stub = env.KITSHN.getByName("kitshn");
  const agents = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
  );
  const before = JSON.parse(agents.body) as Circle;
  const own = call("", {
    edits: [
      {
        _tag: "circle",
        id: "agents",
        after: { ...before, members: [machineChip("vps", { ...rights, secrets: automatic })] },
      },
    ],
  });
  const op = (id: string, nonce: string, body: string) =>
    forwarded(key, "POST", `/op/${id}`, `${nonce}-0123456789abcdef`, body, {}, ADMIN);
  const outcomes: Array<string> = [];
  for (const [id, body] of [
    ["apply", own],
    ["state-export", call("")],
    ["device-token-add", call("", { name: "phone" })],
  ] as const) {
    const answer = await op(id, `escalate-${id}`, body);
    const result = (await answer.json()) as { outcome: string };
    const [proposal] = await runInDurableObject(stub, (_, state) => {
      const rows = state.storage.sql
        .exec<{ right_name: string; circle_id: string }>("SELECT right_name, circle_id FROM proposals")
        .toArray();
      state.storage.sql.exec("DELETE FROM proposals");
      return rows;
    });
    outcomes.push(`${id}: ${result.outcome} ${proposal?.right_name ?? ""} ${proposal?.circle_id ?? ""}`);
  }
  expect(outcomes).toEqual([
    `apply: waiting shares ${OWNER_CIRCLE_ID}`,
    `state-export: refused  `,
    `device-token-add: refused  `,
  ]);
  const after = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
  );
  expect(after.body).toBe(agents.body);
});

it("sends the job of a gated call once its machine is online, and the right off or the pause ends it (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ changes: { mode: "automatic" } }, key);
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
  await setup({ changes: { mode: "automatic" }, maintains: { mode: "off" } }, key);
  expect(await deliver(off)).toMatchObject({ state: "failed", output: expect.stringContaining("off") });
  // No person approved it, so "ask" ends it too: only an automatic effect let it in (M5).
  await setup({ changes: { mode: "automatic" } }, key);
  const asks = await restart("asks");
  await setup({ changes: { mode: "automatic" }, maintains: { mode: "ask", circleId: OWNER_CIRCLE_ID } }, key);
  expect(await deliver(asks)).toMatchObject({
    state: "failed",
    output: expect.stringContaining('"maintains" of the caller is no longer automatic'),
  });

  await setup({ changes: { mode: "automatic" } }, key);
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
  const ended = await withDaemon(async (instance, state) => {
    const read = () =>
      state.storage.sql
        .exec<{ state: string; output: string }>("SELECT state, output FROM jobs WHERE id = ?", paused)
        .one();
    const atPause = read();
    // The same job as a race queues it after the pause: its delivery ends it too, and it never waits for Resume.
    state.storage.sql.exec("UPDATE jobs SET state = 'queued', output = '' WHERE id = ?", paused);
    (instance as Instance).deliverJobs();
    const raced = read();
    state.storage.sql.exec("DELETE FROM meta WHERE key IN ('paused', 'paused_by', 'paused_at')");
    return [atPause, raced];
  });
  await evictDurableObject(stub);
  const pauseEnded = { state: "failed", output: "The emergency pause ended this job." };
  expect(ended).toEqual([pauseEnded, pauseEnded]);
});

const HOUR = 60 * 60_000;
/** Every card of the machine vps, also those of earlier tests, at a spot: the agent circle is at (5000, 5000). */
const placeMachineCards = async (spot: "agents" | "owner") => {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const [x, y] = spot === "agents" ? [5000, 5000] : [owner.x, owner.y];
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
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO places (id, x, y)
       SELECT id, ?, ? FROM resources WHERE json_extract(body, '$.machine') = 'vps'`,
      x,
      y,
    );
  });
  await evictDurableObject(stub);
};
const approveAsOwner = (proposalId: string) =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
    (
      instance as unknown as {
        decide(
          id: string,
          decision: "approved",
          by: object,
          hash: null,
          via: "passkey",
        ): Promise<{ ok: boolean; error?: string }>;
      }
    ).decide(
      proposalId,
      "approved",
      { actor: ownerCaller.actor, visitor: ownerCaller.visitor, machineId: null, reason: null },
      null,
      "passkey",
    ),
  );

it("checks K-718 again when a job that no person approved goes out, and gives it the normal expiry (K-613, K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ runs: { mode: "automatic" } }, key);
  const shell = async (nonce: string) =>
    forwarded(
      key,
      "POST",
      "/op/machine-shell",
      `${nonce}-0123456789abcdef`,
      call("vps", { command: { script: "true" } }),
      {},
      ADMIN,
    );
  const job = (id: number) =>
    withDaemon(async (instance, state) => {
      (instance as Instance).deliverJobs();
      return state.storage.sql
        .exec<{ state: string; output: string; life: number }>(
          "SELECT state, output, expires_at - created_at AS life FROM jobs WHERE id = ?",
          id,
        )
        .one();
    });

  // The agent circle manages the whole machine, so the gate runs the call with no person.
  await placeMachineCards("agents");
  const gated = await shell("gated");
  expect(gated.status, await gated.clone().text()).toBe(200);
  const gatedId = ((await gated.json()) as { result: { id: number } }).result.id;
  // The owner takes the machine card out of the agent circle before the job goes out.
  await placeMachineCards("owner");
  expect(await job(gatedId)).toMatchObject({
    state: "failed",
    output: expect.stringContaining("K-718"),
    life: 24 * HOUR,
  });

  // K-1778: out of scope, "shares" automatic does not let a shell in, so K-718 never falls away; it waits for the Owner.
  await setup({ runs: { mode: "automatic" }, shares: { mode: "automatic" } }, key);
  const shared = await shell("shared");
  expect(shared.status, await shared.clone().text()).toBe(409);
  expect(await shared.json()).toMatchObject({ outcome: "waiting", circle: "Owner" });
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql.exec("DELETE FROM proposals"),
  );
  await setup({ runs: { mode: "automatic" } }, key);

  // Out of scope, the same call asks the Owner. The Owner's approval covers what they saw, for 1 hour.
  const asked = await shell("asked");
  expect(asked.status, await asked.clone().text()).toBe(409);
  expect(await approveAsOwner(((await asked.json()) as { proposalId: string }).proposalId)).toEqual({
    ok: true,
  });
  const approved = await shell("approved");
  expect(approved.status, await approved.clone().text()).toBe(200);
  const approvedId = ((await approved.json()) as { result: { id: number } }).result.id;
  expect(await job(approvedId)).toMatchObject({ state: "sent", life: HOUR });
});

it("never runs an Owner ask on an approval of a right that came without a passkey (K-1723)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ runs: { mode: "ask", circleId: OWNER_CIRCLE_ID } }, key);
  await placeMachineCards("agents");
  const stub = env.KITSHN.getByName("kitshn");
  // The Owner circle lets the token "script" approve without a passkey (K-1725 warns).
  const script = tokenActor("t-script", "script.access", "Script");
  await runInDurableObject(stub, (_, state) => {
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    state.storage.sql.exec(
      "UPDATE circles SET body = ? WHERE id = ?",
      JSON.stringify({ ...owner, members: [...owner.members, script], approvesWithoutPasskey: true }),
      OWNER_CIRCLE_ID,
    );
    insertActors(state.storage.sql, [script]);
  });
  await evictDurableObject(stub);
  const shell = (nonce: string) =>
    forwarded(
      key,
      "POST",
      "/op/machine-shell",
      `${nonce}-0123456789abcdef`,
      call("vps", { command: { script: "true" } }),
      {},
      ADMIN,
    );
  const asked = await shell("passkey-asked");
  expect(asked.status, await asked.clone().text()).toBe(409);
  const { proposalId } = (await asked.json()) as { proposalId: string };
  const byToken = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as { decide(id: string, decision: "approved", by: object): Promise<unknown> }
    ).decide(proposalId, "approved", {
      actor: { _tag: "device", clientId: "script.access", name: "Script" },
      visitor: { email: null, clientId: "script.access", ip: null },
      machineId: null,
      reason: null,
    }),
  );
  expect(byToken).toMatchObject({ ok: true });
  // Out of scope, the same call is an Owner ask (right "owner"), which only a passkey approval runs.
  await placeMachineCards("owner");
  const again = await shell("passkey-again");
  expect(again.status, await again.clone().text()).toBe(409);
});

it("asks the Owner when the scope fails or a secret goes out, and the Owner's approval runs the call (K-1777)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  // These effects run at once, so only a failed scope asks; "secrets" asks the Owner instead of its default off.
  await setup(
    {
      maintains: { mode: "automatic" },
      creates: { mode: "automatic" },
      secrets: { mode: "ask", circleId: OWNER_CIRCLE_ID },
    },
    key,
  );
  await placeMachineCards("owner");
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
  expect(await approveAsOwner(asked)).toEqual({ ok: true });
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
  // The approver reads what the answer gives: a secret, or text that a person typed.
  const shown = (proposalId: string) =>
    runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ shown: string }>("SELECT shown FROM proposals WHERE id = ?", proposalId)
          .one().shown,
    );
  const reset = await waits(await op("machine-reset-key", "reset", call("vps")));
  expect(await shown(reset)).toContain("gives: a key code that can act as the machine vps");
  // K-1730: job output can quote a secret that a person typed, so it waits for the Owner.
  const jobs = await waits(await op("jobs", "jobs", call("")));
  expect(await shown(jobs)).toContain("gives: the commands and output of the last 100 jobs");

  // A target that does not exist refuses, because no approval could run the call.
  for (const [id, target, kind] of [
    ["job-cancel", "424242", "job"],
    ["card-time", "no-card", "card"],
  ] as const) {
    const missing = await op(id, `missing-${id}`, call(target, { endsAt: null }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining(`no such ${kind}`),
    });
  }

  // A rotation ends the approved jobs of a machine, so only the machine's own key rotates at once.
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES ('m2', ?)",
      JSON.stringify({
        id: "m2",
        name: "m2",
        labels: [],
        order: 1,
        serviceTokenId: "t2",
        clientId: "m2.access",
        tunnelId: "u2",
      }),
    ),
  );
  await evictDurableObject(stub);
  await waits(await op("machine-rotate-key", "rotate-other", call("m2")));
  const own = await op("machine-rotate-key", "rotate-own", call("vps"));
  expect(await own.json()).not.toMatchObject({ outcome: "waiting" });
});

/** K-1778: the token "script" of an actor of its own, in no circle; an Access token of it on the admin path. */
async function scriptToken() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    for (const [id, body] of actorRows([tokenActor("t-script", "script.access", "nightly backup")]))
      state.storage.sql.exec(ACTOR_ROW, id, body);
    state.storage.sql.exec("DELETE FROM proposals");
  });
  await evictDurableObject(stub);
  return accessToken(ADMIN, { common_name: "script.access" });
}

const post = (jwt: string, path: string, body: string) =>
  send(path, {
    method: "POST",
    headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json" },
    body,
  });

it("lets a token actor call /op: an unset right waits for the Owner, and another credential approves it (K-1778)", async () => {
  stubAccessCerts();
  await setup({});
  const jwt = await scriptToken();
  const order = call("vps", { order: 5 });
  const first = await post(jwt, "/op/machine-order", order);
  expect(first.status, await first.clone().text()).toBe(409);
  const { proposalId } = (await first.json()) as { proposalId: string };
  const stub = env.KITSHN.getByName("kitshn");
  const credential = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ credential: string; machine_id: string }>(
        "SELECT credential, machine_id FROM proposals WHERE id = ?",
        proposalId,
      )
      .one(),
  );
  expect(credential).toEqual({ credential: "token/t-script", machine_id: "" });
  type Decide = {
    decide(id: string, decision: "approved", by: object): Promise<{ ok: boolean; error?: string }>;
  };
  // The credential that asked never approves its own ask, also when the rules would let it (K-1778).
  const self = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Decide).decide(proposalId, "approved", {
      actor: { _tag: "device", clientId: "script.access", name: "nightly backup" },
      visitor: { email: null, clientId: "script.access", ip: null },
      machineId: null,
      reason: null,
    }),
  );
  expect(self).toMatchObject({ ok: false, error: expect.stringContaining("never approves its own ask") });
  const approved = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Decide).decide(proposalId, "approved", {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
      machineId: null,
      reason: null,
    }),
  );
  expect(approved).toMatchObject({ ok: true });
  const second = await post(jwt, "/op/machine-order", order);
  expect(second.status, await second.clone().text()).toBe(200);
  expect(await second.json()).toMatchObject({ outcome: "done", result: { order: 5 } });
});

it("lets a token raise access only by its shares: automatic runs, ask and default wait, off refuses, and a person gate stays (K-1778)", async () => {
  stubAccessCerts();
  const jwt = await scriptToken();
  const stub = env.KITSHN.getByName("kitshn");
  // The circle holds the admin card of the seed at (0, 40), so the token has control on the admin (K-104).
  const atAdmin = { x: 0, y: 40 };
  const added = tokenActor("t-new", "new.access", "new phone");
  const outcomes: Array<[string, number, unknown, boolean, boolean]> = [];
  for (const mode of ["automatic", "ask", "default", "off"] as const) {
    const script = tokenActor("t-script", "script.access", "nightly backup");
    const chip =
      mode === "default"
        ? { ...script, rights: { maintains: { mode: "automatic" as const } } }
        : mode === "ask"
          ? { ...script, rights: { shares: { mode, circleId: OWNER_CIRCLE_ID } } }
          : { ...script, rights: { shares: { mode }, secrets: { mode } } };
    await setup({}, null, atAdmin, [chip]);
    await runInDurableObject(stub, (_, state) => {
      insertActors(state.storage.sql, [added]);
      state.storage.sql.exec("DELETE FROM proposals");
    });
    await evictDurableObject(stub);
    const agents = await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
    );
    const before = JSON.parse(agents.body) as Circle;
    // K-715: a new member raises access.
    const edit = call("", {
      edits: [{ _tag: "circle", id: "agents", after: { ...before, members: [...before.members, added] } }],
    });
    const answer = await post(jwt, "/op/apply", edit);
    const after = await runInDurableObject(stub, (_, state) => ({
      members: (
        JSON.parse(
          state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one().body,
        ) as Circle
      ).members.length,
      asks: state.storage.sql
        .exec<{ right_name: string; circle_id: string }>("SELECT right_name, circle_id FROM proposals")
        .toArray(),
    }));
    const body = (await answer.json()) as { outcome: string; reason?: string };
    // K-104, K-1778: the map path holds the admin for a token only with "shares" and "secrets" automatic.
    const map = await send("/api/state", { headers: { "cf-access-jwt-assertion": jwt } });
    const resume = await post(jwt, "/op/resume", call(""));
    outcomes.push([
      mode,
      answer.status,
      { outcome: body.outcome, members: after.members - before.members.length, asks: after.asks },
      map.status === 200,
      resume.status === 403,
    ]);
  }
  expect(outcomes).toEqual([
    ["automatic", 200, { outcome: "done", members: 1, asks: [] }, true, true],
    ...(["ask", "default"] as const).map((mode) => [
      mode,
      409,
      { outcome: "waiting", members: 0, asks: [{ right_name: "shares", circle_id: OWNER_CIRCLE_ID }] },
      false,
      true,
    ]),
    ["off", 403, { outcome: "refused", members: 0, asks: [] }, false, true],
  ]);
});

it("reads the map through the gate, and caps the open asks of each credential at 20 (K-1777, K-1778)", async () => {
  stubAccessCerts();
  await setup({});
  const jwt = await scriptToken();
  // The token is in no agent circle, so "reads the map" asks the Owner like any unset right; the owner reads at once.
  const read = (token: string) => send("/op/state", { headers: { "cf-access-jwt-assertion": token } });
  const waiting = await read(jwt);
  expect(waiting.status).toBe(409);
  expect(await waiting.json()).toMatchObject({ outcome: "waiting" });
  const owner = await read(await accessToken(ADMIN, { email: "owner@example.com" }));
  expect(owner.status).toBe(200);
  expect(await owner.json()).toMatchObject({
    outcome: "done",
    result: { hidden: { jobs: expect.any(String) } },
  });
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    for (let index = 0; index < 20; index++)
      state.storage.sql.exec(
        `INSERT INTO proposals (id, machine_id, credential, action, target, body, reason, labels, right_name, circle_id, shown,
         shown_hash, state, created_at, expires_at, verified) VALUES (?, '', 'token/t-script', 'forward', 't', 'null', NULL, '{}',
         'owner', 'owner', 's', ?, 'pending', 0, ?, '[]')`,
        `p-cap-${index}`,
        `h-${index}`,
        Date.now() + 60_000,
      );
  });
  const capped = await post(jwt, "/op/machine-order", call("vps", { order: 9 }));
  expect(capped.status).toBe(409);
  expect(await capped.json()).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("20 open asks"),
  });
  // Another credential keeps its own 20.
  const key = await newMachineKey();
  await setup({ changes: { mode: "automatic" } }, key);
  const other = await forwarded(
    key,
    "POST",
    "/op/machine-labels",
    "cap-other-0123456789abcdef",
    call("vps", { labels: [] }),
    {},
    ADMIN,
  );
  expect(other.status).toBe(409);
  expect(await other.json()).toMatchObject({ outcome: "waiting" });
  await runInDurableObject(stub, (_, state) => state.storage.sql.exec("DELETE FROM proposals"));
});

it("allows a repo through /op only as an agent: a waiting repo under its own credential, never a blocked or taken one (K-819)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ runs: { mode: "automatic" } }, key);
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen, allowed_by_client, allowed_by_name) VALUES
       ('2001', 'acme/waiting', 'waiting', 1, NULL, NULL),
       ('2002', 'acme/blocked', 'blocked', 1, NULL, NULL),
       ('2003', 'acme/taken', 'allowed', 1, 'other.access', 'other agent')`,
    ),
  );
  await evictDurableObject(stub);
  const outcomes: Array<string> = [];
  for (const repo of ["2001", "2002", "2003"]) {
    const answer = await forwarded(
      key,
      "POST",
      "/op/repo-allow",
      `repo-allow-${repo}-0123456789abcdef`,
      call(repo),
      {},
      ADMIN,
    );
    outcomes.push(`${repo}: ${answer.status}`);
  }
  const rows = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ repo_id: string; state: string; allowed_by_client: string | null }>(
        "SELECT repo_id, state, allowed_by_client FROM repos WHERE repo_id IN ('2001', '2002', '2003') ORDER BY repo_id",
      )
      .toArray(),
  );
  expect({ outcomes, rows }).toEqual({
    outcomes: ["2001: 200", "2002: 409", "2003: 409"],
    rows: [
      { repo_id: "2001", state: "allowed", allowed_by_client: "vps.access" },
      { repo_id: "2002", state: "blocked", allowed_by_client: null },
      { repo_id: "2003", state: "allowed", allowed_by_client: "other.access" },
    ],
  });
});

it("lets an agent key with shares automatic move its own card into another circle on /agent/apply, but never edit a circle (K-1778)", async () => {
  stubAccessCerts();
  await setup({}, null, { x: 5000, y: 5000 }, [keyChip("t-key", "key.access", "kit key", { shares: true })]);
  const stub = env.KITSHN.getByName("kitshn");
  const owner = await runInDurableObject(stub, (_, state) => {
    const card: Resource = {
      id: "key-card",
      kind: "site.static",
      name: "key card",
      addresses: [],
      status: "unknown",
      group: null,
      machine: null,
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES ('key-card', ?)",
      JSON.stringify(card),
    );
    state.storage.sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('key-card', 5000, 5000)");
    return JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
  });
  await evictDurableObject(stub);
  const jwt = await accessToken("agent-aud", { common_name: "key.access" });
  const apply = (edits: ReadonlyArray<object>) => post(jwt, "/agent/apply", JSON.stringify({ edits }));
  const agents = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'agents'").one(),
  );
  const renamed = { ...(JSON.parse(agents.body) as Circle), name: "Mine" };
  const rename = await apply([{ _tag: "circle", id: "agents", after: renamed }]);
  const share = await apply([{ _tag: "place", id: "key-card", after: { x: owner.x, y: owner.y } }]);
  expect([rename.status, share.status]).toEqual([403, 200]);
});
