# Primitives
KitSHn has four primitives.

## Recipe
A recipe is a fully qualified GitHub repo name, `owner/repo`, plus its deployment contract.

Rules:

- Always use the fully qualified name.
- Assume GitHub hosting.
- Remote is derived as `git@github.com:<owner>/<repo>.git`.
- Matching is exact and case-sensitive.
- Use `compose.yml` when the recipe has containers.
- Use root `Caddyfile` or `Caddyfile.j2` when the recipe routes public traffic.
- Use Compose required variable interpolation for required runtime params, for example `${TOKEN:?TOKEN is required}`.
- Log to stdout.

## Environment
An environment is a string produced by resolving the recipe's `.kitshn.yaml` against a triggering event. The same string is the GitHub Environment name, the `/deployments/<owner>/<repo>/<env>` path segment, the Compose project name, and the Caddy site identifier.

Rules:

- Params come from GitHub Environment vars and secrets. CI forwards only `KITSHN_*` entries and strips the prefix; the recipe sees bare names.
- Mappings live in `.kitshn.yaml`; see `ci.md`.
- `name` may be literal or templated with `{branch}`, `{pr}`, `{sha7}`.
- Sanitization on every expanded name: lowercase, replace any char outside `[a-z0-9-]` with `-`, collapse repeats, trim leading/trailing `-`, cap at 63 chars.
- Manual `workflow_dispatch` can deploy any ref to any env name.

## Deployment
A deployment is one recipe deployed to one environment.

Identity:

```text
<owner>/<repo>/<environment>
```

## Service
A service is a Docker Compose service inside a recipe.
