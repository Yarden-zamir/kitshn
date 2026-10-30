// K-701, K-702: the daemon's local Unix socket (a named pipe on Windows, K-621), and the client that the `kitshn`
// commands use.
import {
  type Answer,
  type ExecFrame,
  type IdRequest,
  type Request,
  MAX_LINE_LENGTH,
  line,
  readAnswer,
  readRequest,
} from "@kitshn/local";
import { type Stats, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";
import { type ExecHandle, applyFrame, startExec } from "./exec.ts";
import { type PeerDecision, peerUid, requestAllowed, requestSenders } from "./peer.ts";
import { type Platform, ownUid } from "./service.ts";
import { pipeServerProblem } from "./winpipe.ts";

/**
 * K-704: one counter for every listener of the daemon, so a connection key names one connection also when the
 * private and the shared socket both have connections.
 */
let lastConnection = 0;
/** K-704: closes each open connection by its key, for the liveness check of the providers. */
const closers = new Map<number, () => void>();

/** K-704: closes one connection; its `closed` handler runs as for any close. */
export function dropConnection(key: number): void {
  closers.get(key)?.();
}

/** K-621: at most this many pipe connections at once, and a connection sends its first line within this time. */
const PIPE_CONNECTIONS = 64;
const PIPE_FIRST_LINE_MS = 30_000;

/**
 * K-621: a client checks that the pipe's server runs as its own account before it sends anything, so a program of
 * another account that took the name first gets no request. Only on Windows; tests run this code on a Unix socket.
 */
function pipeRefusal(path: string): Promise<LocalOutcome> | null {
  if (process.platform !== "win32") return null;
  const problem = pipeServerProblem(path);
  if (problem === "missing") return Promise.resolve({ kind: "not-running" });
  return problem === null ? null : Promise.reject(new Error(problem));
}

/** The local user that sent a request. Each request records it (K-701). */
export interface Caller {
  readonly uid: number;
  /** K-704: the connection that sent the request; a provider belongs to the connection that registered it. */
  readonly connection: number;
}

/**
 * Bun writes only what fits in the socket buffer and returns that count; it keeps nothing. This keeps the rest in
 * order and writes it on each `drain`, so a long line arrives whole. `end` waits for the rest.
 */
export class SocketWriter {
  private readonly pending: Array<Uint8Array> = [];
  private ending = false;
  constructor(private readonly socket: Pick<Bun.Socket<unknown>, "write" | "end">) {}

  write(data: string | Uint8Array) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.ending || bytes.length === 0) return;
    this.pending.push(bytes);
    this.drain();
  }

  /** Call from the socket's `drain` handler. */
  drain() {
    while (this.pending.length > 0) {
      const head = this.pending[0]!;
      const written = Math.max(this.socket.write(head), 0);
      if (written < head.length) {
        this.pending[0] = head.subarray(written);
        return;
      }
      this.pending.shift();
    }
    if (this.ending) this.socket.end();
  }

  end() {
    this.ending = true;
    if (this.pending.length === 0) this.socket.end();
  }
}

interface Connection {
  readonly uid: number;
  readonly key: number;
  readonly writer: SocketWriter;
  readonly decoder: TextDecoder;
  buffer: string;
}

export interface LocalOptions {
  readonly platform: Platform;
  /** Called for each connection with the peer user id. A peer whose user id the kernel does not give never passes. */
  readonly decide: (peer: number) => PeerDecision;
  /** K-701: the local users that may also run a provider; read at each request. */
  readonly providerUsers?: () => ReadonlyArray<number>;
  /**
   * Answers with the id of the request; null for a request without an id (`pong`, `exec-credit`, `exec-frame`).
   * `emit` sends a later event on the same connection (K-703, K-1722).
   */
  readonly handle: (
    request: Request,
    caller: Caller,
    emit: (event: Answer) => void,
  ) => Promise<Answer | null>;
  /** K-704: a connection sent a line; any line counts as alive. */
  readonly seen?: (connection: number) => void;
  readonly log: (text: string) => void;
  /** K-704: a connection closed; its providers go offline. */
  readonly closed?: (connection: number) => void;
  /** K-704: a `register` of this provider did not decode; the daemon keeps the reason until one is accepted. */
  readonly refused?: (provider: string, reason: string, uid: number) => void;
  /**
   * K-701: "private" is a folder of 0700 and a socket of 0600. "shared" is a folder of 0711 and a socket of 0666, for
   * the users in `localUsers`; the peer check is then the only guard.
   */
  readonly access: "private" | "shared";
  /** K-702: the longest line that a connection may send; a test sets a small one, so it sends no 17 MiB. */
  readonly maxLineLength?: number;
}

