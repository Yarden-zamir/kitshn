import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * K-818: Compose keys that need no allowance, because they cannot reach past the app's own folders,
 * network and limits. Every other key, and every risky value of these keys, comes back as a setting name
 * that only an allow list entry of the owner lets through. New Compose features are refused until they
 * are on this list, so they never become a way around it.
 */
const SAFE_SERVICE_KEYS = new Set([
  "build",
  "command",
  "container_name",
  "cpus",
  "cpu_shares",
  "depends_on",
  "deploy",
  "entrypoint",
  "environment",
  "env_file",
  "expose",
  "extra_hosts",
  "healthcheck",
  "hostname",
  "image",
  "init",
  "labels",
  "logging",
  "mem_limit",
  "mem_reservation",
  "networks",
  "pull_policy",
  "read_only",
  "restart",
  "secrets",
  "configs",
  "shm_size",
  "stdin_open",
  "stop_grace_period",
  "stop_signal",
  "tmpfs",
  "tty",
  "ulimits",
  "user",
  "volumes",
  "working_dir",
  "platform",
  "profiles",
  "scale",
]);
const SAFE_BUILD_KEYS = new Set([
  "context",
  "additional_contexts",
  "dockerfile",
  "args",
  "target",
  "labels",
  "cache_from",
  "tags",
  "platforms",
]);
const SAFE_TOP_KEYS = new Set(["name", "services", "volumes", "networks", "secrets", "configs"]);

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): Array<unknown> => (Array.isArray(value) ? value : []);
/** Label names of a map or of a list of `name=value`. */
const labelNames = (labels: unknown): Array<string> =>
  Array.isArray(labels)
    ? labels.map((label) => String(label).split("=")[0] ?? "")
    : Object.keys(record(labels));
/** Compose finds the containers, networks and volumes of a project by these labels. */
const composeLabel = (labels: unknown) =>
  labelNames(labels).some((name) => name.startsWith("com.docker.compose."));
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * Follows symlinks of the longest part of a path that exists, then adds the rest, so a link in the repo or
 * a folder that Docker would create cannot point out of the app's folders.
 */
