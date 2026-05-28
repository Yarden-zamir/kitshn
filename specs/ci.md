# CI Rules
A repo auto-deploys when:

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

permissions:
  contents: read
  deployments: write

jobs:
  call:
    uses: Yarden-zamir/kitshn/.github/workflows/deploy.yml@main
    secrets: inherit
```

The caller workflow must grant the reusable workflow at least `contents: read` and `deployments: write`; permissions can only be maintained or reduced across a reusable workflow call.

`kitshn init` writes this file.

`kitshn init` also writes `kitshn.md`, which explains the recipe contract and records the KitSHn source commit that generated it.

## Reusable workflow
`Yarden-zamir/kitshn/.github/workflows/deploy.yml` is the only supported CI entry point for `kitshn deploy` and `kitshn destroy`.

Workflow steps run KitSHn directly from the hosted GitHub ref. Remote VPS deploy/destroy commands also use this hosted CLI through `uvx`, with `$HOME/.local/bin` prepended for non-interactive SSH sessions:

```bash
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn <ci-command>
```

The workflow YAML should stay declarative. Non-trivial logic belongs in KitSHn CLI `ci-*` commands, not inline shell, Node, or Python in the workflow file.

Jobs:

- `resolve` — no `environment:` binding. Runs `kitshn ci-resolve` and emits `matched`, `env`, `action`, `ephemeral`, and `ref`.
- `deploy` — `environment: ${{ needs.resolve.outputs.env }}`. Runs `kitshn ci-write-params`, scps to the VPS through `kitshn ci-deploy`, and runs the hosted KitSHn CLI remotely through `uvx`.
- `teardown` — `environment: ${{ needs.resolve.outputs.env }}`. Runs `kitshn ci-destroy`, which runs the hosted KitSHn CLI remotely through `uvx`. When `ephemeral` is `true`, `kitshn ci-delete-environment` calls `DELETE /repos/{owner}/{repo}/environments/{name}`.

The `environment:` binding on deploy/teardown attaches the run to the GitHub Environment and applies its protection rules and secrets. `environment:` also auto-creates the Environment on first use, so dynamic names like `pr-42` need no `PUT`.

## `KITSHN_` prefix filter
Only secrets and vars whose names start with `KITSHN_` are forwarded into `params.env`. The prefix is stripped when writing: `KITSHN_TOKEN` lands in `params.env` as `TOKEN=…`. The prefix is a GitHub-side selector, not a wire format.

Reserved workflow infrastructure keys are not forwarded into app params:

- `KITSHN_VPS_HOST`
- `KITSHN_SSH_KEY`

Workflow infrastructure uses the same namespace:

- `vars.KITSHN_VPS_HOST` — SSH target.
- `secrets.KITSHN_SSH_KEY` — deploy SSH key.

## PR lifecycle
- `opened`, `synchronize`, `reopened` → deploy.
- `closed` → destroy. Ephemeral entries also DELETE the GitHub Environment.
- `/persistent` and `/logs` for the PR env survive destroy by default.
