# Draft: recipes for native services

Status: the draft schema can be checked, but both the CLI and Worker refuse deployment. It creates no service, card,
route, artifact, or DNS record. The lifecycle and tests below must be implemented before enabling it.

## Motivation

An application such as a local proxy has a process and persistent private data on a Mac, Linux machine, or Windows PC.
The current recipe kinds deploy a static site, a Worker, or a Compose app. Compose is useful where available, but it
does not manage an existing launchd agent, a systemd user service, or a Windows scheduled task. A native service
recipe should describe an application, not grant a repo additional access to a machine by itself.

One app and environment identify one service on one machine, following the existing app/card model. A repo can use
separate app keys and machine labels to describe its Mac service and each machine's local fallback. This keeps the
service's identity, card, progress, and rollback specific to the machine. It does not imply that every machine with a
label is updated or that a new machine is implicitly authorized.

The draft fields are `native.runsOn` (machine labels), `native.executable` (a path inside a verified build artifact),
`native.args` (bounded literal arguments), and an optional `native.site.port` for a local HTTP service. `{data}` in an
argument is reserved for Kitshn to replace with that service's private, persistent data directory, without a shell.
When `site` is absent, the service is local-only. A site's presence does not by itself grant anyone access. Its default
must be private, and a machine-to-machine link must be separately authorized through the map.

## Security and ownership

Native code can read everything its OS user can read. An existing `deploy` label and a repo's Compose permission are
not sufficient authorization to run arbitrary native code as the daemon user. Before a native deployment can run, the
owner must explicitly allow that repo and service user on that machine. An agent cannot choose or change the service
user, widen an existing allowance, or obtain secrets through an approval for another operation. Recheck permission,
repo state, machine identity, and the target at job delivery, not only at planning time. A removed or changed key,
repo block, revoked allowance, or pause fails a queued deployment closed.

The process runs as the explicitly authorized, non-root user by default. A different user from the daemon requires a
deliberate, local operating-system mechanism that the owner installed; the daemon must not silently become root or
read that user's files to make the deployment work. On macOS use that user's launchd agent, on Linux its systemd user
service, and on Windows its least-privilege scheduled task. If the manager or user session is unavailable, fail with a
clear reason and keep the previous service. For a systemd user service without a login, enable lingering only when
the owner chose that behavior.

Kitshn targets a `site` at a loopback HTTP endpoint; the service owner is still responsible for how the process binds
its own listener. A recipe must never create a public share,
or add machine members to a circle as a side effect. A private card and the existing map grant decide access. Normal
Kitshn live sites currently use public DNS behind Access, while the proposed machine relay can use a private card; the
implementation must distinguish those cases before it creates an address or an ingress. A router and a proxy engine
may be local-only and need no address at all.

## Artifact and lifecycle

The build runs for the intended commit in GitHub Actions and produces a platform-specific artifact. The deploy must
bind the artifact to that run, commit, platform, and digest; reject missing, mismatched, oversized, or ambiguous
artifacts. Download to a new private version directory, reject path traversal and symlinks that escape it, and verify
the executable again before use. The daemon never evaluates a recipe as JavaScript or interpolates shell syntax. The
executable path is relative to the artifact and its argument array is passed directly to the OS. Only the literal
`{data}` placeholder is expanded; its result is one argument, even when the path has spaces. No secret belongs in the
recipe, command arguments, job output, or artifact.

Each service user owns its persistent data directory; new versions and rollback do not delete or replace data, local
keys, or account credentials. Adoption of an existing service needs explicit checks that its user, service name,
listener, data path, and credentials are the intended ones. Do not overwrite an existing configuration or stop its
process before a verified replacement is ready. Preserve the prior version and service definition, test the new
service's health, and restore the prior version on failed startup. Handle an offline target as pending rather than
silently deploying elsewhere. Limit retained artifacts and make stop, removal, restart, and rollback deterministic.
Removing a service does not delete credentials.

Existing live streams can end during restart or rollback. Service availability and request replay are the caller's
concern; Kitshn must not replay a POST or claim that a stream resumed.

## Implementation and validation before enabling

- Decide how an owner grants a native repo a non-root service user per machine, and how the daemon talks to that user's
  service manager. Test the case where the daemon and service users differ, including the existing Linux VPS.
- Add a native deploy path and private service/card lifecycle without reusing the current static-site fallback. Verify
  that older daemons and old CLIs fail closed, and that an unavailable target cannot shift a service to another machine.
- Implement artifact upload, digest verification, bounded extraction, path and symlink checks, and explicit platform
  matching. Cover reconnect, pause, repo block, queued-job delivery, key rotation, and permission changes in tests.
- Test launch, restart, stop, failed update, rollback, removal, preserved private data, and an offline machine on all
  three operating systems. Test linked HTTP and streaming separately, including the Kitshn relay's revocation rules.
- Make `kitshn check`, the public types, this spec and the app-repo skill agree. Until every deploy path and user
  boundary is implemented, retain the CLI and Worker refusals and keep the PR in draft.
