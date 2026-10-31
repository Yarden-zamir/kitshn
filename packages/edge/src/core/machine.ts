import type { LogAnswer, LogLine, LogSearch } from "./logs.ts";
import type { BackupReport } from "./backups.ts";
import type { MachineRight } from "./model.ts";
import type {
  CardSettingValues,
  DesiredParts,
  ExecFrame,
  ExecRun,
  GrantTables,
  HealthReport,
  ProviderReport,
  ProviderAccess,
  ProviderRefusal,
  ReachedCard,
} from "@kitshn/local";
import type { ServerReport } from "./sites.ts";
import type { DoorPlan } from "./game.ts";
/** K-1609: daemon-only live-site reach, never sent to a provider. */
export interface ReachedSite {
  readonly id: string;
  readonly address: string;
}

/** A destination guard enforces each caller's last possible expiry locally, even between pushes. */
export interface SiteGuardClient {
  readonly clientId: string;
  /** Milliseconds since epoch; null means that no matching share has an expiry. */
  readonly until: number | null;
}

/** A card's link-path audience and current machine grants, pushed only to its destination daemon. */
export interface SiteGuardGrant {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly audience: string;
  readonly clients: ReadonlyArray<SiteGuardClient>;
}

/** K-1609: the push and capability for the daemon's live-site link route. */
export const SITE_REACH_KEY = "site:reach";
export const SITE_LINKS_CAPABILITY = "site-links";
export const SITE_GUARD_KEY = "site:guard";
export const SITE_GUARD_CAPABILITY = "site-link-guard";

/** A joined machine (K-602). Its resource card has the same id and the kind `machine`. */
export interface Machine {
  readonly id: string;
  readonly name: string;
  /** K-609 */
  readonly labels: ReadonlyArray<string>;
  /** K-609: one order of all machines; lower runs jobs first. */
  readonly order: number;
  /** The Access service token of the machine (K-107). */
  readonly serviceTokenId: string;
  readonly clientId: string;
  /** The remotely managed tunnel of the machine (K-603). */
  readonly tunnelId: string;
  /** K-818: risky Compose settings that the owner allows for one repo on this machine. */
  readonly allow?: ReadonlyArray<ComposeAllowance>;
  /**
   * K-1702. Absent on a machine that joined before machine keys: it reports status only and gets no job until
   * `kitshn rekey` gives it its first key (K-1708).
   */
  readonly key?: MachineKey;
  /** K-626: "Update daemon automatically" is on unless this is false. */
  readonly autoUpdate?: false;
  /** K-633: when it joined. Absent on a machine from before this field. */
  readonly joinedAt?: number;
}

export type MachineKey =
  /** K-1702: the public half of the machine key pair, and when it became valid. */
  | {
      readonly kind: "public";
      readonly publicKey: string;
      readonly fingerprint: string;
      readonly since: number;
    }
  /** K-1703, K-1706: the machine waits for its key from a join code or a rekey code, and cannot connect. */
  | { readonly kind: "waiting"; readonly since: number };

/** K-818: one allow list entry: a repo (`owner/name`) and one setting name of the daemon's check. */
export interface ComposeAllowance {
  readonly repo: string;
  readonly setting: string;
}

/** K-818: the settings that a machine allows for one repo. */
export const allowedFor = (machine: Machine, repo: string): Array<string> =>
  (machine.allow ?? [])
    .filter((entry) => entry.repo.toLowerCase() === repo.toLowerCase())
    .map((entry) => entry.setting);

