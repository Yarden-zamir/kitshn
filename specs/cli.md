# CLI

Flags, arguments, and usage live in `kitshn <command> --help`. This spec records behavior
that `--help` cannot express: invariants, side effects, and failure semantics.

## Universal Rules

- Recipe arguments are always fully qualified `owner/repo` names.
- Environment arguments are GitHub Environment names, sanitized per [Primitives](primitives.md).
- Output is script-friendly by default: `key=value` lines or JSON, not prose.
- Every invocation appends a structured JSON line to `/logs/.kitshn/kitshn.log` with
  `timestamp`, `command`, `deployment`, `ref`, `compose_project`, `changed_services`,
  `triggered_by`, and `status`. A failed entry adds `error`. When the failed command names a
  recipe and an environment (or its default environment), the entry also carries that
  `deployment` and `compose_project`. Log-append failures never fail the command.

## Remote Execution

`diagnose`, `status`, `logs`, `compose`, `params list`, and `params get` accept `--vps-host`.
With it, the command first probes the host with a non-interactive SSH connection and fails
with the SSH error when unreachable, then re-runs the same invocation there, minus
`--vps-host`, as `bash -lc` with `$HOME/.local/bin` prepended to PATH and the hosted
`uvx --from git+... kitshn` CLI. The remote exit code becomes the local exit code. A login
shell is required because non-interactive SSH sessions do not have `uvx` on PATH.

## Self-Check

`self-check` prints the installed version, the latest published version and whether it came
from a release or a tag, and the detected install source. It exits `1` when the installed
version is lower than the latest, after printing the upgrade commands. Network failures are
reported as errors, never as "current".

## Try

`try` builds and runs the recipe's `compose.yml` without touching routing or deployments:

- Fails with a clear message when the directory has no `compose.yml` or `compose.yaml`, when
  `--params-file` does not exist, when `docker info` fails locally, or when the VPS SSH probe
  fails. It also refuses to run locally under Docker Desktop, whose host bind mounts cannot
  carry Unix sockets, and points at `--vps-host`.
- Creates one temporary root and derives every KitSHn path from it, so the socket, params,
  data, and log directories never overlap a real deployment. The environment name is
  `try-<pid>`, which makes the Compose project name unique per run.
- Runs Compose from the temporary deployment root with `COMPOSE_FILE` pointing at the recipe
  file, so build contexts resolve against the recipe directory.
- Waits for healthchecks and for the default socket, then requests `--path` over the socket
  with `curl` and reports the HTTP status and content type.
- Prints the last 50 lines of Compose logs when the check fails or an error occurs.
- Cleans up with `down --remove-orphans --volumes --rmi local` and removes the temporary root,
  unless `--keep` is passed; then it prints the curl and cleanup commands.
- `--vps-host` copies the recipe with `rsync` (honoring `.gitignore`, excluding `.git`) to
  `/tmp/kitshn-try-<name>-<pid>/src` on the VPS (created with `umask 077`; a copied params
  file gets mode `600`), resolves the recipe name locally and passes it with `--recipe`, runs
  hosted `kitshn try` there, and removes the remote directory afterwards. It warns first that the build and containers run on the
  production host, that images, containers, networks, and volumes are created there, and what
  cleanup removes. Pulled base images stay in the VPS image cache.

## Track

`track` follows one commit from the laptop, in order, each step with its own timeout flag:

1. Find the GitHub Actions run for the commit (`HEAD` unless `--sha`). No run within
   `--run-start-timeout` fails with a hint to push.
2. Wait for the run to finish, printing each job's status transitions. A failed run stops
   `track` after printing `gh run view --log-failed`.
3. Resolve the environment from `.kitshn.yaml` for the current branch, then for the open pull
   request, unless `--environment` is given.
4. Read `kitshn status` on the VPS over SSH (`--vps-host`, defaulting to the repo's
   `KITSHN_VPS_HOST` variable) until the ref equals the commit, every service is running and
   healthy when healthchecked, and the default socket exists when a route exists.
5. Request the public URL inferred from `Caddyfile.j2` (or `--url`) until it answers with a
   status below 500, so a login wall or a 404 at `/` counts as serving. With `--expect`, it waits
   for a 2xx response and,
   with `--expect`, contains the text. No single concrete hostname means a warning, not a
   failure.

