// Helpers of the HTTP tests of a machine: its agent circle, and calls that its daemon forwards (K-1714).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  FORWARD_HEADERS,
  type Machine,
  type MachinePrivateKey,
  forwardText,
  signText,
} from "../src/core/machine.ts";
import type { Circle, Member, RightMode } from "../src/core/model.ts";
import { accessToken, send } from "./access.ts";
import { insertActors, machine as machineChip } from "./actors.ts";

/** The machine vps in the agent circle "agents" with these rights. */
export async function setup(
  rights: Partial<Record<string, RightMode>>,
  key: MachinePrivateKey | null = null,
  spot: { readonly x: number; readonly y: number } = { x: 5000, y: 5000 },
  others: ReadonlyArray<Member> = [],
) {
  const machine: Machine = {
    ...(key ? { key: { kind: "public" as const, publicKey: key.x, fingerprint: "f", since: 0 } } : {}),
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "token-vps",
    clientId: "vps.access",
    tunnelId: "tunnel-vps",
  };
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [machineChip("vps", rights), ...others],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    ...spot,
    r: 200,
  };
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
    insertActors(state.storage.sql, agents.members);
    state.storage.sql.exec("DELETE FROM ask_events");
  });
  await evictDurableObject(stub);
}

/**
 * Runs `scenario` with a signed daemon socket of vps that is online and sent its status, then closes the socket,
 * because an open one keeps the Durable Object busy and the next test evicts it.
 */
export async function withDaemon<T>(
  scenario: (
    instance: unknown,
    state: DurableObjectState,
    daemon: (message: object) => Promise<void>,
  ) => Promise<T>,
  capabilities: ReadonlyArray<string> = [],
): Promise<T> {
  return runInDurableObject(env.KITSHN.getByName("kitshn"), async (instance, state) => {
    const kitshn = instance as unknown as {
      setPresence(machineId: string, online: boolean): void;
      webSocketMessage(socket: WebSocket, message: string): Promise<void>;
    };
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1], ["vps", "machines"]);
    pair[0].accept();
    pair[1].serializeAttachment({
      kind: "machine",
      machineId: "vps",
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    });
    kitshn.setPresence("vps", true);
    const daemon = (message: object) => kitshn.webSocketMessage(pair[1], JSON.stringify(message));
    const status = {
      version: "bbbbbbbbbbbb",
      os: "Linux 6",
      arch: "x64",
      hostname: "vps",
      tunnel: "running",
    };
    await daemon({ type: "status", status: { ...status, capabilities } });
    try {
      return await scenario(instance, state, daemon);
    } finally {
      pair[1].close(1000, "test over");
    }
  });
}

/** One call as the daemon forwards it: the machine token, and the machine key's signature (K-1714). */
export async function forwarded(
  key: MachinePrivateKey,
  method: string,
  path: string,
  nonce: string,
  body = "{}",
  extra: Record<string, string> = {},
  audience = "agent-aud",
) {
  const at = Date.now();
  const labels = "{}";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(labels)));
  const labelsHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const signature = await signText(
    key,
    forwardText("kit.example.com", "vps", { method, path, at, nonce, labelsHash }),
  );
  return send(path, {
    method,
    headers: {
      "cf-access-jwt-assertion": await accessToken(audience, { common_name: "vps.access" }),
      "content-type": "application/json",
      [FORWARD_HEADERS.signature]: signature,
      [FORWARD_HEADERS.at]: String(at),
      [FORWARD_HEADERS.nonce]: nonce,
      [FORWARD_HEADERS.labels]: labels,
      ...extra,
    },
    body,
  });
}
