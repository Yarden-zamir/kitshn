import { describe, expect, it } from "vitest";
import {
  cloudflaredUrl,
  expectedDaemonUid,
  expectedHash,
  localSocket,
  otherUsersSockets,
  type Platform,
  pathsFor,
  releaseAsset,
  restartTunnel,
  serviceCommands,
  serviceFile,
  windowsElevated,
  tunnelCommands,
  tunnelServiceFile,
  tunnelStateOf,
  versionJson,
} from "./service.ts";

describe("daemon service (K-601)", () => {
  it("keeps the tokens in the user's config folder", () => {
    expect(pathsFor("linux", {}, "/home/u").config).toBe("/home/u/.config/kitshn/machine.json");
    expect(pathsFor("linux", { XDG_CONFIG_HOME: "/x" }, "/home/u").service).toBe(
      "/x/systemd/user/kitshn.service",
    );
    expect(pathsFor("darwin", {}, "/Users/u").service).toBe(
      "/Users/u/Library/LaunchAgents/com.kitshn.daemon.plist",
    );
    expect(pathsFor("linux", { XDG_RUNTIME_DIR: "/x" }, "/home/u", 7).socket).toBe("/x/kitshn/kitshn.sock");
    expect(pathsFor("linux", {}, "/home/u", 7).socket).toBe("/run/user/7/kitshn/kitshn.sock");
    expect(pathsFor("darwin", {}, "/Users/u").socket).toBe(
      "/Users/u/Library/Application Support/kitshn/kitshn.sock",
    );
    // K-621, K-623: a pipe per user, and the user's local app data.
    const windows = pathsFor(
      "win32",
      { LOCALAPPDATA: "C:\\Users\\Ya\\AppData\\Local", USERNAME: "Ya" },
      "C:\\Users\\Ya",
    );
    expect(windows.config).toBe("C:\\Users\\Ya\\AppData\\Local\\kitshn\\machine.json");
    expect(windows.socket).toBe("\\\\.\\pipe\\kitshn-ya");
    expect(windows.sharedSocket).toBe("");
  });

  it("refuses an elevated Windows window, whose tasks the user could not start (K-622)", () => {
    expect(windowsElevated("Mandatory Label\\High Mandatory Level   Label   S-1-16-12288")).toBe(true);
    expect(windowsElevated("Mandatory Label\\Medium Mandatory Level Label   S-1-16-8192")).toBe(false);
  });

  it("restarts the daemon after every exit", () => {
    expect(serviceFile("linux", "/home/u/.local/bin/kitshn")).toContain(
      'ExecStart="/home/u/.local/bin/kitshn" run',
    );
    expect(serviceFile("linux", "/b")).toContain("Restart=always");
    expect(serviceFile("darwin", "/a&b")).toContain("<string>/a&amp;b</string>");
    // K-622: a task of the user at logon, started again every 5 minutes, with no window.
    const task = serviceFile("win32", "C:\\k\\kitshn.exe", { USERDOMAIN: "PC", USERNAME: "ya" });
    expect(task).toContain("<UserId>PC\\ya</UserId>");
    expect(task).toContain("<Interval>PT5M</Interval>");
    expect(task).toContain(
      "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>",
    );
    // The repetition of a logon trigger starts only at the next logon; the time trigger repeats from now on.
    expect(task).toMatch(
      /<TimeTrigger>\s*<StartBoundary>[^<]+<\/StartBoundary>\s*<Enabled>true<\/Enabled>\s*<Repetition><Interval>PT5M</,
    );
    expect(task).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(task).toContain(
      "<Command>conhost.exe</Command><Arguments>--headless &quot;C:\\k\\kitshn.exe&quot; run</Arguments>",
    );
    expect(serviceCommands("win32", "C:\\t.xml", -1).start[0]).toEqual([
      "schtasks",
      "/Create",
      "/TN",
      "\\kitshn\\daemon",
      "/XML",
      "C:\\t.xml",
      "/F",
    ]);
    expect(serviceCommands("linux", "/f", 1000).start.at(-1)).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "kitshn.service",
    ]);
  });

  it("runs the tunnel as its own service, with the token in a file (K-603)", () => {
    expect(pathsFor("linux", {}, "/home/u").tunnelService).toBe(
      "/home/u/.config/systemd/user/kitshn-tunnel.service",
    );
    const unit = tunnelServiceFile("linux", "/d/cloudflared", "/d/tunnel-token");
    expect(unit).toContain('--token-file "/d/tunnel-token"');
    expect(unit).toContain("Restart=always");
    expect(tunnelServiceFile("darwin", "/d/cloudflared", "/d/t")).toContain(
      "<string>--token-file</string><string>/d/t</string>",
    );
    // K-622: its own task, config and a free metrics port, so it never clashes with another cloudflared.
    const task = tunnelServiceFile(
      "win32",
      "C:\\k\\cloudflared.exe",
      "C:\\k\\tunnel-token",
      { USERNAME: "ya" },
      ["--metrics", "127.0.0.1:49152"],
    );
    expect(task).toContain("--config &quot;C:\\k\\cloudflared.yml&quot;");
    expect(task).toContain("tunnel --metrics 127.0.0.1:49152 run");
    expect(task).toContain("--token-file &quot;C:\\k\\tunnel-token&quot;");
    expect(tunnelCommands("win32", "C:\\t.xml", -1).start[0]?.argv).toContain("\\kitshn\\tunnel");
  });

  it("restarts the tunnel service on each platform, and fails with the steps that failed (K-634)", () => {
    const ran = (platform: Platform, failing: string | null = null) => {
      const argvs: Array<string> = [];
      const outcome = restartTunnel(tunnelCommands(platform, "/t/tunnel", 501).restart, (argv) => {
        argvs.push(argv.join(" "));
        return argv[1] !== failing;
      });
      return { argvs, outcome };
    };
    expect(ran("darwin").argvs).toEqual([
      "launchctl bootout gui/501 /t/tunnel",
      "launchctl bootstrap gui/501 /t/tunnel",
    ]);
    expect(ran("linux").argvs).toContain("systemctl --user restart kitshn-tunnel.service");
    expect(ran("win32").argvs).toEqual([
      "schtasks /End /TN \\kitshn\\tunnel",
      expect.stringContaining("kitshn-cloudflared.exe"),
      "schtasks /Create /TN \\kitshn\\tunnel /XML /t/tunnel /F",
      "schtasks /Run /TN \\kitshn\\tunnel",
    ]);
    expect(ran("linux").outcome).toEqual({ ok: true, exitCode: 0, output: "the tunnel restarted" });
    // `bootout` of an agent that is not loaded fails, and means "already so".
    expect(ran("darwin", "bootout").outcome.ok).toBe(true);
    expect(ran("darwin", "bootstrap").outcome).toMatchObject({
      ok: false,
      output: expect.stringContaining("bootstrap"),
    });
  });

  it("reads the tunnel state from its service manager (K-605)", () => {
    expect(tunnelStateOf("linux", "active\n")).toBe("running");
    expect(tunnelStateOf("linux", "activating\n")).toBe("starting");
    expect(tunnelStateOf("linux", "failed\n")).toBe("stopped");
    expect(tunnelStateOf("darwin", "com.kitshn.tunnel = {\n\tstate = running\n")).toBe("running");
    expect(tunnelStateOf("darwin", "")).toBe("stopped");
    expect(tunnelStateOf("win32", '"kitshn-cloudflared.exe","4242","Console","1","30,000 K"\r\n')).toBe(
      "running",
    );
    expect(tunnelStateOf("win32", "INFO: No tasks are running which match the specified criteria.\r\n")).toBe(
      "stopped",
    );
  });

  it("downloads the cloudflared of the platform", () => {
    expect(cloudflaredUrl("linux", "arm64").url).toMatch(/cloudflared-linux-arm64$/);
    expect(cloudflaredUrl("darwin", "x64")).toMatchObject({ archive: true });
    expect(() => cloudflaredUrl("linux", "ia32")).toThrow();
    expect(cloudflaredUrl("win32", "x64").url).toMatch(/cloudflared-windows-amd64\.exe$/);
  });

  it("finds the daemon of a release and its hash in SHA256SUMS (K-617)", () => {
    expect(releaseAsset("linux", "arm64")).toBe("kitshn-linux-arm64");
    expect(() => releaseAsset("linux", "ia32")).toThrow();
    expect(releaseAsset("win32", "x64")).toBe("kitshn-windows-x64.exe");
    expect(() => releaseAsset("win32", "arm64")).toThrow();
    const sums = `${"a".repeat(64)}  kitshn-linux-arm64\n${"b".repeat(64)} *kitshn.mjs\n`;
    expect(expectedHash(sums, "kitshn-linux-arm64")).toBe("a".repeat(64));
    expect(expectedHash(sums, "kitshn.mjs")).toBe("b".repeat(64));
    expect(expectedHash(sums, "kitshn-linux-x64")).toBeNull();
  });

  it("names the shared socket and the daemon user that a client expects there (K-701)", () => {
    expect(pathsFor("linux", {}, "/home/u", 7).sharedSocket).toBe("/tmp/kitshn-7/kitshn.sock");
    expect(expectedDaemonUid({}, "/tmp/kitshn-1000/kitshn.sock", 1001)).toBe(1000);
    // Root reaches the private socket of the daemon user 7 and expects 7 there.
    expect(expectedDaemonUid({}, "/run/user/7/kitshn/kitshn.sock", 0)).toBe(7);
    expect(expectedDaemonUid({ KITSHN_DAEMON_UID: "1000" }, "/srv/k.sock", 1001)).toBe(1000);
    expect(expectedDaemonUid({ KITSHN_DAEMON_UID: "kitshn" }, "/srv/k.sock", 1001)).toMatch(/not a user id/);
    expect(expectedDaemonUid({ KITSHN_DAEMON_UID: "1e3" }, "/srv/k.sock", 1001)).toMatch(/not a user id/);
    expect(expectedDaemonUid({}, "/tmp/kitshn-x/kitshn.sock", 5)).toBe(5);
  });

  it("finds the socket with no setting: its own, else the one shared socket of the user kitshn (K-701)", () => {
    const root = pathsFor("linux", {}, "/root", 0);
    const folder = { uid: 1000, mode: 0o40711, directory: true, socket: false };
    const sock = { uid: 1000, mode: 0o140666, directory: false, socket: true };
    const at =
      (entries: Record<string, { uid: number; mode: number; directory: boolean; socket: boolean }>) =>
      (path: string) =>
        entries[path] ?? null;
    const named = (uid: number) => (uid === 1000 ? "kitshn" : uid === 1001 ? "mallory" : null);
    const daemon = { "/tmp/kitshn-1000": folder, "/tmp/kitshn-1000/kitshn.sock": sock };
    const tmp = ["kitshn-1000", "kitshn-x", "other"];
    expect(localSocket({ KITSHN_LOCAL_SOCKET: "/srv/k.sock" }, root, at({}), tmp, named)).toBe("/srv/k.sock");
    expect(localSocket({}, root, at({ ...daemon, [root.socket]: sock }), tmp, named)).toBe(root.socket);
    expect(localSocket({}, root, at(daemon), tmp, named)).toBe("/tmp/kitshn-1000/kitshn.sock");
    expect(localSocket({}, root, at({}), tmp, named)).toBe(root.socket);
    // The folder of another user, also with the right modes, is not the daemon's.
    const mallory = {
      "/tmp/kitshn-1001": { ...folder, uid: 1001 },
      "/tmp/kitshn-1001/kitshn.sock": { ...sock, uid: 1001 },
    };
    expect(localSocket({}, root, at(mallory), ["kitshn-1001"], named)).toBe(root.socket);
    // So "not running" names it, instead of only the caller's own socket.
    expect(otherUsersSockets(at({ ...daemon, ...mallory }), [...tmp, "kitshn-1001"], named)).toEqual([
      "/tmp/kitshn-1001/kitshn.sock (user mallory)",
    ]);
    // Another user's fake socket next to the daemon's neither counts nor blocks the daemon's.
    expect(localSocket({}, root, at({ ...daemon, ...mallory }), [...tmp, "kitshn-1001"], named)).toBe(
      "/tmp/kitshn-1000/kitshn.sock",
    );
    // A folder of kitshn that names another uid than its owner.
    const renamed = { "/tmp/kitshn-1002": folder, "/tmp/kitshn-1002/kitshn.sock": sock };
    expect(localSocket({}, root, at(renamed), ["kitshn-1002"], named)).toEqual({
      refused: expect.stringContaining("belongs to user id 1000, not 1002"),
    });
    expect(
      localSocket({}, root, at({ ...daemon, "/tmp/kitshn-1000": { ...folder, mode: 0o40777 } }), tmp, named),
    ).toEqual({ refused: expect.stringContaining("mode 777") });
    expect(localSocket({}, root, at({ ...daemon, ...renamed }), [...tmp, "kitshn-1002"], named)).toEqual({
      several: ["/tmp/kitshn-1000/kitshn.sock", "/tmp/kitshn-1002/kitshn.sock"],
    });
  });

  it("names itself kitshn 2 in one stable JSON line, so tools can tell it from KitSHn 1 (K-1714)", () => {
    expect(JSON.parse(versionJson("edge-abc"))).toEqual({
      product: "kitshn",
      generation: 2,
      version: "edge-abc",
    });
  });
});
