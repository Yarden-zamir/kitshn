// K-812, K-815: what a Compose app finds on a machine, shared by the daemon and `kitshn try`.
import { join, resolve } from "node:path";

/** K-607: the name of the socket in `$KITSHN_SOCKET_DIR` that the address goes to. */
export const DEFAULT_SOCKET = "default.sock";

/** K-812, K-607: the variables of KitSHn 1 that every Compose app gets, so its `compose.yml` works unchanged. */
export const appVariables = (app: {
  readonly recipe: string;
  readonly environment: string;
  readonly deployment: string;
  readonly socketDir: string;
  readonly data: string;
  readonly logs: string;
  readonly params: string;
}) => ({
  KITSHN_RECIPE: app.recipe,
  KITSHN_ENVIRONMENT: app.environment,
  KITSHN_DEPLOYMENT: app.deployment,
  KITSHN_SOCKET_DIR: app.socketDir,
  KITSHN_DEFAULT_SOCKET: join(app.socketDir, DEFAULT_SOCKET),
  KITSHN_DATA_DIR: app.data,
  KITSHN_LOG_DIR: app.logs,
  KITSHN_PARAMS_FILE: app.params,
});

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
