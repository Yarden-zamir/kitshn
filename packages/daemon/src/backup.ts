// K-1811 to K-1820: backups of Compose apps with restic, through a local proxy to kitshn.
import { BACKUP_POLICY, type BackupReport, PACK_MIB } from "@kitshn/edge/backups";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobSocketFolder, socketPathProblem } from "./sockets.ts";

/** busybox, pinned by digest, so no app can take the name with an image of its own (K-818). */
export const HELPER_IMAGE =
  "busybox:1.38@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e";

/** K-1812: restic 0.19.1, the multi-arch image index pinned by digest. */
export const RESTIC_IMAGE =
  "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";

/** restic exits with 10 when the repository does not exist (restic 0.17 and later). */
const NO_REPOSITORY = 10;

/** K-1820: the folder names that a restore uses inside each volume and the data folder. */
const RESTORING = ".kitshn-restore";
const BEFORE = ".kitshn-before";
const MOVED_IN = ".kitshn-moved-in";

/** K-1820: a run that holds the state from before a restore keeps this tag for 7 days. */
export const BEFORE_TAG = "before-restore";

export interface Machine {
  readonly server: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The data folder of the daemon; apps live in `apps/<card>`. */
  readonly data: string;
}

export interface Outcome {
  readonly ok: boolean;
  readonly output: string;
  /** Also on a failed restore, when its first backup was made, so the way back stays (K-1820). */
  readonly backup?: BackupReport;
}

/** One volume or the data folder: `volume` names a Docker volume, `folder` a host path. */
export type Source = { readonly name: string } & ({ readonly volume: string } | { readonly folder: string });

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program to its end and keeps the end of its output. */
function run(
  program: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-1_000_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
  });
}

async function must(what: string, program: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) {
  const ran = await run(program, args, env);
  if (ran.code !== 0)
    throw new Error(`${what} failed (${String(ran.code)}): ${ran.stderr.trim().slice(-2000)}`);
  return ran.stdout;
}

/**
 * K-1813: a proxy on a Unix socket that adds the machine's Access headers. It lives as long as one job, and it
 * answers only requests below a random secret path, so nothing else on the machine can use it.
 */
export function startProxy(machine: Machine, card: string, folder: string) {
  const socket = join(folder, "proxy.sock");
  const tooLong = socketPathProblem(socket, process.platform);
  if (tooLong) throw new Error(tooLong);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  rmSync(socket, { force: true });
  const secret = crypto.randomUUID();
  const base = new URL(`/connect/backups/${encodeURIComponent(card)}`, machine.server);
  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`/${secret}/`)) return new Response("Wrong path.", { status: 403 });
      const headers = new Headers({
        "CF-Access-Client-Id": machine.clientId,
        "CF-Access-Client-Secret": machine.clientSecret,
      });
      for (const name of ["content-type", "range", "accept"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      // A pack is at most 32 MiB; a whole body gets a Content-Length, which the Worker needs to stream it to R2.
      const body = request.method === "POST" ? await request.arrayBuffer() : undefined;
      return fetch(`${base.href}${url.pathname.slice(secret.length + 1)}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    },
  });
  return {
    socket,
    repository: `rest:http+unix:///run/kitshn/proxy.sock:/${secret}/`,
    stop: () => {
      void server.stop(true);
      rmSync(socket, { force: true });
    },
  };
}

/** K-1815: the repository password, which kitshn gives only while this machine runs a job of the card. */
async function password(machine: Machine, card: string): Promise<string> {
  const response = await fetch(new URL(`/connect/backups/${encodeURIComponent(card)}/key`, machine.server), {
    headers: { "CF-Access-Client-Id": machine.clientId, "CF-Access-Client-Secret": machine.clientSecret },
  });
  if (!response.ok)
    throw new Error(`kitshn answered ${response.status} for the backup key: ${await response.text()}`);
  return ((await response.json()) as { password: string }).password;
}

/** K-1811: the named volumes of the project and its data folder, when they exist. */
export async function sources(data: string, card: string): Promise<Array<Source>> {
  const listed = await must("docker volume ls", "docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${card}`,
  ]);
  const volumes = listed
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((volume): Source => ({ name: `volume-${volume}`, volume }));
  const folder = join(data, "apps", card, "data");
  return existsSync(folder) ? [...volumes, { name: "data", folder }] : volumes;
}

