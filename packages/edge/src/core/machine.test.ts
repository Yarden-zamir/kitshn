import { describe, expect, it } from "vitest";
import {
  connectText,
  daemonProtocolMatch,
  namedProtocol,
  fingerprintOf,
  forwardPathProblem,
  forwardUrl,
  newChallenge,
  newMachineKey,
  parseAllowances,
  parsePrivateKey,
  parsePublicKey,
  rotateText,
  signText,
  signedHost,
  verifyForHosts,
  verifyText,
} from "./machine.ts";

describe("allow list (K-818)", () => {
  it("takes one repo and one setting per entry", () => {
    expect(parseAllowances([{ repo: " a/b ", setting: "bind:/var/run/docker.sock" }])).toEqual([
      { repo: "a/b", setting: "bind:/var/run/docker.sock" },
    ]);
  });
  it("refuses an entry with more words, which would read as another setting", () => {
    expect(parseAllowances([{ repo: "a/b ports", setting: "privileged" }])).toBeTypeOf("string");
    expect(parseAllowances([{ repo: "a/b", setting: "privileged\tports" }])).toBeTypeOf("string");
  });
});

describe("machine keys (K-1701 to K-1705)", () => {
  const host = "kit.example.com";

  it("verifies the answer to its own challenge with the public half", async () => {
    const key = await newMachineKey();
    const challenge = newChallenge();
    const signature = await signText(key, connectText(host, "m1", challenge));
    expect(await verifyText(key.x, connectText(host, "m1", challenge), signature)).toBe(true);
  });

  it("refuses a replay on another connection, for another host, machine or key", async () => {
    const key = await newMachineKey();
    const challenge = newChallenge();
    const signature = await signText(key, connectText(host, "m1", challenge));
    expect(await verifyText(key.x, connectText(host, "m1", newChallenge()), signature)).toBe(false);
    expect(await verifyText(key.x, connectText("kit.other.com", "m1", challenge), signature)).toBe(false);
    expect(await verifyText(key.x, connectText(host, "m2", challenge), signature)).toBe(false);
    expect(await verifyText((await newMachineKey()).x, connectText(host, "m1", challenge), signature)).toBe(
      false,
    );
  });

  it("never takes a connect answer as a rotation", async () => {
    const old = await newMachineKey();
    const next = await newMachineKey();
    const challenge = newChallenge();
    const answer = await signText(old, connectText(host, "m1", challenge));
    expect(await verifyText(old.x, rotateText(host, "m1", challenge, next.x), answer)).toBe(false);
    const handover = await signText(old, rotateText(host, "m1", challenge, next.x));
    expect(await verifyText(old.x, rotateText(host, "m1", challenge, next.x), handover)).toBe(true);
  });

  it("takes a signature for the old host only while that host is listed (K-1209)", async () => {
    const key = await newMachineKey();
    const challenge = newChallenge();
    const signature = await signText(key, connectText("kit.example.com", "m1", challenge));
    const textFor = (signedFor: string) => connectText(signedFor, "m1", challenge);
    expect(await verifyForHosts(key.x, ["kitshn.example.com", "kit.example.com"], textFor, signature)).toBe(
      true,
    );
    expect(await verifyForHosts(key.x, ["kitshn.example.com"], textFor, signature)).toBe(false);
  });

  it("signs the hostname without its port, from an address or a host", async () => {
    expect(signedHost("localhost:8787")).toBe("localhost");
    expect(signedHost("http://localhost:8787")).toBe("localhost");
    expect(signedHost("https://kit.example.com")).toBe("kit.example.com");
    const key = await newMachineKey();
    const challenge = newChallenge();
    // The daemon signs with its server address; kitshn checks with its KITSHN_HOST.
    const signature = await signText(key, connectText("http://localhost:8787", "m1", challenge));
    expect(await verifyText(key.x, connectText("localhost:8787", "m1", challenge), signature)).toBe(true);
  });

  it("returns false for a broken key or signature instead of throwing", async () => {
    const key = await newMachineKey();
    expect(await verifyText("not a key", "text", "sig")).toBe(false);
    expect(await verifyText(key.x, "text", "!!!")).toBe(false);
    expect(await verifyText(key.x, "text", 42)).toBe(false);
  });

  it("reads keys back and gives each key its own fingerprint", async () => {
    const key = await newMachineKey();
    expect(parsePrivateKey(JSON.parse(JSON.stringify(key)))).toEqual(key);
    expect(parsePrivateKey({ ...key, crv: "P-256" })).toBeNull();
    expect(parsePublicKey(key.x)).toBe(key.x);
    expect(parsePublicKey(key.x.slice(1))).toBeNull();
    const fingerprint = await fingerprintOf(key.x);
    expect(fingerprint.startsWith("SHA256:") && fingerprint.length === "SHA256:".length + 43).toBe(true);
    expect(await fingerprintOf(key.x)).not.toBe(await fingerprintOf((await newMachineKey()).x));
  });
});

describe("forwarded paths (K-1714)", () => {
  it("stay below /agent/ on the server after normalizing, with no encoded slash, dot or percent", () => {
    const server = "https://kit.example.com";
    expect(String(forwardUrl(server, "/agent/cards/x/address"))).toBe(
      "https://kit.example.com/agent/cards/x/address",
    );
    for (const path of [
      "/agent/../connect/deploys/1/params.env",
      "/agent/%2e%2e/connect",
      "/agent/cards/a%2fb/address",
      "/agent/cards/a%252e%252e/address",
      "//evil.example.com/agent/x",
    ])
      expect(forwardUrl(server, path), path).toEqual(expect.any(String));
    expect(forwardPathProblem("/agent/library")).toBeNull();
    expect(forwardPathProblem("/connect")).toEqual(expect.any(String));
  });
});

describe("the protocol that a daemon names (K-724)", () => {
  it("reads a missing value as 2.0.0, and refuses a value of another type", () => {
    expect(namedProtocol(undefined)).toBe("2.0.0");
    expect(daemonProtocolMatch(namedProtocol(undefined), "vps").outcome).not.toBe("refuse");
    for (const bad of [3, null, { major: 2 }, ["2.1.0"]])
      expect(daemonProtocolMatch(namedProtocol(bad), "vps").outcome).toBe("refuse");
  });
});
