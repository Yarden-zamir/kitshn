// The kitshn daemon (SPEC section 6). One program: `kitshn join`, `kitshn run`, `kitshn service`.
import {
  connectText,
  fingerprintOf,
  newMachineKey,
  openJoin,
  parsePrivateKey,
  rotateText,
  signText,
  forwardText,
  FORWARD_HEADERS,
  type Command,
  type DaemonMessage,
  type LiveSiteReport,
  type JoinSecrets,
  type MachinePrivateKey,
  type ProjectVolume,
  type ServerToDaemon,
  type AskOutcome,
} from "@kitshn/edge/machine";
import { type DoorPlan, portKey } from "@kitshn/edge/game";
import type { BackupReport } from "@kitshn/edge/backups";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  ASK_ACTIONS,
  type Answer,
  type AskAction,
  MAX_FORWARD_BYTES,
  type Request,
  WINDOW_ACTIONS,
} from "@kitshn/local";
import { composeFiles, composeRisks, envFileRisks, rawRisks, realpathOnDisk, sourceRisks } from "./guard.ts";
import { withNotify } from "./notify.ts";
import { backup, finishRestores, restore, unpauseMarked } from "./backup.ts";
import { keyPlan } from "./keys.ts";
import {
  AttestationError,
  T3_TOKEN_ENV,
  unregisteredT3,
  attest,
  attestationRefusal,
  attesterPrefixes,
  attestersOf,
  dropAttested,
  withAttester,
} from "./attest.ts";
import { credentialReply, readCredentialInput, repoOfCredential, repoOfRemote } from "./gitCredential.ts";
import { composeLogs, followLogs, rangeArgs, searchLogs, withLogLimits } from "./logs.ts";
import {
  type Caller,
  type LocalOutcome,
  askLocal,
  bridgeLocal,
  listenLocal,
  sharedFolderProblem,
} from "./local.ts";
import { type IconMemory, iconToSend, iconsDue, targetIcon } from "./icons.ts";
import { localUsersOf, peerDecision } from "./peer.ts";
import { movedVolume, takeoverPlan } from "./kitshn1.ts";
import {
  HELPER_IMAGE,
  daemonUser,
  dockerKind,
  printable,
  rootTakeover,
  rootTakeoverPlan,
} from "./takeover.ts";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  homedir,
  hostname,
  userInfo,
  loadavg,
  platform as osPlatform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { basename, dirname, join } from "node:path";
import { oldBinaries, oldBinaryName, swapBinary } from "./update.ts";
import { ownSid } from "./winpipe.ts";
import {
  type Platform,
  RELEASES,
  WINDOWS_CLOUDFLARED,
  WINDOWS_TASKS,
  ownUid,
  cloudflaredUrl,
  expectedDaemonUid,
  expectedHash,
  isDigits,
  localSocket,
  versionJson,
  pathsFor,
  releaseAsset,
  serviceCommands,
  serviceFile,
  tunnelCommands,
  tunnelServiceFile,
  tunnelStateOf,
} from "./service.ts";
import { type SiteEntry, addSite, parseSiteFile, probe, targetOf } from "./sites.ts";
import { scanServers } from "./servers.ts";
import type { ServerReport } from "@kitshn/edge/sites";
import { RUNNING_FORMAT, VOLUME_FORMAT, idleVolumes, volumeRemoveRefusal } from "./volumes.ts";
import { keepBuild, keptId, keptTag, rollbackOverride, serviceImages, staleTags } from "./keep.ts";
import { TokenCache } from "./tokens.ts";
import { Providers, parseSaved } from "./providers.ts";
import { desiredProblem } from "@kitshn/local";
import { linkSocketProblem, serveLinks } from "./link.ts";
import { lastHour, lastSamples } from "./samples.ts";
import { pushKey } from "@kitshn/local";
import { listenerUid, portOf } from "./listener.ts";
import { MAX_FORWARDS, forwardTarget, passedHeaders, readBounded } from "./forward.ts";
import {
  Relays,
  applyDoors,
  doorsCommand,
  doorsProblem,
  keptPlan,
  listening,
  publicAddresses,
} from "./doors.ts";
import {
  type UpnpState,
  netstatListening,
  runWindowsHelper,
  syncUpnp,
  windowsDoorsCommand,
  windowsDoorsProblem,
  writeWindowsPlan,
} from "./windoors.ts";
import { AGENT_USAGE, type AgentTransport, runAgentCommand, timeBody } from "kitshn/agent";
import { CliError } from "kitshn/cli-error";
import { checkSkill, installGlobalSkill, installRepoSkill, refreshGlobalSkill } from "./skill.ts";

declare const KITSHN_VERSION: string;
const VERSION = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";

const platform = ((): Platform => {
  const value = osPlatform();
  if (value === "linux" || value === "darwin" || value === "win32") return value;
  throw new Error(`kitshn runs on Linux, macOS and Windows (K-601), not on ${value}.`);
})();
const paths = pathsFor(platform, process.env);

/** K-605: status at most every 5 seconds, a sample once a minute. K-604: a ping every 10 seconds. */
const PING_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
const SAMPLE_MS = 60_000;
const HISTORY_DAYS = 30;
const JOB_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;

const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

function fail(text: string): never {
  console.error(`kitshn: ${text}`);
  process.exit(1);
}

function readConfig(): JoinSecrets {
  if (!existsSync(paths.config))
    fail(`this machine has not joined yet. Run: kitshn join <code> --server <address>`);
  return JSON.parse(readFileSync(paths.config, "utf8")) as JoinSecrets;
}

/**
 * K-1702: the private half of the machine key lives next to `machine.json`, mode 0600 in a folder with mode
 * 0700. During a rotation the new half waits in `machine.key.next` until kitshn has it (K-1705).
 */
const keyFile = join(dirname(paths.config), "machine.key");
const nextKeyFile = `${keyFile}.next`;
/** K-1703, K-1706: a key from a join or rekey code waits here until kitshn takes it. */
const codeKeyFile = `${keyFile}.rekey`;

/** The key in a file, or null when the file is missing. A broken file stops the daemon (K-006). */
function readKey(file: string): MachinePrivateKey | null {
  if (!existsSync(file)) return null;
  const key = parsePrivateKey(JSON.parse(readFileSync(file, "utf8")));
  if (!key) fail(`${file} holds no Ed25519 key. Use Reset key on the map, then kitshn rekey <code>.`);
  return key;
}

/** Writes a key through a rename, so a stop never leaves half a key. */
function writeKey(file: string, key: MachinePrivateKey) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(key)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * K-602, K-1703: trades the join code and the public half of a new machine key for the machine secrets, and saves
 * both for the daemon user only.
 */
async function joinCommand(code: string | undefined, server: string | undefined) {
  if (!code || !server) fail("usage: kitshn join <code> --server https://kit.example.com");
  // K-623: Windows ignores file modes, so before the key goes in, only the user and SYSTEM get the folder, with no
  // inherited access.
  if (platform === "win32") {
    mkdirSync(dirname(paths.config), { recursive: true });
    // SIDs, not names: SYSTEM has another name in some languages, and a bare user name can match a domain account.
    const sid = ownSid();
    if (sid === null) fail("kitshn cannot read the SID of this Windows account (K-623).");
    const grant = spawnSync(
      "icacls",
      [
        dirname(paths.config),
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "/grant:r",
        "*S-1-5-18:(OI)(CI)F",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (grant.status !== 0)
      fail(`icacls could not protect ${dirname(paths.config)}: ${grant.stdout}${grant.stderr}`);
  }
  // K-1703: the key pair comes first, in machine.key.rekey before kitshn stores its public half, so a wrong code
  // never replaces a valid key. The next challenge that names it promotes it.
  const key = await newMachineKey();
  writeKey(codeKeyFile, key);
  const response = await fetch(new URL("/join/exchange", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, publicKey: key.x }),
  });
  const body = (await response.json().catch(() => null)) as {
    iv?: string;
    sealed?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.iv || !body.sealed) {
    rmSync(codeKeyFile, { force: true });
    fail(body?.error ?? `the server answered ${response.status}.`);
  }
  const secrets = await openJoin(code, { iv: body.iv, sealed: body.sealed });
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  // An older file can have looser permissions; tighten them before the secrets go in.
  if (existsSync(paths.config)) chmodSync(paths.config, 0o600);
  writeFileSync(paths.config, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(codeKeyFile, keyFile);
  console.log(`Joined as machine ${secrets.machineId} with the key ${await fingerprintOf(key.x)}.`);
}

/**
 * K-1706, K-1708: trades a key code for a new key, then asks the running daemon to connect again with it. Only
 * the daemon's own connection to kitshn changes; the tunnel and the apps keep serving. A stopped daemon signs
 * with the new `machine.key` when it starts.
 */
async function rekeyCommand(code: string | undefined) {
  if (!code) fail("usage: kitshn rekey <code>");
  const config = readConfig();
  // In its own file before kitshn stores its public half, so a failed write cannot lock the machine out, a wrong
  // code cannot replace a valid key, and a rotation or a reconnect never touches it. The next challenge that
  // names it promotes it.
  const key = await newMachineKey();
  writeKey(codeKeyFile, key);
  const response = await fetch(new URL("/join/rekey", config.server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machineId: config.machineId, publicKey: key.x }),
  });
  const body = (await response.json().catch(() => null)) as { fingerprint?: string; error?: string } | null;
  if (!response.ok || !body?.fingerprint) {
    rmSync(codeKeyFile, { force: true });
    fail(body?.error ?? `the server answered ${response.status}.`);
  }
  renameSync(codeKeyFile, keyFile);
  console.log(`Saved the new key ${body?.fingerprint} in ${keyFile}.`);
  const answer = await ask({ id: "1", type: "reconnect" });
  console.log(
    answer === null
      ? "The daemon is not running. It signs with the new key when it starts."
      : "The daemon connects again with the new key.",
  );
}

/** K-1705: asks the running daemon to rotate its key over its connection. */
async function rotateKeyCommand() {
  const answer = await ask({ id: "1", type: "rotate-key" });
  if (answer === null) fail(notRunning());
  if (answer.type !== "rotate-key") fail(`the daemon answered ${answer.type} to rotate-key.`);
  console.log(`Rotated. The new key is ${answer.fingerprint}.`);
}

async function statusCommand() {
  const answer = await ask({ id: "1", type: "status" });
  if (answer === null) fail(notRunning());
  if (answer.type !== "status") fail(`the daemon answered ${answer.type} to status.`);
  const { status } = answer;
  console.log(
    [
      `version  ${status.version}`,
      `machine  ${status.machineId}`,
      `key      ${status.fingerprint ?? "none (kitshn rekey <code>)"}`,
      `kitshn   ${status.connection}`,
      `tunnel   ${status.tunnel}`,
    ].join("\n"),
  );
}

/** K-701: where the commands find the daemon: their own socket, or the one trusted shared socket in /tmp. */
// K-621: Windows has one pipe per user and no shared socket.
const foundSocket =
  platform === "win32"
    ? paths.socket
    : localSocket(
        process.env,
        paths,
        (path) => {
          try {
            const stat = lstatSync(path);
            return { uid: stat.uid, mode: stat.mode, directory: stat.isDirectory(), socket: stat.isSocket() };
          } catch {
            return null;
          }
        },
        (() => {
          try {
            return readdirSync("/tmp");
          } catch {
            return [];
          }
        })(),
        (uid) => {
          const name = spawnSync("id", ["-nu", String(uid)], { encoding: "utf8" });
          return name.status === 0 ? name.stdout.trim() : null;
        },
      );
const socketPath = typeof foundSocket === "string" ? foundSocket : paths.socket;
const daemonUid = expectedDaemonUid(process.env, socketPath, ownUid());
/** K-701: why no daemon answers. A shared folder that another user made first keeps the daemon out of it. */
function notRunning(): string {
  if (typeof foundSocket !== "string")
    return "refused" in foundSocket
      ? foundSocket.refused
      : `several daemons share a socket here (${foundSocket.several.join(", ")}); set KITSHN_LOCAL_SOCKET to the one to use.`;
  const folder = dirname(socketPath);
  if (socketPath.startsWith("/tmp/kitshn-") && typeof daemonUid === "number" && existsSync(folder)) {
    const problem = sharedFolderProblem(lstatSync(folder), statSync(dirname(folder)), daemonUid);
    if (problem)
      return `${folder} belongs to another user or is not safe (${problem}), so the daemon cannot listen there. Ask root to remove it, then restart the daemon.`;
  }
  return `the daemon is not running (no daemon listens on ${socketPath}). Start it with: kitshn service install`;
}

/**
 * K-704: `kitshn provider`: stdin and stdout become one connection to the daemon, for a provider such as T3 Code.
 * `kitshn provider forget <name>` drops a provider that does not run.
 */
async function providerCommand(argv: ReadonlyArray<string>) {
  if (argv[0] === "forget") {
    const name = argv[1];
    if (!name) fail("usage: kitshn provider forget <name>");
    const answer = await ask({ id: "1", type: "provider-forget", provider: name! });
    if (answer === null) fail(notRunning());
    console.log(
      `Forgot the provider ${name}. Its cards stay on the map, offline, until you use "Forget provider" there.`,
    );
    return;
  }
  if (argv.length > 0) fail("usage: kitshn provider [forget <name>]");
  if (typeof daemonUid === "string") fail(daemonUid);
  const outcome = await bridgeLocal(
    socketPath,
    { platform, daemonUid: daemonUid as number },
    process.stdin,
    (bytes) => process.stdout.write(bytes),
  ).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  if (outcome !== "closed") fail(notRunning());
}

/**
 * K-1609, K-621: `kitshn link-check <socket>` exits 0 when this account's daemon serves the link socket, so a provider
 * that cannot read a pipe's server account itself checks it before its first call.
 */
function linkCheckCommand(path: string | undefined) {
  if (!path) fail("usage: kitshn link-check <socket or pipe>");
  const problem = linkSocketProblem(platform, path!);
  if (problem) fail(problem);
  console.log(`${path} is served by this account.`);
}

/** K-702: one request to the running daemon; null when it does not run. An error answer ends the command. */
async function ask(request: Request): Promise<Exclude<Answer, { type: "error" }> | null> {
  // A rotation waits for kitshn to store the new key (K-1705).
  if (typeof daemonUid === "string") fail(daemonUid);
  const peer = { platform, daemonUid: daemonUid as number };
  const outcome: LocalOutcome = await askLocal(socketPath, request, 30_000, peer).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  if (outcome.kind === "not-running") return null;
  if (outcome.answer.type === "error") fail(outcome.answer.error);
  return outcome.answer;
}

/**
 * K-1752: the values of the token variables that this machine's attesters read, from the environment of this
 * command; the daemon names the variables, so a command never needs to read `machine.json`.
 */
async function attestationsFromEnv(): Promise<Record<string, string>> {
  if (typeof daemonUid === "string") return {};
  const outcome = await askLocal(socketPath, { id: "1", type: "status" }, 5_000, {
    platform,
    daemonUid: daemonUid as number,
  }).catch(() => null);
  const names =
    outcome?.kind === "answer" && outcome.answer.type === "status"
      ? (outcome.answer.status.attesterEnv ?? [])
      : [];
  // K-1752: the T3 credential goes also when `status` fails or names no `t3.` attester, so kitshn can refuse it.
  return Object.fromEntries(
    [...new Set([...names, T3_TOKEN_ENV])].flatMap((name) =>
      process.env[name] ? [[name, process.env[name] as string]] : [],
    ),
  );
}

