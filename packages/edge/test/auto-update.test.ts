import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProviderReport } from "@kitshn/local";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

const NEW = "aaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbb";
const machine: Machine = {
  key: { kind: "public", publicKey: "x", fingerprint: "f", since: 0 },
  id: "auto",
  name: "auto",
  labels: [],
  order: 0,
  serviceTokenId: "token-auto",
  clientId: "auto.access",
  tunnelId: "tunnel-auto",
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** The machine "auto" with its card in the Owner circle, so the owner has control on it (K-614). */
async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("DELETE FROM providers");
    state.storage.sql.exec("DELETE FROM jobs WHERE machine_id = 'auto'");
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'daemon_rollout'");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      machine.id,
      JSON.stringify(machine),
    );
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: machine.id,
      kind: "machine",
      name: machine.name,
      addresses: [],
      status: "running",
      group: null,
      machine: machine.id,
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      card.id,
      JSON.stringify(card),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
      card.id,
      owner.x,
      owner.y,
    );
  });
  await evictDurableObject(stub);
  return stub;
}

const busyReport = (busy: boolean): ProviderReport => ({
  name: "t3",
  online: true,
  kinds: [{ id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } }],
  commands: [],
  resources: [
    {
      id: "app",
      kind: "t3.app",
      name: "T3 on auto",
      status: "running",
      facts: [{ label: "busy", value: String(busy), role: "busy" }],
    },
  ],
});

/**
 * Runs `scenario` on a Worker of a release, with a signed daemon socket of "auto" that is online, then closes the
 * socket, because an open one keeps the Durable Object busy and the next test evicts it.
 */
async function withDaemon(
  scenario: (tools: {
    readonly daemon: (message: object) => Promise<void>;
    readonly jobs: () => Array<{ state: string; command: string; when_idle: number; output: string }>;
    readonly kitshn: { commit(actor: object, changes: Array<object>, undo: null): number | null };
    /** K-627: the stored rollout. */
    readonly rollout: () => unknown;
  }) => Promise<void>,
) {
  const stub = await setup();
  await runInDurableObject(stub, async (instance, state) => {
    const kitshn = instance as unknown as {
      env: { KITSHN_VERSION: string };
      setPresence(machineId: string, online: boolean): void;
      commit(actor: object, changes: Array<object>, undo: null): number | null;
    };
    // The Worker of a release, so there is a release to update to (K-617).
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: NEW };
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1], [machine.id, "machines"]);
    pair[0].accept();
    pair[1].serializeAttachment({
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    });
    // As the accepted challenge does (K-1704).
    kitshn.setPresence(machine.id, true);
    try {
      await scenario({
        daemon: (message) => instance.webSocketMessage(pair[1], JSON.stringify(message)),
        jobs: () =>
          state.storage.sql
            .exec<{ state: string; command: string; when_idle: number; output: string }>(
              "SELECT state, command, when_idle, output FROM jobs WHERE machine_id = ?",
              machine.id,
            )
            .toArray(),
        kitshn,
        rollout: () =>
          JSON.parse(
            state.storage.sql
              .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'daemon_rollout'")
              .one().value,
          ),
      });
    } finally {
      pair[1].close(1000, "test over");
    }
  });
}

const behindStatus = {
  type: "status",
  status: {
    version: OLD,
    os: "Linux 6",
    arch: "x64",
    hostname: "auto",
    tunnel: "running",
    capabilities: ["update", "update-gz"],
  },
};

it("starts the rollout after a release wake when a signed daemon socket kept its old status (K-627)", async () => {
  const stub = await setup();
  await runInDurableObject(stub, (instance, state) => {
    const kitshn = instance as unknown as {
      env: { KITSHN_VERSION: string };
      setPresence(machineId: string, online: boolean): void;
      autoUpdate(): boolean;
      resumeAutoUpdatesAfterWake(): void;
    };
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: NEW };
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1], [machine.id, "machines"]);
    pair[0].accept();
    pair[1].serializeAttachment({
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: behindStatus.status,
      sample: null,
    });
    kitshn.setPresence(machine.id, true);
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_rollout_seen_version', ?)",
      OLD,
    );
    const jobs = () =>
      state.storage.sql
        .exec<{ state: string; command: string }>(
          "SELECT state, command FROM jobs WHERE machine_id = ?",
          machine.id,
        )
        .toArray();
    try {
      expect(jobs()).toEqual([]);
      const failure = vi.spyOn(kitshn, "autoUpdate").mockImplementationOnce(() => {
        throw new Error("synthetic rollout failure");
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      kitshn.resumeAutoUpdatesAfterWake();
      expect(jobs()).toEqual([]);
      expect(logged).toHaveBeenCalledOnce();
      expect(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'daemon_rollout_seen_version'")
          .one().value,
      ).toBe(OLD);
      failure.mockRestore();
      // No new status message or socket reconnect occurs: the attachment came through the wake.
      kitshn.resumeAutoUpdatesAfterWake();
      expect(jobs()).toEqual([{ state: "sent", command: JSON.stringify({ kind: "update", version: NEW }) }]);
      kitshn.resumeAutoUpdatesAfterWake();
      expect(jobs()).toHaveLength(1);
    } finally {
      pair[1].close(1000, "test over");
    }
  });
});

