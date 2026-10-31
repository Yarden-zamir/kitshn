// Packs the build into the release bundle that the bootstrap script uploads (K-1203):
// worker.js, assets/, and assets.json with the hash, size and content type of each asset.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist/release");
const client = join(root, "dist/client");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  // K-625: Windows PowerShell 5.1 `irm` reads text with no charset as ISO-8859-1.
  ".ps1": "text/plain; charset=utf-8",
  "": "text/plain; charset=utf-8",
};

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });
cpSync(join(root, "dist/kitshn/index.js"), join(out, "worker.js"));

const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

const manifest: Record<string, { hash: string; size: number; type: string }> = {};
for (const path of files(client)) {
  const name = relative(client, path);
  if (name === ".assetsignore") continue;
  const bytes = readFileSync(path);
  const extension = extname(name);
  const type = TYPES[extension];
  if (type === undefined) throw new Error(`No content type for ${name}. Add its extension to TYPES.`);
  // The Workers API takes any 32 hex characters; this is the hash of its own examples.
  const hash = createHash("sha256")
    .update(bytes.toString("base64") + extension.slice(1))
    .digest("hex")
    .slice(0, 32);
  manifest[`/${name}`] = { hash, size: bytes.length, type };
  mkdirSync(join(out, "assets", hash.slice(0, 2)), { recursive: true });
  cpSync(path, join(out, "assets", hash.slice(0, 2), hash));
}
writeFileSync(join(out, "assets.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const version = (process.env["KITSHN_SHA"] ?? process.env["GITHUB_SHA"])?.slice(0, 12) ?? "local";
writeFileSync(join(out, "version"), `${version}\n`);
execFileSync("tar", ["-czf", join(root, "dist/kitshn-edge.tar.gz"), "-C", out, "."]);
console.log(`dist/kitshn-edge.tar.gz: ${Object.keys(manifest).length} assets, version ${version}`);
