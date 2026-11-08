// K-805, K-806, K-815: the build steps of a recipe, shared by `kitshn deploy` and `kitshn try`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { fail } from "./cli-error.ts";
import type { WorkerApp } from "./recipe.ts";

/**
 * The environment of the build command and of npx, without the two variables that mint GitHub OIDC tokens. This is
 * defense in depth, not isolation: a build runs as the same user and can still read the environment of this process,
 * and hosted runners give sudo. A build that runs untrusted code belongs in its own job without `id-token: write`,
 * which passes its output as an artifact (K-805).
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  delete env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  return env;
}

export function runBuild(dir: string, command: string) {
  console.log(`kitshn: building with: ${command}`);
  execFileSync("sh", ["-c", command], { cwd: dir, stdio: "inherit", env: childEnv() });
}

/** A path of the recipe after symlinks, or a failure when it leaves the repo. */
export function insideRepo(dir: string, path: string, what: string): string {
  const full = resolve(dir, path);
  // realpath follows a symlink, so a link cannot point outside the repo.
  const real = existsSync(full) ? realpathSync(full) : full;
  const root = realpathSync(dir);
  if (real !== root && !real.startsWith(root + sep)) fail(`${what} ${path} is outside the repo.`);
  if (!existsSync(full)) fail(`${what} ${path} does not exist after the build.`);
  return full;
}

/**
 * K-806: the esbuild that bundles Worker apps, pinned. Known limit: npx downloads it from npm in each deploy, so a
 * deploy needs the npm registry and trusts that package. Revisit when that download fails a deploy, or when the
 * kitshn release can ship esbuild itself.
 */
const ESBUILD = "esbuild@0.28.2";

/** K-806: the Free plan limit of a Worker, gzip-compressed. */
const WORKER_GZIP_LIMIT = 3 * 1024 * 1024;

/**
 * K-806: runs the recipe's `build`, then bundles `main` into one ES module `worker.js` in `work`, and checks the size
 * limit and the classes of the Durable Object bindings.
 */
export function bundleWorker(dir: string, app: WorkerApp, work: string) {
  if (app.build) runBuild(dir, app.build);
  const main = insideRepo(dir, app.main, "the entry module");
  const file = join(work, "worker.js");
  const metafile = join(work, "meta.json");
  console.log(`kitshn: bundling ${app.main} with ${ESBUILD}`);
  // From the temporary folder and the public registry, so the .npmrc and node_modules of the repo do not choose
  // the esbuild that runs.
  execFileSync(
    "npx",
    [
      "--yes",
      "--registry=https://registry.npmjs.org",
      ESBUILD,
      main,
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--conditions=workerd,worker,browser",
      "--main-fields=module,main",
      "--external:cloudflare:*",
      "--external:node:*",
      `--outfile=${file}`,
      `--metafile=${metafile}`,
      "--log-level=warning",
    ],
    { cwd: work, stdio: "inherit", env: childEnv() },
  );
  const module = readFileSync(file, "utf8");
  const size = gzipSync(module).length;
  if (size > WORKER_GZIP_LIMIT)
    fail(
      `the bundle is ${Math.round(size / 1024)} KB gzip-compressed; a Worker on the Free plan takes 3 MB.`,
    );
  const meta = JSON.parse(readFileSync(metafile, "utf8")) as {
    outputs: Record<string, { exports?: ReadonlyArray<string> }>;
  };
  const exports = new Set(Object.values(meta.outputs).flatMap((output) => output.exports ?? []));
  for (const [binding, name] of Object.entries(app.durableObjects ?? {}))
    if (!exports.has(name))
      fail(`${app.main} exports no class ${name} for the Durable Object binding ${binding}.`);
  return { file, module, size };
}
