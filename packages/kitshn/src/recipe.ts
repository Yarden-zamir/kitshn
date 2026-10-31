import { Schema } from "effect";
import { DEFAULT_APP, RESERVED_SITE_NAMES } from "./names.ts";
import type {
  ComposeApp as PublicComposeApp,
  DeployEntry as PublicDeployEntry,
  NativeApp as PublicNativeApp,
  Recipe as PublicRecipe,
  StaticApp as PublicStaticApp,
  WorkerApp as PublicWorkerApp,
} from "./index.ts";

/**
 * K-817: the most addresses of one environment. Each costs Cloudflare API calls in one deploy request, and the free
 * plan allows 50 there (K-406); 5 keeps a new static site with all of its custom domains under that.
 */
export const MAX_ADDRESSES = 5;

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9{}-]{0,40}$/));

/** One entry of `deploy` (K-807). The first entry that matches the event wins. */
export const DeployEntry = Schema.Struct({
  on: Schema.Literals(["push", "pull_request"]),
  /** For `push`: the branch. Without it, every branch matches. */
  branch: Schema.optionalKey(Schema.String),
  /** The environment name. `{pr}` becomes the pull request number. */
  name: Name,
  /**
   * The address, one level under a kitshn zone (K-901). Without it, kitshn picks `<repo>[-<name>].<zone>`. A
   * `push` entry may list several (K-817); each serves the app. A list item stays a string, so a later item kind
   * (a redirect) can join it.
   */
  address: Schema.optionalKey(
    Schema.Union([
      Schema.String,
      Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ADDRESSES)),
    ]),
  ),
  /** A pull request environment that kitshn removes when the pull request closes (K-904). */
  ephemeral: Schema.optionalKey(Schema.Boolean),
  /** The circle that a new environment starts in (K-807). Without it, the card waits in the tray, private. */
  startsIn: Schema.optionalKey(Schema.String),
});
export type DeployEntry = typeof DeployEntry.Type;

/** K-805: a static site. Actions runs `build`, then uploads `output`. */
export const StaticApp = Schema.Struct({
  build: Schema.optionalKey(Schema.String),
  output: Schema.String,
});

/**
 * K-804, K-812: a Compose app. A machine with all `runsOn` labels builds and runs `file`. The app listens on
 * the socket `$KITSHN_DEFAULT_SOCKET` (K-607), as in KitSHn 1, and the tunnel sends the address there.
 */
/** A relative path that stays inside the repo; the CLI checks it again after symlinks. */
const RepoPath = Schema.String.check(
  Schema.makeFilter((path) =>
    path === "" || path.startsWith("/") || path.split("/").includes("..")
      ? "the path must be inside the repo"
      : undefined,
  ),
);

export const ComposeApp = Schema.Struct({
  runsOn: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(10))),
  /** K-818: a path inside the repo; the daemon checks it again after symlinks. */
  file: Schema.optionalKey(RepoPath),
});

/** Native services are schema-only until their guarded machine lifecycle is implemented. */
const NativePath = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._/-]+$/),
  Schema.makeFilter((path) =>
    path.split("/").some((part) => part === "" || part === "." || part === "..")
      ? "the executable must be a relative path inside the artifact"
      : undefined,
  ),
);
export const NativeApp = Schema.Struct({
  runsOn: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(10))),
  executable: NativePath,
  args: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(
        Schema.isMaxLength(1024),
        Schema.makeFilter((arg) =>
          [...arg].some((char) => {
            const code = char.codePointAt(0) ?? 0;
            return code < 32 || (code >= 127 && code <= 159);
          })
            ? "an argument cannot contain control characters"
            : undefined,
        ),
      ),
    ).check(Schema.isMaxLength(32)),
  ),
  site: Schema.optionalKey(
    Schema.Struct({
      port: Schema.Number.check(
        Schema.makeFilter((port) =>
          Number.isInteger(port) && port >= 1 && port <= 65535
            ? undefined
            : "the port must be an integer from 1 to 65535",
        ),
      ),
    }),
  ),
});

/** K-806: a binding or class name, a JavaScript identifier. */
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/));

