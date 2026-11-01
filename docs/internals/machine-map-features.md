# Features from the machine map

kitshn replaces the machine map portal of the T3 Code fork (`apps/machine-map/SPEC.md`, `MM-` numbers). This file holds the portal features that kitshn takes over, drops or changes (K-16xx). The order of work is in [migration.md](../operations/migration.md).

## Devices and clients

- **K-1601** Phone and desktop app invites. An invite is a link `https://<KITSHN_HOST>/join/device#code=<code>` with a one-time code of 128 bits that expires after 15 minutes. Like join codes (K-602), it has no attempt limit. Rules: The token of an invite joins an actor (K-1778): the actor that the invite names, else the person actor of the owner who invites, else a new actor of the token. A token that is a credential already keeps its actor. The answer of `POST /join/device` names it as `actor: { id, name }`.
  - The code stays in the URL fragment, so it never reaches a server log. The page fills the app links in the browser.
  - The app sends `POST /join/device` once. kitshn deletes the invite, rotates the token secret with no grace period, and answers with the service token. kitshn stores the client id, never the secret.
  - A used or unknown code gets 404, also when the first answer got lost, so the app asks for a new invite and never retries. An expired code gets 410. During the pause, the exchange gets 423.
  - Only the owner makes or cancels an invite. An undo never adds, changes or removes a device token.
  - kitshn makes the device token when the owner makes the invite, and drops its secret. So the circle holds the device before the app arrives, and the app pairs on the first try. A token made at the exchange would make the owner wait to place the device. A secret sealed with the code would make kitshn store it.
  - An invite takes only a `kitshn device ` token, never a machine token, so an invite never takes over a machine.
  - `GET /device/machines` takes a service token only and lists each provider card with an address that the token opens. kitshn knows no T3 kind (K-005), so it lists every such card.
  - Planned: "Add phone" in the Add menu (K-1621).
- **K-1602** The Clients view lists the Access sessions of kitshn's applications and the sessions that providers report as lists (K-1625). "Sign out" on a row sends the provider command "revoke client". "Sign out everywhere" (K-110) also ends those sessions.
- **K-1603** Dropped: browser keys, their approval flow and `clientAccess`, because a passkey circle and device tokens replace them (K-108). Kept: a machine joins or leaves kitshn only from its local desktop app, `kitshn join` or the installer. `kitshn_join` and remote T3 clients refuse it, because leaving turns off the grants that the provider enforces.
- **K-1617** The desktop app uses its own device token (K-106), never the machine token (K-711). It gets the token through an invite (K-1601) and its machines from `/device/machines`. It adds every `t3.app` card that its token opens as a saved environment, and removes it when the share ends.

## Health and push

- **K-1604** Each machine has health thresholds, which the owner edits in the machine panel. An empty field turns a check off. The daemon checks its own samples, so samples cause no Durable Object writes (K-1302), and reports only the start and the end of an alert. A card shows one sticker per active alert. kitshn keeps alert events 30 days, at most 500, as events, not revisions.
- **K-1605** The machine panel shows charts of the last hour, day and 30 days from the history that the daemon keeps (K-606). An offline machine shows its last sample. `kitshn_resources` returns the same data to agents. Charts change only when a sample arrives.
- **K-1606** The map is an installable web app. Its service worker caches nothing, because the map sits behind Access and a cache could show a stale map. Revisit with an offline page. kitshn sends Web Push with the Web Crypto API (K-1907) and a VAPID key that the Durable Object makes on first use and keeps in its storage (`meta` key `push_vapid_jwk`), never in a Worker secret. The key stays out of every read path, export, backup and History entry. "Sign out everywhere" deletes every subscription.

## Inbox and queue

