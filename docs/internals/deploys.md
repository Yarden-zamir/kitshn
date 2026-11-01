# Recipes, deploys and previews

An app repo holds a recipe, `kitshn.config.ts`, and a workflow file. This file holds the rules for recipes and deploys (K-8xx) and for previews (K-9xx). The recipe types are in `packages/kitshn`, and the reusable workflow is `.github/workflows/kitshn2-deploy.yml`.

## Recipes

- **K-801** A recipe is `kitshn.config.ts` with `export default defineApp({...})`, or `defineApps({ <key>: {...} })` for a repo with several apps (K-804). The value is one object literal. The `kitshn` package exports the types as a `.d.ts` with no imports, so an editor shows recipe mistakes. Its CLI is one bundled file with no runtime dependencies. An app does not need the package installed: Actions runs `kitshn check` from the release.
- **K-802** Recipes do not compute. `kitshn check` refuses loops, conditions, function calls other than `defineApp` and `defineApps`, and imports other than `kitshn`. A lint rule is enough, because kitshn never runs repo code (K-803).
- **K-803** GitHub Actions reads the recipe without running it: `kitshn check` turns the literal object into JSON, and kitshn checks the JSON with the same schema. The deploy job takes the GitHub Environment `prod` only for the default branch, and `pr-<n>` for a pull request. Any other push runs with no GitHub Environment, so per-branch Environment secrets are not supported. Revisit when an app needs them.
- **K-804** Kinds: a Compose app (`compose`), a static site (`static`), a Worker app (`worker`). A recipe has exactly one kind. A repo has up to 10 apps, each under a key (a lowercase letter, then up to 19 lowercase letters or digits). `defineApp` is the app with the key `app`, which keeps the card ids and addresses of a repo with one app. Other apps carry their key in the card id and in the default address. A card id over 56 characters ends in a hash. One workflow run deploys every app, each as its own deploy, in the order of K-820. Known limit: all apps of one run get the same `KITSHN_<NAME>` values (K-808). Revisit when two apps of one repo need different values under one name.

  ```ts
  import { defineApp } from "kitshn";

  export default defineApp({
    compose: { runsOn: ["docker", "server"] },
    deploy: [
      { on: "push", branch: "main", name: "prod", address: "riffle.example.com" },
      { on: "pull_request", name: "pr-{pr}", ephemeral: true, startsIn: "Owner" },
    ],
  });
  ```

- **K-805** A static site names a build command and an output folder. Actions builds it and uploads the files, and kitshn deploys them as Workers static assets with no Worker code, so their requests are free. `_headers` and `_redirects` files go with the deploy as text, at most 100 KB each. A build that needs more than the deploy job offers, or that runs untrusted code, builds in its own job and passes an artifact. That job has no `id-token: write`, so untrusted code cannot ask for the deploy token. A deploy whose runner stops without a word fails as expired.
- **K-806** A Worker app is described in the recipe only: the entry module, the compatibility date and flags, an optional build and assets folder, KV bindings, Durable Object classes, crons and plain vars. The recipe names no place, so kitshn sets the script name, the addresses and the storage. Rules:
  - Actions bundles the entry into one ES module with a pinned esbuild. The CLI fails above the Free limit of 3 MB after gzip. Known limit: each deploy downloads esbuild from npm. Revisit when that download fails a deploy.
  - Each environment gets its own KV namespace per binding, which stays with the card.
  - kitshn declares the Durable Object classes in the declarative `exports` of the upload, so it keeps no migration state. A class that leaves the recipe fails the deploy, because kitshn never declares a deletion, which deletes its data. Renames are not supported.
  - Only push environments run crons. The Free plan allows 5 crons per account, so kitshn counts the crons of the other Workers and refuses a deploy that passes 5.
  - D1, R2, queues, service bindings, Workflows and AI bindings are not supported yet.
- **K-807** `deploy` maps triggers to environments: the first matching entry wins. `startsIn` names the circle of a new environment, except for a repo that an agent key allowed (K-819). After that, the map decides (K-518). Rules:
  - The pull request number comes from the signed GitHub token, so a pull request reaches only its own preview.
  - A push environment deploys only from the branch that first deployed it.
  - An environment keeps its kind. kitshn refuses a deploy of another kind onto its card, because removal and teardown follow the kind.
- **K-808** Planned: `needs.vars` and `needs.secrets` list names, and the values come from the kitshn store (K-809). Until then, the schema refuses them. A `KITSHN_<NAME>` GitHub variable or secret forwards as `<NAME>` on each deploy. A deploy fails before any work when a needed name has no value. A Worker app gets each value as a secret binding, and kitshn stores none. A repo secret also reaches pull request previews, so a secret for production only goes in the GitHub Environment "prod".
- **K-809** Planned: the kitshn store encrypts secret values with AES-GCM under a Worker secret. The map shows names and "set" or "missing", never a value.
- **K-810** The workflow file is the same few lines for every app. It needs `permissions: id-token: write` and calls the reusable workflow of K-803.
- **K-811** Deploy auth: Actions sends its GitHub OIDC token. kitshn accepts a token whose `repository_owner_id` is on its list of owners, and refuses any other. The list holds user accounts only, no organizations for now.

