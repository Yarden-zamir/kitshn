// K-2009: game doors on Windows. The daemon (no admin rights) writes the plan file and keeps the router's UPnP
// forwards; a helper that runs as SYSTEM, from a copy that only administrators can change, turns the plan into
// Windows Firewall block rules. IPv4 doors only; IPv6 stays closed on game ports.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { win32 } from "node:path";
import { type DoorPlan, type GamePort, doorAddress, portKey } from "@kitshn/edge/game";

const programData = () => process.env["ProgramData"] || "C:\\ProgramData";
const programFiles = () => process.env["ProgramFiles"] || "C:\\Program Files";
/** The plan folder: SYSTEM and Administrators own it; the daemon user may change files in it. */
export const windowsPlanFile = () => win32.join(programData(), "kitshn", "doors", "plan.txt");
/** The helper's own copy of kitshn, which the daemon user cannot change, so SYSTEM never runs the user's file. */
export const windowsHelperPath = () => win32.join(programFiles(), "kitshn", "kitshn-doors.exe");
/** The helper's last run. It sits beside the helper copy, so only SYSTEM and administrators write it. */
export const windowsHelperStatusFile = () => win32.join(programFiles(), "kitshn", "doors-status.txt");
export const WINDOWS_HELPER_TASK = "\\kitshn\\doors";
const RULE_GROUP = "kitshn doors";
/** The plan format. A helper that reads another format keeps its rules, and the daemon asks for a new install. */
export const WINDOWS_PLAN_FORMAT = 1;
const PLAN_HEADER = `kitshn-plan ${WINDOWS_PLAN_FORMAT}`;
/** The helper applies the plan at least this often; a status older than twice that means that it does not run. */
const HELPER_RUN_SECONDS = 30;

/** The plan as the helper reads it: the format, game ports, and IPv4 doors with their end in seconds since the epoch. */
export function windowsPlanText(plan: DoorPlan, now: number): string {
  const lines = [PLAN_HEADER, ...plan.ports.map(({ proto, port }) => `port ${proto} ${port}`)];
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
 * game ports still close (fail closed). A door that ended is left out. At most 4000 lines. Null for a plan of
 * another format, or one whose every line is bad: the helper then keeps the rules that it has.
 */
export function readWindowsPlan(text: string, nowSeconds: number): WindowsDoors | null {
  const [header, ...lines] = text.split("\n");
  if (header?.trim() !== PLAN_HEADER) return null;
  const ports = new Map<string, GamePort>();
  const open = new Map<string, Array<string>>();
  let skipped = 0;
  for (const line of lines.slice(0, 4000)) {
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
  if (skipped > 0 && ports.size === 0) return null;
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
 * group go, so a change never leaves a game port open. A rule that someone turned off or changed to allow counts as
 * missing, so it comes back. Every value comes from a checked number or address.
 */
export function firewallScript(rules: ReadonlyArray<FirewallRule>): string {
  const names = rules.map((rule) => `'${rule.name}'`).join(", ");
  const create = rules.map(
    (rule) =>
      `if ($good -notcontains '${rule.name}') { New-NetFirewallRule -DisplayName '${rule.name}' -Group '${RULE_GROUP}' -Direction Inbound -Action Block -Profile Any -Protocol ${rule.port.proto.toUpperCase()} -LocalPort ${rule.port.port} -RemoteAddress @(${rule.remote.map((range) => `'${range}'`).join(",")}) | Out-Null }`,
  );
  return [
    "$ErrorActionPreference = 'Stop'",
    `$all = @(Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue)`,
    `$working = @($all | Where-Object { ${WORKING_RULE} })`,
    "$good = @($working | ForEach-Object { $_.DisplayName })",
    ...create,
    `$keep = @(${names})`,
    "$workingIds = @($working | ForEach-Object { $_.Name })",
    // -Name with one ID each: Remove-NetFirewallRule with no filter removes every rule of the PC.
    "foreach ($rule in $all) { if ($keep -notcontains $rule.DisplayName -or $workingIds -notcontains $rule.Name) { Remove-NetFirewallRule -Name $rule.Name } }",
    "exit 0",
  ].join("\n");
}

/** A rule of the group that blocks: on, inbound and block. */
const WORKING_RULE = "$_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block'";

/**
 * `-Command -` runs stdin line by line and goes on after an error, so a failed new rule would still let the old
 * rules go. One script block stops at the first error, and PowerShell then exits 1 (tested on Windows 11).
 */
const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
];

const powershell = (script: string, timeout = 60_000) =>
  spawnSync("powershell.exe", POWERSHELL_ARGS, {
    input: script,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });

/** PowerShell for the daemon, which must not wait: UPnP discovery alone takes about 9 seconds. */
function powershellAsync(
  script: string,
  timeout = 90_000,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", POWERSHELL_ARGS, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: String(error) });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

/** The helper's status: the plan format that it reads, when it last ran, and its last error. */
export function helperStatusText(nowSeconds: number, error: string | null): string {
  const lines = [`format ${WINDOWS_PLAN_FORMAT}`, `checked ${nowSeconds}`];
  if (error !== null) lines.push(`error ${error.replaceAll("\n", " ").slice(0, 300)}`);
  return `${lines.join("\n")}\n`;
}

/** The daemon's check of the helper's status file (null when it is missing): why doors cannot work, or null. */
export function helperProblem(status: string | null, nowSeconds: number): string | null {
  if (status === null)
    return "the door helper is not installed; run `kitshn doors install` in an administrator PowerShell, once";
  const fields = new Map(
    status
      .split("\n")
      .filter((line) => line.includes(" "))
      .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1).trim()] as const),
  );
  if (fields.get("format") !== String(WINDOWS_PLAN_FORMAT))
    return "the door helper is from another release; run `kitshn doors install` again in an administrator PowerShell";
  const checked = Number(fields.get("checked"));
  if (!Number.isFinite(checked) || nowSeconds - checked > 2 * HELPER_RUN_SECONDS + 30)
    return "the door helper does not run; start the task \\kitshn\\doors or run `kitshn doors install` again";
  const error = fields.get("error");
  return error === undefined ? null : `the door helper failed: ${error}`;
}