const mountOf = (source: Source) => ("volume" in source ? source.volume : source.folder);

/** The `summary` line of `restic backup --json`. */
export function backupSummary(stdout: string): { snapshot: string; bytes: number; added: number } {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message["message_type"] !== "summary") continue;
    const snapshot = message["snapshot_id"];
    const bytes = message["total_bytes_processed"];
    const added = message["data_added"];
    if (typeof snapshot !== "string" || typeof bytes !== "number" || typeof added !== "number")
      throw new Error(`restic sent a summary that kitshn cannot read: ${line.slice(0, 300)}`);
    return { snapshot, bytes, added };
  }
  throw new Error("restic sent no summary.");
}

/** K-1817: the runs that a repository still holds, from `restic snapshots --json`. */
export function keptRuns(stdout: string): Array<string> {
  const snapshots = JSON.parse(stdout) as Array<{ tags?: Array<string> }>;
  return snapshots.flatMap((snapshot) =>
    (snapshot.tags ?? []).filter((tag) => tag.startsWith("run-")).map((tag) => tag.slice("run-".length)),
  );
}

/**
 * K-1812: restic runs in a container, as root of the rootless user namespace, so it reads files that a container
 * of the app owns. Each source is a folder `/data/<name>`, so a later run skips files whose metadata did not
 * change. The password comes from the environment of this call, never from the command line.
 */
class Restic {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly socket: string,
    private readonly cache: string,
    private readonly card: string,
  ) {}

  args(all: ReadonlyArray<Source>, writable: boolean, name: string | null, command: ReadonlyArray<string>) {
    return [
      "run",
      "--rm",
      ...(name ? ["--name", name] : []),
      "--network",
      "none",
      "-e",
      "RESTIC_REPOSITORY",
      "-e",
      "RESTIC_PASSWORD",
      "-e",
      "RESTIC_PACK_SIZE",
      "-e",
      "RESTIC_CACHE_DIR=/cache",
      "-v",
      `${this.socket}:/run/kitshn/proxy.sock`,
      "-v",
      `${this.cache}:/cache`,
      ...all.flatMap((source) => ["-v", `${mountOf(source)}:/data/${source.name}${writable ? "" : ":ro"}`]),
      RESTIC_IMAGE,
      ...command,
    ];
  }

  call(what: string, command: ReadonlyArray<string>, all: ReadonlyArray<Source> = [], writable = false) {
    return must(what, "docker", this.args(all, writable, null, command), this.env);
  }

  probe(command: ReadonlyArray<string>) {
    return run("docker", this.args([], false, null, command), this.env);
  }

  /** One snapshot of all sources; `name` lets a time limit kill the container. */
  async backup(all: ReadonlyArray<Source>, tags: ReadonlyArray<string>, name: string | null = null) {
    const stdout = await must(
      "restic backup",
      "docker",
      this.args(all, false, name, [
        "backup",
        "--json",
        "--host",
        `kitshn-${this.card}`,
        ...tags.flatMap((tag) => ["--tag", tag]),
        "--exclude",
        `/data/*/${RESTORING}`,
        "--exclude",
        `/data/*/${BEFORE}`,
        "--exclude",
        `/data/*/${MOVED_IN}`,
        "/data",
      ]),
      this.env,
    );
    return backupSummary(stdout);
  }
}

async function openRepository(machine: Machine, card: string, socket: string, repository: string) {
  const cache = join(machine.data, "cache", "restic", card);
  mkdirSync(cache, { recursive: true });
  const env = {
    ...process.env,
    RESTIC_REPOSITORY: repository,
    RESTIC_PASSWORD: await password(machine, card),
    RESTIC_PACK_SIZE: String(PACK_MIB),
  };
  const restic = new Restic(env, socket, cache, card);
  const opened = await restic.probe(["cat", "config"]);
  if (opened.code === NO_REPOSITORY) await restic.call("restic init", ["init"]);
  else if (opened.code !== 0)
    throw new Error(`restic cannot open the repository: ${opened.stderr.trim().slice(-1000)}`);
  return restic;
}

/** K-1816: the marker of a paused app; the daemon unpauses each marked app when it starts. */
const markerOf = (data: string, card: string) => join(data, "paused", card);

