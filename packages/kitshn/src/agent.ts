// K-1116 to K-1128: the commands that agents use on kitshn: publish, address, logs, repo and redirect. One transport
// carries their calls to `/agent`: an agent key's service token, or the local daemon, which adds the machine identity
// (K-1714), so an agent on a joined machine needs no token.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { type AssetSession, uploadAssets } from "./assets.ts";
import { CliError, fail } from "./cli-error.ts";
import { type DeployRun, type LogAnswer, logArgs, logLineText, logRange, sinceMs } from "./logs.ts";
import { contentType } from "./media.ts";
import { cardOutput, errorOutput } from "./output.ts";
import { type HandoverAnswer, repoFiles } from "./repo-files.ts";
import { KITSHN_RELEASE, skillText, versionedSkill } from "./skill.ts";

/** One call to an `/agent` path of kitshn. */
export interface AgentTransport {
  /** The address of kitshn, for the files of a new repo (K-1127). */
  readonly server: () => Promise<string>;
  readonly call: (
    path: string,
    init: {
      readonly method: "GET" | "POST" | "DELETE";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string | Uint8Array;
    },
  ) => Promise<Response>;
  /** K-718, K-1711: the state of the agent; `all` adds the servers and the link events of a machine. */
  readonly state: (all?: boolean) => Promise<AgentState>;
}

export interface CircleRef {
  readonly id: string;
  readonly name: string;
}

export interface StateCard {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly addresses: ReadonlyArray<string>;
  readonly status: string;
  readonly endsAt: number | null;
  readonly circles: ReadonlyArray<CircleRef>;
}

export interface StateRight {
  readonly id: string;
  readonly name: string;
  readonly mode: "automatic" | "ask" | "off";
  /** The approver circle of an `ask` right. */
  readonly circle?: CircleRef;
}

/** The fields of `kitshn agent state` that the CLI reads (K-718); the answer has more. */
export interface AgentState {
  readonly rights: ReadonlyArray<StateRight>;
  readonly circles: ReadonlyArray<CircleRef & { readonly level: string }>;
  readonly cards: ReadonlyArray<StateCard>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const circleRef = (value: unknown): CircleRef | null =>
  isRecord(value) && typeof value["id"] === "string" && typeof value["name"] === "string"
    ? { id: value["id"], name: value["name"] }
    : null;

/** Reads the answer of `/agent/state`; an answer of another shape fails with the next step. */
export function parseState(value: unknown): AgentState {
  const outdated = (): never =>
    fail("kitshn sent a state that this CLI does not read. Update kitshn on this machine, then try again.");
  if (!isRecord(value)) return outdated();
  const list = (key: string) => {
    const items = value[key];
    return Array.isArray(items) ? items : outdated();
  };
  const rights = list("rights").map((item): StateRight => {
    const mode = isRecord(item) ? item["mode"] : undefined;
    if (!isRecord(item) || typeof item["id"] !== "string" || typeof item["name"] !== "string")
      return outdated();
    if (mode !== "automatic" && mode !== "ask" && mode !== "off") return outdated();
    const circle = circleRef(item["circle"]);
    return { id: item["id"], name: item["name"], mode, ...(circle ? { circle } : {}) };
  });
  const circles = list("circles").map((item) => {
    const ref = circleRef(item);
    return ref && isRecord(item) ? { ...ref, level: String(item["level"] ?? "") } : outdated();
  });
  const cards = list("cards").map((item): StateCard => {
    if (!isRecord(item) || typeof item["id"] !== "string" || !Array.isArray(item["circles"]))
      return outdated();
    return {
      id: item["id"],
      kind: String(item["kind"] ?? ""),
      name: String(item["name"] ?? ""),
      addresses: Array.isArray(item["addresses"]) ? item["addresses"].map(String) : [],
      status: String(item["status"] ?? ""),
      endsAt: typeof item["endsAt"] === "number" ? item["endsAt"] : null,
      circles: item["circles"].map((circle) => circleRef(circle) ?? outdated()),
    };
  });
  return { rights, circles, cards };
}

/**
 * C2 of the UX audit: who opens a card, by the circles that hold it: [] for a card in the tray, null when no circle
 * of the agent holds it.
 */
export function reachText(circles: ReadonlyArray<CircleRef> | null): string {
  if (circles === null) return "who opens it: no circle of yours holds it; the map shows where it is.";
  if (circles.length === 0)
    return "private: only you open it. Add --circle <circle> to a first publish, or move the card into a circle on the map.";
  if (circles.some((circle) => circle.id === EVERYONE)) return "public: anyone opens it.";
  return `who opens it: ${circles.map((circle) => circle.name).join(", ")}.`;
}

const EVERYONE = "everyone";

/** K-1714, K-1776: the 409 answer of a forwarded call that waits for an approval, or null for any other answer. */
export interface ForwardWait {
  readonly proposalId: string;
  readonly circle: string;
  readonly expiresAt: number | null;
}

export function forwardWaiting(status: number, text: string): ForwardWait | null {
  if (status !== 409) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data["outcome"] !== "waiting" || typeof data["proposalId"] !== "string") return null;
  return {
    proposalId: data["proposalId"],
    circle: typeof data["circle"] === "string" ? data["circle"] : "its approver circle",
    expiresAt: typeof data["expiresAt"] === "number" ? data["expiresAt"] : null,
  };
}