/** K-806: a Worker app. Each binding name is unique in the app; `ASSETS` belongs to the assets folder. */
export const WorkerApp = Schema.Struct({
  main: RepoPath,
  compatibilityDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  compatibilityFlags: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,80}$/))).check(Schema.isMaxLength(20)),
  ),
  build: Schema.optionalKey(Schema.String),
  assets: Schema.optionalKey(
    Schema.Struct({
      folder: RepoPath,
      runWorkerFirst: Schema.optionalKey(
        Schema.Union([
          Schema.Boolean,
          Schema.Array(Schema.String.check(Schema.isPattern(/^!?\/\S{0,200}$/))).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(20),
          ),
        ]),
      ),
    }),
  ),
  kv: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(10))),
  durableObjects: Schema.optionalKey(Schema.Record(Identifier, Identifier).check(Schema.isMaxProperties(10))),
  crons: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^\S+( \S+){4,5}$/))).check(Schema.isMaxLength(3)),
  ),
  vars: Schema.optionalKey(
    Schema.Record(Identifier, Schema.String.check(Schema.isMaxLength(5000))).check(
      Schema.isMaxProperties(50),
    ),
  ),
}).check(
  Schema.makeFilter((app) => {
    const names = workerBindingNames(app);
    const twice = names.find((name, index) => names.indexOf(name) !== index);
    return twice === undefined ? undefined : `the binding name ${twice} is used twice`;
  }),
);

export type WorkerApp = typeof WorkerApp.Type;

/** K-806: every binding name that the recipe gives the Worker, `ASSETS` for the assets folder. */
export const workerBindingNames = (app: {
  readonly assets?: unknown;
  readonly kv?: ReadonlyArray<string>;
  readonly durableObjects?: { readonly [binding: string]: string };
  readonly vars?: { readonly [name: string]: string };
}): Array<string> => [
  ...(app.assets === undefined ? [] : ["ASSETS"]),
  ...(app.kv ?? []),
  ...Object.keys(app.durableObjects ?? {}),
  ...Object.keys(app.vars ?? {}),
];

const deploy = Schema.Array(DeployEntry).check(Schema.isMinLength(1), Schema.isMaxLength(20));

/** K-804: the key of an app; it has no `-`, so a card id reads left to right. */
export const AppKey = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]{0,19}$/));

/**
 * K-820, K-808: what an app needs. `apps` are keys of other apps of this repo, which deploy first. `vars` and
 * `secrets` join it with K-808; until then the schema refuses them.
 */
const needs = Schema.optionalKey(
  Schema.Struct({ apps: Schema.optionalKey(Schema.Array(AppKey).check(Schema.isMaxLength(9))) }),
);

/** K-801, K-804: a recipe has exactly one kind. */
export const Recipe = Schema.Union([
  Schema.Struct({ static: StaticApp, deploy, needs }),
  Schema.Struct({ compose: ComposeApp, deploy, needs }),
  Schema.Struct({ worker: WorkerApp, deploy, needs }),
  Schema.Struct({ native: NativeApp, deploy, needs }),
]);
export type Recipe = typeof Recipe.Type;

/**
 * K-820: the keys in deploy order: each app after the apps that it names in `needs.apps`, ties by key. A key that no app
 * has, an app that names itself and a cycle are errors.
 */
export function deployOrder(apps: {
  readonly [key: string]: { readonly needs?: { readonly apps?: ReadonlyArray<string> } };
}): { readonly order: ReadonlyArray<string> } | { readonly error: string } {
  const keys = Object.keys(apps).sort();
  for (const key of keys)
    for (const before of apps[key]?.needs?.apps ?? []) {
      if (before === key) return { error: `The app ${key} needs itself (K-820).` };
      if (!keys.includes(before))
        return { error: `The app ${key} needs ${before}, but no app has that key (K-820).` };
    }
  const order: Array<string> = [];
  while (order.length < keys.length) {
    const next = keys.find(
      (key) =>
        !order.includes(key) && (apps[key]?.needs?.apps ?? []).every((before) => order.includes(before)),
    );
    if (next === undefined) {
      const left = keys.filter((key) => !order.includes(key));
      return { error: `The apps ${left.join(", ")} need each other, a cycle (K-820).` };
    }
    order.push(next);
  }
  return { order };
}

/** K-820: how one app of a run ended. An app with nothing to do for the event counts as `done`. */
export type AppResult = "done" | "failed" | "skipped";

/** K-820: the apps that this app needs and that did not deploy in this run, so this app does not deploy either. */
export const missingNeeds = (
  app: { readonly needs?: { readonly apps?: ReadonlyArray<string> } },
  results: ReadonlyMap<string, AppResult>,
): Array<string> => (app.needs?.apps ?? []).filter((key) => results.get(key) !== "done");