/**
 * K-1714: the agent commands (publish, address, logs, repo, redirect) reach `/agent` through the daemon, which adds
 * the machine identity and the attested labels, so the agent needs no token.
 */
function daemonTransport(): AgentTransport {
  if (typeof daemonUid === "string") throw new CliError(daemonUid);
  const peer = { platform, daemonUid: daemonUid as number };
  const ask = async (request: Request) => {
    const outcome = await askLocal(socketPath, request, 120_000, peer).catch((error: unknown) => {
      throw new CliError(error instanceof Error ? error.message : String(error));
    });
    if (outcome.kind === "not-running") throw new CliError(notRunning());
    if (outcome.answer.type === "error") throw new CliError(outcome.answer.error);
    return outcome.answer;
  };
  return {
    server: async () => {
      const answer = await ask({ id: "1", type: "status" });
      const server = answer.type === "status" ? answer.status.server : undefined;
      if (!server) throw new CliError("the daemon names no kitshn server; update the daemon.");
      return server;
    },
    call: async (path, init) => {
      const body = init.body === undefined ? undefined : Buffer.from(init.body).toString("base64");
      const answer = await ask({
        id: "1",
        type: "forward",
        method: init.method,
        path,
        ...(init.headers ? { headers: { ...init.headers } } : {}),
        ...(body === undefined ? {} : { body }),
        attestations: await attestationsFromEnv(),
      });
      if (answer.type !== "forward")
        throw new CliError(`the daemon answered ${answer.type} to a forwarded call.`);
      return new Response(Buffer.from(answer.body, "base64"), {
        status: answer.status,
        headers: answer.contentType ? { "content-type": answer.contentType } : {},
      });
    },
  };
}

/** K-1763, K-1764: one `github-token` ask for a repo; the answer, or null when the daemon does not run. */
async function askToken(repo: string): Promise<Answer | null> {
  if (typeof daemonUid === "string") return null;
  const outcome = await askLocal(
    socketPath,
    {
      id: "1",
      type: "ask",
      action: "github-token",
      target: repo,
      body: { permission: "auto" },
      attestations: await attestationsFromEnv(),
    },
    90_000,
    { platform, daemonUid: daemonUid as number },
  ).catch(() => null);
  return outcome?.kind === "answer" ? outcome.answer : null;
}

/**
 * K-1763: `kitshn git-credential get` gives git a token for a repo of an owner with the kitshn App way. For a "not kitshn"
 * owner, a daemon that does not run, or another host, it prints nothing, so git tries the next helper. A refusal or
 * a waiting ask of a kitshn owner prints `quit=1`, so git never falls back to the machine's own login.
 */
async function gitCredentialCommand(operation: string | undefined) {
  if (operation !== "get" && operation !== "erase") return;
  const repo = repoOfCredential(readCredentialInput(await Bun.stdin.text()));
  if (repo === null) return;
  // Git erases a credential that GitHub refused, so the daemon drops the kept token of that repo.
  if (operation === "erase") {
    if (typeof daemonUid !== "string")
      await askLocal(socketPath, { id: "1", type: "forget-token", repo }, 10_000, {
        platform,
        daemonUid: daemonUid as number,
      }).catch(() => null);
    return;
  }
  const reply = credentialReply(await askToken(repo));
  if (reply.stderr) console.error(reply.stderr);
  process.stdout.write(reply.stdout);
}

/**
 * K-1763: `kitshn setup-git` puts `kitshn git-credential` first for https://github.com, with useHttpPath, and keeps the
 * helpers that the user had after it.
 */
function setupGitCommand() {
  const scope = "credential.https://github.com.helper";
  const read = (key: string) =>
    spawnSync("git", ["config", "--global", "--get-all", key], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line !== "");
  const ours = `!${process.execPath} git-credential`;
  const previous = [...new Set([...read(scope), ...read("credential.helper")])].filter(
    (helper) => helper !== ours && !helper.endsWith(" git-credential"),
  );
  const git = (...args: Array<string>) => {
    const result = spawnSync("git", ["config", "--global", ...args], { encoding: "utf8" });
    if (result.status !== 0 && args[0] !== "--unset-all")
      fail(`git config ${args.join(" ")} failed: ${result.stderr}`);
  };
  git("--unset-all", scope);
  // An empty helper clears the list that git collected so far, so kitshn goes first.
  git("--add", scope, "");
  git("--add", scope, ours);
  for (const helper of previous) git("--add", scope, helper);
  git("credential.https://github.com.useHttpPath", "true");
  console.log(
    `git asks kitshn first for github.com, then: ${previous.length > 0 ? previous.join(", ") : "nothing else"}.`,
  );
}

/** K-1764: `kitshn gh <args>` runs gh with a token for the repo of --repo or of the remote origin. */
async function ghCommand(argv: ReadonlyArray<string>) {
  const at = argv.indexOf("--repo");
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).stdout ?? "";
  const repo = at >= 0 ? (argv[at + 1] ?? null) : repoOfRemote(remote);
  const env = { ...process.env };
  if (repo !== null) {
    const answer = await askToken(repo);
    if (
      answer?.type === "ask" &&
      answer.outcome === "done" &&
      typeof answer.result === "object" &&
      answer.result !== null
    ) {
      const token = (answer.result as { token?: unknown }).token;
      if (typeof token === "string") env["GH_TOKEN"] = token;
    } else if (answer?.type === "ask" && (answer.outcome === "refused" || answer.outcome === "waiting"))
      fail(
        answer.outcome === "refused"
          ? answer.reason
          : `the token waits for an approval (proposal ${answer.proposalId}).`,
      );
  }
  const run = spawnSync("gh", [...argv], { stdio: "inherit", env });
  process.exit(run.status ?? 1);
}

/**
 * K-1710: `kitshn agent <action> [target] [--reason <text>] [--label <key>=<value>]... [--body <json>]` asks
 * kitshn through the daemon and prints the result as JSON. A waiting ask follows its proposal to the end (K-1722).
 * A right that no circle sets asks the Owner first (K-1776).
 */
async function agentCommand(argv: ReadonlyArray<string>) {
  const [action, ...rest] = argv;
  if (!(ASK_ACTIONS as ReadonlyArray<string>).includes(action ?? ""))
    fail(`kitshn agent <action>: the action is one of ${ASK_ACTIONS.join(", ")}.`);
  let target = "";
  let reason: string | undefined;
  let body: unknown;
  const labels: Record<string, string> = {};
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index] ?? "";
    const value = () => rest[++index] ?? fail(`${word} needs a value.`);
    if (word === "--reason") reason = value();
    // K-1774: `--aud` is the alias of the JWT claim name.
    else if (word === "--audience" || word === "--aud") target = value();
    else if (word === "--body") {
      const text = value();
      try {
        body = JSON.parse(text);
      } catch {
        fail("--body is not JSON.");
      }
    } else if (word === "--label") {
      const pair = value();
      const equals = pair.indexOf("=");
      if (equals <= 0) fail(`--label ${pair}: write <key>=<value>.`);
      labels[pair.slice(0, equals)] = pair.slice(equals + 1);
    } else if (word.startsWith("--")) fail(`kitshn agent does not know ${word}.`);
    else if (target === "") target = word;
    else fail(`kitshn agent takes one target, not also ${word}.`);
  }
  if (typeof daemonUid === "string") fail(daemonUid);
  const request: Request = {
    id: "1",
    type: "ask",
    action: action as AskAction,
    target,
    ...(body === undefined ? {} : { body }),
    ...(reason === undefined ? {} : { reason }),
    ...(Object.keys(labels).length === 0 ? {} : { labels }),
    attestations: await attestationsFromEnv(),
  };
  const outcome = await askLocal(
    socketPath,
    request,
    90_000,
    { platform, daemonUid: daemonUid as number },
    (answer) => answer.type === "ask" && answer.outcome === "waiting",
    (answer) => {
      if (answer.type === "ask" && answer.outcome === "waiting")
        console.error(`waiting: proposal ${answer.proposalId} asks its approver circle (K-1722).`);
    },
  ).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  if (outcome.kind === "not-running") fail(notRunning());
  const answer = outcome.answer;
  if (answer.type === "error") fail(answer.error);
  if (answer.type === "ask" && answer.outcome === "refused") fail(answer.reason);
  if (answer.type === "ask-result" && answer.outcome !== "approved")
    fail(`${answer.outcome}: proposal ${answer.proposalId}${answer.reason ? ` (${answer.reason})` : ""}.`);
  const result =
    answer.type === "ask" && answer.outcome === "done"
      ? answer.result
      : answer.type === "ask-result"
        ? answer.result
        : null;
  console.log(JSON.stringify(result ?? null, null, 2));
}

/**
 * K-1751: `kitshn attester set --prefix <p.> --url <loopback url> --token-env <NAME>` registers an attester through the
 * daemon, as the daemon user or root. The T3 server runs it on start with its own port.
 */
async function attesterCommand(argv: ReadonlyArray<string>) {
  const [action, ...rest] = argv;
  const value = (name: string) => {
    const index = rest.indexOf(name);
    return index >= 0 ? (rest[index + 1] ?? "") : "";
  };
  const prefix = value("--prefix");
  const url = value("--url");
  const tokenEnv = value("--token-env");
  if (action !== "set" || !prefix || !url || !tokenEnv)
    fail("usage: kitshn attester set --prefix <prefix.> --url <loopback url> --token-env <variable>");
  if (typeof daemonUid === "string") fail(daemonUid);
  const outcome = await askLocal(
    socketPath,
    { id: "1", type: "attester-set", prefix, url, tokenEnv },
    10_000,
    { platform, daemonUid: daemonUid as number },
  ).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  if (outcome.kind === "not-running") fail(notRunning());
  const answer = outcome.answer;
  if (answer.type === "error") fail(answer.error);
  console.log(JSON.stringify(answer.type === "attester-set" ? answer.attesters : null));
}

/**
 * K-701: `kitshn local-users list|add|remove [user]` edits `localUsers` in `machine.json`. Only the daemon user
 * (and root) can read that file. The daemon reads the list at each new connection.
 */
function localUsersCommand(action: string | undefined, who: string | undefined) {
  readConfig();
  const machine = JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>;
  const users = localUsersOf(machine);
  if (users === null) fail(`localUsers in ${paths.config} is not a list of user ids. Fix it by hand.`);
  if (platform === "win32")
    fail("Windows has no local users for kitshn yet; only the user who joined uses it (K-624).");
  const own = ownUid();
  if (action === "list") {
    console.log([`${own} (the daemon user)`, ...users.map(String)].join("\n"));
    return;
  }
  if ((action !== "add" && action !== "remove") || !who)
    fail("usage: kitshn local-users list|add|remove <user or uid>");
  const uid = uidOf(who);
  if (uid === own) fail("the daemon user always can use the local socket.");
  const next = action === "add" ? [...new Set([...users, uid])] : users.filter((user) => user !== uid);
  // Through a rename, so a stop never leaves half of the file that holds the machine token.
  const temporary = `${paths.config}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...machine, localUsers: next }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.config);
  console.log(`Local users: ${next.length > 0 ? next.join(", ") : "none"}, and the daemon user ${own}.`);
  if (action === "add")
    console.log(`The user ${who} now reaches the daemon with kitshn, through ${paths.sharedSocket}.`);
}

/** K-1404: the takeover of KitSHn 1 data by root, for a daemon user with rootless Docker. */
async function kitshn1TakeoverCommand(repo?: string, environment?: string, project?: string, user?: string) {
  if (!repo || !environment || !project || !user)
    fail("usage: kitshn kitshn1-takeover <owner/repo> <environment> --project <card> --user <daemon user>");
  if (ownUid() !== 0) fail("kitshn1-takeover runs as root: it stops KitSHn 1 and reads /persistent.");
  const failWith = (error: unknown) =>
    fail(printable(error instanceof Error ? error.message : String(error)));
  const daemon = await daemonUser(user).catch(failWith);
  const plan = rootTakeoverPlan({
    repo,
    environment,
    project,
    user: daemon,
    persistentRoot: KITSHN1_PERSISTENT,
    exists: existsSync,
  });
  if (typeof plan === "string") fail(printable(plan));
  await rootTakeover(plan, daemon).catch(failWith);
}

/** A user id, from a number or a user name. */
function uidOf(who: string): number {
  if (isDigits(who)) return Number(who);
  const result = spawnSync("id", ["-u", who], { encoding: "utf8" });
  if (result.status !== 0) fail(`there is no user ${who}.`);
  return Number(result.stdout.trim());
}

const run = (argv: ReadonlyArray<string>, mayFail = false) => {
  const [program = "", ...rest] = argv;
  const result = spawnSync(program, rest, { stdio: "inherit" });
  if (result.status !== 0 && !mayFail) fail(`${argv.join(" ")} failed.`);
};

const tunnel = tunnelCommands(platform, paths.tunnelService, ownUid());

/** K-622: Task Scheduler reads a task file as UTF-16 with its byte order mark; the other service files are UTF-8. */
const serviceBytes = (text: string) =>
  platform === "win32" ? Buffer.from(`\ufeff${text}`, "utf16le") : Buffer.from(text, "utf8");

/** Writes a file only when its bytes change. Returns whether it changed. */
function writeChanged(file: string, text: string | Buffer, mode: number): boolean {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  if (existsSync(file) && readFileSync(file).equals(bytes)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes, { mode });
  chmodSync(file, mode);
  return true;
}

/**
 * K-603: installs the tunnel as its own user service and starts it. It restarts the tunnel only when cloudflared,
 * its token or its service file changed, so a daemon restart or update never stops the tunnel.
 */
async function ensureTunnel(config: JoinSecrets) {
  const { file: binary, fresh } = await ensureCloudflared();
  const tokenFile = join(paths.data, "tunnel-token");
  const tokenChanged = writeChanged(tokenFile, config.tunnelToken, 0o600);
  // K-622: the empty config keeps the tunnel off any `.cloudflared` config of the user.
  if (platform === "win32")
    writeChanged(
      join(paths.data, "cloudflared.yml"),
      // cloudflared logs an error for a config with only comments, so it holds one setting that the task also sets.
      "# kitshn: no other local settings (K-622)\nno-autoupdate: true\n",
      0o600,
    );
  const unitChanged = writeChanged(
    paths.tunnelService,
    serviceBytes(tunnelServiceFile(platform, binary, tokenFile)),
    0o644,
  );
  const steps = fresh || tokenChanged || unitChanged ? tunnel.restart : tunnel.start;
  for (const step of steps) run(step.argv, step.mayFail);
}

/**
 * K-603, K-615: stops and removes the tunnel service and its token file, after "Remove machine" or on
 * `kitshn service uninstall`. The cloudflared binary stays in the data folder.
 */
function removeTunnel() {
  for (const step of tunnel.stop) run(step.argv, step.mayFail);
  rmSync(paths.tunnelService, { force: true });
  rmSync(join(paths.data, "tunnel-token"), { force: true });
}

async function serviceCommand(action: string | undefined) {
  const file = paths.service;
  const commands = serviceCommands(platform, file, ownUid());
  if (action === "install") {
    // The tunnel service starts before the old daemon stops, so a daemon that still runs its own cloudflared
    // hands over with no gap.
    await ensureTunnel(readConfig());
    mkdirSync(dirname(file), { recursive: true });
    // A second install replaces the running daemon, for example after a new download.
    for (const argv of commands.stop) run(argv, true);
    writeFileSync(file, serviceBytes(serviceFile(platform, process.execPath)));
    for (const argv of commands.start) run(argv);
    console.log(`kitshn runs as a user service (${file}).`);
    if (platform === "linux") {
      console.log("For a start without a login, the user needs lingering: loginctl enable-linger $USER");
    }
  } else if (action === "uninstall") {
    for (const argv of commands.stop) run(argv, true);
    rmSync(file, { force: true });
    removeTunnel();
    const folders = [...new Set([dirname(paths.config), paths.data])];
    console.log(
      `Removed ${file}, ${paths.tunnelService} and the tunnel token. These folders stay: ${folders.join(", ")}` +
        ` (${paths.config} and machine.key hold the machine token and key; the data folder holds cloudflared,` +
        ` the apps and the sample history). Delete them with: rm -r ${folders.map((folder) => `"${folder}"`).join(" ")}`,
    );
  } else fail("usage: kitshn service install|uninstall");
}

/** K-603: the cloudflared of the tunnel service, downloaded once. `fresh` says that this call downloaded it. */
async function ensureCloudflared(): Promise<{ file: string; fresh: boolean }> {
  const file = join(paths.data, platform === "win32" ? WINDOWS_CLOUDFLARED : "cloudflared");
  if (existsSync(file)) return { file, fresh: false };
  mkdirSync(paths.data, { recursive: true });
  const { url, archive } = cloudflaredUrl(platform, arch());
  log(`downloading cloudflared from ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cloudflared download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (archive) {
    const tgz = `${file}.tgz`;
    writeFileSync(tgz, bytes);
    const result = spawnSync("tar", ["-xzf", tgz, "-C", paths.data]);
    rmSync(tgz, { force: true });
    if (result.status !== 0) throw new Error("cloudflared archive could not be unpacked.");
  } else writeFileSync(file, bytes);
  chmodSync(file, 0o755);
  return { file, fresh: true };
}

