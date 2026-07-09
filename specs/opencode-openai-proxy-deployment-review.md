# opencode-openai-proxy Deployment Review

Perspective: an AI agent (Claude) **iterating on two already-existing KitSHn recipes** —
`Yarden-zamir/opencode-openai-proxy` (a new OpenAI-compatible bridge) and
`Yarden-zamir/opencode-telegram-bot` — both deploying `main -> prod` on
`yarden-zamir-vps-2` and attaching to the shared `opencode-serve` instance over
`kitshn-edge`. Unlike the changeLorg review, this was **not** first-time setup: the
recipes, VPS bootstrap, and auth already existed. My loop was: edit code → push
`main` → GitHub Actions deploy → verify on the VPS.

## Summary

The push-to-`main` deploy is simple and dependable for iteration. Almost all friction
was in the **edit/verify inner loop**, not the deploy mechanism itself: prod is the only
target for these fixed-hostname recipes (so every test is a real deploy), verification
and secret retrieval fall back to raw `docker` on the VPS, and services are reachable
only over `kitshn-edge`, not host ports. Both recipes deployed green and were verified in
prod (proxy: conversation continuity + model fallback; bot: live topic creation on new
sessions).

## Process (as I actually used it)

- **Deploy trigger:** `.kitshn.yaml` (`deploy: on push, branch main, name prod`) →
  `.github/workflows/kitshn.yml`, which calls the reusable
  `Yarden-zamir/kitshn/.github/workflows/deploy.yml@main`: `resolve → build params →
  Deploy over SSH → teardown`. ~1m20s when a runner is free.
- **Secrets/params:** GitHub `KITSHN_*` secrets/vars, materialized on the VPS at
  `/params/<owner>/<repo>/<env>/params.env` and injected into container env.
- **Networking:** services join `kitshn-edge`; a recipe attaches to the shared instance
  via the `kitshn.depends_on` label and `http://opencode:4096`. Public ingress is Caddy →
  unix socket (`Caddyfile.j2` + a socat socket-proxy).
- **Verify:** `docker logs/exec/inspect` on the VPS plus hitting the public HTTPS
  endpoint through Caddy.

## Pain Points

- **Prod is the only environment.** These recipes deploy `main -> prod` only (fixed
  public hostname / shared singleton), so every change under test ships to prod. I worked
  around it by running throwaway containers on the edge network
  (`docker run --network kitshn-edge ...`) to exercise new code against the real opencode
  before pushing — but there's no first-class "build and test this recipe without shipping
  prod" path.
- **CI-only deploys, with latency.** One deploy sat `queued` ~7+ minutes before a runner
  picked it up. There's no quick local `kitshn deploy` for these recipes; each iteration
  waits on GitHub Actions.
- **Secret retrieval is non-obvious.** Getting the live `PROXY_TOKEN` / bot token meant
  either `sudo cat /params/.../params.env` or `docker inspect` the container env. I first
  grepped the wrong var name (empty result), and later a token read that didn't strip
  surrounding quotes/whitespace produced a confusing `404` from an API call. A
  `kitshn secret get <recipe> <env> <KEY>` would remove this whole class of mistake.
- **No host port binding.** Services aren't published to the host, so `127.0.0.1:<port>`
  doesn't work — everything goes over `kitshn-edge`. Correct and secure, but I initially
  assumed host access and had to switch to a curl sidecar / `docker exec`.
- **Observability is raw Docker.** Verifying a deploy = `docker logs/exec/inspect` on the
  VPS. `kitshn diagnose` exists but isn't part of the iterate loop; a `kitshn logs` /
  `kitshn status <recipe> <env>` would help a lot.
- **BusyBox tooling gap (not KitSHn's fault, but hit during verify).** The opencode
  container ships BusyBox `wget` (no `--method`) and no `curl`, so a simple `DELETE`
  against the API required spinning up a `curlimages/curl` sidecar on `kitshn-edge`.
- **Noisy workflow annotation.** Every deploy run logs a `uv` cache warning
  (`No file matched ... cache-dependency-glob`). Cosmetic, but it reads as a problem on an
  otherwise-green run.

## Misunderstandings / Where I Had To Be Steered

- **I confused KitSHn with the client app.** I repeatedly called KitSHn "the Android app"
  and wrote that into GitHub issues and a README. The user corrected me: **KitSHn is the
  VPS deployment system; the client is `openclaw-assistant`.** I had to rewrite issue
  bodies and doc references. Root cause: I inferred the role from context instead of
  checking. A one-line "KitSHn is a deployment system, not an app" in the README/AGENTS.md
  would have prevented it.
- **Deploy-to-verify by reflex.** My first instinct was to deploy in order to test; the
  better practice here (and the user's implicit expectation) was to validate in an
  isolated container on `kitshn-edge` first, then deploy once. I adopted that after the
  first round.
- **(App-level, for completeness)** The user also steered two design calls unrelated to
  KitSHn: using an opencode session-title hash instead of a separate state map for proxy
  conversation continuity, and identifying "telegram's own" sessions from the bot's
  binding store rather than by guessing from titles.

## Suggested Improvements

- Add `kitshn secret get <recipe> <env> <KEY>` (or at least print the params path) so
  operators don't hand-parse `params.env` or `docker inspect`.
- Add `kitshn logs` / `kitshn status <recipe> <env>` for the iterate/verify loop, not just
  `diagnose`.
- Document (or provide a helper for) the "test a recipe build against shared services
  without a prod deploy" pattern — e.g., the `docker run --network kitshn-edge` sidecar I
  used, or a `kitshn run --ephemeral`.
- State plainly in generated recipe READMEs that services are reachable only over
  `kitshn-edge`, not host ports.
- Silence or scope the `uv` `cache-dependency-glob` annotation in the deploy workflow.
- Add one line to the KitSHn README/AGENTS.md clarifying that KitSHn is a deployment
  system (so agents don't mistake it for the app being deployed).

## Overall Takeaway

For iterating on existing recipes, KitSHn's push-to-`main` model is low-ceremony and
reliable. The gaps are all in the inner loop: no lightweight non-prod target, CI-only
deploys, and verification/secrets that fall back to raw Docker on the VPS. First-class
`secret get`, `logs`/`status`, and an ephemeral test path would make agent-driven
iteration noticeably smoother.