/** K-605: what a daemon reports about itself. */
export interface MachineStatus {
  readonly version: string;
  readonly os: string;
  readonly arch: string;
  readonly hostname: string;
  readonly tunnel: "starting" | "running" | "stopped";
  /** Job kinds that this daemon knows beyond shell, diagnostics and restart. Old daemons send none. */
  readonly capabilities?: ReadonlyArray<string>;
  /** Private Unix socket on which this daemon guards the reserved link host, when it is serving one. */
  readonly siteGuardSocket?: string;
  /** K-821: the bytes of the images that the daemon keeps for rollbacks, at most; shared layers count once per image. */
  readonly keptBytes?: number;
  /** K-2002: the public addresses on the machine's interfaces, for the records of its game cards. */
  readonly publicAddresses?: { readonly v4: string | null; readonly v6: string | null };
  /** K-2002: why the machine cannot gate game ports; absent when it reports the capability `doors`. */
  readonly doorsProblem?: string;
  /** K-2006: the game ports (`25565/tcp`) of the last door plan that something listens on. */
  readonly listening?: ReadonlyArray<string>;
  /** K-704: the providers whose last registration the daemon refused; only from a signed connection. */
  readonly refusedProviders?: ReadonlyArray<ProviderRefusal>;
  /** K-704, K-515: the registered providers without a connection, since `at` and why; only from a signed connection. */
  readonly offlineProviders?: ReadonlyArray<ProviderRefusal>;
  /**
   * K-722: how exec of other machines becomes each provider's exec user: through the sudo rule of `kitshn exec
   * install`, or through the provider's bridge when the rule is missing, so a broken provider blocks exec.
   */
  readonly execPaths?: ReadonlyArray<{
    readonly provider: string;
    readonly user: string;
    readonly via: "sudo" | "bridge";
  }>;
  /** K-704: the items that the last register or upsert of a provider dropped (`path: reason`); signed only. */
  readonly providerProblems?: ReadonlyArray<ProviderRefusal>;
}

/** K-605, K-606: the latest resource sample. The Durable Object keeps it in memory only. */
export interface Sample {
  readonly at: number;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
}

/** K-612 built-in commands. */
export type Command =
  | { readonly kind: "shell"; readonly script: string }
  | { readonly kind: "diagnostics" }
  | { readonly kind: "restart" }
  /** K-612, K-617: replace the daemon with the release that the Worker names, then restart. */
  | { readonly kind: "update"; readonly version: string }
  /**
   * K-812: build and start a Compose app from the source of a deploy, then expose its socket as `name`
   * (K-607). Only kitshn makes this job, never the jobs API.
   */
  | {
      readonly kind: "compose";
      readonly deployId: string;
      /** K-818: the risky Compose settings that the owner allows for this repo on this machine. */
      readonly allowed: ReadonlyArray<string>;
      readonly project: string;
      readonly name: string;
      readonly environment: string;
      readonly repo: string;
      /** The Compose file of the recipe; with null, the daemon takes the files that Compose finds on its own. */
      readonly file: string | null;
    }
  /**
   * K-718: start the last build of a Compose app that came up, from the copy on the machine. It never takes
   * new code. Only kitshn makes this job, never the jobs API.
   */
  | {
      readonly kind: "compose-redeploy";
      readonly allowed: ReadonlyArray<string>;
      readonly project: string;
      readonly name: string;
      readonly environment: string;
      readonly repo: string;
      readonly file: string | null;
    }
  /** K-904, K-909: stop a Compose app and stop exposing it; a closed preview also loses its data. */
  | {
      readonly kind: "compose-down";
      readonly project: string;
      readonly name: string;
      readonly removeData: boolean;
    }
  /**
   * K-909: delete one orphaned volume. kitshn fills in the project from the daemon's report; the daemon
   * deletes only a volume that it still reports as idle.
   */
  | { readonly kind: "compose-volume-remove"; readonly project: string; readonly volume: string }
  /**
   * K-821: start the build before the last one of a Compose app again, from its kept source, params and image tags,
   * without a build. The daemon checks that its kept build is the deploy `deployId`. Only kitshn makes this job.
   */
  | {
      readonly kind: "compose-rollback";
      readonly deployId: string;
      readonly allowed: ReadonlyArray<string>;
      readonly project: string;
      readonly name: string;
      readonly environment: string;
      readonly repo: string;
      readonly file: string | null;
      /** K-821: the run rollback that this job is one step of, if any. */
      readonly group: string | null;
    }
  /**
   * K-1816, K-1817: back up the volumes and the data folder of the Compose app `card` as the run `run`, then
   * forget old runs, and prune when `prune` is true. Only kitshn makes this job.
   */
  | {
      readonly kind: "backup";
      readonly card: string;
      readonly run: string;
      readonly prune: boolean;
      /** K-1816: the hard limit of the paused pass, from the pause of the last run. */
      readonly pauseLimitMs: number;
    }
  /**
   * K-707: a command of a provider on this machine. `resource` is the provider's id of the card, null for a command
   * of the machine card. The daemon passes it to the provider and waits for its result.
   */
  | {
      readonly kind: "provider";
      readonly provider: string;
      readonly command: string;
      readonly resource: string | null;
      /** K-1625: the row of a list that the command is for. */
      readonly row?: string;
    }
  /** K-1820: back up as the run `before` first, then write the run `run` back. Only kitshn makes this job. */
  /** K-2005: the game ports of this machine and their open doors; the whole list each time. Only kitshn makes it. */
  | { readonly kind: "doors"; readonly plan: DoorPlan }
  | {
      readonly kind: "backup-restore";
      readonly card: string;
      readonly run: string;
      readonly before: string;
      /** The sources of the run; the daemon checks that each exists before the app stops. */
      readonly sources: ReadonlyArray<string>;
      readonly pauseLimitMs: number;
    };

