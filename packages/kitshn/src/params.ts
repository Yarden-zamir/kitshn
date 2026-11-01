/**
 * K-808: Compose env lines `<NAME>="value"` for `params.env`, which the daemon passes as `--env-file`.
 * JSON quoting keeps a line break or a `#`, like KitSHn 1. Compose still expands `$` inside double
 * quotes, so each `$` becomes `\$`, which Compose reads as a plain `$`.
 */
export const envLines = (values: ReadonlyMap<string, string>) =>
  [...values].map(([key, value]) => `${key}=${JSON.stringify(value).replaceAll("$", "\\$")}`).join("\n");
