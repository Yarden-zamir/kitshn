# Lessons And Architecture Follow-ups
This records lessons from deploying several real services with KitSHn and the architecture changes worth considering next.

## What Worked
- The core model stayed useful: a recipe repo plus `.kitshn.yaml` was enough to deploy prod services, PR previews, singleton bots, and utility apps.
- Running the hosted KitSHn CLI through `uvx` kept CI and VPS behavior aligned without requiring a preinstalled local checkout.
- Docker Compose as runtime source of truth made deployments understandable and debuggable with native Docker commands.
- Caddy generated from recipe-owned `Caddyfile.j2` kept ingress close to the service contract.
- `kitshn.depends_on` labels gave dependent services, such as Shahar depending on OpenCode, a simple recreation hook when an upstream deploy changed.
- Unix socket ingress removed host-port allocation from public services; apps can bind sockets directly, while TCP-only images can use a socket proxy sidecar.
- `kitshn diagnose <owner/repo> --environment <env>` now gives a quick remote health view for Compose, generated Caddy, socket targets, curl probes, and Caddy validation.

## Pain Points
- Secret forwarding was easy to misunderstand. GitHub secrets must be named `KITSHN_*` to reach app params, but the app sees the stripped name. Setting `OPENCODE_SERVER_PASSWORD` did not help; only `KITSHN_OPENCODE_SERVER_PASSWORD` produced `OPENCODE_SERVER_PASSWORD` in `params.env`.
- Reusable workflow logs expose JSON key names for all inherited secrets. Values are masked, but empty forwarded values are visible as empty strings and can be confusing.
- Dependencies only recreate already checked-out dependent services. That is intentional, but it can surprise users expecting dependency deploys to pull dependent repo changes.
- App-level routing still differs by runtime capability. Direct Unix sockets are simplest when the app supports them; arbitrary TCP-only images need a sidecar proxy.
- Public PR preview routes depend on DNS, not just KitSHn and Caddy. Missing wildcard DNS made otherwise healthy PR deployments unreachable from the public internet.
- Remote OpenCode introduced cross-recipe secret and network coupling that was not visible enough in the recipe contract.
- Debugging failed deploys still requires reading GitHub logs and remote Docker state separately. `kitshn diagnose` covers current remote state, but not the full GitHub run timeline or last failed deploy log.

## Architecture Changes To Consider
- Add a first-class `params` or `secrets` declaration to `.kitshn.yaml`, including required/optional flags and documentation strings. Use it to validate that required GitHub `KITSHN_*` vars/secrets exist before SSH deploy.
- Print a non-secret params summary during `ci-write-params`: forwarded key names, whether each is empty/non-empty, and which reserved keys were consumed but not forwarded.
- Add `kitshn recipe doctor` for a service repo. It should check workflow permissions, GitHub vars/secrets presence, `.kitshn.yaml`, Compose interpolation, dependency labels, routing files, and wildcard DNS hints for PR hostnames.
- Make dependencies richer than a label string. A future schema could describe recreate-only, redeploy, health dependency, shared network requirement, and required params from upstream services.
- Provide a dependency graph command, for example `kitshn graph`, showing which deployments will be recreated when a recipe deploys.
- Add a deploy report artifact or timeline entry that captures ref, environment, params keys, Compose services, Caddy output path, affected dependents, healthcheck results, and final URLs.
- Consider optional route strategies explicitly: `tcp`, `unix-socket`, or `none`, instead of relying entirely on handwritten Compose/Caddy coordination.
- Add a safer secret-copy helper for common cross-recipe cases, such as sharing an upstream service password into a dependent recipe's `KITSHN_*` secret without printing it.
- Extend `kitshn diagnose` or add `kitshn logs --last-deploy` to include GitHub run status and remote deploy logs, not only current VPS state.

## Documentation Updates To Make
- Emphasize that `KITSHN_` is a GitHub-side selector and not the runtime name. Runtime apps reference the stripped key.
- Document dependency behavior as recreate-only, not full dependent redeploy.
- Document the DNS requirement for wildcard PR preview hostnames.
- Include examples for cross-recipe shared services, especially internal HTTP dependencies on `kitshn-edge`.
- Add complete direct-socket and socket-proxy examples, including the `alpine/socat` TCP-only image pattern.