export function realpathOf(
  path: string,
  realpath: (path: string) => string,
  exists: (path: string) => boolean,
): string {
  const absolute = resolve(path);
  if (exists(absolute)) return realpath(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : join(realpathOf(parent, realpath, exists), absolute.slice(parent.length + 1));
}

/**
 * The real path of a source on this disk. A link counts as present even when its target is missing, so a
 * dangling link fails the deploy instead of passing as a folder that Docker would create (K-818).
 */
export function realpathOnDisk(path: string): string {
  try {
    return realpathOf(path, realpathSync, (part) => lstatSync(part, { throwIfNoEntry: false }) !== undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(`${path} is or passes a link whose target is missing (K-818)`);
  }
}

/**
 * The app's own folders: first the new source, then data, logs and sockets. Build inputs and env files stay
 * in the new source, which no running container of the app can change.
 */
type Roots = readonly [source: string, ...others: Array<string>];

/**
 * K-818: the env and label files of `docker compose config --format json --no-interpolate`, which names them
 * without reading them. Checked before the run with the params, which reads them.
 */
export function envFileRisks(
  uninterpolated: unknown,
  roots: Roots,
  real: (path: string) => string,
): Array<string> {
  const source = real(roots[0]);
  const risks = new Set<string>();
  for (const service of Object.values(record(record(uninterpolated)["services"]))) {
    const s = record(service);
    for (const key of ["env_file", "label_file"])
      for (const entry of list(s[key])) {
        const path = typeof entry === "string" ? entry : record(entry)["path"];
        if (typeof path !== "string" || path.includes("$") || !under(real(path), source))
          risks.add(`${key}:${String(path)}`);
      }
  }
  return [...risks].sort();
}

/**
 * K-818: the bind and file sources that need an allowance: one out of the app's folders after symlinks, one
 * that is a link inside them, which the app can re-point before a restart, and one under a writable bind.
 * The daemon checks them with the config, and again right before `up`.
 */
export function sourceRisks(config: unknown, roots: Roots, real: (path: string) => string): Array<string> {
  const realRoots = roots.map(real);
  const inside = (path: string) => realRoots.some((root) => under(real(path), root));
  const link = (path: string) => {
    const absolute = resolve(path);
    for (const [index, root] of roots.entries()) {
      const realRoot = realRoots[index] ?? root;
      // The app's folder itself may be a link, as /var is on macOS; only links below a root count.
      const base = [root, realRoot].find((candidate) => under(absolute, candidate));
      if (base !== undefined) return real(absolute) !== realRoot + absolute.slice(base.length);
    }
    return false;
  };
  const binds = bindSources(config);
  const files = fileSources(config);
  return [
    ...binds.filter((path) => !inside(path)).map((path) => `bind:${resolve(path)}`),
    ...files.filter((path) => !inside(path)).map((path) => `file:${resolve(path)}`),
    ...[...binds, ...files].filter(link).map((path) => `link:${resolve(path)}`),
    ...nestedSources(config, real).map((path) => `nested:${resolve(path)}`),
  ];
}

/** K-818: the settings of a Compose app that need an allowance. `config` is `docker compose config --format json`. */
export function composeRisks(
  config: unknown,
  project: string,
  roots: Roots,
  real: (path: string) => string,
): Array<string> {
  const risks = new Set<string>(sourceRisks(config, roots, real));
  const inSource = (path: string) => under(real(path), real(roots[0]));
  const top = record(config);
  for (const key of Object.keys(top))
    if (!SAFE_TOP_KEYS.has(key) && !key.startsWith("x-")) risks.add(`top:${key}`);
  for (const [serviceName, service] of Object.entries(record(top["services"]))) {
    const s = record(service);
    for (const key of Object.keys(s))
      if (!SAFE_SERVICE_KEYS.has(key) && !key.startsWith("x-")) risks.add(key);
    // A built image or a container name of another app would take its place on this machine. A plain
    // prefix is not enough: the project a-pr-1 is a prefix of the project a-pr-12.
    const ownName = `${project}-${serviceName}`;
    const own = (name: unknown) => {
      if (name === ownName) return true;
      if (typeof name !== "string" || !name.startsWith(`${ownName}:`)) return false;
      const tag = name.slice(ownName.length + 1);
      return tag !== "" && !tag.includes(":") && !tag.includes("/") && !tag.includes("@");
    };
    if (s["build"] !== undefined && s["image"] !== undefined && !own(s["image"])) risks.add("image");
    if (s["container_name"] !== undefined && s["container_name"] !== ownName) risks.add("container_name");
    if ([s["labels"], record(s["build"])["labels"], record(s["deploy"])["labels"]].some(composeLabel))
      risks.add("labels");
    const logging = record(s["logging"]);
    if (logging["driver"] !== undefined && logging["driver"] !== "json-file" && logging["driver"] !== "local")
      risks.add("logging");
    for (const option of Object.keys(record(logging["options"])))
      if (!["max-size", "max-file", "compress"].includes(option)) risks.add("logging");
    for (const value of Object.values(record(s["networks"])))
      if (value !== null && Object.keys(record(value)).length > 0) risks.add("networks.options");
    for (const volume of list(s["volumes"])) {
      const v = record(volume);
      if (v["type"] !== "bind" && v["type"] !== "volume" && v["type"] !== "tmpfs")
        risks.add(`volume:${String(v["type"])}`);
    }
    const build = record(s["build"]);
    for (const key of Object.keys(build)) if (!SAFE_BUILD_KEYS.has(key)) risks.add(`build.${key}`);
    const context = typeof build["context"] === "string" ? build["context"] : null;
    for (const input of [context, ...Object.values(record(build["additional_contexts"]))])
      if (input !== null && (typeof input !== "string" || input.includes("://") || !inSource(input)))
        risks.add(`build:${String(input)}`);
    if (
      context !== null &&
      typeof build["dockerfile"] === "string" &&
      !inSource(resolve(context, build["dockerfile"]))
    )
      risks.add(`build:${build["dockerfile"]}`);
    for (const tag of list(build["tags"])) if (!own(tag)) risks.add("build.tags");
    for (const source of list(build["cache_from"]))
      if (typeof source !== "string" || (source.includes("type=") && !source.includes("type=registry")))
        risks.add("build.cache_from");
    for (const name of Object.keys(record(s["networks"])))
      if (name !== "default" && !Object.hasOwn(record(top["networks"]), name)) risks.add(`network:${name}`);
    const deploy = record(s["deploy"]);
    for (const key of Object.keys(deploy))
      if (!["resources", "restart_policy", "replicas", "labels"].includes(key)) risks.add(`deploy.${key}`);
    if (Object.keys(record(record(deploy["resources"])["reservations"])).includes("devices"))
      risks.add("devices");
  }
  for (const [name, volume] of Object.entries(record(top["volumes"]))) {
    const v = record(volume);
    // A plain named volume of this project; anything else can reach another app's volume or the host.
    const own = typeof v["name"] !== "string" || v["name"] === `${project}_${name}`;
    if (!own || v["external"] === true || v["driver"] !== undefined || v["driver_opts"] !== undefined)
      risks.add(`volume:${name}`);
    if (composeLabel(v["labels"])) risks.add("labels");
  }
  for (const [name, network] of Object.entries(record(top["networks"]))) {
    const n = record(network);
    // The setting names the Docker network, so `network:kitshn-edge` holds whatever key the file uses.
    // Compose gives each service its name as an alias on a shared network such as kitshn-edge, so a
    // service there can take the traffic of another app's service of the same name.
    const risk = `network:${typeof n["name"] === "string" ? n["name"] : name}`;
    // Only a name, labels and `internal`; ipam, ipv6 and drivers can change routing on the host. Compose
    // writes an empty ipam on every network.
    const plain = (key: string) =>
      ["name", "labels", "external", "internal"].includes(key) ||
      (key === "ipam" && Object.keys(record(n[key])).length === 0);
    if (Object.keys(n).some((key) => !plain(key))) risks.add(risk);
    if (composeLabel(n["labels"])) risks.add("labels");
    const own = typeof n["name"] !== "string" || n["name"] === `${project}_${name}`;
    if (!own || n["external"] === true) risks.add(risk);
  }
  for (const section of ["secrets", "configs"])
    for (const entry of Object.values(record(top[section]))) {
      if (record(entry)["environment"] !== undefined) risks.add(`${section}.environment`);
    }
  return [...risks].sort();
}

/**
 * K-818: bind and file sources under a writable bind source of the same app, after symlinks. Docker follows
 * symlinks at each container start, so through the outer bind the app can turn the inner source into a link
 * to any host path, and a restart mounts that path. The same path twice is fine: no container can replace
 * the root of its own mount.
 */
export function nestedSources(config: unknown, real: (path: string) => string): Array<string> {
  const writable = Object.values(record(record(config)["services"])).flatMap((service) =>
    list(record(service)["volumes"]).flatMap((volume) => {
      const v = record(volume);
      return v["type"] === "bind" && typeof v["source"] === "string" && v["read_only"] !== true
        ? [real(v["source"])]
        : [];
    }),
  );
  return [...bindSources(config), ...fileSources(config)].filter((path) => {
    const resolved = real(path);
    return writable.some((outer) => resolved.startsWith(`${outer}/`));
  });
}

/**
 * K-826: the mounts of a config that keep data on this machine: each volume, named or not, and each bind below the
 * data folder of the app. A spread app has none, because kitshn cannot move data to another machine yet.
 */
export function spreadData(config: unknown, data: string, real: (path: string) => string): Array<string> {
  const folder = real(data);
  return Object.entries(record(record(config)["services"]))
    .flatMap(([name, service]) =>
      list(record(service)["volumes"]).flatMap((volume) => {
        const v = record(volume);
        if (v["type"] === "volume") return [`${name}: volume ${String(v["source"] ?? "(anonymous)")}`];
        if (v["type"] !== "bind" || typeof v["source"] !== "string") return [];
        const source = real(v["source"]);
        return source === folder || source.startsWith(`${folder}/`) ? [`${name}: bind ${v["source"]}`] : [];
      }),
    )
    .sort();
}

/** K-818: every bind source of a config, checked again right before `up` with nothing of the app running. */
export function bindSources(config: unknown): Array<string> {
  return Object.values(record(record(config)["services"])).flatMap((service) =>
    list(record(service)["volumes"]).flatMap((volume) => {
      const v = record(volume);
      return v["type"] === "bind" && typeof v["source"] === "string" ? [v["source"]] : [];
    }),
  );
}

const isMapping = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * K-818: `docker compose config` inlines `include` and `extends`, so their files and env files never show
 * in its output. The raw Compose files of the app must not use them without an allowance. A real YAML
 * parse sees them in every form: quoted keys, flow style, JSON and merge keys. Throws on a file that is
 * not one YAML mapping, also on more than one document.
 */
export function rawRisks(text: string): Array<string> {
  const document: unknown = Bun.YAML.parse(text);
  if (!isMapping(document)) throw new Error("a Compose file must be one YAML mapping");
  const services = record(document["services"]);
  // Bun expands merge keys; one that stays is a form that Compose may read differently.
  if ("<<" in document || Object.values(services).some((service) => "<<" in record(service)))
    throw new Error("a Compose file has a merge key that does not expand");
  const risks: Array<string> = [];
  if ("include" in document) risks.push("include");
  if (Object.values(services).some((service) => "extends" in record(service))) risks.push("extends");
  return risks;
}

/** K-818: the Compose file names that Compose finds on its own, in its order; it takes the first of each. */
const DEFAULT_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
const OVERRIDE_FILES = [
  "compose.override.yml",
  "compose.override.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
];

/**
 * K-818: the Compose files of an app, as absolute paths. The daemon passes them with `-f`, so a
 * `COMPOSE_FILE` in the params cannot add files. `file` is the recipe's file, relative to the source.
 * Throws when a file is missing or resolves out of the source.
 */
export function composeFiles(
  source: string,
  file: string | null,
  exists: (path: string) => boolean,
  real: (path: string) => string,
): Array<string> {
  const realSource = real(source);
  const linksIn = (path: string) => real(path).startsWith(`${realSource}/`);
  if (file !== null) {
    const path = resolve(source, file);
    if (file === "" || file.startsWith("/") || !path.startsWith(`${source}/`))
      throw new Error(`the Compose file "${file}" is not inside the repo`);
    if (!exists(path)) throw new Error(`the repo has no Compose file ${file}`);
    if (!linksIn(path)) throw new Error(`the Compose file ${file} links out of the repo`);
    return [path];
  }
  const first = (names: ReadonlyArray<string>) => names.map((name) => join(source, name)).find(exists);
  const main = first(DEFAULT_FILES);
  if (main === undefined)
    throw new Error(`the repo has none of the Compose files ${DEFAULT_FILES.join(", ")}`);
  const override = first(OVERRIDE_FILES);
  const files = override === undefined ? [main] : [main, override];
  for (const path of files)
    if (!linksIn(path)) throw new Error(`the Compose file ${path} links out of the repo`);
  return files;
}

/** K-818: the secret and config files of a config, checked again right before `up`. */
export function fileSources(config: unknown): Array<string> {
  const top = record(config);
  return ["secrets", "configs"].flatMap((section) =>
    Object.values(record(top[section])).flatMap((entry) => {
      const file = record(entry)["file"];
      return typeof file === "string" ? [file] : [];
    }),
  );
}