Exits non-zero when any step fails.

## Deploy And Destroy

- `deploy` and `destroy` hold the host deploy lock; see [Deploy Flow](deploy-flow.md).

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
last deploy entry from `/logs/.kitshn/kitshn.log`, successful or failed.

## Diagnose

Checks, in order: deployment root, params file, socket directory, a warning when the default socket path is longer than 107 bytes, Compose file, `docker
compose ps`, socket-proxy network attachment, generated Caddyfile, its `unix//...` targets
exist and are sockets, whether the Caddy service user can connect to each socket, optional
`curl --unix-socket` probes when curl is available, and host Caddy config validation. Each
socket is checked once, even when several routes use it.

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
- KitSHn has no command that writes params. They are set with `gh secret set` and
  `gh variable set`; the README lists the mistakes to avoid.
- Values are stored quoted and escaped for Compose (`ci.write_params_from_github` uses
  `json.dumps`). Reads decode that encoding, so `--show` returns the exact runtime value.
  Hand-parsing `params.env` returns the surrounding quotes instead.

## Recipe Auth

Derives the GitHub repo from `gh`, generates a per-recipe SSH key, authorizes the public key
locally or over SSH, and sets `KITSHN_SSH_KEY` plus `KITSHN_VPS_HOST` through `gh`. If
`--vps-host` is an SSH alias, it stores the resolved `user@hostname`, not the alias.

## Init

Writes the fixed required recipe contract files. `--docker` and `--routing` add optional
example contract files. `--template static` writes a complete static-site recipe and rejects
`--docker` and `--routing`; `--hostname` and `--site-dir` apply only with it. Refuses to
overwrite existing files without `--force`.

Always ends `kitshn.md` with the Origin section, and prints the ordered checklist: create
the repo without pushing, `recipe auth`, optional `try`, push, `track`. The static template
prepends its own steps and flags the placeholder hostname when `--hostname` was omitted.

## CI Commands

Hidden `ci-*` commands exist for the reusable workflow. `ci-resolve` also emits `url=`, the
public URL inferred from `Caddyfile.j2` for the resolved environment, or empty.
`ci-preflight` fails with the `kitshn recipe auth` command when `KITSHN_VPS_HOST` or
`KITSHN_SSH_KEY` is missing. `ci-verify` requests `KITSHN_URL` until it answers below 500 or
`KITSHN_VERIFY_TIMEOUT` seconds pass, writes the URL, status, and content type to the job
summary, posts a deployment status with the check result as its description on the job's GitHub
deployment, and
fails when the final response is 5xx. A 4xx, such as a login wall or a 404 at `/`, means the site serves and passes. When `KITSHN_REF`, the ref the deploy checked out, is a full commit SHA, the summary ends with the `kitshn track --sha <sha> --environment <env>` command for that run. For a pull request that is the head SHA, not the merge SHA in `GITHUB_SHA`. When the URL never answers before the timeout (for example
a preview hostname without DNS), it still writes the summary row and a `failure` deployment
status, then fails. With no URL it writes a note and succeeds.

## Skill

`skill show` prints the bundled agent skill. `skill link-claude` and `skill link-opencode`
symlink it into `~/.claude/skills/` and `~/.opencode/skills/`. The link targets `KITSHN_SKILL_DIR`
when it is set. The Homebrew wrapper sets it to the formula's `opt` path, so the link follows
`brew upgrade`. A link from `uvx`, which runs from uv's cache, breaks when the cache is pruned;
link from Homebrew or `uv tool install`. An existing link to another `kitshn-deploy-service`
directory is replaced. Existing non-matching skill
paths are never overwritten.

## Doctor

Verifies, without changing state: Docker and Docker Compose available; Git, `gh`, uv, and
Caddy available; canonical roots exist with expected ownership and permissions; shared Docker
networks such as `kitshn-edge` exist; Caddy config validates, as the Caddy service user when KitSHn runs as root. Reports `gh` auth status —
public repos work unauthenticated, private repos need `gh auth login` on the VPS deployment
user. Missing dependencies are reported explicitly, with matching installer modules.
