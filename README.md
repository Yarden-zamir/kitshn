<img src="packages/edge/public/favicon.svg" width="72" alt="kitshn icon: a yellow pot on a black tile">

# kitshn

kitshn deploys apps from GitHub to Cloudflare and to your own machines, and a map decides who can open each one: a card inside a circle is shared with that circle. The admin and the map live at `kit.<zone>`.

- Website: [kitshn.com](https://kitshn.com)
- Requirements, each with a `K-` number: [SPEC.md](SPEC.md)
- Design: [docs/architecture.md](docs/architecture.md). Order of work: [docs/migration.md](docs/migration.md)
- Add kitshn to an app repo: the agent skill [packages/kitshn/skill/SKILL.md](packages/kitshn/skill/SKILL.md). Install it with `kitshn skill install`.
- Contributors and agents: [AGENTS.md](AGENTS.md)

KitSHn 1, the VPS and Caddy version, lives in [Yarden-zamir/kitshn-1](https://github.com/Yarden-zamir/kitshn-1).

[MIT](LICENSE)