/** K-804, K-820: the apps of a repo by key, 1 to 10, in an order that `needs.apps` allows. */
export const Apps = Schema.Record(AppKey, Recipe).check(
  Schema.isMinProperties(1),
  Schema.isMaxProperties(10),
  Schema.makeFilter((apps) => {
    const result = deployOrder(apps);
    return "error" in result ? result.error : undefined;
  }),
);
export type Apps = typeof Apps.Type;

// The public types of index.ts and the schema accept the same recipes; a failing line names the type.
// Strict equality: plain assignability both ways misses a key that is optional on one side only.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Keys<T> = T extends unknown ? keyof T : never;
// The schema's deploy is a plain array; the public one is non-empty, so the editor refuses `[]` too.
type Kind<T, K extends string, Never extends string> = {
  readonly [P in keyof Omit<Extract<T, Record<K, unknown>>, Never>]: P extends "deploy"
    ? ReadonlyArray<PublicDeployEntry>
    : Extract<T, Record<K, unknown>>[P];
};
type Assert<T extends true> = T;
export type PublicTypesMatch = [
  Assert<Same<typeof DeployEntry.Type, PublicDeployEntry>>,
  Assert<Same<typeof StaticApp.Type, PublicStaticApp>>,
  Assert<Same<typeof ComposeApp.Type, PublicComposeApp>>,
  Assert<Same<typeof WorkerApp.Type, PublicWorkerApp>>,
  Assert<Same<typeof NativeApp.Type, PublicNativeApp>>,
  Assert<Same<Keys<Recipe>, Keys<PublicRecipe>>>,
  Assert<
    Same<Extract<Recipe, { static: unknown }>, Kind<PublicRecipe, "static", "compose" | "worker" | "native">>
  >,
  Assert<
    Same<Extract<Recipe, { compose: unknown }>, Kind<PublicRecipe, "compose", "static" | "worker" | "native">>
  >,
  Assert<
    Same<Extract<Recipe, { worker: unknown }>, Kind<PublicRecipe, "worker", "static" | "compose" | "native">>
  >,
  Assert<
    Same<Extract<Recipe, { native: unknown }>, Kind<PublicRecipe, "native", "static" | "compose" | "worker">>
  >,
  Assert<
    Same<
      Pick<Extract<PublicRecipe, { static: PublicStaticApp }>, "compose" | "worker" | "native">,
      { readonly compose?: never; readonly worker?: never; readonly native?: never }
    >
  >,
  Assert<
    Same<
      Pick<Extract<PublicRecipe, { compose: PublicComposeApp }>, "static" | "worker" | "native">,
      { readonly static?: never; readonly worker?: never; readonly native?: never }
    >
  >,
  Assert<
    Same<
      Pick<Extract<PublicRecipe, { worker: PublicWorkerApp }>, "static" | "compose" | "native">,
      { readonly static?: never; readonly compose?: never; readonly native?: never }
    >
  >,
  Assert<
    Same<
      Pick<Extract<PublicRecipe, { native: PublicNativeApp }>, "static" | "compose" | "worker">,
      { readonly static?: never; readonly compose?: never; readonly worker?: never }
    >
  >,
];

export const decodeRecipe = Schema.decodeUnknownSync(Recipe, { onExcessProperty: "error" });
export const decodeApps = Schema.decodeUnknownSync(Apps, { onExcessProperty: "error" });

/** The GitHub event that a deploy runs for. */
export interface DeployEvent {
  readonly name: "push" | "pull_request";
  /** For a push, the branch; for a pull request, its head branch. */
  readonly branch: string;
  readonly pr: number | null;
  /** For a pull request: opened, synchronize, reopened or closed. */
  readonly action: string | null;
}

export type Plan =
  /** Nothing to do for this event. */
  | { readonly kind: "skip"; readonly reason: string }
  /** The recipe has a mistake; the deploy fails and says why (K-006). */
  | { readonly kind: "error"; readonly reason: string }
  | {
      readonly kind: "deploy" | "teardown";
      readonly environment: string;
      /** The main address: the card address, the expose name, the route check and the deployment (K-817). */
      readonly address: string;
      /** Every address that serves the app, the main one first (K-817). */
      readonly addresses: ReadonlyArray<string>;
      readonly ephemeral: boolean;
      readonly startsIn: string | null;
    };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const repoSlug = (repo: string) =>
  (repo.split("/")[1] ?? repo)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * K-817, K-1111: the zone of an address: the apex of a zone or one name under it, so Universal SSL covers it.
 * Null when it is in no zone, or deeper.
 */
