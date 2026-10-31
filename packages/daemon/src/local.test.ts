import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request } from "@kitshn/local";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeSession,
  type Caller,
  type LocalOptions,
  askLocal,
  bridgeLocal,
  listenLocal,
  sharedFolderProblem,
} from "./local.ts";
import type { Platform } from "./service.ts";

const platform: Platform = process.platform === "darwin" ? "darwin" : "linux";
const own = process.getuid!();
const daemonPeer = { platform, daemonUid: own } as const;

/** A folder name directly in /tmp, as the shared socket needs (root's, with the sticky bit); never a live one. */
const sharedTestFolder = () => join("/tmp", `kitshn-test-${randomUUID()}`);

/** A daemon on a socket in a new temporary folder, never the path of a live daemon. */
async function daemon(
  decide: LocalOptions["decide"],
  access: LocalOptions["access"] = "private",
  maxLineLength?: number,
) {
  const folder =
    access === "shared" ? sharedTestFolder() : join(mkdtempSync(join(tmpdir(), "kitshn-local-")), "kitshn");
  const path = join(folder, "kitshn.sock");
  const peers: Array<number | null> = [];
  const callers: Array<Caller> = [];
  const closed = Promise.withResolvers<number>();
  const refusals: Array<{ provider: string; reason: string }> = [];
  const server = await listenLocal(path, {
    platform,
    refused: (provider, reason) => refusals.push({ provider, reason }),
    ...(maxLineLength === undefined ? {} : { maxLineLength }),
    closed: closed.resolve,
    decide: (peer) => {
      peers.push(peer);
      return decide(peer);
    },
    handle: (request, caller) => {
      callers.push(caller);
      // A forward comes back as it went, so a test sends a long line each way.
      if (request.type === "forward")
        return Promise.resolve({
          id: request.id,
          type: "forward",
          status: 200,
          contentType: "",
          body: request.body ?? "",
        });
      if (request.type !== "status") throw new Error(`no ${request.type} here`);
      return Promise.resolve({
        id: request.id,
        type: "status",
        status: {
          version: "dev",
          machineId: "m1",
          fingerprint: null,
          connection: "disconnected",
          tunnel: "stopped",
        },
      });
    },
    log: () => {},
    access,
  });
  const stop = () => {
    server.stop();
    if (access === "shared") rmSync(folder, { recursive: true, force: true });
  };
  return { path, peers, callers, refusals, closed: closed.promise, [Symbol.dispose]: stop };
}

/** Sends raw lines, as a provider with a bug would, and collects the answer lines. node:net buffers a long write. */
function raw(path: string, text: string, answers: number): Promise<Array<unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const socket = createConnection(path, () => socket.write(text));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      // Only newline-terminated lines count; a chunk can end inside an answer.
      const lines = buffer.split("\n").slice(0, -1);
      if (lines.length < answers) return;
      socket.end();
      resolve(lines.map((value) => JSON.parse(value) as unknown));
    });
    socket.on("error", reject);
  });
}

const status: Request = { id: "1", type: "status" };