function sample() {
  const disk = statfsSync(platform === "win32" ? `${process.env["SystemDrive"] ?? "C:"}\\` : "/");
  return {
    at: Date.now(),
    cpu: Math.min(1, (loadavg()[0] ?? 0) / Math.max(1, cpus().length)),
    memory: 1 - freemem() / totalmem(),
    disk: 1 - disk.bavail / disk.blocks,
  };
}

/** K-605: the samples of the last hour, for `samples` on the local socket; read from the file at start. */
const RECENT_SAMPLES = 60;
let recentSamples: Array<ReturnType<typeof sample>> = [];

/** K-606: the daemon keeps 30 days of samples on its own disk. */
function keepSample(value: ReturnType<typeof sample>) {
  const file = join(paths.data, "samples.jsonl");
  mkdirSync(paths.data, { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
  recentSamples = [...recentSamples, value].slice(-RECENT_SAMPLES);
}

function pruneSamples() {
  const file = join(paths.data, "samples.jsonl");
  if (!existsSync(file)) return;
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60_000;
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line && (JSON.parse(line) as { at: number }).at >= cutoff);
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
}

/**
 * K-612, K-617: downloads the daemon of the release that kitshn names, checks it against the release's
 * SHA256SUMS, puts it in place of this binary, and exits; the service manager starts the new one.
 */
async function updateDaemon(
  version: string,
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const failed = (output: string) => ({ ok: false, exitCode: null, output });
  if (!/^[0-9a-f]{12}$/.test(version)) return failed(`kitshn named no valid release (${version}).`);
  // A daemon run from source has the runtime as its execPath; replacing that would break the runtime.
  if (VERSION === "dev") return failed("This daemon runs from source; update it from the repo.");
  if (version === VERSION) return { ok: true, exitCode: 0, output: `Already at ${version}.` };
  const name = `${releaseAsset(platform, arch())}.gz`;
  const base = `${RELEASES}/edge-${version}`;
  try {
    const sums = await fetch(`${base}/SHA256SUMS`);
    const binary = await fetch(`${base}/${name}`);
    if (!sums.ok || !binary.ok) return failed(`The release edge-${version} has no ${name}.`);
    const expected = expectedHash(await sums.text(), name);
    const packed = new Uint8Array(await binary.arrayBuffer());
    const actual = createHash("sha256").update(packed).digest("hex");
    if (!expected || expected !== actual)
      return failed(`${name} of edge-${version} does not match its SHA256SUMS.`);
    const bytes = gunzipSync(packed);
    const next = `${process.execPath}.new`;
    // A leftover file keeps its old mode, so start fresh and set the mode explicitly.
    rmSync(next, { force: true });
    writeFileSync(next, bytes);
    chmodSync(next, 0o755);
    // K-620: Windows cannot replace a running .exe, but it can rename one; the next start deletes the old one.
    if (platform === "win32")
      await swapBinary(
        { rename: renameSync },
        process.execPath,
        next,
        oldBinaryName(process.execPath, Date.now()),
      );
    else renameSync(next, process.execPath);
  } catch (error) {
    return failed(`The update failed: ${String(error)}`);
  }
  restartSoon();
  return { ok: true, exitCode: 0, output: `Updated ${VERSION} to ${version}; restarting.` };
}

/**
 * K-620: deletes the copies that earlier updates renamed. A copy that still runs (a `kitshn provider` bridge, for
 * example) stays until a later try; the daemon starts anyway and tries again every hour.
 */
function removeOldBinaries() {
  const left = oldBinaries(process.execPath, readdirSync(dirname(process.execPath))).filter((file) => {
    try {
      rmSync(file, { force: true });
      return false;
    } catch (error) {
      log(`${file} is still in use; kitshn deletes it later (${String(error)})`);
      return true;
    }
  });
  if (left.length > 0) setTimeout(removeOldBinaries, 60 * 60_000).unref();
}

/**
 * K-601: exits so that the service manager starts the daemon again. K-622: Task Scheduler does not start an action
 * that ended, so on Windows a hidden PowerShell runs the task again once this daemon is gone.
 */
function restartSoon() {
  if (platform === "win32")
    spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Sleep 3; schtasks /Run /TN '${WINDOWS_TASKS.daemon}'`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    ).unref();
  setTimeout(() => process.exit(0), 500);
}

/** Ends a job and its children: its process group, or on Windows its process tree. */
function killTree(pid: number) {
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Process groups of running shell jobs. They end with the daemon, also under launchd. */
const runningGroups = new Set<number>();
process.on("exit", () => {
  for (const pid of runningGroups) killTree(pid);
});

type JobOutcome = {
  ok: boolean;
  exitCode: number | null;
  output: string;
  /** K-821: the image id of each service of a Compose build that came up. */
  images?: Record<string, string>;
  /** K-1817 */
  backup?: BackupReport;
};

/** Runs a program with a time limit; it gets its own process group, so the limit also ends its children. */
function runProgram(
  program: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<JobOutcome> {
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = (result: JobOutcome) => {
      if (done) return;
      done = true;
      if (child.pid) runningGroups.delete(child.pid);
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(program, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    if (child.pid) runningGroups.add(child.pid);
    // The end of the output holds the error of a failed build, so a long output keeps its end.
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => {
      if (child.pid) killTree(child.pid);
      finish({
        ok: false,
        exitCode: null,
        output: `${output}\n[kitshn: the job ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped]`,
      });
    }, timeoutMs);
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, output }));
    child.on("error", (error) => finish({ ok: false, exitCode: null, output: String(error) }));
  });
}

/** A Compose build can take longer than a shell command. */
const COMPOSE_TIMEOUT_MS = 30 * 60_000;
const SOCKET_WAIT_MS = 180_000;

let joined: JoinSecrets | null = null;

/** K-812: a file of the running deploy, read with the machine token. */
async function deployFile(deployId: string, file: string): Promise<Buffer> {
  if (!joined) throw new Error("The daemon has no machine token.");
  const response = await fetch(new URL(`/connect/deploys/${deployId}/${file}`, joined.server), {
    headers: { "CF-Access-Client-Id": joined.clientId, "CF-Access-Client-Secret": joined.clientSecret },
  });
  if (!response.ok)
    throw new Error(`kitshn answered ${response.status} for ${file}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

/** K-1404: the persistent root of KitSHn 1 on this machine. */
const KITSHN1_PERSISTENT = process.env["KITSHN1_PERSISTENT"] ?? "/persistent";

/**
 * K-812, K-607: builds and starts a Compose app with the variables of KitSHn 1, so its `compose.yml` works
 * unchanged: the app listens on `$KITSHN_DEFAULT_SOCKET`. Then the socket becomes a live site under the
 * name of the address, and the tunnel sends the address there.
 */
async function composeUp(
  command: Extract<Command, { kind: "compose" | "compose-redeploy" | "compose-rollback" }>,
  notify?: { readonly url: string; readonly token: string },
): Promise<JobOutcome> {
  const dir = join(paths.data, "apps", command.project);
  // K-818: each deploy unpacks into a new folder that no running container mounts, so the old app runs on
  // while the new one is read, checked and built. A job of the same app never runs at the same time.
  const source = join(dir, `src-${Date.now().toString(36)}`);
  const sockets = join(dir, "sockets");
  const socketPath = join(sockets, "default.sock");
  /** K-818: the configs hold the values of the params, so they stay in a folder of the daemon user only. */
  const scratch = join(dir, "private");
  const checked = join(scratch, "compose.checked.json");
  let output = "";
  /** K-1404: the KitSHn 1 project that this job stopped, which a failure starts again. */
  let stoppedKitshn1: string | null = null;
  /** The volumes that the takeover made, which a failure removes so a retry copies fresh. */
  const madeVolumes: Array<string> = [];
  /** K-818: the containers of the old app that this job stopped, which a failure before `up` starts again. */
  let stoppedIds: Array<string> = [];
  let upStarted = false;
  const step = async (title: string, program: string, args: ReadonlyArray<string>, options = {}) => {
    output += `$ ${title}\n`;
    const result = await runProgram(program, args, { timeoutMs: COMPOSE_TIMEOUT_MS, ...options });
    output += result.output;
    if (!result.ok) throw new Error(`${title} failed with exit code ${result.exitCode ?? "none"}`);
  };
  try {
    mkdirSync(dir, { recursive: true });
    // K-718: the last build that came up stays in good/ with its params; a redeploy starts it again.
    const good = join(dir, "good");
    // K-821: the build before it stays in good.prev/, with the image tags of both, for a rollback.
    const previous = join(dir, "good.prev");
    // A stop in the middle of the swap below leaves only good.old; it is still the last good build.
    if (!existsSync(good) && existsSync(`${good}.old`)) renameSync(`${good}.old`, good);
    if (command.kind === "compose-rollback") {
      if (keptId(previous) !== command.deployId)
        throw new Error(
          `this machine keeps no build of the deploy ${command.deployId} to roll back to; it keeps ${keptId(previous) ?? "none"} (K-821)`,
        );
      copyFileSync(join(previous, "source.tgz"), join(dir, "source.tgz"));
      copyFileSync(join(previous, "params.env"), join(dir, "params.env"));
      chmodSync(join(dir, "params.env"), 0o600);
    } else if (command.kind === "compose-redeploy") {
      if (!existsSync(join(good, "source.tgz")) || !existsSync(join(good, "params.env")))
        throw new Error("this machine keeps no build of the app that came up; deploy it from the repo");
      copyFileSync(join(good, "source.tgz"), join(dir, "source.tgz"));
      copyFileSync(join(good, "params.env"), join(dir, "params.env"));
      chmodSync(join(dir, "params.env"), 0o600);
    } else {
      writeFileSync(join(dir, "source.tgz"), await deployFile(command.deployId, "source.tgz"));
      writeFileSync(join(dir, "params.env"), await deployFile(command.deployId, "params.env"), {
        mode: 0o600,
      });
    }
    mkdirSync(source);
    await step("unpack the source", "tar", ["-xzf", join(dir, "source.tgz"), "-C", source]);
    // K-1404: the first deploy of an app on this machine takes over the data of its KitSHn 1 deployment.
    // KitSHn 1 stops first, so no write lands after the copy; root-owned files need a short container.
    const data = join(dir, "data");
    const marker = join(dir, "kitshn1-taken");
    const takeover =
      command.kind === "compose"
        ? takeoverPlan({
            repo: command.repo,
            environment: command.environment,
            persistentRoot: KITSHN1_PERSISTENT,
            hasData: existsSync(data),
            taken: existsSync(marker),
            exists: existsSync,
          })
        : ({ kind: "skip", note: null } as const);
    if (takeover.kind === "skip" && takeover.note) output += `${takeover.note}\n`;
    const env = {
      ...process.env,
      KITSHN_RECIPE: command.repo,
      KITSHN_ENVIRONMENT: command.environment,
      KITSHN_DEPLOYMENT: command.project,
      KITSHN_SOCKET_DIR: sockets,
      KITSHN_DEFAULT_SOCKET: socketPath,
      KITSHN_DATA_DIR: data,
      KITSHN_LOG_DIR: join(dir, "logs"),
      KITSHN_PARAMS_FILE: join(dir, "params.env"),
      // K-1908: the app passes these on in its Compose file, as it does with KITSHN_DATA_DIR.
      ...(notify ? { KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: notify.token } : {}),
    };
    // KitSHn 1 apps join this network; it exists on a KitSHn 1 host and is made elsewhere.
    if (!(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok) {
      // Another deploy may make it at the same moment; only a network that is still missing is an error.
      const made = await runProgram("docker", ["network", "create", "kitshn-edge"]);
      if (!made.ok && !(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok)
        throw new Error(`docker network create kitshn-edge failed: ${made.output}`);
    }
    // K-818: risky Compose settings run only when the owner allows them for this repo on this machine. The
    // check runs before the takeover, so a refused deploy leaves KitSHn 1 as it is.
    const refuse = (risks: ReadonlyArray<string>) => {
      const refused = risks.filter((risk) => !command.allowed.includes(risk));
      if (refused.length > 0)
        throw new Error(
          `the Compose file asks for ${refused.join(", ")}; the owner allows each one for ${command.repo} in the panel of this machine (K-818)`,
        );
    };
    const real = realpathOnDisk;
    // Explicit files, so a `COMPOSE_FILE` in the params cannot add a file that the check never reads.
    const files = composeFiles(source, command.file, existsSync, real);
    // Before Compose reads the files, so it never fetches what `include` or `extends` names.
    refuse(
      files.flatMap((path) => {
        try {
          return rawRisks(readFileSync(path, "utf8"));
        } catch (error) {
          throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)} (K-818)`);
        }
      }),
    );
    const composeArgs = [
      "compose",
      "-p",
      command.project,
      ...files.flatMap((file) => ["-f", file]),
      "--env-file",
      env.KITSHN_PARAMS_FILE,
    ];
    const roots = [source, data, env.KITSHN_LOG_DIR, sockets] as const;
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    chmodSync(scratch, 0o700);
    const readConfig = async (extra: ReadonlyArray<string>) => {
      const file = join(scratch, "compose.config.json");
      try {
        await step(
          "read the Compose settings",
          "docker",
          [...composeArgs, "config", "--format", "json", ...extra, "-o", file],
          {
            cwd: source,
            env,
          },
        );
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } finally {
        rmSync(file, { force: true });
      }
    };
    // Without the params first, so an error in the files does not show their values.
    // It names the env and label files without reading them; the run with the params reads them.
    refuse(envFileRisks(await readConfig(["--no-interpolate"]), roots, real));
    const config = await readConfig([]);
    refuse(composeRisks(config, command.project, roots, real));
    if (takeover.kind === "take") {
      // K-1404: rootless Docker sees neither the KitSHn 1 project nor its root-owned files; root takes the data over.
      // A Docker that kitshn cannot name stops the deploy too, so it never copies on the wrong Docker.
      const kind = dockerKind(await runProgram("docker", ["info", "--format", "{{json .SecurityOptions}}"]));
      if (kind === "unknown")
        throw new Error(
          `KitSHn 1 data waits at ${takeover.dataDir}, and docker info failed, so kitshn copies nothing (K-1404).`,
        );
      if (kind === "rootless") {
        const self = userInfo();
        throw new Error(
          `KitSHn 1 data waits at ${takeover.dataDir}, and this daemon uses rootless Docker. As root, run: ` +
            `${process.execPath} kitshn1-takeover ${command.repo} ${command.environment} --project ${command.project} --user ${self.username}` +
            " Then deploy again (K-1404).",
        );
      }
      // Set first: a stop that fails half-way still gets its start back.
      stoppedKitshn1 = takeover.project;
      await step("stop the KitSHn 1 app", "docker", ["compose", "-p", takeover.project, "stop"], {
        cwd: paths.data,
      });
      // A staged copy becomes the data folder only when it is complete.
      const staged = `${data}.kitshn1`;
      output += await removeAsRoot(staged, `${command.project}-stage`);
      mkdirSync(staged, { recursive: true });
      await step("copy the KitSHn 1 data", "docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${takeover.dataDir}:/from:ro`,
        "-v",
        `${staged}:/to`,
        HELPER_IMAGE,
        "cp",
        "-a",
        "/from/.",
        "/to/",
      ]);
      const volumes = await runProgram("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${takeover.project}`,
      ]);
      if (!volumes.ok) throw new Error(`docker volume ls failed: ${volumes.output}`);
      for (const volume of volumes.output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)) {
        const target = movedVolume(volume, takeover.project, command.project);
        if (!target) continue;
        const suffix = target.slice(command.project.length + 1);
        madeVolumes.push(target);
        await step(`create the volume ${target}`, "docker", [
          "volume",
          "create",
          "--label",
          `com.docker.compose.project=${command.project}`,
          "--label",
          `com.docker.compose.volume=${suffix}`,
          target,
        ]);
        await step(`copy the volume ${volume}`, "docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${volume}:/from:ro`,
          "-v",
          `${target}:/to`,
          HELPER_IMAGE,
          "cp",
          "-a",
          "/from/.",
          "/to/",
        ]);
      }
      renameSync(staged, data);
      writeFileSync(marker, `${takeover.dataDir}\n`);
      output += `KitSHn 1 data of ${takeover.project} copied from ${takeover.dataDir}; it stays there for a rollback.\n`;
      output += `KitSHn 1 is stopped, so the site is down until you move the DNS record of ${command.name} to the tunnel (K-1404).\n`;
    }
    // The container user may not be the daemon user; the socket directory must take its socket.
    mkdirSync(sockets, { recursive: true });
    chmodSync(sockets, 0o777);
    for (const folder of [data, env.KITSHN_LOG_DIR]) mkdirSync(folder, { recursive: true });
    // Build and start from the checked config itself, so the repo's files are not read again. It stays with
    // the last good build, so a teardown reads the same services.
    // K-1908: the token stays out of this file, which stays with the last good build.
    writeFileSync(checked, JSON.stringify(withNotify(withLogLimits(config), notify)), { mode: 0o600 });
    // The params file again: without it Compose reads the repo's `.env`, and `COMPOSE_PROFILES` is lost.
    const run = [
      "compose",
      "-p",
      command.project,
      "--project-directory",
      source,
      "-f",
      checked,
      "--env-file",
      env.KITSHN_PARAMS_FILE,
    ];
    // K-821: a rollback runs the kept images of that deploy through an override, with no build and no pull.
    let images = serviceImages(config, command.project);
    if (command.kind === "compose-rollback") {
      const override = rollbackOverride(config, command.project, command.deployId);
      const overrideFile = join(scratch, "compose.rollback.json");
      writeFileSync(overrideFile, JSON.stringify(override), { mode: 0o600 });
      run.push("-f", overrideFile);
      images = new Map(Object.entries(override.services).map(([service, pinned]) => [service, pinned.image]));
      // Before the app stops: a missing kept image fails here, and the app runs on.
      for (const [service, tag] of images)
        await step(`find the kept image of ${service}`, "docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          tag,
        ]);
    } else
      await step("docker compose build", "nice", ["-n", "19", "docker", ...run, "build"], {
        cwd: source,
        env,
      });
    // K-818: no container of the app runs from here to `up`, so none can swap a path in the data, log or
    // sockets folder between the check below and `up`. Orphans and one-off runs count too.
    const running = await runProgram("docker", [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${command.project}`,
    ]);
    if (!running.ok) throw new Error(`docker ps failed: ${running.output}`);
    const ids = running.output
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
    // Set first: a stop that fails half-way still gets its start back.
    stoppedIds = ids;
    if (ids.length > 0) await step("stop the app", "docker", ["stop", ...ids]);
    // The takeover may also have brought links into the data folder.
    const moved = sourceRisks(config, roots, real).filter((risk) => !command.allowed.includes(risk));
    if (moved.length > 0) throw new Error(`a path changed after the check: ${moved.join(", ")} (K-818)`);
    // A teardown takes down what the last `up` started, also when that `up` failed.
    copyFileSync(checked, join(scratch, "down.json"));
    copyFileSync(env.KITSHN_PARAMS_FILE, join(scratch, "down.env"));
    upStarted = true;
    await step("docker compose up", "docker", [...run, "up", "-d", "--no-build", "--remove-orphans"], {
      cwd: source,
      env,
    });
    const until = Date.now() + SOCKET_WAIT_MS;
    while (!(await probe(`unix:${socketPath}`))) {
      if (Date.now() > until) throw new Error(`the app opened no socket at ${socketPath} within 3 minutes`);
      await new Promise((done) => setTimeout(done, 2000));
    }
    const sites = readSites();
    if (sites === null) throw new Error(`${sitesFile()} is broken; fix it, then deploy again`);
    const next = addSite(sites, { name: command.name, target: `unix:${socketPath}`, dev: false });
    if (typeof next === "string") throw new Error(next);
    writeSites(next);
    void checkSites();
    // K-821: the deploy of this build: a redeploy starts the build of good/ again, so it keeps its id.
    const deployId = command.kind === "compose-redeploy" ? keptId(good) : command.deployId;
    const kept: Record<string, string> = {};
    if (deployId !== null)
      for (const [service, image] of images) {
        const id = await runProgram("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
        if (!id.ok) continue;
        const tag = keptTag(command.project, service, deployId);
        // A rollback runs the kept tag itself; only a service whose tag exists counts as kept.
        if (image !== tag && !(await runProgram("docker", ["tag", image, tag])).ok) continue;
        kept[service] = id.output.trim();
      }
    // The build and its params change together: a stop in between leaves the old pair, the new pair or none.
    const staged = join(dir, "good.next");
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { mode: 0o700 });
    renameSync(join(dir, "source.tgz"), join(staged, "source.tgz"));
    copyFileSync(join(dir, "params.env"), join(staged, "params.env"));
    chmodSync(join(staged, "params.env"), 0o600);
    if (deployId !== null) writeFileSync(join(staged, "deploy-id"), `${deployId}\n`);
    rmSync(checked, { force: true });
    keepBuild(dir, staged, command.kind === "compose-redeploy", /^pr-\d+$/.test(command.environment));
    output += await pruneKept(
      command.project,
      [keptId(good), keptId(previous)].flatMap((id) => (id ? [id] : [])),
    );
    // The containers of the last build may have written into their source as root (a bind mount of `.`).
    // A folder that stays costs disk only; the app is up, so the deploy still succeeds.
    for (const old of sourceFolders(dir).filter((folder) => folder !== source))
      output += await removeAsRoot(old, `${command.project}-${basename(old)}`).catch(
        (cleanup: unknown) => `${String(cleanup)}\n`,
      );
    output += `\nThe app answers on its socket; the tunnel sends ${command.name} there.\n`;
    return { ok: true, exitCode: 0, output, images: kept };
  } catch (error) {
    output += `\n[kitshn: ${error instanceof Error ? error.message : String(error)}]`;
    rmSync(checked, { force: true });
    // K-818: before `up`, the old containers and their source are as they were, so the old app runs again.
    // After `up` started, Compose replaced them; the app stays down until a deploy or redeploy comes up.
    if (!upStarted) {
      if (stoppedIds.length > 0) {
        const started = await runProgram("docker", ["start", ...stoppedIds]);
        output += `$ start the app again\n${started.output}`;
      }
      output += await removeAsRoot(source, `${command.project}-${basename(source)}`).catch(
        (cleanup: unknown) => `${String(cleanup)}\n`,
      );
    }
    // A takeover that did not end in a running app gives the site back to KitSHn 1, and the next deploy
    // copies its data again, so no write of KitSHn 1 is lost.
    if (stoppedKitshn1 !== null) {
      // By its project label alone; the app's folder holds no Compose file.
      await runProgram("docker", ["compose", "-p", command.project, "down"], { cwd: dir });
      rmSync(join(dir, "kitshn1-taken"), { force: true });
      for (const folder of ["data", "data.kitshn1"])
        output += await removeAsRoot(
          join(dir, folder),
          `${command.project}-${folder.replace(".", "-")}`,
        ).catch((cleanup: unknown) => `${String(cleanup)}\n`);
      for (const volume of madeVolumes)
        output += (await runProgram("docker", ["volume", "rm", volume])).output;
      const started = await runProgram("docker", ["compose", "-p", stoppedKitshn1, "start"], {
        cwd: paths.data,
      });
      output += `$ start the KitSHn 1 app ${stoppedKitshn1} again\n${started.output}`;
    }
    return { ok: false, exitCode: null, output };
  }
}

/**
 * K-821: removes the kept image tags of an app that no kept build names, then the images that no tag holds any more
 * (dangling only, so no other image goes), and counts what the daemon keeps for the machine card.
 */
async function pruneKept(project: string, keep: ReadonlyArray<string>): Promise<string> {
  const listed = await runProgram("docker", [
    "image",
    "ls",
    "--format",
    "{{.Repository}}:{{.Tag}}",
    "--filter",
    `reference=kitshn-keep/${project}/*`,
  ]);
  if (!listed.ok) return `$ list the kept images\n${listed.output}`;
  let output = "";
  const stale = staleTags(
    listed.output.split("\n").map((line) => line.trim()),
    project,
    keep,
  );
  if (stale.length > 0) output += (await runProgram("docker", ["image", "rm", ...stale])).output;
  await runProgram("docker", ["image", "prune", "-f"]);
  await countKept();
  return output;
}

/** K-821: the bytes of the kept images of all apps, at most: an image counts whole, also its shared layers. */
let keptBytes: number | undefined;

async function countKept() {
  const ids = await runProgram("docker", [
    "image",
    "ls",
    "-q",
    "--no-trunc",
    "--filter",
    "reference=kitshn-keep/*/*",
  ]);
  if (!ids.ok) return;
  const unique = [
    ...new Set(
      ids.output
        .split("\n")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (unique.length === 0) {
    keptBytes = 0;
  } else {
    const sizes = await runProgram("docker", ["image", "inspect", "--format", "{{.Size}}", ...unique]);
    if (!sizes.ok) return;
    keptBytes = sizes.output
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((size) => Number.isFinite(size))
      .reduce((sum, size) => sum + size, 0);
  }
  report();
}

/** Short root jobs on app folders (copy, clean-up); busybox has `cp -a` and `find -delete` and is a few MB. */
// Pinned by digest, so no app can take the name with an image of its own (K-818).
/** K-818: the source folders of an app: the one of its last deploy, and any of a deploy that failed in `up`. */
const sourceFolders = (dir: string): Array<string> =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name === "src" || name.startsWith("src-"))
        .sort()
        .map((name) => join(dir, name))
    : [];

/**
 * Removes a folder that an app's containers wrote into, often as root, which the daemon user cannot remove.
 * A short container with the same folder deletes what is inside; nothing widens the permissions of files.
 * Returns the output, or throws when the folder stays.
 */
async function removeAsRoot(dir: string, name: string): Promise<string> {
  if (!existsSync(dir)) return "";
  const inside = await runProgram(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `kitshn-clean-${name}`,
      "--network",
      "none",
      "-v",
      `${dir}:/app`,
      HELPER_IMAGE,
      "find",
      "/app",
      "-mindepth",
      "1",
      "-delete",
    ],
    { timeoutMs: COMPOSE_TIMEOUT_MS },
  );
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `${dir} stays: ${error instanceof Error ? error.message : String(error)}\n${inside.output}`,
    );
  }
  return `$ remove ${dir}\n${inside.output}`;
}

/** K-904: stops the app, stops exposing it, and for a preview removes its volumes and files. */
async function composeDown(command: Extract<Command, { kind: "compose-down" }>): Promise<JobOutcome> {
  const sites = readSites();
  if (sites) writeSites(sites.filter((site) => site.name !== command.name));
  void checkSites();
  const dir = join(paths.data, "apps", command.project);
  // K-818: the checked config of the last `up` names the same services and profiles; the repo's own files
  // are never read. Without one, Compose finds the app by its project label alone.
  const last = [join(dir, "private", "down.json"), join(dir, "private", "down.env")] as const;
  const files = last.every((file) => existsSync(file)) ? ["-f", last[0], "--env-file", last[1]] : [];
  const result = await runProgram(
    "docker",
    [
      "compose",
      "-p",
      command.project,
      ...files,
      "down",
      "--remove-orphans",
      ...(command.removeData ? ["--volumes", "--rmi", "local"] : []),
    ],
    // The app's folder holds no Compose file, so Compose reads none of the repo's files.
    { timeoutMs: COMPOSE_TIMEOUT_MS, cwd: existsSync(dir) ? dir : paths.data },
  );
  // Containers that may still run could write while the files go, so a failed down keeps them for a retry.
  if (!command.removeData || !result.ok) return result;
  // K-821: a removed preview keeps no build, so its kept image tags go too.
  await pruneKept(command.project, []);
  // Also the volumes that no kept config names, such as those of an earlier build.
  const volumes = await runProgram("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${command.project}`,
  ]);
  const names = volumes.output
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  const removed =
    volumes.ok && names.length > 0 ? await runProgram("docker", ["volume", "rm", ...names]) : volumes;
  const output = `${result.output}${removed.output}`;
  if (!removed.ok) return { ok: false, exitCode: removed.exitCode, output };
  try {
    return { ...result, output: output + (await removeAsRoot(dir, command.project)) };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      output: `${output}\n[kitshn: ${error instanceof Error ? error.message : String(error)}]`,
    };
  }
}