/**
 * C4 of the UX audit: the line while a call waits for an approval. `again`: after the approval the caller must send
 * the call once more (a forwarded call, K-1776, or a token, K-1723); else the approval runs it (K-1722).
 */
export function waitingLine(wait: ForwardWait, now: number, again: boolean): string {
  const hours = wait.expiresAt === null ? null : Math.max(1, Math.round((wait.expiresAt - now) / 3_600_000));
  return [
    `waiting: ${wait.circle} must approve proposal ${wait.proposalId}${hours === null ? "" : ` (expires in ${hours} h)`}.`,
    again
      ? "This command waits and then runs the call. If it ends first, run the same command again within 1 hour after the approval (K-1776)."
      : "This command waits for the answer. If it ends first, the approval still runs it; see kitshn agent history (K-1722).",
  ].join(" ");
}

/** A local time for people: the time today, else the date and the time. */
export function localTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date(now).toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** C6 of the UX audit: bad arguments exit 2, a refused step exits 1 (K-1809). */
export class UsageError extends CliError {}
const usageFail = (text: string): never => {
  throw new UsageError(text);
};

/** K-1116: an agent key: its service token from CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, on `server`. */
export function keyTransport(server: string): AgentTransport {
  if (!server)
    fail("name the kitshn server with --server or KITSHN_SERVER, for example https://kit.example.com.");
  const id = process.env["CF_ACCESS_CLIENT_ID"];
  const secret = process.env["CF_ACCESS_CLIENT_SECRET"];
  if (!id || !secret)
    fail(
      "on a joined machine, run kitshn of the machine; elsewhere set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to the service token of an agent key.",
    );
  const credentials = { "cf-access-client-id": id ?? "", "cf-access-client-secret": secret ?? "" };
  const call: AgentTransport["call"] = (path, init) =>
    fetch(new URL(path, server), { ...init, headers: { ...credentials, ...init.headers } });
  return {
    server: async () => server,
    call,
    state: async (all = false) => {
      const response = await call(all ? "/agent/state?all=1" : "/agent/state", { method: "GET" });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) fail(data?.error ?? answered(response.status, "/agent/state"));
      return parseState(data);
    },
  };
}

export const AGENT_COMMANDS = [
  "publish",
  "unpublish",
  "address",
  "logs",
  "repo",
  "redirect",
  "time",
  "port",
] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];
export const isAgentCommand = (value: unknown): value is AgentCommand =>
  typeof value === "string" && (AGENT_COMMANDS as ReadonlyArray<string>).includes(value);

