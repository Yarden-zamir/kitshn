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
An environment is a GitHub Environment name.

Rules:

- Params come from GitHub Environment vars and secrets.
- Auto-deploy mappings use `environment(branch-glob)`.
- Environments without brackets exist but do not auto-deploy.
- Manual `workflow_dispatch` can deploy any branch or SHA to any GitHub Environment.
- Environment names are sanitized before use in paths, Compose project names, and generated Caddyfile names.

## Deployment
A deployment is one recipe deployed to one environment.

Identity:

```text
<owner>/<repo>/<environment>
```

## Service
A service is a Docker Compose service inside a recipe.
