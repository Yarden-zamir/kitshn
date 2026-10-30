// Section 20: the door of port cards on this machine. The daemon has no privilege, so one root helper writes the
// nftables table; the daemon sends it the gated ports and the open doors as plain lines.
import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { type DoorPlan, type ServicePort, doorAddress, portKey } from "@kitshn/edge/port";

export const HELPER_PATH = "/usr/local/lib/kitshn/doors";
export const SUDOERS_PATH = "/etc/sudoers.d/kitshn-doors";
export const TABLE = "kitshn_doors";
export const STATE_PATH = "/var/lib/kitshn/doors.ports";
export const BOOT_UNIT_PATH = "/etc/systemd/system/kitshn-doors.service";

/** K-2005: loads the last gated ports with no door before the network and Docker start, so a reboot opens nothing. */
export const BOOT_UNIT = `[Unit]
Description=kitshn port doors: portCard ports start closed (K-2005)
DefaultDependencies=no
# After nftables.service, whose \`flush ruleset\` would delete the table again.
After=local-fs.target nftables.service
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=${HELPER_PATH} boot
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;

/**
 * K-2005: the root helper. It reads `port`, `open4` and `open6` lines, checks each field, and replaces the table
 * `inet kitshn_doors` in one nft transaction. `off` removes the table. It touches no other table.
 */
export const HELPER = `#!/bin/sh
# kitshn doors (K-2005): the one root step of kitshn port cards. Installed by \`kitshn doors install\`.
# Usage: doors apply < lines | doors boot | doors off. It changes only the nftables table inet ${TABLE}.
# \`boot\` runs before the network at each start: it loads the last gated ports with no door, so they start closed.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
table=${TABLE}
# A fixed path: nothing from the caller's environment decides where root writes. The traffic test edits a copy.
state=${STATE_PATH}
mode=\${1:-}
fail() { echo "doors: $*" >&2; exit 2; }
remove() { if nft list table inet "$table" >/dev/null 2>&1; then nft delete table inet "$table"; fi; }
case "\${1:-}" in
off) remove; rm -f "$state"; exit 0 ;;
boot) [ -f "$state" ] || exit 0; exec <"$state" ;;
apply) ;;
*) fail "usage: doors apply < lines | doors boot | doors off" ;;
esac
number() { case "$1" in "" | *[!0-9]*) return 1 ;; esac; [ "\${#1}" -le 6 ]; }
port() { number "$1" && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
proto() { [ "$1" = tcp ] || [ "$1" = udp ]; }
seconds() { number "$1" && [ "$1" -ge 1 ] && [ "$1" -le 604800 ]; }
ipv4() {
  case "$1" in *[!0-9.]* | *..* | .* | *.) return 1 ;; esac
  old=$IFS; IFS=.; set -- $1; IFS=$old
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do number "$octet" && [ "$octet" -le 255 ] || return 1; done
}
# The network of a /64, as kitshn writes it: four groups of 1 to 4 hex digits, then "::".
ipv6net() {
  case "$1" in *::) ;; *) return 1 ;; esac
  head=\${1%::}
  case "$head" in "" | *[!0-9a-f:]* | *::* | :* | *:) return 1 ;; esac
  old=$IFS; IFS=:; set -- $head; IFS=$old
  [ "$#" -eq 4 ] || return 1
  for group in "$@"; do case "$group" in "" | ?????*) return 1 ;; esac; done
}
ports="" portlines="" open4="" open6="" lines=0
while IFS=' ' read -r kind a b c d extra; do
  lines=$((lines + 1))
  # At boot a bad line costs only itself: the good gated ports still load, so a damaged file fails closed.
  if [ "$mode" = boot ]; then
    [ "$lines" -le 4000 ] || break
    if [ "$kind" = port ] && proto "$a" && port "$b" && [ -z "\${c:-}" ] && [ -z "\${extra:-}" ]; then
      ports="$ports\${ports:+, }$a . $b"
      portlines="\${portlines}port $a $b
"
    else
      echo "doors: skipped line $lines of $state" >&2
    fi
    continue
  fi
  [ "$lines" -le 4000 ] || fail "too many lines"
  [ -z "\${extra:-}" ] || fail "line $lines has too many fields"
  case "$kind" in
  port)
    proto "$a" && port "$b" && [ -z "\${c:-}" ] || fail "line $lines is no port"
    ports="$ports\${ports:+, }$a . $b"
    portlines="\${portlines}port $a $b
