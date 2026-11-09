// K-1780: the MCP server of kitshn. Stateless streamable HTTP: one JSON answer per POST, no session and no stream.
// Each tool call is one call of `/op`, so the one gate decides it and History names the actor of the token (K-1777).
import { OPERATIONS, type Operation, isPersonGate } from "../core/operations.ts";

/** The protocol versions that this server speaks, newest first; an unknown request gets the newest. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** One call of `/op` with the caller of the MCP request: `GET /op/state`, or `POST /op/<operation>` with this body. */
export type OpCall = (operation: string, body: string | null) => Promise<Response>;

type Id = string | number;

const TOOLS = [
  {
    name: "kitshn_operations",
    title: "kitshn operations",
    description:
      "List every kitshn operation: its id, what it does, its effect and its gate. Every owner action has one, and kitshn_call runs it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "kitshn_state",
    title: "kitshn state",
    description:
      "Read the kitshn map: circles, actors, cards, machines, shares and the open asks that you may answer. Needs the effect reads.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "kitshn_call",
    title: "kitshn call",
    description:
      'Run one kitshn operation as your own identity. The answer is done (with the result), waiting (a person or circle must approve; send the same call again after the approval), or refused (with the reason). Approve an ask with operation "approve" and the proposal id as target.',
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "An operation id from kitshn_operations." },
        target: {
          type: "string",
          description: "The target of the operation: a card, machine, circle, job, actor or proposal id.",
        },
        body: { type: "object", description: "The body fields of the operation." },
        reason: { type: "string", description: "Why: the approver and History read it." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const rpcError = (id: Id | null, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The operation table as kitshn_operations shows it; the same rows as `kitshn ops`. */
const operationRows = () =>
  Object.entries(OPERATIONS as Readonly<Record<string, Operation>>).map(([id, op]) => ({
    id,
    title: op.title,
    effect: op.effect,
    gate: isPersonGate(op.gate) ? `only a person: ${op.gate.person}` : op.gate.scope,
    ...(op.secret === true ? { secret: true } : {}),
    ...(op.shortOnly === true ? { only: op.short } : {}),
  }));

/** The tool result of one `/op` answer: its JSON as text and as structured content; a refusal is a tool error. */
async function toolResult(answer: Response) {
  const body: unknown = await answer
    .json()
    .catch(() => ({ outcome: "refused", reason: `answered ${answer.status}` }));
  const refused = !answer.ok && !(isRecord(body) && body["outcome"] === "waiting");
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: isRecord(body) ? body : { result: body },
    isError: refused,
  };
}

async function toolCall(params: unknown, op: OpCall) {
  const name = isRecord(params) ? params["name"] : undefined;
  const args = isRecord(params) && isRecord(params["arguments"]) ? params["arguments"] : {};
  if (name === "kitshn_operations") {
    const rows = operationRows();
    return {
      content: [{ type: "text", text: JSON.stringify(rows) }],
      structuredContent: { operations: rows },
    };
  }
  if (name === "kitshn_state") return toolResult(await op("state", null));
  if (name === "kitshn_call") {
    const operation = args["operation"];
    if (typeof operation !== "string" || operation === "" || operation.includes("/"))
      return {
        content: [{ type: "text", text: "Name an operation id from kitshn_operations." }],
        isError: true,
      };
    const call = {
      target: typeof args["target"] === "string" ? args["target"] : "",
      body: isRecord(args["body"]) ? args["body"] : {},
      reason: typeof args["reason"] === "string" ? args["reason"] : null,
    };
    return toolResult(await op(operation, JSON.stringify(call)));
  }
  return null;
}

/**
 * K-1780: one MCP request. The Worker checked the Access token of the caller before, so `op` carries the identity of the
 * connection: one token, one actor (K-1778).
 */
export async function mcpAnswer(request: Request, op: OpCall, version: string): Promise<Response> {
  if (request.method !== "POST")
    return new Response("kitshn's MCP server answers POST only; it has no stream.", {
      status: 405,
      headers: { allow: "POST" },
    });
  const message: unknown = await request.json().catch(() => undefined);
  if (Array.isArray(message)) return rpcError(null, -32600, "Send one JSON-RPC message per request.", 400);
  if (!isRecord(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string")
    return rpcError(null, -32600, "Send a JSON-RPC 2.0 message.", 400);
  const id = message["id"];
  // A notification or a response of the client needs no answer.
  if (typeof id !== "string" && typeof id !== "number") return new Response(null, { status: 202 });
  const result = (value: unknown) => json({ jsonrpc: "2.0", id, result: value });
  switch (message["method"]) {
    case "initialize": {
      const asked = isRecord(message["params"]) ? message["params"]["protocolVersion"] : undefined;
      const protocolVersion = MCP_VERSIONS.find((known) => known === asked) ?? MCP_VERSIONS[0];
      return result({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "kitshn", title: "kitshn", version },
        instructions:
          "You act in kitshn as the actor of your token. kitshn_operations lists every action; kitshn_call runs one through the same gate as the owner. A call that waits needs an approval; send it again after the approval.",
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const answer = await toolCall(message["params"], op);
      return answer === null ? rpcError(id, -32602, "kitshn has no such tool.") : result(answer);
    }
    default:
      return rpcError(id, -32601, `kitshn's MCP server has no method ${String(message["method"])}.`);
  }
}
