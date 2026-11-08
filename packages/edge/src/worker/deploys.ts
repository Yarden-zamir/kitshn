import { ICON_LIMIT, type IconType, iconType } from "kitshn/icon";
import { DEFAULT_APP } from "kitshn/names";
import { type DeployEvent, WORKER_ASSETS, type WorkerApp, workerBindingNames } from "kitshn/recipe";
import type { AppAccess } from "../core/machine.ts";

/** K-903: kitshn refuses a new preview at this many Worker scripts in the account. */
export const SCRIPT_LIMIT = 90;
/** A planned deploy must finish within this time. */
export const DEPLOY_MS = 60 * 60 * 1000;
/**
 * K-1129: one part of an owner's folder upload passes through the Durable Object, which holds it in memory (128 MB).
 * A file is at most 25 MiB, so one file in base64 fits.
 */
export const FOLDER_PART_BYTES = 40 * 1024 * 1024;

const id = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The card id and the Worker script name of one environment of one app of a repo. The repo id keeps two repos with
 * similar names apart (my.site and my-site). K-804: the app `app` keeps the ids of a repo with one app; every other
 * app has its key after the repo id. The script name `kitshn-<card id>` stays within the 63 characters of Cloudflare.
 */
/** K-303, K-807: the pull request number of a `pr-<n>` environment, or null for any other environment. */
export function pullRequestNumber(environment: string): number | null {
  if (!environment.startsWith("pr-")) return null;
  const digits = environment.slice(3);
  const number = Number(digits);
  return digits !== "" && String(number) === digits && number > 0 ? number : null;
}

export function environmentNames(
  repoId: string,
  repo: string,
  environment: string,
  key: string = DEFAULT_APP,
) {
  const slug = slugOf(repo);
  const named = key === DEFAULT_APP ? environment : `${key}-${environment}`;
  const full = id(`app-${slug}-${repoId}-${named}`);
  // A long name keeps a hash instead of cutting it, so two environments never meet. The plan also checks the key of
  // the card (K-804), so a hash that two apps share fails instead of mixing them.
  const hashed = key === DEFAULT_APP ? environment : `${key}/${environment}`;
  const resourceId = full.length <= 56 ? full : `app-${slug}-${repoId}-${fnv(hashed)}`;
  return { resourceId, script: `kitshn-${resourceId}` };
}

const slugOf = (repo: string) => id(repo.split("/")[1] ?? repo).slice(0, 20);

/**
 * K-819: the repo id inside a card id that `environmentNames` made from this repo name and environment,
 * or null when the card id has another form (card ids from before the repo id, or another repo).
 */
export function repoIdOf(repo: string, environment: string, resourceId: string): string | null {
  const prefix = `app-${slugOf(repo)}-`;
  if (!resourceId.startsWith(prefix)) return null;
  const rest = resourceId.slice(prefix.length);
  const end = rest.indexOf("-");
  const candidate = end === -1 ? rest : rest.slice(0, end);
  if (candidate === "") return null;
  return environmentNames(candidate, repo, environment).resourceId === resourceId ? candidate : null;
}

/**
 * K-819: the repo ids of the deploy rows from before the gate, and the repos that count as allowed: each
 * repo with a finished deploy (a teardown alone does not count). `unknown` lists the rows without an id.
 * Later rows win the repo name.
 */
export function legacyRepos(
  deploys: ReadonlyArray<{
    readonly id: string;
    readonly repo: string;
    readonly environment: string;
    readonly resourceId: string;
    readonly kind: string;
    readonly state: string;
  }>,
) {
  const repoIds = new Map<string, string>();
  const allowed = new Map<string, string>();
  const unknown: Array<string> = [];
  for (const deploy of deploys) {
    const repoId = repoIdOf(deploy.repo, deploy.environment, deploy.resourceId);
    if (repoId === null) {
      unknown.push(deploy.id);
      continue;
    }
    repoIds.set(deploy.id, repoId);
    if (deploy.kind === "deploy" && deploy.state === "done") allowed.set(repoId, deploy.repo);
  }
  return { repoIds, allowed, unknown };
}

/** FNV-1a, 32 bits, as 8 hex characters. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * K-811: the event from the signed token. Only the pull request action comes from the request, because
 * the token has none; it can only open or close the preview of the token's own pull request.
 */
export function eventOf(
  deployer: { eventName: string; branch: string; pr: number | null },
  value: unknown,
): (DeployEvent & { readonly claimed?: true }) | string {
  // K-718: a dispatch (by an agent key through the App, or by a repo member) runs one branch's code,
  // so it plans as a push of that branch.
  if (deployer.eventName === "push" || deployer.eventName === "workflow_dispatch")
    return { name: "push", branch: deployer.branch, pr: null, action: null };
  if (deployer.eventName !== "pull_request") {
    return `kitshn deploys on push, pull_request and workflow_dispatch, not on ${deployer.eventName}.`;
  }
  const action =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)["action"] : null;
  if (typeof action !== "string") return "A pull request deploy needs its action.";
  if (deployer.pr !== null) return { name: "pull_request", branch: deployer.branch, pr: deployer.pr, action };
  // A closed pull request has no `refs/pull/<n>/` ref in its token, so its number comes from the request.
  // kitshn trusts it only to close the preview that the token's own head branch deployed (planDeploy).
  const pr = (value as Record<string, unknown>)["pr"];
  if (action !== "closed" || typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0)
    return { name: "pull_request", branch: deployer.branch, pr: null, action };
  return { name: "pull_request", branch: deployer.branch, pr, action, claimed: true };
}