- **K-1607** Agent changes that become proposals (K-715) wait in the Inbox, at the top of the Notifications view (K-1905). The owner approves or denies each one. A proposal from an "ask <circle>" right goes to the members of that circle, and each answers with its own proof (K-1723). A proposal expires after 24 hours and names its reason and its agent, machine and labels (K-1722). An approve runs the guard of K-105.
- **K-1608** The grant tables, card settings and desired state of an offline machine wait for it, and its card shows "queued" with a count. Each push carries a hash, and the daemon answers `applied` with its key and hash after it saved the push. kitshn counts the queue once per push, not once per map. On connection, a machine applies the current state, not each queued revision. A daemon without the capability `applied` shows "queued ?". A job with `whenIdle` waits while a running provider card of its machine has the fact `busy` = `true`. Each provider report delivers the jobs that wait. Planned: the Queue view.

## Cross-machine work

- **K-1609** A link from machine A to machine B needs one share: B's `t3.app` card with a circle that holds A at `view` or higher, so Access lets A reach B's T3 address (K-402). The level sets the link access, and `use` makes B a linked environment of A. `machine_exec` runs through kitshn (K-722), not over the link. Rules:
  - kitshn pushes each provider of A its reach: every card of that provider on another machine that A's token opens.
  - The daemon serves a link proxy on `link.sock` (or a named pipe on Windows, K-621), with the peer check of K-701. `http://link/<provider>/<machine id>/<path>` goes to that card's address with A's machine token, for HTTP and WebSocket.
  - The proxy drops the caller's own `CF-Access-*` headers and the `CF_Authorization` cookie, so B always sees A's machine token, never a person's or an old session.
  - The path is no boundary between providers: every caller is the daemon user or a local user and may name any provider. Known limit: with two kinds of one provider with addresses on one machine, the first card wins. Revisit when a provider has two.
  - B decides with `check` (K-721). The source thread's limits travel with each call, and the narrower limit wins. The emergency pause makes every link unreachable.
  - The provider trusts the Access JWT header only because T3 listens on loopback behind the tunnel.
- **K-1610** kitshn relays each exec run (K-722), so it records the run itself when it ends: the machines, the thread, the command name, the folder, the outcome and the time, never the arguments or the output. The command name drops leading `NAME=value` assignments, because their values can be secrets. A forwarded tool call over a link gets one event too, named by the provider in the header `Kitshn-Audit-Name`, which the link proxy removes and reports. A call without a valid name still gets an event, named by its method and path, so leaving out the header never hides a call. kitshn records at most 120 calls of one machine a minute, and keeps the events 30 days, at most 2,000.
- **K-1612** Agents act as their machine, with asks and operations through its daemon (K-1710, K-1777). `kitshn state` shows the map through `AGENT_READ`. A change that touches only cards on which the machine has `control` and raises no access applies at once. Everything else becomes a proposal (K-715). A command outside the limit of K-718 asks the Owner. Device members, invites and tokens ask the Owner, and the secret answer goes only to the same call after the approval (K-1777).

## T3 Code