/** C5 of the UX audit: the help of each agent command, for `kitshn <command> --help` and `kitshn --help`. */
export const AGENT_HELP: Record<AgentCommand, string> = {
  publish: `kitshn publish <file|folder> [--name <name>] [--address <name>] [--zone <zone>] [--circle <circle>] [--public] [--json]
                                             publish a page, a file (K-1116) or a folder site (K-1123); the line
                                             ends with who opens it. The same name again updates the card (K-1117)
kitshn publish --previous <card> [--json]    go back to the previous version of a card that you published (K-1117)`,
  unpublish: `kitshn unpublish <card> [--json]             remove a page, a file or a folder site that you published (K-1117)`,
  address: `kitshn address <card> <name> [--json]        give a page, a file (K-1120) or a folder site (K-1124) a new address name
                                             --json prints one JSON object on stdout: the card, or {"error"}`,
  logs: `kitshn logs <card> [text] [--since 1h | --from <time> [--to <time>]] [--deploys] [--json] [-- <text>]
                                             search the logs of a card that you manage (K-1809)`,
  repo: `kitshn repo <card> [<folder|file>] --repo <owner/name>
                                             make a new repo of a page or a folder site with gh (K-1127)`,
  redirect: `kitshn redirect <card> <address> [--remove] [--json]
                                             a hostname that only sends visitors on to a site card (K-1128)`,
  time: `kitshn time <card> <30m|1h|4h|1d|stop|now> [--json]
                                             a card leaves every circle for the tray after this time (K-212);
                                             stop keeps it until someone moves it, now ends it at once`,
  port: `kitshn port add --machine <machine> --name <name> --port 25565/tcp [--port <port/proto>] [--door 12h] [--srv minecraft] [--relay <machine>] [--json]
                                             a port card: its ports open per person from its connect page (K-2001)
kitshn port doors <card> [--json]            the open doors, records and listening ports of a port card (K-2007)
kitshn port close <card> <address> [--json]  close one door of a port card (K-2007)
kitshn port remove <card> [--json]           remove a port card, its doors and its records (K-2007)`,
};

/** The help lines of all agent commands. */
export const AGENT_USAGE = AGENT_COMMANDS.map((command) => AGENT_HELP[command]).join("\n");

/** K-1809: with `--json`, stdout holds only the result object; progress and notes go to stderr. */
let json = false;

const answered = (status: number, path: string) =>
  `kitshn answered ${status} to ${path}. Try again; if it fails again, run kitshn status.`;

/** K-1116, K-1120, K-1123: one JSON call to an `/agent` path. */
async function agentCall<T>(t: AgentTransport, path: string, body: object): Promise<T> {
  const response = await t.call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) fail(data?.error ?? answered(response.status, path));
  return data as T;
}

/**
 * C2 of the UX audit: the circles that hold a card, from the state of the agent, and the line that says who opens it.
 * `fresh`: a first publish, which lands in the tray unless it named a circle.
 */
async function reach(t: AgentTransport, card: string, fresh: boolean) {
  try {
    const found = (await t.state()).cards.find((each) => each.id === card);
    const circles = found ? found.circles : fresh ? [] : null;
    return { circles, text: reachText(circles) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { circles: null, text: `who opens it: unknown, because kitshn agent state failed: ${reason}` };
  }
}

interface PublishOptions {
  readonly name: string;
  readonly circle: string;
  readonly address: string;
  readonly zone: string;
  readonly open: boolean;
}

/**
 * K-1116: `kitshn publish <file>` sends the file to `/agent/library`. The same name again updates the card and keeps
 * the previous version (K-1117).
 */
async function publish(t: AgentTransport, file: string, options: PublishOptions) {
  if (!existsSync(file)) fail(`${file} does not exist. Name a file or a folder that exists.`);
  if (statSync(file).isDirectory()) return publishFolder(t, file, options);
  if (options.zone)
    usageFail("--zone is for a folder site; a page or a file lives on the kitshn zone. Drop --zone.");
  const { name, circle, address, open } = options;
  const body = readFileSync(file);
  const fileName = name || file.slice(file.lastIndexOf(sep) + 1);
  const headers: Record<string, string> = {
    "x-kitshn-name": encodeURIComponent(fileName),
    "content-type": contentType(fileName),
  };
  if (circle) headers["x-kitshn-circle"] = encodeURIComponent(circle);
  if (address) headers["x-kitshn-address"] = encodeURIComponent(address);
  if (open) headers["x-kitshn-public"] = "true";
  const response = await t.call("/agent/library", { method: "POST", headers, body });
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    id?: string;
    address?: string | null;
    updated?: boolean;
    revision?: number | null;
  } | null;
  if (!response.ok) fail(data?.error ?? answered(response.status, "/agent/library"));
  const updated = data?.updated === true;
  const who = await reach(t, data?.id ?? "", !updated);
  if (json)
    return void process.stdout.write(
      cardOutput({
        address: data?.address,
        card: data?.id,
        kind: fileName.toLowerCase().endsWith(".html") ? "page" : "file",
        updated,
        revision: data?.revision ?? null,
        circles: who.circles,
      }),
    );
  console.log(
    `kitshn: ${updated ? "updated" : "published"} ${fileName}${data?.address ? ` at https://${data.address}` : ""}. ${who.text}`,
  );
}

