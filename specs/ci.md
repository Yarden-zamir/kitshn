# CI Rules
A repo auto-deploys only when:

- it has the GitHub topic `kitshn-deploy`
- a `.kitshn.yaml` entry matches the triggering event

## `.kitshn.yaml`
Lives at the recipe repo root.

```yaml
deploy:
  - on: push
    branch: main
    name: prod

  - on: push
    branch: "dev*"
    name: feature

  - on: pull_request
    name: "pr-{pr}"
    ephemeral: true
```

Fields per entry:

- `on` — `push` or `pull_request`.
- `branch` — glob, required when `on: push`.
- `name` — env identity. Literal or template using `{branch}`, `{pr}`, `{sha7}`.
- `ephemeral` — `true` means destroy also deletes the GitHub Environment. Defaults to `false`.

First matching entry wins. No match means no auto-deploy.

## Caller workflow
Each recipe ships `.github/workflows/kitshn.yml`:

```yaml
on:
  push:
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:
    inputs:
      environment: { required: true,  type: string }
      ref:         { required: false, type: string }

jobs:
  call:
    uses: kitshn-org/kitshn/.github/workflows/deploy.yml@v1
    secrets: inherit
```

`kitshn init` writes this file.

## Reusable workflow
`kitshn-org/kitshn/.github/workflows/deploy.yml` is the only supported entry point for `kitshn deploy` and `kitshn destroy`.

Jobs:

- `resolve` — no `environment:` binding. Runs `kitshn resolve` and emits `env`, `action`, `ephemeral`.
- `deploy` — `environment: ${{ needs.resolve.outputs.env }}`. Builds `params.env` from `vars` and `secrets` filtered by `KITSHN_` prefix, scps to the VPS, runs `kitshn deploy --params-file …`.
- `teardown` — `environment: ${{ needs.resolve.outputs.env }}`. Runs `kitshn destroy`. When `ephemeral` is `true`, also calls `DELETE /repos/{owner}/{repo}/environments/{name}`.

The `environment:` binding on deploy/teardown attaches the run to the GitHub Environment and applies its protection rules and secrets. `environment:` also auto-creates the Environment on first use, so dynamic names like `pr-42` need no `PUT`.

## `KITSHN_` prefix filter
Only secrets and vars whose names start with `KITSHN_` are forwarded into `params.env`. The prefix is stripped when writing: `KITSHN_TOKEN` lands in `params.env` as `TOKEN=…`. The prefix is a GitHub-side selector, not a wire format.

Workflow infrastructure uses the same namespace:

- `vars.KITSHN_VPS_HOST` — SSH target.
- `secrets.KITSHN_SSH_KEY` — deploy SSH key.

## PR lifecycle
- `opened`, `synchronize`, `reopened` → deploy.
- `closed` → destroy. Ephemeral entries also DELETE the GitHub Environment.
- `/persistent` and `/logs` for the PR env survive destroy by default.