/**
 * K-701: why a shared socket folder is not safe to use, or null. Another user may make the folder in /tmp first, so
 * it must be a real folder of the daemon user, not a link.
 */
export function sharedFolderProblem(
  folder: Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid">,
  parent: Pick<Stats, "uid" | "mode">,
  own: number,
): string | null {
  // Only the sticky bit stops another user from renaming or removing the daemon's folder in /tmp.
  if (parent.uid !== 0 || (parent.mode & 0o1000) === 0)
    return "its parent folder is not root's with the sticky bit";
  if (folder.isSymbolicLink()) return "it is a link";
  if (!folder.isDirectory()) return "it is not a folder";
  if (folder.uid !== own) return `it belongs to the user id ${folder.uid}, not to the daemon user ${own}`;
  return null;
}

/**
 * K-701: removes a socket file that an earlier daemon left, listens, and sets the modes of `options.access`. It
 * throws when a daemon still listens there, or when a shared folder is not the daemon user's own. `stop` removes the
 * socket file, unless another daemon made a new one meanwhile.
 */
export async function listenLocal(
  path: string,
  options: LocalOptions,
): Promise<{ readonly stop: () => void }> {
  if (options.platform === "win32") return listenPipe(path, options);
  const folder = dirname(path);
  if (options.access === "private") {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
  } else {
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    const problem = sharedFolderProblem(lstatSync(folder), statSync(dirname(folder)), ownUid());
    if (problem) throw new Error(`the shared socket folder ${folder} is not safe: ${problem}.`);
    chmodSync(folder, 0o711);
  }
  // Known limit: a daemon that starts between this check and the listen below loses its socket. Two daemons
  // that start in the same moment are a mistake of the service setup.
  const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
    (socket) => (socket.end(), true),
    (error: unknown) => {
      // Only a missing file or one that no daemon listens on may go; anything else is unknown (K-006).
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") return false;
      throw error;
    },
  );
  if (live) throw new Error(`another kitshn daemon listens on ${path}.`);
  rmSync(path, { force: true });
  const send = (socket: Bun.Socket<Connection | undefined>, answer: Answer) =>
    socket.data?.writer.write(line(answer));
  const maxLine = options.maxLineLength ?? MAX_LINE_LENGTH;
  const tooLong = (socket: Bun.Socket<Connection | undefined>) => {
    send(socket, { id: null, type: "error", error: `A line is longer than ${maxLine} characters.` });
    socket.data?.writer.end();
  };
  const lastRefusal = new Map<number | null, number>();
  const answer = (socket: Bun.Socket<Connection | undefined>, { uid, key }: Connection, text: string) =>
    answerLine(options, (reply) => send(socket, reply), { uid, connection: key }, text);
  const server = Bun.listen<Connection | undefined>({
    unix: path,
    socket: {
      open(socket) {
        // Bun has no documented call for the descriptor; a Bun without `fd` makes every peer fail here.
        const peer = peerUid(options.platform, (socket as { fd?: unknown }).fd);
        const refuse = (reason: string) => {
          // One line per user id and minute, so a client in a loop cannot fill the log.
          const now = Date.now();
          if (now - (lastRefusal.get(peer) ?? 0) >= 60_000) {
            lastRefusal.set(peer, now);
            options.log(`local socket: refused a connection: ${reason}`);
          }
          socket.end();
        };
        if (peer === null) return refuse("the peer user id cannot be read (K-006)");
        const decision = options.decide(peer);
        if (!decision.accept) return refuse(decision.reason);
        const key = ++lastConnection;
        closers.set(key, () => socket.end());
        socket.data = {
          uid: peer,
          key,
          writer: new SocketWriter(socket),
          decoder: new TextDecoder(),
          buffer: "",
        };
      },
      close(socket) {
        if (!socket.data) return;
        closers.delete(socket.data.key);
        options.closed?.(socket.data.key);
      },
      drain(socket) {
        socket.data?.writer.drain();
      },
      data(socket, chunk) {
        const connection = socket.data;
        if (!connection) return;
        connection.buffer += connection.decoder.decode(chunk, { stream: true });
        for (let end = connection.buffer.indexOf("\n"); end >= 0; end = connection.buffer.indexOf("\n")) {
          const text = connection.buffer.slice(0, end);
          connection.buffer = connection.buffer.slice(end + 1);
          if (text.length > maxLine) return tooLong(socket);
          options.seen?.(connection.key);
          void answer(socket, connection, text);
        }
        if (connection.buffer.length > maxLine) tooLong(socket);
      },
    },
  });
  chmodSync(path, options.access === "private" ? 0o600 : 0o666);
  const inode = statSync(path).ino;
  return {
    stop: () => {
      server.stop(true);
      if (existsSync(path) && statSync(path).ino === inode) rmSync(path, { force: true });
    },
  };
}

