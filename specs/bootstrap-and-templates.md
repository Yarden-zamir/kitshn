# Bootstrap And Templates
Bootstrap prepares the VPS and is idempotent.

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
- `/logs/.kitshn`
- shared Docker networks such as `kitshn-edge`
- GitHub deploy access

Running `kitshn bootstrap` repeatedly is safe. It creates missing resources, verifies existing resources, and only changes existing configuration when it does not match KitSHn's expected state. At the end, it runs the same checks as `kitshn doctor`.

Commands:

```bash
kitshn bootstrap
kitshn bootstrap-remote <ssh-target>
kitshn doctor
```

`kitshn doctor` performs the verification checks without making changes.

Recipes are not registered separately. `kitshn deploy` creates the deployment, params, persistent, and logs roots on first run and clones the recipe into the deployment root. `kitshn status` walks `/deployments/*/*/*`.

Every template includes:

- `.kitshn.yaml` with at least one entry, defaulting to `main` → `prod` and a `pr-{pr}` ephemeral entry.
- `.github/workflows/kitshn.yml` calling the kitshn-hosted reusable workflow with `secrets: inherit`.

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