/**
 * K-1123: a folder becomes a static site at `<name>.<zone>`, in the steps of a repo deploy: plan, the upload of the
 * files straight to Cloudflare, finish. The same folder name again deploys the same site.
 */
async function publishFolder(t: AgentTransport, folder: string, options: PublishOptions) {
  const name = options.name || resolve(folder).slice(resolve(folder).lastIndexOf(sep) + 1);
  const plan = await agentCall<{ deployId: string; card: string; address: string; updated: boolean }>(
    t,
    "/agent/sites/plan",
    {
      folder: name,
      circle: options.circle,
      address: options.address,
      zone: options.zone,
      public: options.open,
    },
  );
  const assets = await uploadAssets(folder, (manifest) =>
    agentCall<AssetSession>(t, "/agent/sites/assets", { deployId: plan.deployId, manifest }),
  );
  const done = await agentCall<{ address: string; status: number }>(t, "/agent/sites/finish", {
    deployId: plan.deployId,
    jwt: assets.jwt,
    icon: assets.icon,
    headers: assets.headers,
    redirects: assets.redirects,
  });
  const who = await reach(t, plan.card, !plan.updated);
  if (json)
    return void process.stdout.write(
      cardOutput({
        address: done.address,
        card: plan.card,
        kind: "folder",
        updated: plan.updated,
        circles: who.circles,
      }),
    );
  console.log(
    `kitshn: ${plan.updated ? "updated" : "published"} ${name} (${assets.count} files) at https://${done.address} (answered ${done.status}). ${who.text}`,
  );
}

/** K-1117, K-821: `kitshn publish --previous <card>`: a page or a file to its previous slot, a folder site back one deploy. */
async function previous(t: AgentTransport, card: string) {
  const data = await agentCall<Record<string, unknown>>(
    t,
    `/agent/cards/${encodeURIComponent(card)}/previous`,
    {},
  );
  if (json) return void process.stdout.write(`${JSON.stringify({ card, previous: true, ...data })}\n`);
  console.log(`kitshn: ${card} is back at its previous version. Run it again to switch back (K-1117).`);
}

/** K-1117: `kitshn unpublish <card>` removes a page, a file or a folder site that this agent published. */
async function unpublish(t: AgentTransport, card: string) {
  const path = `/agent/cards/${encodeURIComponent(card)}`;
  const response = await t.call(path, { method: "DELETE" });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) fail(data?.error ?? answered(response.status, path));
  if (json) return void process.stdout.write(`${JSON.stringify({ card, removed: true })}\n`);
  console.log(`kitshn: removed ${card}; its address no longer opens it.`);
}

/** K-1120: gives a page or a file card, by its id or its address name, a new address name. */
async function setAddress(t: AgentTransport, card: string, name: string) {
  const data = await agentCall<{
    address: string;
    card: string;
    kind: "page" | "file" | "folder";
    revision: number | null;
  }>(t, `/agent/cards/${encodeURIComponent(card)}/address`, {
    address: name,
  });
  if (json)
    return void process.stdout.write(
      cardOutput({
        address: data.address,
        card: data.card,
        kind: data.kind,
        updated: true,
        revision: data.revision,
      }),
    );
  console.log(`kitshn: ${card} is now at https://${data.address}`);
}