## Compose deploys

- **K-812** A Compose deploy is a job (K-610). Actions sends the checkout and the `KITSHN_*` params to R2 through the Worker. The daemon downloads them with its machine token, only while it runs that job, so the machine needs no GitHub credential. Rules:
  - After the app comes up, the daemon keeps that build as the last good build (K-718). A push environment also keeps the build before it, with its images tagged `kitshn-keep/<card>/<service>:<deploy id>`, for a rollback (K-821).
  - The daemon starts the app with the variables of KitSHn 1, so a KitSHn 1 `compose.yml` works unchanged, within the limits of K-818. KitSHn 1 deploy credentials never reach the app.
  - A machine runs one Compose job per app at a time.
  - The files leave R2 when the job ends, and an R2 rule removes any that remain after a day.
- **K-813** The Actions step polls the deploy state every few seconds until it ends, then prints the job output and the address. The daemon sends the output at the end of the job, not line by line. Revisit when builds need live logs.
- **K-814** The deploy ends with a route check: kitshn requests the address and records the status and content type.
- **K-815** Planned: `kitshn try` builds and runs a recipe on the developer's machine with a temporary socket. It touches no environment.
- **K-816** kitshn creates a GitHub deployment and its status for each environment of each app.
- **K-817** A `push` entry may list up to 5 addresses (each costs API calls in one deploy request, K-406). A `pull_request` entry keeps one (K-901). Rules:
  - Each address is the apex or one level below a zone of K-1111, so Universal SSL covers it.
  - The first address under `KITSHN_ZONE` is the main one: the card address, the route check and the deployment.
  - Each address has its own Access application, and K-402, K-403 and K-410 hold per address.
  - A Compose address gets its DNS record at plan time, before the build, so no lookup during the build caches another answer.
  - No address is an admin host or a name that kitshn uses (`kit`, `pages`, `files`, `www`).
  - kitshn takes over no record that it did not make. It keeps the card that made each of its records, so only a record of another card blocks.
  - An address that leaves the list sends its visitors on (K-1124).
- **K-818** A Compose app gets no more than its own folders, project and network. The daemon builds and starts from a checked config, not from the repo's files. Rules:
  - The daemon parses the raw files for `include` and `extends` first, then reads `docker compose config --no-interpolate`, checks the env and label files, and only then reads the config with the params.
  - Only a short list of Compose keys passes on its own, with safe values. Paths stay inside the app's folders after symlinks, and a bind is never a link or under another writable bind, because Docker follows links at each container start.
  - Every other key or value (for example `privileged`, `ports`, `network_mode`, `bind:/var/run/docker.sock`) runs only when the owner names that repo and setting on the machine's allow list. An entry holds for previews too.
  - The daemon builds while the old app still runs. Then it stops every container of the app, checks the paths once more and runs `up`, so no container can swap a path between the check and `up`. A failure before `up` starts the old app again.
  - kitshn sends Compose jobs only to daemons with the capability `compose-guard`.
  - Known limits, to revisit when a second person deploys apps on a machine: apps share the BuildKit cache; a root container can leave setuid files in its folders; there are no default CPU or memory limits; network aliases and `<project>-<service>` names can collide between apps. Rootless Docker for the kitshn user is the next step. The VPS runs it, and its `kitshn` user is not in the `docker` group.

## The repo gate

- **K-819** A repo that kitshn has never deployed waits. Its first deploy step records it by its GitHub `repository_id` and fails with "waits on the kitshn map". One Allow or Block covers every app of the repo. This bends K-002: a new repo needs one click before its first deploy, because with OIDC (K-811) any repo of a trusted owner, also one that an agent created, could otherwise deploy code onto a machine. Rules:
  - "Allow" starts the workflow of the waiting run again through the GitHub App (K-908). Allow is a deploy permission, not an access share, so it works during the pause but starts nothing until Resume.
  - "Block" cuts a repo off at once, also after a rename or a transfer, because the gate keys on the id. A blocked repo still tears down its previews.
  - "Forget" deletes the gate row, so the next deploy waits again. kitshn refuses it while the repo has cards, and for a blocked repo or a repo of a removed key, because an agent key could then allow it.
  - The repo list asks GitHub whether each repo still exists, at most once per repo per day. The daily run does not ask, because its alarm already spends 40 of the 50 calls (K-406). A repo is "deleted on GitHub" only when every installation answers 404 and one of them holds all repos of the owner. Known limit: a private repo that moved to an account without the App also reads as deleted. Revisit when kitshn stores the owner id of each repo.
  - An agent key with "runs" allows only a waiting repo, never during the pause, and never unblocks. While the key that allowed a repo has no agent circle, the repo counts as waiting until the owner takes it over or blocks it.
  - A key never writes allow entries (K-818), so the daemon refuses every risky Compose setting of a repo that a key allowed. Known limit: the allow list keys on the repo name, so a new repo under a freed name gets the old entries. Revisit when the allow list keys on the repo id.
  - A Compose app of a key's repo goes only to a machine where the key may run jobs (K-718). Its new cards start in the key's first agent circle, not in `startsIn`.
  - Planned (K-1730): a machine with "runs" allows a repo as a key does.

