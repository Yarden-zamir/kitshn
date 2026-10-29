// K-2009: game doors on Windows. The daemon (no admin rights) writes the plan file and keeps the router's UPnP
// forwards; a helper that runs as SYSTEM, from a copy that only administrators can change, turns the plan into
// Windows Firewall block rules. IPv4 doors only; IPv6 stays closed on game ports.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { type DoorPlan, type GamePort, doorAddress, portKey } from "@kitshn/edge/game";

const programData = () => process.env["ProgramData"] || "C:\\ProgramData";
const programFiles = () => process.env["ProgramFiles"] || "C:\\Program Files";
/** The plan folder: SYSTEM and Administrators own it; the daemon user may change files in it. */
export const windowsPlanFile = () => win32.join(programData(), "kitshn", "doors", "plan.txt");
/** The helper's own copy of kitshn, which the daemon user cannot change, so SYSTEM never runs the user's file. */
export const windowsHelperPath = () => win32.join(programFiles(), "kitshn", "kitshn-doors.exe");
export const WINDOWS_HELPER_TASK = "\\kitshn\\doors";
const RULE_GROUP = "kitshn doors";

/** The plan as the helper reads it: game ports, and IPv4 doors with their end in seconds since the epoch. */
export function windowsPlanText(plan: DoorPlan, now: number): string {
  const lines = plan.ports.map(({ proto, port }) => `port ${proto} ${port}`);
  for (const door of plan.doors) {
    // IPv4 only in the first version; an IPv6 door opens nothing on Windows.
    if (door.endsAt <= now || door.address.includes(":")) continue;
    const end = Math.floor(door.endsAt / 1000);
    for (const { proto, port } of door.ports) lines.push(`open4 ${door.address} ${proto} ${port} ${end}`);
  }
  return `${lines.join("\n")}\n`;
}

export interface WindowsDoors {
  readonly ports: ReadonlyArray<GamePort>;
  /** Open IPv4 addresses for each port key (`25565/tcp`). */
  readonly open: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Lines that the helper skipped. */
  readonly skipped: number;
}

const isPort = (text: string) => /^\d{4,5}$/.test(text) && Number(text) >= 1024 && Number(text) <= 65535;
const isProto = (text: string): text is GamePort["proto"] => text === "tcp" || text === "udp";

/**
 * The helper's check of the plan file. Each field must be what kitshn writes; a bad line is skipped, so the good
 * game ports still close (fail closed). A door that ended is left out. At most 4000 lines.
 */
export function readWindowsPlan(text: string, nowSeconds: number): WindowsDoors {
  const ports = new Map<string, GamePort>();
  const open = new Map<string, Array<string>>();
  let skipped = 0;
  for (const line of text.split("\n").slice(0, 4000)) {
    if (line.trim() === "") continue;
    const [kind, a = "", b = "", c = "", d = "", ...extra] = line.trim().split(" ");
    if (extra.length > 0) {
      skipped++;
      continue;
    }
    if (kind === "port" && isProto(a) && isPort(b) && c === "") {
      ports.set(`${b}/${a}`, { port: Number(b), proto: a });
      continue;
    }
    const door = doorAddress(a);
    const ok =
      kind === "open4" &&
      !("error" in door) &&
      door.family === 4 &&
      door.address === a &&
      isProto(b) &&
      isPort(c);
    if (ok && /^\d{1,12}$/.test(d)) {
      if (Number(d) > nowSeconds) open.set(`${c}/${b}`, [...(open.get(`${c}/${b}`) ?? []), a]);
      continue;
    }
    skipped++;
  }
  // A door counts only for a game port of the plan.
  for (const key of open.keys()) if (!ports.has(key)) open.delete(key);
  return { ports: [...ports.values()], open, skipped };
}

const v4Number = (address: string) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
const v4Text = (value: number) =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");