it("tells an already-open map when a release wake starts an update (K-628)", async () => {
  const stub = await setup();
  const received: Array<unknown> = [];
  const sockets = await runInDurableObject(stub, (instance, state) => {
    const kitshn = instance as unknown as {
      env: { KITSHN_VERSION: string };
      setPresence(machineId: string, online: boolean): void;
      resumeAutoUpdatesAfterWake(): void;
    };
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: NEW };
    const daemon = new WebSocketPair();
    state.acceptWebSocket(daemon[1], [machine.id, "machines"]);
    daemon[0].accept();
    daemon[1].serializeAttachment({
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: behindStatus.status,
      sample: null,
    });
    kitshn.setPresence(machine.id, true);
    const map = new WebSocketPair();
    state.acceptWebSocket(map[1], ["map"]);
    map[0].accept();
    map[0].addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    map[1].serializeAttachment({
      kind: "map",
      caller: {
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        actor: { _tag: "person", email: "owner@example.com" },
      },
    });
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('daemon_rollout_seen_version', ?)",
      OLD,
    );
    kitshn.resumeAutoUpdatesAfterWake();
    kitshn.resumeAutoUpdatesAfterWake();
    return [daemon[1], map[1]];
  });
  try {
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "snapshot",
          snapshot: expect.objectContaining({
            jobs: expect.arrayContaining([
              expect.objectContaining({
                machineId: machine.id,
                state: "sent",
                command: { kind: "update", version: NEW },
              }),
            ]),
          }),
        }),
      ),
    );
    expect(received).toHaveLength(1);
  } finally {
    await runInDurableObject(stub, () => sockets.forEach((socket) => socket.close(1000, "test over")));
  }
});

it("lets a BEHIND daemon wait while a provider is busy, with no job that holds the rollout, and updates it once idle (K-627)", async () => {
  await withDaemon(async ({ daemon, jobs, rollout }) => {
    await daemon({ type: "providers", providers: [busyReport(true)] });
    await daemon(behindStatus);
    await daemon(behindStatus);
    // A busy machine gets no job yet, so it holds no step; its wait starts.
    expect(jobs()).toEqual([]);
    expect(rollout()).toMatchObject({ step: null, busySince: { [machine.id]: expect.any(Number) } });
    // The report that ends `busy` brings the update at once.
    await daemon({ type: "providers", providers: [busyReport(false)] });
    expect(jobs().map(({ output: _output, ...job }) => job)).toEqual([
      { state: "sent", command: JSON.stringify({ kind: "update", version: NEW }), when_idle: 1 },
    ]);
    expect(rollout()).toMatchObject({ step: { machineId: machine.id }, busySince: {} });
  });
});

it("ends the wait of a busy machine when the owner turns the setting off (K-626)", async () => {
  await withDaemon(async ({ daemon, jobs, kitshn, rollout }) => {
    await daemon({ type: "providers", providers: [busyReport(true)] });
    await daemon(behindStatus);
    expect(rollout()).toMatchObject({ busySince: { [machine.id]: expect.any(Number) } });
    kitshn.commit(
      { _tag: "person", email: "owner@example.com" },
      [{ _tag: "autoUpdate", id: machine.id, before: true, after: false }],
      null,
    );
    // The machine neither waits nor holds the rollout, and it gets no update.
    expect(rollout()).toMatchObject({ step: null, failed: null, busySince: {} });
    expect(jobs()).toEqual([]);
  });
});

it("turns Update daemon automatically off in one revision that History can undo (K-626)", async () => {
  stubAccessCerts();
  await setup();
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  const post = (path: string, body: object) =>
    send(path, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const stored = () =>
    runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) => {
      const body = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM machines WHERE id = ?", machine.id).one()
          .body,
      ) as Machine;
      const revision = state.storage.sql
        .exec<{ id: number; summary: string }>("SELECT id, summary FROM revisions ORDER BY id DESC LIMIT 1")
        .one();
      return { autoUpdate: body.autoUpdate, revision };
    });
  expect((await post(`/api/machines/${machine.id}`, { autoUpdate: false })).status).toBe(200);
  const off = await stored();
  expect(off.autoUpdate).toBe(false);
  expect(off.revision.summary).toContain("Turned off Update daemon automatically for auto");
  expect((await post("/api/undo", { revision: off.revision.id })).status).toBe(200);
  expect((await stored()).autoUpdate).toBeUndefined();
});
