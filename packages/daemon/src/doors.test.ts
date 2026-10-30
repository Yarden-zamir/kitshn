import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  declaredProblem,
  helperInput,
  hostFirewallRules,
  hostFirewallStatus,
  hostFirewallText,
  listening,
  planOf,
  publicAddresses,
  refreshSeenV4,
  sudoersLine,
  systemTool,
  toolProblem,
} from "./doors.ts";

it("gives the root helper one line per port and per open door and port, without ended doors (K-2006)", () => {
  const plan = {
    ports: [
      { port: 25565, proto: "tcp" as const },
      { port: 19132, proto: "udp" as const },
    ],
    relays: [],
    doors: [
      { address: "203.0.113.9", ports: [{ port: 25565, proto: "tcp" as const }], endsAt: 61_000 },
      { address: "2001:db8:1:2::/64", ports: [{ port: 19132, proto: "udp" as const }], endsAt: 3_000 },
      { address: "198.51.100.1", ports: [{ port: 25565, proto: "tcp" as const }], endsAt: 1_500 },
    ],
  };
  expect(helperInput(plan, 1_000).split("\n")).toEqual([
    "port tcp 25565",
    "port udp 19132",
    "open4 203.0.113.9 tcp 25565 60",
    "open6 2001:db8:1:2:: udp 19132 2",
    "",
  ]);
});

it("reads the listening ports from ss, for IPv4 and IPv6 sockets (K-2007)", () => {
  const output = [
    "tcp   LISTEN 0      4096   0.0.0.0:25565   0.0.0.0:*",
    "udp   UNCONN 0      0      [::]:19132      [::]:*",
    "tcp   LISTEN 0      4096   127.0.0.1:2019  0.0.0.0:*",
  ].join("\n");
  expect([...listening(output)].sort()).toEqual(["19132/udp", "2019/tcp", "25565/tcp"]);
});

it("lets the daemon user run only `apply` of the helper as root (K-2003)", () => {
  expect(sudoersLine("kitshn")).toBe("kitshn ALL=(root) NOPASSWD: /usr/local/lib/kitshn/doors apply\n");
});

it("reads a kept plan only in this daemon's shape, so an old one never stops the start (K-2006)", () => {
  const plan = { ports: [{ port: 25565, proto: "tcp" }], doors: [], relays: [] };
  expect(planOf(plan)).toEqual(plan);
  expect(planOf({ ports: [{ port: 25565, proto: "tcp" }], doors: [] })).toEqual(plan);
  expect(planOf({ ports: "25565/tcp", doors: [] })).toBeNull();
  expect(planOf({ ports: [], doors: [{ address: "203.0.113.9", endsAt: "soon", ports: [] }] })).toBeNull();
  expect(planOf(null)).toBeNull();
});

it("finds a system tool outside the PATH, and names a missing tool instead of an empty output (K-2003)", () => {
  expect(systemTool("visudo", (path) => path === "/usr/sbin/visudo")).toBe("/usr/sbin/visudo");
  expect(systemTool("visudo", () => false)).toBe("visudo");
  const missing = spawnSync("kitshn-no-such-tool", ["-cf", "x"], { encoding: "utf8" });
  expect(toolProblem("visudo", missing, "refused the sudoers line")).toBe("visudo was not found");
  const refused = spawnSync("/bin/sh", ["-c", "echo '>>> line 1: syntax error' >&2; exit 1"], {
    encoding: "utf8",
  });
  expect(toolProblem("visudo", refused, "refused the sudoers line")).toBe(
    "visudo refused the sudoers line: >>> line 1: syntax error",
  );
  expect(toolProblem("visudo", spawnSync("/bin/sh", ["-c", "exit 0"], { encoding: "utf8" }))).toBeNull();
});

