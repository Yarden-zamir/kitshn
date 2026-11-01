# Machine identity and agent rights

An agent on a joined machine acts in kitshn as its machine (K-1612). kitshn is the authority, not the tool layer: it decides who may do what, with which approval, and records it. Agents keep their own tools (`git`, `gh`, `wrangler`, cloud CLIs, MCP servers). kitshn gives them identity and short credentials, and never wraps those tools. This file holds those rules (K-17xx).

kitshn reaches an outside service in one of four ways, in this order of preference:

1. Federation: the service trusts kitshn passes. kitshn has no code for that service.
2. Token minting: kitshn makes a short, narrow token of the service (GitHub).
3. Action relay: kitshn makes the call with a credential that stays in kitshn. Only for a short, named list of actions, each with its own design check. None exists yet.
4. Not kitshn: the machine uses its own credentials.

Agent parity: every action of the owner has an agent path. A call runs, waits for a person, or refuses because the rule also refuses the owner. What stays different: a person proves things with a passkey, and raising access always needs a person (K-715). Check this in every new feature.

Every new right starts off for every existing machine and agent key, so a new right never gives access by itself.

## Machine key pairs

- **K-1701** A machine proves itself to kitshn with its own Ed25519 key pair. Workers `crypto.subtle` and Bun both support Ed25519, so kitshn does not need P-256 here.
- **K-1702** The daemon keeps the private half in `machine.key` next to `machine.json`, mode 0600 in a 0700 folder. kitshn stores only the public half, its fingerprint and the time that it became valid. Known limit: root and every process of the daemon user can read the file, also an agent on the machine. Revisit with a hardware key (Secure Enclave, TPM), or when agents run as their own users.
- **K-1703** `kitshn join` makes the key pair before it sends the join code, and sends the public half with the code. kitshn stores it in the same step that deletes the code, and refuses a join without one.
- **K-1704** Each connection starts with a challenge: 32 random bytes per socket, kept only in the socket attachment, so a challenge writes no row. The daemon signs `kitshn-connect-v1`, the kitshn host, its machine id and the challenge. Each side takes the host from its own config, never from the challenge. Until the check passes, kitshn reads no message and sends no job, state or grant. Only an accepted socket replaces an older socket of the machine, so the token alone cannot push the real daemon off. Each socket accepts one answer, so a replay fails.
- **K-1705** "Rotate key" (panel or `kitshn rotate-key`) runs over the live connection. The daemon signs the new public half with the old key and the current challenge. kitshn stores the new key, writes a revision, and closes the connection, and the daemon connects again with the new key. From then on, kitshn refuses the old key. Only a member with control on the admin card rotates.
- **K-1706** "Reset key" is for a key that someone may have stolen, or for an offline machine. kitshn deletes the public half and closes the connection at once. Then `kitshn rekey <code>`, with the code rules of K-602, makes a new pair. The tunnel and the apps keep serving meanwhile (K-603), and jobs wait (K-613).
- **K-1708** A machine gets its first key only with a key code, from the join or from `kitshn rekey`. kitshn never takes a first key from a connection, so nothing runs unsigned. A machine without a key connects with its Access token for status and samples only. It gets no job, and kitshn ignores its other messages, so no unsigned message changes routing. Known limit: whoever holds the token of such a machine can push its daemon offline until the rekey.
- **K-1709** The machine keeps its Access service token, so `/connect` has two locks: Access checks the token, then kitshn checks the key signature. With the token, Access drops a socket without a valid service token before it costs a Worker request, and the token stays the machine's Access identity in circles (K-107). The owner chose this on the condition that joining stays one code: kitshn makes the token, and nobody copies one by hand.

## Asks

