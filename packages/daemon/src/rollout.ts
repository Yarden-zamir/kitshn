// K-636: the Worker step of `kitshn rollout <version>`: the bootstrap script of that release, run from this machine
// with the account token. Known limit: only a machine with CLOUDFLARE_API_TOKEN deploys the Worker, so an agent
// without it runs `kitshn rollout` for the daemons only. Revisit when the Worker can deploy a release itself.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "kitshn/cli-error";
import { RELEASES, expectedHash } from "./service.ts";

/** K-617: a release names the first 12 hex digits of its commit. */
export const isReleaseVersion = (version: string) =>
  version.length === 12 && [...version].every((char) => "0123456789abcdef".includes(char));

/** K-1203: the bootstrap script of each release, beside its bundle. */
export const INSTALL_ASSET = "kitshn-install.sh";

/** How long the Worker may take to answer with the new release after the script ended. */
const LIVE_WAIT_MS = 120_000;

const liveVersion = async (server: string) => {
  const response = await fetch(new URL("/deploy/version", server), { cache: "no-store" });
  if (!response.ok) throw new CliError(`${server}/deploy/version answered ${response.status}.`);
  return (await response.text()).trim();
};

/**
 * K-636: deploys the Worker of `version` with the bootstrap of that release, unless kitshn runs it already. Prints the
 * changed lines and the path of the full log; the script never prints the token (K-1815).
 */
export async function deployWorker(version: string, server: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!isReleaseVersion(version))
    throw new CliError(`${version} is no release: name the 12 hex digits of edge-<version>.`);
  const before = await liveVersion(server);
  if (before === version) {
    console.log(`kitshn runs edge-${version} already; the rollout goes on with the daemons.`);
    return;
  }
  const missing = ["CLOUDFLARE_API_TOKEN", "KITSHN_OWNER_EMAILS"].filter((name) => !env[name]);
  if (missing.length > 0)
    throw new CliError(
      `kitshn runs edge-${before}. Deploying edge-${version} needs ${missing.join(" and ")} on this machine; without them, run kitshn rollout with no version on any machine after a deploy (K-636).`,
    );
  if (env["KITSHN_BACKUP_KEY_NOW"])
    throw new CliError(
      "kitshn rollout refuses KITSHN_BACKUP_KEY_NOW: the owner runs that step in their own terminal (K-1815).",
    );
  const base = `${RELEASES}/edge-${version}`;
  const [sums, script] = await Promise.all([fetch(`${base}/SHA256SUMS`), fetch(`${base}/${INSTALL_ASSET}`)]);
  if (!sums.ok || !script.ok)
    throw new CliError(
      `The release edge-${version} has no ${INSTALL_ASSET}; a release before K-636 deploys only with the bootstrap of its checkout.`,
    );
  const bytes = new Uint8Array(await script.arrayBuffer());
  if (expectedHash(await sums.text(), INSTALL_ASSET) !== createHash("sha256").update(bytes).digest("hex"))
    throw new CliError(`${INSTALL_ASSET} of edge-${version} does not match its SHA256SUMS.`);
  const folder = mkdtempSync(join(tmpdir(), "kitshn-rollout-"));
  const file = join(folder, INSTALL_ASSET);
  writeFileSync(file, bytes, { mode: 0o600 });
  const log = join(folder, "bootstrap.log");
  console.log(`Deploy kitshn edge-${version} (now edge-${before}); full log: ${log}`);
  const code = await new Promise<number | null>((resolve, reject) => {
    const out = createWriteStream(log, { mode: 0o600 });
    const child = spawn("sh", [file], {
      env: { ...env, KITSHN_HOST: new URL(server).host, KITSHN_BUNDLE: `${base}/kitshn-edge.tar.gz` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const show = (chunk: Buffer) => {
      out.write(chunk);
      // The script's own errors start with "kitshn:" and name a permission, never a token value.
      for (const line of chunk.toString().split("\n"))
        if (line.startsWith("  changed:") || line.startsWith("kitshn:")) console.log(line);
    };
    child.stdout.on("data", show);
    child.stderr.on("data", show);
    child.on("error", reject);
    child.on("close", (status) => out.end(() => resolve(status)));
  });
  if (code !== 0) throw new CliError(`The bootstrap of edge-${version} failed (exit ${code}); see ${log}.`);
  const end = Date.now() + LIVE_WAIT_MS;
  while ((await liveVersion(server)) !== version) {
    if (Date.now() > end)
      throw new CliError(`kitshn does not answer with edge-${version} 2 minutes after the bootstrap.`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  console.log(`kitshn runs edge-${version}.`);
}
