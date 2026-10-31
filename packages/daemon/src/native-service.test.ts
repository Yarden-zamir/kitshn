import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeServiceFile, windowsArgument } from "./native-service.ts";

describe("native user-service definitions", () => {
  const unix = {
    id: "app-proxy-1-prod",
    executable: "/home/u/release/bin/proxy-gateway",
    args: ["-config", "{data}/gateway.json"],
    data: "/home/u/proxy data/$& %n",
    workingDirectory: "/home/u/release folder",
  };

  it("renders a systemd user service without shell, variable, or specifier expansion", () => {
    const service = nativeServiceFile("linux", unix);
    expect(service.name).toBe("kitshn-app-app-proxy-1-prod.service");
    expect(service.encoding).toBe("utf8");
    expect(service.content).toContain("WorkingDirectory=/home/u/release folder");
    expect(service.content).toContain(
      'ExecStart="/home/u/release/bin/proxy-gateway" "-config" "/home/u/proxy data/$$& %%n/gateway.json"',
    );
    expect(service.content).toContain("Restart=always");
    expect(service.content).not.toContain("/bin/sh");
    if (process.platform === "linux" && existsSync("/usr/bin/systemd-analyze")) {
      const dir = mkdtempSync(join(tmpdir(), "kitshn-native-unit-"));
      try {
        const file = join(dir, "kitshn-app-test.service");
        const valid = nativeServiceFile("linux", {
          ...unix,
          executable: "/usr/bin/true",
          workingDirectory: "/tmp",
        });
        writeFileSync(file, valid.content);
        execFileSync("/usr/bin/systemd-analyze", ["verify", file], { encoding: "utf8" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("renders valid launchd XML, preserving data paths with XML metacharacters", () => {
    const service = nativeServiceFile("darwin", {
      ...unix,
      data: "/Users/u/proxy & <data>",
      executable: "/Users/u/release/proxy",
      workingDirectory: "/Users/u/release",
    });
    expect(service.name).toBe("com.kitshn.app.app-proxy-1-prod.plist");
    expect(service.encoding).toBe("utf8");
    expect(service.content).toContain("<string>/Users/u/proxy &amp; &lt;data&gt;/gateway.json</string>");
    expect(service.content).toContain("<key>KeepAlive</key><true/>");
    if (process.platform === "darwin") {
      const dir = mkdtempSync(join(tmpdir(), "kitshn-native-plist-"));
      try {
        const file = join(dir, "service.plist");
        writeFileSync(file, service.content);
        expect(execFileSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("passes Windows arguments as quoted argv and uses the explicitly chosen non-system user", () => {
    expect(windowsArgument("")).toBe('""');
    expect(windowsArgument("two words")).toBe('"two words"');
    expect(windowsArgument('a"b')).toBe('"a\\"b"');
    expect(windowsArgument("ends\\")).toBe('"ends\\\\"');
    const service = nativeServiceFile("win32", {
      id: "app-proxy-1-prod",
      executable: "C:\\Users\\u\\release folder\\proxy.exe",
      args: ["-config", "{data}\\gateway.json", 'a"b'],
      data: "C:\\Users\\u\\proxy & data",
      workingDirectory: "C:\\Users\\u\\release folder",
      windowsUser: "PC\\u",
    });
    expect(service.name).toBe("\\kitshn\\apps\\app-proxy-1-prod");
    expect(service.encoding).toBe("utf16le-bom");
    expect(service.content).toContain("<UserId>PC\\u</UserId>");
    expect(service.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(service.content).toContain("<Command>C:\\Users\\u\\release folder\\proxy.exe</Command>");
    expect(service.content).toContain(
      "&quot;-config&quot; &quot;C:\\Users\\u\\proxy &amp; data\\gateway.json&quot; &quot;a\\&quot;b&quot;",
    );
    expect(service.content).not.toContain("powershell");
    expect(service.content).not.toContain("cmd.exe");
    expect(
      nativeServiceFile("win32", {
        ...unix,
        executable: "C:\\app\\proxy.exe",
        data: "C:\\app\\data",
        workingDirectory: "C:\\app",
        windowsUser: "MicrosoftAccount\\user@example.com",
      }).content,
    ).toContain("MicrosoftAccount\\user@example.com");
  });

  it("refuses unsafe ids, control characters, relative paths, Windows network paths and system users", () => {
    expect(() => nativeServiceFile("linux", { ...unix, id: "../other" })).toThrow();
    expect(() => nativeServiceFile("linux", { ...unix, executable: "bin/proxy" })).toThrow();
    expect(() => nativeServiceFile("linux", { ...unix, args: ["line\nbreak"] })).toThrow();
    expect(() => nativeServiceFile("linux", { ...unix, workingDirectory: "/tmp/trailing " })).toThrow();
    expect(() => nativeServiceFile("linux", { ...unix, workingDirectory: "/tmp/back\\slash" })).toThrow();
    expect(() => nativeServiceFile("darwin", { ...unix, args: ["bad\ud800"] })).toThrow();
    const windows = {
      ...unix,
      executable: "C:\\app\\proxy.exe",
      data: "C:\\app\\data",
      workingDirectory: "C:\\app",
      windowsUser: "PC\\u",
    };
    expect(() =>
      nativeServiceFile("win32", { ...windows, executable: "\\\\server\\share\\proxy.exe" }),
    ).toThrow();
    expect(() => nativeServiceFile("win32", { ...windows, args: ["%PATH%"] })).toThrow();
    for (const executable of ["C:\\app\\proxy.cmd", "C:\\app\\proxy.BAT", "C:\\app\\proxy.exe "])
      expect(() => nativeServiceFile("win32", { ...windows, executable })).toThrow();
    for (const windowsUser of [
      "NT AUTHORITY\\SYSTEM",
      "NT AUTHORITY\\LOCAL SERVICE",
      "NT SERVICE\\example",
      "PC\\user ",
      "SYSTEM",
    ])
      expect(() => nativeServiceFile("win32", { ...windows, windowsUser })).toThrow();
  });
});