/**
 * K-909: the idle volumes of kitshn apps, read from Docker; null when Docker does not answer. Known limit:
 * runProgram keeps the last 64 KiB of output, which cuts the list at about a thousand volumes. Revisit then.
 */
async function readIdleVolumes(): Promise<Array<ProjectVolume> | null> {
  const volumes = await runProgram("docker", ["volume", "ls", "--format", VOLUME_FORMAT]);
  const running = await runProgram("docker", ["ps", "--format", RUNNING_FORMAT]);
  if (!volumes.ok || !running.ok) return null;
  const apps = join(paths.data, "apps");
  return idleVolumes(volumes.output, running.output, existsSync(apps) ? readdirSync(apps) : []);
}

/** K-909: tells kitshn the idle volumes, so the machine card lists the orphaned ones. */
async function reportVolumes() {
  const volumes = await readIdleVolumes();
  if (volumes === null || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "volumes", volumes } satisfies DaemonMessage));
}

/** K-909: deletes one volume, only while it is still an idle volume of that kitshn app. */
async function removeVolume(
  command: Extract<Command, { kind: "compose-volume-remove" }>,
): Promise<JobOutcome> {
  const idle = await readIdleVolumes();
  if (idle === null)
    return { ok: false, exitCode: null, output: "Docker does not answer, so the volume stays." };
  const refusal = volumeRemoveRefusal(idle, command);
  if (refusal !== null) return { ok: false, exitCode: null, output: refusal };
  const removed = await runProgram("docker", ["volume", "rm", command.volume]);
  if (!removed.ok) return removed;
  // K-821: an orphaned volume belongs to a removed app, so its kept builds go with it, also good/ with its params.
  for (const set of ["good", "good.prev"])
    rmSync(join(paths.data, "apps", command.project, set), { recursive: true, force: true });
  return { ...removed, output: removed.output + (await pruneKept(command.project, [])) };
}