/** K-909: a Docker volume with the Compose project label of a kitshn app that runs no container. */
export interface ProjectVolume {
  readonly name: string;
  readonly project: string;
}

export interface JobResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  /** K-821: after a Compose build came up, the image id of each service, which the daemon tagged to keep. */
  readonly images?: Readonly<Record<string, string>>;
  /** K-1817: what a backup job, or the first step of a restore, wrote. */
  readonly backup?: BackupReport;
}

/** K-1104, K-1107: a live site that a machine exposes, and whether its local server answers. */
export interface LiveSiteReport {
  readonly name: string;
  readonly target: string;
  readonly dev: boolean;
  readonly up: boolean;
  /** K-212: `kitshn expose --time`: the end time that the new card gets. */
  readonly endsAt?: number;
  /** K-1104: `kitshn expose --circle`: the circle, by id or name, of the new card. */
  readonly circle?: string;
}

/** Messages from a daemon to kitshn over `/connect`. The text "ping" is answered by the auto response. */
/** K-1710: one ask of an agent, as the daemon sends it over its signed connection. */
export interface AskWire {
  readonly action: string;
  readonly target: string;
  readonly body?: unknown;
  readonly reason?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** K-1752: the labels that a provider of the machine vouched for; only these count for rights (K-1754). */
  readonly attested?: Readonly<Record<string, string>>;
}

/** K-1710, K-1722: kitshn's answer to one ask. */
export type AskOutcome =
  | { readonly outcome: "done"; readonly result: unknown }
  | { readonly outcome: "waiting"; readonly proposalId: string }
  /** K-1776: `need` names the right that refused the call. */
  | { readonly outcome: "refused"; readonly reason: string; readonly need?: MachineRight }
  /** K-1760: the owner of the repo is "not kitshn"; the machine uses its own login. */
  | { readonly outcome: "not-kitshn"; readonly reason: string };

/** K-1722 to K-1724: the answer to a proposal, sent to the machine that asked. */
export interface AskResult {
  readonly proposalId: string;
  readonly outcome: "approved" | "denied" | "expired";
  readonly result?: unknown;
  readonly reason?: string;
}