/** K-1809: an agent key searches the logs of a card that it controls (K-1810); no Live, which needs the map. */
async function logs(
  t: AgentTransport,
  card: string,
  text: string,
  range: { from: number; to: number },
  options: { deploys: boolean; json: boolean },
) {
  const answer = await agentCall<{ answer?: LogAnswer; runs?: ReadonlyArray<DeployRun> }>(t, "/agent/logs", {
    card,
    tab: options.deploys ? "deploys" : "app",
    text,
    from: range.from,
    to: range.to,
  });
  // An error answer fails (exit 1), also with --json, where the catch prints it as {"error"} (K-1809).
  const found = answer.answer;
  if (found?.state === "error") fail(found.error);
  if (found?.state === "needs-permission")
    fail(
      'search in Worker logs needs the token permission "Account > Workers Observability > Edit" (K-1806).',
    );
  // With --json, stdout holds only the answer; console.log goes to stderr in that mode.
  if (options.json) return void process.stdout.write(`${JSON.stringify(found ?? answer.runs)}\n`);
  if (options.deploys) {
    for (const run of answer.runs ?? []) {
      console.log(
        `${new Date(run.at).toISOString()} ${run.sha.slice(0, 7)} ${run.state}${run.reason ? ` ${run.reason}` : ""}${run.runUrl ? ` ${run.runUrl}` : ""}`,
      );
      for (const line of run.lines ?? []) console.log(`  ${line}`);
    }
    return;
  }
  if (!found) fail("kitshn sent no answer.");
  if (found?.state !== "lines") return;
  for (const line of found.lines) console.log(logLineText(line));
  if (found.cut)
    console.error(
      "kitshn: the search stopped at 15 s, so the newest lines may be missing; narrow the range.",
    );
  else if (found.matched > found.lines.length)
    console.error(`kitshn: the newest ${found.lines.length} of ${found.matched} lines that match.`);
}

/**
 * K-1127: makes a new GitHub repo of a page or a folder site with the user's own `gh` login, and hands the card over
 * to it by the repo's ids: the repo's first push deploys the same card. The files come from `path`; for a page
 * without one, from kitshn.
 */
