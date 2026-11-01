#!/usr/bin/env node
// The kitshn CLI for app repos: `kitshn check` (K-802) and `kitshn deploy` (K-803, K-805, K-811).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { AGENT_USAGE, isAgentCommand, keyTransport, runAgentCommand } from "./agent.ts";
import { OPS_HELP, isOpCommand, runOpCommand } from "./ops.ts";
import { type AssetSession, jsonOf, uploadAssets } from "./assets.ts";
import { CliError, fail } from "./cli-error.ts";
import { errorOutput } from "./output.ts";
import { type Artifact, artifactsByApp } from "./artifacts.ts";
import { RecipeError, readApps } from "./parse.ts";
import {
  type AppResult,
  type Apps,
  type DeployEvent,
  type Recipe,
  type WorkerApp,
  decodeApps,
  deployOrder,
  missingNeeds,
} from "./recipe.ts";

function loadApps(dir: string): Apps {
  const file = join(dir, "kitshn.config.ts");
  if (!existsSync(file)) fail(`${file} does not exist.`);
  try {
    return decodeApps(readApps(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof RecipeError) fail(error.message);
    return fail(`kitshn.config.ts does not match the recipe schema: ${String(error)}`);
  }
}

/** The GitHub Actions OIDC token for the kitshn server (K-811). It needs `permissions: id-token: write`. */
let cachedToken: { readonly value: string; readonly until: number } | null = null;

async function oidcToken(audience: string): Promise<string> {
  // A token lasts about 5 minutes; a deploy that waits asks for one every few seconds.
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value;
  const url = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  const token = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  if (!url || !token) fail("no GitHub OIDC token. The workflow needs `permissions: id-token: write`.");
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${token}` },
  });
  const body = jsonOf<{ value?: string }>(await response.text());
  const value = body.ok ? body.value.value : undefined;
  if (!value) fail(`GitHub gave no OIDC token (${response.status})${body.ok ? "" : `: ${body.text}`}.`);
  cachedToken = { value: value as string, until: Date.now() + 4 * 60_000 };
  return value as string;
}

function githubEvent(): DeployEvent {
  const name = process.env["GITHUB_EVENT_NAME"];
  const payload = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8")) as {
    action?: string;
    pull_request?: { number: number; head: { ref: string } };
  };
  if (name === "pull_request") {
    const pr = payload.pull_request;
    return { name, branch: pr?.head.ref ?? "", pr: pr?.number ?? null, action: payload.action ?? null };
  }
  // K-718: a dispatch runs one branch's code, so it deploys as a push of that branch.
  if (name === "push" || name === "workflow_dispatch")
    return { name: "push", branch: process.env["GITHUB_REF_NAME"] ?? "", pr: null, action: null };
  return fail(`kitshn deploys on push, pull_request and workflow_dispatch, not on ${name}.`);
}

async function call<T>(server: string, path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, server), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await oidcToken(new URL(server).origin)}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !data) fail(data?.error ?? `${path} answered ${response.status}.`);
  return data as T;
}

/**
 * K-804, K-820: deploys each app of the repo as its own deploy, after the apps that it needs. When an app does not
 * deploy, the apps that need it do not deploy either, and kitshn records why on their cards. A closed pull request
 * tears every preview down in the reverse order, and one failed teardown does not stop the others.
 */
async function deploy(server: string, dir: string) {
  const env = params();
  const apps = loadApps(dir);
  const event = githubEvent();
  const artifacts = artifactsByApp(Object.keys(apps), process.env);
  if (!(artifacts instanceof Map)) return fail(artifacts.error);
  const ordered = deployOrder(apps);
  if ("error" in ordered) return fail(ordered.error);
  const closing = event.name === "pull_request" && event.action === "closed";
  const order = closing ? [...ordered.order].reverse() : ordered.order;
  const results = new Map<string, AppResult>();
  for (const key of order) {
    const recipe = apps[key]!;
    const label = Object.keys(apps).length === 1 ? "" : `[${key}] `;
    const missing = closing ? [] : missingNeeds(recipe, results);
    const run: { deployId: string | null } = { deployId: null };
    try {
      if (missing.length > 0) {
        const reason = `not deployed, because it needs ${missing.join(", ")}, which did not deploy (K-820).`;
        await call(server, "/deploy/plan", { recipe, key, event, skip: reason });
        console.log(`kitshn: ${label}${reason}`);
        results.set(key, "skipped");
        continue;
      }
      await deployApp(server, dir, key, label, recipe, event, env, artifacts.get(key) ?? null, run);
      results.set(key, "done");
    } catch (error) {
      const reason = error instanceof CliError ? error.message : String(error);
      console.error(`kitshn: ${label}${reason}`);
      results.set(key, "failed");
      if (run.deployId)
        await call(server, "/deploy/fail", { deployId: run.deployId, reason }).catch(() => undefined);
    }
  }
  if (order.length > 1)
    console.log(
      `kitshn: ${order.map((key) => `${key} ${results.get(key) === "done" ? "ok" : results.get(key)}`).join(", ")}`,
    );
  if ([...results.values()].some((result) => result !== "done")) process.exitCode = 1;
}

/** K-805, K-806, K-812: plans and runs the deploy of one app. `run.deployId` names the deploy once kitshn made it. */
async function deployApp(
  server: string,
  dir: string,
  key: string,
  label: string,
  recipe: Recipe,
  event: DeployEvent,
  env: ReadonlyMap<string, string>,
  artifact: Artifact | null,
  run: { deployId: string | null },
) {
  const plan = await call<{
    deployId: string | null;
    plan: { kind: string; reason?: string; address?: string; environment?: string };
  }>(server, "/deploy/plan", { recipe, key, event });
  if (plan.plan.kind === "skip" || !plan.deployId) {
    console.log(`kitshn: ${label}nothing to do. ${plan.plan.reason ?? ""}`);
    return;
  }
  run.deployId = plan.deployId;
  if (plan.plan.kind === "teardown") {
    await call(server, "/deploy/teardown", { deployId: plan.deployId });
    console.log(`kitshn: ${label}removed ${plan.plan.environment} at https://${plan.plan.address}`);
    return;
  }
  if ("compose" in recipe) {
    if (artifact) fail("an artifact is for a static site; a Compose app builds on its machine.");
    return deployCompose(server, dir, plan.deployId, plan.plan.address ?? "", env);
  }
  if ("worker" in recipe) {
    if (artifact) fail("an artifact is for a static site; a Worker app builds with `build` (K-806).");
    return deployWorker(server, dir, plan.deployId, recipe.worker, env);
  }
  if (recipe.static.build) runBuild(dir, recipe.static.build);
  const output = resolve(dir, recipe.static.output);
  // K-805: a site that its own job built arrives at its artifact path, which must be the output folder of the recipe.
  const artifactPath = artifact?.path;
  if (artifactPath && (artifactPath.startsWith("/") || artifactPath.split("/").includes("..")))
    fail(`the artifact path ${artifactPath} must be a folder inside the repo.`);
  if (artifactPath && resolve(dir, artifactPath) !== output) {
    fail(
      `the artifact went to ${artifactPath}, but the output folder of the recipe is ${recipe.static.output}. Make the artifact path and output the same folder.`,
    );
  }
  if (artifact?.from) {
    if (!existsSync(artifact.from)) fail(`the artifact of ${key} was not downloaded; check its name.`);
    cpSync(artifact.from, output, { recursive: true });
  }
  if (artifactPath && recipe.static.build)
    console.log(
      "kitshn: warning: the recipe builds too, over the artifact; a site with its own build job names no build.",
    );
  const assets = await uploadAssets(insideRepo(dir, recipe.static.output, "the output folder"), (manifest) =>
    call<AssetSession>(server, "/deploy/assets", { deployId: plan.deployId, manifest }),
  );
  const done = await call<{ address: string; status: number; card: string }>(server, "/deploy/finish", {
    deployId: plan.deployId,
    jwt: assets.jwt,
    icon: assets.icon,
    headers: assets.headers,
    redirects: assets.redirects,
  });
  console.log(
    `kitshn: deployed ${assets.count} files to https://${done.address} (route check: ${done.status}).`,
  );
  console.log(`kitshn: ${done.card}`);
}

