/**
 * The schema of the Durable Object as numbered migrations. Each list runs once, in order, in one
 * transaction with the new version number. Never change a migration that shipped; add a new one.
 */
export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  // 1: the tables of milestones 1 to 3. They use IF NOT EXISTS, because databases from before the
  // migrations have them already.
  [
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS circles (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS share_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    `CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      actor TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT NOT NULL, undoes INTEGER)`,
    "CREATE TABLE IF NOT EXISTS access_objects (key TEXT PRIMARY KEY, cf_id TEXT NOT NULL, body TEXT NOT NULL, tried TEXT NOT NULL, error TEXT)",
    "CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, online INTEGER NOT NULL, last_seen INTEGER NOT NULL)",
    `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT, labels TEXT NOT NULL,
      command TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      actor TEXT NOT NULL, visitor TEXT NOT NULL, exit_code INTEGER, output TEXT NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, expires_at)",
    `CREATE TABLE IF NOT EXISTS join_codes (lookup TEXT PRIMARY KEY, machine_id TEXT NOT NULL, iv TEXT NOT NULL,
      sealed TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS tunnel_objects (machine_id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT)",
    `CREATE TABLE IF NOT EXISTS live_sites (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, name TEXT NOT NULL,
      address TEXT NOT NULL, target TEXT NOT NULL, dev INTEGER NOT NULL, up INTEGER NOT NULL, last_up INTEGER NOT NULL,
      state TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS dns_objects (address TEXT PRIMARY KEY, record_id TEXT NOT NULL, content TEXT NOT NULL, error TEXT)",
    "CREATE TABLE IF NOT EXISTS route_objects (address TEXT PRIMARY KEY, route_id TEXT NOT NULL, error TEXT)",
    `CREATE TABLE IF NOT EXISTS deploys (id TEXT PRIMARY KEY, repo TEXT NOT NULL, environment TEXT NOT NULL,
      resource_id TEXT NOT NULL, address TEXT NOT NULL, script TEXT NOT NULL, starts_in TEXT, kind TEXT NOT NULL,
      sha TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, branch TEXT NOT NULL DEFAULT '')`,
  ],
  // 2: the removal order of K-006. A tunnel row keeps the ingress that Cloudflare last accepted, and a
  // failed write waits five minutes, not a day, before the next try.
  [
    "ALTER TABLE tunnel_objects ADD COLUMN applied TEXT NOT NULL DEFAULT ''",
    "UPDATE tunnel_objects SET applied = body WHERE error IS NULL",
    "ALTER TABLE tunnel_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dns_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE route_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
  ],
  // 3: pages and files in R2 (sections 10 and 11). `source` names where an imported page came from, so
  // an import adds each page once (K-1008).
  [
    `CREATE TABLE library (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, file_name TEXT,
      thread TEXT, machine TEXT, size INTEGER NOT NULL, content_type TEXT NOT NULL, created_at INTEGER NOT NULL,
      source TEXT UNIQUE)`,
    "CREATE TABLE library_deleted (source TEXT PRIMARY KEY)",
  ],
  // 4: Compose deploys (K-812) run as a job on one machine.
  [
    "ALTER TABLE deploys ADD COLUMN app TEXT NOT NULL DEFAULT 'static'",
    "ALTER TABLE deploys ADD COLUMN machine_id TEXT",
    "ALTER TABLE deploys ADD COLUMN job_id INTEGER",
    "ALTER TABLE deploys ADD COLUMN compose_file TEXT",
  ],
  // 5: stacks that the owner makes (K-521).
  ["CREATE TABLE stacks (id TEXT PRIMARY KEY, body TEXT NOT NULL)"],
  // 6: the repo gate (K-819), by GitHub repository id. The Durable Object then fills `deploys.repo_id` of
  // older rows (backfillRepoIds), because the id comes out of the card id with code.
  [
    `CREATE TABLE repos (repo_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting', 'allowed', 'blocked')), first_seen INTEGER NOT NULL, branch TEXT)`,
    "ALTER TABLE deploys ADD COLUMN repo_id TEXT",
  ],
  // 7: the audience tag of each Access application, for the Access check on tunnel ingress (K-603).
  ["ALTER TABLE access_objects ADD COLUMN aud TEXT NOT NULL DEFAULT ''"],
  // 8: the agent key that allowed a repo (K-718, K-819); null when the owner allowed it.
  [
    "ALTER TABLE repos ADD COLUMN allowed_by_client TEXT",
    "ALTER TABLE repos ADD COLUMN allowed_by_name TEXT",
  ],
  // 9: the one-time codes of "Reset key" (K-1706). They hold no secret, unlike join codes.
  [
    "CREATE TABLE rekey_codes (lookup TEXT PRIMARY KEY, machine_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ],
  // 10: the revision that a per-item undo reverses (K-1507); moves never join such an undo (K-1505).
  ["ALTER TABLE revisions ADD COLUMN item_undo INTEGER"],
  // 11: card icons. A static site keeps one small icon (K-1113); a machine keeps the system of its last status
  // (K-524), so its card keeps the icon while it is offline.
  [
    "CREATE TABLE icons (id TEXT PRIMARY KEY, type TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL)",
    "ALTER TABLE presence ADD COLUMN os TEXT",
  ],
  // 12: what GitHub said about each repo id (K-819): when kitshn last asked, and since when the repo is gone.
  ["ALTER TABLE repos ADD COLUMN checked_at INTEGER", "ALTER TABLE repos ADD COLUMN gone_at INTEGER"],
  // 13: when each icon last changed; a daemon changes the icon of a site at most once an hour (K-1114).
  ["ALTER TABLE icons ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0"],
  // 14: every address that serves an environment, the main one first, as JSON (K-817). Null on older rows means
  // the one address of the row.
  ["ALTER TABLE deploys ADD COLUMN addresses TEXT"],
  // 15: the card that made each DNS record (K-817); null on older rows, which then count as another card's.
  ["ALTER TABLE dns_objects ADD COLUMN card_id TEXT"],
  // 16: Worker apps (K-806). A deploy keeps the `worker` part of its recipe as JSON, so later steps use the planned
  // recipe. `worker_storage` holds the KV namespace of each binding (`kv`), and the script that "Remove app" kept
  // (`script`, with the script name as cf_id), so a removed app has a way to delete them (K-909).
  [
    "ALTER TABLE deploys ADD COLUMN worker TEXT",
    `CREATE TABLE worker_storage (card_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('kv', 'script')),
      name TEXT NOT NULL, cf_id TEXT NOT NULL, PRIMARY KEY (card_id, kind, name))`,
  ],
  // 17: several apps per repo (K-804) and their order (K-820). `app_key` is the app of the deploy; older rows are
  // the app `app`. `state` also takes 'failed' and 'skipped', with `reason`. `version_id` (the Cloudflare version of a
  // static or Worker deploy) and the run keep what a later rollback needs.
  [
    "ALTER TABLE deploys ADD COLUMN app_key TEXT NOT NULL DEFAULT 'app'",
    "ALTER TABLE deploys ADD COLUMN reason TEXT",
    "ALTER TABLE deploys ADD COLUMN version_id TEXT",
    "ALTER TABLE deploys ADD COLUMN run_id TEXT",
    "ALTER TABLE deploys ADD COLUMN run_attempt TEXT",
    // The card panel reads the newest deploy of each card (deployNotes), and deploy rows never go away.
    "CREATE INDEX deploys_resource ON deploys (resource_id)",
  ],
  // 18: rollback (K-821). `images` holds the image id of each service of a Compose deploy that came up; `needs` the
  // keys of `needs.apps`, so a run rolls back in its own order. `origin` is the deploy whose build a rollback row
  // repeats, the id that the daemon keeps it by. `rollbacks` holds the steps of a run rollback and the job it waits for.
  [
    "ALTER TABLE deploys ADD COLUMN images TEXT",
    "ALTER TABLE deploys ADD COLUMN needs TEXT",
    "ALTER TABLE deploys ADD COLUMN origin TEXT",
    `CREATE TABLE rollbacks (id TEXT PRIMARY KEY, steps TEXT NOT NULL, next INTEGER NOT NULL, state TEXT NOT NULL,
      actor TEXT NOT NULL, notes TEXT NOT NULL, job_id INTEGER)`,
  ],
  // 19: the workflow file of the run that waits at the repo gate, which Allow starts again, and of the run of each
  // deploy, which a restore from the trash and an agent key build start again (K-1121).
  ["ALTER TABLE repos ADD COLUMN workflow TEXT", "ALTER TABLE deploys ADD COLUMN workflow TEXT"],
  // 20: the badge reads the newest deploy of a repo by name in any case (K-1119); anyone can ask for any name.
  ["CREATE INDEX deploys_badge ON deploys (lower(repo), app_key, environment)"],
  // 21: agent uploads (K-1116, K-1117). `added_by` is the client id of the agent key that published a page or a file;
  // only that key updates it by name. R2 keeps two slots of an item (`slotKey`); `current_slot` names the one that
  // serves, with `size` and `content_type`. `previous_size` and `previous_type` describe the bytes of the other slot,
  // the one previous version, and are null when the item has none. `agent_tray` is 1 while a card has waited in the
  // tray since its key published it; the first move or share, or any change by the owner, sets it to 0.
  [
    "ALTER TABLE library ADD COLUMN added_by TEXT",
    "ALTER TABLE library ADD COLUMN current_slot INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE library ADD COLUMN agent_tray INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE library ADD COLUMN previous_size INTEGER",
    "ALTER TABLE library ADD COLUMN previous_type TEXT",
  ],
  // 22: address names of pages and files (K-1120). A row stays when its item gets a new name, so the old name sends
  // visitors on and no other item takes it; the delete of the item removes its rows.
  [
    "CREATE TABLE library_addresses (kind TEXT NOT NULL, name TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (kind, name))",
    "CREATE INDEX library_addresses_item ON library_addresses (item_id)",
  ],
  // 23: folder sites (K-1123), a static site that an agent key publishes from a folder, with no repo. `circle` and
  // `public` are where the first publish lands; `agent_tray` works as for pages (K-1117).
  [
    `CREATE TABLE agent_sites (card_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, folder TEXT NOT NULL,
     address TEXT NOT NULL, circle TEXT, public INTEGER NOT NULL DEFAULT 0, agent_tray INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
     UNIQUE (client_id, folder))`,
  ],
  // 24: old site addresses (K-817, K-1124). Each one sends its visitors on to the main address of its card through the
  // kitshn-redirects Worker; the rowid orders them, and a card keeps its 5 newest (K-1122).
  // `attached` is 1 while the custom domain is on the redirect Worker, so its Access application stays until it goes.
  [
    "CREATE TABLE old_addresses (address TEXT PRIMARY KEY, card_id TEXT NOT NULL, attached INTEGER NOT NULL DEFAULT 0)",
  ],
  // 25: uptime (K-1125, K-1126). One row of state per card, written only on change, and each change from up to down
  // or back, kept 30 days.
  [
    "CREATE TABLE uptime (card_id TEXT PRIMARY KEY, up INTEGER NOT NULL, failing_since INTEGER, since INTEGER NOT NULL)",
    "CREATE TABLE uptime_changes (card_id TEXT NOT NULL, at INTEGER NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (card_id, at))",
  ],
  // 26: notifications (K-1901, K-1905). A key that opens again gets a new row, so the view keeps each time; the
  // partial index lets the reconcile after each change read only the open rows (K-1906).
  [
    `CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, key TEXT NOT NULL,
     card_id TEXT, recipients TEXT NOT NULL, level TEXT NOT NULL, priority TEXT NOT NULL, title TEXT NOT NULL,
     text TEXT NOT NULL, actions TEXT NOT NULL, state TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER,
     snoozed_until INTEGER, episode TEXT NOT NULL)`,
    "CREATE UNIQUE INDEX notifications_open ON notifications (source, key) WHERE closed_at IS NULL",
    "CREATE TABLE notification_mutes (card_id TEXT NOT NULL, source TEXT NOT NULL, until INTEGER, PRIMARY KEY (card_id, source))",
  ],
  // 27: one row per backup run of a Compose card (K-1819); the card panel reads the newest of each card.
  [
    `CREATE TABLE backups (run TEXT PRIMARY KEY, card TEXT NOT NULL, machine_id TEXT NOT NULL, at INTEGER NOT NULL,
      state TEXT NOT NULL, bytes INTEGER, added INTEGER, error TEXT, job_id INTEGER, sources TEXT,
      pause_ms INTEGER)`,
    "CREATE INDEX backups_card ON backups (card, at)",
    // K-1819: when the daily run first saw that a card with backups was gone; its repository goes 7 days later.
    "CREATE TABLE backup_gone (card TEXT PRIMARY KEY, since INTEGER NOT NULL)",
  ],
  // 28: make it a repo (K-1127). A handover lets the first push deploy of one repo take over a page or a folder site
  // card for an hour; `repo_cards` then keeps that card for every later deploy of the repo, its app and environment.
  [
    `CREATE TABLE handovers (repo_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, repo TEXT NOT NULL,
     card_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, client_name TEXT NOT NULL, address TEXT NOT NULL,
     expires_at INTEGER NOT NULL)`,
    `CREATE TABLE repo_cards (repo_id TEXT NOT NULL, app_key TEXT NOT NULL, environment TEXT NOT NULL,
     card_id TEXT NOT NULL UNIQUE, PRIMARY KEY (repo_id, app_key, environment))`,
  ],
  // 29: Web Push subscriptions (K-1907), one row per browser of a person. `levels` is a JSON list; the quiet hours
  // are minutes after midnight in `time_zone`, or all null.
  [
    `CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL UNIQUE,
     p256dh TEXT NOT NULL, auth TEXT NOT NULL, email TEXT NOT NULL, label TEXT NOT NULL, levels TEXT NOT NULL,
     quiet_start INTEGER, quiet_end INTEGER, time_zone TEXT, created_at INTEGER NOT NULL, last_ok_at INTEGER)`,
  ],
  // 30: section 17. A proposal is an ask that waits for its approver circle (K-1722); `body` and `labels` are JSON,
  // and one conditional update moves `state` from pending (K-1723). Ask events are the History of asks (K-1717): not
  // revisions, with their own cap.
  [
    `CREATE TABLE proposals (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      body TEXT NOT NULL, reason TEXT, labels TEXT NOT NULL, right_name TEXT NOT NULL, circle_id TEXT NOT NULL,
      shown TEXT NOT NULL, shown_hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER,
      decided_by TEXT, result TEXT, verified TEXT NOT NULL DEFAULT '[]')`,
    "CREATE INDEX proposals_state ON proposals (state, expires_at)",
    "CREATE INDEX proposals_machine ON proposals (machine_id, state)",
    `CREATE TABLE ask_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, machine_id TEXT NOT NULL,
      action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT, labels TEXT NOT NULL, outcome TEXT NOT NULL,
      detail TEXT NOT NULL, verified TEXT NOT NULL DEFAULT '[]')`,
    "CREATE INDEX ask_events_machine ON ask_events (machine_id, id)",
    // K-1756: one row for each label of an ask event, so a search by key=value reads at most its 50 rows.
    "CREATE TABLE ask_labels (event_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL)",
    "CREATE INDEX ask_labels_search ON ask_labels (key, value, event_id)",
    "CREATE INDEX ask_labels_event ON ask_labels (event_id)",
    // K-1762: the App installation of each GitHub owner, so a token costs one GitHub call.
    "CREATE TABLE github_installations (owner TEXT PRIMARY KEY, installation_id INTEGER NOT NULL)",
    // K-1771: the pass keys; backups and the state export leave this table out. K-1773: the pass audiences.
    `CREATE TABLE pass_keys (kid TEXT PRIMARY KEY, private_jwk TEXT NOT NULL, public_jwk TEXT NOT NULL,
      created_at INTEGER NOT NULL, retired_at INTEGER)`,
    // K-1767: a run of a pull request of the kitshn App that waits for the owner's Deploy, by repo, pull request and
    // the commit of the run; an approval counts for that commit only.
    `CREATE TABLE bot_runs (repo_id TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL,
      run_id TEXT NOT NULL, at INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (repo_id, pr, sha))`,
    "CREATE TABLE pass_audiences (address TEXT PRIMARY KEY, labels INTEGER NOT NULL, added_by TEXT, added_at INTEGER NOT NULL)",
    // K-1716: the live GitHub tokens, so a reset, a removal, the pause or a lost right revokes them after a sleep.
    // `sealed` is the token under a key from a Worker secret (github.ts); backups leave the table out.
    `CREATE TABLE github_tokens (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, repo TEXT NOT NULL,
      right_name TEXT NOT NULL, expires_at INTEGER NOT NULL, sealed TEXT NOT NULL)`,
  ],
  // 31: redirect addresses (K-1128). `pinned` marks an old address that the owner or a key added by hand: it counts
  // toward the 5 of K-1122 but no rename pushes it out. `going` marks one that is being removed, which keeps its Access
  // application until its custom domain left the redirect Worker (K-410).
  [
    "ALTER TABLE old_addresses ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE old_addresses ADD COLUMN going INTEGER NOT NULL DEFAULT 0",
  ],
  // 32: notify tokens of app cards (K-1908): only the SHA-256 of each token, the newest 6 live ones per card.
  // `pending` names the deploy or job that the token waits on; it turns live (null) only when that one succeeds.
  [
    "CREATE TABLE notify_tokens (hash TEXT PRIMARY KEY, card_id TEXT NOT NULL, created_at INTEGER NOT NULL, pending TEXT)",
    "CREATE INDEX notify_tokens_card ON notify_tokens (card_id, created_at)",
  ],
  // 33: the nonces of calls that daemons forwarded in the last minute (K-1714), with the time that the daemon signed,
  // so a copied call does not run twice, also after a restart. Each forward deletes the rows older than its window.
  ["CREATE TABLE forward_nonces (nonce TEXT PRIMARY KEY, at INTEGER NOT NULL)"],
  // 34: where a whole-revision Undo came from (K-1509): its toast, History, or the HTTP API; null before.
  ["ALTER TABLE revisions ADD COLUMN undo_source TEXT"],
  // 35: the providers of each machine (K-704): the kinds and commands of their last registration, as JSON. Their
  // cards are rows of `resources`.
  [
    "CREATE TABLE providers (machine_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (machine_id, name))",
    // "Forget provider": until the daemon drops it, kitshn ignores its offline reports and tells the daemon again.
    "CREATE TABLE forgotten_providers (machine_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (machine_id, name))",
  ],
  // 36: the end time of each timed card (K-212), in milliseconds, and who set it as a JSON actor: the end runs as
  // that actor, so its Undo works (K-1506). Null when an undo brought the time back.
  ["CREATE TABLE card_ends (id TEXT PRIMARY KEY, ends_at INTEGER NOT NULL, set_by TEXT)"],
  // 37: section 20. A game card (K-2001) with the last public addresses of its machine, so its records stay while the
  // machine is offline; the open doors (K-2005) with the address that opened each (K-2006); and the A, AAAA and SRV records that kitshn made for it (K-2008).
  [
    `CREATE TABLE games (card_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, ports TEXT NOT NULL,
      door_ms INTEGER NOT NULL, srv TEXT, relay_id TEXT, v4 TEXT, v6 TEXT)`,
    `CREATE TABLE doors (card_id TEXT NOT NULL, person TEXT NOT NULL, address TEXT NOT NULL, opened_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL, seen_ip TEXT, PRIMARY KEY (card_id, person, address))`,
    `CREATE TABLE game_records (type TEXT NOT NULL, name TEXT NOT NULL, card_id TEXT NOT NULL, content TEXT NOT NULL,
      record_id TEXT NOT NULL, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (type, name))`,
  ],
  // 38: provider state. The desired state of each kind (K-709), with "" as the machine of the shared part; card
  // settings (K-717), outside the card body that each report rewrites; the last push that each machine applied
  // (K-1608); and jobs that wait until no provider of their machine is busy (K-613).
  [
    "CREATE TABLE desired_state (kind TEXT NOT NULL, machine_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, machine_id))",
    "CREATE TABLE card_settings (card_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (card_id, key))",
    "CREATE TABLE applied_state (machine_id TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (machine_id, key))",
    "ALTER TABLE jobs ADD COLUMN when_idle INTEGER NOT NULL DEFAULT 0",
  ],
  // 39: the cross-machine work that source machines report (K-1610): exec runs and forwarded tool calls, never their
  // arguments or output. Events, not revisions; 30 days, at most 2,000.
  [
    `CREATE TABLE link_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL,
      target TEXT NOT NULL, kind TEXT NOT NULL, thread TEXT, name TEXT NOT NULL, cwd TEXT, outcome TEXT NOT NULL,
      exit_code INTEGER)`,
  ],
  // 40: device invites (K-1601). The lookup of the one-time code and the token it opens; never the code or a secret.
  [
    `CREATE TABLE device_invites (lookup TEXT PRIMARY KEY, token_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
      name TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  ],
  // 41: the rights that an Owner or circle approval of a forwarded folder site plan or handover gave (K-1776), as JSON,
  // so the files, the finish and the first deploy count them; and when a forwarded call used its approval (K-1714).
  [
    "ALTER TABLE deploys ADD COLUMN approved TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE proposals ADD COLUMN used_at INTEGER",
    "ALTER TABLE handovers ADD COLUMN approved TEXT NOT NULL DEFAULT '[]'",
  ],
  // 42: provider protocol 2. The exec runs that kitshn relays (K-722), so an evicted Durable Object finds each run
  // again, and the rev of the last set of each desired state (K-709). Its code step moves each `t3.agents` share to
  // the `t3.app` card of the same machine, once, by its own mark in `meta`.
  [
    `CREATE TABLE exec_runs (exec_id TEXT PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL, provider TEXT,
      command TEXT NOT NULL, cwd TEXT, thread TEXT, proposal_id TEXT, state TEXT NOT NULL, started_at INTEGER NOT NULL)`,
    "CREATE TABLE desired_revs (kind TEXT PRIMARY KEY, rev TEXT NOT NULL)",
  ],
  // 43: section 20 is "Ports" (K-2001): the kind `game` becomes `port`, and its tables follow the name.
  [
    "ALTER TABLE games RENAME TO port_cards",
    "ALTER TABLE game_records RENAME TO port_records",
    `UPDATE resources SET body = json_set(body, '$.kind', 'port') WHERE json_extract(body, '$.kind') = 'game'`,
  ],
  // 44: actors (K-1778). Its code step (`migrateMembers`) turns the email, device and machine members of each circle into
  // actors and their chips, once, in the transaction of the migration. The circle bodies of before stay in
  // `circles_before_actors`, so an owner can go back by hand to a kitshn of before it.
  [
    "CREATE TABLE circles_before_actors (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "INSERT INTO circles_before_actors (id, body) SELECT id, body FROM circles",
    "CREATE TABLE actors (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    // The actor that a device invite adds its token to; null makes a new actor of the token (K-1601).
    "ALTER TABLE device_invites ADD COLUMN actor_id TEXT",
  ],
  // 45: a proposal belongs to the credential that asked (K-1778): `machine/<id>`, `token/<id>` or `login/<email>`. A
  // token actor has no machine, so its `machine_id` is empty. The credential never approves its own ask. A call that the
  // Owner decides now asks for the right "raises access" (K-1778), not "owner".
  [
    "ALTER TABLE proposals ADD COLUMN credential TEXT NOT NULL DEFAULT ''",
    "UPDATE proposals SET credential = 'machine/' || machine_id",
    "CREATE INDEX proposals_credential ON proposals (credential, state)",
    "UPDATE proposals SET right_name = 'raisesAccess' WHERE right_name = 'owner'",
  ],
  // 46: effects (K-1730). Its code step (`migrateRights`) moves the rights of each chip, the proposals and the approvals
  // of deploys and handovers to effects, once, in the transaction of the migration. A queued job keeps the approval of
  // its call with the right names of before, so it fails, and the caller sends it again.
  [
    "UPDATE github_tokens SET right_name = CASE right_name WHEN 'writesCode' THEN 'changes' ELSE 'reads' END",
    `UPDATE jobs SET state = 'failed', output = 'kitshn moved to effects; send the job again (K-1730)'
      WHERE state = 'queued' AND json_extract(visitor, '$.ownerApproved') IS NOT NULL`,
  ],
  // 47: placement (K-823). `compose` keeps the `compose` part of the recipe as JSON, so the drift of K-825 reads its
  // labels and placement. `deploy_instances` holds the job of each instance of a deploy beyond the home one (K-827);
  // `deferred` marks a machine that was offline at plan time, whose job the deploy does not wait for.
  [
    "ALTER TABLE deploys ADD COLUMN compose TEXT",
    `CREATE TABLE deploy_instances (deploy_id TEXT NOT NULL, machine_id TEXT NOT NULL, address TEXT NOT NULL,
      job_id INTEGER, deferred INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (deploy_id, machine_id))`,
    "CREATE INDEX deploy_instances_job ON deploy_instances (job_id)",
    // K-827: the repository of an instance that is not the home one; null for the card's own repository.
    "ALTER TABLE backups ADD COLUMN repository TEXT",
  ],
];

/** K-819: the migration after which the Durable Object derives the repo ids of older deploy rows. */
export const REPO_GATE_MIGRATION = 6;
/** K-722: the migration after which the `t3.agents` kind is gone; an import from before it runs the code step. */
export const AGENTS_MIGRATION = 42;
/** K-1778: the migration of the actors; a database or an import from before it runs `migrateMembers`. */
export const ACTORS_MIGRATION = 44;
/** K-1730: the migration of the effects; a database or an import from before it runs `migrateRights`. */
export const EFFECTS_MIGRATION = 46;

/**
 * Runs the migrations after `from`, up to `to` (K-1833 stops at the schema of an export). Returns the new version.
 * The caller provides the transaction.
 */
export function migrate(exec: (query: string) => void, from: number, to = MIGRATIONS.length): number {
  if (from > MIGRATIONS.length) {
    throw new Error(
      `The database has schema version ${from}, newer than this kitshn (${MIGRATIONS.length}).`,
    );
  }
  for (let version = from + 1; version <= to; version++) {
    for (const query of MIGRATIONS[version - 1] ?? []) exec(query);
    exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${version}')`);
  }
  return to;
}
