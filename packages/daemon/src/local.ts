// K-701, K-702: the daemon's local Unix socket (a named pipe on Windows, K-621), and the client that the `kitshn`
// commands use.
import { type Answer, type Request, MAX_LINE_LENGTH, line, readAnswer, readRequest } from "@kitshn/local";
import { type Stats, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";
import { type PeerDecision, peerUid, requestAllowed } from "./peer.ts";
import { type Platform, ownUid } from "./service.ts";
import { pipeServerProblem } from "./winpipe.ts";

/** K-621: at most this many pipe connections at once, and a connection sends its first line within this time. */
const PIPE_CONNECTIONS = 64;
const PIPE_FIRST_LINE_MS = 30_000;

/**
 * K-621: a client checks that the pipe's server runs as its own account before it sends anything, so a program of
 * another account that took the name first gets no request. Only on Windows; tests run this code on a Unix socket.
 * Known limit: the check and the connect are two connections, so a name taken in between is not seen; revisit with
 * one connection for both when a Windows machine has more accounts.
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
  /** Answers with the id of the request. `emit` sends a later event on the same connection (K-703, K-1722). */
  readonly handle: (request: Request, caller: Caller, emit: (event: Answer) => void) => Promise<Answer>;
  readonly log: (text: string) => void;
  /** K-704: a connection closed; its providers go offline. */
  readonly closed?: (connection: number) => void;
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
  let connections = 0;
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
        socket.data = {
          uid: peer,
          key: ++connections,
          writer: new SocketWriter(socket),
          decoder: new TextDecoder(),
          buffer: "",
        };
      },
      close(socket) {
        if (socket.data) options.closed?.(socket.data.key);
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

/** K-701: answers one request line of a connection of `uid`. */
async function answerLine(
  options: LocalOptions,
  send: (answer: Answer) => void,
  { uid, connection }: Caller,
  text: string,
) {
  const read = readRequest(text);
  if (!read.ok) return send(read.answer);
  const { request } = read;
  if (!requestAllowed(request.type, uid, ownUid())) {
    options.log(`local socket: refused ${request.type} from user id ${uid}`);
    return send({
      id: request.id,
      type: "error",
      error: `${request.type} is not allowed for the user id ${uid}; only the daemon user and root may send it (K-701).`,
    });
  }
  options.log(`local socket: ${request.type} from user id ${uid}`);
  send(
    await Promise.resolve()
      .then(() => options.handle(request, { uid, connection }, send))
      .catch((error: unknown): Answer => ({
        id: request.id,
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      })),
  );
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
  let connections = 0;
  const server = createServer((socket) => {
    const key = ++connections;
    const send = (answer: Answer) => void socket.write(line(answer));
    // A connection that never sends a line holds a pipe instance for nothing, for example a read-only one.
    const quiet = setTimeout(() => socket.destroy(), PIPE_FIRST_LINE_MS);
    socket.once("data", () => clearTimeout(quiet));
    socket.on("close", () => {
      clearTimeout(quiet);
      options.closed?.(key);
    });
    socket.on(
      "data",
      lineReader(
        (text) => void answerLine(options, send, { uid: ownUid(), connection: key }, text),
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
  request: Request,
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

/**
 * K-704: `kitshn provider` joins stdin and stdout to one connection, line by line, so a provider needs no socket code.
 * It checks the peer as `askLocal` does before it sends anything, and ends when either side ends.
 */
export function bridgeLocal(
  path: string,
  peer: { readonly platform: Platform; readonly daemonUid: number },
  input: AsyncIterable<Uint8Array>,
  /** The bytes as they come: a character split across chunks stays whole for the reader. */
  output: (bytes: Uint8Array) => void,
): Promise<LocalOutcome | "closed"> {
  if (peer.platform === "win32") return bridgePipe(path, input, output);
  let writer: SocketWriter | null = null;
  return new Promise((resolve, reject) => {
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
          void (async () => {
            for await (const chunk of input) own.write(chunk);
            own.end();
          })().catch(reject);
        },
        drain: () => writer?.drain(),
        data(_socket, chunk) {
          output(chunk);
        },
        close: () => resolve("closed"),
        error: (_socket, error) => reject(error),
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
  request: Request,
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
): Promise<LocalOutcome | "closed"> {
  const refused = pipeRefusal(path);
  if (refused) return refused;
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => {
      void (async () => {
        for await (const chunk of input) socket.write(chunk);
        socket.end();
      })().catch(reject);
    });
    socket.on("data", (chunk: Buffer) => output(new Uint8Array(chunk)));
    socket.on("close", () => resolve("closed"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? resolve({ kind: "not-running" })
        : reject(error),
    );
  });
}
