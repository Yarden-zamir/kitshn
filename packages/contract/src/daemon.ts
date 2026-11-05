// K-723: one real daemon for the contract tests, in a home folder of its own, with no tunnel and a short ping, so a
// liveness scenario takes a second. A `kitshn` shim on its PATH starts the same daemon command, for `kitshn provider`.
import { fingerprintOf, newMachineKey } from "@kitshn/edge/machine";
import { pathsFor } from "@kitshn/daemon/service";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { type FakeEdge, fakeEdge } from "./edge.ts";
import { waitFor } from "./wait.ts";

export const PING_MS = 200;
export const GRACE_MS = 600;
export const MACHINE_ID = "contract-machine";

export interface Daemon {
  readonly edge: FakeEdge;
  readonly socket: string;
  readonly env: Readonly<Record<string, string>>;
  /** Starts the daemon and waits for its signed connection. */
  readonly start: () => Promise<void>;
  /** Sends a signal to the process that `start` made, by its own PID; `SIGTERM` waits for its exit. */
  readonly signal: (name: NodeJS.Signals) => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** `bun ../daemon/src/main.ts` or `./kitshn-linux-x64`: words that name a file become absolute paths. */
const words = (command: string) =>
  command
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => (existsSync(word) ? resolve(word) : word));

export async function daemon(command: string): Promise<Daemon> {
  const os = platform();
  if (os !== "linux" && os !== "darwin")
    throw new Error(`the contract tests run on Linux and macOS, not ${os}.`);
  // A short folder, because a Unix socket path has at most 104 bytes on macOS.
  const home = mkdtempSync("/tmp/kc-");
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_RUNTIME_DIR: join(home, "run"),
    PATH: `${join(home, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    KITSHN_TUNNEL: "off",
    KITSHN_PING_MS: String(PING_MS),
    KITSHN_GRACE_MS: String(GRACE_MS),
  };
  mkdirSync(env["XDG_RUNTIME_DIR"]!, { mode: 0o700 });
  const paths = pathsFor(os, env, home);
  const key = await newMachineKey();
  const edge = await fakeEdge(await fingerprintOf(key.x));
  env["KITSHN_ACCESS_CERTS_URL"] = edge.certsUrl;
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.config,
    JSON.stringify({
      server: edge.url,
      machineId: MACHINE_ID,
      clientId: "contract.access",
      clientSecret: "contract-secret",
      tunnelToken: "contract-tunnel",
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dirname(paths.config), "machine.key"), JSON.stringify(key), { mode: 0o600 });
  const argv = words(command);
  mkdirSync(join(home, "bin"));
  const shim = join(home, "bin", "kitshn");
  writeFileSync(shim, `#!/bin/sh\nexec ${argv.map((word) => `'${word}'`).join(" ")} "$@"\n`);
  chmodSync(shim, 0o755);
  let child: ChildProcess | null = null;
  let exited: Promise<void> = Promise.resolve();
  const value: Daemon = {
    edge,
    socket: paths.socket,
    env,
    start: async () => {
      const [program = "", ...rest] = argv;
      const started = spawn(program, [...rest, "run"], { env, stdio: ["ignore", "ignore", "inherit"] });
      child = started;
      exited = new Promise((done) => started.once("exit", () => done()));
      await edge.connected(true);
      // The socket listens before the connection opens; this only checks that the file is there.
      if (!existsSync(paths.socket)) throw new Error(`the daemon made no socket at ${paths.socket}.`);
    },
    signal: async (name) => {
      if (!child?.pid) throw new Error("the daemon does not run.");
      child.kill(name);
      if (name === "SIGTERM" || name === "SIGKILL")
        await waitFor((done) => (void exited.then(() => done(undefined)), () => {}), "exit of the daemon");
    },
    stop: async () => {
      if (child?.exitCode === null && child.pid) {
        child.kill("SIGCONT");
        child.kill("SIGTERM");
        await exited;
      }
      await edge.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
  return value;
}
