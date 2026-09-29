# Trek Sites Deployment Review

Perspective: a coding agent that kept two KitSHn recipes deployed through a long run of daily changes. The recipes are `Yarden-zamir/gr52` (`gr52.yarden-zamir.com`) and `Yarden-zamir/yam2yam` (`yam2yam.yarden-zamir.com`). Both are built from `Yarden-zamir/trek-site-template` and run on the same VPS (`89.233.108.13`).

## Summary

KitSHn carried a site that grew from static pages into four services without changing its model: a Caddy site container, a Python upload service, oauth2-proxy for GitHub sign-in, and ffmpeg for videos. Each change was a push to `main`. Most deploys took one to two minutes, and the site stayed up.

The friction came from four places:

- Two recipes that deployed at the same time on one VPS broke each other.
- KitSHn's params model differs from plain Compose, and the docs did not say where it differs. This was fixed in #6.
- It was hard to tell from the laptop when a deploy was live.
- The details of GitHub sign-in behind the Unix socket ingress were undocumented.

## The Recipes

- `site`: Caddy in a container. It serves the static build, binds `${KITSHN_DEFAULT_SOCKET}`, and routes `/auth/*` and the editing routes.
- `uploader`: a Python service with Pillow and ffmpeg. It keeps pictures, videos and page edits on the `logdata` volume.
- `oauth2-proxy`: GitHub sign-in through a GitHub App. Caddy calls it with `forward_auth` for the editing routes. This service runs in gr52 only.
- Params: `KITSHN_OAUTH2_PROXY_CLIENT_ID`, `KITSHN_OAUTH2_PROXY_CLIENT_SECRET` and `KITSHN_OAUTH2_PROXY_COOKIE_SECRET`, as secrets in the `prod` environment.

## What Went Well

- **The model stays small.** It is a Compose file, a `Caddyfile.j2` and GitHub variables and secrets. Adding a service was an edit to one file.
- **Pushes deploy.** Dozens of `main` deploys per recipe succeeded with no manual step on the VPS. A typical deploy took one to two minutes from push to the new files served. A deploy that rebuilt the uploader image with ffmpeg took about three minutes.
- **Unix socket ingress needs no ports.** Three services, and oauth2-proxy talks to Caddy on the project network, with no host port and no clash between recipes.
- **The `KITSHN_` prefix and environment scoping are correct for secrets.** Pull request previews never see production secrets.
- **Debugging on the VPS is direct.** `docker logs` and `docker exec` gave answers in seconds. For example, the oauth2-proxy log showed that the browser never reached `/auth/callback`, which pointed at the page and away from the server. `docker exec -i <uploader> python -` was the safe way to send edits to the service from inside the network, with the same checks that the public route uses.
- **The workflow logs are clear.** The one failed deploy named the failing command and its error.

## Pain Points

### 1. Two recipes that deploy at the same time on one VPS break each other

The CI concurrency groups are per `<owner>/<repo>/<environment>`. So gr52 `prod` and yam2yam `prod` deploy in parallel on the same host. Two times, when both were pushed within a minute, the gr52 deploy failed. I read the log of the first failure:

```text
failed to set up git credential helper: failed to run git: error: could not lock config file /root/.gitconfig: File exists
kitshn: command failed (1): gh auth setup-git --hostname github.com
```

`git_ops._configure_github_git_auth` runs `gh auth setup-git` on every deploy, and that command writes the global `/root/.gitconfig`. Two deploys that write it at the same moment race for its lock.

After the failure, `https://gr52.yarden-zamir.com` did not answer. TLS failed with `tlsv1 alert internal error` for up to ten minutes, while `http://` still answered. A re-run of the failed job fixed it. I did not find why a deploy that failed at the git step also took the live site off the air. I expected the previous deployment to keep serving.

Workaround: I pushed one recipe, waited for its deploy, then pushed the next.

### 2. A repo `.env` does nothing, and nothing says so

