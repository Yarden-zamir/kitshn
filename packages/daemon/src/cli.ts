// The text of the `kitshn` commands of a machine, apart from the commands that print it, so tests can read it.
import type { Answer, AskAction, IdRequest } from "@kitshn/local";
import { fail } from "kitshn/cli-error";
import type { ServerReport } from "@kitshn/edge/sites";
import {
  AGENT_COMMANDS,
  AGENT_HELP,
  type AgentState,
  type ForwardWait,
  type StateRight,
  forwardWaiting,
  isAgentCommand,
  waitingLine,
} from "kitshn/agent";
import { OPS_HELP } from "kitshn/ops";
import type { SiteEntry } from "./sites.ts";

/**
 * C7 of the UX audit: one line for each action of `kitshn agent` (K-1711). `exec` is no ask of an agent: only the
 * exec request of a provider starts a run on another machine (K-722).
 */
export const ASK_ACTION_HELP: Record<Exclude<AskAction, "exec">, string> = {
  state: `the cards, circles, effects and open asks of this machine; --body '{"all":true}' adds servers and link events`,
  apply: `move a card or change a share: --body '{"edits":[...]}'`,
  organize: "tidy the cards that you manage into a grid, as one Undo (K-532)",
  publish: `move a card into Everyone, or out with --body '{"public":false}'`,
  allow: "let a waiting repo deploy: kitshn agent allow <repo id> (K-819)",
  deploy: `redeploy a card: kitshn agent deploy <card> --body '{"mode":"redeploy"}' or '{"mode":"build"}'`,
  job: `run a command on a machine: kitshn agent job <machine> --body '{"command":...}' (K-612)`,
  "job-read": "the state and output of a job that this machine sent: kitshn agent job-read <job id>",
  "github-token": "a GitHub token for a repo: kitshn agent github-token <owner/name> (K-1762)",
  "audience-add": "add a pass audience: kitshn agent audience-add --audience <address> (K-1773)",
  "audience-remove": "remove a pass audience: kitshn agent audience-remove --audience <address>",
  pass: "a pass for an outside service: kitshn agent pass --audience <address> (K-1774)",
  approve:
    "approve an open ask of a circle that this machine is in: kitshn agent approve <proposal id> (K-1726)",
  deny: "deny an open ask: kitshn agent deny <proposal id> (K-1726)",
  history: "the asks of this machine with one label: kitshn agent history t3.thread.id=<id> (K-1756)",
  backup: "back up a Compose card now: kitshn agent backup <card> (K-1819)",
  restore: `write a backup run back: kitshn agent restore <card> --body '{"run":<run>}' (K-1820)`,
};

export function askActionsText(): string {
  const width = Math.max(...Object.keys(ASK_ACTION_HELP).map((action) => action.length));
  return Object.entries(ASK_ACTION_HELP)
    .map(([action, text]) => `  ${action.padEnd(width)}  ${text}`)
    .join("\n");
}