/** One Compose job per app at a time: a teardown never runs during the build of the same app. */
const appQueues = new Map<string, Promise<unknown>>();
function oneAtATime(project: string, work: () => Promise<JobOutcome>): Promise<JobOutcome> {
  const next = (appQueues.get(project) ?? Promise.resolve()).then(work, work);
  appQueues.set(project, next);
  return next;
}

function runJob(
  jobId: number,
  command: Command,
  notify?: { readonly url: string; readonly token: string },
): Promise<JobOutcome> {
  if (
    command.kind === "compose" ||
    command.kind === "compose-redeploy" ||
    command.kind === "compose-rollback"
  )
    return oneAtATime(command.project, () => composeUp(command, notify));
  if (command.kind === "compose-down") return oneAtATime(command.project, () => composeDown(command));
  if (command.kind === "compose-volume-remove")
    return oneAtATime(command.project, () => removeVolume(command));
  if (command.kind === "diagnostics") {
    const text = [
      `kitshn ${VERSION}`,
      `machine ${hostname()} ${osPlatform()} ${release()} ${arch()}`,
      `uptime ${Math.round(uptime() / 60)} minutes`,
      `config ${paths.config}`,
      `data ${paths.data}`,
      `cloudflared ${tunnelState}`,
    ].join("\n");
    return Promise.resolve({ ok: true, exitCode: 0, output: text });
  }
  if (command.kind === "update") return updateDaemon(command.version);
  if (command.kind === "provider") return runProviderCommand(command, jobId);
  if (command.kind === "backup" || command.kind === "backup-restore") {
    if (!joined)
      return Promise.resolve({ ok: false, exitCode: null, output: "The daemon has no machine token." });
    const machine = { ...joined, data: paths.data };
    // K-1816: one Compose job of an app at a time, so a backup never pauses an app in the middle of a deploy.
    return oneAtATime(command.card, async () => {
      const outcome =
        command.kind === "backup"
          ? await backup(machine, command.card, command.run, command.prune, command.pauseLimitMs)
          : await restore(
              machine,
              command.card,
              command.run,
              command.before,
              command.sources,
              command.pauseLimitMs,
            );
      return { ...outcome, exitCode: outcome.ok ? 0 : 1 };
    });
  }
  if (command.kind === "doors") {
    if (doorState.problem !== null)
      return Promise.resolve({ ok: false, exitCode: 1, output: `no doors here: ${doorState.problem}` });
    const outcome = applyDoorsHere(command.plan);
    if (outcome.ok) syncRelays(command.plan);
    checkListening();
    return Promise.resolve({ ...outcome, exitCode: outcome.ok ? 0 : 1 });
  }
  if (command.kind === "restart") {
    restartSoon();
    return Promise.resolve({ ok: true, exitCode: 0, output: "restarting" });
  }
  // `$KITSHN` is this daemon's binary, so a job can run `"$KITSHN" expose …` (K-1104).
  // From source, execPath is bun itself, not kitshn. K-624: Windows runs the script in Windows PowerShell.
  const [shell, ...shellArgs] =
    platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
      : ["/bin/sh", "-c"];
  return runProgram(shell ?? "/bin/sh", [...shellArgs, command.script], {
    env: VERSION === "dev" ? process.env : { ...process.env, KITSHN: process.execPath },
  });
}

let tunnelState: "starting" | "running" | "stopped" = "stopped";
let socket: WebSocket | null = null;

