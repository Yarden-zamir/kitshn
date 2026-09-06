# Caddy Ingress
Caddy is global infrastructure installed and managed by KitSHn bootstrap.

DNS is handled outside KitSHn with normal A/AAAA records pointing to the VPS.

Bootstrap owns:

- Caddy install/runtime.
- Caddy global config.
- persistent Caddy `/data` and `/config`.
- base Caddyfile importing `/deployments/Caddyfile`.

Recipe route contract:

- A recipe that routes public traffic must provide a root `Caddyfile.j2`.
- The recipe `Caddyfile.j2` is rendered through Jinja2 into the deployment `Caddyfile`.
- `Caddyfile` is a generated deployment artifact and should be gitignored by recipes.
- Public-route services should default to Unix socket ingress at `{{ paths.default_socket }}`.
- TCP routing is still possible, but recipe authors must avoid host port collisions themselves.

Deploy behavior:

- Generate `/deployments/<owner>/<repo>/<environment>/Caddyfile` via atomic rename.
- Regenerate `/deployments/Caddyfile` with explicit imports for every generated deployment Caddyfile.
- Validate the full Caddy config once.
- Reload Caddy once when generated Caddyfiles changed.
- If validation fails, keep the previous generated Caddyfile active and fail deploy.

Jinja2 context includes:

- recipe name
- environment name
- deployment identity
- deployment paths
- full deployment params from `params.env`, including secrets, as `params`

Socket ingress:

- `KITSHN_SOCKET_DIR` points at `/deployments/<owner>/<repo>/<environment>/.kitshn/sockets` and is cleared before each deploy.
- `KITSHN_DEFAULT_SOCKET` points at `$KITSHN_SOCKET_DIR/app.sock`.
- Compose services can bind mount `${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}` and listen on `${KITSHN_DEFAULT_SOCKET}`.
- Caddy inside a container can bind the socket itself with `bind unix/{$KITSHN_DEFAULT_SOCKET}|0666`. Caddy removes a stale socket file left by a previous container when it starts, so no sidecar and no cleanup step is needed. `kitshn init --template static` uses this.
- Caddy's `encode` compresses only its default MIME types, and `header` directives run before `encode` sees the type. A custom `Content-Type` set with `header` is only compressed when listed in an explicit `encode { match { header Content-Type ... } }` block.
- Only images that cannot bind a Unix socket need a socket proxy sidecar that listens on `${KITSHN_DEFAULT_SOCKET}` and forwards to the app's internal Compose service port over the project-local default network.
- Caddy routes to sockets with `reverse_proxy unix//{{ paths.default_socket }}`.
- Public HTTP recipes with PR previews must render unique hostnames per environment. If prod and `pr-*` render the same hostname, Caddy fails with an ambiguous site definition.

Preview-safe hostname pattern:

```jinja
{% if environment == "prod" -%}
example.com
{%- else -%}
pr.{{ environment.removeprefix("pr-") }}.example.com
{%- endif %} {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

`Caddyfile.j2` should treat `params` as sensitive. Use it only for values that must be rendered into Caddy config.

Public URL inference:

- `kitshn track` and `ci-resolve` render `Caddyfile.j2` for the environment with the deployment context and an empty `params` mapping, then read the site addresses of every top-level site block.
- Exactly one distinct concrete host across those addresses yields `https://<host>` (`http://` when the address says so; an explicit port is kept). Zero hosts, wildcard hosts, `localhost`, port-only addresses, or several distinct hosts yield no URL. KitSHn never guesses.
- The rendered text is discarded; it is never written to the VPS.