- **K-1611** T3 Settings > Machines joins with a code and leaves kitshn on the local desktop app (K-1603). The T3 Machines panel shows the map from `kitshn_read`, read only. Settings > Connections shows the links from `t3.app` shares, read only. When a share to or from the machine lowers or ends, T3 shows an access change notice.
- **K-1613** Settings sync: `t3.settings` (K-713) holds shared values and per-machine values of T3 settings (K-709). A change in T3 Settings to a synced setting becomes that machine's value, and "Make shared" copies it to all machines. The Settings view shows drift per machine, with editors from the provider's schema. Machine-local settings never sync.
- **K-1614** The provider reports the scheduled tasks of its machine as a list (K-1625). The Tasks view offers Pause, Resume and "Run now" as provider commands (K-1615), so an offline machine gets them from its queue.
- **K-1615** The provider of `t3.app` adds the commands restart server, install update (now or "when idle"), stop all agents, pause and resume scheduled tasks, run one task, reload windows, start thread and revoke client (K-707). Restart server, stop all agents and remove machine ask for a confirm.
- **K-1616** The provider of `t3.app` reports the T3 version, running agents, threads that wait, a waiting update and queued work as facts and stickers (K-1625). The daemon version is no provider fact: a machine card shows NEWEST when its daemon runs the Worker's release (K-617), and BEHIND otherwise. An offline machine shows neither. A daemon that runs from source shows SOURCE, because "Update daemon" refuses it.
- **K-1618** Under the pause (K-1504), Access blocks remote clients of every `t3.app` card, because no circle holds them. Each provider also locks T3 for every client except its own desktop app, and saves the lock so that it survives a restart.
- **K-1623** The cutover of T3 hosts from the portal. While a machine is still on the portal, a portal machine and a kitshn machine reach each other only through their own T3 pairing, and the kitshn pause does not stop portal machines. The portal holds the host `t3-<machine>.<zone>`, and its DNS record keeps that host off the `t3.app` card (K-705). Rules:
  - Cloudflare refuses a second application for an exact host that another application holds (409), but accepts `<host>/*` next to it, and the `/*` application then answers every path. So kitshn uses `<host>/*`.
  - "Take the address" (`POST /api/cards/<id>/take-address`) keeps the one proxied CNAME record of the host and refuses other records or a Worker. It needs an online daemon that names `access`, because kitshn's application answers on the host at once and T3 must accept its tokens.
  - kitshn makes its Access application for `<host>/*`, then the ingress. At least 15 seconds later, and once the machine applied the push with the new audience, it moves the record to its tunnel. So the host has an application and a route at each moment. The `applied` answer wakes that step at once (K-411).
  - "Give the address back" works only while the portal still holds the exact host. kitshn forgets the record and never deletes it.
  - The portal's path applications on a host are more specific, so they stay with the portal and get tunnel rules ahead of the host's rule.
  - kitshn pushes the daemon the Access audiences of each provider's site hosts, and `served`: the hosts whose record points at kitshn's tunnel. The audiences come before the record moves, so only `served` tells the provider when to stop its own route. Known limit: on a give-back, the provider's own route can lag the record. Revisit if give-backs happen in use.
  - `check` accepts a token whose `aud` is in that list or in the provider's `trustAudiences`, such as the portal's audience, until the portal goes.
- **K-1625** With `upsert` (K-705), a provider may attach facts (a label and a value), stickers (a text, a tone and an optional link) and lists (rows with columns and row commands) to its resources. kitshn stores and shows them without knowing what they mean (K-005). Two fact roles are generic: `version` and `busy` (K-1608). A card has at most 4 lists of 100 rows and 8 columns. A resource holds at most 64 KB as JSON, checked by the daemon and kitshn with the same code. Planned: the `version` compare.

## Map and machine tools

- **K-1619** Planned: a time slider that shows the map at an older revision, read only, with "Restore" as one new revision; "Hold changes" as a draft; and more History filters.
- **K-1620** Machine tools: a new machine shows "waiting" until its first connection. The owner renames a machine (names are unique without regard to case), and a rename sends the new name to the daemon. "Rotate token" makes a new machine token with a 24-hour hand-over. The machine key rotates at once instead (K-1705).
- **K-1621** Planned: sticky notes on the map, free text of at most 500 characters, each change a revision with Undo. A double click on empty map opens "Add machine here", "Add phone here" and "Add note here".
- **K-1622** Dropped from the machine map:
  - Arrows, wires, connection handles and the Table board, because circles replace pairwise arrows and the Machines table replaces the Table view.
  - The session rules of MM-1305, because Access and grant tables decide levels (K-405, K-409). The provider keeps its 7-day sweep of unused sessions.
  - Adding a machine without an API token, because the Worker always has its token.
  - The owner's guaranteed access to every machine, because owner access is a normal share and the pause removes it on purpose (K-1504). K-719 keeps owner control of `t3.app` cards, and the local desktop app is the way back in.
  - Temporary levels that return to the earlier level, because a second circle with an end date does the same (K-207, K-209).