- **K-1710** An agent asks its daemon with `ask` on the local socket: one action, one target, an optional reason and optional labels. `kitshn agent <action> <target>` asks and prints the answer. The daemon accepts an ask only from an allowed local user (K-701), adds the attested labels (K-1752), and sends it over its signed connection. kitshn answers with the result, with "waiting" and a proposal id, or with a refusal and its reason. kitshn makes no token for its own actions: no JWT, no pass, no stored pass id.
- **K-1711** The actions match the agent paths of K-718: `state`, `apply`, `publish`, `organize`, `allow`, `deploy`, `job`, `job-read`, `github-token`, `audience-add`, `pass`, `approve`, `deny`, `history`, `backup` and `restore`. `state`, `job-read` and `history` need no right. `approve` and `deny` need membership of the approver circle (K-1723). Each other action needs one right of K-1730.
- **K-1712** kitshn runs an ask only when all of these hold at that moment: the connection passed the challenge, the machine has the right through its circles, every condition of the right holds on attested labels, K-819 and K-718 allow the action (or an Owner approval covers it, K-1776), and kitshn is not paused. It checks them again when an approval runs the ask.
- **K-1713** Known limit: every process of an allowed local user can ask, and labels that no provider vouched for are claims. The unit of trust is the machine, plus the thread that its provider vouches for. Revisit when agents run as their own users.
- **K-1714** Agent keys keep their HTTP paths `/agent/<path>`. A machine asks the actions of K-1711 only over `/connect`. The CLI commands `publish`, `address`, `redirect`, `logs` and `repo` send their `/agent` call through the daemon as a `forward` request. Rules:
  - The daemon sends only a normalized path below `/agent/`, signed with the machine key over the method, the path, the time, a nonce and the hash of the labels. kitshn takes a machine token on `/agent` only for a forward path with a valid signature from the last minute and an unseen nonce. It keeps the nonces in storage, so a restart does not let a copied call run again. The body is not signed; TLS covers it.
  - A forwarded call whose right is unset or "ask <circle>" waits like an ask: kitshn answers 409 with a proposal, and the CLI sends the same call again after the approval. The same call of the same machine and thread runs once within 1 hour after the approval.
  - `kitshn version --json` prints `{"product":"kitshn","generation":2,...}`, so a tool can tell kitshn 2 from a KitSHn 1 `kitshn`.
  - Known limit: a forwarded body is at most 12 MiB each way. Revisit when an agent needs more.
  - The owner chose HTTP over asks on `/connect` for these calls, because the asks would hold upload bodies in R2 for an approval. Revisit when an agent must not send its call a second time after the approval.
- **K-1715** An ask reads no Durable Object rows beyond a wake and the reads of the path that it runs: rights, circles, audiences and provider lists are in memory. It writes one ask event and one index row per label. `test/asks.test.ts` bounds the reads.
- **K-1716** "Rotate key", "Reset key" and "Remove machine" close the connection, deny every open proposal of the machine, and revoke every GitHub token of the machine that kitshn still holds. The pause does the same for every machine and agent key, and refuses new asks. Setting a right to off revokes the GitHub tokens that it gave.
- **K-1717** Asks are events, not revisions: no Undo, kept 30 days, at most 5,000. An event names the machine, the action, the target, the reason, the labels with their vouching provider, and the outcome. A decision writes one revision. The thread title is the snapshot at ask time.

## Modes and approvals

- **K-1720** Each agent right of a machine has one of four modes: "default", "off", "automatic" and "ask <circle>". "Default" asks the Owner (K-1776). Only "off" refuses. Only a member with control on the admin card sets a mode, and each change is a revision. All configurations are allowed, and some get a warning (K-1725).
- **K-1721** With "automatic", kitshn runs the ask at once (K-1712).
- **K-1722** With "ask <circle>", kitshn makes a proposal (K-1607) that names the machine, the action, the target, the reason and the labels, and answers "waiting". `kitshn agent` waits for the local socket event of the result, so nothing polls. The circle's people get it in the Inbox and as a Web Push. "Approve" opens `/inbox/<proposal id>`, because a service worker cannot pass a passkey check. "Deny" runs from the notification. Mute and snooze hide an ask, but never answer it.
- **K-1723** One member of the approver circle answers, with its own proof at that moment. Rules:
  - A person approves through one of two Access applications compiled from the approver circles. An Access token does not say which policy or login method let a person in, so the application decides it: `/api/approve/passkey` holds the passkey circles and takes a login of at most 10 minutes, and `/api/approve/login` holds the others. VERIFY: a person of a passkey circle reaches `/api/approve/passkey/start` only after a passkey prompt.
  - While any machine is joined, the Owner circle is an approver circle, because an unset right asks the Owner.
  - The approve page shows the full text of the ask and approves only when it has the hash that the Approve button carried. A link alone never approves.
  - "Resume" stays with the owner emails on `/api/fresh`. An approver policy never opens it.
  - A machine approves with the `approve` action over its signed connection. In a passkey circle, only while "machines may approve" is on (off by default). A machine never approves a job or deploy outside the K-718 limit of the asker.
  - A service token alone never approves. "Deny" needs no fresh proof, because it lowers access.
  - A proposal gets one answer, through one conditional write.
  - No proposal row holds a token. An approved `github-token` or `pass` sends "approved", and the daemon asks again. The same ask of that machine runs at once for 1 hour after the approval.
- **K-1724** A deny and an expiry after 24 hours reach the agent as "denied" or "expired", with the proposal id.
- **K-1725** The map warns, and does not refuse, when:
  - the approver circle holds the machine that asks, so it can approve itself (K-1727);
  - a passkey approver circle has "machines may approve" on;
  - a high-risk right ("runs commands", "deploys", "writes code", "adds apps", "restores") asks a circle with no person;
  - an approver circle with a machine member reads requester text, which an agent can write to fool another agent;
  - "writes code" is "automatic" with no thread condition (K-1754).