/**
 * `kitshn doors-helper`, as SYSTEM: applies the plan file at start, when it changes (checked every 2 s), and every
 * 30 s, so a door closes within 30 s of its end, also when the daemon does not run, and a deleted or changed rule
 * comes back. A missing plan or a plan of another format keeps the rules that exist. Never returns.
 */
export function runWindowsHelper(log: (line: string) => void): void {
  let seen = "";
  let checkedAt = 0;
  const status = (error: string | null) => {
    const file = windowsHelperStatusFile();
    writeFileSync(`${file}.new`, helperStatusText(Math.floor(Date.now() / 1000), error));
    renameSync(`${file}.new`, file);
  };
  const apply = (): string | null => {
    const file = windowsPlanFile();
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const doors = readWindowsPlan(text, Math.floor(Date.now() / 1000));
    if (doors === null) return `the plan file is not in format ${WINDOWS_PLAN_FORMAT}; the rules stay`;
    if (doors.skipped > 0) log(`doors: skipped ${doors.skipped} bad lines of ${file}`);
    const run = powershell(firewallScript(firewallRules(doors)));
    return run.status === 0 ? null : `the firewall change failed: ${`${run.stderr}`.trim()}`;
  };
  const tick = () => {
    try {
      const file = windowsPlanFile();
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      const now = Date.now();
      if (text === seen && now - checkedAt < HELPER_RUN_SECONDS * 1000) return;
      seen = text;
      checkedAt = now;
      const error = apply();
      if (error !== null) log(`doors: ${error}`);
      status(error);
    } catch (error) {
      log(`doors: ${String(error)}`);
      try {
        status(String(error));
      } catch {
        // The next tick tries again; the daemon sees an old status and reports that the helper does not run.
      }
    }
  };
  tick();
  setInterval(tick, 2_000);
}

/** The keys (`25565/tcp`) of the game ports whose IPv4 and IPv6 block rules are on, from the rules' names. */
export function blockedPorts(ruleNames: ReadonlyArray<string>): ReadonlySet<string> {
  const families = new Map<string, Set<string>>();
  for (const name of ruleNames) {
    const [kitshn, door, key = "", family = ""] = name.split(" ");
    if (kitshn !== "kitshn" || door !== "door") continue;
    families.set(key, (families.get(key) ?? new Set()).add(family));
  }
  return new Set([...families].filter(([, found]) => found.has("v4") && found.has("v6")).map(([key]) => key));
}

/**
 * K-2009: the ports that the router may forward to this PC: a gated port only while its block rules are on, so a
 * forward never opens a port that no rule gates, and the ports of games open to all.
 */
export function forwardPorts(plan: DoorPlan, blocked: ReadonlySet<string>): Array<GamePort> {
  return [...plan.ports.filter((port) => blocked.has(portKey(port))), ...plan.openPorts];
}

