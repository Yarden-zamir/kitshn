# CI Rules
A repo auto-deploys only when:

- it has the GitHub topic `kitshn-deploy`
- the pushed branch matches an auto-deploy environment mapping

Mapping syntax:

```text
environment(branch-glob)
```

Example:

```text
prod(main),stage(dev),feature(dev*),test
```

Meaning:

- `prod(main)`: push to `main` deploys environment `prod`.
- `stage(dev)`: push to `dev` deploys environment `stage`.
- `feature(dev*)`: push to branches matching `dev*` deploys environment `feature`.
- `test`: environment exists, but no push auto-deploys it.

Automatic CI command shape:

```bash
kitshn deploy <owner/repo> --ref <branch-or-sha> --environment <environment>
```

Manual `workflow_dispatch` can deploy any branch or SHA to any GitHub Environment.

Manual inputs:

```text
recipe: owner/repo
ref: branch-or-sha
environment: GitHub Environment name
```

Concurrency:

- CI uses a GitHub Actions concurrency group per deployment identity, `<owner>/<repo>/<environment>`.
- Two deploy jobs for the same deployment must not run at the same time.
