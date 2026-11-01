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
import type { Circle, RightMode } from "../src/core/model.ts";
import { accessToken, send } from "./access.ts";

/** The machine vps in the agent circle "agents" with these rights. */
export async function setup(
  rights: Partial<Record<string, RightMode>>,
  key: MachinePrivateKey | null = null,
  spot: { readonly x: number; readonly y: number } = { x: 5000, y: 5000 },
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
    members: [{ _tag: "machine", machineId: "vps", rights }],
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
    state.storage.sql.exec("DELETE FROM ask_events");
  });
  await evictDurableObject(stub);
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
