import type { Command, Machine, MachineKey, MachineStatus } from "../core/machine.ts";
import type { JobView } from "../core/protocol.ts";
import { FACT_LABELS, type MachineFact, hasLabels, isReservedLabel } from "../core/facts.ts";
import { type ProviderRefusal, PROVIDER_LIMITS, isProviderName } from "@kitshn/local";

/** K-613: a job waits at most this long for its machine by default. */
export const JOB_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** K-1107: a machine that answered no ping for this long counts as offline. */
export const PING_TIMEOUT_MS = 30_000;
/**
 * K-1107, K-1302: the alarm checks the pings at least this often; each daemon sample checks them too. Each alarm
 * wakes the Durable Object, and a wake reads rows, so a 30-second alarm cost about 2,880 wakes a day.
 */
export const LIVENESS_CHECK_MS = 120_000;
/** K-602 */
export const JOIN_CODE_MS = 10 * 60 * 1000;
/** K-1601 */
export const DEVICE_INVITE_MS = 15 * 60 * 1000;
/** Job output that kitshn keeps, at most. The daemon caps it too. */
export const OUTPUT_LIMIT = 64 * 1024;

export type Job = JobView;

/** K-610: the first online machine in the owner's order that has every label, or null. Fact labels count (K-635). */
export function pickMachine(
  machines: Iterable<Machine>,
  online: ReadonlySet<string>,
  labels: ReadonlyArray<string>,
  factsOf: (machine: Machine) => ReadonlyArray<MachineFact>,
): Machine | null {
  const fitting = [...machines]
    .filter((machine) => online.has(machine.id) && hasLabels(machine.labels, factsOf(machine), labels))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return fitting[0] ?? null;
}

const LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;
const isFactLabel = (label: string): boolean => (FACT_LABELS as ReadonlyArray<string>).includes(label);

/** K-610: the labels that a job needs, which can name a fact label (K-635). */
export function parseLabels(value: unknown): Array<string> | string {
  if (!Array.isArray(value)) return "Labels must be a list.";
  const labels = value.map((label) => String(label).trim().toLowerCase()).filter(Boolean);
  const bad = labels.find((label) => !LABEL.test(label) && !isFactLabel(label));
  return bad ? `The label "${bad}" may use only a to z, 0 to 9 and dashes.` : [...new Set(labels)];
}

/** K-609, K-635: the labels that the owner sets. Only kitshn gives the names of fact labels. */
export function parseOwnerLabels(value: unknown): Array<string> | string {
  const labels = parseLabels(value);
  if (typeof labels === "string") return labels;
  const reserved = labels.find(isReservedLabel);
  return reserved === undefined
    ? labels
    : `The label "${reserved}" comes from the daemon: kitshn sets os:, arch: and unix labels by itself (K-635).`;
}

export function parseCommand(value: unknown): Command | string {
  if (typeof value !== "object" || value === null || !("kind" in value)) return "A job needs a command.";
  if (value.kind === "diagnostics" || value.kind === "restart" || value.kind === "tunnel-restart")
    return { kind: value.kind };
  // The version is not the sender's choice: kitshn fills in its own (K-617).
  if (value.kind === "update") return { kind: "update", version: "" };
  if (value.kind === "shell") {
    const script = "script" in value ? value.script : undefined;
    if (typeof script !== "string" || !script.trim() || script.length > 10_000) {
      return "A shell command needs a script of 1 to 10,000 characters.";
    }
    return { kind: "shell", script };
  }
  // K-909: the project is not the sender's choice: kitshn takes it from the machine's report.
  if (value.kind === "compose-volume-remove") {
    const volume = "volume" in value ? value.volume : undefined;
    if (typeof volume !== "string" || !volume || volume.length > 255) return "Name the volume to delete.";
    return { kind: "compose-volume-remove", project: "", volume };
  }
  // K-707: kitshn checks the provider, the command and the card against the machine's providers when it queues it.
  if (value.kind === "provider") {
    const field = (key: string) => (key in value ? (value as Record<string, unknown>)[key] : undefined);
    const provider = field("provider");
    const command = field("command");
    const resource = field("resource") ?? null;
    if (
      typeof provider !== "string" ||
      provider.length > 32 ||
      typeof command !== "string" ||
      command.length > 40
    )
      return "A provider command names its provider and its command.";
    if (resource !== null && (typeof resource !== "string" || resource.length > 64))
      return "A provider command names a card id, or none for the machine.";
    const row = field("row");
    if (row !== undefined && (typeof row !== "string" || row.length > 64))
      return "A row of a provider command is an id of at most 64 characters.";
    return { kind: "provider", provider, command, resource, ...(row === undefined ? {} : { row }) };
  }
  return `kitshn has no command "${String(value.kind)}".`;
}

/**
 * K-617: the update as a shell job, for a daemon from before the "update" job kind. It does what the
 * daemon would do: download the release file, check SHA256SUMS, replace the binary, then restart the
 * service from outside the daemon, so the job result still goes out. Null when the platform is unknown.
 */