export function zoneOfAddress(address: string, zones: ReadonlyArray<string>): string | null {
  // The longest zone first, so a zone inside another zone takes its own names.
  for (const zone of [...zones].sort((a, b) => b.length - a.length)) {
    if (address === zone) return zone;
    if (address.endsWith(`.${zone}`) && LABEL.test(address.slice(0, -zone.length - 1))) return zone;
  }
  return null;
}

/**
 * K-807, K-901, K-817: the environment and addresses of an event, or why kitshn skips it. `zone` is the kitshn
 * zone; `otherZones` are the further zones of K-1111, which only the extra addresses of a `push` entry may use.
 */
export function plan(
  recipe: Recipe,
  repo: string,
  event: DeployEvent,
  zone: string,
  otherZones: ReadonlyArray<string> = [],
  key: string = DEFAULT_APP,
): Plan {
  const entry = recipe.deploy.find(
    (item) =>
      item.on === event.name &&
      (item.on !== "push" || item.branch === undefined || item.branch === event.branch),
  );
  if (!entry) return { kind: "skip", reason: `No deploy entry matches ${event.name} on ${event.branch}.` };
  if (event.name === "pull_request" && event.pr === null)
    return { kind: "skip", reason: "The pull request has no number." };
  // A pull request touches only its own preview: the token's number names it, whatever the recipe says (K-811).
  if (event.name === "pull_request" && entry.name !== "pr-{pr}") {
    return { kind: "error", reason: `A pull_request entry must be named "pr-{pr}", not "${entry.name}".` };
  }
  const environment = entry.name.replaceAll("{pr}", String(event.pr ?? ""));
  if (!LABEL.test(environment))
    return { kind: "error", reason: `The environment name "${environment}" is not a valid name.` };
  // K-804: the default address of an app other than `app` holds its key.
  const slug = key === DEFAULT_APP ? repoSlug(repo) : `${repoSlug(repo)}-${key}`;
  const listed =
    entry.address === undefined
      ? []
      : typeof entry.address === "string"
        ? [entry.address]
        : [...entry.address];
  if (listed.length > 1 && entry.on !== "push")
    return { kind: "error", reason: "Only a push entry may list several addresses (K-817)." };
  if (new Set(listed).size !== listed.length)
    return { kind: "error", reason: "The address list names an address twice (K-817)." };
  // K-817: the first address under the kitshn zone is the main one.
  const main = listed.find((address) => address.endsWith(`.${zone}`));
  if (listed.length > 0 && main === undefined) {
    return {
      kind: "error",
      reason: `The address ${listed[0]} is not under the kitshn zone ${zone} (K-1111). One address must be.`,
    };
  }
  // K-817: the main address never takes a name that kitshn uses on its zone either.
  if (main !== undefined && RESERVED_SITE_NAMES.has(main.slice(0, -zone.length - 1)))
    return { kind: "error", reason: `${main} is a name that kitshn keeps for itself (K-817).` };
  for (const address of listed) {
    if (address === main) continue;
    if (zoneOfAddress(address, [zone, ...otherZones]) === null)
      return {
        kind: "error",
        reason: `The address ${address} is not the apex or one name under a zone that kitshn publishes on (K-817, K-1111).`,
      };
    // K-817: an extra address never takes the kitshn zone apex or a name that kitshn uses on its zone.
    const label = address.endsWith(`.${zone}`) ? address.slice(0, -zone.length - 1) : null;
    if (address === zone || (label !== null && RESERVED_SITE_NAMES.has(label)))
      return { kind: "error", reason: `${address} is a name that kitshn keeps for itself (K-817).` };
  }
  const label =
    main !== undefined
      ? main.slice(0, -zone.length - 1)
      : environment === "prod"
        ? slug
        : `${slug}-${environment}`;
  // K-901: one level under the zone, so the free Universal SSL certificate covers it.
  if (!LABEL.test(label))
    return {
      kind: "error",
      reason: `The address ${label}.${zone} must be one name of at most 63 letters, digits or dashes under ${zone} (K-901).`,
    };
  const ephemeral = entry.ephemeral === true;
  const closing = event.name === "pull_request" && event.action === "closed";
  if (closing && !ephemeral)
    return { kind: "skip", reason: "The pull request closed; its environment is not ephemeral." };
  return {
    kind: closing ? "teardown" : "deploy",
    environment,
    address: `${label}.${zone}`,
    addresses: [`${label}.${zone}`, ...listed.filter((address) => address !== main)],
    ephemeral,
    // K-907: a preview starts in Owner unless the recipe names another circle.
    startsIn: entry.startsIn ?? (ephemeral ? "Owner" : null),
  };
}