describe("the host firewall check and the declared address (K-2003)", () => {
  const oracle = [
    "-P INPUT ACCEPT",
    "-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT",
    "-A INPUT -p icmp -j ACCEPT",
    "-A INPUT -i lo -j ACCEPT",
    "-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT",
    "-A INPUT -j REJECT --reject-with icmp-host-prohibited",
    "---- nft",
  ].join("\n");
  const minecraft = [{ port: 25565, proto: "tcp" as const }];

  it("names the rule that rejects a new connection before the port could pass", () => {
    expect(hostFirewallRules(oracle, minecraft)).toEqual([
      "-A INPUT -j REJECT --reject-with icmp-host-prohibited",
    ]);
    // A rule that accepts the port first lets it pass.
    const allowed = oracle.replace(
      "-A INPUT -j REJECT",
      "-A INPUT -p tcp -m tcp --dport 25560:25570 -j ACCEPT\n-A INPUT -j REJECT",
    );
    expect(hostFirewallRules(allowed, minecraft)).toEqual([]);
    expect(hostFirewallText(hostFirewallRules(oracle, minecraft))).toContain("allow the ports");
    // `! --dport 22` drops every port except 22.
    const allBut = "-A INPUT -p tcp ! --dport 22 -j DROP\n---- nft";
    expect(hostFirewallRules(allBut, minecraft)).toHaveLength(1);
    expect(hostFirewallRules(allBut, [{ port: 22, proto: "tcp" }])).toEqual([]);
  });

  it("names a drop policy, and stays quiet behind a jump that it cannot read or with no firewall", () => {
    expect(hostFirewallRules("-P INPUT DROP\n---- nft", minecraft)).toEqual(["-P INPUT DROP"]);
    expect(hostFirewallRules("-P INPUT DROP\n-A INPUT -j ufw-before-input\n---- nft", minecraft)).toEqual([]);
    expect(hostFirewallRules("-P INPUT ACCEPT\n---- nft", minecraft)).toEqual([]);
    expect(
      hostFirewallRules(
        "---- nft\ntable inet filter {\n chain input {\n  type filter hook input priority filter; policy drop;\n }\n}",
        minecraft,
      ),
    ).toHaveLength(1);
    // A rule of the chain that names the port lets it pass, also in a set or a range.
    for (const rule of [
      "tcp dport 25565 accept",
      "tcp dport { 22, 25565 } accept",
      "tcp dport 25000-26000 accept",
    ])
      expect(
        hostFirewallRules(
          `---- nft\ntable inet filter {\n chain input {\n  type filter hook input priority filter; policy drop;\n  ${rule}\n }\n}`,
          minecraft,
        ),
        rule,
      ).toEqual([]);
  });

  it("says that the check did not run when an old helper saved no rules", () => {
    expect(hostFirewallStatus(null, minecraft)).toContain("run `kitshn doors install`");
    expect(hostFirewallStatus(null, [])).toBeNull();
    expect(hostFirewallStatus("-P INPUT ACCEPT\n---- nft", minecraft)).toBeNull();
  });

  it("drops a declared address only after a definite other answer, never for no answer", async () => {
    const none = {};
    const answers = (status: number, text: string) =>
      vi.stubGlobal("fetch", async () => new Response(text, { status }));
    using _restore = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    // Before the first answer the address counts.
    expect(publicAddresses(none, "203.0.113.9", null).v4).toBe("203.0.113.9");
    answers(200, "203.0.113.9\n");
    await refreshSeenV4();
    expect(publicAddresses(none, "203.0.113.9").v4).toBe("203.0.113.9");
    answers(503, "");
    await refreshSeenV4();
    expect(publicAddresses(none, "203.0.113.9").v4).toBe("203.0.113.9");
    answers(200, "<html>a proxy page</html>");
    await refreshSeenV4();
    expect(publicAddresses(none, "203.0.113.9").v4).toBe("203.0.113.9");
    answers(200, "198.51.100.1\n");
    await refreshSeenV4();
    expect(publicAddresses(none, "203.0.113.9").v4).toBeNull();
    answers(503, "");
    await refreshSeenV4();
    expect(publicAddresses(none, "203.0.113.9").v4).toBeNull();
    expect(declaredProblem("203.0.113.9", "198.51.100.1")).toContain("is not the address of the machine");
    expect(declaredProblem("203.0.113.9", null)).toBeNull();
    expect(declaredProblem(null, "198.51.100.1")).toBeNull();
  });
});