The template wrote a `.env` with `LOG_EDITORS`, `LOG_TZ` and `COMPOSE_PROFILES=auth`. KitSHn runs Compose with `--env-file <params.env>`, so Compose never read that file. As a result:

- the `auth` profile never started oauth2-proxy
- the uploader never got its editor list or its time zone

The deploy succeeded, and `docker compose config` from the laptop looked correct. This came to light only when sign-in answered 502 in production. The fix was a generated `compose.override.yml`, which Compose loads beside `compose.yml`. #6 now documents this, but a deploy still gives no warning.

### 3. It is hard to tell when a deploy is live

I polled the public URL for a string that only the new build contains. That worked, but it is fragile. Once, my chosen string also appeared in the old page, so I pushed the next recipe too early and caused pain point 1 again. `kitshn track` exists and does this properly: it checks the ref on the VPS, service health, and `--expect`. I did not use it, which is my mistake. The skill lists `track` in step 6 of the first setup, but not as the way to confirm every later deploy.

### 4. GitHub sign-in behind the socket ingress

- oauth2-proxy logs `Error obtaining real IP for trusted IP list: unable to parse ip (@) from X-Real-Ip header` on each request. Caddy's `{remote_host}` is `@` on a Unix socket, so `header_up X-Real-IP {remote_host}` sends `@`. The docs do not say which header carries the visitor's address behind the host Caddy.
- A pull request preview cannot sign in, because the GitHub App knows only the production callback URL. That is expected, but a recipe author meets it only at run time.

### 5. Params are set with raw `gh`

`kitshn params list` and `get` read params on the VPS. No command writes them. I used `gh secret set KITSHN_<NAME> --env prod`, with the value on stdin. That works, but a typo in the prefix or the environment fails silently until the next deploy.

## Did I Follow The Intended Flow?

Mostly. Every deploy went through a push and the workflow. I never ran Compose by hand on the VPS. I had to use `docker exec` for two jobs:

- reading logs
- sending edits to the uploader service from inside the network

I did not use `kitshn track` or `kitshn diagnose`. I polled public URLs instead, and I read the GitHub run list for failures. `track` would have removed the guesswork in pain point 3.

## Suggested Improvements

1. **Serialize deploys per VPS, not only per repo.** Take a host-wide lock around the deploy, for example `flock` on a file under the deployments root. Or make the git credential step not write shared global state: skip `gh auth setup-git` when the credential helper is already set, or pass a per-command helper with `git -c credential.helper=…`.
2. **Keep the live deployment serving when a deploy fails early.** A failure before Compose runs should not change the Caddy routes. If this outage has another cause, `diagnose` could report the Caddy state after a failed deploy.
3. **Warn about a repo `.env`.** When the recipe root has a `.env`, and it sets `COMPOSE_PROFILES` or a variable that `compose.yml` interpolates, print a warning in `try` and in the deploy log. The warning says that KitSHn does not read the file.
4. **Make `track` the default way to confirm a deploy.** In the skill, say "after each push, run `kitshn track --expect <text>`", not only in the first setup. The workflow summary could also print the one-line `track` command for that run.
5. **Add `kitshn params set <owner/repo> <NAME> --env <environment>`.** It reads the value from stdin, adds the `KITSHN_` prefix, and checks the environment exists.
6. **Document the visitor's address behind the host Caddy.** Name the header that the host Caddy sets for the recipe (`X-Forwarded-For`, or another), and give the value for an auth proxy's `X-Real-IP` in the static template.
7. **Add a GitHub sign-in example.** The static template could carry an optional oauth2-proxy service and the `forward_auth` block. It could also have a note that previews need their own app.

## Overall Takeaway

KitSHn was a good fit for a site that changed daily and grew services over time. The deploy loop was fast enough that small visual fixes went out one by one, and the model never needed a workaround for adding a service or a secret. The two real problems:

- Recipes that share one VPS need a host-wide deploy lock.
- The params model must be loud about ignoring a repo `.env`.

Both are cheap to fix, and each cost more time than any other issue in this run.
