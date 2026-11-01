import { homedir } from "node:os";
import { join, win32 } from "node:path";

export type Platform = "linux" | "darwin" | "win32";

/**
 * K-621: Windows has no user ids. Its pipe admits only the daemon user, SYSTEM and administrators, so every caller
 * there counts as the daemon user, under this id.
 */
export const WINDOWS_UID = -1;
export const ownUid = () => process.getuid?.() ?? WINDOWS_UID;

/** K-622: the daemon's own cloudflared on Windows, by a name that no other cloudflared on the PC has. */
export const WINDOWS_CLOUDFLARED = "kitshn-cloudflared.exe";

/** K-622: the Task Scheduler folder of the two tasks; the system service "Cloudflared" is not a task, so no clash. */
export const WINDOWS_TASKS = { daemon: "\\kitshn\\daemon", tunnel: "\\kitshn\\tunnel" } as const;

export interface Paths {
  /** Holds the machine token and the tunnel token, mode 0600 (K-602). */
  readonly config: string;
  /** cloudflared and the 30-day sample history (K-606). */
  readonly data: string;
  /** The service file of the platform. */
  readonly service: string;
  /** K-603: the service file of the tunnel, a second user service next to the daemon. */
  readonly tunnelService: string;
  /** K-701: the local socket of the daemon. */
  readonly socket: string;
  /** K-701: the socket for the users in `localUsers`, in a folder of the daemon user that others can pass. */
  readonly sharedSocket: string;
}

