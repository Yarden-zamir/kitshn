// K-815: `kitshn try` builds one app of the recipe file and runs it on this machine. It calls no kitshn server.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { bundleWorker, childEnv, insideRepo, runBuild } from "./build.ts";
import { CliError, errorText, fail } from "./cli-error.ts";
import { DEFAULT_SOCKET, appVariables, composeFiles } from "./compose.ts";
import {
  type Apps,
  type Recipe,
  STATIC_SITE,
  WORKER_ASSETS,
  type WorkerApp,
  workerBindingNames,
} from "./recipe.ts";

export interface TryOptions {
  readonly dir: string;
  /** `--app`; null takes the only app of the file. */
  readonly app: string | null;
  /** `--port`; null takes a free port. */
  readonly port: number | null;
  /** `--params-file`: an env file with the values that the app gets, as the params of a deploy (K-808). */
  readonly paramsFile: string | null;
  /** `--check`: stop after the route check, for agents and CI. */
  readonly check: boolean;
}

/** K-815: the wrangler that runs a static site or a Worker app here, pinned. npx downloads it, as esbuild (K-806). */
const WRANGLER = "wrangler@4.158.0";

/**
 * K-815: forwards the port of `try` to the socket of a Compose app. It is a container because Docker Desktop gives the
 * host no working socket that a container made in a bind mount, while another container can use it.
 */
const SOCAT_IMAGE =
  "alpine/socat:1.8.1.1@sha256:7f9a06753033f2b7de18edc2353f2c15153413d95a039163c6db270fc7a6c3b0";
const DOOR = "kitshn-try-door";

/** K-815: as long as the daemon waits for the socket of a deploy. */
const ANSWER_WAIT_MS = 180_000;

export function pickApp(apps: Apps, key: string | null): { readonly key: string; readonly recipe: Recipe } {
  const keys = Object.keys(apps);
  const picked = key ?? (keys.length === 1 ? keys[0] : undefined);
  if (picked === undefined)
    return fail(`kitshn.config.ts has the apps ${keys.join(", ")}; name one with --app.`);
  const recipe = Object.hasOwn(apps, picked) ? apps[picked] : undefined;
  if (!recipe) return fail(`kitshn.config.ts has no app ${picked}; it has ${keys.join(", ")}.`);
  return { key: picked, recipe };
}

/** K-815: the Compose service that publishes the socket of the app on this machine only. */
export const doorService = (socketDir: string, port: number) => ({
  services: {
    [DOOR]: {
      image: SOCAT_IMAGE,
      command: ["TCP-LISTEN:8080,fork,reuseaddr", `UNIX-CONNECT:/sockets/${DEFAULT_SOCKET}`],
      ports: [`127.0.0.1:${port}:8080`],
      volumes: [`${socketDir}:/sockets`],
    },
  },
});

/** K-815: the wrangler config of a static site, with the asset handling of its deploy (K-805). */
export const staticConfig = (output: string) => ({
  name: "kitshn-try",
  compatibility_date: STATIC_SITE.compatibilityDate,
  assets: { directory: output, ...STATIC_SITE.assets },
});

/**
 * K-815: the wrangler config of a Worker app: the bindings of its deploy (K-806), with local storage. Known limit: the
 * `KITSHN_ACCESS_*` values are missing (K-822), as there is no Access here.
 */
export function workerConfig(
  app: WorkerApp,
  paths: { readonly module: string; readonly assets: string | null },
) {
  const classes = [...new Set(Object.values(app.durableObjects ?? {}))].sort();
  const runWorkerFirst = app.assets?.runWorkerFirst;
  return {
    name: "kitshn-try",
    main: paths.module,
    no_bundle: true,
    compatibility_date: app.compatibilityDate,
    compatibility_flags: [...(app.compatibilityFlags ?? [])],
    kv_namespaces: (app.kv ?? []).map((binding) => ({ binding, id: binding })),
    durable_objects: {
      bindings: Object.entries(app.durableObjects ?? {}).map(([name, class_name]) => ({ name, class_name })),
    },
    migrations: classes.length === 0 ? [] : [{ tag: "kitshn-try", new_sqlite_classes: classes }],
    vars: { ...app.vars },
    ...(paths.assets === null
      ? {}
      : {
          assets: {
            directory: paths.assets,
            binding: "ASSETS",
            ...WORKER_ASSETS,
            ...(runWorkerFirst === undefined
              ? {}
              : {
                  run_worker_first:
                    typeof runWorkerFirst === "boolean" ? runWorkerFirst : [...runWorkerFirst],
                }),
          },
        }),
    ...(app.crons === undefined ? {} : { triggers: { crons: [...app.crons] } }),
  };
}

type Cleanup = () => Promise<void> | void;

/**
 * K-815: builds the app, runs it on `127.0.0.1`, and checks that its address answers. Without `check`, it runs until
 * Ctrl-C or until the app stops. Every exit removes what it made. True when the address answered below 500.
 */
