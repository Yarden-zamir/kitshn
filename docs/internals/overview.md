# Overview

kitshn runs apps, sites, pages, files and machines on Cloudflare, and decides who may open each one. Everything sits on one map. A card inside a circle is shared with that circle.

The repo is "KitSHn 2". Code, packages, the CLI and the MCP tools use `kitshn`. The admin and the map live at `kit.yarden-zamir.com` until the move to `kitshn.yarden-zamir.com` (K-1208, K-1209).

## Core rules

- **K-001** The app and what it needs to deploy live in its repo. The places (machines, the Cloudflare account, domains, who may open what) live in kitshn, never in the repo.
- **K-002** "Create a repo, push, and it deploys" stays true. A new app repo needs a recipe and a workflow file, and nothing else: no per-repo secret, no setup step in kitshn. The one exception is the first deploy of a repo, which waits for one Allow (K-819).
- **K-003** kitshn runs on Cloudflare only. Its logic and state run in one Worker with one Durable Object. Machines do only machine work: tunnels, local sites, Compose deploys, commands and builds.
- **K-004** kitshn fits the Cloudflare free plan for the reference setup (K-1301). A paid plan only raises limits, and no feature needs it.
- **K-005** kitshn knows nothing about T3 Code. T3 Code and other programs add their own resource kinds through the local interface (K-7xx).
- **K-006** Every unexpected state fails closed: a request that kitshn cannot decide gets no access, and the error says why.

## Terms

- **Owner:** the person who installed kitshn, the first member of the Owner circle.
- **Circle:** a named group of who: people (emails), email domains, devices, networks (IP ranges), machines, and the flag "needs passkey". A circle has a default level.
- **Resource:** something that kitshn can share: a machine, a site, a page, a file, an app, a thread. Each resource kind names its levels.
- **Card:** a resource on the map.
- **Share:** a card inside a circle. It gives the members the circle's default level on that resource, or the level of an override.
- **Level:** what a share allows. Each kind names its own ordered levels, for example `view`, `use`, `control`.
- **Daemon:** the `kitshn` program on a machine.
- **Provider:** a program on a machine that adds resource kinds through the daemon, for example T3 Code.
- **Recipe:** `kitshn.config.ts` in an app repo.
- **Environment:** one deployed copy of an app, for example `prod` or `pr-12`.
- **Job:** one piece of machine work, for example a Compose deploy.

## Parts

| Part | Where it runs | What it does |
| --- | --- | --- |
| kitshn Worker | Cloudflare | Routes requests, checks Access JWTs and GitHub OIDC tokens, serves pages, files and the offline page. Its static assets hold the map UI. |
| kitshn Durable Object | Cloudflare, one instance | Holds all state in SQLite. Keeps the daemon and map sockets. Runs the alarm queue that writes Cloudflare API changes. |
| R2 bucket | Cloudflare | Library pages, files, backups, and deploy archives while a deploy runs. |
| Cloudflare Access | Cloudflare | Logs people in and checks circles at the edge for every address that has an Access application. |
| Tunnels | Cloudflare and each machine | One remotely managed tunnel per machine. Ingress goes to Unix sockets on the machine. |
| App Workers | Cloudflare | One Worker script per environment of a static site or Worker app. |
| `kitshn` daemon | Each machine | Runs `cloudflared`, runs jobs, checks local sites, keeps sample history, serves the local socket for providers. |
| Providers | Each machine | Programs such as T3 Code that add resource kinds through the local socket. |
| `kitshn` npm package | App repos and Actions | `defineApp`, `defineApps`, the recipe types, and the CLI that the deploy workflow runs. |
| GitHub App | GitHub | Pull request close, deployment statuses, the repo gate, Actions dispatch and repo tokens. |

```text
 people, devices ──► Cloudflare edge ──► Access (circles as policies)
                         │                   │
          ┌──────────────┼───────────────────┼──────────────────────┐
          ▼              ▼                   ▼                      ▼
   kitshn Worker    App Workers         tunnel of a machine    pages/files (Worker)
    + static UI     (static assets)          │
          │                                  ▼
   Durable Object ◄── WebSocket ──── kitshn daemon ── unix sockets ──► Compose apps, live sites
   (SQLite, alarms)                         │
          │                          local socket (JSON lines)
          ▼                                  ▼
     Cloudflare API                      T3 Code (provider)
```

## Where state lives

| State | Lives in | Notes |
| --- | --- | --- |
| Circles, members, shares, places, stacks, presets, revisions, jobs | Durable Object SQLite | Never in Git (K-518). |
| Presence and the latest sample | Durable Object memory | Samples are never written (K-606). |
| Card icons | Durable Object SQLite, at most 100 KB each | Written only when the bytes change (K-1113). Not R2, so icons need no second check. |
| Sample history | Daemon disk | 30 days. |
| Access applications and policies, tunnel ingress, DNS records, Worker routes | Cloudflare | Compiled from shares and resources. kitshn is the source, Cloudflare is the copy. |
| Machine token, tunnel token, machine private key | Daemon files, mode 0600 | Never in the Durable Object at rest (K-602, K-1702). |
| Pass key, VAPID key, sealed GitHub tokens | Durable Object storage | Out of every export and backup (K-1831). |
| Recipe | App repo | The only state in Git. |
| Page and file bytes, Compose backups, daily state copies | R2 | Backups are restic repositories (K-1811). |
| Compose data and logs | Machine disk | At most 30 MB of logs per container (K-1803). |
| Device view (zoom, pan, widths) | Browser local storage | |

