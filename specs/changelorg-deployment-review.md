# changeLorg Deployment Review

Perspective: first-time service deployer using KitSHn to deploy `Yarden-zamir/changeLorg` to `changelorg.yarden-zamir.com` on `yarden-zamir-vps-2`.

## Summary

KitSHn worked well once I followed the intended GitHub Actions flow. The deployment model is clear: recipe repo in GitHub, VPS bootstrapped once, recipe auth configured once, then pushes and PRs drive deploys. The main friction came from command/version ambiguity, bootstrap wording, a Docker networking footgun in the socket-proxy pattern, and my initial misunderstanding of PR preview routing.

The final deployment is healthy:

- `https://changelorg.yarden-zamir.com/health` returns `{"status":"ok"}`.
- `https://pr.1.changelorg.yarden-zamir.com/health` returns `{"status":"ok"}` for the PR preview.
- `/refresh/status` reports the hourly backend refresh loop enabled and successful.
- `kitshn diagnose Yarden-zamir/changeLorg --environment prod` passes on the VPS.
- `kitshn diagnose Yarden-zamir/changeLorg --environment pr-1` passes on the VPS.

## Timing

Measured from GitHub Actions history and final verification:

- First failed workflow started: `2026-07-08T06:26Z`.
- VPS was successfully serving healthy public endpoints: about `2026-07-08T08:01Z`.
- Total elapsed time from first deploy attempt to verified public deployment: about **1 hour 35 minutes**.
- The final successful deployment cycle after the socket-proxy fix was about **2 minutes**.
- The initial successful KitSHn deploy before diagnosis took about **3 minutes**, but exposed a runtime 502 due to recipe Compose networking.
- The PR preview redeploy after fixing `Caddyfile.j2` took about **1 minute 23 seconds** and produced a healthy preview route.

This includes creating the GitHub repo, bootstrapping the VPS, configuring recipe auth, debugging the first failed workflow, diagnosing the 502, patching the recipe, and redeploying.

## What Went Well

- The GitHub Actions deployment flow was clean once `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY` were configured.
- `kitshn recipe auth --vps-host yarden-zamir-vps-2` did the right thing: generated an SSH key, set repo secret/var, and authorized the public key on the VPS.
- `kitshn diagnose` was the most useful debugging tool. It clearly showed that Compose and Caddy were present, the socket existed, and the failure was specifically `curl app.sock`.
- The hosted command worked correctly once used explicitly: `uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...`.
- The VPS did not need a persistent KitSHn install. Installing `uv` was enough; KitSHn itself ran through hosted `uvx`.
- The Caddy Unix-socket ingress model is good. It avoided host port allocation and made the app deploy self-contained.
- PR preview deploys worked once the recipe used an environment-aware hostname in `Caddyfile.j2`.

## Pain Points

- `uvx kitshn` resolved to an older PyPI version (`0.1.0`), while the docs and generated scaffolding expected newer behavior (`0.1.5`). The reliable command was the longer GitHub-source form.
- `bootstrap-remote` was confusing because it attempted to run `kitshn bootstrap` on the remote host. That conflicts with the documented guidance that the VPS does not need a persistent KitSHn install.
- The VPS did not have `uv`/`uvx`, so I first had to install `uv`. This is reasonable, but the distinction should be explicit: install `uv`, not KitSHn.
- The first GitHub Actions run failed because it started before `recipe auth` had configured `KITSHN_VPS_HOST` and `KITSHN_SSH_KEY`. This is easy to recover from by rerunning, but the order matters.
- Raw `docker compose` on the VPS is misleading unless the KitSHn params/env are provided. It prints many blank-variable warnings and can restart services incorrectly if run carelessly.
- The scaffolded socket-proxy example attached the proxy to `kitshn-edge`. For this app that caused Docker DNS to resolve `app` through the wrong network and produced public 502s despite healthy containers.
- I initially misread the PR preview failure as evidence that this should be a singleton-only deployment. That was wrong. The failure was a recipe bug: prod and PR preview Caddy site blocks both used `changelorg.yarden-zamir.com`.

## Main Runtime Bug Encountered

The app container was healthy and reachable inside the Compose default network:

```text
curl http://app:8000/health -> {"status":"ok"}
```

But Caddy returned 502 and `kitshn diagnose` reported a socket failure. The socket-proxy logs showed repeated `Connection refused` to alternating container IPs.

