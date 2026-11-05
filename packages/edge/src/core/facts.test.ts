import { describe, expect, it } from "vitest";
import { deployLabels, hasLabels, machineFacts } from "./facts.ts";

const labelsOf = (os: string, arch: string) => machineFacts({ os, arch }).map((fact) => fact.label);

describe("fact labels (K-635)", () => {
  it("derives the labels from a daemon report", () => {
    expect(labelsOf("linux 6.8.0-45-generic", "x64")).toEqual(["os:linux", "unix", "arch:x64"]);
    expect(labelsOf("darwin 25.6.0", "arm64")).toEqual(["os:darwin", "unix", "arch:arm64"]);
    expect(labelsOf("win32 10.0.26100", "x64")).toEqual(["os:windows", "arch:x64"]);
    expect(labelsOf("freebsd 14.1", "ia32")).toEqual([]);
    expect(machineFacts(null)).toEqual([]);
    expect(machineFacts({ os: "linux 6.8.0", arch: "arm64" })[0]).toEqual({
      label: "os:linux",
      from: "os linux 6.8.0",
    });
  });

  it("matches runsOn with a fact label only on a machine that the owner labels deploy (K-610)", () => {
    const linux = machineFacts({ os: "linux 6.8.0", arch: "x64" });
    expect(hasLabels(["deploy"], linux, deployLabels(["unix"]))).toBe(true);
    expect(hasLabels(["docker"], linux, deployLabels(["unix"]))).toBe(false);
    expect(
      hasLabels(["deploy"], machineFacts({ os: "win32 10.0", arch: "x64" }), deployLabels(["unix"])),
    ).toBe(false);
  });
});
