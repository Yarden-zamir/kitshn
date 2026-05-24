# Filesystem
Canonical deployment-owned paths use `owner/repo/environment` ordering.

```text
/deployments/<owner>/<repo>/<environment>
/params/<owner>/<repo>/<environment>
/persistent/<owner>/<repo>/<environment>
/logs/<owner>/<repo>/<environment>
```

Deployment root:

- Contains the recipe checkout for the selected ref.
- Contains generated deployment `Caddyfile` when public traffic is routed.
- Contains `logs` symlink to `/logs/<owner>/<repo>/<environment>`.

Params:

- Contains `params.env` generated on every deploy from GitHub Environment params.
- `KITSHN_PARAMS_FILE=/params/<owner>/<repo>/<environment>/params.env`.

Runtime env:

- `KITSHN_RECIPE=<owner/repo>`.
- `KITSHN_ENVIRONMENT=<environment>`.
- `KITSHN_DEPLOYMENT=<owner>/<repo>/<environment>`.
- `KITSHN_PARAMS_FILE=/params/<owner>/<repo>/<environment>/params.env`.
- `KITSHN_DATA_DIR=/persistent/<owner>/<repo>/<environment>`.
- `KITSHN_LOG_DIR=/logs/<owner>/<repo>/<environment>`.

Persistent data:

- Deployment apps write persistent data under `KITSHN_DATA_DIR`.
- `KITSHN_DATA_DIR=/persistent/<owner>/<repo>/<environment>`.

Logs:

- Apps log to stdout.
- File logs go under `KITSHN_LOG_DIR`.
- `KITSHN_LOG_DIR=/logs/<owner>/<repo>/<environment>`.
