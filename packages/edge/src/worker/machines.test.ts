import { describe, expect, it } from "vitest";
import { circlePolicies } from "../core/access.ts";
import { machineFacts } from "../core/facts.ts";
import { type Machine, newJoinCode, openJoin, sealJoin } from "../core/machine.ts";
import type { Circle } from "../core/model.ts";
import { circleMatches } from "../core/visitor.ts";
import {
  answerCheck,
  legacyUpdateScript,
  machineIdFor,
  parseCommand,
  parseLabels,
  parseOwnerLabels,
  pickMachine,
  rekeyDecision,
  socketStart,
} from "./machines.ts";

const machine = (id: string, order: number, labels: Array<string>): Machine => ({
  id,
  name: id,
  labels,
  order,
  serviceTokenId: `token-${id}`,
  clientId: `${id}.access`,
  tunnelId: `tunnel-${id}`,
});

describe("join codes (K-602)", () => {
  it("opens with the right code and fails with another", async () => {
    const code = newJoinCode();
    const secrets = {
      server: "https://kit.example.com",
      machineId: "m1",
      clientId: "c",
      clientSecret: "s",
      tunnelToken: "t",
    };
    const box = await sealJoin(code, secrets);
    expect(await openJoin(code, box)).toEqual(secrets);
    await expect(openJoin(newJoinCode(), box)).rejects.toThrow();
  });
});

describe("jobs (K-610)", () => {
  it("picks the first online machine in the order that has every label", () => {
    const machines = [
      machine("b", 2, ["docker", "arm"]),
      machine("a", 1, ["docker"]),
      machine("c", 0, ["docker"]),
    ];
    const online = new Set(["a", "b"]);
    // K-635: only b reports Linux.
    const factsOf = (each: Machine) =>
      machineFacts(each.id === "b" ? { os: "linux 6.8.0", arch: "arm64" } : null);
    expect(pickMachine(machines, online, ["docker"], factsOf)?.id).toBe("a");
    expect(pickMachine(machines, online, ["docker", "arm"], factsOf)?.id).toBe("b");
    expect(pickMachine(machines, online, ["docker", "unix"], factsOf)?.id).toBe("b");
    expect(pickMachine(machines, online, ["gpu"], factsOf)).toBeNull();
  });

  it("checks commands and labels", () => {
    expect(parseCommand({ kind: "shell", script: "uptime" })).toEqual({ kind: "shell", script: "uptime" });
    expect(parseCommand({ kind: "shell", script: " " })).toMatch(/script/);
    expect(parseCommand({ kind: "format-disk" })).toMatch(/no command/);
    // The sender cannot pick the version of an update; kitshn fills in its own release (K-617).
    expect(parseCommand({ kind: "update", version: "deadbeefdead" })).toEqual({
      kind: "update",
      version: "",
    });
    expect(parseLabels(["Docker", "docker", "arm"])).toEqual(["docker", "arm"]);
    expect(parseLabels(["no spaces"])).toMatch(/label/);
    // K-635: a job can need a fact label, but the owner cannot set one.
    expect(parseLabels(["os:linux", "unix"])).toEqual(["os:linux", "unix"]);
    expect(parseOwnerLabels(["deploy", "Unix"])).toMatch(/comes from the daemon/);
    expect(parseOwnerLabels(["arch:x64"])).toMatch(/comes from the daemon/);
    expect(parseOwnerLabels(["deploy", "docker"])).toEqual(["deploy", "docker"]);
    expect(machineIdFor("Oracle VPS!")).toMatch(/^oracle-vps-[0-9a-f]{6}$/);
  });
});

