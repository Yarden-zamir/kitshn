import { describe, expect, it } from "vitest";
import { composeFiles } from "./compose.ts";

const same = (path: string) => path;

describe("Compose files of an app (K-818)", () => {
  const source = "/apps/a/src";
  const files = (present: ReadonlyArray<string>, file: string | null = null) =>
    composeFiles(source, file, (path) => present.includes(path), same);
  it("picks the files that Compose picks on its own: one main file and its override", () => {
    expect(
      files([
        "/apps/a/src/compose.yml",
        "/apps/a/src/docker-compose.yml",
        "/apps/a/src/compose.override.yaml",
      ]),
    ).toEqual(["/apps/a/src/compose.yml", "/apps/a/src/compose.override.yaml"]);
    expect(() => files([])).toThrow();
  });
  it("takes a named file only inside the source, and only when it exists", () => {
    expect(files(["/apps/a/src/deploy/compose.yml"], "deploy/compose.yml")).toEqual([
      "/apps/a/src/deploy/compose.yml",
    ]);
    expect(() => files(["/apps/a/src/deploy/compose.yml"], "compose.yml")).toThrow();
    expect(() => files(["/apps/b/src/compose.yml"], "../../b/src/compose.yml")).toThrow();
    expect(() => files(["/etc/compose.yml"], "/etc/compose.yml")).toThrow();
    const linked = (path: string) => (path === "/apps/a/src/compose.yml" ? "/apps/b/src/compose.yml" : path);
    expect(() => composeFiles(source, "compose.yml", () => true, linked)).toThrow();
    // The app folder itself may be a link, as /var is on macOS.
    const moved = (path: string) => path.replace("/apps/", "/private/apps/");
    expect(composeFiles(source, "compose.yml", () => true, moved)).toEqual(["/apps/a/src/compose.yml"]);
  });
});
