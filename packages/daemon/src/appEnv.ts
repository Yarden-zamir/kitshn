import type { AppAccess } from "@kitshn/edge/machine";

export type Notify = { readonly url: string; readonly token: string };

/** K-822: the Access values of an app, as the variables that it gets. */
export function accessEnv(access: AppAccess): Record<string, string> {
  return {
    KITSHN_ACCESS_TEAM_DOMAIN: access.teamDomain,
    KITSHN_ACCESS_AUDIENCES: access.audiences.join(","),
  };
}

/**
 * K-1908, K-822: every service of a Compose app gets the kitshn variables of the job, so the app needs no Compose
 * change; a value that the app sets itself wins. No file holds the notify token: the key goes in as null, and each
 * place where Compose interpolated the token (another key, a command, a label, a build arg) becomes
 * `${KITSHN_NOTIFY_TOKEN}` again, which Compose fills in from its own environment at `up`.
 */
export function withAppEnv(
  config: unknown,
  job: { readonly notify?: Notify | undefined; readonly access?: AppAccess | undefined },
  markers: Readonly<Record<string, string>> = {},
): unknown {
  const values: Record<string, string | null> = {
    ...(job.notify ? { KITSHN_NOTIFY_URL: job.notify.url, KITSHN_NOTIFY_TOKEN: null } : {}),
    ...(job.access ? accessEnv(job.access) : {}),
    // K-833: a store value goes in from the environment of `up`, like the notify token.
    ...Object.fromEntries(Object.keys(markers).map((name) => [name, null])),
  };
  if (Object.keys(values).length === 0) return config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return config;
  const services = (config as { services?: unknown }).services;
  if (typeof services !== "object" || services === null || Array.isArray(services)) return config;
  const added = {
    ...config,
    services: Object.fromEntries(
      Object.entries(services as Record<string, Record<string, unknown>>).map(([name, service]) => {
        const own = service["environment"];
        // `docker compose config --format json` gives the environment as a map; anything else is unexpected.
        if (own !== undefined && (typeof own !== "object" || own === null || Array.isArray(own)))
          throw new Error(`the environment of the service ${name} is not a map (K-1908)`);
        return [name, { ...service, environment: { ...values, ...(own as Record<string, string | null>) } }];
      }),
    ),
  };
  // K-833: a store value reaches a service only through its environment. Anywhere else (a path, a port, a build arg, a
  // command) the checks of K-818 saw only its marker, so the deploy stops.
  const outside = JSON.stringify({
    ...added,
    services: Object.fromEntries(
      Object.entries(added.services).map(([name, service]) => [name, { ...service, environment: {} }]),
    ),
  });
  for (const [name, marker] of Object.entries(markers))
    if (outside.includes(marker))
      throw new Error(
        `the Compose file uses the kitshn value ${name} outside the environment of a service; a kitshn value reaches an app only through its environment (K-833)`,
      );
  // `config --format json` writes a literal `$` as `$$`, so only this text is interpolated again at `up`.
  let text = JSON.stringify(added);
  if (job.notify) text = text.replaceAll(job.notify.token, "${KITSHN_NOTIFY_TOKEN}");
  for (const [name, marker] of Object.entries(markers)) text = text.replaceAll(marker, `\${${name}}`);
  return JSON.parse(text) as unknown;
}

/**
 * K-833: a marker for each store value of a job. The daemon reads the Compose config with the markers in place of the
 * values, so no file holds a value, and each marker becomes `${NAME}` again, which Compose fills in at `up`.
 */
export const valueMarkers = (names: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    names.map((name) => [
      name,
      `kitshn-value-${[...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    ]),
  );

/**
 * K-833: the job output with each secret value as `***`, as GitHub Actions hides its secrets. Known limit: a secret
 * shorter than 4 characters stays, because hiding it would hide that text everywhere in the output. Revisit when an
 * app needs such a short secret.
 */
export function maskSecrets(output: string, secrets: ReadonlyArray<string>): string {
  let masked = output;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    if (secret.length >= 4) masked = masked.replaceAll(secret, "***");
  return masked;
}