describe("machine members (K-107)", () => {
  const m1 = machine("m1", 0, []);
  const machines = new Map([[m1.id, m1]]);
  const circle: Circle = {
    id: "agents",
    name: "Agents",
    color: "#6C5CE7",
    level: "use",
    members: [{ _tag: "machine", machineId: "m1" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 0,
    y: 0,
    r: 100,
  };

  it("matches the machine's service token and compiles to it", () => {
    expect(circleMatches(circle, { email: null, clientId: "m1.access", ip: null }, machines)).toBe(true);
    expect(circleMatches(circle, { email: null, clientId: "other.access", ip: null }, machines)).toBe(false);
    expect(circlePolicies(circle, machines).get("policy:agents:tokens")?.include).toEqual([
      { service_token: { token_id: "token-m1" } },
    ]);
  });

  it("matches nobody and compiles to nothing for an unknown machine", () => {
    expect(circleMatches(circle, { email: null, clientId: "m1.access", ip: null }, new Map())).toBe(false);
    expect(circlePolicies({ ...circle, match: "all" }, new Map()).size).toBe(0);
  });

  it("updates an old daemon with a checked shell script, only for a known platform (K-617)", () => {
    const script = legacyUpdateScript("f5d93ff436db", "linux 6.17.0-1020-oracle", "arm64");
    expect(script).toContain("edge-f5d93ff436db");
    expect(script).toContain("kitshn-linux-arm64.gz");
    expect(script).toContain("gzip -dc");
    // A failed unpack must stop the script before the mv (set -e skips && lists).
    expect(script).not.toMatch(/gzip -dc[^\n]*&&/);
    expect(script).toContain("SHA256SUMS");
    expect(legacyUpdateScript("f5d93ff436db", "win32 10", "x64")).toBeNull();
    expect(legacyUpdateScript("local", "linux", "x64")).toBeNull();
  });
});

describe("the check of a machine socket (K-1704, K-1706, K-1708)", () => {
  const key = { kind: "public", publicKey: "pub", fingerprint: "SHA256:f", since: 1 } as const;
  const fresh = { check: "waiting", answered: false } as const;

  it("sends a machine with a key a challenge for that key", () => {
    expect(socketStart(key)).toEqual({ kind: "challenge", fingerprint: "SHA256:f" });
    expect(answerCheck(key, fresh)).toEqual({ kind: "verify", publicKey: "pub", fingerprint: "SHA256:f" });
  });

  it("closes the socket of a machine that waits for its key code", () => {
    expect(socketStart({ kind: "waiting", since: 1 })).toEqual({ kind: "waitsForKey" });
    expect(answerCheck({ kind: "waiting", since: 1 }, fresh).kind).toBe("refuse");
  });

  it("takes a machine without a key on its token for status only, and never takes a first key from it", () => {
    expect(socketStart(undefined)).toEqual({ kind: "token" });
    expect(answerCheck(undefined, { check: "token", answered: false }).kind).toBe("refuse");
  });

  it("takes one answer per socket", () => {
    expect(answerCheck(key, { check: "waiting", answered: true }).kind).toBe("refuse");
    expect(answerCheck(key, { check: "signed", answered: true }).kind).toBe("refuse");
  });
});

describe("key codes (K-1706, K-1708)", () => {
  const keyless = machine("m1", 0, []);
  const code = { machineId: "m1", expiresAt: 100 };

  it("gives a key to the machine of the code", () => {
    expect(rekeyDecision(code, "m1", keyless, 50)).toEqual({ kind: "store" });
  });

  it("refuses another machine and keeps the code for its own machine", () => {
    expect(rekeyDecision(code, "m2", keyless, 50)).toMatchObject({ kind: "refuse", keepCode: true });
  });

  it("uses up an expired code and a code of a machine that has a key again", () => {
    expect(rekeyDecision(code, "m1", keyless, 200)).toMatchObject({ kind: "refuse", keepCode: false });
    const keyed = {
      ...keyless,
      key: { kind: "public", publicKey: "p", fingerprint: "f", since: 1 },
    } as const;
    expect(rekeyDecision(code, "m1", keyed, 50)).toMatchObject({ kind: "refuse", keepCode: false });
    expect(rekeyDecision(code, "m1", undefined, 50)).toMatchObject({ kind: "refuse", keepCode: false });
  });
});