describe("local socket (K-701, K-702)", () => {
  it("sends a line far longer than the socket buffer whole, both ways", async () => {
    using local = await daemon(() => ({ accept: true }));
    const body = Buffer.alloc(1024 * 1024, "kitshn ✓ ").toString("base64");
    const outcome = await askLocal(
      local.path,
      { id: "1", type: "forward", method: "POST", path: "/agent/library", body },
      5000,
      daemonPeer,
    );
    expect(outcome).toMatchObject({ kind: "answer", answer: { type: "forward", body } });
  });

  it("joins a provider's stdin and stdout to one connection, line by line (K-704)", async () => {
    using local = await daemon(() => ({ accept: true }));
    // A provider keeps stdin open while it runs; it ends here after the answer, as a provider that exits.
    const answered = Promise.withResolvers<void>();
    async function* input() {
      yield new TextEncoder().encode(`${JSON.stringify(status)}\n`);
      await answered.promise;
    }
    let output = "";
    const decoder = new TextDecoder();
    const bridge = bridgeLocal(local.path, daemonPeer, input(), (text) => {
      output += decoder.decode(text, { stream: true });
      if (output.endsWith("\n")) answered.resolve();
    });
    expect(await bridge).toBe("closed");
    expect(JSON.parse(output.trim())).toMatchObject({ id: "1", type: "status" });
    // A socket of another user gets no line (K-701).
    await expect(
      bridgeLocal(local.path, { platform, daemonUid: own + 1 }, input(), () => {}),
    ).rejects.toThrow(/kitshn sent nothing/);
  });

  it("ends `kitshn provider` with an error when the daemon closes its connection, also while stdin stays open (K-704)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-local-")), "kitshn.sock");
    // The test daemon closes the connection after the provider's first line, as a daemon that restarts while it runs.
    const running = Promise.withResolvers<{ end(): void }>();
    const server = Bun.listen({
      unix: path,
      socket: { data: (socket) => running.resolve(socket) },
    });
    const child = Bun.spawn(["bun", join(import.meta.dirname, "main.ts"), "provider"], {
      env: { ...process.env, KITSHN_LOCAL_SOCKET: path, KITSHN_DAEMON_UID: String(own) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      void child.stdin.write(`${JSON.stringify(status)}\n`);
      void child.stdin.flush();
      (await running.promise).end();
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toMatch(/the daemon closed the connection/);
    } finally {
      child.kill();
      server.stop(true);
    }
  });

  it("reads the real peer user id of a client of the same user, and answers with the request id", async () => {
    using local = await daemon(() => ({ accept: true }));
    expect(statSync(local.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(local.path, "..")).mode & 0o777).toBe(0o700);
    const outcome = await askLocal(local.path, status, 5000, daemonPeer);
    expect(outcome).toMatchObject({ kind: "answer", answer: { id: "1", type: "status" } });
    expect(local.peers).toEqual([own]);
    expect(local.callers).toEqual([{ uid: own, connection: expect.any(Number) }]);
    // K-704: the daemon hears which connection closed, so its providers go offline.
    expect(await local.closed).toBe(local.callers[0]?.connection);
  });

  it("closes a refused connection before it reads a request", async () => {
    using local = await daemon(() => ({ accept: false, reason: "test" }));
    await expect(askLocal(local.path, status, 5000, daemonPeer)).rejects.toThrow("without an answer");
    expect(local.callers).toEqual([]);
  });

  it("answers a clear error for a bad line, with its id when it has one, and keeps a refused register (K-704)", async () => {
    using local = await daemon(() => ({ accept: true }));
    const badRegister = {
      id: "9",
      type: "register",
      provider: "t3",
      protocol: 2,
      instance: "env-1",
      // A broken shape refuses the line; a bad resource alone is dropped later (C-3).
      kinds: "none",
      commands: [],
      resources: [],
    };
    const answers = await raw(
      local.path,
      'not json\n{"id":"7","type":"nope"}\n{"id":"8","type":"rotate-key"}\n' +
        `${JSON.stringify(badRegister)}\n`,
      4,
    );
    expect(answers).toEqual(
      expect.arrayContaining([
        { id: null, type: "error", error: "The line is not JSON." },
        expect.objectContaining({ id: "7", type: "error" }),
        { id: "8", type: "error", error: "no rotate-key here" },
      ]),
    );
    expect(local.refusals).toEqual([{ provider: "t3", reason: expect.stringMatching(/kinds/) }]);
  });

  it("refuses to start next to a daemon that listens, and ends a connection with a line that is too long", async () => {
    // A small limit checks the same rule as the 17 MiB one, without sending 17 MiB.
    using local = await daemon(() => ({ accept: true }), "private", 1024);
    await expect(
      listenLocal(local.path, {
        platform,
        decide: () => ({ accept: true }),
        handle: () => Promise.reject(new Error("unused")),
        log: () => {},
        access: "private",
      }),
    ).rejects.toThrow("another kitshn daemon");
    const [answer] = await raw(
      local.path,
      `${JSON.stringify({ id: "9", type: "status", pad: "x".repeat(1025) })}\n`,
      1,
    );
    expect(answer).toMatchObject({ id: null, type: "error" });
    expect(local.callers).toEqual([]);
  });

  it("opens a shared socket for local users: folder 0711, socket 0666 (K-701)", async () => {
    using local = await daemon(() => ({ accept: true }), "shared");
    expect(statSync(local.path).mode & 0o777).toBe(0o666);
    expect(statSync(join(local.path, "..")).mode & 0o777).toBe(0o711);
    expect(await askLocal(local.path, status, 5000, daemonPeer)).toMatchObject({ kind: "answer" });
  });

  it("refuses a shared folder that is a link, or that another user owns", async () => {
    const real = mkdtempSync(join(tmpdir(), "kitshn-local-"));
    const link = sharedTestFolder();
    symlinkSync(real, link);
    const options = {
      platform,
      decide: () => ({ accept: true }) as const,
      handle: () => Promise.reject(new Error("unused")),
      log: () => {},
    };
    try {
      await expect(listenLocal(join(link, "kitshn.sock"), { ...options, access: "shared" })).rejects.toThrow(
        "is a link",
      );
    } finally {
      rmSync(link, { force: true });
    }
    const folder = { isDirectory: () => true, isSymbolicLink: () => false, uid: own + 1 };
    const tmp = { uid: 0, mode: 0o41777 };
    expect(sharedFolderProblem(folder, tmp, own)).toMatch(`user id ${own + 1}`);
    expect(sharedFolderProblem({ ...folder, uid: own }, tmp, own)).toBeNull();
    // Without the sticky bit, or not root's, another user could rename the folder away.
    expect(sharedFolderProblem({ ...folder, uid: own }, { uid: 0, mode: 0o40777 }, own)).toMatch("sticky");
    expect(sharedFolderProblem({ ...folder, uid: own }, { uid: own, mode: 0o41777 }, own)).toMatch("sticky");
  });

  it("sends nothing to a socket whose peer is not the daemon user (K-701)", async () => {
    using local = await daemon(() => ({ accept: true }), "shared");
    await expect(askLocal(local.path, status, 5000, { platform, daemonUid: own + 1 })).rejects.toThrow(
      "sent nothing",
    );
    expect(local.callers).toEqual([]);
  });

  it("tells the client plainly that no daemon runs, and removes its socket on stop", async () => {
    const local = await daemon(() => ({ accept: true }));
    local[Symbol.dispose]();
    expect(existsSync(local.path)).toBe(false);
    expect(await askLocal(local.path, status, 5000, daemonPeer)).toEqual({ kind: "not-running" });
  });
});