/** C5 of the UX audit: the help of each command of a machine, for `kitshn <command> --help` and `kitshn --help`. */
const MACHINE_HELP = {
  join: "kitshn join <code> --server <address>   join this machine to kitshn (K-602)",
  service: `kitshn service install                  run the daemon as a user service (K-601)
kitshn service uninstall                stop and remove the user service`,
  run: "kitshn run                              run the daemon in the foreground",
  "rotate-key":
    "kitshn rotate-key                       replace the machine key over the live connection (K-1705)",
  rekey:
    "kitshn rekey <code>                     make a new machine key with the key code of its panel (K-1706, K-1708)",
  status:
    "kitshn status                           the machine, its map name, server, effects, key, connection and tunnel",
  health:
    "kitshn health [--now] [--json]          the last check of the providers and links of this machine (K-630)",
  "local-users": `kitshn local-users list|add|remove <u>  who else may use the local socket, as the daemon user (K-701);
                                        add <u> --provider also lets it run a provider`,
  providers: `kitshn providers rebind <name> --to-user <u>
                                        move a provider to a provider user (K-704)
kitshn providers exec-user <name> <u>   the user that runs commands of other machines for that provider (K-722)`,
  provider: `kitshn provider                         join stdin and stdout to the local socket, for a provider (K-704)
kitshn provider forget <name>           drop a provider that does not run, as the daemon user or root (K-704)`,
  agent: `kitshn agent <action> [target]          ask kitshn as this machine (K-1710): --reason, --label k=v, --body json;
                                        kitshn agent --help lists the actions`,
  "setup-git": "kitshn setup-git                        git asks kitshn first for github.com tokens (K-1763)",
  gh: "kitshn gh <args>                        gh with a kitshn token for this repo (K-1764)",
  expose: `kitshn expose <port|socket> --name <n> [--circle <circle>] [--time 1h] [--dev] [--new] [--json]
                                        share a local server at <n>.<zone> (K-1104): also localhost:5173 or
                                        http://127.0.0.1:5173/ (K-1131); --circle shares it with a circle where
                                        this machine has control (K-718), else it waits private in the tray;
                                        --time ends it (K-212); --dev sets Host localhost; --new refuses a
                                        name that this machine shares already`,
  unexpose: "kitshn unexpose <name>                  stop sharing it",
  servers:
    "kitshn servers [--json]                 the servers that listen on this machine, and what kitshn exposes (K-619)",
  doors: `kitshn doors install --user <u>         as root: the helper that gates the ports of port cards, for the daemon user (K-2006)
                                        --public-address <IPv4>: the address of a cloud machine behind its provider's NAT (K-2003)
kitshn doors uninstall                  as root: remove it and its firewall table`,
  exec: `kitshn exec install --user <u> --daemon-user <d>
                                        as root: the daemon user runs exec of other machines as <u> (K-722)
kitshn exec uninstall --user <u>        as root: remove that rule; exec as <u> then needs its provider's bridge`,
  skill: `kitshn skill install [--repo]           the skill for coding agents, global or in this repo (K-618)
kitshn skill check                      exit 1 when a copy of the skill is from another release`,
  version: `kitshn version [--json]                 the version; --json: {"product":"kitshn","generation":2,"version"}`,
} as const;

export type MachineCommand = keyof typeof MACHINE_HELP;
export const isMachineCommand = (value: string): value is MachineCommand =>
  Object.hasOwn(MACHINE_HELP, value);

/** The help of one command, or of all of them. */
export function helpText(command: string | null, version: string): string {
  if (command !== null && isAgentCommand(command)) return AGENT_HELP[command];
  if (command === "agent") return `${MACHINE_HELP.agent}\n\nThe actions:\n${askActionsText()}`;
  if (command !== null && isMachineCommand(command)) return MACHINE_HELP[command];
  const order: ReadonlyArray<MachineCommand> = [
    "join",
    "service",
    "run",
    "rotate-key",
    "rekey",
    "status",
    "health",
    "local-users",
    "providers",
    "provider",
    "agent",
  ];
  const rest = (Object.keys(MACHINE_HELP) as Array<MachineCommand>).filter((name) => !order.includes(name));
  return [
    `kitshn ${version}`,
    "",
    ...order.map((name) => MACHINE_HELP[name]),
    OPS_HELP,
    ...AGENT_COMMANDS.map((name) => AGENT_HELP[name]),
    ...rest.map((name) => MACHINE_HELP[name]),
    "",
    "kitshn <command> --help shows the help of one command.",
  ].join("\n");
}

/** C11 of the UX audit: one line for each effect of the machine, with its mode. */
export function rightLines(rights: ReadonlyArray<StateRight>): Array<string> {
  return rights.map(
    (right) =>
      `${right.name}: ${right.mode === "ask" ? `asks ${right.circle?.name ?? "the Owner"}` : right.mode}`,
  );
}

/**
 * C1 of the UX audit: the address of a live site. The card in the state of the agent has the real one; before kitshn
 * makes the card, another live site card names the zone of live sites. Known limit: with no such card, the zone is a
 * guess from the server host (`kit.<zone>`), so the address is pending; revisit if the daemon learns the zone.
 */
