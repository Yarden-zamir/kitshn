import { describe, expect, it } from "vitest";
import {
  blockedV4,
  firewallRules,
  firewallScript,
  helperTaskXml,
  netstatListening,
  readWindowsPlan,
  windowsPlanText,
} from "./windoors.ts";

const v4 = (address: string) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
const covered = (ranges: ReadonlyArray<string>, address: string) =>
  ranges.some((range) => {
    const [from = "", to = ""] = range.split("-");
    return v4(from) <= v4(address) && v4(address) <= v4(to);
  });

describe("Windows game doors (K-2009)", () => {
  it("writes IPv4 doors with their end, and leaves out IPv6 and ended doors", () => {
    const tcp = [{ port: 25565, proto: "tcp" as const }];
    const text = windowsPlanText(
      {
        ports: tcp,
        relays: [],
        doors: [
          { address: "203.0.113.9", ports: tcp, endsAt: 120_000 },
          { address: "2001:db8:1:2::/64", ports: tcp, endsAt: 120_000 },
          { address: "198.51.100.1", ports: tcp, endsAt: 500 },
        ],
      },
      1_000,
    );
    expect(text).toBe("port tcp 25565\nopen4 203.0.113.9 tcp 25565 120\n");
  });

  it("checks every line of the plan file, skips a bad one, and keeps the good ports closed", () => {
    const doors = readWindowsPlan(
      [
        "port tcp 25565",
        "port tcp 80",
        "open4 203.0.113.9 tcp 25565 200",
        "open4 198.51.100.1 tcp 25565 50",
        "open4 10.0.0.5 tcp 25565 200",
        "open4 203.0.113.10 tcp 7777 200",
        "open4 203.0.113.11;calc tcp 25565 200",
        "port udp 19132 extra",
      ].join("\n"),
      100,
    );
    expect(doors.ports).toEqual([{ port: 25565, proto: "tcp" }]);
    // The ended door, the private address and the door of a port outside the plan open nothing.
    expect([...doors.open.entries()]).toEqual([["25565/tcp", ["203.0.113.9"]]]);
    expect(doors.skipped).toBe(4);
  });

  it("blocks every IPv4 address except the open doors and the private networks", () => {
    const ranges = blockedV4(["203.0.113.9", "8.8.8.8"]);
    for (const open of ["203.0.113.9", "8.8.8.8", "192.168.1.202", "10.1.2.3", "127.0.0.1", "100.100.1.1"])
      expect(covered(ranges, open), open).toBe(false);
    for (const closed of [
      "0.0.0.0",
      "1.1.1.1",
      "8.8.8.7",
      "8.8.8.9",
      "203.0.113.8",
      "203.0.113.10",
      "255.255.255.255",
    ])
      expect(covered(ranges, closed), closed).toBe(true);
  });

  it("writes rules from checked values only, and adds the new ones before it removes the old ones", () => {
    const rules = firewallRules(readWindowsPlan("port tcp 25565\nopen4 203.0.113.9 tcp 25565 200\n", 100));
    expect(rules.map((rule) => rule.name.split(" ").slice(0, 4).join(" "))).toEqual([
      "kitshn door 25565/tcp v4",
      "kitshn door 25565/tcp v6",
    ]);
    const script = firewallScript(rules);
    expect(script.indexOf("New-NetFirewallRule")).toBeLessThan(script.indexOf("Remove-NetFirewallRule"));
    expect(script).toContain("-Action Block -Profile Any -Protocol TCP -LocalPort 25565");
    // An empty plan removes every rule of the group.
    expect(firewallScript([])).toContain("$keep = @()");
  });

  it("reads listening ports from netstat (K-2006)", () => {
    const output = [
      "  TCP    0.0.0.0:25565          0.0.0.0:0              LISTENING",
      "  TCP    192.168.1.202:50000    1.1.1.1:443            ESTABLISHED",
      "  UDP    [::]:19132             *:*",
    ].join("\r\n");
    expect([...netstatListening(output)].sort()).toEqual(["19132/udp", "25565/tcp"]);
  });

  it("runs the helper as SYSTEM from its own copy, at start-up", () => {
    const xml = helperTaskXml("C:\\Program Files\\kitshn\\kitshn-doors.exe");
    expect(xml).toContain("<UserId>S-1-5-18</UserId>");
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain(
      "<Command>C:\\Program Files\\kitshn\\kitshn-doors.exe</Command><Arguments>doors-helper</Arguments>",
    );
  });
});