export async function tryApp(apps: Apps, options: TryOptions): Promise<boolean> {
  const { key, recipe } = pickApp(apps, options.app);
  const dir = resolve(options.dir);
  if (options.paramsFile !== null && !existsSync(options.paramsFile))
    fail(`the params file ${options.paramsFile} does not exist.`);
  if ("static" in recipe && options.paramsFile !== null)
    fail("a static site has no runtime, so it takes no --params-file.");
  const needed = recipe.needs?.apps ?? [];
  if (needed.length > 0)
    console.log(`kitshn: try runs ${key} alone; it does not start ${needed.join(", ")}, which ${key} needs.`);
  // Before the build, so a Ctrl-C in the build still removes what try made.
  const stop = Promise.withResolvers<void>();
  const stopping = new AbortController();
  const onSignal = () => {
    stopping.abort();
    stop.resolve();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const root = mkdtempSync(join(tmpdir(), "kitshn-try-"));
  const cleanups: Array<Cleanup> = [];
  try {
    const port = options.port ?? (await freePort());
    const { exited } =
      "compose" in recipe
        ? await startCompose(dir, recipe.compose.file ?? null, root, port, options, cleanups, stopping.signal)
        : startWrangler(dir, recipe, root, port, options.paramsFile, cleanups);
    const address = `http://127.0.0.1:${port}/`;
    const answer = await firstAnswer(address, Promise.race([exited, stop.promise]));
    if (answer === null) {
      if (!stopping.signal.aborted) console.error(`kitshn: ${address} gave no answer.`);
      return false;
    }
    console.log(`kitshn: route check: ${answer.status} ${answer.contentType}`);
    const ok = answer.status < 500;
    if (options.check) return ok;
    console.log(`kitshn: ${key} runs at ${address}. Ctrl-C stops it and removes what try made.`);
    const stoppedByApp = await Promise.race([exited.then(() => true), stop.promise.then(() => false)]);
    if (stoppedByApp) console.error(`kitshn: ${key} stopped.`);
    return ok && !stoppedByApp;
  } finally {
    // The signal handlers stay until the end, and the cleanup steps run in their own process groups, so a second
    // Ctrl-C reaches neither.
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error(`kitshn: cleanup: ${errorText(error)}`);
      }
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      // A container can write files as root into the data folder.
      console.error(`kitshn: ${root} stays: ${errorText(error)}`);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** K-815: a Compose app on a temporary socket, with the folders and variables of a machine (K-607, K-812). */
async function startCompose(
  dir: string,
  file: string | null,
  root: string,
  port: number,
  { paramsFile }: TryOptions,
  cleanups: Array<Cleanup>,
  stopping: AbortSignal,
): Promise<Group> {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    fail("docker does not answer; kitshn try runs a Compose app with the Docker of this machine.");
  }
  let files: Array<string>;
  try {
    files = composeFiles(dir, file, existsSync, realpathSync);
  } catch (error) {
    return fail(errorText(error));
  }
  const socketDir = join(root, "s");
  const data = join(root, "data");
  const logs = join(root, "logs");
  const params = join(root, "params.env");
  for (const folder of [socketDir, data, logs]) mkdirSync(folder);
  // The container user may not be this user; the folder must take its socket.
  chmodSync(socketDir, 0o777);
  if (paramsFile === null) writeFileSync(params, "");
  else copyFileSync(paramsFile, params);
  chmodSync(params, 0o600);
  const door = join(root, "door.json");
  writeFileSync(door, JSON.stringify(doorService(socketDir, port)));
  const project = `kitshn-try-${process.pid}`;
  const compose = [
    "compose",
    "-p",
    project,
    "--project-directory",
    dir,
    ...files.flatMap((path) => ["-f", path]),
    "-f",
    door,
    "--env-file",
    params,
  ];
  const env = {
    ...childEnv(),
    ...appVariables({
      recipe: repoName(dir),
      environment: "try",
      deployment: project,
      socketDir,
      data,
      logs,
      params,
    }),
  };
  // Compose files from KitSHn 1 name this network, as on a machine. It stays, because other apps may use it.
  if (spawnSync("docker", ["network", "inspect", "kitshn-edge"], { stdio: "ignore" }).status !== 0)
    await run("docker network create", "docker", ["network", "create", "kitshn-edge"], { env });
  // Before `up`, so an `up` that fails half-way is taken down too.
  cleanups.push(() =>
    run(
      "docker compose down",
      "docker",
      [...compose, "down", "--remove-orphans", "--volumes", "--rmi", "local"],
      { env },
    ),
  );
  await run("docker compose up", "docker", [...compose, "up", "--detach", "--build", "--remove-orphans"], {
    cwd: dir,
    env,
    stopping,
  });
  // Only the services of the app: the door runs on after the app stops, and its logs would never end.
  const services = execFileSync("docker", [...compose, "config", "--services"], {
    cwd: dir,
    env,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name !== "" && name !== DOOR);
  const follow = startGroup("docker", [...compose, "logs", "--follow", ...services], { cwd: dir, env });
  cleanups.push(() => stopGroup(follow));
  return follow;
}

/** K-815: a static site or a Worker app in `wrangler dev`, built by the steps of its deploy (K-805, K-806). */
function startWrangler(
  dir: string,
  recipe: Exclude<Recipe, { readonly compose: unknown }>,
  root: string,
  port: number,
  paramsFile: string | null,
  cleanups: Array<Cleanup>,
): Group {
  let config: object;
  let crons = false;
  if ("static" in recipe) {
    if (recipe.static.build) runBuild(dir, recipe.static.build);
    config = staticConfig(insideRepo(dir, recipe.static.output, "the output folder"));
  } else {
    const app = recipe.worker;
    if (paramsFile !== null) {
      // K-806: the deploy refuses a value with the name of a binding, so try refuses it too.
      const names = workerBindingNames(app);
      const clash = Object.keys(parseEnv(readFileSync(paramsFile, "utf8"))).find((name) =>
        names.includes(name),
      );
      if (clash !== undefined)
        fail(`the params file gives ${clash}, which is the name of a binding of the recipe.`);
    }
    // A folder of its own: wrangler watches the folder of `main`, and the local storage changes all the time.
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    const { file } = bundleWorker(dir, app, bundle);
    const assets = app.assets ? insideRepo(dir, app.assets.folder, "the output folder") : null;
    config = workerConfig(app, { module: file, assets });
    crons = app.crons !== undefined;
  }
  const configFile = join(root, "wrangler.json");
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  if (crons) console.log("kitshn: crons do not run on their own here; open /__scheduled to run one.");
  const wrangler = startGroup(
    "npx",
    [
      "--yes",
      "--registry=https://registry.npmjs.org",
      WRANGLER,
      "dev",
      "--config",
      configFile,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--local",
      "--persist-to",
      join(root, "state"),
      "--show-interactive-dev-session=false",
      ...(paramsFile === null ? [] : ["--env-file", resolve(paramsFile)]),
      ...(crons ? ["--test-scheduled"] : []),
    ],
    { cwd: root, env: { ...childEnv(), WRANGLER_SEND_METRICS: "false" } },
  );
  cleanups.push(() => stopGroup(wrangler));
  return wrangler;
}

/** The first answer of the address, or null after ANSWER_WAIT_MS or when `gaveUp` settles. */
async function firstAnswer(
  address: string,
  gaveUp: Promise<void>,
): Promise<{ readonly status: number; readonly contentType: string } | null> {
  let over = false;
  void gaveUp.then(() => {
    over = true;
  });
  const until = Date.now() + ANSWER_WAIT_MS;
  while (!over && Date.now() < until) {
    try {
      const response = await fetch(address, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "no content type",
      };
    } catch {
      // Not up yet: the door closes the connection until the app opens its socket.
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  return null;
}

/** Known limit: another program can take the port before the app does. Revisit when that happens; --port avoids it. */
function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

/** A program in its own process group, so a Ctrl-C of the terminal does not reach it; `stopping` ends it. */
function run(
  title: string,
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv; readonly stopping?: AbortSignal },
): Promise<void> {
  const { stopping, ...spawnOptions } = options;
  return new Promise((done, failed) => {
    if (stopping?.aborted) return failed(new CliError(`${title} did not start: try stops.`));
    const child = spawn(program, args, {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      ...spawnOptions,
    });
    const end = () => signalGroup(child, "SIGTERM");
    stopping?.addEventListener("abort", end, { once: true });
    child.once("error", failed);
    child.once("close", (code) => {
      stopping?.removeEventListener("abort", end);
      if (code === 0) done();
      else if (stopping?.aborted) failed(new CliError(`${title} stopped: try stops.`));
      else failed(new CliError(`${title} failed with exit code ${code ?? "none"}.`));
    });
  });
}

type Group = { readonly child: ChildProcess; readonly exited: Promise<void> };

/** A program in its own process group, so a stop also ends its children (npx starts wrangler, wrangler workerd). */
function startGroup(
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Group {
  // No stdin: a background process group that reads the terminal stops.
  const child = spawn(program, args, { stdio: ["ignore", "inherit", "inherit"], detached: true, ...options });
  const exited = new Promise<void>((done) => {
    child.once("close", () => done());
    child.once("error", (error) => {
      console.error(`kitshn: ${program}: ${errorText(error)}`);
      done();
    });
  });
  return { child, exited };
}

function signalGroup(child: ChildProcess, name: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    // The group has ended.
  }
}

async function stopGroup(group: Group) {
  signalGroup(group.child, "SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const ended = await Promise.race([
    group.exited.then(() => true),
    new Promise<false>((done) => {
      timer = setTimeout(() => done(false), 10_000);
    }),
  ]);
  clearTimeout(timer);
  if (!ended) signalGroup(group.child, "SIGKILL");
}

/**
 * K-812: the `owner/repo` of the git remote `origin`, as the deploy names it. A folder without that remote gives its
 * own name, so an app that parses `owner/repo` gets no slash there.
 */
function repoName(dir: string): string {
  const remote = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" });
  const url = remote.status === 0 ? remote.stdout.trim() : "";
  const path = (url.endsWith(".git") ? url.slice(0, -4) : url).replaceAll(":", "/").split("/").slice(-2);
  return path.length === 2 && path.every((part) => part !== "") && url.includes("github.com")
    ? path.join("/")
    : basename(dir);
}
