# KitSHn 2 migration plan

The machine map portal (in the T3 Code fork, `apps/machine-map`) and KitSHn 1 (`Yarden-zamir/kitshn-1`) keep running until each piece moves (K-1401). Each milestone ends in a state where everything works.

| # | Milestone | What ships | What keeps working |
| --- | --- | --- | --- |
| 0 | Spec approved | This spec. The GitHub App is created. | Everything as today. |
| 1 | Edge core | Worker, Durable Object, R2, bootstrap script (section 12), admin at `kit.yarden-zamir.com` (K-1208), admin resource, Owner circle with passkey, map with circles and shares, history. Test: `unix:` ingress on a remotely managed tunnel (K-607), reusable policies on many apps (K-402). | Portal and KitSHn 1 unchanged. kitshn runs on its own address and manages nothing live yet. The KitSHn 1 website moves to `kitshn-legacy.yarden-zamir.com`. |
| 2 | Daemon and machines | `kitshn` daemon, join, tunnel, status, jobs, commands, labels and order. Join one test machine first. The Usage view (K-1303) shows the seats in use. Seat removal (K-112) is not built yet; it stays here. | Portal keeps the T3 machines. The test machine has no T3 tunnel. |
| 3 | Static sites, pages and files | Static site and Worker app deploys, library, uploads, the offline page. Move tick3d and the resume first. | KitSHn 1 apps unchanged. T3 pages stay in threads; the import copies them. |
| 4 | Compose deploys and previews | Compose jobs on sockets, previews, GitHub App teardown (`kitshn adopt` dropped, K-1404). Move one app (for example `kitshn-meta`), then the rest one at a time. | `deploy.yml` in this repo still forwards to KitSHn 1 for apps that did not move. `host.yml` in kitshn-1 keeps the host Caddy for them. |
| 5 | T3 interface | `@kitshn/local`, T3 fork provider files and hooks, `kitshn_*` tools, grant tables, settings as desired state. The Inbox (K-1607), the queue of desired state (K-1608), `t3.app` links (K-1609), the audit of cross-machine work (K-1610), agent rights of machines (K-1612), the T3 commands (K-1615) and provider facts (K-1625). Section 17 in one pull request: machine keys (built), asks with a mode per right, GitHub tokens, labels and thread attestation, passes for outside services, and agent rights on machines with repo groups. Then the host move to `kitshn.<zone>` (K-1209). | T3 machines still use the portal. The provider stays off by a server setting until milestone 6. |
| 6 | Portal cutover | Import the machine map (K-1403), keeping tunnels, hostnames and service tokens. Turn the provider and its cross-machine links (K-1609) on one machine at a time, Windows included (K-620). Until the last machine moves, pause both kitshn and the portal in an emergency (K-1623). Guest links move to `t3.thread` circles. Before the first machine moves: phone invites (K-1601), the Clients view (K-1602), health alerts and history (K-1604, K-1605), the installed app and Web Push (K-1606), T3 panels and access change notices (K-1611), settings sync (K-1613), tasks (K-1614), T3 status (K-1616), the desktop app list (K-1617), the stop of links and exec on a pause (K-1618; the T3 lock screen comes later), history extras (K-1619), machine tools (K-1620) and notes (K-1621). Phones and desktop apps that paired with the portal keep their sessions, and pair again with a kitshn device invite (K-1601, K-1617). | The portal is read-only for machines that moved. |
| 7 | Clean-up | Remove `deploy.yml` forwarding once no app calls it, and kitshn-1's `host.yml` once no app needs the host Caddy. Remove Caddy from the VPS. Remove the KitSHn 1 Python code from this repo. Done in this repo on 2026-10-29: the `deploy.yml` forwarding, the Python code, its specs and its release and Homebrew workflows. `host.yml` and the VPS Caddy are still open. | Nothing calls the removed parts. The portal stays for Windows machines. |
| 8 | Windows | The `kitshn` daemon on Windows, at logon through Task Scheduler (K-620 to K-625). Move the Windows machines and import their pages (K-1008). Then remove the portal Worker and `apps/machine-map` from the fork. | Mac and Linux machines unchanged. |

Section 16 of SPEC.md maps every machine map feature to a milestone, or drops it with its reason (K-1603, K-1622).

## Risks to watch

- `release.yml` and `homebrew.yml` are gone from this repo (milestone 7). kitshn-1 has its own copies, and the tap builds the `kitshn1` formula from kitshn-1.
- Each moved app changes one line in its own workflow file: `permissions: id-token: write`. A reusable workflow cannot raise the permissions of its caller, so `kitshn2-deploy.yml` cannot do it for the apps.
- The address: the admin of kitshn 2 is `kit.yarden-zamir.com` until the move to `kitshn.yarden-zamir.com` (K-1208, K-1209). The KitSHn 1 website (`kitshn-meta`) is retired since 2026-10-29, so both of its addresses are free.
- Tunnel ingress checks the Access JWT (K-603), so a request reaches an app only through Access. The check does not tell the app who the user is. Access also sends `Cf-Access-Authenticated-User-Email`, but that header is not signed, and anything on the machine that reaches the socket can set it. An app that needs the user identity verifies the `Cf-Access-Jwt-Assertion` header itself ([validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)):
  1. Get the signing keys from `https://$KITSHN_ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`.
  2. Check the signature and the expiry of the token.
  3. Check that `iss` is `https://$KITSHN_ACCESS_TEAM_DOMAIN`.
  4. Check that `aud` contains one of the tags in `KITSHN_ACCESS_AUDIENCES`, a comma list. An empty list accepts no token.
  5. Read the identity from the verified token (`email`, or `common_name` for a service token).

  kitshn sets both variables for each service of a Compose app at each deploy, redeploy and rollback, and as plain vars of a Worker app at each deploy from the repo (K-822). A value that the app sets itself wins. A tag changes when kitshn makes the Access application again, for example after someone deletes it in Cloudflare. A running app gets the new tag only with its next redeploy.

  A site in Everyone has a Bypass policy (K-403), and Access sends no JWT for Bypass. On such a site, a verifier must not require the token. It treats a request without a token as a visitor with no identity.