export type DaemonMessage =
  /** K-1704: the signature of `connectText` with the key that the challenge names. */
  | { readonly type: "answer"; readonly signature: string }
  /** K-1705: a new public half, with the signature of `rotateText` by the old private half. */
  | { readonly type: "rotate"; readonly publicKey: string; readonly signature: string }
  | { readonly type: "status"; readonly status: MachineStatus }
  | { readonly type: "sample"; readonly sample: Sample }
  | { readonly type: "jobResult"; readonly id: number; readonly result: JobResult }
  /** The whole list of live sites, sent on connect and on each change (K-1107). */
  | { readonly type: "sites"; readonly sites: ReadonlyArray<LiveSiteReport> }
  /** K-619: the listening ports of the machine, sent on connect and on each change. */
  | { readonly type: "servers"; readonly servers: ReadonlyArray<ServerReport> }
  /** K-1114: the icon of one site of this machine, base64, read from the app; null when it has none. */
  | { readonly type: "icon"; readonly site: string; readonly icon: string | null }
  /** K-909: the idle volumes of kitshn apps, sent on connect and after each Compose job. */
  | { readonly type: "volumes"; readonly volumes: ReadonlyArray<ProjectVolume> }
  /** K-1804: the answer to a `logs` request. */
  | { readonly type: "logs"; readonly id: string; readonly answer: LogAnswer }
  /** K-1805: new lines of a tail, and the count of lines that did not fit in this batch. */
  | {
      readonly type: "tailLines";
      readonly id: string;
      readonly lines: ReadonlyArray<LogLine>;
      readonly skipped: number;
    }
  /** K-1805: a tail stopped on the daemon, with why. */
  | { readonly type: "tailEnd"; readonly id: string; readonly reason: string }
  /** K-1710: an ask of a local agent; kitshn answers with `askAnswer` and the same `requestId`. */
  | { readonly type: "ask"; readonly requestId: string; readonly ask: AskWire }
  /** K-704: every provider of the machine with its kinds, commands and resources, on connect and on each change. */
  | { readonly type: "providers"; readonly providers: ReadonlyArray<ProviderReport> }
  /** K-709: a provider set a part of a desired state; kitshn stores it and pushes it to every machine. */
  | {
      readonly type: "desiredSet";
      /** kitshn answers with `requestAnswer` and this id. */
      readonly requestId: string;
      readonly provider: string;
      readonly kind: string;
      readonly part: "shared" | "machine";
      readonly value: unknown;
      /** K-709: the provider's mark of this set; the next `desired` push of the kind carries it. */
      readonly rev?: string;
    }
  /** K-1612: a local user cancels a queued job of this machine; kitshn answers with `requestAnswer`. */
  | { readonly type: "cancelJob"; readonly requestId: string; readonly jobId: number }
  /**
   * K-722: A starts a run on the machine `target`. `provider` is the provider of the connection that asks, whose
   * exec user runs it on B; `attested` holds the labels that its provider vouched for (K-1752). kitshn answers with
   * `execState`, or ends the run at once with an `exit` frame.
   */
  | {
      readonly type: "execStart";
      readonly execId: string;
      readonly target: string;
      readonly provider: string | null;
      /** K-722: the provider on the target that A names, when A controls cards of several there. */
      readonly targetProvider?: string;
      readonly run: ExecRun;
      readonly attested: Readonly<Record<string, string>>;
    }
  /**
   * K-1610: one call that the link proxy of this machine forwarded with a tool name (MM-1922), and the status of its
   * answer, 0 when the link failed. Never its arguments or its answer.
   */
  | { readonly type: "linkCall"; readonly target: string; readonly name: string; readonly status: number }
  /** K-722: one frame of a run: from B its output, stdin credit and exit; from A its credit, stdin and close. */
  | { readonly type: "execFrame"; readonly execId: string; readonly frame: ExecFrame }
  /** K-1608: the daemon saved the push with this key and hash and gave it to its provider. */
  | { readonly type: "applied"; readonly key: string; readonly hash: string }
  /** K-630: the check of its providers and links, every 10 minutes and after `checkHealth`. */
  | { readonly type: "health"; readonly report: HealthReport };