export function liveAddress(
  name: string,
  state: AgentState | null,
  server: string,
): { readonly address: string; readonly pending: boolean } {
  const live = (state?.cards ?? []).filter((card) => card.kind === "site.live");
  const own = live.find((card) => card.name === name)?.addresses[0];
  if (own) return { address: own, pending: false };
  const other = live.find((card) => card.addresses[0]?.includes("."))?.addresses[0];
  const zone = other
    ? other.slice(other.indexOf(".") + 1)
    : URL.canParse(server)
      ? new URL(server).hostname.split(".").slice(1).join(".")
      : "<zone>";
  return { address: `${name}.${zone}`, pending: true };
}

/**
 * Dev servers first. Known limit: "dev" means a process of a known runtime that answers HTTP; revisit when an owner
 * misses a server at the end of the list.
 */
const DEV_RUNTIMES: ReadonlySet<string> = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "php",
  "java",
  "dotnet",
  "go",
  "hugo",
]);

const serverRank = (server: ServerReport) =>
  server.status === null ? 2 : DEV_RUNTIMES.has((server.process ?? "").toLowerCase()) ? 0 : 1;

/** C10 of the UX audit: the table of `kitshn servers`, with the name that each port is exposed as. */
export function serverTable(
  servers: ReadonlyArray<ServerReport>,
  sites: ReadonlyArray<SiteEntry>,
): Array<string> {
  const exposed = (port: number) =>
    sites
      .filter((site) => site.target === `http://localhost:${port}`)
      .map((site) => site.name)
      .join(",");
  const rows = [...servers]
    .sort((a, b) => serverRank(a) - serverRank(b) || a.port - b.port)
    .map((server) => [
      String(server.port),
      server.process ?? "?",
      server.status === null ? "no http" : String(server.status),
      exposed(server.port) || "-",
      server.title ?? "",
    ]);
  const header = ["PORT", "PROCESS", "HTTP", "EXPOSED AS", "TITLE"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** C12 of the UX audit: why `kitshn unexpose <name>` found nothing, with the names that it can stop. */
export function unexposeRefusal(name: string | undefined, sites: ReadonlyArray<SiteEntry>): string {
  const names = sites.map((site) => site.name);
  const which = name ? `no site of this machine is named ${name}.` : "name the site to stop.";
  return names.length === 0
    ? `${which} Nothing is exposed on this machine.`
    : `${which} Exposed here: ${names.join(", ")}.`;
}

/** One request to the daemon: `follow` keeps the connection for a later line, which `onLine` sees first (K-1722). */
export type LocalAsk = (
  request: IdRequest,
  follow?: (answer: Answer) => boolean,
  onLine?: (answer: Answer) => void,
) => Promise<Answer>;

type ForwardAnswer = Extract<Answer, { type: "forward" }>;

const waitOf = (answer: Answer) =>
  answer.type === "forward"
    ? forwardWaiting(answer.status, Buffer.from(answer.body, "base64").toString("utf8"))
    : null;

/** K-1714: the waiting answer that `--json` prints as one line on stdout, before the result line. */
export const waitingJson = (wait: ForwardWait) => JSON.stringify({ outcome: "waiting", ...wait });

/**
 * K-1714, K-1776: one forwarded call. While it waits for an approval, it prints the waiting line and keeps the
 * connection for the answer of the proposal; after "approved" it sends the same call once more, from the same
 * thread, because the approval runs only that call. "denied" or "expired" fail with one line. `say` also gets the
 * wait, so `--json` can print it as data.
 */
export async function forwardAndWait(
  ask: LocalAsk,
  request: Extract<IdRequest, { type: "forward" }>,
  say: (line: string, wait: ForwardWait) => void,
  now: () => number,
): Promise<ForwardAnswer> {
  const forward = (answer: Answer): ForwardAnswer =>
    answer.type === "forward"
      ? answer
      : fail(`the daemon answered ${answer.type} to a forwarded call. Update kitshn on this machine.`);
  const first = await ask(
    request,
    (answer) => waitOf(answer) !== null,
    (answer) => {
      const wait = waitOf(answer);
      if (wait) say(waitingLine(wait, now(), true), wait);
    },
  );
  if (first.type !== "ask-result") return forward(first);
  if (first.outcome !== "approved")
    fail(
      `${first.outcome}: proposal ${first.proposalId}${first.reason ? ` (${first.reason})` : ""}. Nothing ran; run the command again to ask again (K-1776).`,
    );
  return forward(await ask(request));
}