- **K-1726** An agent that answers for a circle uses `kitshn agent approve` or `kitshn agent deny` with a reason. It sees in `state` the proposals of its circles, in a passkey circle only while "machines may approve" is on.
- **K-1727** kitshn takes an approve or a deny from the machine that asked when the rules let it: the owner decided that what the rules allow, kitshn allows. The circle editor warns at once when such a rule starts (K-1725).
- **K-1776** A call that no right covers asks the Owner, and its approval runs that one call. Rules:
  - A right set to "off" refuses with one line that names the right. "Off" counts only for its own right.
  - A `job` or `deploy` outside the limit of K-718 asks the Owner also when its right is "automatic" or "ask <circle>".
  - A job that no approval can run, a volume removal, a command that does not parse, and a backup or restore of a card that the machine does not manage refuse at once, with no proposal.
  - A `kitshn gh` token ask with `auto` asks for write, because gh cannot say whether it writes.

## Rights on machines

- **K-1730** Agent rights belong to machines. The agent circles of a machine are the circles of devices and machines only that name the machine with at least one right set and have not ended. K-718 holds for a machine in its agent circles, with the machine in place of the key. The rights: "adds apps", "publishes", "deploys", "runs commands", "reads code", "writes code", "adds audiences", "gets passes", "adds pages" and "restores". Planned: "removes apps it added". Every right starts at "default". A member whose rights are all "off" still reads `state`, logs and page content of its cards.
- **K-1731** A machine in an agent circle is also an Access member of that circle (K-107), so its service token opens the sites of the circle.
- **K-1732** An agent key (K-718) is only an exception for an agent that runs on no joined machine. Every new right starts off for keys too. The map marks each key with an "exception" sticker.
- **K-1733** A repo group is a card of the kind `repo.group`. It matches repos by owner or by a name pattern with one `*`. A right on a repo group covers every repo that it matches, also one that kitshn has not seen yet. Known limit: a pattern matches by name, while the gate of K-819 matches by id, so a repo that someone renames into a pattern gets the rights of the group.
- **K-1734** A click on a repo group card highlights the repo cards that it matches. The panel lists them.

## Labels and attestation

- **K-1750** An ask carries at most 10 labels, each a prefixed key (for example `t3.thread.id`) and a value. kitshn refuses a bad label and names it. Labels that no provider vouched for are claims, and History shows them as "claimed".
- **K-1751** A provider vouches for its own agents over its own connection (K-704), so no config lists attesters. An agent carries `KITSHN_ATTEST=<provider>:<token>`, and every agent command sends it. The daemon sends `attest` with the token only to that provider's connection. Known limit: the agents of a provider run as the provider's user, so an agent can register the provider again and vouch for labels of its prefix. Revisit when agents run as their own user, and before any grant depends on such a label.
- **K-1752** The provider answers `attest` within 2 seconds with `active` and at most 16 bare labels. The daemon adds the provider's prefix and marks them "verified by <provider>". A call that carries a token fails closed: no provider connection, a late answer or `active: false` refuses it. It never goes on as the bare machine. A call without a token goes as the bare machine, and a right with a condition refuses it.
- **K-1753** The daemon and kitshn drop every caller label with the prefix of a provider of the machine. Only that provider sets those labels. The prefix `t3.` stays reserved also on a machine without T3.
- **K-1754** A right can have conditions on attested labels: a key equals a value, or is one of a list. kitshn refuses a condition on a prefix that no provider of the machine has. A failed condition refuses the ask and names the condition.
- **K-1755** T3 vouches with `thread.id`, `thread.title`, `project.id`, `project.name`, `environment.id`, `provider`, `runtime`, `interaction`, `subagent`, `thread.parent` and `thread.parent.environment`. Known limits: agents and the T3 server run as one OS user, so an agent that steals the token of another thread acts as that thread. An in-process subagent uses its parent's token, so it has `t3.subagent` = `false`. Revisit when agents run as their own users.
- **K-1756** History is searchable by label: `key=value` in the History view, and `kitshn agent history --label`, at most 50 events. kitshn stores one index row per label, on (key, value, time).

## GitHub tokens

The GitHub App (K-908) needs Contents and Pull requests (read and write) for these rules.