/** Messages from kitshn to a daemon. */
export type ServerToDaemon =
  /**
   * K-1704: the first message of each connection. `fingerprint` names the key that kitshn expects, so a daemon
   * in the middle of a rotation signs with the right file. Null when the machine has no key yet: the daemon
   * then does not answer, and the connection reports status only (K-1708).
   */
  | { readonly type: "challenge"; readonly challenge: string; readonly fingerprint: string | null }
  /** K-1704: the answer passed; from now on kitshn reads the messages of this connection. */
  | { readonly type: "accepted"; readonly fingerprint: string }
  /** K-1705: "Rotate key" in the machine panel. */
  | { readonly type: "rotateKey" }
  /** K-631: "Check now" in the Machines view; the daemon checks at once and sends `health`. */
  | { readonly type: "checkHealth" }
  /** K-704: the name of the machine on the map, on each signed connection and after a rename. */
  | { readonly type: "name"; readonly name: string }
  /** K-704: the owner forgot this provider on the map; the daemon drops it unless a connection holds it. */
  | { readonly type: "forgetProvider"; readonly provider: string }
  /** K-706: the grant table of each resource of one provider, on connect and on each change. */
  | {
      readonly type: "grants";
      readonly provider: string;
      readonly tables: GrantTables;
      readonly hash: string;
    }
  /** The answer to a request of the daemon that names a `requestId`: null, or why kitshn refused. */
  | { readonly type: "requestAnswer"; readonly requestId: string; readonly error: string | null }
  /** K-709: the shared part and this machine's part of one desired state, with the `rev` of its last set. */
  | {
      readonly type: "desired";
      readonly provider: string;
      readonly kind: string;
      readonly state: DesiredParts;
      readonly rev: string | null;
      readonly hash: string;
    }
  /** K-721: whether kitshn is paused (K-1504), on each signed connection and on each change. */
  | { readonly type: "paused"; readonly paused: boolean; readonly hash: string }
  /** K-722: the machines whose "runs commands" covers this machine at automatic, on connect and on each change. */
  | { readonly type: "execRights"; readonly machines: ReadonlyArray<string>; readonly hash: string }
  /** K-722, A: how a run that this machine started stands. */
  | {
      readonly type: "execState";
      readonly execId: string;
      readonly state: "running" | "waiting";
      readonly proposalId?: string;
    }
  /** K-722, B: run this for another machine, as the exec user of `provider`. */
  | { readonly type: "execRun"; readonly provider: string | null; readonly run: ExecRun }
  /** K-722: a frame of a run, from the other machine. */
  | { readonly type: "execFrame"; readonly execId: string; readonly frame: ExecFrame }
  /** K-1612: a job that this machine queued with an ask ended. */
  | {
      readonly type: "jobEnded";
      readonly jobId: number;
      readonly state: "done" | "failed" | "expired";
      readonly exitCode: number | null;
      readonly output: string;
    }
  /** K-1609: the cards of one provider on other machines that this machine reaches. */
  | {
      readonly type: "reach";
      readonly provider: string;
      readonly cards: ReadonlyArray<ReachedCard>;
      readonly hash: string;
    }
  /** K-1609: the live-site cards on other machines that this machine's token opens. */
  | { readonly type: "siteReach"; readonly cards: ReadonlyArray<ReachedSite>; readonly hash: string }
  /** The destination's current path audiences and machine grants, on its signed connection only. */
  | {
      readonly type: "siteGuard";
      readonly teamDomain: string;
      readonly grants: ReadonlyArray<SiteGuardGrant>;
      readonly hash: string;
    }
  /** K-1623: the Access audiences of one provider's site hosts on this machine. */
  | {
      readonly type: "access";
      readonly provider: string;
      readonly access: ProviderAccess;
      readonly hash: string;
    }
  /** K-717: the card settings of one provider's cards on this machine. */
  | {
      readonly type: "settings";
      readonly provider: string;
      readonly values: CardSettingValues;
      readonly hash: string;
    }
  /** K-1762: the daemon drops its kept GitHub tokens of one repo, or all with null, because kitshn revoked them. */
  | { readonly type: "dropTokens"; readonly repo: string | null }
  | {
      readonly type: "job";
      readonly id: number;
      readonly command: Command;
      /** K-1908: the notify address and a new token for a Compose app; the daemon passes both to `docker compose`. */
      readonly notify?: { readonly url: string; readonly token: string };
      /** K-822: the Access values of a Compose app, read when the job goes out. */
      readonly access?: AppAccess;
    }
  /** K-1804: search the logs of the Compose app `project`. */
  | { readonly type: "logs"; readonly id: string; readonly project: string; readonly search: LogSearch }
  /** K-1805: follow the logs of the Compose app `project` until `tailStop`. */
  | { readonly type: "tail"; readonly id: string; readonly project: string }
  | { readonly type: "tailStop"; readonly id: string }
  | ({ readonly type: "askAnswer"; readonly requestId: string } & AskOutcome)
  | ({ readonly type: "askResult" } & AskResult);