export function legacyUpdateScript(version: string, os: string, arch: string): string | null {
  const platform = os.startsWith("linux") ? "linux" : os.startsWith("darwin") ? "darwin" : null;
  const cpu = arch === "arm64" || arch === "x64" ? arch : null;
  if (!platform || !cpu || !/^[0-9a-f]{12}$/.test(version)) return null;
  const file = `kitshn-${platform}-${cpu}.gz`;
  return [
    "set -e",
    `base=https://github.com/Yarden-zamir/kitshn/releases/download/edge-${version}`,
    'bin="$HOME/.local/bin/kitshn"',
    'tmp=$(mktemp "$bin.XXXXXX")',
    // Remove the temporary file when any step fails; after the mv it no longer exists.
    'trap \'rm -f "$tmp" "$tmp.bin"\' EXIT',
    `curl -fsSL "$base/${file}" -o "$tmp"`,
    `expected=$(curl -fsSL "$base/SHA256SUMS" | awk -v f=${file} '$2 == f || $2 == "*" f { print $1 }')`,
    `actual=$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | awk '{ print $1 }')`,
    'if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then rm -f "$tmp"; echo "The file does not match SHA256SUMS."; exit 1; fi',
    // One command per line: under set -e, a failure inside an && list does not stop the script.
    'gzip -dc "$tmp" > "$tmp.bin"',
    'mv "$tmp.bin" "$tmp"',
    'chmod 755 "$tmp"',
    'mv "$tmp" "$bin"',
    platform === "linux"
      ? "systemd-run --user --on-active=3 --collect systemctl --user restart kitshn.service >/dev/null"
      : '(sleep 3; launchctl kickstart -k "gui/$(id -u)/com.kitshn.daemon") >/dev/null 2>&1 &',
    `echo "Updated to ${version}; the daemon restarts in 3 seconds."`,
  ].join("\n");
}

/** A machine id from its name: lowercase, dashes, and a random tail so two machines never collide. */
export function machineIdFor(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const tail = crypto.randomUUID().slice(0, 6);
  return base ? `${base}-${tail}` : `machine-${tail}`;
}

/**
 * K-1704: where a machine socket is in its check. kitshn reads messages and sends jobs only on "signed" and
 * "token" sockets.
 */
export type MachineCheck =
  /** The challenge went out; no valid answer yet. */
  | "waiting"
  | "signed"
  /** K-1708: the machine has no key yet, so its service token alone counts, as before machine keys. */
  | "token";

/** K-1704, K-1706, K-1708: what kitshn does with a new `/connect` socket of a machine. */
export type SocketStart =
  /** K-1706: the machine waits for its key from a code, so the socket closes with 4005. */
  | { readonly kind: "waitsForKey" }
  | { readonly kind: "challenge"; readonly fingerprint: string }
  /** K-1708: no key yet; the token counts for status only, and the machine gets no job. */
  | { readonly kind: "token" };

export function socketStart(key: MachineKey | undefined): SocketStart {
  if (key === undefined) return { kind: "token" };
  if (key.kind === "waiting") return { kind: "waitsForKey" };
  return { kind: "challenge", fingerprint: key.fingerprint };
}

/** K-1704: how kitshn checks one answer to a challenge, before the signature check. */
export type AnswerCheck =
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "verify"; readonly publicKey: string; readonly fingerprint: string };

export function answerCheck(
  key: MachineKey | undefined,
  socket: { readonly check: MachineCheck; readonly answered: boolean },
): AnswerCheck {
  if (socket.answered || socket.check === "signed")
    return { kind: "refuse", reason: "A connection answers its challenge once." };
  // K-1708: the first key comes only with a rekey code, never on a connection.
  if (key === undefined) return { kind: "refuse", reason: "This machine has no key yet. Use its key code." };
  if (key.kind === "waiting") return { kind: "refuse", reason: "This machine waits for its key code." };
  return { kind: "verify", publicKey: key.publicKey, fingerprint: key.fingerprint };
}

/** K-1706, K-1708: what a rekey code does for the machine that sends it. */
export type RekeyDecision =
  | { readonly kind: "store" }
  /** `keepCode`: a code of another machine stays valid for its own machine. */
  | { readonly kind: "refuse"; readonly status: number; readonly reason: string; readonly keepCode: boolean };

export function rekeyDecision(
  code: { readonly machineId: string; readonly expiresAt: number },
  senderMachineId: string,
  machine: Machine | undefined,
  now: number,
): RekeyDecision {
  if (code.machineId !== senderMachineId)
    return {
      kind: "refuse",
      status: 403,
      reason: "This key code belongs to another machine.",
      keepCode: true,
    };
  if (code.expiresAt < now || !machine || machine.key?.kind === "public")
    return {
      kind: "refuse",
      status: 410,
      reason: "This key code expired. Make a new one in the panel.",
      keepCode: false,
    };
  return { kind: "store" };
}

/** K-704: the refused registrations of a daemon status, checked; a bad item is left out. */
export function providerRefusals(raw: unknown): ReadonlyArray<ProviderRefusal> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ProviderRefusal =>
        typeof item === "object" &&
        item !== null &&
        typeof item.provider === "string" &&
        isProviderName(item.provider) &&
        typeof item.reason === "string" &&
        Number.isSafeInteger(item.at),
    )
    .slice(0, PROVIDER_LIMITS.providers)
    .map(({ provider, reason, at }) => ({ provider, reason: reason.slice(0, 500), at }));
}

/** K-722: the exec paths of a daemon status, checked; a bad item is left out. */
export function execPathsOf(raw: unknown): NonNullable<MachineStatus["execPaths"]> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is { provider: string; user: string; via: "sudo" | "bridge" } =>
        typeof item === "object" &&
        item !== null &&
        typeof item.provider === "string" &&
        isProviderName(item.provider) &&
        typeof item.user === "string" &&
        (item.via === "sudo" || item.via === "bridge"),
    )
    .slice(0, PROVIDER_LIMITS.providers)
    .map(({ provider, user, via }) => ({ provider, user: user.slice(0, 32), via }));
}
