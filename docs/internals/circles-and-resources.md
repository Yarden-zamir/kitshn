# Circles, shares and resources

A card inside a circle is shared with that circle. This file holds the rules for circles and shares (K-2xx) and for resources (K-3xx).

## Circles and shares

- **K-201** A circle has a name, a colour, a default level, members, a match mode (K-203), an optional end date, and the flag "needs passkey".
- **K-202** A circle holds actors (K-1778) and rules: an email domain, an IP range, and "everyone". "Everyone" means anyone who can reach the address, with no login.
- **K-203** A circle has one of two match modes. With "Any" (the default), the visitor matches at least one member, and the members become Access include rules. With "All must match", the visitor matches every member, and the members become require rules. With "needs passkey", the visitor also passes a passkey check in both modes.
- **K-204** A card is shared with every circle that it sits inside. Circles overlap freely, with no limit on their number.
- **K-205** A share uses the default level of its circle. One card can override the level for one circle.
- **K-206** A level that the resource kind does not have becomes the next lower level of that kind. A circle with the default `control` thus gives a file `view`.
- **K-207** When several circles match a visitor, the visitor gets the highest level of those shares.
- **K-208** A card outside every circle is private. Only the admin (K-104) sees it on the map, and an agent with "reads the map" in `kitshn state` (K-1777).
- **K-209** A share can have an end date. At the end date, kitshn moves the card out of that circle as a new revision. An Undo of the expiry puts the card back without the passed end date, so the share stays. Any other Undo that brings back a passed end date keeps it, so the share ends at once.
- **K-210** A circle with "everyone" asks for a confirm the first time that a card enters it.
- **K-211** The Owner circle and the Everyone circle exist from the start. The owner can rename them, and cannot delete the Owner circle. A delete of another circle runs at once, without a confirm, and Undo restores it (K-1502).
- **K-212** A card can have an end time, as a timed card. The share ends of K-209 and the card end share one expiry step. At the end time every share of the card ends at once, also before the alarm runs. The alarm then moves the card to the tray in one revision, as the actor who set the time, so that actor's Undo (K-1506) brings it back. The map, `POST /api/cards/<card>/time`, `POST /agent/cards/<card>/time` and `kitshn time` (K-1714) call one service. An agent sets the time only of a card that it manages (K-718). The admin card cannot have an end time. During a pause, an end time cannot move later or go (K-1504).

## Resources

- **K-301** Built-in resource kinds and their levels:

  | Kind           | Levels             | What it is                                                  |
  | -------------- | ------------------ | ----------------------------------------------------------- |
  | `kitshn.admin` | control            | kitshn administration (K-104)                               |
  | `machine`      | view, use, control | a machine with a daemon                                     |
  | `site.static`  | view               | a static site on Workers static assets                      |
  | `site.worker`  | view               | a Worker app                                                |
  | `site.compose` | view               | a Compose app on a machine                                  |
  | `site.live`    | view               | a local site of a machine, through its tunnel (K-1104)      |
  | `page`         | view               | an HTML page in the library                                 |
  | `file`         | view               | a file in R2                                                |
  | `repo`         | view               | a repo that has a recipe; its environments are its children |
  | `repo.group`   | view               | the repos of one owner or of a name pattern (K-1733)        |
  | `port`         | view               | ports of a service on a machine (K-2001)                    |

- **K-302** A provider adds kinds through the daemon (K-704). Each kind has an id with the provider prefix (for example `t3.thread`), its levels, and how it is enforced (K-405).
- **K-303** Each environment of an app is its own resource and its own card, for example "riffle" and "riffle pr-41". A preview card (a `pr-<n>` environment, K-821) links its pull request. New environments start in the circle that the recipe names (K-807).
- **K-304** Each resource has an id, a kind, a name, an owner machine when it has one, its addresses, and its status: running, stopped, deploying, failed, offline or unknown.
