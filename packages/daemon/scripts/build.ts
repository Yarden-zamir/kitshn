// Builds one kitshn binary per platform with Bun (K-601), for the edge release and the join script.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const version = (process.env["KITSHN_SHA"] ?? process.env["GITHUB_SHA"])?.slice(0, 12) ?? "dev";
// K-618: the skill of this release goes into the binary, so `kitshn skill install` writes the matching text.
const skill = readFileSync(new URL("../../kitshn/skill/SKILL.md", import.meta.url), "utf8");
const targets = [
  ["bun-linux-arm64", "kitshn-linux-arm64"],
  ["bun-linux-x64", "kitshn-linux-x64"],
  ["bun-darwin-arm64", "kitshn-darwin-arm64"],
  ["bun-darwin-x64", "kitshn-darwin-x64"],
  // K-620: one console binary, so `kitshn status` prints in a terminal; the tasks start it without a window.
  ["bun-windows-x64", "kitshn-windows-x64.exe"],
] as const;
const only = process.argv[2];
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
for (const [target, name] of targets) {
  if (only && !name.endsWith(only)) continue;
  execFileSync(
    "bun",
    [
      "build",
      "src/entry.ts",
      "--compile",
      `--target=${target}`,
      `--define=KITSHN_VERSION="${version}"`,
      `--define=KITSHN_SKILL=${JSON.stringify(skill)}`,
      `--outfile=dist/${name}`,
    ],
    { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname },
  );
}