async function makeRepo(t: AgentTransport, card: string, path: string, repo: string) {
  const gh = (...ghArgs: Array<string>) => execFileSync("gh", ghArgs, { encoding: "utf8" }).trim();
  // A new repo only: the handover is for the repo that this command makes.
  const known = spawnSync("gh", ["repo", "view", repo, "--json", "name"], { stdio: "ignore" });
  if (known.error) fail("install the GitHub CLI and log in with gh auth login.");
  if (known.status === 0) fail(`${repo} exists already; name a new repo.`);
  if (path && !existsSync(path)) fail(`${path} does not exist.`);
  gh("repo", "create", repo, "--private");
  const [repoId = "", ownerId = ""] = gh("api", `repos/${repo}`, "--jq", ".id, .owner.id").split("\n");
  let handover: HandoverAnswer;
  try {
    handover = await agentCall<HandoverAnswer>(t, `/agent/cards/${encodeURIComponent(card)}/handover`, {
      repo,
      repoId,
      ownerId,
    });
  } catch (error) {
    console.error(
      `kitshn: ${repo} is made but empty; delete it with gh repo delete ${repo} if you do not need it.`,
    );
    throw error;
  }
  const dir = mkdtempSync(join(tmpdir(), "kitshn-repo-"));
  try {
    const site = join(dir, "site");
    mkdirSync(site);
    if (path && statSync(path).isDirectory())
      cpSync(path, site, {
        recursive: true,
        filter: (from) =>
          !relative(path, from)
            .split(sep)
            .some((part) => part.startsWith(".")),
      });
    else if (path && handover.kind === "page") cpSync(path, join(site, "index.html"));
    else if (path) fail(`${path} is a file; a folder site becomes a repo from its folder.`);
    else if (handover.kind === "page") {
      const page = await t.call(`/agent/library/${encodeURIComponent(handover.card)}/content`, {
        method: "GET",
      });
      if (!page.ok) fail(`kitshn did not send the page: ${page.status}.`);
      writeFileSync(join(site, "index.html"), Buffer.from(await page.arrayBuffer()));
    } else fail("name the folder of the site: kitshn cannot read the files of a folder site back.");
    const skill = versionedSkill(skillText(), KITSHN_RELEASE, "repo");
    for (const [file, text] of Object.entries(repoFiles(handover, repo, await t.server(), skill))) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const git = (...gitArgs: Array<string>) => execFileSync("git", gitArgs, { cwd: dir, stdio: "inherit" });
    git("init", "--quiet", "--initial-branch", "main");
    git("add", "--all");
    git("commit", "--quiet", "--message", `kitshn: ${repo} from its kitshn card`);
    // The user's gh login pushes, so the first deploy comes from the user's push.
    git(
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "--quiet",
      `https://github.com/${repo}.git`,
      "main",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    `kitshn: made ${repo}; its first push deploys the card at https://${handover.addresses[0] ?? ""} (K-1127).`,
  );
}

/** K-212: `30m`, `1h`, `4h` or `1d` from now, `stop` for no end, or `now`; undefined for any other word. */
export function timeBody(word: string, now: number): { endsAt: number | null } | { now: true } | undefined {
  if (word === "now") return { now: true };
  if (word === "stop") return { endsAt: null };
  const after = sinceMs(word);
  return after === null ? undefined : { endsAt: now + after };
}

async function cardTime(t: AgentTransport, card: string, word: string) {
  const body =
    timeBody(word, Date.now()) ?? usageFail(`kitshn time takes 30m, 1h, 4h, 1d, stop or now, not "${word}".`);
  const data = await agentCall<{ revision: number | null; endsAt: number | null }>(
    t,
    `/agent/cards/${encodeURIComponent(card)}/time`,
    body,
  );
  if (json) return void process.stdout.write(`${JSON.stringify({ card, ...data })}\n`);
  console.log(
    data.endsAt === null
      ? word === "now"
        ? `kitshn: ${card} is in the tray now, out of every circle.`
        : `kitshn: ${card} stays until someone moves it.`
      : `kitshn: ${card} moves to the tray at ${localTime(data.endsAt, Date.now())}. kitshn time ${card} stop keeps it.`,
  );
}

/** K-1128: adds a hostname that only sends visitors on to a site card, or with `remove` takes it away again. */
async function redirect(t: AgentTransport, card: string, address: string, remove: boolean) {
  const path = `/agent/cards/${encodeURIComponent(card)}/redirects`;
  const response = await t.call(remove ? `${path}/${encodeURIComponent(address)}` : path, {
    method: remove ? "DELETE" : "POST",
    headers: { "content-type": "application/json" },
    ...(remove ? {} : { body: JSON.stringify({ address }) }),
  });
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    card?: string;
    address?: string;
    to?: string;
    revision?: number;
  } | null;
  if (!response.ok || !data) fail(data?.error ?? answered(response.status, path));
  if (json) return void process.stdout.write(`${JSON.stringify({ ...data, removed: remove })}\n`);
  console.log(
    remove
      ? `kitshn: ${address} no longer sends visitors on to ${card}.`
      : `kitshn: ${address} sends visitors on to https://${data?.to ?? ""} once its domain is up (K-1128).`,
  );
}

/** K-2001, K-2007: `kitshn port add|doors|close`. An agent never opens a door; a person does on the connect page. */
async function portCard(transport: () => AgentTransport, args: ReadonlyArray<string>) {
  const valued = new Set(["--machine", "--name", "--port", "--door", "--srv", "--relay", "--server"]);
  const values = (name: string) =>
    args.flatMap((arg, index) => (arg === name ? [args[index + 1] ?? ""] : []));
  const [action, card, address] = args.filter(
    (arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1] ?? ""),
  );
  let response: Response;
  if (action === "add") {
    const door = values("--door")[0] ?? "12h";
    const hours = door.endsWith("d") ? Number(door.slice(0, -1)) * 24 : Number(door.replace(/h$/, ""));
    if (!Number.isFinite(hours)) usageFail(`--door is a time like 12h or 2d, not ${door}.`);
    response = await transport().call("/agent/ports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        machine: values("--machine")[0] ?? "",
        name: values("--name")[0] ?? "",
        ports: values("--port"),
        doorHours: hours,
        srv: values("--srv")[0] ?? "",
        relay: values("--relay")[0] ?? "",
      }),
    });
  } else if (action === "doors" && card) {
    response = await transport().call(`/agent/cards/${encodeURIComponent(card)}/doors`, { method: "GET" });
  } else if (action === "remove" && card) {
    response = await transport().call(`/agent/cards/${encodeURIComponent(card)}`, { method: "DELETE" });
  } else if (action === "close" && card && address) {
    response = await transport().call(
      `/agent/cards/${encodeURIComponent(card)}/doors/${encodeURIComponent(address)}`,
      {
        method: "DELETE",
      },
    );
  } else return usageFail(`name what to do with the port card:\n${AGENT_HELP.port}`);
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !data) fail(String(data?.["error"] ?? answered(response.status, "/agent/ports")));
  if (json) return void process.stdout.write(`${JSON.stringify(data)}\n`);
  if (action === "add")
    console.log(
      `kitshn: added ${String(data?.["address"])}; players open it at ${String(data?.["connect"])}.`,
    );
  else if (action === "close") console.log(`kitshn: closed ${address} on ${card}.`);
  else if (action === "remove") console.log(`kitshn: removed the port card ${card}.`);
  else console.log(JSON.stringify(data, null, 2));
}