/** K-704: the provider name of a `register` line that does not decode, so its refusal can show; else null. */
function registeringProvider(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { type, provider } = value as { type?: unknown; provider?: unknown };
    return type === "register" && typeof provider === "string" ? provider : null;
  } catch {
    return null;
  }
}

/** K-701: answers one request line of a connection of `uid`. */
async function answerLine(
  options: LocalOptions,
  send: (answer: Answer) => void,
  { uid, connection }: Caller,
  text: string,
) {
  const read = readRequest(text);
  if (!read.ok) {
    const provider = registeringProvider(text);
    if (provider !== null && requestAllowed("register", uid, ownUid(), options.providerUsers?.() ?? []))
      options.refused?.(provider, read.answer.error, uid);
    return send(read.answer);
  }
  const { request } = read;
  if (!requestAllowed(request.type, uid, ownUid(), options.providerUsers?.() ?? [])) {
    options.log(`local socket: refused ${request.type} from user id ${uid}`);
    return send({
      id: "id" in request ? request.id : null,
      type: "error",
      error: `${request.type} is not allowed for the user id ${uid}; only ${requestSenders(request.type)} may send it (K-701).`,
    });
  }
  const id = "id" in request ? request.id : null;
  // The frequent frames of a provider would fill the log.
  if (id !== null) options.log(`local socket: ${request.type} from user id ${uid}`);
  const answer = await Promise.resolve()
    .then(() => options.handle(request, { uid, connection }, send))
    .catch((error: unknown): Answer => ({
      id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    }));
  if (answer) send(answer);
}

/** Splits chunks into lines; a line, or a rest, longer than the limit calls `tooLong` and stops. */
function lineReader(onLine: (text: string) => void, tooLong: () => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (text.length > MAX_LINE_LENGTH) return tooLong();
      onLine(text);
    }
    if (buffer.length > MAX_LINE_LENGTH) tooLong();
  };
}

/**
 * K-621: the daemon's named pipe on Windows. A pipe with no security descriptor gives read and write only to its
 * owner, SYSTEM and Administrators; everyone else gets read only, so no other user opens it for a request (tested
 * on Windows 11, also from a low integrity process). Each caller counts as the daemon user. The name is first come:
 * a program of another account that takes it before the daemon starts makes the start fail here, and the clients
 * refuse it, because they check the server's account first (`pipeRefusal`).
 */