- **K-1760** The GitHub way of an owner is a setting of its owner repo group: "kitshn App token" or "not kitshn". Settings holds the default, "not kitshn" at first. Only kitshn answers "not kitshn", and the daemon keeps no copy. Known limit: kitshn sees the repo name of each ask, also for a "not kitshn" owner.
- **K-1761** "reads code" gives Contents read and Metadata read. "writes code" gives Contents write and Pull requests write, and includes "reads code". "writes code" never deploys (K-1767). No right gives Workflows, Secrets, Administration or Issues. A future right for one of them is its own high-risk right (K-1725).
- **K-1762** `github-token` asks for one repo and "read" or "write". kitshn makes an installation token for that repo only, with the permissions of K-1761. GitHub fixes its life at 1 hour. Rules:
  - kitshn keeps each live token in `github_tokens`, sealed with AES-GCM under a key that HKDF derives from the App private key. `DELETE /installation/token` needs the token itself, so the sealed copy is the one way to revoke it after a sleep. The table is in `SECRET_ROWS` (K-1831).
  - The daemon keeps a token in memory only, until 5 minutes before it expires. It reuses a kept token only for the same repo and the same attested `t3.thread.id`. It drops every kept token on a new connection and on a key rotation.
- **K-1763** `kitshn git-credential` is a git credential helper, which `kitshn setup-git` writes before other helpers. Git never tells a helper push from fetch, so `setup-git` also sets `pushInsteadOf`, and a push carries the user name `kitshn-push`. The helper asks for "write" on a marked push and "read" otherwise. For a "not kitshn" owner, or with no daemon, it prints nothing, so git tries the next helper. For a "kitshn App token" owner, a refusal prints `quit=1`, so git never falls back to the machine's own login. Known limits: a helper that looks up the user name does not answer a marked push, so `setup-git` warns about each one. A remote with its own `pushurl` is not marked.
- **K-1764** `kitshn gh <args>` gets a token for the repo of `--repo` or of the git remote, and runs `gh` with `GH_TOKEN`. It adds nothing else.
- **K-1765** Work with these tokens shows as `kitshn[bot]` on GitHub, so the owner can review agent pull requests. Commits keep the author of the machine's git config.
- **K-1766** An owner without the App gets "the kitshn App is not installed on <owner>" and no token.
- **K-1767** A push or a pull request of the kitshn App bot never deploys by itself. A push waits for a deploy ask (`kitshn agent deploy`), which runs by `workflow_dispatch`. A pull request waits for the owner's "Deploy" in the map panel, which approves that commit only. While kitshn cannot read its bot name, every actor that ends with `[bot]` waits.

## Passes for outside services

kitshn's own actions never use passes (K-1710). Passes stay off until the host move of K-1209 is done. While they are off, `pass` refuses, and the `/.well-known` paths answer "not found". The claims are a public contract in [passes.md](../user/passes.md).

- **K-1770** kitshn is an OpenID issuer, `https://kitshn.<zone>`. The Worker serves exactly `/.well-known/openid-configuration` and `/.well-known/jwks.json` with no login and `max-age=300`. Every other path below `/.well-known/` answers "not found". There is no authorization endpoint, because kitshn gives passes only to machines.
- **K-1771** The pass key is ES256 (P-256), which AWS and Google Cloud accept. The Durable Object makes it and keeps it in its storage, never in a Worker secret. No read path, export, backup, snapshot or History entry includes the private half, and a test checks that. The JWKS lists a retired key for 6 minutes (pass life plus leeway), at most 5 keys. kitshn's own restore to a time rotates the pass key as its last step. After a restore outside kitshn, the owner rotates it at once. Revisit with RS256 for a verifier that refuses ES256.
- **K-1772** A pass is a JWT with `iss`, `aud` (one allowed audience), `sub` `machine:<machine id>`, `iat`, `exp` 5 minutes later, and `jti`. Only when the audience allows labels: `act` from an attested `t3.thread.id`, and `kitshn_labels`. `sub` holds ids only, never names. kitshn only adds claims and never renames or removes one.
- **K-1773** Audiences are a list in Settings, each with its exact address and "labels in passes" (off by default). An agent with "adds audiences" adds one, and removes one that it added at once, because that lowers access. An audience grants nothing by itself: the outside service must also trust kitshn.
- **K-1774** `kitshn agent pass --audience <address>` asks for a pass. It needs "gets passes" and an audience in the list. kitshn stores no `jti`: only the outside service checks the pass. Known limit: a pass is a bearer token for 5 minutes that kitshn cannot revoke. Revisit with DPoP (RFC 9449).
- **K-1775** A pass costs one ask event and reads no row beyond a wake. Discovery and JWKS read no row: the public keys are in memory.

## Budget

- **K-1740** With about 300 agent asks a day, these rules add about 15 Durable Object requests, 50 Worker requests, 300 GitHub API calls and 6,300 rows written (ask events, label index rows and their deletes). Every daily limit stays under 10%. The budget table is in [overview.md](overview.md#free-plan-budget).
