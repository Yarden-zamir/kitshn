import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { type Machine, connectText, fingerprintOf, newMachineKey, signText } from "../src/core/machine.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

it("counts the queued jobs of each machine from the job table, not from the newest jobs (K-515)", async () => {
  stubAccessCerts();
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) => {
    const job = (machineId: string, jobState: string, at: number) =>
      state.storage.sql.exec(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
         VALUES (?, '[]', '{"kind":"diagnostics"}', ?, ?, ?, 'owner@example.com', '{}', '')`,
        machineId,
        jobState,
        at,
        at + 3_600_000,
      );
    // One job waits for vps, and ten newer jobs of another machine push it out of the newest jobs.
    job("vps", "queued", 1);
    for (let index = 0; index < 10; index++) job("mac", "done", 100 + index);
  });
  const answer = await send("/api/state", {
    headers: { "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }) },
  });
  const snapshot = (await answer.json()) as {
    jobs: Array<{ machineId: string }>;
    queuedJobs: Record<string, number>;
  };
  expect(snapshot.jobs.some((job) => job.machineId === "vps")).toBe(false);
  expect(snapshot.queuedJobs).toEqual({ vps: 1 });
});

it("sends the maps the queued count after a reconnect hands the jobs to the machine (K-515)", async () => {
  const queuedAtUpdates = await runInDurableObject(
    env.KITSHN.getByName("machine-reconnect"),
    (instance, state) => {
      const kitshn = instance as unknown as {
        load(): void;
        broadcast(): void;
        acceptMachine(socket: WebSocket, attachment: object): void;
      };
      const machine: Machine = {
        id: "vps",
        name: "vps",
        labels: [],
        order: 0,
        serviceTokenId: "token-vps",
        clientId: "vps.access",
        tunnelId: "tunnel-vps",
        key: { kind: "public", publicKey: "key", fingerprint: "print", since: 0 },
      };
      state.storage.sql.exec("INSERT INTO machines (id, body) VALUES (?, ?)", "vps", JSON.stringify(machine));
      // A job that kitshn made itself goes to any connected machine (K-614).
      state.storage.sql.exec(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
       VALUES ('vps', '[]', '{"kind":"diagnostics"}', 'queued', ?, ?, 'owner@example.com', '{"kitshn":true,"clientId":null}', '')`,
        Date.now(),
        Date.now() + 3_600_000,
      );
      kitshn.load();
      const queued: Array<number> = [];
      const broadcast = kitshn.broadcast.bind(kitshn);
      kitshn.broadcast = () => {
        queued.push(
          state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").one()
            .n,
        );
        broadcast();
      };
      const [, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      state.acceptWebSocket(server, ["vps"]);
      kitshn.acceptMachine(server, {
        kind: "machine",
        machineId: "vps",
        since: Date.now(),
        challenge: "c",
        check: "signed",
        answered: true,
        rotateBy: null,
        status: null,
        sample: null,
      });
      const sent = state.storage.sql.exec<{ state: string }>("SELECT state FROM jobs").one().state;
      return { queued, sent };
    },
  );
  expect(queuedAtUpdates.sent).toBe("sent");
  // The machine took its job, so the last map update counts none.
  expect(queuedAtUpdates.queued.at(-1)).toBe(0);
});

it("sends a daemon of another protocol major only care jobs at connect, from the protocol of its answer (K-724)", async () => {
  const key = await newMachineKey();
  const fingerprint = await fingerprintOf(key.x);
  const outcome = await runInDurableObject(
    env.KITSHN.getByName("protocol-connect"),
    async (instance, state) => {
      const kitshn = instance as unknown as {
        load(): void;
        webSocketMessage(socket: WebSocket, data: string): Promise<void>;
      };
      const machine: Machine = {
        id: "vps",
        name: "vps",
        labels: [],
        order: 0,
        serviceTokenId: "token-vps",
        clientId: "vps.access",
        tunnelId: "tunnel-vps",
        key: { kind: "public", publicKey: key.x, fingerprint, since: 0 },
      };
      state.storage.sql.exec("INSERT INTO machines (id, body) VALUES (?, ?)", "vps", JSON.stringify(machine));
      const job = (command: object) =>
        state.storage.sql.exec(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
         VALUES ('vps', '[]', ?, 'queued', ?, ?, '{"_tag":"kitshn","reason":"test"}', '{"kitshn":true,"clientId":null}', '')`,
          JSON.stringify(command),
          Date.now(),
          Date.now() + 3_600_000,
        );
      job({ kind: "shell", script: "true" });
      job({ kind: "diagnostics" });
      kitshn.load();
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      state.acceptWebSocket(server, ["vps"]);
      client.accept();
      const received: Array<{ type: string; command?: { kind: string } }> = [];
      client.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
      server.serializeAttachment({
        kind: "machine",
        machineId: "vps",
        since: Date.now(),
        challenge: "c",
        check: "waiting",
        answered: false,
        rotateBy: null,
        status: null,
        sample: null,
      });
      const signature = await signText(key, connectText("kit.example.com", "vps", "c"));
      // No status yet: the answer alone names the protocol.
      await kitshn.webSocketMessage(server, JSON.stringify({ type: "answer", signature, protocol: "3.0.0" }));
      const jobsNow = () =>
        state.storage.sql
          .exec<{ command: string; state: string }>("SELECT command, state FROM jobs ORDER BY id")
          .toArray()
          .map((row) => `${(JSON.parse(row.command) as { kind: string }).kind} ${row.state}`);
      const atConnect = jobsNow();
      server.close(1000, "test over");
      return { atConnect, received };
    },
  );
  expect(outcome.atConnect).toEqual(["shell queued", "diagnostics sent"]);
  await vi.waitFor(() => expect(outcome.received.map((message) => message.type)).toContain("accepted"));
});