## Request paths

1. **The owner opens the map.** Access checks the admin application (email code and passkey). The Worker serves the UI, and the page opens one WebSocket to the Durable Object for a snapshot and then changes.
2. **The owner drops a card into a circle.** The Durable Object writes the share and a revision, pushes the change to open maps and affected daemons, and queues an Access job. The alarm writes it in runs of at most 40 API calls (K-406).
3. **A visitor opens a Compose app.** Access checks the circles of its application, and the tunnel sends the request to the service's Unix socket. The Worker is not on this path.
4. **A visitor opens a live site whose machine is off.** kitshn added a Worker route for that address when the daemon went away. The Worker tries the origin and answers with the offline page (K-1108).
5. **A visitor opens a page.** The Worker serves a public page from R2. For another page, it reads the Access JWT, sends a visitor without one through `/login`, then checks the circles (K-1004).
6. **An app deploys.** Actions turns the recipe into JSON and sends it with its OIDC token. For a Compose app, the Durable Object picks a machine (K-610), takes the source archive through R2, and sends the job to the daemon. For a static or Worker app, Actions uploads the files, and the Worker uploads the script.
7. **T3 Code asks for a level.** T3 passes the Access headers of a request to the daemon with `check`. The daemon decides from the grant tables that kitshn pushed (K-721), with no call to kitshn.
8. **An agent on a machine acts.** The agent calls `kitshn`, which asks the daemon over the local socket. The daemon adds the labels that the provider vouched for and sends the ask over its signed connection. kitshn checks the right and its mode, then runs it, asks a circle, or refuses (K-1710).

## Free plan budget

Reference setup (K-1301): 5 machines, about 15 apps with about 5 open previews, about 50 pages that grow by about 20 per week, 2 people and a few guests. The numbers are estimates, not measurements.

| Budget | Free limit | Expected use | How it stays low |
| --- | --- | --- | --- |
| Worker requests | 100,000 per day | about 550 per day for kitshn, plus at most about 6,000 uptime fetches of Worker apps (K-1126) | Access and tunnels carry app traffic. Static assets are free. The offline route exists only while an origin is down. |
| Worker CPU | 10 ms per request | under 5 ms for a snapshot of about 500 rows | Waiting on the Cloudflare API does not count. |
| Subrequests | 50 per request | at most 40 per alarm run, plus at most 5 pushes | Alarm queue (K-406). The daily run keeps 10 spare. |
| Durable Object requests | 100,000 per day | about 2,100 per day | Pings use the auto response. WebSocket messages count 20:1. A pending alarm never moves later. |
| Rows read | 5,000,000 per day for the account; above it every Durable Object call fails until 00:00 UTC | A wake reads only the small tables, and the first snapshot after it reads the recent revisions. | `test/rows-read.test.ts` holds the bounds. An uptime turn reads no row while every card is up. kitshn never prunes `deploys`. Revisit when it passes 10,000 rows. |
| Rows written | 100,000 per day | about 10,500 per day, with agent asks (K-1740) and 2,880 `setAlarm` writes | Write on change only. One alarm for the next due item. No sample rows. |
| DO storage | 5 GB | under 50 MB | Bytes live in R2. |
| R2 storage | 10 GB-month | pages, files and backups, guarded at 8 GB (K-1818) | Archives go after each deploy. Backups are deduplicated. |
| Access seats | 50 people | about 7 | Seat expiration after 1 month (K-111). Devices and machines use service tokens. |
| Access applications and reusable policies | 500 each | about 40 applications, one policy pair per circle | Public resources need no application. |
| Service tokens | 50 | about 9 | GitHub uses OIDC, no token. |
| Worker scripts | 100 | about 15 | Refuse new previews and folder sites at 90 (K-903, K-1123). |
| DNS records per zone | 200 for Free zones made after 2024-09-01 | about 35 | One record per address. |

The tightest limits for growth are service tokens (50) and Worker scripts (100), not requests.

## Choices and simpler options

- **Schema migrations.** The Durable Object keeps a `schema_version` in `meta` and runs numbered migrations from `packages/edge/src/worker/migrations.ts` once, in order. A shipped migration never changes. A new one goes at the end.
- **One Durable Object for everything.** It is simple and fits the budget. One instance serializes all writes, which is fine at this size. Revisit when the map holds more than about 10,000 cards.
- **Samples on the machine, not in the Durable Object.** One row per machine per minute is about 7,200 rows written per day for 5 machines. Revisit if history must work while a machine is offline.
- **Source archive through R2, not a git clone on the machine.** The machine needs no GitHub credential. Revisit when archives pass 500 MB.
- **Offline page through a temporary Worker route.** Custom error rules need a paid plan. A Worker route on every live site costs a request for each file of a dev server page.
- **No Caddy.** `cloudflared` reaches Unix sockets directly. An app that needs rewrites keeps its own Caddy inside its Compose file.
