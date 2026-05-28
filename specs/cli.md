# CLI
Core commands:

```bash
kitshn bootstrap
kitshn bootstrap --install-missing --installer <installer>
kitshn installers
kitshn doctor
kitshn init <owner/repo> --template <template>
kitshn deploy <owner/repo> --params-file <path> [--ref <ref>] [--environment <name>]
kitshn destroy <owner/repo> --environment <name> [--purge]
kitshn resolve --recipe <owner/repo> --event <push|pull_request|workflow_dispatch> [event flags]
kitshn logs [<owner/repo> [service]] [--environment <name>] [--follow] [--files]
kitshn status [owner/repo] [--environment <name>]
```

Lifecycle helpers can be added when needed:

```bash
kitshn start <owner/repo> [--environment <name>]
kitshn stop <owner/repo> [--environment <name>]
kitshn restart <owner/repo> [--environment <name>]
kitshn affected <owner/repo> [--from <sha>] [--to <sha>]
```

`status` for a single deployment reports:

- checkout ref
- running Compose services
- healthcheck state per service
- Caddy route presence
- last deploy entry from `/logs/.kitshn/kitshn.log`

`logs` behavior:

- `kitshn logs` shows KitSHn's own log stream from `/logs/.kitshn/kitshn.log`.
- `kitshn logs <owner/repo>` shows Docker stdout/stderr logs for all Compose services in the deployment.
- `kitshn logs <owner/repo> <service>` shows Docker stdout/stderr logs for one Compose service.
- `--files` reads file logs under `/logs/<owner>/<repo>/<environment>` instead of Docker logs.
- `--follow` follows the selected log source.

`doctor` verifies server readiness:

- Docker and Docker Compose are available.
- Git, uv, and Caddy are available.
- Missing dependencies are reported explicitly.
- Matching optional installer modules are reported when dependencies are missing.
- canonical roots exist with expected ownership and permissions.
- shared Docker networks such as `kitshn-edge` exist.
- GitHub deploy access works.
- Caddy config validates.

Rules:

- Recipe arguments are always fully qualified `owner/repo` names.
- Environment arguments are GitHub Environment names.
- CLI output should be script-friendly by default.
- Logs should support both Docker stdout/stderr and file logs under `/logs`.
- `deploy` requires `--params-file` pointing at a key/value file. The file is treated as opaque — the `KITSHN_` selection and prefix-stripping happen in CI before the file is built.
- `resolve` is a pure function. It writes `env=`, `action=`, `ephemeral=` lines suitable for `$GITHUB_OUTPUT` and exits non-zero with no output when no `.kitshn.yaml` entry matches.
- Every invocation appends a structured JSON line to `/logs/.kitshn/kitshn.log` with: `timestamp`, `command`, `deployment` (`<owner>/<repo>/<environment>`), `ref`, `compose_project`, `changed_services`, `triggered_by`, `status`.
