import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { ADMIN_RESOURCE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

interface Kitshn {
  sql(
    query: string,
    ...bindings: Array<string | number | null>
  ): Array<Record<string, string | number | null>>;
  load(): void;
  broadcast(): void;
}

const deploy = (kitshn: Kitshn, id: string, state: string, reason: string | null) =>
  kitshn.sql(
    `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at, reason)
     VALUES (?, 'o/shop', 'prod', 'shop', 'shop.example.com', 'kitshn-shop', 'deploy', 'abc', ?, 0, ?)`,
    id,
    state,
    reason,
  );

it("opens a deploy notification when the newest deploy fails, and closes it after a good one (K-1904)", async () => {
  const stub = env.KITSHN.getByName("kitshn");
  const rows = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn;
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn.sql("SELECT state, title, text FROM notifications WHERE source = 'deploy' ORDER BY id");
    deploy(kitshn, "d1", "failed", "The build failed.");
    kitshn.broadcast();
    kitshn.broadcast();
    const failed = read();
    deploy(kitshn, "d2", "done", null);
    kitshn.broadcast();
    return { failed, after: read() };
  });
  expect(rows.failed).toEqual([{ state: "open", title: "Deploy of shop failed", text: "The build failed." }]);
  expect(rows.after.map((row) => row.state)).toEqual(["closed"]);
});

it("opens an uptime notification while a card is down, and closes it when it is up (K-1904)", async () => {
  const stub = env.KITSHN.getByName("notify-uptime");
  const states = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn & { uptimeCache: unknown };
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn.sql("SELECT state FROM notifications WHERE source = 'uptime'").map((row) => row.state);
    kitshn.sql("INSERT INTO uptime (card_id, up, failing_since, since) VALUES ('shop', 0, NULL, 1)");
    kitshn.uptimeCache = null;
    kitshn.broadcast();
    const down = read();
    kitshn.sql("DELETE FROM uptime WHERE card_id = 'shop'");
    kitshn.uptimeCache = null;
    kitshn.broadcast();
    return { down, up: read() };
  });
  expect(states).toEqual({ down: ["open"], up: ["closed"] });
});

it("keeps a dismissed notification closed for its episode, and opens a new one for the next (K-1905)", async () => {
  const stub = env.KITSHN.getByName("notify-dismiss");
  const states = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn & {
      setNotificationState(source: string, key: string, state: string): void;
    };
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn
        .sql("SELECT state FROM notifications WHERE source = 'deploy' ORDER BY id")
        .map((row) => row.state);
    deploy(kitshn, "d1", "failed", "The build failed.");
    kitshn.broadcast();
    kitshn.setNotificationState("deploy", "shop", "dismissed");
    // The same failed deploy is still the newest, so nothing opens again.
    kitshn.broadcast();
    const dismissed = read();
    deploy(kitshn, "d2", "failed", "The build failed again.");
    kitshn.broadcast();
    return { dismissed, next: read() };
  });
  expect(states).toEqual({ dismissed: ["dismissed"], next: ["dismissed", "open"] });
});

it("refuses a mute of a card that does not exist or of an unknown source (K-1905)", async () => {
  stubAccessCerts();
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    "content-type": "application/json",
  };
  const mute = (body: object) =>
    send("/api/notifications/mute", { method: "POST", headers, body: JSON.stringify(body) });
  expect((await mute({ card: "no-such-card", source: "deploy", until: null })).status).toBe(400);
  expect((await mute({ card: ADMIN_RESOURCE_ID, source: "anything", until: null })).status).toBe(400);
});

