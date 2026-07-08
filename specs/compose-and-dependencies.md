# Compose And Dependencies
Compose is the runtime source of truth.

KitSHn renders Compose with:

```bash
docker compose --env-file /params/<owner>/<repo>/<environment>/params.env config --format json
```

KitSHn uses the same `--env-file /params/<owner>/<repo>/<environment>/params.env` argument for every Compose command in the deploy flow, including config rendering, pulling external images, building local images, and applying changes. `KITSHN_PARAMS_FILE` is exported into the runtime env as a pointer for app code, not as a Compose input.

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
- Public HTTP services should prefer Unix socket ingress by mounting `${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}` and listening on `${KITSHN_DEFAULT_SOCKET}`.
- Images that only expose TCP can use a Compose sidecar such as `alpine/socat` to bind `${KITSHN_DEFAULT_SOCKET}` and forward to `TCP:<service>:<port>`.
- Keep socket proxy-to-app traffic on the project-local default network. Do not attach the socket proxy to a shared external network such as `kitshn-edge`; service DNS aliases can collide across prod and PR deployments with the same service names.
- KitSHn force-recreates recipe services on deploy because the socket directory is cleared before Compose runs.
- Compose service names should be stable because other services may route to them by Docker DNS name.

Dependency rules:

- `kitshn.depends_on` compose label is the only dependency source.
- Values are comma-separated, fully qualified `owner/repo` recipe names.
- Matching is case-insensitive.
- Shared Docker networks do not imply dependencies. Use them only for intentional cross-recipe traffic.
- When a recipe deploys, KitSHn scans every other deployment for services labelled `kitshn.depends_on` containing the deployed recipe and recreates those services. It does not re-checkout, re-pull, or re-build the dependent recipes.

Example:

```yaml
labels:
  kitshn.depends_on: "Yarden-zamir/opencode,Yarden-zamir/dotfiles"
```
