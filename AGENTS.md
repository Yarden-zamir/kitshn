# AGENTS.md

## kitshn 2 (TypeScript)
- This repo is kitshn 2. KitSHn 1 lives in `Yarden-zamir/kitshn-1`. [docs/README.md](docs/README.md) is the index of the docs and of the numbered `K-` requirements. `docs/internals/overview.md` has the parts, the request paths and the budget.
- It is a pnpm workspace: `packages/edge` is the Worker, its Durable Object and the map UI (Preact). `packages/kitshn` is the recipe package and CLI for app repos (`defineApp`, `defineApps`, `kitshn check`, `kitshn deploy`). `packages/daemon` is the machine daemon; `node packages/daemon/scripts/build.ts [linux-arm64]` compiles it with Bun into `packages/daemon/dist/`. Run `pnpm install`, then `pnpm run check` (format, lint, typecheck, tests) before a push. The daemon tests run on Bun, so `bun` must be on the path. CI runs the same in `.github/workflows/edge.yml`.
- `src/core` is pure logic shared by the Worker and the UI: the model, changes and the K-105 guard, placement, visitor levels and the Access compile. Test it there. Tests in `packages/edge/test` run the Worker and its Durable Object in workerd (`@cloudflare/vitest-plugin`); they sign Access tokens with a test key, so a route test goes through the real JWT check. `src/core/schema.ts` decodes wire input with Effect Schema and keeps the UI bundle free of `effect`.
- Local development: `pnpm --filter @kitshn/edge dev`. Put `DEV_IDENTITY=you@example.com` and optionally `DEV_DEMO=1` in `packages/edge/.dev.vars`; the Worker honours them only on localhost.
- PR screenshots and clips: write a scenario like `packages/edge/scripts/captures/pause.ts` and run `pnpm --filter @kitshn/edge capture packages/edge/scripts/captures/pause.ts` from the repo root (paths are relative to where you run pnpm). It runs each view and colour scheme on a fresh dev server (its own `KITSHN_DEV_STATE`, never your local state), and writes PNGs and, for a clip, an MP4 with the page's sound to `~/.cache/kitshn-captures/<scenario>`. Install Chromium once with `pnpm --filter @kitshn/edge exec playwright install chromium`; clips need `ffmpeg`.
- `packages/edge/public/join` is the machine join script (K-602). `packages/edge/public/install` is the bootstrap script (K-1201). It deploys the bundle that `pnpm run build` writes to `packages/edge/dist/kitshn-edge.tar.gz`; pass a local bundle with `KITSHN_BUNDLE=<path>`.
- `site/` is the kitshn.com site: static files with no build, deployed by `kitshn.config.ts` and `.github/workflows/kitshn-site.yml`. Its "Live right now" list reads `kit.<zone>/public/cards.json` (K-1118). Its pictures come from `packages/edge/scripts/captures/site.ts`; keep the text true when a feature it names changes.
- `packages/kitshn/skill/SKILL.md` is the agent skill for app repos (`.claude/skills/kitshn` links it, and `kitshn.tgz` ships it). Keep it true when a recipe field, a CLI command or a deploy message changes. The KitSHn 1 skill stays in `Yarden-zamir/kitshn-1`, with no link here, so kitshn 2 agents do not read it.
- Everything kitshn makes in Access has a name that starts with `kitshn `. Never change or delete other Access objects.

## Documentation

Follow the documentation rules of upstream T3 Code. Most code changes need no doc change: agents can read the code.

- `docs/internals/` holds one file per topic: decisions and their reasons, constraints across components, and traps that the source does not show. Before you add a line, ask what a maintainer gets wrong without it.
- Do not enumerate features, fields or UI states, narrate control flow, or append PR summaries. Types, tests and code are the record. A local reason goes in a short code comment.
- `docs/user/` holds task guides for users. `docs/operations/` holds maintainer procedures.
- A rule that code, tests or decisions cite has a `K-` number: a line `- **K-<n>** <rule>` in the internals file of its block (the index in `docs/README.md`). Code comments that name "section <n>" mean the `K-<n>xx` rules.
- Never renumber a rule. When a rule goes, delete its line only when `git grep K-<n>` finds no reference left; else keep it.
- Take a new `K-` number from `node scripts/next-k.ts <block>`: it counts the numbers of main and of every open PR, and the `spec numbers` check fails a PR that takes one of them.
- When a decision or constraint changes, rewrite the affected line. Do not append a second account of the new behavior.

## Plans and work artifacts

- Do not commit plans, design briefs, research notes or agent scratch files. A decision that still holds goes into the right docs file. A merged PR is the record of the work.
- Track open work in a GitHub issue. Keep material that must not be public outside the repo.