async function listenPipe(path: string, options: LocalOptions): Promise<{ readonly stop: () => void }> {
  const server = createServer((socket) => {
    const key = ++lastConnection;
    closers.set(key, () => socket.end());
    const send = (answer: Answer) => void socket.write(line(answer));
    // A connection that never sends a line holds a pipe instance for nothing, for example a read-only one.
    const quiet = setTimeout(() => socket.destroy(), PIPE_FIRST_LINE_MS);
    socket.once("data", () => clearTimeout(quiet));
    socket.on("close", () => {
      clearTimeout(quiet);
      closers.delete(key);
      options.closed?.(key);
    });
    socket.on(
      "data",
      lineReader(
        (text) => {
          options.seen?.(key);
          void answerLine(options, send, { uid: ownUid(), connection: key }, text);
        },
        () => {
          send({ id: null, type: "error", error: `A line is longer than ${MAX_LINE_LENGTH} characters.` });
          socket.end();
        },
      ),
    );
    socket.on("error", () => socket.destroy());
  });
  server.maxConnections = PIPE_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`another kitshn daemon or another program holds the pipe ${path} (K-621).`)
          : error,
      ),
    );
    server.listen(path, resolve);
  });
  return { stop: () => void server.close() };
}

export type LocalOutcome =
  | { readonly kind: "answer"; readonly answer: Answer }
  /** No socket file, or one that no daemon listens on. */
  | { readonly kind: "not-running" };

/**
 * K-702: sends one request and waits for the answer with its id. K-701: before it sends, it checks that the peer is
 * the daemon user `daemonUid`, so a user who made a shared socket folder first cannot pose as the daemon.
 */
