# Environment URLs And GitHub Deployments

Status: planned, not implemented.

Two problems drive this work:

1. A merged PR leaves a stale `pr-<n>` GitHub Environment behind. `changeLorg` still has `pr-1` and `pr-2`.
2. There is no link from the GitHub PR/Environment UI to the live preview.

## Decisions Already Made

- No `url:` field in `.kitshn.yaml`. The URL is derived, not declared.
- The URL is resolved from **live Caddy**, not by parsing `Caddyfile.j2` or the generated `Caddyfile`.
- If a single clear URL cannot be derived, attach **no URL**. Do not guess.
- Stable environments keep using GitHub Environments. Ephemeral PR previews stop creating them.

## URL Inference From Live Caddy

After Caddy reload, query the local admin API:

```bash
curl http://127.0.0.1:2019/config/apps/http/servers
```

Walk the active JSON config:

- find `reverse_proxy` handlers whose upstream `dial` equals `deployment.default_socket`
- walk out to the enclosing route matchers
- collect concrete `host` matchers
- exactly one concrete host -> infer `https://<host>`
- zero hosts, wildcard-only hosts, or multiple hosts -> no URL, emit a warning

Because KitSHn socket paths are unique per deployment
(`/deployments/<owner>/<repo>/<env>/.kitshn/sockets/app.sock`), the socket is a reliable
key for mapping an active Caddy route back to a deployment.

### Cases That Must Yield No URL

- `:443 { reverse_proxy unix//... }` — no host matcher, internal-only.
- `*.example.com` — wildcard is not a concrete preview URL.
- `example.com` and `admin.example.com` both pointing at the same socket — ambiguous.

Requires the Caddy admin API enabled and reachable on `127.0.0.1:2019`.

## Stop Creating GitHub Environments For PR Previews

Today `.github/workflows/deploy.yml` sets `environment: ${{ needs.resolve.outputs.env }}` on
every deploy job, which auto-creates a GitHub Environment per PR. Deleting them afterwards is
unreliable: the default `GITHUB_TOKEN` returns `403`, which is why `ci-delete-environment`
already swallows `403` as a warning.

Split the deploy job by `ephemeral`:

- `ephemeral != true` — keep the `environment:` binding, set `environment.url` from the
  inferred URL. Protection rules and environment secrets keep working.
- `ephemeral == true` — no `environment:` binding. Instead create a GitHub Deployment with
  `transient_environment: true`, set status `in_progress`, then `success`/`failure`, and
  include `environment_url` only when the URL was inferred.

On PR close: destroy the VPS deployment, then mark the transient deployment `inactive`. No
Environment DELETE call is needed because none was created.

## Prune Existing Stale Environments

Legacy `pr-*` Environments already exist. Add:

```bash
kitshn github prune-environments <owner/repo> --pattern 'pr-*' --closed-prs
```

Behavior:

- list repo Environments
- match `pr-<number>`
- verify the PR is closed or merged before touching anything
- mark related deployments inactive
- delete the Environment when token permissions allow
- on `403`, print the exact `gh auth refresh` command needed instead of failing silently

## Diagnose Additions

- show the inferred Caddy URL when exactly one exists
- warn when no URL can be inferred
- warn when multiple concrete hosts point at the same deployment socket
- warn when only wildcard hosts point at the socket

## Sequencing

1. Caddy admin API URL inference plus tests for the one/zero/wildcard/multiple cases.
2. GitHub Deployment status API in `ci.py`, with `environment_url` only when inferred.
3. Split `deploy.yml` into stable and ephemeral paths.
4. `prune-environments` for the existing `changeLorg` backlog.
5. Diagnose and docs.