/** The names of the working block rules of the group. The daemon user may read them. */
export async function readBlockRules(): Promise<Array<string> | { problem: string }> {
  const run = await powershellAsync(
    // An empty group is not an error; `exit 0`, because an empty group sets the exit code to 1.
    `@(Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue) | Where-Object { ${WORKING_RULE} } | ForEach-Object { $_.DisplayName }\nexit 0`,
    30_000,
  );
  if (run.status !== 0)
    return { problem: `the firewall rules are not readable: ${run.stderr.trim().slice(0, 200)}` };
  return run.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The router's answer to the UPnP step: its outside IPv4 address, or why UPnP does not work here. */
export type UpnpState =
  | { readonly external: string }
  /** `noUpnp`: the router has no UPnP, so it holds no forward of this PC. */
  | { readonly problem: string; readonly noUpnp: boolean };

/** This PC's name in the description of its forwards, so two kitshn PCs behind one router keep their own. */
export const forwardLabel = (name = hostname()) =>
  [...name.toLowerCase()]
    .filter((char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-")
    .join("") || "pc";

/**
 * K-2009: makes this PC's router forwards (`kitshn <PC> <port>/<proto>`) the given ports, to this PC's own address,
 * and reads the router's outside address. A forward of this PC to an old address of the PC is made again. Forwards
 * of other programs and other PCs stay; a port that another device holds is a problem.
 */
export async function syncUpnp(ports: ReadonlyArray<GamePort>): Promise<UpnpState> {
  const run = await powershellAsync(upnpScript(ports, forwardLabel()));
  const out = run.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (run.status !== 0) return { problem: `UPnP failed: ${run.stderr.trim().slice(0, 200)}`, noUpnp: false };
  if (out.startsWith("no upnp: ")) return { problem: out.slice("no upnp: ".length), noUpnp: true };
  if (out.startsWith("problem: ")) return { problem: out.slice("problem: ".length), noUpnp: false };
  if (!out.startsWith("external: ")) return { problem: "the router gave no answer to UPnP", noUpnp: false };
  return { external: out.slice("external: ".length) };
}

/** The PowerShell of `syncUpnp`. `label` holds only `a-z`, `0-9` and `-`. */
export function upnpScript(ports: ReadonlyArray<GamePort>, label: string): string {
  // `port/PROTO` strings: PowerShell flattens an array that holds one array.
  const wanted = ports.map((port) => `'${port.port}/${port.proto.toUpperCase()}'`).join(", ");
  return `
$ErrorActionPreference = 'Stop'
$me = 'kitshn ${label} '
$wanted = @(${wanted})
$local = (Find-NetRoute -RemoteIPAddress 1.1.1.1 | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
$finder = New-Object -ComObject UPnP.UPnPDeviceFinder
$wan = @($finder.FindByType('urn:schemas-upnp-org:device:InternetGatewayDevice:1', 0) | ForEach-Object { $_.Children } | ForEach-Object { $_.Children } | ForEach-Object { $_.Services } | Where-Object { $_.ServiceTypeIdentifier -like '*:WANIPConnection:*' -or $_.ServiceTypeIdentifier -like '*:WANPPPConnection:*' }) | Select-Object -First 1
if ($wan -eq $null) { 'no upnp: the router offers no UPnP'; exit 0 }
$answer = $null
[void]$wan.InvokeAction('GetExternalIPAddress', @(), [ref]$answer)
$maps = (New-Object -ComObject HNetCfg.NATUPnP).StaticPortMappingCollection
if ($maps -eq $null) { 'no upnp: the router offers no UPnP port mapping'; exit 0 }
foreach ($m in @($maps | ForEach-Object { $_ })) {
  $key = "$($m.ExternalPort)/$($m.Protocol)"
  if ($m.Description -like "$me*" -and ($wanted -notcontains $key -or $m.InternalClient -ne $local)) { $maps.Remove($m.ExternalPort, $m.Protocol) }
}
$list = @($maps | ForEach-Object { $_ })
foreach ($w in $wanted) {
  $port, $proto = $w.Split('/')
  $found = $list | Where-Object { "$($_.ExternalPort)/$($_.Protocol)" -eq $w } | Select-Object -First 1
  if ($found -and $found.InternalClient -ne $local) { 'problem: another device has the router forward of ' + $w.ToLower(); exit 0 }
  if (-not $found) { $maps.Add([int]$port, $proto, [int]$port, $local, $true, $me + $w.ToLower()) | Out-Null }
}
'external: ' + [string]$answer[0]
`;
}

const inV4 = (address: string, [from, to]: readonly [string, string]) =>
  v4Number(from) <= v4Number(address) && v4Number(address) <= v4Number(to);

/**
 * Why the router cannot carry game doors, or null. `external` is the router's outside address from UPnP, and `seen`
 * is the address that the internet sees.
 */
export function natProblem(external: string, seen: string | null): string | null {
  if (external === "") return "the router does not tell its outside address";
  const door = doorAddress(external);
  if (inV4(external, ["100.64.0.0", "100.127.255.255"]))
    return `the router's outside address ${external} is shared (carrier NAT), so no door can open`;
  if ("error" in door || door.family !== 4 || door.address !== external)
    return `the router's outside address ${external} is not public (double NAT)`;
  if (seen === null) return "the PC cannot tell its public address";
  if (external !== seen)
    return `the router's outside address ${external} is not the public address ${seen} (double NAT)`;
  return null;
}

/** The daemon's step: the plan file for the helper, written whole by a rename. */
export function writeWindowsPlan(plan: DoorPlan, now: number): void {
  const file = windowsPlanFile();
  mkdirSync(win32.dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, windowsPlanText(plan, now));
  renameSync(`${file}.new`, file);
}

/** The helper's status file, or null when it is missing. */
export function readHelperStatus(): string | null {
  try {
    return readFileSync(windowsHelperStatusFile(), "utf8");
  } catch {
    return null;
  }
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
 * the plan folder (SYSTEM and Administrators own it; this user may write the plan) and the SYSTEM task. Install
 * again to update the helper; it stops the old helper first, because Windows cannot replace a running program.
 */
export async function windowsDoorsCommand(action: string | undefined, ownSid: string | null): Promise<void> {
  const helper = windowsHelperPath();
  const folder = win32.dirname(windowsPlanFile());
  const admin = spawnSync("net", ["session"], { windowsHide: true, stdio: "ignore" }).status === 0;
  if (!admin) throw new Error("run `kitshn doors install|uninstall` in an administrator PowerShell");
  const run = (program: string, args: ReadonlyArray<string>) => {
    const step = spawnSync(program, [...args], { encoding: "utf8", windowsHide: true });
    if (step.status !== 0)
      throw new Error(`${program} ${args.join(" ")} failed: ${step.stdout}${step.stderr}`);
  };
  const stopHelper = () => {
    spawnSync("schtasks", ["/End", "/TN", WINDOWS_HELPER_TASK], { windowsHide: true });
    powershell(
      `Get-CimInstance Win32_Process -Filter 'Name="kitshn-doors.exe"' | Where-Object { $_.ExecutablePath -eq '${helper.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }`,
    );
  };
  if (action === "uninstall") {
    stopHelper();
    spawnSync("schtasks", ["/Delete", "/TN", WINDOWS_HELPER_TASK, "/F"], { windowsHide: true });
    // The forwards go first, so no forward stays without its block rule.
    const upnp = await syncUpnp([]);
    if ("problem" in upnp && !upnp.noUpnp)
      throw new Error(
        `the router forwards could not be removed (${upnp.problem}), so the firewall rules stay; run it again`,
      );
    const rules = powershell(
      `foreach ($rule in @(Get-NetFirewallRule -Group '${RULE_GROUP}' -ErrorAction SilentlyContinue)) { Remove-NetFirewallRule -Name $rule.Name }\nexit 0`,
    );
    if (rules.status !== 0) throw new Error(`the firewall rules could not be removed: ${rules.stderr}`);
    rmSync(windowsHelperStatusFile(), { force: true });
    console.log(
      `kitshn: removed the task ${WINDOWS_HELPER_TASK}, the router forwards and the firewall rules; ${helper} and ${folder} stay.`,
    );
    return;
  }
  if (action !== "install") throw new Error("usage: kitshn doors install | kitshn doors uninstall");
  if (ownSid === null) throw new Error("kitshn cannot read the SID of this Windows account");
  mkdirSync(win32.dirname(helper), { recursive: true });
  stopHelper();
  writeFileSync(`${helper}.new`, readFileSync(process.execPath));
  renameSync(`${helper}.new`, helper);
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
  // Beside the helper copy, where the user cannot write, so no program of the user changes the task before it exists.
  const xmlFile = win32.join(win32.dirname(helper), "doors-task.xml");
  writeFileSync(xmlFile, Buffer.from(`\ufeff${helperTaskXml(helper)}`, "utf16le"));
  try {
    run("schtasks", ["/Create", "/TN", WINDOWS_HELPER_TASK, "/XML", xmlFile, "/F"]);
  } finally {
    rmSync(xmlFile, { force: true });
  }
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