it("answers over the Windows pipe code, and a second daemon cannot take the name (K-621)", async () => {
  // On macOS and Linux, node:net makes a Unix socket of the path; the request and answer code is the same.
  const path = join(mkdtempSync(join(tmpdir(), "kitshn-pipe-")), "pipe");
  const options = {
    platform: "win32" as const,
    access: "private" as const,
    decide: () => ({ accept: true as const }),
    handle: async (request: { type: string }) => ({
      id: "id" in request ? String(request.id) : null,
      type: "error" as const,
      error: "pong",
    }),
    log: () => {},
  };
  const server = await listenLocal(path, options);
  try {
    const outcome = await askLocal(path, { id: "7", type: "status" } as never, 5000, {
      platform: "win32",
      daemonUid: -1,
    });
    expect(outcome).toMatchObject({ kind: "answer", answer: { id: "7", type: "error", error: "pong" } });
    await expect(listenLocal(path, options)).rejects.toThrow(/holds the pipe/);
  } finally {
    server.stop();
  }
  expect(
    await askLocal(path, { id: "8", type: "status" } as never, 5000, { platform: "win32", daemonUid: -1 }),
  ).toEqual({
    kind: "not-running",
  });
});

describe("connection keys (K-704)", () => {
  it("never gives a connection of the private socket the key of one on the shared socket, so its close leaves a provider online", async () => {
    // The daemon listens twice and gives each close to the same handler, which takes the providers of that key offline.
    const keys = { private: [] as Array<number>, shared: [] as Array<number> };
    const closed: Array<number> = [];
    const listen = (path: string, list: Array<number>) =>
      listenLocal(path, {
        platform,
        access: "private",
        decide: () => ({ accept: true }),
        log: () => {},
        closed: (key) => closed.push(key),
        handle: (request, caller) => {
          list.push(caller.connection);
          return Promise.resolve({ id: "id" in request ? request.id : null, type: "error", error: "test" });
        },
      });
    const privatePath = join(mkdtempSync(join(tmpdir(), "kitshn-keys-")), "kitshn", "kitshn.sock");
    const sharedPath = join(mkdtempSync(join(tmpdir(), "kitshn-keys-")), "kitshn", "kitshn.sock");
    const first = await listen(privatePath, keys.private);
    const second = await listen(sharedPath, keys.shared);
    try {
      // A provider's bridge on the shared socket stays open; `kitshn status` on the private socket comes and goes.
      const bridge = createConnection(sharedPath);
      await new Promise<void>((resolve) => bridge.once("connect", resolve));
      bridge.write(`${JSON.stringify(status)}\n`);
      await new Promise((resolve) => bridge.once("data", resolve));
      await raw(privatePath, `${JSON.stringify(status)}\n`, 1);
      await vi.waitFor(() => expect(closed).toHaveLength(1));
      expect(keys.private[0]).not.toBe(keys.shared[0]);
      expect(closed).toEqual(keys.private);
      bridge.destroy();
    } finally {
      first.stop();
      second.stop();
    }
  });
});

describe("the bridge (K-704, K-722)", () => {
  it("sends the frames of a run that it runs only between two whole lines of the provider", async () => {
    const written: Array<string> = [];
    const exited = Promise.withResolvers<void>();
    const session = bridgeSession(
      (bytes) => {
        const text = new TextDecoder().decode(bytes);
        written.push(text);
        if (text.includes('"exit"')) exited.resolve();
      },
      () => {},
    );
    session.fromProvider(new TextEncoder().encode('{"id":"1","type":"upsert","provider":"t3",'));
    const run = { execId: "e1", command: "echo hi", timeoutSeconds: 5, stdin: false };
    session.fromDaemon(new TextEncoder().encode(`${JSON.stringify({ type: "exec-run", run })}\n`));
    // The run ends while the provider is in the middle of its line, so its frames wait.
    await vi.waitFor(() => expect(session.queued()).toBeGreaterThan(1));
    expect(written).toHaveLength(1);
    session.fromProvider(new TextEncoder().encode('"resources":[]}\n'));
    await exited.promise;
    const joined = written.join("");
    expect(joined.startsWith('{"id":"1","type":"upsert","provider":"t3","resources":[]}\n')).toBe(true);
    expect(
      joined
        .split("\n")
        .filter(Boolean)
        .every((text) => JSON.parse(text) !== null),
    ).toBe(true);
  });
});