Root cause: the `socket-proxy` service was attached to both the app default network and `kitshn-edge`. Because Caddy talks through the host-mounted Unix socket, the socket-proxy does not need `kitshn-edge`. Removing that network attachment made Docker DNS resolve `app` correctly.

Final fix in the recipe:

```yaml
socket-proxy:
  image: alpine/socat:latest
  command: ["UNIX-LISTEN:${KITSHN_DEFAULT_SOCKET},fork,unlink-early,mode=666", "TCP:app:8000"]
  volumes:
    - ${KITSHN_SOCKET_DIR}:${KITSHN_SOCKET_DIR}
  networks:
    - default
  depends_on:
    app:
      condition: service_healthy
```

## PR Preview Routing Bug Encountered

After the feature branch opened a PR, the preview deployment failed during Caddy validation:

```text
Error: adapting config using caddyfile: ambiguous site definition: changelorg.yarden-zamir.com
```

Root cause: `Caddyfile.j2` hardcoded the production hostname. The PR preview environment `pr-1` generated a second site block for the same hostname as prod, so Caddy correctly rejected the combined config.

I first made the wrong fix: I disabled PR previews in `.kitshn.yaml`, assuming this stateful app should be singleton-only. That violated KitSHn's default expectation that public HTTP recipes should support PR previews when DNS exists.

Correct fix: keep the default PR preview deployment and make the hostname environment-aware:

```jinja
{% if environment == "prod" -%}
changelorg.yarden-zamir.com
{%- else -%}
pr.{{ environment.removeprefix("pr-") }}.changelorg.yarden-zamir.com
{%- endif %} {
    reverse_proxy unix//{{ paths.default_socket }}
}
```

After this change:

- The PR workflow deployed `pr-1` successfully.
- `kitshn diagnose Yarden-zamir/changeLorg --environment pr-1` passed.
- `https://pr.1.changelorg.yarden-zamir.com/health` returned `{"status":"ok"}`.

Lesson: a Caddy ambiguous site error in a PR deployment usually means the recipe's route template is not environment-aware, not that previews should be disabled.

## Did I Follow The Intended Flow?

Mostly, after one false start.

Good path used:

- Added KitSHn recipe files to the service repo.
- Created and pushed the GitHub recipe repo.
- Bootstrapped the VPS with hosted `uvx`/KitSHn and system dependencies.
- Configured recipe auth with `kitshn recipe auth`.
- Used GitHub Actions for deploys.
- Kept the default PR-preview deployment model after correcting the hostname template.
- Used `kitshn diagnose` on the VPS after deployment.
- Did not install KitSHn persistently on the VPS.

False starts:

- Tried `bootstrap-remote`, which assumed remote `kitshn` existed.
- Briefly used the Homebrew `kitshn` wrapper locally before switching to explicit hosted `uvx`.
- Initially copied a socket-proxy pattern with an unnecessary `kitshn-edge` network.
- Temporarily disabled PR previews instead of first fixing the route template. The correct pattern is prod hostname for `prod`, preview hostname for `pr-*`.

## Suggested Improvements

- Make docs consistently prefer:

```sh
uvx --from git+https://github.com/Yarden-zamir/kitshn.git kitshn ...
```

- Add a remote bootstrap command that installs or verifies `uv`, then runs hosted `uvx`, without requiring remote `kitshn`.
- Rename or document `bootstrap-remote` clearly if it intentionally requires a remote `kitshn` binary.
- Add a warning or diagnosis hint when a socket-proxy service is attached to extra networks.
- Add a first-class recipe template for a TCP app behind a Unix socket proxy.
- Make the public HTTP template include an example environment-aware Caddy hostname for PR previews, such as `pr.{{ environment.removeprefix("pr-") }}.<domain>`.
- Have `diagnose` or `deploy` add a hint when Caddy fails with `ambiguous site definition`: check whether prod and PR generated the same hostname.
- Make `diagnose` explain common meanings for:
  - `curl app.sock: empty reply`
  - `curl app.sock: connection reset`
  - socket proxy logs showing `TCP:app:8000: Connection refused`
- Consider a command that runs Compose using the exact stored params file to avoid manual `docker compose` mistakes.

## Overall Takeaway

KitSHn is a good fit for small VPS-hosted services. The core flow is simple and reliable once the recipe repo exists and auth is configured. The biggest improvements would be making the hosted-`uvx` path impossible to miss, hardening the socket-proxy guidance, and making PR-preview hostname templating explicit in public HTTP recipes.
