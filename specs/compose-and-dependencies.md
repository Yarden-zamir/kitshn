# Compose And Dependencies
Compose is the runtime source of truth.

KitSHn renders Compose with:

```bash
docker compose --env-file /params/<owner>/<repo>/<environment>/params.env config --format json
```

KitSHn uses the same `--env-file /params/<owner>/<repo>/<environment>/params.env` argument for every Compose command in the deploy flow, including config rendering, pulling external images, building local images, and applying changes.

KitSHn reads:

- services
- labels
- build contexts
- images
- pull policies
- healthchecks

Image rules:

- Local builds use `build.context` and `pull_policy: build`.
- External images use `image` and `pull_policy: always`.
- Required runtime params use Compose interpolation like `${TOKEN:?TOKEN is required}` so `docker compose config` fails early.
- Compose service names should be stable because Caddy and other services may route to them by Docker DNS name.

Dependency rules:

- `kitshn.depends_on` compose label is the only dependency source.
- Values are comma-separated, fully qualified `owner/repo` recipe names.
- Matching is exact and case-sensitive.
- Shared Docker networks do not imply dependencies.

Example:

```yaml
labels:
  kitshn.depends_on: "Yarden-zamir/opencode,Yarden-zamir/dotfiles"
```