/**
 * Runs one agent command and exits on an error: 1 for a refused step, 2 for bad arguments (K-1809). With `--json`,
 * the reason is the one object on stdout.
 */
export async function runAgentCommand(
  command: AgentCommand,
  args: ReadonlyArray<string>,
  transport: () => AgentTransport,
) {
  json = args.includes("--json");
  if (json) console.log = console.error.bind(console);
  const flag = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  /** The words that are not flags or flag values. */
  const words = (valued: ReadonlyArray<string>) =>
    args.filter(
      (arg, index) => !arg.startsWith("--") && !["--server", ...valued].includes(args[index - 1] ?? ""),
    );
  const usage = (reason: string): never => usageFail(`${reason}\n${AGENT_HELP[command]}`);
  try {
    if (command === "publish") {
      const [file] = words(["--name", "--circle", "--address", "--zone", "--previous"]);
      const back = flag("--previous", "");
      if (args.includes("--previous")) {
        if (!back) usage("name the card to take back to its previous version.");
        return await previous(transport(), back);
      }
      if (!file) usage("name the file or folder to publish.");
      await publish(transport(), file ?? "", {
        name: flag("--name", ""),
        circle: flag("--circle", ""),
        address: flag("--address", ""),
        zone: flag("--zone", ""),
        open: args.includes("--public"),
      });
    } else if (command === "unpublish") {
      const [card] = words([]);
      if (!card) usage("name the card to remove.");
      await unpublish(transport(), card ?? "");
    } else if (command === "logs") {
      const { card, text } = logArgs(args);
      if (!card) usage("name the card.");
      const range = logRange(
        { since: flag("--since", ""), from: flag("--from", ""), to: flag("--to", "") },
        Date.now(),
      );
      if (typeof range === "string") usage(range);
      await logs(transport(), card ?? "", text, range as { from: number; to: number }, {
        deploys: args.includes("--deploys"),
        json: args.includes("--json"),
      });
    } else if (command === "redirect") {
      const [card, address] = words([]);
      if (!card || !address) usage("name the site card and the hostname.");
      await redirect(transport(), card ?? "", address ?? "", args.includes("--remove"));
    } else if (command === "time") {
      const [card, word] = words([]);
      if (!card || !word) usage("name the card and the time.");
      await cardTime(transport(), card ?? "", word ?? "");
    } else if (command === "port") {
      await portCard(transport, args);
    } else if (command === "address") {
      const [card, name] = words([]);
      if (!card || !name) usage("name the card and its new address name.");
      await setAddress(transport(), card ?? "", name ?? "");
    } else if (command === "repo") {
      const [card, path] = words(["--repo"]);
      const repo = flag("--repo", "");
      if (!card || !repo) usage("name the card and the new repo.");
      await makeRepo(transport(), card ?? "", path ?? "", repo);
    }
  } catch (error) {
    const code = error instanceof UsageError ? 2 : 1;
    if (json) {
      process.stdout.write(errorOutput(error instanceof Error ? error.message : String(error)));
      process.exit(code);
    }
    if (!(error instanceof CliError)) throw error;
    console.error(`kitshn: ${error.message}`);
    process.exit(code);
  }
}