" ;;
  open4)
    ipv4 "$a" && proto "$b" && port "$c" && seconds "$d" || fail "line $lines is no IPv4 door"
    open4="$open4\${open4:+, }$a . $b . $c timeout \${d}s" ;;
  open6)
    ipv6net "$a" && proto "$b" && port "$c" && seconds "$d" || fail "line $lines is no IPv6 door"
    # nft reads "x::" before " ." as a host name, so the element takes the full 8-group form.
    open6="$open6\${open6:+, }$head:0:0:0:0 . $b . $c timeout \${d}s" ;;
  "") ;;
  *) fail "line $lines is unknown" ;;
  esac
done
if [ -z "$ports" ]; then remove; rm -f "$state"; exit 0; fi
elements4="" elements6=""
[ -z "$open4" ] || elements4="elements = { $open4 }"
[ -z "$open6" ] || elements6="elements = { $open6 }"
script=$(mktemp)
trap 'rm -f "$script"' EXIT
cat >"$script" <<EOF
table inet $table
delete table inet $table
table inet $table {
  set gated_ports { type inet_proto . inet_service; elements = { $ports } }
  set open4 { type ipv4_addr . inet_proto . inet_service; flags timeout; $elements4 }
  set open6 { type ipv6_addr . inet_proto . inet_service; flags timeout; $elements6 }
  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "lo" accept
    ct direction reply accept
    meta l4proto != { tcp, udp } accept
    ip saddr . meta l4proto . th dport @open4 accept
    ip6 saddr and ffff:ffff:ffff:ffff:0:0:0:0 . meta l4proto . th dport @open6 accept
    meta l4proto . th dport @gated_ports drop
  }
  # "End now" cuts both ways: the service's own packets to a closed address go too.
  chain output {
    type filter hook output priority filter - 10; policy accept;
    oifname "lo" accept
    ct direction original accept
    meta l4proto != { tcp, udp } accept
    ip daddr . meta l4proto . th sport @open4 accept
    ip6 daddr and ffff:ffff:ffff:ffff:0:0:0:0 . meta l4proto . th sport @open6 accept
    meta l4proto . th sport @gated_ports drop
  }
  # A port that system Docker publishes goes DNAT and through here, in both directions.
  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    ct status & dnat == 0 accept
    meta l4proto != { tcp, udp } accept
    ct direction original ip saddr . meta l4proto . ct original proto-dst @open4 accept
    ct direction original ip6 saddr and ffff:ffff:ffff:ffff:0:0:0:0 . meta l4proto . ct original proto-dst @open6 accept
    ct direction reply ip daddr . meta l4proto . ct original proto-dst @open4 accept
    ct direction reply ip6 daddr and ffff:ffff:ffff:ffff:0:0:0:0 . meta l4proto . ct original proto-dst @open6 accept
    meta l4proto . ct original proto-dst @gated_ports drop
  }
}
EOF
nft -c -f "$script"
nft -f "$script"
# The gated ports alone, for \`boot\`; root's file, so the daemon user cannot change what loads before the network.
if [ "$mode" = apply ]; then
  mkdir -p "\${state%/*}"
  umask 077
  printf '%s' "$portlines" >"$state.new"
  mv "$state.new" "$state"
fi
`;

/** The daemon only applies plans; `off` and `boot` run as root through the install command and the boot unit. */
export const sudoersLine = (user: string) => `${user} ALL=(root) NOPASSWD: ${HELPER_PATH} apply\n`;

/** K-2005: the helper's input for a plan. A door that has ended is left out; the kernel ends the rest. */
export function helperInput(plan: DoorPlan, now: number): string {
  const lines = plan.ports.map(({ proto, port }) => `port ${proto} ${port}`);
  for (const door of plan.doors) {
    const seconds = Math.min(604_800, Math.floor((door.endsAt - now) / 1000));
    if (seconds < 1) continue;
    const kind = door.address.includes(":") ? "open6" : "open4";
    const address = door.address.replace(/\/64$/, "");
    for (const { proto, port } of door.ports) lines.push(`${kind} ${address} ${proto} ${port} ${seconds}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * K-2008: one `cloudflared access tcp` per port card that this machine relays. It listens on the gated port, so the door
 * table gates it like a local port; the service token goes in the environment, never into the process arguments.
 */
export class Relays {
  private readonly running = new Map<string, ChildProcess>();
  private wanted = new Set<string>();

  constructor(
    private readonly log: (line: string) => void,
    private readonly restartMs = 5000,
  ) {}

  /** K-2008: the relays end with the daemon; a service manager that kills only the daemon leaves no listener. */
  stopAll() {
    this.wanted = new Set();
    for (const child of this.running.values()) child.kill();
    this.running.clear();
  }

  sync(
    relays: DoorPlan["relays"] | undefined,
    cloudflared: string,
    token: { readonly clientId: string; readonly clientSecret: string },
  ) {
    this.wanted = new Set((relays ?? []).map(({ hostname, port }) => `${hostname} ${port}`));
    for (const [key, child] of this.running) {
      if (this.wanted.has(key)) continue;
      this.running.delete(key);
      child.kill();
    }
    for (const key of this.wanted) if (!this.running.has(key)) this.start(key, cloudflared, token);
  }

