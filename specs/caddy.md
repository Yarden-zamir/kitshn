# Caddy Ingress
Caddy is global infrastructure installed and managed by KitSHn bootstrap.

DNS is handled outside KitSHn with normal A/AAAA records pointing to the VPS.

Bootstrap owns:

- Caddy install/runtime.
- Caddy global config.
- persistent Caddy `/data` and `/config`.
- base Caddyfile importing `/deployments/Caddyfile`.
- optional: a Caddy build with extra modules, global ACME and DNS options, and the Caddy
  service environment. See "Wildcard preview certificates".

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
- `host(base)`: `base` for `prod`, `<environment>.<base>` for every other environment

When KitSHn runs as root and the Caddy service has its own user, a generated `Caddyfile` is
`root:<caddy group>` with mode `0640`, because it can hold `params` secrets.

Socket ingress:

- `KITSHN_SOCKET_DIR` points at `/deployments/<owner>/<repo>/<environment>/.kitshn/sockets` and is cleared before each deploy.
- `KITSHN_DEFAULT_SOCKET` points at `$KITSHN_SOCKET_DIR/app.sock`.
- Compose services can bind mount `${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}` and listen on `${KITSHN_DEFAULT_SOCKET}`.
- Caddy inside a container can bind the socket itself with `bind unix/{$KITSHN_DEFAULT_SOCKET}|0666`. Caddy removes a stale socket file left by a previous container when it starts, so no sidecar and no cleanup step is needed. `kitshn init --template static` uses this.
- Caddy's `encode` compresses only its default MIME types, and `header` directives run before `encode` sees the type. A custom `Content-Type` set with `header` is only compressed when listed in an explicit `encode { match { header Content-Type ... } }` block.
- Only images that cannot bind a Unix socket need a socket proxy sidecar that listens on `${KITSHN_DEFAULT_SOCKET}` and forwards to the app's internal Compose service port over the project-local default network.
- Caddy routes to sockets with `reverse_proxy unix//{{ paths.default_socket }}`.

Permission model:

- The host Caddy runs as its systemd service user, `caddy` on the supported installers. KitSHn runs as the deploy user, often root.
- Containers usually run as root, so a socket file on the host is owned by root. The host Caddy can connect only when the socket is writable by others, so bind it with mode `0666`. Caddy's `bind unix/...|0666`, socat's `mode=666`, and uvicorn's `--uds` all do this.
- Every parent directory of the socket must be searchable by the Caddy user. KitSHn creates them with mode `0755`.
- Mode `0666` lets any local user connect to the app socket. That fits a single-purpose VPS; the socket is not reachable from the network.
- `diagnose` checks both rules for the Caddy service user and fails the socket with a hint when the user cannot connect. Its `curl` probe runs as the deploy user, so it passes even when Caddy gets a 502.
- When KitSHn runs as root, it runs `caddy validate` as the Caddy service user with `runuser`, in `deploy`, `diagnose`, and `doctor`. Validation creates any missing `log { output file ... }` target. As root, that file would be root-owned, and the service could not open it on reload. `caddy reload` goes through the admin API and needs no switch.
- The service user comes from `systemctl show -p User caddy`. Without systemd or `runuser`, or when the unit runs as root, validation runs as the deploy user.
- Public HTTP recipes with PR previews must render unique hostnames per environment. If prod and `pr-*` render the same hostname, Caddy fails with an ambiguous site definition.

Preview-safe hostname pattern:

```jinja
{{ host("app.example.com") }} {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

Prod serves `app.example.com`; the preview of PR 7 serves `pr-7.app.example.com`. A preview
hostname is exactly one label below the base, so one wildcard certificate covers all of them.
The older `pr.<number>.app.example.com` form is two labels below the base. No wildcard covers
it, so each preview needs its own certificate.

## Wildcard Preview Certificates

Let's Encrypt issues at most 50 new certificates per registered domain in 7 days. Each preview
hostname used to take one, so busy previews blocked new certificates for every site on the
domain.

Recipe side:

- `host(base)` in a non-prod render records `*.<base>` as a comment line at the top of the
  generated `Caddyfile`: `# kitshn preview wildcard: *.<base>`.