function report() {
  const message: DaemonMessage = {
    type: "status",
    status: {
      // K-624: Windows has no Docker setup in v1, so the map refuses Compose, logs and backups there with a reason.
      capabilities:
        platform === "win32"
          ? ["update", "update-gz", "provider", "access", ...(doorState.problem === null ? ["doors"] : [])]
          : [
              "update",
              "update-gz",
              "compose",
              "compose-redeploy",
              "compose-guard",
              "compose-rollback",
              "logs",
              "backup",
              "backup-restore",
              "provider",
              // K-1608: this daemon answers `applied` for each push that it saved.
              "applied",
              // K-1623: this daemon saves the Access audiences of its providers and gives them on.
              "access",
              ...(doorState.problem === null ? ["doors"] : []),
            ],
      ...(keptBytes === undefined ? {} : { keptBytes }),
      version: VERSION,
      os: `${osPlatform()} ${release()}`,
      arch: arch(),
      hostname: hostname(),
      tunnel: tunnelState,
      // K-1751: the map shows the attesters of each machine.
      attesters: attestersOf(readMachineFile()).attesters.map(({ prefix, address }) => ({ prefix, address })),
      // K-2009: a Windows PC behind its router reports the router's outside address, once doors work there.
      publicAddresses:
        platform === "win32"
          ? { v4: doorState.problem === null ? windowsDoors.seen : null, v6: null }
          : publicAddresses(),
      ...(doorState.problem === null ? {} : { doorsProblem: doorState.problem }),
      listening: [...doorState.listening],
    },
  };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** K-2002, K-2006: whether this machine can gate game ports, and which game ports listen. */
const doorState: { problem: string | null; listening: ReadonlySet<string> } = {
  problem: "not checked yet",
  listening: new Set(),
};
const doorsFile = () => join(paths.data, "doors.json");
const relays = new Relays(log);
process.on("exit", () => relays.stopAll());

/** K-2008: the relays of a plan, after its doors are in the table. */
function syncRelays(plan: DoorPlan) {
  void ensureCloudflared()
    .then(({ file }) => relays.sync(plan.relays, file, readConfig()))
    .catch((error: unknown) => log(`the relays could not start: ${String(error)}`));
}

/** K-2006: the game ports of the kept plan that something listens on; a change goes out in the status. */
function checkListening() {
  const plan = keptPlan(doorsFile());
  const wanted = new Set((plan?.ports ?? []).map(({ port, proto }) => `${port}/${proto}`));
  const found =
    wanted.size === 0
      ? new Set<string>()
      : new Set(
          [
            ...(platform === "win32"
              ? netstatListening(
                  spawnSync("netstat", ["-an"], { encoding: "utf8", windowsHide: true }).stdout ?? "",
                )
              : listening(spawnSync("ss", ["-H", "-ltnu"], { encoding: "utf8" }).stdout ?? "")),
          ].filter((key) => wanted.has(key)),
        );
  if ([...found].sort().join() === [...doorState.listening].sort().join()) return;
  doorState.listening = found;
  report();
}

/** K-2005: after a restart or a reboot the table is empty or old; the kept plan goes in again before kitshn sends one. */
function startDoors() {
  checkListening();
  setInterval(checkListening, 30_000);
  if (platform === "win32") {
    void checkWindowsDoors(true);
    setInterval(() => void checkWindowsDoors(false), 60_000);
    return;
  }
  doorState.problem = doorsProblem(platform);
  if (platform !== "linux") return;
  if (doorState.problem === null) applyKeptPlan();
  // K-2005: each minute, a start problem is checked again (the network was not up yet, or sudo failed once), and
  // the kept plan goes in again, because a \`flush ruleset\` (nftables.service, a reload) can delete the table at
  // any time and the daemon user cannot list it. The apply is idempotent.
  setInterval(() => {
    if (doorState.problem === null) return applyKeptPlan(true);
    doorState.problem = doorsProblem(platform);
    if (doorState.problem !== null) return;
    applyKeptPlan();
    report();
  }, 60_000);
}

/** K-2009: the router's UPnP state and the public address that the internet sees, on Windows. */
const windowsDoors: { upnp: UpnpState; seen: string | null } = {
  upnp: { problem: "not checked yet" },
  seen: null,
};

/**
 * K-2009: each minute on Windows: the router forwards of the kept plan, the public address, and whether doors work.
 * The helper re-reads the plan file itself; the daemon writes it again, so a deleted file comes back.
 */
async function checkWindowsDoors(start: boolean) {
  const before = doorState.problem;
  const plan = keptPlan(doorsFile());
  windowsDoors.upnp = syncUpnp(plan?.ports ?? []);
  windowsDoors.seen = await fetch("https://ipv4.icanhazip.com", { signal: AbortSignal.timeout(5000) })
    .then((answer) => (answer.ok ? answer.text() : ""))
    .then((text) => text.trim() || null)
    .catch(() => windowsDoors.seen);
  doorState.problem = windowsDoorsProblem(windowsDoors.upnp, windowsDoors.seen);
  if (doorState.problem === null && plan) writeWindowsPlan(plan, Date.now());
  if (start || doorState.problem !== before) report();
}

/** K-2005, K-2009: one plan into this machine's firewall, and kept for a restart. */
function applyDoorsHere(plan: DoorPlan): { ok: boolean; output: string } {
  if (platform !== "win32") return applyDoors(plan, doorsFile(), Date.now());
  try {
    writeWindowsPlan(plan, Date.now());
  } catch (error) {
    return { ok: false, output: `the plan file could not be written: ${String(error)}` };
  }
  windowsDoors.upnp = syncUpnp(plan.ports);
  if ("problem" in windowsDoors.upnp) return { ok: false, output: windowsDoors.upnp.problem };
  writeFileSync(`${doorsFile()}.new`, JSON.stringify(plan), { mode: 0o600 });
  renameSync(`${doorsFile()}.new`, doorsFile());
  return { ok: true, output: `doors: ${plan.ports.map(portKey).join(" ") || "no game ports"}` };
}

/** K-2005: the plan that this daemon wrote last goes into the table again before kitshn sends a new one. */
function applyKeptPlan(quiet = false) {
  const plan = keptPlan(doorsFile());
  if (plan === null) {
    if (!quiet && existsSync(doorsFile()))
      log("the kept door plan is not readable; waiting for kitshn's plan");
    return;
  }
  const outcome = applyDoorsHere(plan);
  if (!outcome.ok) log(`the kept door plan failed: ${outcome.output}`);
  else if (!quiet) log(`kept ${outcome.output}`);
  if (outcome.ok) syncRelays(plan);
}

/** K-605: the tunnel state comes from its service manager; a change goes out in the status. */
function watchTunnel() {
  const check = () => {
    const [program = "", ...rest] = tunnel.state;
    const result = spawnSync(program, rest, { encoding: "utf8" });
    const state = tunnelStateOf(platform, result.stdout ?? "");
    if (state === tunnelState) return;
    tunnelState = state;
    report();
  };
  check();
  setInterval(check, 5000);
}

const pendingResults: Array<DaemonMessage> = [];

/** K-1804: kitshn reads only the logs of apps that it deployed here, which each have a folder below `apps`. */
const kitshnApp = (project: string) => existsSync(join(paths.data, "apps", project));
const notKitshnApp = (project: string) => ({
  state: "error" as const,
  error: `${project} is no app that kitshn deployed on this machine, so the daemon reads no logs of it.`,
});

/** K-1805: the running tails by id; each ends when its connection closes. */
const tails = new Map<string, () => void>();

function stopTails() {
  for (const stopTail of tails.values()) stopTail();
  tails.clear();
}

/** K-1804, K-1805: log answers go out on the connection that asked, and are lost with it. */
function sendOn(ws: WebSocket, message: DaemonMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function flushResults() {
  while (socket?.readyState === WebSocket.OPEN && pendingResults.length > 0) {
    socket.send(JSON.stringify(pendingResults.shift()));
  }
}

/** K-1704: the challenge of the accepted connection; a rotation signs it too (K-1705). */
let challenge: string | null = null;
let rotating = false;

/**
 * K-1704: signs the challenge with the key that kitshn names. Returns "answered", "token-only" when kitshn has
 * no key for this machine (K-1708: status only, no jobs, until `kitshn rekey`), or why this key cannot pass.
 */
async function answerChallenge(
  ws: WebSocket,
  config: JoinSecrets,
  message: Extract<ServerToDaemon, { type: "challenge" }>,
): Promise<"answered" | "wrong-key" | "no-key" | "token-only"> {
  const fingerprint = async (file: string) => {
    const key = readKey(file);
    return key ? fingerprintOf(key.x) : null;
  };
  const plan = keyPlan(message.fingerprint, {
    current: await fingerprint(keyFile),
    next: await fingerprint(nextKeyFile),
    fromCode: await fingerprint(codeKeyFile),
  });
  // kitshn took the key, but the end of its command or the 4004 close never came (K-1705, K-1706).
  if (plan.promote === "fromCode") renameSync(codeKeyFile, keyFile);
  if (plan.promote === "next") renameSync(nextKeyFile, keyFile);
  // A rotation that kitshn never took; a new "Rotate key" or `kitshn rotate-key` asks again.
  if (plan.dropNext) rmSync(nextKeyFile, { force: true });
  if (message.fingerprint === null) {
    log(
      "kitshn has no key for this machine, so it gets status only and no job. Run kitshn rekey with the key code of its panel.",
    );
    return "token-only";
  }
  const key = readKey(keyFile);
  if (!key) {
    log(
      `kitshn expects the key ${message.fingerprint}, and ${keyFile} is missing. Use Reset key on the map, then kitshn rekey <code>.`,
    );
    return "no-key";
  }
  const signing = await fingerprintOf(key.x);
  const signature = await signText(key, connectText(config.server, config.machineId, message.challenge));
  ws.send(JSON.stringify({ type: "answer", signature } satisfies DaemonMessage));
  challenge = message.challenge;
  if (message.fingerprint === signing) return "answered";
  log(
    `kitshn expects the key ${message.fingerprint}, but this machine has ${signing}. Use Reset key on the map, then kitshn rekey <code>.`,
  );
  return "wrong-key";
}

type RotationOutcome = { readonly fingerprint: string } | { readonly error: string };
/** K-1705: the `rotate-key` requests of the local socket that wait for kitshn to store the new key. */
const rotationWaiters: Array<(outcome: RotationOutcome) => void> = [];
const keptTokens = new TokenCache();
/** K-1710: the asks that wait for kitshn's answer, by request id. */
const askWaiters = new Map<string, (outcome: AskOutcome) => void>();
/** K-1722: the local connections that wait for the answer to a proposal, by proposal id. */
const proposalWaiters = new Map<string, Array<(event: Answer) => void>>();

/** K-1723: after an approval of a token, the same ask runs once more, and its answer becomes the approved result. */
async function askAgain(
  request: Extract<Request, { type: "ask" }>,
  event: Answer,
  emit: (event: Answer) => void,
) {
  if (event.type !== "ask-result" || event.outcome !== "approved") return emit(event);
  const again = await askKitshn(request, () => {}).catch((error: unknown) => ({
    type: "ask" as const,
    outcome: "refused" as const,
    reason: String(error),
  }));
  emit(
    again.type === "ask" && again.outcome === "done"
      ? { ...event, result: again.result }
      : {
          type: "ask-result",
          proposalId: event.proposalId,
          outcome: "denied",
          reason:
            again.type === "ask" && again.outcome === "refused" ? again.reason : "kitshn gave no token.",
        },
  );
}

/** K-1751: writes one attester into `machine.json`, replacing an older entry of the same prefix. */
function setAttester(request: Extract<Request, { type: "attester-set" }>, caller: Caller): Answer {
  // K-1751: the registering user must hold the port now; the entry keeps that uid, and each check compares it again.
  let port = 0;
  try {
    port = portOf(request.url);
  } catch {
    throw new Error(`kitshn refuses this attester: ${request.url} is not an address (K-1751).`);
  }
  if (listenerUid(platform, port) !== caller.uid)
    throw new Error(
      `kitshn refuses this attester: port ${port} is not held by user id ${caller.uid} (K-1751).`,
    );
  const machine = readMachineFile();
  // A file that the daemon cannot read is never rewritten, so its tokens stay.
  if (typeof machine !== "object" || machine === null || Array.isArray(machine))
    throw new Error(`the daemon cannot read ${paths.config}, so it changes no attester.`);
  const next = withAttester(machine as Record<string, unknown>, {
    prefix: request.prefix,
    address: request.url,
    tokenEnv: request.tokenEnv,
    uid: caller.uid,
  });
  if (typeof next === "string") throw new Error(`kitshn refuses this attester: ${next} (K-1751).`);
  const temporary = `${paths.config}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.config);
  log(`attester ${request.prefix} set to ${request.url}`);
  // K-1751: the map shows the new attester without a daemon restart.
  report();
  return {
    id: request.id,
    type: "attester-set",
    attesters: attestersOf(next).attesters.map(({ prefix, address, tokenEnv }) => ({
      prefix,
      address,
      tokenEnv,
    })),
  };
}

/** K-1752, K-1753: the labels that the attesters of this machine vouch for, each asked with its own token only. */
async function attestedFor(attestations: Readonly<Record<string, string>> | undefined) {
  const { attesters } = attestersOf(readMachineFile());
  const unregistered = unregisteredT3(attestations, attesters);
  if (unregistered) throw new AttestationError(unregistered);
  const attested: Record<string, string> = {};
  for (const attester of attesters) {
    const token = attestations?.[attester.tokenEnv];
    if (!token) continue;
    // K-1751: a stale port that another user took never gets the caller's token.
    if (attester.uid !== undefined && listenerUid(platform, portOf(attester.address)) !== attester.uid)
      throw new AttestationError(
        `could not check the ${attester.prefix === "t3." ? "T3" : attester.prefix.slice(0, -1)} thread: its port is not held by the user that registered it; restart that service.`,
      );
    const result = await attest(attester, token);
    // K-1752: a call with a token never falls back to the bare machine.
    const refusal = attestationRefusal(attester, result);
    if (refusal) throw new AttestationError(refusal);
    if (result.outcome === "labels") Object.assign(attested, result.labels);
  }
  return attested;
}

/**
 * K-1714: one call of a local agent to `/agent`, with the machine token and a signature of the machine key over the
 * method, the path, the time, a nonce and the attested labels. Only `x-kitshn-` headers and the content type pass.
 */
let forwards = 0;

async function forwardCall(request: Extract<Request, { type: "forward" }>): Promise<Answer> {
  if (forwards >= MAX_FORWARDS)
    throw new Error(`the daemon forwards at most ${MAX_FORWARDS} calls at once; try again (K-1714).`);
  forwards++;
  try {
    return await forwardOnce(request);
  } finally {
    forwards--;
  }
}

async function forwardOnce(request: Extract<Request, { type: "forward" }>): Promise<Answer> {
  if (!joined) throw new Error("the daemon has not read machine.json yet.");
  const key = readKey(keyFile);
  if (!key)
    throw new Error("this machine has no key, so it cannot forward a call (K-1714). Run kitshn rekey.");
  const url = forwardTarget(joined.server, request.path);
  if (typeof url === "string") throw new Error(`the daemon forwards only /agent calls: ${url} (K-1714)`);
  const body = request.body === undefined ? undefined : Buffer.from(request.body, "base64");
  if (body && body.length > MAX_FORWARD_BYTES)
    throw new Error(
      `the body is larger than ${MAX_FORWARD_BYTES} bytes, the limit of a forwarded call (K-1714).`,
    );
  const labels = JSON.stringify(await attestedFor(request.attestations));
  const at = Date.now();
  const nonce = crypto.randomUUID();
  const labelsHash = createHash("sha256").update(labels).digest("hex");
  const signature = await signText(
    key,
    forwardText(joined.server, joined.machineId, {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      at,
      nonce,
      labelsHash,
    }),
  );
  const passed = passedHeaders(request.headers ?? {});
  const response = await fetch(url, {
    method: request.method,
    redirect: "error",
    headers: {
      ...passed,
      "CF-Access-Client-Id": joined.clientId,
      "CF-Access-Client-Secret": joined.clientSecret,
      [FORWARD_HEADERS.signature]: signature,
      [FORWARD_HEADERS.at]: String(at),
      [FORWARD_HEADERS.nonce]: nonce,
      [FORWARD_HEADERS.labels]: labels,
    },
    ...(body ? { body } : {}),
  });
  const answer = await readBounded(response, MAX_FORWARD_BYTES);
  return {
    id: request.id,
    type: "forward",
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: answer.toString("base64"),
  };
}

/** K-1710: sends an ask of a local agent over the signed connection, and gives the answer back on the socket. */
async function askKitshn(
  request: Extract<Request, { type: "ask" }>,
  emit: (event: Answer) => void,
): Promise<Answer> {
  const ws = socket;
  if (ws === null || challenge === null)
    throw new Error(
      "the daemon has no signed connection to kitshn, so it cannot ask (K-1710). See kitshn status.",
    );
  const requestId = crypto.randomUUID();
  const { id, type: _type, labels, attestations, ...rest } = request;
  // K-1752, K-1753: only an attester sets the labels of its prefix; the caller's token goes to that attester only.
  const { attesters } = attestersOf(readMachineFile());
  let attested: Record<string, string>;
  try {
    attested = await attestedFor(attestations);
  } catch (error) {
    // K-1752: a thread that no attester vouched for is a refusal of this ask, which git-credential stops on.
    if (error instanceof AttestationError)
      return { id, type: "ask", outcome: "refused", reason: error.message };
    throw error;
  }
  const ask = {
    ...rest,
    ...(labels ? { labels: dropAttested(labels, attesterPrefixes(attesters)) } : {}),
    ...(Object.keys(attested).length > 0 ? { attested } : {}),
  };
  // K-1762: a kept token goes only to the same repo and the same attested thread; an ask without one always asks kitshn.
  const thread = request.action === "github-token" ? attested["t3.thread.id"] : undefined;
  const body = request.body;
  const wanted =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>)["permission"] : "auto";
  const kept = thread ? keptTokens.get(request.target, thread, wanted, Date.now()) : null;
  if (kept) return { id, type: "ask", outcome: "done", result: kept };
  const outcome = await new Promise<AskOutcome>((resolve) => {
    const timer = setTimeout(() => {
      askWaiters.delete(requestId);
      resolve({ outcome: "refused", reason: "kitshn did not answer within 60 seconds." });
    }, 60_000);
    askWaiters.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    ws.send(JSON.stringify({ type: "ask", requestId, ask } satisfies DaemonMessage));
  });
  if (outcome.outcome === "waiting")
    proposalWaiters.set(outcome.proposalId, [
      ...(proposalWaiters.get(outcome.proposalId) ?? []),
      WINDOW_ACTIONS.has(request.action) ? (event) => void askAgain(request, event, emit) : emit,
    ]);
  if (thread && outcome.outcome === "done" && typeof outcome.result === "object" && outcome.result !== null) {
    const { token, expiresAt, permission } = outcome.result as Record<string, unknown>;
    if (typeof token === "string" && typeof expiresAt === "string")
      keptTokens.set(request.target, thread, {
        token,
        expiresAt,
        permission: permission === "write" ? "write" : "read",
      });
  }
  return { id, type: "ask", ...outcome };
}
const settleRotation = (outcome: RotationOutcome) => {
  for (const waiter of rotationWaiters.splice(0)) waiter(outcome);
};
/** The fingerprint of the key that the current connection rotates to. */
let rotatingTo: string | null = null;

/** K-1705: makes a new pair and hands over to it with a signature of the old key, bound to this connection. */
async function rotateKey(ws: WebSocket) {
  if (rotating || challenge === null || socket !== ws || !joined) return;
  keptTokens.drop(null);
  const current = readKey(keyFile);
  if (!current) {
    log(`no key to rotate in ${keyFile}`);
    return settleRotation({ error: `there is no key to rotate in ${keyFile}.` });
  }
  rotating = true;
  let next: MachinePrivateKey;
  let signature: string;
  try {
    next = await newMachineKey();
    writeKey(nextKeyFile, next);
    signature = await signText(current, rotateText(joined.server, joined.machineId, challenge, next.x));
  } catch (error) {
    // Nothing went out yet, so kitshn has no new key.
    rotating = false;
    rmSync(nextKeyFile, { force: true });
    log(`the key rotation failed: ${String(error)}`);
    return settleRotation({ error: `the key rotation failed: ${String(error)}` });
  }
  rotatingTo = await fingerprintOf(next.x);
  // From here kitshn may store the new key, so `machine.key.next` stays until the next challenge names a key.
  ws.send(JSON.stringify({ type: "rotate", publicKey: next.x, signature } satisfies DaemonMessage));
  log(`rotating the machine key to ${rotatingTo}`);
}

/** K-1706, K-1708: ends the current connection or wait and connects again at once, for `kitshn rekey`. */
let reconnectNow = () => {};

/** K-604: one WebSocket to kitshn, with backoff after a failure and a ping every 10 seconds. */
function connect(config: JoinSecrets) {
  joined = config;
  let delay = 1000;
  // After a 4001, 4002 or 4005 close, or a key that cannot pass, every later try waits an hour, until a
  // connection opens again.
  let stopped = false;
  let current: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let soon = false;
  reconnectNow = () => {
    stopped = false;
    delay = 1000;
    if (current) {
      soon = true;
      current.close();
    } else {
      if (timer) clearTimeout(timer);
      open();
    }
  };
  const open = () => {
    timer = null;
    const url = new URL("/connect", config.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url.toString(), {
      headers: { "CF-Access-Client-Id": config.clientId, "CF-Access-Client-Secret": config.clientSecret },
    } as unknown as string);
    current = ws;
    let lastPong = Date.now();
    let ping: ReturnType<typeof setInterval> | null = null;
    /** True when kitshn expects a key that this machine does not have, so the next try fails the same way. */
    let wrongKey = false;
    ws.onopen = () => {
      lastPong = Date.now();
      ping = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          log("no pong for 30 s; connecting again");
          ws.close();
          return;
        }
        ws.send("ping");
      }, PING_MS);
    };
    /** K-1704: kitshn reads this connection from now on. */
    const accepted = (how: string) => {
      log(`connected to kitshn ${how}`);
      // K-1762: a new connection can follow a reset or a lost right that the daemon did not hear of.
      keptTokens.drop(null);
      socket = ws;
      delay = 1000;
      stopped = false;
      flushResults();
      report();
      sendProviders();
      lastSites = "";
      lastServers = null;
      iconMemory = new Map();
      void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`));
      void sendServers().catch((error: unknown) => log(`server scan failed: ${String(error)}`));
      void reportVolumes().catch((error: unknown) => log(`volume report failed: ${String(error)}`));
      ws.send(JSON.stringify({ type: "sample", sample: sample() } satisfies DaemonMessage));
    };
    ws.onmessage = (event) => {
      const text = String(event.data);
      if (text === "pong") {
        lastPong = Date.now();
        return;
      }
      const message = JSON.parse(text) as ServerToDaemon;
      if (message.type === "challenge") {
        void answerChallenge(ws, config, message)
          .then((result) => {
            wrongKey = result === "wrong-key" || result === "no-key";
            if (result === "no-key") ws.close();
            if (result === "token-only") accepted("on the token alone");
          })
          .catch((error: unknown) => {
            log(`could not answer the challenge: ${String(error)}`);
            ws.close();
          });
      } else if (message.type === "accepted") {
        accepted(`with the key ${message.fingerprint}`);
      } else if (message.type === "rotateKey") {
        void rotateKey(ws);
      } else if (
        message.type === "grants" ||
        message.type === "desired" ||
        message.type === "settings" ||
        message.type === "reach" ||
        message.type === "access"
      ) {
        // K-1608: the daemon saves each push, gives it to the provider, and tells kitshn that it applied it.
        const key =
          message.type === "grants"
            ? pushKey.grants(message.provider)
            : message.type === "settings"
              ? pushKey.settings(message.provider)
              : message.type === "reach"
                ? pushKey.reach(message.provider)
                : message.type === "access"
                  ? pushKey.access(message.provider)
                  : pushKey.desired(message.provider, message.kind);
        const { hash: _hash, ...event } = message;
        const value =
          message.type === "grants"
            ? message.tables
            : message.type === "settings"
              ? message.values
              : message.type === "reach"
                ? message.cards
                : message.type === "access"
                  ? message.access
                  : message.state;
        if (registry().setPushed(key, value)) {
          const connection = registry().connectionOf(message.provider);
          const emit = connection === null ? undefined : providerEmitters.get(connection);
          emit?.(event);
        }
        sendOn(ws, { type: "applied", key, hash: message.hash });
      } else if (message.type === "name") {
        // K-704: the answer to register names the machine, also before the next connection.
        registry().setPushed(MACHINE_NAME_KEY, message.name);
      } else if (message.type === "forgetProvider") {
        // K-704: a provider that a connection holds runs, so the forget does not apply to it.
        if (
          registry().connectionOf(message.provider) === null &&
          registry().forget(message.provider) === null
        )
          sendProviders();
      } else if (message.type === "requestAnswer") {
        answerWaiters.get(message.requestId)?.(message.error);
        answerWaiters.delete(message.requestId);
      } else if (message.type === "dropTokens") {
        keptTokens.drop(message.repo);
      } else if (message.type === "logs") {
        // K-1804: the data folder holds no Compose file, so Compose finds the app by its project label alone.
        void (
          kitshnApp(message.project)
            ? searchLogs(composeLogs(message.project, rangeArgs(message.search)), message.search, paths.data)
            : Promise.resolve(notKitshnApp(message.project))
        )
          .catch((error: unknown) => ({ state: "error" as const, error: String(error) }))
          .then((answer) => sendOn(ws, { type: "logs", id: message.id, answer }));
      } else if (message.type === "tail" && !kitshnApp(message.project)) {
        sendOn(ws, { type: "tailEnd", id: message.id, reason: notKitshnApp(message.project).error });
      } else if (message.type === "tail") {
        tails.get(message.id)?.();
        tails.set(
          message.id,
          followLogs(
            composeLogs(message.project, ["--follow", "--tail", "100"]),
            paths.data,
            (lines, skipped) => sendOn(ws, { type: "tailLines", id: message.id, lines, skipped }),
            (reason) => {
              tails.delete(message.id);
              sendOn(ws, { type: "tailEnd", id: message.id, reason });
            },
          ),
        );
      } else if (message.type === "tailStop") {
        tails.get(message.id)?.();
        tails.delete(message.id);
      } else if (message.type === "askAnswer") {
        const { type: _type, requestId, ...outcome } = message;
        askWaiters.get(requestId)?.(outcome);
        askWaiters.delete(requestId);
      } else if (message.type === "askResult") {
        const { type: _type, ...result } = message;
        for (const emit of proposalWaiters.get(result.proposalId) ?? [])
          emit({ type: "ask-result", ...result });
        proposalWaiters.delete(result.proposalId);
      } else if (message.type === "job") {
        log(`job ${message.id}: ${message.command.kind}`);
        // A job that throws (for example a file it cannot delete) still sends a result, and never ends the daemon.
        void runJob(message.id, message.command, message.notify)
          .catch((error: unknown): JobOutcome => ({
            ok: false,
            exitCode: null,
            output: `[kitshn: ${String(error)}]`,
          }))
          .then((result) => {
            // The connection can change while a job runs; the result goes out on the current one.
            pendingResults.push({ type: "jobResult", id: message.id, result });
            flushResults();
            // K-909: a Compose job can leave volumes idle or take them away.
            if (message.command.kind.startsWith("compose"))
              void reportVolumes().catch((error: unknown) => log(`volume report failed: ${String(error)}`));
          });
      }
    };
    ws.onclose = (event) => {
      if (ping) clearInterval(ping);
      // K-1805: kitshn forgets the tails of a closed connection.
      if (socket === ws) stopTails();
      if (socket === ws) socket = null;
      // K-709: a request in flight gets no answer from a closed connection.
      for (const [requestId, settle] of answerWaiters) {
        settle(`the connection to kitshn closed (${event.code}) before its answer.`);
        answerWaiters.delete(requestId);
      }
      // K-1716: an ask in flight gets no result from a closed connection; its proposal stays.
      for (const [requestId, settle] of askWaiters) {
        settle({
          outcome: "refused",
          reason: `the connection to kitshn closed (${event.code}) before its answer.`,
        });
        askWaiters.delete(requestId);
      }
      // K-1705: kitshn stored the new key; the next connection signs with it.
      if (event.code === 4004 && existsSync(nextKeyFile)) renameSync(nextKeyFile, keyFile);
      settleRotation(
        event.code === 4004 && rotatingTo !== null
          ? { fingerprint: rotatingTo }
          : {
              error: `the connection closed (${event.code}) before kitshn stored the new key. See kitshn status.`,
            },
      );
      challenge = null;
      rotating = false;
      rotatingTo = null;
      // 4001: another daemon with the same token took over; 4002: the owner removed this machine; 4005: the
      // owner reset its key. Like a key that cannot pass, they would repeat forever with a short backoff, so
      // they wait long (a removed machine also needs a new join, a reset one `kitshn rekey`).
      if (event.code === 4001 || event.code === 4002 || event.code === 4005 || wrongKey) stopped = true;
      // K-615: kitshn deleted the tunnel of this machine; its service has nothing left to serve.
      if (event.code === 4002) {
        log(
          "the owner removed this machine; removing the tunnel service. Run kitshn service uninstall to stop the daemon.",
        );
        removeTunnel();
      }
      if (current === ws) current = null;
      const wait = soon || event.code === 4004 ? 0 : stopped ? 60 * 60_000 : delay;
      soon = false;
      log(`connection closed (${event.code} ${event.reason}); trying again in ${wait / 1000} s`);
      timer = setTimeout(open, wait);
      delay = Math.min(delay * 2, 60_000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}

const sitesFile = () => join(paths.data, "sites.json");

/** The sites of this machine, or null when `sites.json` is broken. */
function readSites(): Array<SiteEntry> | null {
  if (!existsSync(sitesFile())) return [];
  try {
    return parseSiteFile(JSON.parse(readFileSync(sitesFile(), "utf8")));
  } catch {
    return null;
  }
}

/** Writes `sites.json` through a rename, so the daemon never reads half a file. */
function writeSites(sites: ReadonlyArray<SiteEntry>) {
  mkdirSync(paths.data, { recursive: true });
  const temporary = `${sitesFile()}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sites, null, 2)}\n`);
  renameSync(temporary, sitesFile());
}

