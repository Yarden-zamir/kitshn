# CLI

Flags, arguments, and usage live in `kitshn <command> --help`. This spec records behavior
that `--help` cannot express: invariants, side effects, and failure semantics.

## Universal Rules

- Recipe arguments are always fully qualified `owner/repo` names.
- Environment arguments are GitHub Environment names, sanitized per [Primitives](primitives.md).
- Output is script-friendly by default: `key=value` lines or JSON, not prose.
- Every invocation appends a structured JSON line to `/logs/.kitshn/kitshn.log` with
  `timestamp`, `command`, `deployment`, `ref`, `compose_project`, `changed_services`,
  `triggered_by`, and `status`. Log-append failures never fail the command.

## Deploy And Destroy

- `deploy` requires `--params-file` pointing at a key/value file. The file is opaque: the
  `KITSHN_` selection and prefix-stripping happen in CI before the file is built.
- `destroy --purge` additionally deletes persistent data and file logs.

## Resolve

- `resolve` is a pure function of its inputs and `.kitshn.yaml`.
- It writes `env=`, `action=`, and `ephemeral=` lines suitable for `$GITHUB_OUTPUT`.
- It exits non-zero with no output when no `.kitshn.yaml` entry matches.
- `workflow_dispatch` bypasses `.kitshn.yaml` entries and deploys the requested environment
  name directly, so any recipe can deploy a non-prod environment on demand.

## Status

Reports, per deployment: checkout ref, running Compose services, healthcheck state per
service, Caddy route presence, the default Unix socket path and whether it exists, and the
last deploy entry from `/logs/.kitshn/kitshn.log`.

## Diagnose

Checks, in order: deployment root, params file, Compose file, socket directory, `docker
compose ps`, socket-proxy network attachment, generated Caddyfile, its `unix//...` targets
exist and are sockets, optional `curl --unix-socket` probes when curl is available, and host
Caddy config validation.

Exits non-zero when any check fails. Warnings do not fail the command.

Failure hints are attached for known-confusing cases: `ambiguous site definition` points at
non-environment-aware Caddy hostnames; `connection refused` on a socket probe points at the
proxy-to-app hop rather than the socket itself.

## Logs

- No recipe: KitSHn's own log stream from `/logs/.kitshn/kitshn.log`.
- Recipe: Docker stdout/stderr for all Compose services in the deployment.
- Recipe and service: Docker stdout/stderr for one service.
- `--files` reads file logs under `/logs/<owner>/<repo>/<environment>` instead.

## Compose

Runs Docker Compose in the deployment checkout with KitSHn's exact `--project-name`,
`--env-file`, working directory, and runtime env. Exists because raw `docker compose` in the
same directory misses required params and emits misleading blank-variable warnings.

## Params

- `params list` prints the params file path and each param name as `set` or `empty`. It never
  prints values.
- `params get` prints presence only; `--show` prints the value on stdout.
- Values are stored quoted and escaped for Compose (`ci.write_params_from_github` uses
  `json.dumps`). Reads decode that encoding, so `--show` returns the exact runtime value.
  Hand-parsing `params.env` returns the surrounding quotes instead.

## Recipe Auth

Derives the GitHub repo from `gh`, generates a per-recipe SSH key, authorizes the public key
locally or over SSH, and sets `KITSHN_SSH_KEY` plus `KITSHN_VPS_HOST` through `gh`. If
`--vps-host` is an SSH alias, it stores the resolved `user@hostname`, not the alias.

## Init

Writes the fixed required recipe contract files. `--docker` and `--routing` add optional
example contract files. Refuses to overwrite existing files without `--force`.

## Skill

`skill show` prints the bundled agent skill. `skill link-claude` and `skill link-opencode`
symlink it into `~/.claude/skills/` and `~/.opencode/skills/`. Existing non-matching skill
paths are never overwritten.

## Doctor

Verifies, without changing state: Docker and Docker Compose available; Git, `gh`, uv, and
Caddy available; canonical roots exist with expected ownership and permissions; shared Docker
networks such as `kitshn-edge` exist; Caddy config validates. Reports `gh` auth status —
public repos work unauthenticated, private repos need `gh auth login` on the VPS deployment
user. Missing dependencies are reported explicitly, with matching installer modules.