- The manifest adds one site per distinct recorded wildcard, before the imports:
  `*.<base> { tls { dns } abort }`. Caddy 2.10 and later use a managed wildcard certificate
  for every covered site and get no certificate per preview. A hostname with no preview gets
  its connection closed.
- The manifest adds these sites only when the global options set a `dns` provider. Without
  one, each preview gets its own certificate, as before.
- A wildcard site exists while at least one preview of that base exists. The first preview
  after none gets a new wildcard certificate.

Host side, set by `bootstrap` flags and kept by later runs that pass the same flags:

- `--caddy-module <path>@v<version>`, repeatable: builds the packaged Caddy version with the
  modules in the `caddy:<version>-builder` image (xcaddy), limited to 2 CPUs. It skips the
  build when `/usr/bin/caddy` reports that version with those module versions. The first
  install adds a `dpkg-divert` of `/usr/bin/caddy` to `/usr/bin/caddy.default`, so a package
  upgrade does not overwrite the build. After a package upgrade, the next bootstrap rebuilds
  for the new packaged version. Only dpkg hosts are supported.
- `--acme-email <email>`: global `email`, plus `cert_issuer acme` (Let's Encrypt) and
  `cert_issuer acme { dir https://acme.zerossl.com/v2/DV90 }`. ZeroSSL is the fallback when
  Let's Encrypt refuses, for example at the rate limit. ZeroSSL needs only the email; Caddy
  gets the EAB credentials itself. The explicit issuers make sites with their own
  `tls { dns }`, such as the wildcard sites, fall back to ZeroSSL too.
- `--dns-provider '<name> <args>'`: the global `dns` option, for example
  `cloudflare {env.CLOUDFLARE_API_TOKEN}`.
- These options go to `/etc/caddy/kitshn-options.caddy`. Bootstrap adds
  `import /etc/caddy/kitshn-options.caddy` to the global options block of
  `/etc/caddy/Caddyfile`, and creates that block when it is missing.
- `--caddy-env-file <file>`: `KEY=VALUE` lines that become `/etc/caddy/kitshn.env`, mode
  `0640` with the Caddy group. A systemd drop-in,
  `/etc/systemd/system/caddy.service.d/kitshn.conf`, starts Caddy with
  `--envfile /etc/caddy/kitshn.env` and without `--environ`, which prints the environment to
  the journal.
- `caddy validate` everywhere (deploy, diagnose, doctor, bootstrap) adds
  `--envfile /etc/caddy/kitshn.env` when the file exists. Validation provisions the DNS
  module, and the module rejects an empty token.
- A new binary, environment, or drop-in needs `systemctl restart caddy`; a reload keeps the
  old process. New options alone reload. The build runs outside the host deploy lock; the
  install, file writes, validation, and restart run inside it.
- Any failure restores the binary and every file, and restarts Caddy when it was touched.

Cloudflare token: an API token with `Zone / Zone / Read` and `Zone / DNS / Edit` on the zone.
The "Edit zone DNS" template gives only DNS edit. A client IP filter must allow the IPv4 and
the IPv6 address of the VPS.

Secrets stay in GitHub. A host workflow writes the token into a `0600` file and runs
`kitshn ci-bootstrap` with the flags above. `ci-bootstrap` reads `KITSHN_VPS_HOST` and
`KITSHN_SSH_KEY` like `ci-deploy`, copies the file with `scp` to a temp file on the VPS,
runs the hosted bootstrap, and removes the temp file. KitSHn's own repo has such a workflow,
`.github/workflows/host.yml`, for the maintainer's VPS.

`Caddyfile.j2` should treat `params` as sensitive. Use it only for values that must be rendered into Caddy config.

Public URL inference:

- `kitshn track` and `ci-resolve` render `Caddyfile.j2` for the environment with the deployment context and an empty `params` mapping, then read the site addresses of every top-level site block.
- Exactly one distinct concrete host across those addresses yields `https://<host>` (`http://` when the address says so; an explicit port is kept). Zero hosts, wildcard hosts, `localhost`, port-only addresses, or several distinct hosts yield no URL. KitSHn never guesses.
- The rendered text is discarded; it is never written to the VPS.
