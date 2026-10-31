// K-723: the contract scenarios C-1 to C-18 (contract-review-2026-10-30.md, section 10), against a real daemon and
// the fake edge. The reference provider is the line client: each scenario sends the lines that a provider sends.
import type { DaemonMessage } from "@kitshn/edge/machine";
import type { Answer } from "@kitshn/local";
import assert from "node:assert/strict";
import { type LineClient, lineClient } from "./client.ts";
import { type Daemon, GRACE_MS, MACHINE_ID, PING_MS } from "./daemon.ts";
import { TEAM } from "./edge.ts";

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly run: (daemon: Daemon) => Promise<void>;
}

const PROVIDER = "ref";
const kinds = [
  { id: "ref.app", name: "app", levels: { view: "view", use: "use", control: "control" } },
  { id: "ref.thread", name: "thread", levels: { view: "view", use: "send" } },
];
const app = { id: "app", kind: "ref.app", name: "Reference", status: "running" };
const thread = (id: string, more: object = {}) => ({
  id,
  kind: "ref.thread",
  name: id,
  status: "running",
  ...more,
});

const register = (client: LineClient, more: Record<string, unknown> = {}) =>
  client.request({
    type: "register",
    protocol: 2,
    provider: PROVIDER,
    instance: "i-1",
    kinds,
    commands: [{ id: "restart", title: "Restart", kinds: ["ref.app"], confirm: false }],
    resources: [app, thread("th-1", { parent: "app" })],
    ...more,
  });

const ok = <T extends Answer["type"]>(answer: Answer, type: T): Extract<Answer, { type: T }> => {
  if (answer.type === "error") throw new Error(`the daemon refused: ${answer.error}`);
  assert.equal(answer.type, type);
  return answer as Extract<Answer, { type: T }>;
};

const is =
  <T extends Answer["type"]>(type: T) =>
  (event: Answer): event is Extract<Answer, { type: T }> =>
    event.type === type;
const from =
  <T extends DaemonMessage["type"]>(
    type: T,
    match: (message: Extract<DaemonMessage, { type: T }>) => boolean = () => true,
  ) =>
  (message: DaemonMessage): message is Extract<DaemonMessage, { type: T }> =>
    message.type === type && match(message as Extract<DaemonMessage, { type: T }>);

const status = async (daemon: Daemon) => {
  const client = await lineClient(daemon.socket);
  try {
    return ok(await client.request({ type: "status" }), "status").status;
  } finally {
    client.close();
  }
};

/** A provider client that registered. */
const provider = async (daemon: Daemon, more: Record<string, unknown> = {}) => {
  const client = await lineClient(daemon.socket);
  ok(await register(client, more), "register");
  return client;
};

/** Pushes the Access team and the grant tables of the reference provider, as kitshn does. */
const pushAccess = (daemon: Daemon, tables: Record<string, unknown>) => {
  daemon.edge.send({
    type: "access",
    provider: PROVIDER,
    access: { teamDomain: TEAM, audiences: ["aud-contract"], served: [] },
  });
  daemon.edge.send({ type: "grants", provider: PROVIDER, tables });
};
const grant = (
  rules: ReadonlyArray<object>,
  level: string,
  more: { match?: "all"; endsAt?: number } = {},
) => ({
  circle: { id: `c-${level}`, name: level, match: more.match ?? "any", needsPasskey: false, rules },
  level,
  endsAt: more.endsAt ?? null,
});
const pushed = (daemon: Daemon, key: string) =>
  daemon.edge.next(from("applied", (message) => message.key === key));