/** The asset manifest of the direct upload flow: paths to a 32-hex hash and a size. */
export function parseManifest(value: unknown): Record<string, { hash: string; size: number }> | string {
  if (typeof value !== "object" || value === null) return "The deploy needs its file manifest.";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20_000) return "A static site has 1 to 20,000 files.";
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const [path, item] of entries) {
    const file = item as { hash?: unknown; size?: unknown } | null;
    if (!path.startsWith("/") || path.length > 500) return `The path ${path} is not valid.`;
    if (typeof file?.hash !== "string" || !/^[0-9a-f]{32}$/.test(file.hash))
      return `The hash of ${path} is not valid.`;
    if (typeof file.size !== "number" || file.size < 0 || file.size > 25 * 1024 * 1024) {
      return `${path} is larger than 25 MB, the limit of a static asset.`;
    }
    manifest[path] = { hash: file.hash, size: file.size };
  }
  return manifest;
}

/**
 * K-1113: the site icon that the CLI sends with `/deploy/finish`, as base64. Null means the site has none, so
 * kitshn drops a stored icon. A missing field is a CLI from before card icons: the stored icon stays.
 */
export function parseSiteIcon(
  value: unknown,
): { readonly bytes: Uint8Array; readonly type: IconType } | null | undefined | string {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return "The site icon must be base64 text or null.";
  // Base64 grows by 4/3, so a longer text cannot fit the limit; this check comes before the decode.
  if (value.length > Math.ceil(ICON_LIMIT / 3) * 4)
    return `The site icon is larger than ${ICON_LIMIT / 1024} KB.`;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return "The site icon is not valid base64.";
  }
  if (bytes.length === 0 || bytes.length > ICON_LIMIT)
    return `The site icon is empty or larger than ${ICON_LIMIT / 1024} KB.`;
  const type = iconType(bytes);
  if (type === null) return "The site icon is not a PNG, ICO, GIF, JPEG, WebP or SVG image.";
  return { bytes, type };
}

/** K-805: the most text of a `_headers` or `_redirects` file that kitshn passes on. */
export const CONFIG_FILE_LIMIT = 100_000;

/**
 * K-805: the `_headers` or `_redirects` file of a static site, which Cloudflare applies to its responses. Null or a
 * missing field (a CLI from before the file) means none.
 */
export function parseConfigFile(
  name: "_headers" | "_redirects",
  value: unknown,
): string | null | { readonly error: string } {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: `The ${name} file must be text or null.` };
  if (new TextEncoder().encode(value).length > CONFIG_FILE_LIMIT)
    return { error: `The ${name} file is larger than ${CONFIG_FILE_LIMIT / 1000} KB.` };
  return value;
}

/**
 * K-805: the Worker of a static site. Static assets answer every request first, so this code runs only
 * for a path that is not a file, and the free plan does not count asset requests.
 */
