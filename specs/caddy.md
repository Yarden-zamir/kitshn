# Caddy Ingress
Caddy is global infrastructure installed and managed by KitSHn bootstrap.

DNS is handled outside KitSHn with normal A/AAAA records pointing to the VPS.

Bootstrap owns:

- Caddy install/runtime.
- Caddy global config.
- persistent Caddy `/data` and `/config`.
- base Caddyfile importing `/deployments/*/*/*/Caddyfile`.

Recipe route contract:

- A recipe that routes public traffic must provide `Caddyfile` or `Caddyfile.j2`.
- `Caddyfile` is copied as static Caddy config.
- `Caddyfile.j2` is rendered with Jinja2 into the deployment `Caddyfile`.
- Public-route services must be reachable by Caddy through an edge network such as `kitshn-edge`.

Deploy behavior:

- Generate `/deployments/<owner>/<repo>/<environment>/Caddyfile`.
- Validate the full Caddy config once.
- Reload Caddy once when generated Caddyfiles changed.
- If validation fails, keep the previous generated Caddyfile active and fail deploy.

Jinja2 context includes:

- recipe name
- environment name
- deployment identity
- deployment paths
- GitHub Environment vars