/**
 * The environment of the build command and of npx, without the two variables that mint GitHub OIDC tokens. This is
 * defense in depth, not isolation: a build runs as the same user and can still read the environment of this process,
 * and hosted runners give sudo. A build that runs untrusted code belongs in its own job without `id-token: write`,
 * which passes its output as an artifact (K-805).
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  delete env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  return env;
}

function runBuild(dir: string, command: string) {
  console.log(`kitshn: building with: ${command}`);
  execFileSync("sh", ["-c", command], { cwd: dir, stdio: "inherit", env: childEnv() });
}

/** A path of the recipe after symlinks, or a failure when it leaves the repo. */
function insideRepo(dir: string, path: string, what: string): string {
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
 * K-806: bundles `main` into one ES module, uploads the assets folder, and sends both with the `KITSHN_<NAME>` values
 * of the run (K-808). kitshn makes the storage of the environment and the Worker.
 */
async function deployWorker(
  server: string,
  dir: string,
  deployId: string,
  app: WorkerApp,
  env: ReadonlyMap<string, string>,
) {
  if (app.build) runBuild(dir, app.build);
  const main = insideRepo(dir, app.main, "the entry module");
  const work = mkdtempSync(join(tmpdir(), "kitshn-worker-"));
  try {
    const outfile = join(work, "worker.js");
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
        `--outfile=${outfile}`,
        `--metafile=${metafile}`,
        "--log-level=warning",
      ],
      { cwd: work, stdio: "inherit", env: childEnv() },
    );
    const module = readFileSync(outfile, "utf8");
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
    const storage = await call<{ created: ReadonlyArray<string> }>(server, "/deploy/storage", { deployId });
    for (const name of storage.created) console.log(`kitshn: made the KV namespace of ${name}.`);
    const assets = app.assets
      ? await uploadAssets(insideRepo(dir, app.assets.folder, "the output folder"), (manifest) =>
          call<AssetSession>(server, "/deploy/assets", { deployId, manifest }),
        )
      : null;
    const done = await call<{ address: string; status: number; card: string; notes: ReadonlyArray<string> }>(
      server,
      "/deploy/finish",
      {
        deployId,
        jwt: assets?.jwt ?? null,
        icon: assets?.icon ?? null,
        headers: assets?.headers ?? null,
        redirects: assets?.redirects ?? null,
        module,
        secrets: Object.fromEntries(env),
      },
    );
    for (const note of done.notes) console.log(`kitshn: ${note}`);
    console.log(
      `kitshn: deployed the Worker (${Math.round(size / 1024)} KB gzip-compressed${assets ? `, ${assets.count} files` : ""}) to https://${done.address} (route check: ${done.status}).`,
    );
    console.log(`kitshn: ${done.card}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The largest source archive kitshn takes (K-812): under the 100 MB request body limit of Cloudflare. */
const MAX_ARCHIVE = 95 * 1024 * 1024;

/** KitSHn 1 deploy credentials that live next to app params in old repos; an app never gets them. */
const INFRASTRUCTURE = new Set(["SSH_KEY", "VPS_HOST", "SSH_KNOWN_HOSTS"]);

/**
 * K-808: the `KITSHN_<NAME>` secrets and variables of the run by `<NAME>`. The workflow filters them into a file in
 * an earlier step, so build commands never see secrets; a secret wins over a variable with the same name.
 */
function params(): Map<string, string> {
  const file = process.env["KITSHN_PARAMS_JSON"];
  delete process.env["KITSHN_PARAMS_JSON"];
  if (!file) return new Map();
  if (!existsSync(file)) fail(`the params file ${file} is missing; the workflow and the CLI do not match.`);
  const text = readFileSync(file, "utf8");
  // Gone before any build command runs, so a build cannot read the secrets.
  rmSync(file, { force: true });
  const read = JSON.parse(text) as {
    secrets?: Record<string, unknown>;
    vars?: Record<string, unknown>;
  };
  const values = new Map<string, string>();
  for (const source of [read.vars ?? {}, read.secrets ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      const name = key.slice("KITSHN_".length);
      const named =
        name.length > 0 &&
        [...name].every((c) => c === "_" || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9"));
      if (!key.startsWith("KITSHN_") || !named || typeof value !== "string" || INFRASTRUCTURE.has(name))
        continue;
      values.set(name, value);
    }
  }
  return values;
}

/** K-808: Compose env lines `<NAME>="value"`, quoted as JSON like KitSHn 1, so a line break or a `#` survives. */
const envLines = (values: ReadonlyMap<string, string>) =>
  [...values].map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");

async function upload(server: string, path: string, deployId: string, body: Buffer, type: string) {
  const response = await fetch(new URL(path, server), {
    method: "POST",
    headers: {
      "content-type": type,
      "x-kitshn-deploy": deployId,
      authorization: `Bearer ${await oidcToken(new URL(server).origin)}`,
    },
    body,
  });
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) fail(data?.error ?? `${path} answered ${response.status}.`);
}

/**
 * K-812, K-813: sends the checkout and the params to R2 for this deploy, starts the job on a machine, and
 * prints its output until it ends. The checkout keeps `.git`, because builds can read it; the workflow
 * checks out without a stored token.
 */
async function deployCompose(
  server: string,
  dir: string,
  deployId: string,
  address: string,
  values: ReadonlyMap<string, string>,
) {
  const env = envLines(values);
  const archive = execFileSync("tar", ["-czf", "-", "--exclude=./node_modules", "-C", dir, "."], {
    maxBuffer: MAX_ARCHIVE + 1,
  });
  if (archive.length > MAX_ARCHIVE) fail("the source archive is larger than 95 MB.");
  console.log(`kitshn: sending the source (${Math.round(archive.length / 1024)} KB)`);
  await upload(server, "/deploy/archive", deployId, archive, "application/gzip");
  await upload(server, "/deploy/params", deployId, Buffer.from(env), "text/plain");
  const started = await call<{ machine: string }>(server, "/deploy/start", { deployId });
  console.log(`kitshn: building and starting on ${started.machine}`);
  let shown = 0;
  // The workflow stops at 40 minutes; a deploy that has not ended by then failed somewhere.
  const until = Date.now() + 38 * 60_000;
  for (;;) {
    if (Date.now() > until) fail("the deploy did not end within 38 minutes.");
    await new Promise((done) => setTimeout(done, 3000));
    const status = await call<{ state: string; output: string; exitCode: number | null }>(
      server,
      "/deploy/status",
      { deployId },
    );
    if (status.output.length > shown) {
      process.stdout.write(status.output.slice(shown));
      shown = status.output.length;
    }
    if (status.state === "done") break;
    if (status.state === "failed" || status.state === "expired")
      fail(`the deploy ${status.state} (exit code ${status.exitCode ?? "none"}).`);
  }
  console.log(`\nkitshn: deployed to https://${address}`);
}

const [command, ...args] = process.argv.slice(2);

/** K-1116: with `--json`, stdout holds only the result object; progress and notes go to stderr. */
const json = args.includes("--json");
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const transport = () => keyTransport(flag("--server", process.env["KITSHN_SERVER"] ?? ""));
if (isAgentCommand(command)) await runAgentCommand(command, args, transport);
// K-1777, K-1778: the same operations as the map and the machine, with the token of an actor.
else if (command !== undefined && isOpCommand(command)) {
  try {
    await runOpCommand(command, args, transport);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    console.error(`kitshn: ${error.message}`);
    process.exit(1);
  }
} else {
  if (json) console.log = console.error.bind(console);
  try {
    if (command === "check") console.log(JSON.stringify(loadApps(flag("--dir", ".")), null, 2));
    else if (command === "deploy") await deploy(flag("--server", ""), flag("--dir", "."));
  } catch (error) {
    if (json) {
      process.stdout.write(errorOutput(error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
    if (!(error instanceof CliError)) throw error;
    console.error(`kitshn: ${error.message}`);
    process.exit(1);
  }
}
if (
  command !== "check" &&
  command !== "deploy" &&
  !isAgentCommand(command) &&
  !(command !== undefined && isOpCommand(command))
) {
  console.log(`kitshn check [--dir <app>]                  check kitshn.config.ts and print it as JSON (K-802)
kitshn deploy --server <address> [--dir <app>]   deploy from GitHub Actions (K-803)
${AGENT_USAGE}
${OPS_HELP}
                                             with a token of an actor: --server or KITSHN_SERVER, and KITSHN_TOKEN=<client id>:<secret>`);
}