/**
 * K-1104, K-1131: `kitshn expose <port, address or socket> --name <name> [--dev] [--time 1h]`. With `--time`, the new
 * card gets that end time (K-212); at the end it leaves every circle for the tray.
 */
function exposeCommand(
  value: string | undefined,
  name: string | undefined,
  dev: boolean,
  time: string | undefined,
  onlyNew: boolean,
) {
  const usage =
    "usage: kitshn expose <port, localhost:port or /path/to.sock> --name <name> [--dev] [--time 30m|1h|4h|1d]";
  if (!value || !name) fail(usage);
  const target = targetOf(value);
  if (typeof target !== "string") fail(target.error);
  // `--ends-at` is the time in milliseconds, as the site wizard sends it (K-1131); `--time` is a span from now.
  const at = time !== undefined && isDigits(time) ? Number(time) : undefined;
  const end = time === undefined || at !== undefined ? undefined : timeBody(time, Date.now());
  const endsAt =
    at !== undefined && at > Date.now()
      ? at
      : end !== undefined && "endsAt" in end && end.endsAt !== null
        ? end.endsAt
        : undefined;
  if (time !== undefined && endsAt === undefined)
    fail(`--time takes 30m, 1h, 4h or 1d, and --ends-at a future time in milliseconds, not ${time}.`);
  const current = readSites();
  if (current === null) fail(`${sitesFile()} is broken. Fix it or delete it, then expose the sites again.`);
  // K-1131: the site wizard only makes sites; it never points a shared name at another server.
  if (onlyNew && current!.some((site) => site.name === name))
    fail(`${name} is shared already on this machine. Pick another name.`);
  const sites = addSite(current!, { name, target, dev, ...(endsAt === undefined ? {} : { endsAt }) });
  if (typeof sites === "string") fail(sites);
  writeSites(sites as Array<SiteEntry>);
  console.log(
    `Exposed ${target} as ${name}. Its card arrives in the tray of the map, private until you share it${endsAt === undefined ? "" : `, and it leaves every circle at ${new Date(endsAt).toISOString()}`}.`,
  );
}

/** K-619: the listening ports of this machine, the same scan that the site wizard of the map shows. */
async function serversCommand(asJson: boolean) {
  const servers = await scanServers(platform, [], true);
  if (asJson) return void process.stdout.write(`${JSON.stringify(servers)}\n`);
  if (servers.length === 0) return void console.log("No server listens on this machine.");
  for (const server of servers)
    console.log(
      [
        String(server.port).padEnd(6),
        (server.process ?? "?").padEnd(16),
        server.status ?? "no http",
        server.title ?? "",
      ]
        .join(" ")
        .trimEnd(),
    );
  console.log("Share one with: kitshn expose <port> --name <name> [--time 1h]");
}

function unexposeCommand(name: string | undefined) {
  const sites = readSites();
  if (sites === null) fail(`${sitesFile()} is broken. Fix it or delete it.`);
  if (!name || !sites!.some((site) => site.name === name)) fail(`no live site is named ${name ?? "(none)"}.`);
  writeSites(sites!.filter((site) => site.name !== name));
  console.log(`Stopped exposing ${name}.`);
}

let lastSites = "";

/** K-1107: tries each site every 10 seconds and reports the list only when it changes. */
async function checkSites() {
  // A broken file must not look like "no sites": that would remove every card and its shares on the map.
  const sites = readSites();
  if (sites === null) {
    log(`${sitesFile()} is broken; kitshn keeps the last report until it is fixed.`);
    return;
  }
  // K-705: the live sites of provider cards come after the hand-made ones; a hand-made site of the same name yields.
  const providerSites = registry().sites();
  const held = new Set(providerSites.map((site) => site.name));
  for (const site of sites)
    if (held.has(site.name)) log(`sites.json: ${site.name} belongs to a provider card; it is not exposed.`);
  const all = [...sites.filter((site) => !held.has(site.name)), ...providerSites];
  const reports = await Promise.all(all.map(async (site) => ({ ...site, up: await probe(site.target) })));
  const text = JSON.stringify({ type: "sites", sites: reports } satisfies DaemonMessage);
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (text !== lastSites) {
    lastSites = text;
    socket.send(text);
  }
  void sendIcons(socket, reports).catch((error: unknown) => log(`icon read failed: ${String(error)}`));
}

/** K-1114: per site, what this connection read and sent; a new connection starts empty. */
let iconMemory = new Map<string, IconMemory>();
let readingIcons = false;

/** K-1114: reads the icons that are due through each site's own target, and sends the ones that changed. */
async function sendIcons(ws: WebSocket, reports: ReadonlyArray<LiveSiteReport>) {
  if (readingIcons) return;
  readingIcons = true;
  try {
    const memory = iconMemory;
    const now = Date.now();
    const due = new Set(iconsDue(reports, memory, now));
    for (const report of reports) {
      const known = memory.get(report.name);
      if (!due.has(report.name)) {
        // Only "down" is recorded here: a site that came back stays marked until its delayed read is due.
        if (known?.up && !report.up) memory.set(report.name, { ...known, up: false });
        continue;
      }
      const icon = await targetIcon(report.target);
      const hash = icon ? new Bun.CryptoHasher("sha256").update(icon.bytes).digest("hex") : null;
      const sent = known?.sent ?? null;
      const send = iconToSend(sent, hash, now) && ws.readyState === WebSocket.OPEN && memory === iconMemory;
      if (send) {
        const message: DaemonMessage = {
          type: "icon",
          site: report.name,
          icon: icon ? Buffer.from(icon.bytes).toString("base64") : null,
        };
        ws.send(JSON.stringify(message));
      }
      memory.set(report.name, { readAt: now, up: true, sent: send ? { hash, at: now } : sent });
    }
    for (const name of memory.keys())
      if (!reports.some((report) => report.name === name)) memory.delete(name);
  } finally {
    readingIcons = false;
  }
}

