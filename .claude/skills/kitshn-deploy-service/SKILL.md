---
name: kitshn-deploy-service
description: Prepare or debug a service repo deployed with KitSHn.
license: MIT
---

# kitshn-deploy-service

Use when adding KitSHn deployment files to a service repo or fixing a KitSHn deployment.

## Rules

- Inspect the repo before deciding Docker, routing, env vars, socket support, persistence, or singleton/PR deployments.
- Do not print, paste, inspect, or transfer secret values unless unavoidable and explicitly approved.
- If secrets are needed, prefer giving the user exact `gh secret set ...` commands to run themselves. You can still set non-sensitive GitHub variables directly.
- Use `KITSHN_<NAME>` for GitHub params. KitSHn strips the prefix before writing `params.env`.
- Keep singleton services as `main -> prod` only. Bots, workers with shared tokens, non-preview-safe state, and fixed public domains are usually singleton.
- Add Caddy only for public HTTP ingress.

## Fast Path

1. Inspect:

```bash
git status --short
```

2. Initialize missing files:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn init --docker
```

Use `--routing` only when a public hostname is needed.

3. For singleton services, reduce `.kitshn.yaml` to:

```yaml
deploy:
  - on: push
    branch: main
    name: prod
```

4. Configure deploy SSH:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn recipe auth --vps-host <ssh-target>
```

5. Commit and push only files that exist:

```bash
git add .kitshn.yaml .github/workflows/kitshn.yml kitshn.md compose.yml Dockerfile .dockerignore Caddyfile.j2 .gitignore
git commit -m "chore: add KitSHn deployment config"
git push
```

## Compose

- Use `${NAME:?NAME is required}` for required params.
- Mount `${KITSHN_DATA_DIR}` for persistent app state.
- Add `kitshn.depends_on: "owner/repo"` when another recipe redeploy should recreate this service.
- Public HTTP ingress defaults to Unix sockets. Mount `${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}`, listen on `${KITSHN_DEFAULT_SOCKET}`, and route Caddy with `reverse_proxy unix//{{ paths.default_socket }}`.
- For TCP-only images, add a sidecar such as `alpine/socat` that listens on `${KITSHN_DEFAULT_SOCKET}` and forwards to `TCP:<service>:<port>`.

Minimal worker/bot shape:

```yaml
services:
  app:
    build: .
    pull_policy: build
    environment:
      TOKEN: ${TOKEN:?TOKEN is required}
      APP_HOME: /data
      KITSHN_RECIPE: ${KITSHN_RECIPE}
      KITSHN_ENVIRONMENT: ${KITSHN_ENVIRONMENT}
      KITSHN_DEPLOYMENT: ${KITSHN_DEPLOYMENT}
      KITSHN_PARAMS_FILE: ${KITSHN_PARAMS_FILE}
      KITSHN_DATA_DIR: ${KITSHN_DATA_DIR}
      KITSHN_LOG_DIR: ${KITSHN_LOG_DIR}
      KITSHN_SOCKET_DIR: ${KITSHN_SOCKET_DIR}
      KITSHN_DEFAULT_SOCKET: ${KITSHN_DEFAULT_SOCKET}
    volumes:
      - ${KITSHN_DATA_DIR}:/data
```

## Secrets And Vars

For non-sensitive vars, set them directly:

```bash
gh variable set KITSHN_NAME --repo <owner/repo> --body <value>
```

For secrets, ask the user to run the command so the value never enters the conversation or tool output:

```bash
gh secret set KITSHN_TOKEN --repo <owner/repo>
```

If transferring an existing remote `.env`, prefer telling the user what command to run. Only perform transfers yourself after explicit approval and without printing values.

## Verify

```bash
docker compose --env-file <test-params.env> config --format json >/dev/null
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn resolve --recipe <owner/repo> --event push --branch main --sha abcdef123456 --config .kitshn.yaml
```

After push:

```bash
gh run watch --repo <owner/repo> --exit-status
```

Then verify remotely with `kitshn diagnose <owner/repo> --environment <env>`, public routes, or service logs. Do not dump full container envs because they may include secrets.

## Common Fixes

- Missing Compose env means create matching `KITSHN_<NAME>` secret or variable.
- Workflow permission error means caller workflow needs `contents: read` and `deployments: write`.
- Host Caddy cannot resolve Docker service names unless Caddy is in Docker on that network; use Unix socket ingress or a socket-proxy sidecar.
- Split-container services may need shared volumes/networks for generated config, tools, sockets, or state.
- If `gh secret set --body-file` fails, use stdin or plain interactive `gh secret set`.
