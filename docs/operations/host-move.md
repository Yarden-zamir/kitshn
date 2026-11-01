# Host move: `kit.<zone>` to `kitshn.<zone>` (K-1209)

The move has no redirect at all: `kit.<zone>` stops fully (the owner decided on 2026-10-29). So everything that names the old host changes to the new one during the move, and a script proves that nothing is left before the old host goes. Run it after the section 17 pull request deploys: that release takes the old host and the audience tags of both hosts while `KITSHN_OLD_HOST` is set.

Passkeys survive the move, because they belong to the Access team domain (K-113). During the move, the count of Access applications doubles (K-1303).

## Before

1. Merge and deploy the section 17 pull request.
2. Done on 2026-10-29: the KitSHn 1 redirect of `kitshn.<zone>` to `kitshn-legacy.<zone>` and its DNS record are gone with `kitshn-meta`.
3. Check that `https://kitshn.<zone>` no longer answers.

## Move

1. Run the bootstrap with `KITSHN_HOST=kitshn.<zone>` and `KITSHN_OLD_HOST=kit.<zone>`. It makes the Access applications of the new host and the Worker binding `KITSHN_OLD_HOST`, and each `ACCESS_*_AUD` lists the tags of both hosts. Later bootstrap runs keep the old host until step 1 of "After".
2. Check: open `https://kitshn.<zone>` once, decode its Access token (`CF_Authorization`), and check that its `aud` is in the new `ACCESS_ADMIN_AUD` list. The Worker takes both lists during the move, so a mismatch is a bug to fix, not a reason to stop.
3. Worker: add the custom domain `kitshn.<zone>`.
4. Daemons: on each joined machine, change the server address in `machine.json` and restart the daemon. Check that each card shows a signed connection.
5. GitHub App: change the homepage, callback and webhook addresses.
6. Text and config in this repo: `.github/workflows/kitshn2-deploy.yml` (its default `server`, which app repos call with `@main`), `packages/edge/public/install`, `site/apps.js`, `site/index.html`, `site/install/index.html`, `packages/kitshn/skill/SKILL.md`, `AGENTS.md`, and every `kit.<zone>` in `docs/`.
7. Change every link and badge that names the old host, in each of these places:
   - every app repo (`kitshn.config.ts` comments, `kitshn.md`, README badges and links, workflow files);
   - kitshn.com (`site/`) and the kitshn skill (`packages/kitshn/skill/SKILL.md`);
   - the T3 fork docs (`Yarden-zamir/t3code`);
   - the dotfiles skills (`Yarden-zamir/dotfiles`, for example `.claude/skills/neo-brutalism/SKILL.md`).
8. Prove it: `node scripts/host-move-check.ts kit.yarden-zamir.com Yarden-zamir` lists each file that still names the old host and exits 1 while one remains. Repeat steps 7 and 8 until it prints "No link to kit.yarden-zamir.com remains." It searches default branches only, so an open branch that names `kit.` breaks after the move.

## Checks

1. Each daemon is connected with its key.
2. A push deploys an app end to end.
3. A login with a passkey works, and so does the fresh check of `/api/fresh`.
4. `/public/cards.json` and a badge answer.
5. The install script works from `https://kitshn.<zone>/install`.

## After

1. Run the bootstrap with `KITSHN_OLD_HOST=none`. The Worker then takes only the new host and its audience tags.
2. Remove the `kit.` Access applications, the `kit.` custom domain and its DNS record.
3. Run `node scripts/host-move-check.ts kit.yarden-zamir.com Yarden-zamir` again. It passes.
4. Turn on "Passes" in Settings (17.7). Check that `/.well-known/openid-configuration` names `https://kitshn.<zone>` as its issuer.