  private start(
    key: string,
    cloudflared: string,
    token: { readonly clientId: string; readonly clientSecret: string },
  ) {
    const [hostname = "", port = ""] = key.split(" ");
    const child = spawn(cloudflared, ["access", "tcp", "--hostname", hostname, "--url", `0.0.0.0:${port}`], {
      env: {
        ...process.env,
        TUNNEL_SERVICE_TOKEN_ID: token.clientId,
        TUNNEL_SERVICE_TOKEN_SECRET: token.clientSecret,
      },
      stdio: "ignore",
    });
    this.running.set(key, child);
    this.log(`relay ${hostname} listens on ${port}`);
    child.on("exit", (code) => {
      if (this.running.get(key) !== child) return;
      this.running.delete(key);
      this.log(`relay ${hostname} stopped (${code ?? "signal"}); it starts again`);
      setTimeout(() => {
        if (this.wanted.has(key) && !this.running.has(key)) this.start(key, cloudflared, token);
      }, this.restartMs).unref();
    });
  }
}

/** K-2002: the public addresses on this machine's interfaces. A machine behind NAT has none. */
export function publicAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): {
  readonly v4: string | null;
  readonly v6: string | null;
} {
  let v4: string | null = null;
  let v6: string | null = null;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const door = doorAddress(entry.address);
      if ("error" in door) continue;
      if (door.family === 4) v4 ??= entry.address;
      // A temporary (privacy) address changes; the scope id 0 skips link-local, which doorAddress refuses anyway.
      else v6 ??= entry.address;
    }
  }
  return { v4, v6 };
}

/** K-2006: which gated ports listen now, from `ss -H -ltnu` (the local address is the fifth field). */
export function listening(ssOutput: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const line of ssOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const proto = fields[0];
    const local = fields[4] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if ((proto === "tcp" || proto === "udp") && Number.isInteger(port) && port > 0)
      found.add(`${port}/${proto}`);
  }
  return found;
}

/**
 * K-2002: the full path of a system tool, so a root shell whose PATH has no /usr/sbin (`su` without `-`) finds it.
 * Falls back to the bare name, which the PATH resolves.
 */
export function systemTool(
  name: "sudo" | "visudo" | "systemctl" | "ss",
  exists: (path: string) => boolean = existsSync,
): string {
  return ["/usr/sbin", "/usr/bin", "/sbin", "/bin"].map((dir) => `${dir}/${name}`).find(exists) ?? name;
}

/** Why a tool run failed, or null when it exited with 0. A missing tool says so instead of an empty output. */
export function toolProblem(name: string, run: SpawnSyncReturns<string>, failed = "failed"): string | null {
  if (run.status === 0) return null;
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return `${name} was not found`;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  return `${name} ${failed}: ${output || run.error?.message || `exit ${run.status ?? run.signal}`}`;
}

