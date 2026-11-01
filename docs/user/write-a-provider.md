# Write a provider

A provider is a program on a machine that adds its own cards to kitshn through the local daemon, as T3 Code does. The rules are K-701 to K-723 in [providers.md](../internals/providers.md). Every schema and limit is in `@kitshn/local`: import it, do not copy it.

## Get the packages

Each edge release `edge-<sha12>` of Yarden-zamir/kitshn carries `kitshn-local.tgz` (the schemas) and `kitshn-contract-tests.tgz` (the contract tests), listed in its `SHA256SUMS`. There is no registry and no token.

1. Depend on `https://github.com/Yarden-zamir/kitshn/releases/download/edge-<sha12>/kitshn-local.tgz`. `effect` is a peer dependency, so you keep one copy.
2. Keep the one `<sha12>` in one place, and bump it on purpose.

## Connect

1. Spawn `kitshn provider` as a long-lived child process. It copies JSON lines between its stdin and stdout and the daemon socket.
2. When `kitshn` is missing, run without kitshn. Never fail because of it.
3. When the stdout of the bridge ends, start it again and register again.
4. Answer each `ping` with `{"type":"pong"}`. Drop the connection yourself when no line came for `graceMs`, which the `register` answer names.

## Register

Send `register` on each new connection, with `protocol: 2` and `protocolVersion` (the `KITSHN_PROTOCOL` of your `@kitshn/local`), your provider name, a stable `instance`, your kinds, commands and all your resources.

- A bad item does not refuse the register. The answer names it in `problems`. Fix what it names.
- A resource with `site: { port }` becomes a live site of the machine. The daemon names its address.
- Skip an event type that you do not know, and ignore unknown fields.
- Compare `protocolVersion` of the answer with `matchProtocol`. Another minor: log the warning and go on; gate a newer feature on `capabilities`. A refused `register` names both versions: show it once, and register again at your normal reconnect cadence.

## Decide access

Never parse an Access JWT. For each new session, send `check` with the request headers that `identityHeaders` names.

- Use `levels` for what the subject may do, and cache the answer until `until`.
- On `grants-changed`, check your live sessions again in one batch.
- `refused` with `expired`: drop the session. With `unavailable`: start no new session, and keep the live ones. With any other code: revoke the session.
- No daemon or no answer means no new session.

## Vouch for your agents

Give each agent `KITSHN_ATTEST=<provider>:<token>`. When the daemon sends `attest`, answer with `attest-result` within 2 seconds: `active` and bare labels such as `thread.id`. The daemon adds your prefix.

## Run on another machine

Send `exec` with the target machine, the command and the folder. Output arrives as `exec-output` frames only while you have credit: grant more with `exec-credit` after you wrote the data out. Exactly one `exec-exit` ends each run. A run that waits for an approval keeps its `execId`.

## Test

Run `npx kitshn-contract --daemon <daemon binary> --provider "<command that starts your provider>"` in CI. It exits 0 when every scenario passes. Test your handling of `check`, `attest` and exec frames in your own tests, with the schemas of `@kitshn/local`.
