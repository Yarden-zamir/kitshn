# Migration from the machine map

The machine map portal (in the T3 Code fork, `apps/machine-map`) keeps running until each machine moves to kitshn (K-1401). KitSHn 1 is shut down. Each step ends in a state where everything works. Milestones 0 to 5 are done, and their pull requests are the record.

| # | Step | What ships | What keeps working |
| --- | --- | --- | --- |
| 5 | Host move | The move to `kitshn.<zone>` (K-1209), with [host-move.md](host-move.md). Then "Passes" can turn on. | Everything on `kit.<zone>` until the move ends. |
| 6 | Portal cutover | Import the machine map (K-1403), with its tunnels, hostnames and service tokens. Turn the provider and its links (K-1609) on one machine at a time. Until the last machine moves, pause both kitshn and the portal in an emergency (K-1623). Guest links move to `t3.thread` circles. Before the first machine moves, the open features of [machine-map-features.md](../internals/machine-map-features.md) ship. Phones and desktop apps pair again with a kitshn device invite (K-1601, K-1617). | The portal is read only for machines that moved. |
| 7 | Clean-up | Remove `host.yml` from kitshn-1 once no app needs the host Caddy, and remove Caddy from the VPS. | The portal stays for Windows machines. |
| 8 | Windows | Move the Windows machines (K-620 to K-625) and import their pages (K-1008). Then remove the portal Worker and `apps/machine-map` from the fork. | Mac and Linux machines unchanged. |

## Risks to watch

- Each moved app changes one line in its own workflow file: `permissions: id-token: write`. A reusable workflow cannot raise the permissions of its caller, so `kitshn2-deploy.yml` cannot do it for the apps.
- Check what `t3-oracle-vps` serves before its handover (K-1623): its DNS record comment says "T3 machine map".
- An app that needs the user identity verifies the Access JWT itself. See [app-identity.md](../user/app-identity.md).