export const STATIC_WORKER = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n`;

/** K-1124: the one Worker that sends old site addresses on; `MAP` is a JSON object of old host to main address. */
export const REDIRECT_SCRIPT = "kitshn-redirects";

export const REDIRECT_WORKER = `export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const to = JSON.parse(env.MAP)[url.hostname];
    if (!to) return new Response("kitshn has no site here.", { status: 404 });
    return Response.redirect("https://" + to + url.pathname + url.search, 302);
  },
};
`;

/** K-806: the largest bundle that kitshn takes; the Free plan limit of 3 MB applies after gzip, which the CLI checks. */
export const WORKER_MODULE_LIMIT = 10 * 1024 * 1024;

/** K-806: the bundled Worker module that the CLI sends with `/deploy/finish`. */
export function parseWorkerModule(value: unknown): string | { readonly error: string } {
  if (typeof value !== "string" || value === "")
    return { error: "The deploy needs the bundled Worker module." };
  if (value.length > WORKER_MODULE_LIMIT)
    return { error: `The Worker bundle is larger than ${WORKER_MODULE_LIMIT / 1024 / 1024} MB.` };
  return value;
}

/**
 * K-806, K-808: the `KITSHN_<NAME>` values of the run, which the Worker gets as secret bindings `<NAME>`. kitshn
 * never stores them. Cloudflare takes at most 5 KB per secret.
 */
export function parseWorkerSecrets(
  value: unknown,
): { readonly secrets: Readonly<Record<string, string>> } | { readonly error: string } {
  if (value === undefined || value === null) return { secrets: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { error: "The secrets must be an object." };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) return { error: "A Worker takes at most 100 KITSHN_<NAME> values." };
  const secrets: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (!/^[A-Z0-9_]{1,64}$/.test(name)) return { error: `${name} is not a valid secret name.` };
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 5 * 1024)
      return { error: `The value of ${name} must be text of at most 5 KB.` };
    secrets[name] = text;
  }
  return { secrets };
}

/**
 * K-806: the upload metadata of a Worker app. kitshn sets everything that names a place: the KV namespace ids of
 * this environment and the script itself; the recipe gives only names. The Durable Object classes go in the
 * declarative `exports`, which Cloudflare reconciles with the classes that the script has on each deploy, so the
 * metadata depends only on the recipe and never on an earlier deploy. A class that leaves the recipe still has its
 * namespace, and Cloudflare refuses the upload; kitshn never sends a `deleted` entry.
 */
export function workerMetadata(
  app: WorkerApp,
  input: {
    readonly kv: ReadonlyMap<string, string>;
    readonly secrets: Readonly<Record<string, string>>;
    readonly access: AppAccess;
    readonly assets: {
      readonly jwt: string;
      readonly headers: string | null;
      readonly redirects: string | null;
    } | null;
  },
): { readonly metadata: Record<string, unknown> } | { readonly error: string } {
  const names = workerBindingNames(app);
  const clash = Object.keys(input.secrets).find((name) => names.includes(name));
  if (clash !== undefined)
    return { error: `KITSHN_${clash} gives a secret with the name of a binding of the recipe: ${clash}.` };
  if (app.assets !== undefined && input.assets === null)
    return { error: "The recipe names an assets folder, but the deploy sent no assets." };
  const bindings: Array<Record<string, string>> = [];
  if (app.assets !== undefined) bindings.push({ type: "assets", name: "ASSETS" });
  for (const name of app.kv ?? []) {
    const id = input.kv.get(name);
    if (id === undefined) return { error: `The KV namespace of ${name} is missing. Run the deploy again.` };
    bindings.push({ type: "kv_namespace", name, namespace_id: id });
  }
  for (const [name, className] of Object.entries(app.durableObjects ?? {}))
    bindings.push({ type: "durable_object_namespace", name, class_name: className });
  for (const [name, text] of Object.entries(app.vars ?? {}))
    bindings.push({ type: "plain_text", name, text });
  for (const [name, text] of Object.entries(input.secrets))
    bindings.push({ type: "secret_text", name, text });
  // K-822: a var or secret of the app with the same name wins.
  const access = {
    KITSHN_ACCESS_TEAM_DOMAIN: input.access.teamDomain,
    KITSHN_ACCESS_AUDIENCES: input.access.audiences.join(","),
  };
  for (const [name, text] of Object.entries(access))
    if (!names.includes(name) && !(name in input.secrets)) bindings.push({ type: "plain_text", name, text });
  const runWorkerFirst = app.assets?.runWorkerFirst;
  const classes = [...new Set(Object.values(app.durableObjects ?? {}))].sort();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: app.compatibilityDate,
    compatibility_flags: [...(app.compatibilityFlags ?? [])],
    bindings,
    observability: { enabled: true },
    ...(classes.length > 0
      ? {
          exports: Object.fromEntries(
            classes.map((name) => [name, { type: "durable-object", storage: "sqlite" }]),
          ),
        }
      : {}),
    ...(app.assets !== undefined && input.assets !== null
      ? {
          assets: {
            jwt: input.assets.jwt,
            config: {
              ...WORKER_ASSETS,
              ...(runWorkerFirst === undefined
                ? {}
                : {
                    run_worker_first:
                      typeof runWorkerFirst === "boolean" ? runWorkerFirst : [...runWorkerFirst],
                  }),
              ...(input.assets.headers ? { _headers: input.assets.headers } : {}),
              ...(input.assets.redirects ? { _redirects: input.assets.redirects } : {}),
            },
          },
        }
      : {}),
  };
  return { metadata };
}

/** K-821: the image ids that a daemon reports for a Compose build, as JSON for the deploy row, or null. */
export function keptImages(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && /^sha256:[0-9a-f]{64}$/.test(entry[1]),
    )
    .slice(0, 50);
  return entries.length === 0 ? null : JSON.stringify(Object.fromEntries(entries));
}

/** K-820: the error that a failed Compose job of the daemon names at the end of its output, for the card. */
export function jobError(output: string): string {
  return /\[kitshn: ([^\]]{1,400})\]\s*$/.exec(output)?.[1] ?? "The machine job failed.";
}

/**
 * K-1119: the newest deploy of a repo (any case), app and environment that was not skipped. Anyone can ask for any
 * name, so the index deploys_badge (migration 20) serves it; public-cards.test.ts checks the plan of this query.
 */
export const BADGE_DEPLOY_QUERY = `SELECT resource_id, state, expires_at FROM deploys WHERE lower(repo) = lower(?)
  AND app_key = ? AND environment = ? AND kind = 'deploy' AND state != 'skipped' ORDER BY rowid DESC LIMIT 1`;
