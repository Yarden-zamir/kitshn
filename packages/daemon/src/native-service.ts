import { posix, win32 } from "node:path";
import type { Platform } from "./service.ts";

/** The already-authorized local user and verified artifact paths; this type does not authorize or start a service. */
export interface NativeServiceDefinition {
  readonly id: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly data: string;
  readonly workingDirectory: string;
  /** The explicitly authorized Windows account; not selected by the recipe. */
  readonly windowsUser?: string;
}

export interface NativeServiceFile {
  readonly name: string;
  readonly content: string;
  /** Windows XML needs UTF-16LE with a BOM; the other service files use UTF-8. */
  readonly encoding: "utf8" | "utf16le-bom";
}

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** Only text that can be represented literally in an XML element or one service-manager field. */
const plainText = (text: string) =>
  [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code >= 32 &&
      !(code >= 127 && code <= 159) &&
      !(code >= 0xd800 && code <= 0xdfff) &&
      (code & 0xfffe) !== 0xfffe
    );
  });

/** systemd expands % specifiers in unit values and $ variables in ExecStart, even inside quotes. */
const systemdQuote = (text: string, command = false) =>
  `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (command ? "$$" : "$"))}"`;

/** Quote one argv item according to the Windows C runtime's backslash-and-quote rules; never use a shell. */
export function windowsArgument(value: string): string {
  let result = '"';
  let slashes = 0;
  for (const char of value) {
    if (char === "\\") {
      slashes++;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    result += "\\".repeat(slashes) + char;
    slashes = 0;
  }
  return result + "\\".repeat(slashes * 2) + '"';
}

/**
 * Render one OS user-service definition. The future deploy path must first verify repo and user allowances, artifact
 * identity and paths, and local ownership; rendering a file is not permission to execute or install it.
 */
export function nativeServiceFile(
  platform: Platform,
  definition: NativeServiceDefinition,
): NativeServiceFile {
  const { id, executable, args, data, workingDirectory } = definition;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error("invalid native service id");
  if (args.length > 32 || args.some((arg) => arg.length > 1024 || !plainText(arg)))
    throw new Error("invalid native service arguments");
  if (
    ![executable, data, workingDirectory].every(
      (path) => path !== "" && path.length <= 4096 && plainText(path),
    )
  )
    throw new Error("invalid native service path");
  const path = platform === "win32" ? win32 : posix;
  if (![executable, data, workingDirectory].every((value) => path.isAbsolute(value)))
    throw new Error("native service paths must be absolute");
  // WorkingDirectory= is a raw path, not an ExecStart-style quoted word. Reject characters whose handling
  // could change the directory until they have been tested against the service manager.
  if (platform === "linux" && (workingDirectory.endsWith(" ") || workingDirectory.includes("\\")))
    throw new Error("the systemd working directory cannot end in a space or contain a backslash");
  if (
    platform === "win32" &&
    (![executable, data, workingDirectory].every((value) => /^[A-Za-z]:\\/.test(value)) ||
      [executable, data, workingDirectory, ...args].some((value) => value.includes("%")) ||
      !/\.exe$/i.test(executable))
  )
    throw new Error(
      "Windows service paths must be local drive paths, contain no environment placeholders, and use an .exe executable",
    );
  const expanded = args.map((arg) => arg.replaceAll("{data}", () => data));
  if (platform === "darwin") {
    const label = `com.kitshn.app.${id}`;
    const argv = [executable, ...expanded].map((arg) => `<string>${xml(arg)}</string>`).join("");
    return {
      name: `${label}.plist`,
      encoding: "utf8",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${argv}</array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`,
    };
  }
  if (platform === "linux") {
    const argv = [executable, ...expanded].map((arg) => systemdQuote(arg, true)).join(" ");
    return {
      name: `kitshn-app-${id}.service`,
      encoding: "utf8",
      content: `[Unit]
Description=kitshn native service ${id}

[Service]
WorkingDirectory=${workingDirectory.replaceAll("%", "%%")}
ExecStart=${argv}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
    };
  }
  const user = definition.windowsUser;
  const parts = user?.split("\\") ?? [];
  const accountPart = (part: string | undefined) =>
    part !== undefined && part !== "" && part === part.trim() && !/[\\/:*?"<>|%]/.test(part);
  if (
    !user ||
    user.length > 256 ||
    !plainText(user) ||
    parts.length !== 2 ||
    !parts.every(accountPart) ||
    /^(nt authority|nt service|builtin|window manager|font driver host)$/i.test(parts[0] ?? "")
  )
    throw new Error("an explicitly authorized DOMAIN\\user Windows account is required");
  const commandLine = expanded.map(windowsArgument).join(" ");
  return {
    name: `\\kitshn\\apps\\${id}`,
    encoding: "utf16le-bom",
    content: `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(`kitshn native service ${id}`)}</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </LogonTrigger>
    <TimeTrigger><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId>
    <LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>
  </Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(executable)}</Command>
    <Arguments>${xml(commandLine)}</Arguments><WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`,
  };
}
