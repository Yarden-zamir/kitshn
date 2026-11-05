// K-723: a fake kitshn edge for the contract tests. It speaks `/connect` as kitshn does: the K-1704 challenge,
// `accepted`, the pushes, jobs and asks that a scenario sends, and the exec relay, which it loops back to the same
// daemon, so one machine is A and B of a run. It also serves the Access signing keys for `check`.
import type { DaemonMessage, ServerToDaemon } from "@kitshn/edge/machine";
import { KITSHN_PROTOCOL } from "@kitshn/local/protocol";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { waitFor } from "./wait.ts";

/** What the fake edge answers to an exec start of the daemon. */
export type ExecMode =
  | { readonly mode: "run" }
  | { readonly mode: "refuse"; readonly reason: string }
  | { readonly mode: "offline" }
  | { readonly mode: "wait"; readonly proposalId: string };

export const TEAM = "contract.cloudflareaccess.com";

export interface FakeEdge {
  readonly url: string;
  readonly certsUrl: string;
  /** Every message of the daemon, in order. */
  readonly received: Array<DaemonMessage>;
  /** Waits for the first message from now on, or one already received when `seen` is true, that matches. */
  readonly next: <T extends DaemonMessage>(
    match: (message: DaemonMessage) => message is T,
    seen?: boolean,
  ) => Promise<T>;
  /** Sends one message to the daemon; a push gets a hash. */
  readonly send: (message: ServerToDaemon | Record<string, unknown>) => void;
  /** Resolves when a signed connection is open; `fresh` waits for a new one. */
  readonly connected: (fresh?: boolean) => Promise<void>;
  /** Signs an Access token for `check`. */
  readonly token: (claims: Record<string, unknown>, more?: { aud?: string; exp?: number }) => Promise<string>;
  exec: ExecMode;
  /** The answer to each `ask` of the daemon. */
  ask: (ask: Record<string, unknown>) => Record<string, unknown>;
  readonly close: () => Promise<void>;
}

let hashes = 0;

export async function fakeEdge(fingerprint: string): Promise<FakeEdge> {
  const pair = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "contract", alg: "RS256" };
  const server = createServer((request, response) => {
    if (request.url === "/certs") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server, path: "/connect" });
  const received: Array<DaemonMessage> = [];
  const listeners = new Set<(message: DaemonMessage) => void>();
  let socket: WebSocket | null = null;
  let signed: (() => void) | null = null;
  let isSigned = false;
  const edge: FakeEdge = {
    url: "",
    certsUrl: "",
    received,
    next: (match, seen = false) => {
      const found = seen ? received.find(match) : undefined;
      if (found) return Promise.resolve(found);
      return waitFor((resolve) => {
        const listener = (message: DaemonMessage) => {
          if (!match(message)) return;
          listeners.delete(listener);
          resolve(message);
        };
        listeners.add(listener);
        return () => listeners.delete(listener);
      }, "a message of the daemon");
    },
    send: (message) => {
      const withHash =
        "provider" in message && !("hash" in message) && message.type !== "job"
          ? { ...message, hash: `h${++hashes}` }
          : message;
      socket?.send(JSON.stringify(withHash));
    },
    connected: (fresh = false) =>
      isSigned && !fresh
        ? Promise.resolve()
        : waitFor((resolve) => {
            signed = resolve;
            return () => (signed = null);
          }, "a signed connection of the daemon"),
    token: (claims, more = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "contract" })
        .setIssuer(`https://${TEAM}`)
        .setAudience(more.aud ?? "aud-contract")
        .setExpirationTime(more.exp ?? Math.floor(Date.now() / 1000) + 3600)
        .sign(pair.privateKey),
    exec: { mode: "run" },
    ask: () => ({ outcome: "refused", reason: "the fake edge answers no ask" }),
    close: async () => {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const reply = (message: ServerToDaemon) => socket?.send(JSON.stringify(message));
  sockets.on("connection", (ws) => {
    socket = ws;
    isSigned = false;
    ws.send(
      JSON.stringify({ type: "challenge", challenge: "contract", fingerprint } satisfies ServerToDaemon),
    );
    ws.on("message", (data) => {
      const text = String(data);
      if (text === "ping") return ws.send("pong");
      const message = JSON.parse(text) as DaemonMessage;
      received.push(message);
      if (message.type === "answer") {
        isSigned = true;
        reply({ type: "accepted", fingerprint, protocol: KITSHN_PROTOCOL });
        signed?.();
      } else if (message.type === "ask") {
        reply({
          type: "askAnswer",
          requestId: message.requestId,
          ...edge.ask(message.ask as never),
        } as never);
      } else if (message.type === "desiredSet") {
        reply({ type: "requestAnswer", requestId: message.requestId, error: null });
        edge.send({
          type: "desired",
          provider: message.provider,
          kind: message.kind,
          state: { shared: message.part === "shared" ? message.value : null, machine: null },
          rev: message.rev ?? null,
        });
      } else if (message.type === "execStart") execStart(message);
      // One daemon is A and B, so each frame goes back to it; its hub routes a frame by its type.
      else if (message.type === "execFrame") reply(message);
      for (const listener of listeners) listener(message);
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      isSigned = false;
    });
  });
  const execStart = (message: Extract<DaemonMessage, { type: "execStart" }>) => {
    const { execId } = message;
    const end = (reason: string) =>
      reply({
        type: "execFrame",
        execId,
        frame: { type: "exit", exitCode: null, signal: null, durationMs: 0, reason },
      });
    const mode = edge.exec;
    if (mode.mode === "refuse") return end(`refused: ${mode.reason}`);
    if (mode.mode === "offline") return end("the target is offline");
    if (mode.mode === "wait")
      return reply({ type: "execState", execId, state: "waiting", proposalId: mode.proposalId });
    reply({ type: "execState", execId, state: "running" });
    reply({ type: "execRun", provider: message.provider, run: message.run });
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(edge, { url: `http://127.0.0.1:${port}`, certsUrl: `http://127.0.0.1:${port}/certs` });
}