export function pathsFor(
  platform: Platform,
  env: Record<string, string | undefined>,
  home = homedir(),
  uid = ownUid(),
): Paths {
  if (platform === "win32") {
    // K-623: the user's own local app data; the join gives only the user and SYSTEM access to it.
    const folder = win32.join(env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"), "kitshn");
    return {
      socket: windowsPipe(env),
      // K-624: no shared pipe for other local users in v1.
      sharedSocket: "",
      config: win32.join(folder, "machine.json"),
      data: folder,
      service: win32.join(folder, "task-daemon.xml"),
      tunnelService: win32.join(folder, "task-tunnel.xml"),
    };
  }
  if (platform === "darwin") {
    const support = join(home, "Library", "Application Support", "kitshn");
    return {
      socket: join(support, "kitshn.sock"),
      sharedSocket: sharedSocketOf(uid),
      config: join(support, "machine.json"),
      data: support,
      service: join(home, "Library", "LaunchAgents", "com.kitshn.daemon.plist"),
      tunnelService: join(home, "Library", "LaunchAgents", "com.kitshn.tunnel.plist"),
    };
  }
  const config = env["XDG_CONFIG_HOME"] || join(home, ".config");
  const data = env["XDG_DATA_HOME"] || join(home, ".local", "share");
  // systemd sets XDG_RUNTIME_DIR for a user service; a shell without a login session may not.
  const runtime = env["XDG_RUNTIME_DIR"] || `/run/user/${uid}`;
  return {
    socket: join(runtime, "kitshn", "kitshn.sock"),
    sharedSocket: sharedSocketOf(uid),
    config: join(config, "kitshn", "machine.json"),
    data: join(data, "kitshn"),
    service: join(config, "systemd", "user", "kitshn.service"),
    tunnelService: join(config, "systemd", "user", "kitshn-tunnel.service"),
  };
}

/** K-621: the named pipe of the daemon of this Windows user. */
export const windowsPipe = (env: Record<string, string | undefined>) =>
  `\\\\.\\pipe\\kitshn-${(env["USERNAME"] || "user").toLowerCase().replaceAll("\\", "-")}`;

/**
 * K-622: a PowerShell command that stops the processes of `image` whose full path is one of `paths` (and whose
 * command line ends with ` <lastArgument>`), never by name alone.
 */
function stopByPath(
  image: string,
  paths: ReadonlyArray<string>,
  lastArgument?: string,
): ReadonlyArray<string> {
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const argument = lastArgument ? ` -and $_.CommandLine -match ${quote(`\\s${lastArgument}$`)}` : "";
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-CimInstance Win32_Process -Filter ${quote(`Name="${image}"`)} | Where-Object { @(${paths.map(quote).join(", ")}) -contains $_.ExecutablePath${argument} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ];
}

/**
 * K-622: whether `whoami /groups` shows an elevated token (high or system integrity). Tasks that an elevated
 * window makes carry an access list that the user's normal token cannot use, so the daemon would be denied.
 */
export const windowsElevated = (whoamiGroups: string) =>
  whoamiGroups.includes("S-1-16-12288") || whoamiGroups.includes("S-1-16-16384");

/** K-622: the Windows account of the tasks, as Task Scheduler names it. */
const windowsUser = (env: Record<string, string | undefined>) =>
  env["USERDOMAIN"] ? `${env["USERDOMAIN"]}\\${env["USERNAME"] ?? ""}` : (env["USERNAME"] ?? "");

/**
 * K-622: a Task Scheduler task of the user that starts at logon, with no time limit. `conhost --headless` runs the
 * console program with no window. Task Scheduler does not
 * start an action again after it exits, so a trigger every 5 minutes starts it again; a running one ignores it. The
 * repetition of a logon trigger runs only after the next logon, so a time trigger repeats from the registration on.
 * K-629: a failed run starts again after 1 minute (999 times, the most Task Scheduler allows), so a new daemon that
 * crashes reaches its rollback sooner.
 */
function windowsTask(
  env: Record<string, string | undefined>,
  description: string,
  command: string,
  args: string,
) {
  const user = xml(windowsUser(env));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(description)}</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>conhost.exe</Command><Arguments>${xml(`--headless "${command}" ${args}`)}</Arguments></Exec>
  </Actions>
</Task>
`;
}

/** K-701: the private socket folder sits in a folder that only its user can pass, so the shared one is in /tmp. */
export const sharedSocketOf = (uid: number) => `/tmp/kitshn-${uid}/kitshn.sock`;

/** The owner and the permission bits of a path, from `lstat`; null when it is missing. */
export interface PathFacts {
  readonly uid: number;
  readonly mode: number;
  readonly directory: boolean;
  readonly socket: boolean;
}

/** K-701: the only user whose shared socket the commands find by themselves. */
export const DAEMON_USER = "kitshn";

/**
 * K-701: the socket that the commands use. `KITSHN_LOCAL_SOCKET` wins; else the user's own socket; else the one shared
 * socket in /tmp of the system user `kitshn`, in its own folder with mode 0711, so an allowed local user needs no
 * setting. Another user can make a folder in /tmp under its own uid, so only the user name anchors the trust.
 */
/** K-701: the folders `/tmp/kitshn-<uid>` that hold a socket, with the name of the user that owns each. */
function sharedFolders(
  facts: (path: string) => PathFacts | null,
  tmpEntries: ReadonlyArray<string>,
  userName: (uid: number) => string | null,
) {
  return tmpEntries
    .filter((name) => name.startsWith("kitshn-") && isDigits(name.slice("kitshn-".length)))
    .flatMap((name) => {
      const folder = `/tmp/${name}`;
      const owner = facts(folder);
      if (owner === null || facts(`${folder}/kitshn.sock`) === null) return [];
      return [
        {
          folder,
          uid: Number(name.slice("kitshn-".length)),
          owner: userName(owner.uid) ?? `id ${owner.uid}`,
        },
      ];
    });
}

/** K-701: the shared sockets that kitshn does not use because another user than `kitshn` owns their folder. */
export const otherUsersSockets = (
  facts: (path: string) => PathFacts | null,
  tmpEntries: ReadonlyArray<string>,
  userName: (uid: number) => string | null,
) =>
  sharedFolders(facts, tmpEntries, userName)
    .filter(({ owner }) => owner !== DAEMON_USER)
    .map(({ folder, owner }) => `${folder}/kitshn.sock (user ${owner})`);

export function localSocket(
  env: Record<string, string | undefined>,
  own: Paths,
  facts: (path: string) => PathFacts | null,
  tmpEntries: ReadonlyArray<string>,
  userName: (uid: number) => string | null,
): string | { readonly several: ReadonlyArray<string> } | { readonly refused: string } {
  const given = env["KITSHN_LOCAL_SOCKET"];
  if (given) return given;
  if (facts(own.socket)?.socket) return own.socket;
  // Only folders of the user `kitshn` count, so another user's folder can neither pose as the daemon nor block it.
  const found = sharedFolders(facts, tmpEntries, userName).filter(({ owner }) => owner === DAEMON_USER);
  if (found.length > 1) return { several: found.map(({ folder }) => `${folder}/kitshn.sock`) };
  const [one] = found;
  if (!one) return own.socket;
  const folder = facts(one.folder);
  const socket = facts(`${one.folder}/kitshn.sock`);
  const problem =
    folder === null || !folder.directory
      ? "is not a real folder"
      : folder.uid !== one.uid
        ? `belongs to user id ${folder.uid}, not ${one.uid}`
        : (folder.mode & 0o777) !== 0o711
          ? `has mode ${(folder.mode & 0o777).toString(8)}, not 711`
          : !socket?.socket || socket.uid !== one.uid
            ? "holds a socket of another user"
            : null;
  return problem === null
    ? `${one.folder}/kitshn.sock`
    : {
        refused: `kitshn does not trust ${one.folder}: it ${problem}. Set KITSHN_LOCAL_SOCKET to the socket of your daemon.`,
      };
}

/**
 * K-701: the user id of the daemon that a client expects at the socket: `KITSHN_DAEMON_UID`, else the id in the
 * name of a shared socket folder, else its own. A string is the reason when `KITSHN_DAEMON_UID` is not a user id.
 */
export function expectedDaemonUid(
  env: Record<string, string | undefined>,
  socket: string,
  own: number,
): number | string {
  const given = env["KITSHN_DAEMON_UID"];
  if (given !== undefined && given !== "")
    return isDigits(given) ? Number(given) : `KITSHN_DAEMON_UID=${given} is not a user id.`;
  const shared = socket.startsWith("/tmp/kitshn-")
    ? socket.slice("/tmp/kitshn-".length, -"/kitshn.sock".length)
    : "";
  // The private socket of a Linux daemon: /run/user/<uid>/kitshn/kitshn.sock, which root also uses.
  const runtime = socket.startsWith("/run/user/")
    ? (socket.slice("/run/user/".length).split("/")[0] ?? "")
    : "";
  if (socket.endsWith("/kitshn.sock") && isDigits(shared)) return Number(shared);
  if (isDigits(runtime)) return Number(runtime);
  return own;
}

/** A user id in decimal digits only, as `kitshn local-users` takes it. */
export const isDigits = (text: string) =>
  text !== "" && [...text].every((char) => char >= "0" && char <= "9");

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * K-601: a user service. systemd restarts the daemon after a crash and after `restart` (exit 0); launchd
 * does the same with KeepAlive. A user service needs no root; on Linux it runs without a login only with
 * `loginctl enable-linger`.
 */
export function serviceFile(
  platform: Platform,
  binary: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "win32") return windowsTask(env, "kitshn daemon", binary, "run");
  if (platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kitshn.daemon</string>
  <key>ProgramArguments</key><array><string>${xml(binary)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=kitshn daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${binary}" run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * K-603: the tunnel is its own user service, so a restart or an update of the daemon never stops it. The token
 * stays in a file of the user (`--token-file`), not on the command line.
 */
export function tunnelServiceFile(
  platform: Platform,
  cloudflared: string,
  tokenFile: string,
  env: Record<string, string | undefined> = process.env,
  // K-632: the tunnel's own metrics port, where the daemon reads its data centers, and the edge pin when there is one.
  tunnelArgs: ReadonlyArray<string> = [],
): string {
  // K-622: its own empty config next to the token, so the tunnel never shares a `.cloudflared` config with another
  // cloudflared on the PC.
  if (platform === "win32")
    return windowsTask(
      env,
      "kitshn tunnel (cloudflared)",
      cloudflared,
      `--no-autoupdate --config "${win32.join(win32.dirname(tokenFile), "cloudflared.yml")}" tunnel ${tunnelArgs.join(" ")} run --token-file "${tokenFile}"`,
    );
  if (platform === "darwin") {
    const args = [cloudflared, "--no-autoupdate", "tunnel", ...tunnelArgs, "run", "--token-file", tokenFile];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kitshn.tunnel</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=kitshn tunnel (cloudflared)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${cloudflared}" --no-autoupdate tunnel ${tunnelArgs.join(" ")} run --token-file "${tokenFile}"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** One step of a service command; `mayFail` for a step whose failure means "already so". */
export interface Step {
  readonly argv: ReadonlyArray<string>;
  readonly mayFail: boolean;
}

/**
 * K-603: start (idempotent), restart with a changed service file, stop and read the tunnel service. On macOS a
 * changed plist needs `bootout` and `bootstrap`; `kickstart` would run the old definition.
 */
export function tunnelCommands(
  platform: Platform,
  file: string,
  uid: number,
  env: Record<string, string | undefined> = process.env,
) {
  if (platform === "win32") {
    const name = WINDOWS_TASKS.tunnel;
    const create = { argv: ["schtasks", "/Create", "/TN", name, "/XML", file, "/F"], mayFail: false };
    const run = { argv: ["schtasks", "/Run", "/TN", name], mayFail: false };
    // `/End` ends the task and its conhost but not the program inside, so the process goes too: by its full path,
    // so the tunnel of another user and a system cloudflared stay.
    const end = { argv: ["schtasks", "/End", "/TN", name], mayFail: true };
    const kill = {
      argv: stopByPath(WINDOWS_CLOUDFLARED, [win32.join(win32.dirname(file), WINDOWS_CLOUDFLARED)]),
      mayFail: true,
    };
    return {
      start: [create, { ...run, mayFail: true }],
      restart: [end, kill, create, run],
      stop: [end, kill, { argv: ["schtasks", "/Delete", "/TN", name, "/F"], mayFail: true }],
      // The task state of schtasks is in the language of Windows, so the check looks for the process instead.
      // Only this user's processes count; another user's kitshn tunnel is not this one.
      state: [
        "tasklist",
        "/FI",
        `IMAGENAME eq ${WINDOWS_CLOUDFLARED}`,
        "/FI",
        `USERNAME eq ${windowsUser(env)}`,
        "/FO",
        "CSV",
        "/NH",
      ],
    } satisfies Record<string, ReadonlyArray<Step> | ReadonlyArray<string>>;
  }
  if (platform === "darwin") {
    const bootstrap = { argv: ["launchctl", "bootstrap", `gui/${uid}`, file], mayFail: false };
    const bootout = { argv: ["launchctl", "bootout", `gui/${uid}`, file], mayFail: true };
    return {
      // `bootstrap` fails when the agent is loaded already.
      start: [{ ...bootstrap, mayFail: true }],
      restart: [bootout, bootstrap],
      stop: [bootout],
      state: ["launchctl", "print", `gui/${uid}/com.kitshn.tunnel`],
    } satisfies Record<string, ReadonlyArray<Step> | ReadonlyArray<string>>;
  }
  const reload = { argv: ["systemctl", "--user", "daemon-reload"], mayFail: false };
  return {
    start: [
      reload,
      { argv: ["systemctl", "--user", "enable", "--now", "kitshn-tunnel.service"], mayFail: false },
    ],
    restart: [
      reload,
      { argv: ["systemctl", "--user", "enable", "kitshn-tunnel.service"], mayFail: false },
      { argv: ["systemctl", "--user", "restart", "kitshn-tunnel.service"], mayFail: false },
    ],
    stop: [{ argv: ["systemctl", "--user", "disable", "--now", "kitshn-tunnel.service"], mayFail: true }],
    state: ["systemctl", "--user", "is-active", "kitshn-tunnel.service"],
  } satisfies Record<string, ReadonlyArray<Step> | ReadonlyArray<string>>;
}

/**
 * K-634: the job "tunnel-restart" runs the restart steps of the tunnel service as its file stands, and fails with the
 * steps that failed. A step that may fail means "already so", so it never fails the job.
 */
export function restartTunnel(steps: ReadonlyArray<Step>, runStep: (argv: ReadonlyArray<string>) => boolean) {
  const failed: Array<string> = [];
  for (const step of steps) if (!runStep(step.argv) && !step.mayFail) failed.push(step.argv.join(" "));
  return failed.length === 0
    ? { ok: true, exitCode: 0, output: "the tunnel restarted" }
    : { ok: false, exitCode: 1, output: `the tunnel restart failed: ${failed.join("; ")}` };
}

/** K-605: the tunnel state for the status report, from the output of the state command. */
export function tunnelStateOf(platform: Platform, output: string): "starting" | "running" | "stopped" {
  if (platform === "darwin") return output.includes("state = running") ? "running" : "stopped";
  if (platform === "win32") return output.includes(`"${WINDOWS_CLOUDFLARED}"`) ? "running" : "stopped";
  const state = output.trim();
  if (state === "active") return "running";
  return state === "activating" || state === "reloading" ? "starting" : "stopped";
}

/** The commands that start and stop the service of the platform. */
export function serviceCommands(platform: Platform, file: string, uid: number, binary = process.execPath) {
  if (platform === "win32") {
    const name = WINDOWS_TASKS.daemon;
    return {
      start: [
        ["schtasks", "/Create", "/TN", name, "/XML", file, "/F"],
        ["schtasks", "/Run", "/TN", name],
      ],
      // `/End` leaves the program inside conhost running. The daemon is this binary with `run`; a kitshn command,
      // such as this `service install`, has other arguments and keeps running.
      stop: [
        ["schtasks", "/End", "/TN", name],
        stopByPath(win32.basename(binary), [binary], "run"),
        ["schtasks", "/Delete", "/TN", name, "/F"],
      ],
    };
  }
  if (platform === "darwin") {
    return {
      start: [["launchctl", "bootstrap", `gui/${uid}`, file]],
      stop: [["launchctl", "bootout", `gui/${uid}`, file]],
    };
  }
  return {
    start: [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "kitshn.service"],
    ],
    stop: [
      ["systemctl", "--user", "disable", "--now", "kitshn.service"],
      ["systemctl", "--user", "daemon-reload"],
    ],
  };
}

/** The cloudflared download for this platform (K-603). The daemon never uses another program's copy. */
export function cloudflaredUrl(platform: Platform, arch: string): { url: string; archive: boolean } {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!cpu) throw new Error(`kitshn has no cloudflared for the CPU ${arch}.`);
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (platform === "win32") return { url: `${base}/cloudflared-windows-${cpu}.exe`, archive: false };
  return platform === "darwin"
    ? { url: `${base}/cloudflared-darwin-${cpu}.tgz`, archive: true }
    : { url: `${base}/cloudflared-linux-${cpu}`, archive: false };
}

/** K-617: where kitshn releases live. Each release edge-<version> holds the daemons and SHA256SUMS. */
export const RELEASES = "https://github.com/Yarden-zamir/kitshn/releases/download";

/** The daemon file of a platform in a release. */
export function releaseAsset(platform: Platform, arch: string): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) throw new Error(`kitshn has no daemon for the CPU ${arch}.`);
  // K-620: only x64 on Windows; revisit when a Windows arm64 machine joins.
  if (platform === "win32") {
    if (cpu !== "x64") throw new Error(`kitshn has no Windows daemon for the CPU ${arch}.`);
    return "kitshn-windows-x64.exe";
  }
  return `kitshn-${platform}-${cpu}`;
}

/** The hash that SHA256SUMS (the output of sha256sum) lists for one file, or null. */
export function expectedHash(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === file && hash && /^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  return null;
}

/**
 * K-1714: the one stable answer that marks kitshn 2 for tools that pick a `kitshn` binary. KitSHn 1 has no
 * `version --json`, so its failure or another answer marks it. Fields are only added, never renamed.
 */
export const versionJson = (version: string) => JSON.stringify({ product: "kitshn", generation: 2, version });
