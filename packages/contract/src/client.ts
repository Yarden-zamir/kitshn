// K-723: a line client on the daemon's local socket. As a provider it answers each ping, unless `quiet` is set.
import type { Answer } from "@kitshn/local";
import { type Socket, connect } from "node:net";
import { waitFor } from "./wait.ts";

export interface LineClient {
  /** Sends a request with a new id and waits for its answer. */
  readonly request: (body: Record<string, unknown>) => Promise<Answer>;
  /** Sends one line with no id, such as `pong` or `exec-credit`. */
  readonly write: (body: Record<string, unknown>) => void;
  /** Waits for the next event from now on that matches, or one already received when `seen` is true. */
  readonly next: <T extends Answer>(match: (event: Answer) => event is T, seen?: boolean) => Promise<T>;
  readonly events: Array<Answer>;
  /** Resolves when the daemon closes the connection. */
  readonly closed: Promise<void>;
  quiet: boolean;
  readonly close: () => void;
}

let lastId = 0;

export function lineClient(path: string): Promise<LineClient> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(path);
    const events: Array<Answer> = [];
    const answers = new Map<string, (answer: Answer) => void>();
    const listeners = new Set<(event: Answer) => void>();
    let buffer = "";
    let closed: () => void = () => {};
    const client: LineClient = {
      request: (body) => {
        const id = `c${++lastId}`;
        socket.write(`${JSON.stringify({ id, ...body })}\n`);
        return waitFor(
          (done) => {
            answers.set(id, done);
            return () => answers.delete(id);
          },
          `answer to ${String(body["type"])}`,
        );
      },
      write: (body) => void socket.write(`${JSON.stringify(body)}\n`),
      next: (match, seen = false) => {
        const found = seen ? events.find(match) : undefined;
        if (found) return Promise.resolve(found);
        return waitFor((done) => {
          const listener = (event: Answer) => {
            if (match(event)) done(event);
          };
          listeners.add(listener);
          return () => listeners.delete(listener);
        }, "an event of the daemon");
      },
      events,
      closed: new Promise((done) => (closed = done)),
      quiet: false,
      close: () => socket.end(),
    };
    socket.on("connect", () => resolve(client));
    socket.on("error", reject);
    socket.on("close", () => closed());
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const answer = JSON.parse(line) as Answer;
        if ("id" in answer && answer.id !== null && answers.has(answer.id)) {
          answers.get(answer.id)?.(answer);
          continue;
        }
        if (answer.type === "ping" && !client.quiet) client.write({ type: "pong" });
        events.push(answer);
        for (const listener of listeners) listener(answer);
      }
    });
  });
}