/** One exec of the reference provider through the loop-back relay, with every frame until its exit. */
async function exec(client: LineClient, body: Record<string, unknown>) {
  const answer = ok(await client.request({ type: "exec", target: MACHINE_ID, ...body }), "exec");
  const exit = await client.next(
    (event): event is Extract<Answer, { type: "exec-exit" }> =>
      event.type === "exec-exit" && event.execId === answer.execId,
    true,
  );
  const output = client.events
    .filter((event) => event.type === "exec-output" && event.execId === answer.execId)
    .map((event) =>
      Buffer.from((event as Extract<Answer, { type: "exec-output" }>).data, "base64").toString(),
    )
    .join("");
  return { answer, exit, output };
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: "C-1",
    title: "register with protocol 2 gets the machine, the capabilities, syncedAt and the ping timing",
    run: async (daemon) => {
      const client = await lineClient(daemon.socket);
      const answer = ok(await register(client), "register");
      assert.equal(answer.protocol, 2);
      assert.equal(answer.machine.id, MACHINE_ID);
      for (const capability of ["check", "exec", "attest", "ping"])
        assert.ok(answer.capabilities.includes(capability));
      assert.equal(typeof answer.syncedAt, "number");
      assert.deepEqual([answer.pingMs, answer.graceMs], [PING_MS, GRACE_MS]);
      assert.deepEqual(answer.problems, []);
      // A non-provider can discover the same current link without reserving a provider name.
      assert.equal(typeof answer.linkSocket, "string");
      assert.equal((await status(daemon)).linkSocket, answer.linkSocket);
    },
  },
  {
    id: "C-2",
    title: "register with protocol 3 is refused with both versions, and status shows it",
    run: async (daemon) => {
      const client = await lineClient(daemon.socket);
      const answer = await register(client, { protocol: 3 });
      assert.equal(answer.type, "error");
      assert.match((answer as { error: string }).error, /protocol 2.*3/);
      assert.ok((await status(daemon)).refusedProviders?.some((item) => item.provider === PROVIDER));
    },
  },
  {
    id: "C-3",
    title: "register with one bad row is taken; the row is dropped and named in problems and status",
    run: async (daemon) => {
      const client = await lineClient(daemon.socket);
      const list = {
        id: "tasks",
        title: "Tasks",
        columns: [{ id: "n", title: "N" }],
        rows: [
          { id: "ok", cells: { n: "1" } },
          { id: "x".repeat(201), cells: { n: "2" } },
        ],
      };
      const answer = ok(
        await register(client, { resources: [app, thread("th-1", { lists: [list] })] }),
        "register",
      );
      assert.deepEqual(
        answer.problems.map((problem) => problem.path),
        ["resources[1].lists[0].rows[1]"],
      );
      const state = (await status(daemon)).providers?.find((item) => item.name === PROVIDER);
      assert.equal(state?.problems.length, 1);
    },
  },
  {
    id: "C-4",
    title: "a second instance is refused while the first holds the provider, and the first keeps working",
    run: async (daemon) => {
      const first = await provider(daemon);
      const second = await lineClient(daemon.socket);
      const refused = await register(second, { instance: "i-2" });
      assert.equal(refused.type, "error");
      assert.match((refused as { error: string }).error, /instance i-1/);
      ok(await first.request({ type: "upsert", provider: PROVIDER, resources: [thread("th-2")] }), "upsert");
    },
  },
  {
    id: "C-5",
    title:
      "the same instance takes over with a command in flight; the result from the new connection settles the job",
    run: async (daemon) => {
      const first = await provider(daemon);
      daemon.edge.send({
        type: "job",
        id: 7,
        command: { kind: "provider", provider: PROVIDER, command: "restart", resource: "app" },
      });
      const command = await first.next(is("command"));
      assert.equal(command.row, null);
      assert.ok(command.deadline > Date.now());
      const second = await provider(daemon);
      const moved = await second.next(is("command"), true);
      ok(
        await second.request({
          type: "command-result",
          provider: PROVIDER,
          commandId: moved.commandId,
          ok: true,
          output: "restarted",
        }),
        "command-result",
      );
      const result = await daemon.edge.next(
        from("jobResult", (message) => message.id === 7),
        true,
      );
      assert.equal(result.result.ok, true);
      await first.closed;
    },
  },
  {
    id: "C-6",
    title:
      "after a daemon stop the provider sees the end at once, registers again, and a queued command arrives",
    run: async (daemon) => {
      const client = await provider(daemon);
      await daemon.signal("SIGTERM");
      await client.closed;
      await daemon.start();
      const again = await provider(daemon);
      daemon.edge.send({
        type: "job",
        id: 8,
        command: { kind: "provider", provider: PROVIDER, command: "restart", resource: "app" },
      });
      await again.next(is("command"));
    },
  },
  {
    id: "C-8",
    title: "a provider that stops answering pings is dropped within the grace time and shows offline",
    run: async (daemon) => {
      const client = await provider(daemon);
      await daemon.edge.next(
        from("providers", (message) => message.providers.some((item) => item.online)),
        true,
      );
      client.quiet = true;
      await client.closed;
      await daemon.edge.next(
        from("providers", (message) =>
          message.providers.some((item) => item.name === PROVIDER && !item.online),
        ),
      );
    },
  },
  {
    id: "C-9",
    title:
      "check gives person, device, machine, IP and everyone their levels; a machine token never matches a device rule",
    run: async (daemon) => {
      const client = await provider(daemon);
      pushAccess(daemon, {
        app: [
          grant(
            [{ email: "owner@example.com" }, { machine: { machineId: "mac", clientId: "mac.access" } }],
            "control",
          ),
          grant(
            [
              { device: { clientId: "mac.access", name: "same id" } },
              { device: { clientId: "phone.access", name: "Pixel" } },
            ],
            "use",
          ),
          grant([{ ip: "10.0.0.0/8" }], "view"),
          grant([{ email: "her@example.com" }, { unknown: "future" }], "control", { match: "all" }),
        ],
        "th-1": [grant([{ everyone: true }], "view")],
      });
      await pushed(daemon, `grants:${PROVIDER}`);
      const header = async (claims: Record<string, unknown>, more?: { aud?: string; exp?: number }) => ({
        "cf-access-jwt-assertion": await daemon.edge.token(claims, more),
      });
      const answer = ok(
        await client.request({
          type: "check",
          requests: [
            { key: "person", headers: await header({ email: "Owner@Example.com" }) },
            { key: "machine", headers: await header({ common_name: "mac.access" }) },
            { key: "device", headers: await header({ common_name: "phone.access" }) },
            {
              key: "ip",
              headers: { ...(await header({ email: "x@other.org" })), "cf-connecting-ip": "10.2.3.4" },
            },
            { key: "all", headers: await header({ email: "her@example.com" }) },
            { key: "anonymous", headers: { "cf-connecting-ip": "10.2.3.4" } },
            {
              key: "expired",
              headers: await header({ email: "a@b.c" }, { exp: Math.floor(Date.now() / 1000) - 60 }),
            },
            { key: "invalid", headers: await header({ email: "a@b.c" }, { aud: "other" }) },
            { key: "unknown", headers: await header({ common_name: "stranger.access" }) },
          ],
        }),
        "check",
      );
      const byKey = Object.fromEntries(answer.results.map((result) => [result.key, result]));
      assert.deepEqual(byKey["person"], {
        key: "person",
        subject: { type: "person", id: "owner@example.com", name: "owner@example.com" },
        levels: { app: "control", "th-1": "view" },
        rights: [],
        until: (byKey["person"] as { until: number }).until,
      });
      assert.deepEqual((byKey["machine"] as { levels: object }).levels, { app: "control", "th-1": "view" });
      assert.deepEqual((byKey["device"] as { levels: object }).levels, { app: "use", "th-1": "view" });
      assert.deepEqual((byKey["ip"] as { levels: object }).levels, { app: "view", "th-1": "view" });
      // An "all" circle with a rule of an unknown type never matches.
      assert.deepEqual((byKey["all"] as { levels: object }).levels, { "th-1": "view" });
      assert.deepEqual(byKey["anonymous"], { key: "anonymous", anonymous: true });
      for (const [key, code] of [
        ["expired", "expired"],
        ["invalid", "invalid"],
        ["unknown", "unknown-subject"],
      ] as const)
        assert.equal((byKey[key] as { refused: { code: string } }).refused.code, code);
    },
  },
  {
    id: "C-10",
    title: "a grant change sends grants-changed, and the next check gives the lower level",
    run: async (daemon) => {
      const client = await provider(daemon);
      pushAccess(daemon, { app: [grant([{ email: "a@example.com" }], "control")] });
      await pushed(daemon, `grants:${PROVIDER}`);
      daemon.edge.send({
        type: "grants",
        provider: PROVIDER,
        tables: { app: [grant([{ email: "a@example.com" }], "view")] },
      });
      await client.next(is("grants-changed"));
      const headers = { "cf-access-jwt-assertion": await daemon.edge.token({ email: "a@example.com" }) };
      const answer = ok(await client.request({ type: "check", requests: [{ key: "s", headers }] }), "check");
      assert.deepEqual((answer.results[0] as { levels: object }).levels, { app: "view" });
    },
  },
  {
    id: "C-11",
    title: "until is the earliest of the token expiry, a grant end and syncedAt plus 24 hours",
    run: async (daemon) => {
      const client = await provider(daemon);
      const endsAt = Date.now() + 60_000;
      pushAccess(daemon, { app: [grant([{ email: "a@example.com" }], "control", { endsAt })] });
      await pushed(daemon, `grants:${PROVIDER}`);
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const headers = {
        "cf-access-jwt-assertion": await daemon.edge.token({ email: "a@example.com" }, { exp }),
      };
      const answer = ok(await client.request({ type: "check", requests: [{ key: "s", headers }] }), "check");
      assert.equal((answer.results[0] as { until: number }).until, endsAt);
    },
  },
  {
    id: "C-12",
    title: "attest: an active token gives prefixed labels, an inactive one and a silent one refuse the ask",
    run: async (daemon) => {
      const client = await provider(daemon);
      const agent = await lineClient(daemon.socket);
      daemon.edge.ask = () => ({ outcome: "done", result: null });
      const answerNext = (active: boolean) =>
        void client.next(is("attest")).then((event) =>
          client.request({
            type: "attest-result",
            attestId: event.attestId,
            active,
            ...(active ? { labels: { "thread.id": "th-1" } } : {}),
          }),
        );
      answerNext(true);
      ok(
        await agent.request({ type: "ask", action: "state", target: "", attest: `${PROVIDER}:token-a` }),
        "ask",
      );
      const sent = await daemon.edge.next(from("ask"), true);
      assert.deepEqual(sent.ask.attested, { "ref.thread.id": "th-1" });
      answerNext(false);
      const inactive = ok(
        await agent.request({ type: "ask", action: "state", target: "", attest: `${PROVIDER}:token-b` }),
        "ask",
      );
      assert.equal(inactive.outcome, "refused");
      // No answer: the ask is refused after 2 s.
      const silent = ok(
        await agent.request({ type: "ask", action: "state", target: "", attest: `${PROVIDER}:token-c` }),
        "ask",
      );
      assert.match((silent as { reason: string }).reason, /did not attest within 2 s/);
    },
  },
  {
    id: "C-13",
    title:
      "exec streams output and the exit code, ends a timeout with a signal, and ends a refused, waiting or offline run",
    run: async (daemon) => {
      const client = await provider(daemon);
      const done = await exec(client, { command: "echo hi; exit 3" });
      assert.equal(done.answer.state, "running");
      assert.deepEqual([done.output, done.exit.exitCode, done.exit.reason], ["hi\n", 3, null]);
      const fed = ok(
        await client.request({ type: "exec", target: MACHINE_ID, command: "cat", stdin: true }),
        "exec",
      );
      ok(
        await client.request({
          type: "exec-input",
          execId: fed.execId,
          data: Buffer.from("piped").toString("base64"),
        }),
        "exec-input",
      );
      await client.next(is("exec-stdin-credit"));
      ok(await client.request({ type: "exec-close", execId: fed.execId, what: "stdin" }), "exec-close");
      await client.next(
        (event): event is Extract<Answer, { type: "exec-exit" }> =>
          event.type === "exec-exit" && event.execId === fed.execId,
        true,
      );
      const timeout = await exec(client, { command: "sleep 30", timeoutSeconds: 1 });
      assert.deepEqual([timeout.exit.exitCode, timeout.exit.signal], [null, "SIGKILL"]);
      daemon.edge.exec = { mode: "refuse", reason: 'the right "runs commands" is off' };
      const refused = await exec(client, { command: "true" });
      assert.deepEqual(
        [refused.answer.state, refused.exit.reason],
        ["ended", 'refused: the right "runs commands" is off'],
      );
      daemon.edge.exec = { mode: "offline" };
      assert.equal((await exec(client, { command: "true" })).exit.reason, "the target is offline");
      daemon.edge.exec = { mode: "wait", proposalId: "p-1" };
      const waiting = ok(await client.request({ type: "exec", target: MACHINE_ID, command: "true" }), "exec");
      assert.deepEqual([waiting.state, waiting.proposalId], ["waiting", "p-1"]);
      daemon.edge.send({ type: "askResult", proposalId: "p-1", outcome: "denied", reason: "not now" });
      const denied = await client.next(is("exec-exit"));
      assert.equal(denied.reason, "refused: the ask was denied (not now)");
    },
  },
  {
    id: "C-16",
    title: "desired-set with a rev: the next desired event carries that rev",
    run: async (daemon) => {
      const client = await provider(daemon, {
        kinds: [
          ...kinds,
          {
            id: "ref.settings",
            name: "settings",
            levels: { view: "view" },
            state: { schema: { type: "object" } },
          },
        ],
      });
      ok(
        await client.request({
          type: "desired-set",
          provider: PROVIDER,
          kind: "ref.settings",
          part: "shared",
          value: { a: 1 },
          rev: "r-1",
        }),
        "desired-set",
      );
      const event = await client.next(is("desired"), true);
      assert.deepEqual([event.kind, event.rev, event.state.shared], ["ref.settings", "r-1", { a: 1 }]);
    },
  },
];

/**
 * K-723: the scenarios that other tests cover, with where. C-14 and C-15 need a second machine or other local users,
 * which a CI runner does not have; C-7 and C-17 are rules of the provider; C-18 is a rule of kitshn's rollout.
 */
export const ELSEWHERE: Readonly<Record<string, string>> = {
  "C-7":
    "the provider's own rule: it drops the connection when no line came for graceMs; --provider checks it (P-7)",
  "C-14":
    "packages/daemon/src/link.test.ts: the link proxy adds the machine token and refuses an unreached card",
  "C-15": "packages/daemon/src/peer.test.ts and local.test.ts: who may open each socket",
  "C-17": "the provider skips an unknown event; @kitshn/local readAnswer returns null for one (local tests)",
  "C-18": "packages/edge rollout tests: a busy provider no longer holds the daemon update (K-627)",
};
