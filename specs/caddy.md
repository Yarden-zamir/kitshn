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
- Public-route services must be reachable by Caddy through an edge network such as `kitshn-edge`.

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

`Caddyfile.j2` should treat `params` as sensitive. Use it only for values that must be rendered into Caddy config.
