# kitshn docs

## Using kitshn

- Add kitshn to an app repo: the agent skill [packages/kitshn/skill/SKILL.md](../packages/kitshn/skill/SKILL.md). Install it with `kitshn skill install`.
- [Know who opens your app](user/app-identity.md)
- [Trust kitshn passes in an outside service](user/passes.md)
- [Write a provider](user/write-a-provider.md)

## Working on kitshn

Start with [AGENTS.md](../AGENTS.md). Its [documentation rules](../AGENTS.md#documentation) say what goes into these docs.

Internal notes hold the decisions, the constraints across components, and the traps that the source does not explain. Each rule that code, tests or decisions cite has a stable `K-` number. A rule `K-<section><nn>` lives in the file of its section:

| Numbers | File |
| --- | --- |
| K-001 to K-006, terms, parts, budget | [Overview](internals/overview.md) |
| K-1xx, K-4xx | [Login and Access](internals/access.md) |
| K-2xx, K-3xx | [Circles, shares and resources](internals/circles-and-resources.md) |
| K-5xx | [Map](internals/map.md) |
| K-6xx | [Machines and the daemon](internals/machines.md) |
| K-7xx | [Providers and the local interface](internals/providers.md) |
| K-8xx, K-9xx | [Recipes, deploys and previews](internals/deploys.md) |
| K-10xx, K-11xx | [Library, files and sites](internals/library-and-sites.md) |
| K-12xx, K-13xx, K-14xx | [Bootstrap, budget and migration](internals/bootstrap-and-budget.md) |
| K-15xx | [History, Undo and the pause](internals/history-and-pause.md) |
| K-16xx | [Features from the machine map](internals/machine-map-features.md) |
| K-17xx | [Machine identity and agent rights](internals/agent-rights.md) |
| K-18xx | [Logs, backups and the state export](internals/logs-and-backups.md) |
| K-19xx | [Notifications](internals/notifications.md) |
| K-20xx | [Ports](internals/ports.md) |

Maintainer procedures:

- [Migration from the machine map](operations/migration.md)
- [Host move to `kitshn.<zone>`](operations/host-move.md)