/** IPv4 ranges that a door never blocks: private, loopback, link-local and shared (CGNAT, Tailscale) networks. */
const V4_KEPT: ReadonlyArray<readonly [string, string]> = [
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
];

/** The IPv4 ranges that a game port blocks: every address except the open doors and the kept networks. */
export function blockedV4(open: ReadonlyArray<string>): Array<string> {
  const holes = [
    ...V4_KEPT.map(([from, to]) => [v4Number(from), v4Number(to)] as const),
    ...open.map((address) => [v4Number(address), v4Number(address)] as const),
  ].sort((x, y) => x[0] - y[0]);
  const ranges: Array<string> = [];
  let next = 0;
  for (const [from, to] of holes) {
    if (from > next) ranges.push(`${v4Text(next)}-${v4Text(from - 1)}`);
    next = Math.max(next, to + 1);
  }
  if (next <= 0xffffffff) ranges.push(`${v4Text(next)}-255.255.255.255`);
  return ranges;
}

/** Every IPv6 address except unique local (fc00::/7) and link-local (fe80::/10): IPv6 doors are not in v1. */
export const BLOCKED_V6 = [
  "::-fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fe00::-fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "fec0::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
];

export interface FirewallRule {
  readonly name: string;
  readonly port: GamePort;
  readonly remote: ReadonlyArray<string>;
}

/** The block rules of a plan. A rule's name carries a hash of its content, so a changed rule is a new rule. */
export function firewallRules(doors: WindowsDoors): Array<FirewallRule> {
  return doors.ports.flatMap((port) => {
    const key = portKey(port);
    return [
      { family: "v4", remote: blockedV4(doors.open.get(key) ?? []) },
      { family: "v6", remote: BLOCKED_V6 },
    ].map(({ family, remote }) => {
      const hash = createHash("sha256").update(remote.join(",")).digest("hex").slice(0, 8);
      return { name: `kitshn door ${key} ${family} ${hash}`, port, remote };
    });
  });
}

/**
 * The PowerShell that makes the firewall hold exactly these rules: new rules first, then the other rules of the
 * group go, so a change never leaves a game port open. Every value comes from a checked number or address.
 */
export function firewallScript(rules: ReadonlyArray<FirewallRule>): string {
  const names = rules.map((rule) => `'${rule.name}'`).join(", ");
  const create = rules.map(
    (rule) =>
      `if (-not (Get-NetFirewallRule -DisplayName '${rule.name}' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '${rule.name}' -Group '${RULE_GROUP}' -Direction Inbound -Action Block -Profile Any -Protocol ${rule.port.proto.toUpperCase()} -LocalPort ${rule.port.port} -RemoteAddress @(${rule.remote.map((range) => `'${range}'`).join(",")}) | Out-Null }`,
  );
  return [
    "$ErrorActionPreference = 'Stop'",
    ...create,
    `$keep = @(${names})`,
    `Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue | Where-Object { $keep -notcontains $_.DisplayName } | Remove-NetFirewallRule`,
  ].join("\n");
}

const powershell = (script: string, timeout = 60_000) =>
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
    input: script,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });

/**
 * `kitshn doors-helper`, as SYSTEM: applies the plan file at start, when it changes (checked every 2 s), and every
 * 30 s, so a door closes within 30 s of its end also when the daemon does not run. Never returns.
 */
export function runWindowsHelper(log: (line: string) => void): void {
  let applied = "";
  let seen = -1;
  let checkedAt = 0;
  const tick = () => {
    const file = windowsPlanFile();
    const changed = existsSync(file) ? statSync(file).mtimeMs : 0;
    const now = Date.now();
    if (changed === seen && now - checkedAt < 30_000) return;
    seen = changed;
    checkedAt = now;
    const doors = readWindowsPlan(existsSync(file) ? readFileSync(file, "utf8") : "", Math.floor(now / 1000));
    if (doors.skipped > 0) log(`doors: skipped ${doors.skipped} bad lines of ${file}`);
    const rules = firewallRules(doors);
    const signature = rules.map((rule) => rule.name).join("\n");
    if (signature === applied) return;
    const run = powershell(firewallScript(rules));
    if (run.status === 0) applied = signature;
    else log(`doors: the firewall change failed: ${`${run.stderr}`.trim().slice(0, 300)}`);
  };
  tick();
  setInterval(tick, 2_000);
}

