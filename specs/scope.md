# Scope
KitSHn is a small VPS deployment system for GitHub repos.

Core flow:

```text
repo changed -> CI SSHes to VPS -> kitshn deploy <owner/repo> -> affected deployments update
```

## Goals
- Recipes stay autonomous and map directly to GitHub repos.
- Compose is the runtime source of truth.
- Local images are built on the VPS; external images are pulled normally.
- Dependencies are explicit through `kitshn.depends_on`.
- Caddy is global bootstrap-managed infrastructure and the only managed ingress layer.
- GitHub Environments provide environment identity, vars, and secrets.
- Deployment paths, params, logs, and persistent data are predictable.
- Deployment params files are generated outside the recipe checkout.
- Bootstrap and recipe creation are simple enough to automate.