/** K-618: `kitshn skill install [--repo]` and `kitshn skill check`. */
function skillCommand(action: string | undefined, repo: boolean) {
  try {
    if (action === "install")
      console.log(repo ? installRepoSkill(process.cwd(), VERSION) : installGlobalSkill(homedir(), VERSION));
    else if (action === "check") {
      const result = checkSkill(homedir(), process.cwd(), VERSION);
      for (const line of result.lines) console.log(line);
      if (!result.ok) process.exit(1);
    } else fail("usage: kitshn skill install [--repo] | kitshn skill check");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function runCommand() {
  const config = readConfig();
  log(`kitshn ${VERSION} starts as machine ${config.machineId}`);
  // K-618: after an update, the global skill follows the new release.
  try {
    const refreshed = refreshGlobalSkill(homedir(), VERSION);
    if (refreshed) log(refreshed);
  } catch (error) {
    log(`the global kitshn skill was not written again: ${String(error)}`);
  }
  // Before the socket opens, so `status` answers from the first request.
  joined = config;
  // K-1816: an app that a stopped daemon left paused in the middle of a backup runs again.
  void unpauseMarked(paths.data, log)
    .then(() => finishRestores(paths.data, log))
    .catch((error: unknown) =>
      log(`the clean-up after a stopped backup or restore failed: ${String(error)}`),
    );
  // First, so a second daemon stops before it touches the tunnel or the connection of the running one.
  const own = ownUid();
  if (platform === "win32") removeOldBinaries();
  const socketOptions = {
    platform,
    // Read at each connection, so `kitshn local-users` needs no restart.
    decide: (peer: number) => peerDecision(peer, own, localUsersOf(readMachineFile())),
    handle: answerLocal,
    log,
    closed: providerClosed,
  };
  const local = await listenLocal(paths.socket, { ...socketOptions, access: "private" });
  process.on("exit", local.stop);
  // K-1609: the link proxy of the providers, in the same private folder, so only the daemon user and root reach it.
  // K-1609, K-621: a start without the link proxy still serves the rest; the answer to register then names none.
  const links = await serveLinks(linkSocket, {
    reachOf: (provider) => registry().reachOf(provider),
    token: () => (joined ? { clientId: joined.clientId, clientSecret: joined.clientSecret } : null),
    log,
  }).catch((error: unknown) => {
    log(`no link proxy: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  linkServed = links !== null;
  if (links) process.on("exit", links.stop);
  // K-701: the users in `localUsers` connect here. An unsafe folder costs only this socket, not the daemon.
  const shared =
    platform === "win32"
      ? null
      : await listenLocal(paths.sharedSocket, { ...socketOptions, access: "shared" }).catch(
          (error: unknown) => {
            log(`no shared socket: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          },
        );
  if (shared) process.on("exit", shared.stop);
  // The service manager stops the daemon with SIGTERM; an exit runs the clean-up of the socket and the jobs.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  pruneSamples();
  startDoors();
  recentSamples = lastSamples(
    existsSync(join(paths.data, "samples.jsonl"))
      ? readFileSync(join(paths.data, "samples.jsonl"), "utf8")
      : "",
    RECENT_SAMPLES,
  );
  await ensureTunnel(config);
  watchTunnel();
  // K-821: the machine card shows what the kept builds take on disk.
  void countKept();
  connect(config);
  setInterval(() => {
    const value = sample();
    keepSample(value);
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "sample", sample: value } satisfies DaemonMessage));
  }, SAMPLE_MS);
  setInterval(pruneSamples, 24 * 60 * 60_000);
  setInterval(
    () => void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`)),
    10_000,
  );
  setInterval(
    () => void sendServers().catch((error: unknown) => log(`server scan failed: ${String(error)}`)),
    SERVER_SCAN_MS,
  );
}

/** K-619: a scan every 30 seconds; every 10th scan checks each server again, else only new ones. */
const SERVER_SCAN_MS = 30_000;
const SERVER_RECHECK = 10;
/** The last report that this connection sent, or null after a new connection. */
let lastServers: Array<ServerReport> | null = null;
let serverScans = 0;

/** K-619: sends the listening ports of this machine when they change, so the site wizard can list them. */
async function sendServers() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const servers = await scanServers(platform, lastServers ?? [], serverScans++ % SERVER_RECHECK === 0);
  const text = JSON.stringify({ type: "servers", servers } satisfies DaemonMessage);
  if (lastServers !== null && JSON.stringify({ type: "servers", servers: lastServers }) === text) return;
  lastServers = servers;
  socket?.send(text);
}

/** `machine.json` as it is on disk now, or null when it cannot be read. */
function readMachineFile(): unknown {
  try {
    return JSON.parse(readFileSync(paths.config, "utf8"));
  } catch {
    return null;
  }
}

/** The requests to kitshn that wait for its `answer`, by request id: null, or why kitshn refused. */
const answerWaiters = new Map<string, (error: string | null) => void>();
/** K-704: where the daemon keeps the machine's name among its saved pushes. */
const MACHINE_NAME_KEY = "machine:name";

/** K-1609: the Unix socket of the link proxy, next to the private local socket. */
/**
 * K-1609: the link proxy, next to the private local socket. On Windows a named pipe has no private folder, so its name
 * ends in a part that is new at each start: no other account can take it first, and a provider learns it only from
 * the answer to `register` (K-621).
 */
const linkSocket =
  platform === "win32"
    ? `${paths.socket}-link-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
    : join(dirname(paths.socket), "link.sock");
/** False when the link proxy did not start; the answer to `register` then names no socket. */
let linkServed = false;

/** K-704: the providers of this machine, saved in `providers.json`. */
const providersFile = () => join(paths.data, "providers.json");
let providerRegistry: Providers | null = null;
/** Read on first use, so only the daemon reads `providers.json`, not each command. */
const registry = (): Providers => (providerRegistry ??= loadProviders());
function loadProviders(): Providers {
  let value: unknown = null;
  try {
    value = existsSync(providersFile()) ? JSON.parse(readFileSync(providersFile(), "utf8")) : null;
  } catch (error) {
    value = { broken: String(error) };
  }
  const { saved, problem } = parseSaved(value);
  if (problem) log(`${providersFile()} is broken, so the daemon starts with no providers: ${problem}`);
  return new Providers(saved, (next) => {
    mkdirSync(paths.data, { recursive: true });
    const temporary = `${providersFile()}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(temporary, providersFile());
  });
}
/** K-703: the event channel of each local connection that registered a provider. */
const providerEmitters = new Map<number, (event: Answer) => void>();
/** K-707: the provider commands that wait for their `command-result`, by job id. */
const commandWaiters = new Map<
  number,
  { readonly provider: string; readonly settle: (outcome: JobOutcome) => void }
>();
const COMMAND_TIMEOUT_MS = 5 * 60_000;

let providersTimer: ReturnType<typeof setTimeout> | null = null;
/** K-704: the whole list goes to kitshn on connect and after a change, at most once a second. */
function sendProviders() {
  if (providersTimer) return;
  providersTimer = setTimeout(() => {
    providersTimer = null;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({ type: "providers", providers: registry().reports() } satisfies DaemonMessage),
      );
  }, 1000);
}

function providerClosed(connection: number) {
  providerEmitters.delete(connection);
  const names = registry()
    .reports()
    .filter((report) => registry().connectionOf(report.name) === connection);
  if (!registry().disconnect(connection)) return;
  for (const [commandId, waiter] of commandWaiters)
    if (names.some((report) => report.name === waiter.provider)) {
      commandWaiters.delete(commandId);
      waiter.settle({
        ok: false,
        exitCode: null,
        output: `The provider ${waiter.provider} closed its connection.`,
      });
    }
  sendProviders();
}

/** K-707: who waits for a provider to register; a queued job reaches a restarted daemon before its provider does. */
const registerWaiters = new Map<string, Array<() => void>>();
const PROVIDER_WAIT_MS = 60_000;

function registered(provider: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, PROVIDER_WAIT_MS);
    const waiters = registerWaiters.get(provider) ?? [];
    waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    registerWaiters.set(provider, waiters);
  });
}

/** K-707: passes a provider command to the provider's connection, and waits for its result. */
async function runProviderCommand(
  command: Extract<Command, { kind: "provider" }>,
  jobId: number,
): Promise<JobOutcome> {
  if (registry().connectionOf(command.provider) === null) await registered(command.provider);
  const connection = registry().connectionOf(command.provider);
  const emit = connection === null ? undefined : providerEmitters.get(connection);
  if (!emit)
    return Promise.resolve({
      ok: false,
      exitCode: null,
      output: `The provider ${command.provider} did not connect within 60 seconds.`,
    });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(jobId);
      resolve({
        ok: false,
        exitCode: null,
        output: `The provider ${command.provider} gave no result in 5 minutes.`,
      });
    }, COMMAND_TIMEOUT_MS);
    commandWaiters.set(jobId, {
      provider: command.provider,
      settle: (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
    });
    emit({
      type: "command",
      provider: command.provider,
      commandId: jobId,
      command: command.command,
      resource: command.resource,
      ...(command.row === undefined ? {} : { row: command.row }),
    });
  });
}

/** K-701, K-702: the requests of the local socket. */
async function answerLocal(request: Request, caller: Caller, emit: (event: Answer) => void): Promise<Answer> {
  const { id } = request;
  if (request.type === "ask") return askKitshn(request, emit);
  if (request.type === "status") {
    if (!joined) throw new Error("the daemon has not read machine.json yet.");
    const key = readKey(keyFile);
    return {
      id,
      type: "status",
      status: {
        version: VERSION,
        machineId: joined.machineId,
        fingerprint: key ? await fingerprintOf(key.x) : null,
        connection: socket === null ? "disconnected" : challenge === null ? "token-only" : "connected",
        tunnel: tunnelState,
        attesterEnv: attestersOf(readMachineFile()).attesters.map((attester) => attester.tokenEnv),
        server: joined.server,
      },
    };
  }
  if (request.type === "forward") return forwardCall(request);
  if (request.type === "command-result") {
    const waiter = commandWaiters.get(request.commandId);
    if (
      !waiter ||
      waiter.provider !== request.provider ||
      registry().connectionOf(request.provider) !== caller.connection
    )
      throw new Error(`no command ${request.commandId} of ${request.provider} waits for a result (K-707).`);
    commandWaiters.delete(request.commandId);
    waiter.settle({ ok: request.ok, exitCode: request.ok ? 0 : 1, output: request.output });
    return { id, type: "command-result" };
  }
  if (request.type === "samples") {
    return { id, type: "samples", newest: sample(), history: lastHour(recentSamples, Date.now()) };
  }
  if (request.type === "job-cancel") {
    const ws = socket;
    if (ws === null || challenge === null)
      throw new Error("the daemon has no signed connection to kitshn, so it cannot cancel a job now.");
    const requestId = crypto.randomUUID();
    const error = await new Promise<string | null>((resolve) => {
      answerWaiters.set(requestId, resolve);
      sendOn(ws, { type: "cancelJob", requestId, jobId: request.jobId });
    });
    if (error !== null) throw new Error(error);
    return { id, type: "job-cancel" };
  }
  if (request.type === "audit") {
    // K-1610: only the provider's own connection, and only over a signed connection; kitshn names the source.
    if (registry().connectionOf(request.provider) !== caller.connection)
      throw new Error(`register ${request.provider} on this connection first (K-704).`);
    const ws = socket;
    if (ws === null || challenge === null)
      throw new Error("the daemon has no signed connection to kitshn, so kitshn cannot record the call now.");
    sendOn(ws, { type: "audit", audit: request.audit });
    return { id, type: "audit" };
  }
  if (request.type === "desired-set") {
    // K-709: only the connection that registered the provider, and only over a signed connection to kitshn.
    if (registry().connectionOf(request.provider) !== caller.connection)
      throw new Error(`register ${request.provider} on this connection first (K-704).`);
    const ws = socket;
    if (ws === null || challenge === null)
      throw new Error("the daemon has no signed connection to kitshn, so kitshn cannot store the state now.");
    const kinds =
      registry()
        .reports()
        .find((report) => report.name === request.provider)?.kinds ?? [];
    const problem = desiredProblem(kinds, request.kind, request.value);
    if (problem) throw new Error(problem);
    // kitshn checks again when it writes; the provider gets that answer, not only the daemon's.
    const { id: _id, type: _type, ...change } = request;
    const requestId = crypto.randomUUID();
    const error = await new Promise<string | null>((resolve) => {
      // Like an ask, a request waits at most 60 seconds for kitshn.
      const timer = setTimeout(() => {
        answerWaiters.delete(requestId);
        resolve("kitshn did not answer within 60 seconds; the state may or may not be stored.");
      }, 60_000);
      answerWaiters.set(requestId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      sendOn(ws, { type: "desiredSet", requestId, ...change });
    });
    if (error !== null) throw new Error(error);
    return { id, type: "desired-set" };
  }
  if (request.type === "provider-forget") {
    const problem = registry().forget(request.provider);
    if (problem) throw new Error(problem);
    sendProviders();
    return { id, type: "provider-forget" };
  }
  if (request.type === "register" || request.type === "upsert" || request.type === "remove") {
    if (!joined) throw new Error("the daemon has not read machine.json yet.");
    const handMade = readSites() ?? [];
    const outcome = registry().apply(request, caller.connection, new Set(handMade.map((site) => site.name)));
    if (!outcome.ok) throw new Error(outcome.error);
    if (outcome.changed) {
      sendProviders();
      void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`));
    }
    if (request.type !== "register") return { id, type: request.type };
    providerEmitters.set(caller.connection, emit);
    for (const wake of registerWaiters.get(request.provider) ?? []) wake();
    registerWaiters.delete(request.provider);
    log(`provider ${request.provider} registered with ${request.resources.length} resources`);
    return {
      id,
      type: "register",
      machineId: joined.machineId,
      ...registry().savedFor(request.provider),
      linkSocket: linkServed ? linkSocket : null,
      machineName: registry().pushedValue(MACHINE_NAME_KEY) as string | null,
    };
  }
  if (request.type === "attester-set") return setAttester(request, caller);
  if (request.type === "forget-token") {
    keptTokens.drop(request.repo);
    return { id, type: "forget-token" };
  }
  if (request.type === "reconnect") {
    log("kitshn rekey saved a new key; connecting again");
    reconnectNow();
    return { id, type: "reconnect" };
  }
  const ws = socket;
  if (ws === null || challenge === null)
    throw new Error(
      "the daemon has no signed connection to kitshn, and a rotation needs one (K-1705). See kitshn status.",
    );
  const outcome = await new Promise<RotationOutcome>((resolve) => {
    rotationWaiters.push(resolve);
    void rotateKey(ws);
  });
  if ("error" in outcome) throw new Error(outcome.error);
  return { id, type: "rotate-key", fingerprint: outcome.fingerprint };
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

switch (command) {
  case "join":
    await joinCommand(args[0], flag("--server"));
    break;
  case "run":
    await runCommand();
    break;
  case "service":
    await serviceCommand(args[0]);
    break;
  case "rotate-key":
    await rotateKeyCommand();
    break;
  case "rekey":
    await rekeyCommand(args[0]);
    break;
  case "status":
    await statusCommand();
    break;
  case "git-credential":
    await gitCredentialCommand(args[0]);
    break;
  case "setup-git":
    setupGitCommand();
    break;
  case "gh":
    await ghCommand(args);
    break;
  case "agent":
    await agentCommand(args);
    break;
  case "attester":
    await attesterCommand(args);
    break;
  case "provider":
    await providerCommand(args);
    break;
  case "link-check":
    linkCheckCommand(args[0]);
    break;
  case "publish":
  case "address":
  case "logs":
  case "repo":
  case "redirect":
  case "time":
  case "game":
    await runAgentCommand(command, args, daemonTransport);
    break;
  case "local-users":
    localUsersCommand(args[0], args[1]);
    break;
  case "version":
    console.log(args.includes("--json") ? versionJson(VERSION) : VERSION);
    break;
  case "doors":
    if (platform === "win32") windowsDoorsCommand(args[0], ownSid());
    else doorsCommand(args[0], flag("--user"));
    break;
  case "doors-helper":
    // K-2009: only the SYSTEM task runs this, from its own copy of kitshn.
    if (platform !== "win32") fail("doors-helper runs only on Windows, as SYSTEM");
    runWindowsHelper(log);
    break;
  case "skill":
    skillCommand(args[0], args.includes("--repo"));
    break;
  case "expose":
    exposeCommand(
      args[0],
      flag("--name"),
      args.includes("--dev"),
      flag("--time") ?? flag("--ends-at"),
      args.includes("--new"),
    );
    break;
  case "servers":
    await serversCommand(args.includes("--json"));
    break;
  case "unexpose":
    unexposeCommand(args[0]);
    break;
  case "kitshn1-takeover":
    await kitshn1TakeoverCommand(args[0], args[1], flag("--project"), flag("--user"));
    break;
  default:
    console.log(`kitshn ${VERSION}

kitshn join <code> --server <address>   join this machine to kitshn (K-602)
kitshn service install                  run the daemon as a user service (K-601)
kitshn service uninstall                stop and remove the user service
kitshn run                              run the daemon in the foreground
kitshn rotate-key                       replace the machine key over the live connection (K-1705)
kitshn rekey <code>                     make a new machine key with the key code of its panel (K-1706, K-1708)
kitshn status                           the machine, its key, its connection to kitshn and its tunnel
kitshn local-users list|add|remove <u>  who else may use the local socket, as the daemon user (K-701)
kitshn attester set --prefix <p.> --url <loopback url> --token-env <NAME>
                                        register an attester of thread labels, as the daemon user or root (K-1751)
kitshn provider                         join stdin and stdout to the local socket, for a provider (K-704)
kitshn provider forget <name>           drop a provider that does not run, as the daemon user or root (K-704)
kitshn link-check <socket or pipe>      exit 0 when this account's daemon serves that link proxy (K-1609)
kitshn agent <action> [target]          ask kitshn as this machine (K-1710): --reason, --label k=v, --body json
${AGENT_USAGE}
kitshn setup-git                        git asks kitshn first for github.com tokens (K-1763)
kitshn gh <args>                        gh with a kitshn token for this repo (K-1764)
kitshn expose <port|socket> --name <n>  share a local server at <n>.<zone> (K-1104); --dev sets Host localhost;
                                        also localhost:5173 or http://127.0.0.1:5173/ (K-1131); --time 1h ends it (K-212)
kitshn doors install --user <u>         as root: the helper that gates game ports, for the daemon user (K-2005)
                                        on Windows: kitshn doors install, in an administrator PowerShell (K-2009)
kitshn doors uninstall                  as root: remove it and its firewall table
kitshn unexpose <name>                  stop sharing it
kitshn servers [--json]                 the servers that listen on this machine, with their page title (K-619)
kitshn kitshn1-takeover <owner/repo> <environment> --project <card> --user <daemon user>
                                        as root: move KitSHn 1 data into rootless Docker (K-1404)
kitshn skill install [--repo]            the skill for coding agents, global or in this repo (K-618)
kitshn skill check                      exit 1 when a copy of the skill is from another release
kitshn version [--json]                 the version; --json: {"product":"kitshn","generation":2,"version"}`);
}
