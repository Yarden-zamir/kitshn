# CLI
Core commands:

```bash
kitshn bootstrap
kitshn init <owner/repo> --template <template>
kitshn deploy <owner/repo> [--ref <ref>] [--environment <name>]
kitshn logs <owner/repo> [service] [--environment <name>] [--follow] [--files]
kitshn status [owner/repo] [--environment <name>]
```

Lifecycle helpers can be added when needed:

```bash
kitshn start <owner/repo> [--environment <name>]
kitshn stop <owner/repo> [--environment <name>]
kitshn restart <owner/repo> [--environment <name>]
kitshn affected <owner/repo> [--from <sha>] [--to <sha>]
```

Rules:

- Recipe arguments are always fully qualified `owner/repo` names.
- Environment arguments are GitHub Environment names.
- CLI output should be script-friendly by default.
- Logs should support both Docker stdout/stderr and file logs under `/logs`.