it("runs the later alarm steps when one throws, skips it with backoff, and tells the owner until it works (K-406, K-1910)", async () => {
  const stub = env.KITSHN.getByName("alarm-steps");
  // An hour after the real time, taken before Date.now is mocked: the storage alarm keeps the real clock and moves an
  // alarm in the past to now, so a fixed date fails once the real clock passes it.
  const t0 = Math.ceil(Date.now() / 1000) * 1000 + 60 * 60_000;
  const result = await runInDurableObject(stub, async (instance, state) => {
    const kitshn = instance as unknown as Kitshn & Record<string, unknown> & { alarm(): Promise<void> };
    let clock = t0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The daily run and the backups are far away, so only the steps set the next alarm.
    for (const key of ["daily_at", "backup_at"])
      kitshn.sql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, String(t0 + 86_400_000));
    // K-406, K-409: a timed card ends while the Access step waits (below), and that change runs Access at once.
    const timer: Resource = {
      id: "timer",
      // A Compose card that no machine serves, so uptime fetches nothing.
      kind: "site.compose",
      name: "timer",
      addresses: ["timer.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('timer', ?)", JSON.stringify(timer));
    kitshn.sql("INSERT INTO places (id, x, y) VALUES ('timer', 0, 0)");
    kitshn.sql("INSERT INTO card_ends (id, ends_at) VALUES ('timer', ?)", t0 + 16.5 * 60_000);
    kitshn.load();
    let ran: Array<string> = [];
    const fails = new Set(["syncPortDns"]);
    kitshn["api"] = () => async () => [];
    // PortCard records wait, as on 2026-10-29: this work woke the alarm at once while the step threw.
    kitshn["portDnsWork"] = () => true;
    const step = (name: string, calls: number) => async () => {
      ran.push(name);
      if (fails.has(name)) throw new Error("zonePath takes one label.");
      return calls;
    };
    for (const name of ["fillAudiences", "refreshForeignPaths", "syncTunnels", "checkSites", "syncDns"])
      kitshn[name] = step(name, 0);
    kitshn["syncPortDns"] = step("syncPortDns", 4);
    kitshn["syncRoutes"] = step("syncRoutes", 0);
    kitshn["syncRedirects"] = step("syncRedirects", 0);
    kitshn["syncLauncher"] = step("syncLauncher", 0);
    kitshn["syncBic"] = step("syncBic", 0);
    let accessBudget = 0;
    kitshn["syncAccessLocked"] = async (_api: unknown, budget: number) => {
      ran.push("syncAccessLocked");
      if (fails.has("syncAccessLocked")) throw new Error("Cloudflare answered 503.");
      accessBudget = budget;
    };
    const read = () => kitshn.sql("SELECT key, state FROM notifications WHERE source = 'alarm' ORDER BY id");
    const run = async (at: number) => {
      clock = at;
      ran = [];
      await kitshn.alarm();
      return { ran, accessBudget, alarm: await state.storage.getAlarm() };
    };
    const failed = { ...(await run(t0)), rows: read() };
    const skipped = await run(t0 + 1_000);
    const again = await run(t0 + 5 * 60_000);
    fails.clear();
    const works = await run(t0 + 15 * 60_000);
    const rows = read();
    fails.add("syncAccessLocked");
    await run(t0 + 16 * 60_000);
    fails.clear();
    const ended = await run(t0 + 17 * 60_000);
    return { failed, skipped, again, works, rows, ended, endedRows: read() };
  });
  const later = [
    "syncRoutes",
    "syncRedirects",
    "syncLauncher",
    "syncAccessLocked",
    "syncLauncher",
    "syncBic",
  ];
  const before = ["fillAudiences", "refreshForeignPaths", "syncTunnels", "checkSites", "syncDns"];
  expect(result.failed.ran).toEqual([...before, "syncPortDns", ...later]);
  // The failed step counts its whole budget of 4, so Access keeps 40 - 4 - 16 - 3 - 4 (K-412).
  expect(result.failed.accessBudget).toBe(13);
  expect(result.failed.rows).toEqual([{ key: "port card DNS", state: "open" }]);
  // The next second sends the push of the new notification (K-1907).
  expect(result.failed.alarm).toBe(t0 + 1_000);
  // Until its retry time the step is skipped, spends nothing, and its waiting records wake no alarm.
  expect(result.skipped.ran).toEqual([...before, ...later]);
  expect(result.skipped.accessBudget).toBe(17);
  expect(result.skipped.alarm).toBe(t0 + 5 * 60_000);
  // The second failure waits twice as long.
  expect(result.again.ran).toContain("syncPortDns");
  expect(result.again.alarm).toBe(t0 + 15 * 60_000);
  expect(result.works.ran).toContain("syncPortDns");
  expect(result.rows).toEqual([{ key: "port card DNS", state: "closed" }]);
  // The end of the card is a map change, so the waiting Access step runs in the same alarm and closes.
  expect(result.ended.ran).toContain("syncAccessLocked");
  expect(result.endedRows).toEqual([
    { key: "port card DNS", state: "closed" },
    { key: "Access", state: "closed" },
  ]);
});

it("opens a notification for a repo that waits for Allow, whose Allow runs from the notification (K-819, K-1903)", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  const id = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn;
    kitshn.sql(
      "INSERT INTO repos (repo_id, name, state, first_seen, branch) VALUES ('77', 'o/waits', 'waiting', 1, NULL)",
    );
    kitshn.broadcast();
    const [row] = kitshn.sql(
      "SELECT id, actions FROM notifications WHERE source = 'repo' AND state = 'open'",
    );
    return row;
  });
  expect(JSON.parse(String(id?.["actions"]))).toContainEqual({ id: "allow", label: "Allow", kind: "run" });
  const answer = await send(`/api/notifications/${id?.["id"]}/actions/allow`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(answer.status, await answer.clone().text()).toBe(200);
  const after = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn;
    return {
      repo: kitshn.sql("SELECT state FROM repos WHERE repo_id = '77'")[0]?.["state"],
      notification: kitshn.sql("SELECT state FROM notifications WHERE source = 'repo'")[0]?.["state"],
    };
  });
  expect(after).toEqual({ repo: "allowed", notification: "closed" });
});