export function askLocal(
  path: string,
  request: IdRequest,
  timeoutMs: number,
  peer: { readonly platform: Platform; readonly daemonUid: number },
  /** K-1722: true keeps the connection for a later line, with no time limit; `onLine` sees each line before. */
  follow: (answer: Answer) => boolean = () => false,
  onLine: (answer: Answer) => void = () => {},
): Promise<LocalOutcome> {
  if (peer.platform === "win32") return askPipe(path, request, timeoutMs, follow, onLine);
  return new Promise((resolve, reject) => {
    let done = false;
    let buffer = "";
    let writer: SocketWriter | null = null;
    const decoder = new TextDecoder();
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the daemon did not answer within ${timeoutMs / 1000} seconds.`))),
      timeoutMs,
    );
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          const uid = peerUid(peer.platform, (socket as { fd?: unknown }).fd);
          if (uid !== peer.daemonUid) {
            const who = uid === null ? "a user whose id kitshn cannot read" : `the user id ${uid}`;
            finish(() =>
              reject(
                new Error(
                  `${path} belongs to ${who}, not to the daemon user ${peer.daemonUid}; kitshn sent nothing (K-701).`,
                ),
              ),
            );
            socket.end();
            return;
          }
          writer = new SocketWriter(socket);
          writer.write(line(request));
        },
        drain: () => writer?.drain(),
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let end = buffer.indexOf("\n"); end >= 0 && !done; end = buffer.indexOf("\n")) {
            const text = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const answer = readAnswer(text);
              // A newer daemon may send an event that this release does not know (K-702).
              if (answer === null) continue;
              if ("id" in answer && answer.id !== request.id && answer.id !== null)
                throw new Error(`the daemon answered the id ${answer.id}, not ${request.id}.`);
              onLine(answer);
              if (follow(answer)) {
                clearTimeout(timer);
                continue;
              }
              finish(() => resolve({ kind: "answer", answer }));
            } catch (error) {
              finish(() => reject(error));
            }
            socket.end();
          }
        },
        close: () =>
          finish(() =>
            reject(
              new Error(
                "the daemon closed the connection without an answer. Only the daemon user and its local users can use it (K-701); see the daemon log.",
              ),
            ),
          ),
        error: (_socket, error) => finish(() => reject(error)),
      },
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      finish(() =>
        code === "ENOENT" || code === "ECONNREFUSED" ? resolve({ kind: "not-running" }) : reject(error),
      );
    });
  });
}

const NEWLINE = 10;

/**
 * K-704: how a bridge ended: the provider ended its input, or the daemon side closed or failed, so the provider must
 * start the bridge again.
 */
export type BridgeEnd = "closed" | { readonly lost: string };

/** K-722: the run that a daemon line gives this bridge, or null for a line of the provider. */
function bridgeEvent(text: string): Extract<Answer, { type: "exec-run" | "exec-control" }> | null {
  // Most lines are the provider's; only these two need a decode.
  if (!text.includes('"exec-run"') && !text.includes('"exec-control"')) return null;
  try {
    const answer = readAnswer(text);
    return answer?.type === "exec-run" || answer?.type === "exec-control" ? answer : null;
  } catch {
    return null;
  }
}

/**
 * K-704: one bridge between a provider and the daemon: whole lines both ways, with no liveness of its own (the daemon
 * pings the provider). K-722: the bridge runs the exec runs that the daemon gives it as its own user, the provider
 * user, so the provider never sees them.
 */
export function bridgeSession(write: (bytes: Uint8Array) => void, output: (bytes: Uint8Array) => void) {
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const runs = new Map<string, ExecHandle>();
  // A frame goes out only between two whole lines of the provider, so it never splits one of them.
  let midLine = false;
  const waiting: Array<Uint8Array> = [];
  const frame = (execId: string, value: ExecFrame) => {
    const bytes = encoder.encode(line({ type: "exec-frame", execId, frame: value }));
    if (midLine) waiting.push(bytes);
    else write(bytes);
  };
  const onEvent = (event: Extract<Answer, { type: "exec-run" | "exec-control" }>) => {
    if (event.type === "exec-run") {
      const { execId } = event.run;
      runs.set(
        execId,
        startExec(
          {
            command: event.run.command,
            ...(event.run.cwd === undefined ? {} : { cwd: event.run.cwd }),
            timeoutMs: event.run.timeoutSeconds * 1000,
            stdin: event.run.stdin,
            platform: process.platform,
          },
          {
            output: (stream, data) =>
              frame(execId, { type: "output", stream, data: Buffer.from(data).toString("base64") }),
            stdinCredit: (bytes) => frame(execId, { type: "stdin-credit", bytes }),
            exit: (end) => {
              runs.delete(execId);
              frame(execId, { type: "exit", ...end });
            },
          },
        ),
      );
      return;
    }
    const run = runs.get(event.execId);
    if (run) applyFrame(run, event.frame);
  };
  return {
    fromProvider(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      write(chunk);
      midLine = chunk[chunk.length - 1] !== NEWLINE;
      if (!midLine) for (const bytes of waiting.splice(0)) write(bytes);
    },
    fromDaemon(chunk: Uint8Array) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      let start = 0;
      for (let index = 0; index < joined.length; index++) {
        if (joined[index] !== NEWLINE) continue;
        const bytes = joined.subarray(start, index + 1);
        const event = bridgeEvent(decoder.decode(bytes));
        if (event) onEvent(event);
        else output(bytes);
        start = index + 1;
      }
      pending = joined.slice(start);
    },
    /** The frames that wait for the end of the provider's line. */
    queued: () => waiting.length,
    /** A bridge that ends kills its runs; the daemon ends them with "the relay was lost". */
    stop: () => {
      for (const run of runs.values()) run.kill("the bridge ended");
    },
  };
}

/**
 * K-704: `kitshn provider` joins stdin and stdout to one connection, line by line, so a provider needs no socket code.
 * It checks the peer as `askLocal` does before it sends anything. It ends when the provider ends its input, and as
 * lost when the daemon side closes or fails.
 */
export function bridgeLocal(
  path: string,
  peer: { readonly platform: Platform; readonly daemonUid: number },
  input: AsyncIterable<Uint8Array>,
  /** Whole lines as the daemon sends them. */
  output: (bytes: Uint8Array) => void,
): Promise<LocalOutcome | BridgeEnd> {
  if (peer.platform === "win32") return bridgePipe(path, input, output);
  let writer: SocketWriter | null = null;
  return new Promise((resolve, reject) => {
    let session: ReturnType<typeof bridgeSession> | null = null;
    let ended = false;
    let raw: { end(): void } | null = null;
    const finish = (end: BridgeEnd) => {
      session?.stop();
      resolve(end);
    };
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          const uid = peerUid(peer.platform, (socket as { fd?: unknown }).fd);
          if (uid !== peer.daemonUid) {
            // Reject before the close, so the close cannot report a clean end first.
            reject(
              new Error(
                `${path} does not belong to the daemon user ${peer.daemonUid}; kitshn sent nothing (K-701).`,
              ),
            );
            socket.end();
            return;
          }
          const own = new SocketWriter(socket);
          writer = own;
          raw = socket;
          const current = bridgeSession((bytes) => own.write(bytes), output);
          session = current;
          void (async () => {
            for await (const chunk of input) current.fromProvider(chunk);
            ended = true;
            own.end();
          })().catch(reject);
        },
        drain: () => writer?.drain(),
        data(_socket, chunk) {
          session?.fromDaemon(chunk);
        },
        close: () => finish(ended ? "closed" : { lost: "the daemon closed the connection" }),
        error: (_socket, error) => {
          session?.stop();
          raw?.end();
          reject(error);
        },
      },
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") resolve({ kind: "not-running" });
      else reject(error);
    });
  });
}

/** K-621, K-702: `askLocal` over the daemon's named pipe on Windows. */
function askPipe(
  path: string,
  request: IdRequest,
  timeoutMs: number,
  follow: (answer: Answer) => boolean,
  onLine: (answer: Answer) => void,
): Promise<LocalOutcome> {
  const refused = pipeRefusal(path);
  if (refused) return refused;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.end();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the daemon did not answer within ${timeoutMs / 1000} seconds.`))),
      timeoutMs,
    );
    const socket = connect(path, () => socket.write(line(request)));
    socket.on(
      "data",
      lineReader(
        (text) => {
          if (done) return;
          try {
            const answer = readAnswer(text);
            if (answer === null) return;
            if ("id" in answer && answer.id !== request.id && answer.id !== null)
              throw new Error(`the daemon answered the id ${answer.id}, not ${request.id}.`);
            onLine(answer);
            if (follow(answer)) return clearTimeout(timer);
            finish(() => resolve({ kind: "answer", answer }));
          } catch (error) {
            finish(() => reject(error));
          }
        },
        () =>
          finish(() =>
            reject(new Error(`the daemon sent a line longer than ${MAX_LINE_LENGTH} characters.`)),
          ),
      ),
    );
    socket.on("close", () =>
      finish(() =>
        reject(new Error("the daemon closed the connection without an answer; see the daemon log.")),
      ),
    );
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? resolve({ kind: "not-running" })
          : reject(error),
      ),
    );
  });
}

/** K-621, K-704: `bridgeLocal` over the daemon's named pipe on Windows; the pipe admits only the daemon user. */
function bridgePipe(
  path: string,
  input: AsyncIterable<Uint8Array>,
  output: (bytes: Uint8Array) => void,
): Promise<LocalOutcome | BridgeEnd> {
  const refused = pipeRefusal(path);
  if (refused) return refused;
  return new Promise((resolve, reject) => {
    let ended = false;
    const finish = (end: BridgeEnd) => {
      session.stop();
      resolve(end);
    };
    const socket = connect(path, () => {
      void (async () => {
        for await (const chunk of input) session.fromProvider(chunk);
        ended = true;
        socket.end();
      })().catch(reject);
    });
    const session = bridgeSession((bytes) => socket.write(bytes), output);
    socket.on("data", (chunk: Buffer) => session.fromDaemon(new Uint8Array(chunk)));
    socket.on("close", () => finish(ended ? "closed" : { lost: "the daemon closed the connection" }));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      session.stop();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve({ kind: "not-running" });
      else reject(error);
    });
  });
}