const ED25519 = { name: "Ed25519" } as const;

const base64url = (data: Uint8Array) =>
  base64(data).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unbase64url = (text: string) => unbase64(text.replaceAll("-", "+").replaceAll("_", "/"));

/** K-822: what an app needs to check kitshn's Access logins itself. */
export interface AppAccess {
  readonly teamDomain: string;
  /** The AUD tags of kitshn's Access applications on the addresses of the card. */
  readonly audiences: ReadonlyArray<string>;
}

/** K-1702: the private half of a machine key, as the daemon keeps it in `machine.key`. */
export interface MachinePrivateKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  /** The public half, base64url of the 32 raw bytes; this is the public key on the wire. */
  readonly x: string;
  readonly d: string;
}

/** K-1701: a new Ed25519 key pair. */
export async function newMachineKey(): Promise<MachinePrivateKey> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const { x, d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as { x?: string; d?: string };
  if (!x || !d) throw new Error("Web Crypto exported an Ed25519 key without its x or d.");
  return { kty: "OKP", crv: "Ed25519", x, d };
}

/** A machine key from `machine.key`, or null when the value is not one. */
export function parsePrivateKey(value: unknown): MachinePrivateKey | null {
  if (typeof value !== "object" || value === null) return null;
  const { kty, crv, x, d } = value as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || parsePublicKey(x) === null || typeof d !== "string") return null;
  return { kty, crv, x: x as string, d };
}

/** A public key from the wire: base64url of 32 bytes. Null for anything else. */
export function parsePublicKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 43) return null;
  try {
    return unbase64url(value).length === 32 ? value : null;
  } catch {
    return null;
  }
}

/** K-1702: the fingerprint of a public key: `SHA256:` and the base64url of the hash of its raw bytes. */
export const fingerprintOf = async (publicKey: string) =>
  `SHA256:${base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", unbase64url(publicKey))))}`;

/** K-1704: 32 random bytes for one connection. */
export const newChallenge = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * K-1704: the host that both sides sign: the hostname without a port, from kitshn's own `KITSHN_HOST` or the
 * daemon's configured server address, never from the challenge. So `localhost:8787` and `http://localhost:8787`
 * sign the same host.
 */
export const signedHost = (hostOrAddress: string) =>
  new URL(hostOrAddress.includes("://") ? hostOrAddress : `https://${hostOrAddress}`).hostname;

/** K-1704: what the daemon signs to answer the challenge of one connection to one kitshn host. */
export const connectText = (host: string, machineId: string, challenge: string) =>
  ["kitshn-connect-v1", signedHost(host), machineId, challenge].join("\n");

/** K-1705: what the old key signs to hand over to the new one, bound to the connection like `connectText`. */
export const rotateText = (host: string, machineId: string, challenge: string, publicKey: string) =>
  ["kitshn-rotate-v1", signedHost(host), machineId, challenge, publicKey].join("\n");

/**
 * K-1714: what the daemon signs for one call that it forwards to `/agent` over HTTP for a local agent: the method, the
 * path with its query, the time in ms, a random nonce and the SHA-256 hex of the attested labels as JSON.
 */
export const forwardText = (
  host: string,
  machineId: string,
  call: { method: string; path: string; at: number; nonce: string; labelsHash: string },
) =>
  [
    "kitshn-forward-v1",
    signedHost(host),
    machineId,
    call.method,
    call.path,
    String(call.at),
    call.nonce,
    call.labelsHash,
  ].join("\n");

/**
 * K-1714: why a forwarded path, after URL normalization, is not one that a daemon may send; null when it is. It must stay
 * below `/agent/` and hold no encoded slash, backslash, dot or percent, so no later decoding can climb out of it.
 */
export function forwardPathProblem(pathname: string): string | null {
  if (!pathname.startsWith("/agent/")) return `${pathname} is not below /agent/`;
  const lower = pathname.toLowerCase();
  for (const bad of ["%2f", "%5c", "%2e", "%25", "\\", "/./", "/../"])
    if (lower.includes(bad)) return `${pathname} holds ${bad}`;
  if (lower.endsWith("/.") || lower.endsWith("/..")) return `${pathname} ends in a dot segment`;
  return null;
}