/** The router's answer to the UPnP step: its outside IPv4 address, or why UPnP does not work here. */
export type UpnpState = { readonly external: string | null } | { readonly problem: string };

/**
 * K-2009: makes the router's UPnP forwards (`kitshn <port>/<proto>`) the game ports of the plan, to this PC's own
 * address, and reads the router's outside address. Forwards of other programs stay.
 */
export function syncUpnp(ports: ReadonlyArray<GamePort>): UpnpState {
  // `port/PROTO` strings: PowerShell flattens an array that holds one array.
  const wanted = ports.map((port) => `'${port.port}/${port.proto.toUpperCase()}'`).join(", ");
  const run = powershell(`
$ErrorActionPreference = 'Stop'
$local = (Find-NetRoute -RemoteIPAddress 1.1.1.1 | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
$nat = New-Object -ComObject HNetCfg.NATUPnP
$maps = $nat.StaticPortMappingCollection
if ($maps -eq $null) { 'problem: the router offers no UPnP port mapping'; exit 0 }
$wanted = @(${wanted})
$list = @($maps | ForEach-Object { $_ })
foreach ($m in $list) {
  $key = "$($m.ExternalPort)/$($m.Protocol)"
  if ($m.Description -like 'kitshn *' -and $wanted -notcontains $key) { $maps.Remove($m.ExternalPort, $m.Protocol) }
}
foreach ($w in $wanted) {
  $port, $proto = $w.Split('/')
  $found = $list | Where-Object { "$($_.ExternalPort)/$($_.Protocol)" -eq $w } | Select-Object -First 1
  if ($found -and $found.InternalClient -ne $local) { 'problem: another device has the router forward of ' + $w; exit 0 }
  if (-not $found) { $maps.Add([int]$port, $proto, [int]$port, $local, $true, 'kitshn ' + $w.ToLower()) | Out-Null }
}
$first = @($maps | ForEach-Object { $_ }) | Where-Object { $_.Description -like 'kitshn *' } | Select-Object -First 1
'external: ' + $(if ($first) { $first.ExternalIPAddress } else { '' })
`);
  const out = `${run.stdout ?? ""}`.trim().split("\n").at(-1)?.trim() ?? "";
  if (run.status !== 0) return { problem: `UPnP failed: ${`${run.stderr}`.trim().slice(0, 200)}` };
  if (out.startsWith("problem: ")) return { problem: out.slice("problem: ".length) };
  const external = out.startsWith("external: ") ? out.slice("external: ".length) : "";
  return { external: external === "" ? null : external };
}

/** Why this PC cannot hold game doors, or null. `seen` is the outside address that the internet sees. */
export function windowsDoorsProblem(upnp: UpnpState, seen: string | null): string | null {
  if (
    !existsSync(windowsHelperPath()) ||
    spawnSync("schtasks", ["/Query", "/TN", WINDOWS_HELPER_TASK], { windowsHide: true }).status !== 0
  )
    return "the door helper is not installed; run `kitshn doors install` in an administrator PowerShell, once";
  if ("problem" in upnp) return upnp.problem;
  if (seen === null) return "the PC cannot tell its public address";
  const door = doorAddress(seen);
  if ("error" in door || door.family !== 4)
    return `the public address ${seen} is shared (carrier NAT), so no door can open`;
  if (upnp.external !== null && upnp.external !== seen)
    return `the router's outside address ${upnp.external} is not the public address ${seen} (double NAT)`;
  return null;
}