/** K-1816: the daemon unpauses each marked app when it starts; a failed unpause keeps the marker for the next start. */
export async function unpauseMarked(data: string, log: (text: string) => void) {
  const folder = join(data, "paused");
  if (!existsSync(folder)) return;
  for (const card of readdirSync(folder)) {
    const ran = await run("docker", ["compose", "-p", card, "unpause"]);
    log(
      `unpause of ${card} after a stop in the middle of a backup: ${ran.code === 0 ? "done" : ran.stderr.trim()}`,
    );
    if (ran.code === 0) rmSync(join(folder, card), { force: true });
  }
}

/** K-1816: unpauses every service of the app; a failure keeps the marker, so the next daemon start tries again. */
async function unpause(card: string, marker: string) {
  const ran = await run("docker", ["compose", "-p", card, "unpause"]);
  if (ran.code !== 0)
    throw new Error(
      `docker compose unpause failed, and the next daemon start tries again: ${ran.stderr.trim()}`,
    );
  rmSync(marker, { force: true });
}

/**
 * K-1816: a pass while the app runs (the bulk), then a pass while it is paused (the changes). Only the paused pass
 * stays, as the run `runId`; the live pass goes also when the paused pass fails.
 */
async function backupRun(
  restic: Restic,
  machine: Machine,
  card: string,
  runId: string,
  tags: ReadonlyArray<string>,
  limitMs: number,
): Promise<BackupReport> {
  const all = await sources(machine.data, card);
  if (all.length === 0) throw new Error(`${card} has no volume and no data folder to back up.`);
  const live = await restic.backup(all, [`live-${runId}`]);
  // An app with no running container writes nothing, so it needs no pause.
  const running =
    (
      await must("docker compose ps", "docker", ["compose", "-p", card, "ps", "-q", "--status", "running"])
    ).trim() !== "";
  const marker = markerOf(machine.data, card);
  const container = `kitshn-backup-${runId}`;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let pausedAt = 0;
  let paused: Awaited<ReturnType<Restic["backup"]>>;
  try {
    if (running) {
      mkdirSync(join(machine.data, "paused"), { recursive: true });
      writeFileSync(marker, runId);
      pausedAt = Date.now();
      await must("docker compose pause", "docker", ["compose", "-p", card, "pause"]);
    }
    limit = setTimeout(() => void run("docker", ["kill", container]), limitMs);
    paused = await restic.backup(all, [`run-${runId}`, ...tags], container);
  } catch (error) {
    throw new Error(
      `the pause or the paused pass failed, or ran longer than ${Math.round(limitMs / 1000)} s, so the app runs on without it: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (limit) clearTimeout(limit);
    try {
      if (running) await unpause(card, marker);
    } finally {
      await restic.call("restic forget of the live pass", ["forget", live.snapshot]);
    }
  }
  return {
    run: runId,
    bytes: paused.bytes,
    added: live.added + paused.added,
    sources: all.map((source) => source.name),
    pauseMs: running ? Date.now() - pausedAt : 0,
  };
}

/** K-1817: the runs from before a restore, which are older than 7 days, by their own time. */
export function oldWaysBack(stdout: string, now: number): Array<string> {
  const snapshots = JSON.parse(stdout) as Array<{ id: string; time: string }>;
  return snapshots
    .filter((snapshot) => Date.parse(snapshot.time) < now - 7 * 24 * 3_600_000)
    .map((snapshot) => snapshot.id);
}

/** K-1817, K-1820: the retention, which keeps a run from before a restore for 7 days from its own time. */
async function forget(restic: Restic, prune: boolean) {
  await restic.call("restic forget", [
    "forget",
    "--group-by",
    "host",
    ...BACKUP_POLICY,
    "--keep-tag",
    BEFORE_TAG,
  ]);
  const old = oldWaysBack(
    await restic.call("restic snapshots", ["snapshots", "--json", "--tag", BEFORE_TAG]),
    Date.now(),
  );
  if (old.length > 0) await restic.call("restic forget of old ways back", ["forget", ...old]);
  if (prune) await restic.call("restic prune", ["prune"]);
  return keptRuns(await restic.call("restic snapshots", ["snapshots", "--json"]));
}

/** K-1816, K-1817 */
export async function backup(
  machine: Machine,
  card: string,
  run: string,
  prune: boolean,
  limitMs: number,
  /** K-827: `<card>@<machine id>` for an instance that is not the home one. */
  repository = card,
): Promise<Outcome> {
  const folder = jobSocketFolder(machine.data, run);
  const proxy = startProxy(machine, repository, folder);
  try {
    const restic = await openRepository(machine, repository, proxy.socket, proxy.repository);
    const report = await backupRun(restic, machine, card, run, [], limitMs);
    const kept = await forget(restic, prune);
    return {
      ok: true,
      output: `backed up ${card} as ${run}${prune ? ", and pruned" : ""}`,
      backup: { ...report, kept },
    };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  } finally {
    proxy.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Runs a shell script of the helper image in one source, with the source at `/s`. */
const inSource = (what: string, source: Source, script: string) =>
  must(`${what} in ${source.name}`, "docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${mountOf(source)}:/s`,
    HELPER_IMAGE,
    "sh",
    "-c",
    script,
  ]);

/** Every entry of a folder, also hidden ones, as busybox `sh` globs; a pattern with no match stays as it is. */
const ENTRIES = (folder: string) => `${folder}/* ${folder}/.[!.]* ${folder}/..?*`;

/**
 * K-1820: the swap. Each `mv` stops the script on a failure (`set -e`). The files of now move to `.kitshn-before`;
 * each restored entry that moves in is written to `.kitshn-moved-in` first, so the way back removes only those.
 */
export const SWAP = `set -e
cd /s
mkdir ${BEFORE}
for f in ${ENTRIES(".")}; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  case "$f" in ./${BEFORE}|./${RESTORING}|./${MOVED_IN}) continue ;; esac
  mv -- "$f" ${BEFORE}/
done
: > ${MOVED_IN}
for f in ${ENTRIES(RESTORING)}; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  printf '%s\\n' "\${f#${RESTORING}/}" >> ${MOVED_IN}
  mv -- "$f" ./
done
rmdir ${RESTORING}`;

/** K-1820: the way back after a failed swap: only the entries that moved in go, and the files of now come back. */
export const UNSWAP = `set -e
cd /s
[ -d ${BEFORE} ] || exit 0
if [ -f ${MOVED_IN} ]; then
  while IFS= read -r f; do rm -rf -- "./$f"; done < ${MOVED_IN}
  rm ${MOVED_IN}
fi
for f in ${ENTRIES(BEFORE)}; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  mv -- "$f" ./
done
rmdir ${BEFORE}`;

const CLEAN_RESTORE = `rm -rf /s/${RESTORING}`;
const CLEAN_BEFORE = `rm -rf /s/${BEFORE} /s/${MOVED_IN}`;

/** K-1820: where a restore is, so a daemon that stops in the middle finishes it at its next start. */
type RestorePhase = "writing" | "swapping" | "cleaning";
const restoreMarkerOf = (data: string, card: string) => join(data, "restoring", card);

function markRestore(data: string, card: string, phase: RestorePhase, used: ReadonlyArray<Source>) {
  mkdirSync(join(data, "restoring"), { recursive: true });
  writeFileSync(restoreMarkerOf(data, card), JSON.stringify({ phase, sources: used }));
}

/**
 * K-1820: after a stop in the middle of a restore. While writing: the new copies go. While swapping: the app
 * stops, the files of now come back, and the app starts. While cleaning: the old files go.
 */
export async function finishRestores(data: string, log: (text: string) => void) {
  const folder = join(data, "restoring");
  if (!existsSync(folder)) return;
  for (const card of readdirSync(folder)) {
    const marker = JSON.parse(readFileSync(join(folder, card), "utf8")) as {
      phase: RestorePhase;
      sources: Array<Source>;
    };
    try {
      if (marker.phase === "swapping")
        await must("docker compose stop", "docker", ["compose", "-p", card, "stop"]);
      for (const source of marker.sources) {
        if (marker.phase === "swapping") await inSource("way back", source, UNSWAP);
        await inSource("clean-up", source, marker.phase === "cleaning" ? CLEAN_BEFORE : CLEAN_RESTORE);
      }
      if (marker.phase === "swapping")
        await must("docker compose start", "docker", ["compose", "-p", card, "start"]);
      rmSync(join(folder, card), { force: true });
      log(`finished the restore of ${card} that stopped while ${marker.phase}`);
    } catch (error) {
      log(`the restore of ${card} that stopped while ${marker.phase} needs a hand: ${String(error)}`);
    }
  }
}

/**
 * K-1820: checks every source before the app stops, backs up the state of now as `before`, writes the run into
 * `.kitshn-restore` of each source while the app runs, and swaps only when every write-back worked. The point of no
 * return is a swap whose app started: after it, a failed clean-up is only a note, and the next start cleans up.
 */
export async function restore(
  machine: Machine,
  card: string,
  run: string,
  before: string,
  wanted: ReadonlyArray<string>,
  limitMs: number,
  /** K-827: as for `backup`. */
  repository = card,
): Promise<Outcome> {
  const folder = jobSocketFolder(machine.data, before);
  const proxy = startProxy(machine, repository, folder);
  let report: BackupReport | undefined;
  let stopped = false;
  let used: Array<Source> = [];
  const swapped: Array<Source> = [];
  try {
    const all = await sources(machine.data, card);
    const missing = wanted.filter((name) => !all.some((source) => source.name === name));
    if (missing.length > 0)
      throw new Error(`The app has no ${missing.join(", ")} now, so kitshn changed nothing.`);
    used = all.filter((source) => wanted.includes(source.name));
    const restic = await openRepository(machine, repository, proxy.socket, proxy.repository);
    const [snapshot] = JSON.parse(
      await restic.call("restic snapshots", ["snapshots", "--json", "--tag", `run-${run}`]),
    ) as Array<{ id: string }>;
    if (!snapshot) throw new Error(`The backup run ${run} has no snapshot in the repository.`);
    report = await backupRun(restic, machine, card, before, [BEFORE_TAG], limitMs);
    markRestore(machine.data, card, "writing", used);
    for (const source of used) {
      await inSource("clean-up", source, `${CLEAN_RESTORE} && ${CLEAN_BEFORE}`);
      await restic.call(
        `restic restore of ${source.name}`,
        ["restore", `${snapshot.id}:/data/${source.name}`, "--target", `/data/${source.name}/${RESTORING}`],
        [source],
        true,
      );
    }
    markRestore(machine.data, card, "swapping", used);
    await must("docker compose stop", "docker", ["compose", "-p", card, "stop"]);
    stopped = true;
    for (const source of used) {
      swapped.push(source);
      await inSource("swap", source, SWAP);
    }
    await must("docker compose start", "docker", ["compose", "-p", card, "start"]);
  } catch (error) {
    const notes = [
      `The restore failed, and the data of before stays: ${error instanceof Error ? error.message : String(error)}`,
    ];
    // A start that failed half-way leaves some services running; they stop before the files of now come back.
    if (stopped)
      await must("docker compose stop", "docker", ["compose", "-p", card, "stop"]).catch((stop: unknown) =>
        notes.push(String(stop)),
      );
    for (const source of swapped)
      await inSource("way back", source, UNSWAP).catch((undo: unknown) => notes.push(String(undo)));
    for (const source of used)
      await inSource("clean-up", source, CLEAN_RESTORE).catch((clean: unknown) => notes.push(String(clean)));
    if (stopped)
      await must("docker compose start", "docker", ["compose", "-p", card, "start"]).catch((start: unknown) =>
        notes.push(String(start)),
      );
    if (notes.length === 1) rmSync(restoreMarkerOf(machine.data, card), { force: true });
    proxy.stop();
    rmSync(folder, { recursive: true, force: true });
    return { ok: false, output: notes.join("\n"), ...(report ? { backup: report } : {}) };
  }
  // The point of no return: the restored data serves. A clean-up that fails is a note; the next daemon start does it.
  markRestore(machine.data, card, "cleaning", used);
  const left: Array<string> = [];
  for (const source of used)
    await inSource("clean-up", source, CLEAN_BEFORE).catch((clean: unknown) => left.push(String(clean)));
  if (left.length === 0) rmSync(restoreMarkerOf(machine.data, card), { force: true });
  proxy.stop();
  rmSync(folder, { recursive: true, force: true });
  return {
    ok: true,
    output: [
      `restored ${card} to ${run}; the state from before is ${before}`,
      ...left.map((note) => `clean-up left for the next daemon start: ${note}`),
    ].join("\n"),
    backup: report,
  };
}