/** K-1714: the URL of a forwarded call on `server`, or why the daemon refuses to send it. */
export function forwardUrl(server: string, path: string): URL | string {
  let url: URL;
  try {
    url = new URL(path, server);
  } catch {
    return `${path} is not a path.`;
  }
  if (url.origin !== new URL(server).origin) return `${path} leaves the kitshn server.`;
  const problem = forwardPathProblem(url.pathname);
  return problem === null ? url : `${problem}.`;
}

/** K-1714: the headers of a forwarded call. */
export const FORWARD_HEADERS = {
  signature: "x-kitshn-machine-signature",
  at: "x-kitshn-machine-at",
  nonce: "x-kitshn-machine-nonce",
  labels: "x-kitshn-attested",
} as const;

/** K-1714: a forwarded call is valid this long after the daemon signed it. */
export const FORWARD_WINDOW_MS = 60_000;

export async function signText(key: MachinePrivateKey, text: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey("jwk", key, ED25519, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign(ED25519, privateKey, bytes(text))));
}

/** K-1209: true when the signature fits the text of one of the hosts; during the host move, the daemon signs either. */
export async function verifyForHosts(
  publicKey: string,
  hosts: ReadonlyArray<string>,
  textFor: (host: string) => string,
  signature: unknown,
): Promise<boolean> {
  for (const host of hosts) if (await verifyText(publicKey, textFor(host), signature)) return true;
  return false;
}

/** False for a wrong signature and for a key or a signature that is not one. */
export async function verifyText(publicKey: string, text: string, signature: unknown): Promise<boolean> {
  if (parsePublicKey(publicKey) === null || typeof signature !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("raw", unbase64url(publicKey), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, unbase64url(signature), bytes(text));
  } catch {
    return false;
  }
}

/** What a join code unlocks (K-602). The Worker stores it only encrypted with a key from the code. */
export interface JoinSecrets {
  readonly server: string;
  readonly machineId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tunnelToken: string;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const unbase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The lookup id of a code. It reveals nothing about the key. */
export const joinLookup = async (code: string) =>
  hex(await crypto.subtle.digest("SHA-256", bytes(`lookup:${code}`)));

const joinKey = async (code: string) =>
  crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", bytes(`key:${code}`)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

export async function sealJoin(code: string, secrets: JoinSecrets): Promise<{ iv: string; sealed: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await joinKey(code),
    bytes(JSON.stringify(secrets)),
  );
  return { iv: base64(iv), sealed: base64(new Uint8Array(sealed)) };
}

export async function openJoin(code: string, box: { iv: string; sealed: string }): Promise<JoinSecrets> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64(box.iv) },
    await joinKey(code),
    unbase64(box.sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as JoinSecrets;
}

/** A join code: 20 random characters from an alphabet without look-alikes, about 99 bits. */
export function newJoinCode(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const random = crypto.getRandomValues(new Uint8Array(20));
  return [...random].map((value) => alphabet[value % alphabet.length]).join("");
}

/** K-1601: a device invite code: 16 random bytes in hex, 128 bits. */
export function newInviteCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** K-818: checks an allow list from the map: at most 50 entries of a repo `owner/name` and a setting name. */
export function parseAllowances(value: unknown): Array<ComposeAllowance> | string {
  if (!Array.isArray(value) || value.length > 50) return "The allow list is a list of at most 50 entries.";
  const entries: Array<ComposeAllowance> = [];
  for (const item of value) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const repo = typeof entry["repo"] === "string" ? entry["repo"].trim() : "";
    const setting = typeof entry["setting"] === "string" ? entry["setting"].trim() : "";
    const parts = repo.split("/");
    const blank = (text: string) => [...text].some((char) => char.trim() === "");
    if (
      parts.length !== 2 ||
      blank(repo) ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      return `"${repo}" is not a repo; write owner/name.`;
    if (!setting || setting.length > 200 || blank(setting))
      return `"${setting}" is not a setting name, for example bind:/var/run/docker.sock.`;
    entries.push({ repo, setting });
  }
  return entries;
}