/** The daemon's step: the plan file for the helper, written whole by a rename. */
export function writeWindowsPlan(plan: DoorPlan, now: number): void {
  const file = windowsPlanFile();
  mkdirSync(win32.dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, windowsPlanText(plan, now));
  renameSync(`${file}.new`, file);
}

/** The SYSTEM task of the helper: at start-up, again every 5 minutes if it stopped, with no time limit. */
export function helperTaskXml(helper: string): string {
  const xml = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>kitshn game doors (K-2009)</Description></RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></BootTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(helper)}</Command><Arguments>doors-helper</Arguments></Exec></Actions>
</Task>
`;
}

/**
 * `kitshn doors install|uninstall` on Windows, in an administrator PowerShell (the one UAC prompt): the helper copy,
 * the plan folder (SYSTEM and Administrators own it; this user may write the plan) and the SYSTEM task.
 */
export function windowsDoorsCommand(action: string | undefined, ownSid: string | null): void {
  const helper = windowsHelperPath();
  const folder = win32.dirname(windowsPlanFile());
  const admin = spawnSync("net", ["session"], { windowsHide: true, stdio: "ignore" }).status === 0;
  if (!admin) throw new Error("run `kitshn doors install|uninstall` in an administrator PowerShell");
  const run = (program: string, args: ReadonlyArray<string>, input?: string | Buffer) => {
    const step = spawnSync(program, [...args], { input, encoding: "utf8", windowsHide: true });
    if (step.status !== 0)
      throw new Error(`${program} ${args.join(" ")} failed: ${step.stdout}${step.stderr}`);
  };
  if (action === "uninstall") {
    spawnSync("schtasks", ["/End", "/TN", WINDOWS_HELPER_TASK], { windowsHide: true });
    spawnSync("schtasks", ["/Delete", "/TN", WINDOWS_HELPER_TASK, "/F"], { windowsHide: true });
    powershell(
      `Get-CimInstance Win32_Process -Filter 'Name="kitshn-doors.exe"' | Where-Object { $_.ExecutablePath -eq '${helper.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    );
    console.log(
      `kitshn: removed the task ${WINDOWS_HELPER_TASK} and the firewall rules; ${helper} and ${folder} stay.`,
    );
    return;
  }
  if (action !== "install") throw new Error("usage: kitshn doors install | kitshn doors uninstall");
  if (ownSid === null) throw new Error("kitshn cannot read the SID of this Windows account");
  mkdirSync(win32.dirname(helper), { recursive: true });
  writeFileSync(helper, readFileSync(process.execPath));
  mkdirSync(folder, { recursive: true });
  run("icacls", [
    folder,
    "/inheritance:r",
    "/grant:r",
    "*S-1-5-18:(OI)(CI)F",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
    "/grant:r",
    `*${ownSid}:(OI)(CI)M`,
  ]);
  const xmlFile = win32.join(folder, "task.xml");
  writeFileSync(xmlFile, Buffer.from(`\ufeff${helperTaskXml(helper)}`, "utf16le"));
  run("schtasks", ["/Create", "/TN", WINDOWS_HELPER_TASK, "/XML", xmlFile, "/F"]);
  run("schtasks", ["/Run", "/TN", WINDOWS_HELPER_TASK]);
  console.log(
    `kitshn: installed ${helper} and the SYSTEM task ${WINDOWS_HELPER_TASK}. The daemon reports doors within a minute.`,
  );
}

/** K-2006: listening ports from `netstat -an` on Windows: `TCP  0.0.0.0:25565  0.0.0.0:0  LISTENING`, `UDP  [::]:19132  *:*`. */
export function netstatListening(output: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    const [proto = "", local = "", , state = ""] = line.trim().split(/\s+/);
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    if (proto === "TCP" && state === "LISTENING") found.add(`${port}/tcp`);
    if (proto === "UDP") found.add(`${port}/udp`);
  }
  return found;
}
