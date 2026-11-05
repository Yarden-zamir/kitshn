// Builds the App CLI `kitshn.mjs` with Bun; the release and its skill go in (K-617, K-618).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = (process.env["KITSHN_SHA"] ?? process.env["GITHUB_SHA"])?.slice(0, 12) ?? "dev";
const skill = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
execFileSync(
  "bun",
  [
    "build",
    "src/cli.ts",
    "--target=node",
    "--outfile=dist/kitshn.mjs",
    `--define=KITSHN_VERSION="${version}"`,
    `--define=KITSHN_SKILL=${JSON.stringify(skill)}`,
  ],
  { stdio: "inherit", cwd: new URL("..", import.meta.url).pathname },
);