/** Why this machine cannot gate gated ports, or null when it can (K-2002). */
export function doorsProblem(platform: NodeJS.Platform): string | null {
  if (platform !== "linux") return "port cards need a Linux machine with nftables";
  if (!existsSync(HELPER_PATH))
    return `the door helper is not installed; run \`kitshn doors install\` as root`;
  const check = spawnSync(systemTool("sudo"), ["-n", "-l", HELPER_PATH, "apply"], { encoding: "utf8" });
  if ((check.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "sudo was not found";
  if (check.status !== 0) return "the daemon user may not run the door helper (sudoers)";
  const { v4, v6 } = publicAddresses();
  if (v4 === null && v6 === null)
    return "the machine has no public address on an interface (it is behind NAT)";
  return null;
}

/** K-2005: writes the plan into the firewall through the helper, and keeps it, so a restart writes it again. */
export function applyDoors(plan: DoorPlan, keptFile: string, now: number): { ok: boolean; output: string } {
  const run = spawnSync(systemTool("sudo"), ["-n", HELPER_PATH, "apply"], {
    input: helperInput(plan, now),
    encoding: "utf8",
    timeout: 30_000,
  });
  const problem = toolProblem("sudo", run, "could not run the door helper");
  if (problem !== null) return { ok: false, output: problem };
  mkdirSync(dirname(keptFile), { recursive: true });
  writeFileSync(`${keptFile}.new`, JSON.stringify(plan), { mode: 0o600 });
  renameSync(`${keptFile}.new`, keptFile);
  const doors = plan.doors.filter((door) => door.endsAt > now).length;
  return {
    ok: true,
    output: `doors: ${plan.ports.map(portKey).join(" ") || "no gated ports"}; ${doors} open`,
  };
}

/** K-2005: the plan that this daemon wrote last, or null. A reboot empties the table; the daemon writes it again. */
export function keptPlan(keptFile: string): DoorPlan | null {
  let text: string;
  try {
    text = readFileSync(keptFile, "utf8");
  } catch {
    return null;
  }
  try {
    return planOf(JSON.parse(text));
  } catch {
    return null;
  }
}

const isServicePort = (value: unknown): value is ServicePort =>
  typeof value === "object" &&
  value !== null &&
  Number.isInteger((value as ServicePort).port) &&
  ((value as ServicePort).proto === "tcp" || (value as ServicePort).proto === "udp");

/**
 * K-2005: a door plan from JSON, or null when its shape is not this daemon's, such as a plan that an older daemon
 * kept. The daemon then waits for kitshn's plan instead of stopping.
 */
export function planOf(value: unknown): DoorPlan | null {
  if (typeof value !== "object" || value === null) return null;
  const { ports, doors, relays } = value as Record<string, unknown>;
  if (!Array.isArray(ports) || !ports.every(isServicePort) || !Array.isArray(doors)) return null;
  const doorsOk = doors.every(
    (door: unknown) =>
      typeof door === "object" &&
      door !== null &&
      typeof (door as { address?: unknown }).address === "string" &&
      typeof (door as { endsAt?: unknown }).endsAt === "number" &&
      Array.isArray((door as { ports?: unknown }).ports) &&
      (door as { ports: Array<unknown> }).ports.every(isServicePort),
  );
  const relaysOk =
    relays === undefined ||
    (Array.isArray(relays) &&
      relays.every(
        (relay: unknown) =>
          typeof relay === "object" &&
          relay !== null &&
          typeof (relay as { hostname?: unknown }).hostname === "string" &&
          Number.isInteger((relay as { port?: unknown }).port),
      ));
  if (!doorsOk || !relaysOk) return null;
  return { ports, doors, relays: relays ?? [] } as DoorPlan;
}

/**
 * `kitshn doors install|uninstall`, as root: the helper and its one sudoers line for the daemon user. Nothing else
 * changes; the table appears with the first port card.
 */
export function doorsCommand(action: string | undefined, user: string | undefined): void {
  if (process.getuid?.() !== 0) throw new Error("run `kitshn doors install|uninstall` as root");
  if (action === "uninstall") {
    spawnSync("/bin/sh", ["-c", `[ -x ${HELPER_PATH} ] && ${HELPER_PATH} off || true`], { stdio: "inherit" });
    spawnSync(systemTool("systemctl"), ["disable", "kitshn-doors.service"], { stdio: "inherit" });
    rmSync(BOOT_UNIT_PATH, { force: true });
    spawnSync(systemTool("systemctl"), ["daemon-reload"], { stdio: "inherit" });
    rmSync(SUDOERS_PATH, { force: true });
    rmSync(HELPER_PATH, { force: true });
    console.log(
      `kitshn: removed ${HELPER_PATH}, ${SUDOERS_PATH}, ${BOOT_UNIT_PATH}, ${STATE_PATH} and the table inet ${TABLE}.`,
    );
    return;
  }
  if (action !== "install" || !user || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user))
    throw new Error("usage: kitshn doors install --user <daemon user> | kitshn doors uninstall");
  mkdirSync(dirname(HELPER_PATH), { recursive: true, mode: 0o755 });
  writeFileSync(HELPER_PATH, HELPER, { mode: 0o755 });
  chmodSync(HELPER_PATH, 0o755);
  const staged = `${SUDOERS_PATH}.new`;
  writeFileSync(staged, sudoersLine(user), { mode: 0o440 });
  const problem = toolProblem(
    "visudo",
    spawnSync(systemTool("visudo"), ["-cf", staged], { encoding: "utf8" }),
    "refused the sudoers line",
  );
  if (problem !== null) {
    rmSync(staged, { force: true });
    throw new Error(problem);
  }
  renameSync(staged, SUDOERS_PATH);
  writeFileSync(BOOT_UNIT_PATH, BOOT_UNIT, { mode: 0o644 });
  for (const argv of [["daemon-reload"], ["enable", "kitshn-doors.service"]]) {
    const problem = toolProblem(
      "systemctl",
      spawnSync(systemTool("systemctl"), argv, { encoding: "utf8" }),
      `${argv.join(" ")} failed`,
    );
    if (problem !== null) throw new Error(problem);
  }
  console.log(
    `kitshn: installed ${HELPER_PATH}, ${SUDOERS_PATH} for ${user} and ${BOOT_UNIT_PATH}. Restart the daemon to report doors.`,
  );
}