## Order and rollback

- **K-820** An app names the keys of the other apps of its repo that it needs in `needs.apps`. In one run, that means: deploy after those apps, and do not deploy when one of them did not deploy. An app with nothing to do for the event counts as deployed. The CLI deploys one app at a time in that order, because each deploy step is its own request, so parallel deploys gain nothing against the limits and make the log harder to read. It refuses unknown keys, self-needs and cycles. Each deploy row keeps its app key, the Cloudflare version, the workflow run and its `needs.apps`, so a later rollback can return one card or a whole run. Known limit: `needs.apps` names apps of the same repo only. Revisit when an app must wait for an app of another repo. The name `owner/repo#key` stays free for that.
- **K-821** "Roll back…" returns a deployed card to one of its last finished deploys. Rules:
  - A static or Worker card deploys that Cloudflare version again, with its code, files, bindings, vars and secrets. Cloudflare keeps the last 100 versions.
  - A Compose card starts the build before the last one from the kept source, params and image tags, with no build and no pull. A generated override pins each service to its kept tag with `pull_policy: never`, so no image that another app runs changes.
  - Data never rolls back. Vars and secrets do, so the dialog says to rotate a secret again after a rollback.
  - "Roll back this run…" takes every card of one workflow run back, an app before the apps that it needs, and stops at the first failure.
  - A rollback writes a new finished deploy row that repeats the old one, so the next rollback, Remove app and Undo see it as current. Rolling forward is a rollback to the newer deploy.
  - Only a member with control on the admin card rolls back, not during the pause and not for a blocked repo. A preview has no rollback.
  - Known limit: kitshn sets no disk limit for kept builds. Revisit when a machine runs low on disk.
- **K-822** Each Compose deploy, redeploy and rollback gives each service `KITSHN_ACCESS_TEAM_DOMAIN` and `KITSHN_ACCESS_AUDIENCES` (the AUD tags of the card's Access applications), so an app can check `Cf-Access-Jwt-Assertion` itself. kitshn reads them when the job goes out, so a redeploy and a rollback get the current values. A Worker app gets both as plain bindings. A value that the app sets itself wins. Known limit: a running app keeps the values of its last deploy, and kitshn sends no notice when an audience changes. Revisit when kitshn makes an application again in use.

## Previews

- **K-901** A pull request environment gets one address one level deep, `<repo>-pr-<n>.<zone>` (or `<repo>-<key>-pr-<n>.<zone>`), so the free Universal SSL certificate covers it.
- **K-902** A preview of a Compose app runs on the machine of its app, with a tunnel route to its socket and a DNS record.
- **K-903** A preview of a static site or Worker app is its own Worker script with a custom domain. The free plan allows 100 Worker scripts per account, so kitshn refuses a new preview at 90 and names the open previews.
- **K-904** With the GitHub App (K-908), a closed pull request removes its preview at once: containers, images, volumes, socket, route, DNS record, Access application and card. Without the App, the workflow does it on the `closed` event. A removal on the map (K-909) keeps the volumes.
- **K-905** Planned: a preview keeps what the recipe lists in `keep`, as KitSHn 1. Today a closed preview loses all its data.
- **K-906** Planned: `limits: { cpus, memory }` caps all previews of an app together, as KitSHn 1. Production is never limited.
- **K-907** A preview starts in its `startsIn` circle, by default "Owner".
- **K-908** The kitshn GitHub App adds: preview teardown on close (K-904), deployment statuses (K-816), builds that agents start (K-718, with "Actions: write"), and "Allow" that starts the refused push again (K-819). Planned: repo cards before the first deploy, and "New app" from a template.
- **K-909** "Remove app" takes down an app environment that a deploy made. Only a member with control on the admin card removes an app, and it has no confirm. `DELETE /api/apps/<card>` runs one service. A removal lowers access, so it works during the pause. Rules:
  - A static site loses its custom domain and its script.
  - A Worker app or a folder site loses its custom domains and crons, and kitshn keeps the script with its Durable Objects and KV, as a Compose app keeps its volumes. The admin card lists them as "Orphaned Worker storage", each with its own "Delete".
  - A Compose app gets a `compose-down` job that never expires. It goes out again after a reconnect, because a stop can run twice without harm. A newer deploy replaces a stop that waits. Until the job ends, the Access application lets in only the Owner circle.
  - A removal never deletes volumes or the last good build (K-812).
  - Undo restores the card in its place and starts the app again, under K-1506. During the pause, it starts nothing. The undo result names each app that it did not start, and why.
  - The machine card lists idle volumes of kitshn apps without a card as "Orphaned volumes", each with its own "Delete". kitshn checks again before the job goes out that the app still has no card. An agent key never deletes a volume. A machine deletes one only by "destroys" (K-1730).
  - Known limit: a removal leaves the app's data folder and its last good build on the machine. Revisit when the disk of a machine fills with removed apps.
