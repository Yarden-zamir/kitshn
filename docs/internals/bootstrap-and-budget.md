# Bootstrap, budget and migration

This file holds the rules for the bootstrap (K-12xx), the free plan budget (K-13xx) and the migration from the machine map and KitSHn 1 (K-14xx). The budget table is in [overview.md](overview.md#free-plan-budget).

## Bootstrap

- **K-1201** One command sets up kitshn on a new Cloudflare account: `curl -fsSL https://kit.yarden-zamir.com/install | sh`, with the API token in `CLOUDFLARE_API_TOKEN`. The `/install` path needs no login.
- **K-1202** The owner makes the token through a link with the permissions filled in. On a 403, the script names the missing permission and the link. A 5xx or error 10013 gets one more try for a call that is safe to repeat. The asset upload, which Cloudflare refuses for minutes at a time, gets two more tries, after 5 s and 15 s.
- **K-1203** The script uses only `curl`, `sh` and `jq`. It uploads the Worker bundle of a kitshn release through the Workers API, with static assets through the direct upload flow. It does not use Wrangler.
- **K-1204** The script creates, or reuses: the Worker with its Durable Object, the R2 bucket, the Worker secrets, the Access applications of the admin, `/connect`, `/agent`, `/api/fresh`, `/notify`, `/device` and the public Bypass paths, the login applications of pages and files (K-1004), the Owner circle policy, the One-time PIN and GitHub login methods, seat expiration (K-111), the login pages (K-1130) and the VAPID key (K-1606). The script is the list of what it makes.
- **K-1205** A second run changes nothing that is already right. It prints what it changed.
- **K-1206** At the end, the script prints the admin address and a one-time link to register the first passkey in the Access App Launcher.
- **K-1207** The Zero Trust organization (team domain, free plan) must exist on the account. Without one, the script stops with the dashboard link, and continues after one dashboard visit. VERIFY: `POST /accounts/{id}/access/organizations` creates an organization on an account without one.
- **K-1208** The admin and the map move from `kit.yarden-zamir.com` to `kitshn.yarden-zamir.com`, which is also the pass issuer (K-1770). Until the move of K-1209, they live at `kit.yarden-zamir.com`.
- **K-1209** The move from `kit.<zone>` to `kitshn.<zone>` has no redirect, and `kit.<zone>` stops fully. Everything that names the old host changes, and `scripts/host-move-check.ts` proves that no link remains before the old host goes. The steps are in [host-move.md](../operations/host-move.md). During the move, the binding `KITSHN_OLD_HOST` names the old host: the challenge accepts a signature for either host (K-1704), and each `ACCESS_*_AUD` lists the tags of both hosts, so no daemon and no admin session drops. `KITSHN_OLD_HOST=none` ends the move. Passkeys survive the move, because they belong to the Access team domain.

## Free plan budget

- **K-1301** The reference setup is 5 machines, about 15 apps, about 50 pages that grow by about 20 per week, 2 people and a few guests. The budget table in [overview.md](overview.md#free-plan-budget) uses it.
- **K-1302** kitshn writes Durable Object rows only on change, and stores no resource samples (K-606). Each `setAlarm` counts as one row written, so kitshn sets one alarm for the next due item, never one per item.
- **K-1303** The Usage view shows the use of the whole account against each free plan limit, with a warning at 80%. Daily values count from 00:00 UTC, and monthly values from the first day of the month. Durable Object requests count WebSocket messages 20:1, as the bill does. A value that kitshn cannot read shows as unknown with its reason, never as 0. Known limit: R2 counts per billing month, not per calendar month.
- **K-1304** When a daily Durable Object limit runs out, the map shows the cause and the reset time. Access keeps enforcing the last compiled shares, so access does not change. The Worker then reads the usage values itself for an owner of `OWNER_EMAILS`, so the Usage view still works.
- **K-1305** One GraphQL query and a few REST calls read the usage values, at most once per 5 minutes. The Durable Object keeps the answer in memory, so the view writes no row and stays under the GraphQL rate limit. Each value fails on its own. Only a member with control on the admin card reads `GET /api/usage`.

## Migration

- **K-1401** The machine map portal keeps running until each machine moves. KitSHn 1 is shut down (K-1402). [migration.md](../operations/migration.md) holds the order of work.
- **K-1402** The KitSHn 1 code, its specs and its workflows are gone from this repo. KitSHn 1 lives on in `Yarden-zamir/kitshn-1`, with the host Caddy setup, which stays until no app needs the host Caddy.
- **K-1403** An import reads a machine map export and creates a machine card for each machine (with its tunnel, hostname and token), a circle for each arrow source, circles for Guests rules, `t3.settings` desired state, and presets. It does not import history or browser keys.
- **K-1404** Removed: `kitshn adopt`, which was never built, and the takeover of KitSHn 1 data. No KitSHn 1 app is left to move.
