# Bootstrap And Templates
Bootstrap prepares the VPS.

Bootstrap installs or verifies:

- Docker
- Docker Compose plugin
- Git
- uv
- Caddy

Bootstrap creates or verifies:

- deployment user
- `/deployments`
- `/params`
- `/persistent`
- `/logs`
- shared Docker networks such as `kitshn-edge`
- GitHub deploy access
- registered recipe checkouts

Commands:

```bash
kitshn bootstrap
kitshn bootstrap-remote <ssh-target>
```

Recipe templates should stay boring and editable.

Command:

```bash
kitshn init <owner/repo> --template <template>
```

Initial templates:

- `node-service`
- `static-site`
- `worker`
- `settings-repo`
