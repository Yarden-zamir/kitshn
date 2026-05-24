# KitSHn
KitSHn is a small VPS deployment system for GitHub repos.

Core flow:

```text
repo changed -> CI SSHes to VPS -> kitshn deploy <owner/repo> -> affected deployments update
```

Core primitives:

- **Recipe**: a fully qualified GitHub repo name, `owner/repo`, plus its deployment contract.
- **Environment**: a GitHub Environment name, such as `prod`, `stage`, or `test`.
- **Deployment**: one recipe deployed to one environment.
- **Service**: a Docker Compose service inside a recipe.

Docs:

- [Scope](specs/scope.md)
- [Primitives](specs/primitives.md)
- [Filesystem](specs/filesystem.md)
- [Compose And Dependencies](specs/compose-and-dependencies.md)
- [Caddy Ingress](specs/caddy.md)
- [Deploy Flow](specs/deploy-flow.md)
- [CI Rules](specs/ci.md)
- [Bootstrap And Templates](specs/bootstrap-and-templates.md)
- [CLI](specs/cli.md)
