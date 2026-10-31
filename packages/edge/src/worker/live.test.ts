import { escapeHtml } from "../core/html.ts";
import { describe, expect, it } from "vitest";
import type { PolicyBody } from "../core/access.ts";
import type { AccessRow } from "./access-sync.ts";
import {
  type AccessAppListing,
  foreignHolds,
  foreignPaths,
  ingressPath,
  ATTACHMENT_BUDGET,
  cloneBytes,
  fitAttachment,
  type IngressAccess,
  type LiveSite,
  wantedRecords,
  ingressAccess,
  liveSiteId,
  offlineReason,
  parseSites,
  reachableAddresses,
  addressRecords,
  dnsRecordRefusal,
  nextCardAddresses,
  protectedLiveSites,
  seenText,
  servedSites,
  sitesNeedingRoutes,
  tunnelConfig,
} from "./live.ts";

const site = (name: string, machineId: string, up: boolean, dev = false): LiveSite => ({
  id: `live-${machineId}-${name}`,
  machineId,
  name,
  address: `${name}.example.com`,
  target: "http://localhost:5173",
  dev,
  up,
  lastUp: 0,
  state: "ok",
});

const bypass: IngressAccess = { kind: "bypass" };

const policyRow = (key: string, cfId: string, decision: PolicyBody["decision"]): [string, AccessRow] => [
  key,
  { key, cfId, aud: "", body: JSON.stringify({ decision }), tried: "", error: null },
];

/** An application row; `body` is what Cloudflare accepted, `tried` an update that did not land yet. */
const appRow = (key: string, policyIds: Array<string>, aud: string, body?: string): [string, AccessRow] => {
  const accepted = JSON.stringify({ policies: policyIds.map((id) => ({ id })) });
  return [key, { key, cfId: `cf-${key}`, aud, body: body ?? accepted, tried: accepted, error: null }];
};

describe("live sites (K-1104 to K-1108)", () => {
  it("routes each site through the tunnel, with Host localhost for a dev server", () => {
    expect(
      tunnelConfig([site("b", "m", true, true), site("a", "m", true)], () => bypass).config.ingress,
    ).toEqual([
      { hostname: "a.example.com", service: "http://localhost:5173" },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: { httpHostHeader: "localhost" },
      },
      { service: "http_status:404" },
    ]);
  });

  it("makes cloudflared check the Access JWT of the application (K-603)", () => {
    const access = new Map<string, IngressAccess>([
      ["a", { kind: "check", teamName: "team", aud: "aud-a" }],
      ["b", { kind: "check", teamName: "team", aud: "aud-b" }],
    ]);
    const sites = [site("a", "m", true), site("b", "m", true, true)];
    expect(tunnelConfig(sites, (item) => access.get(item.name)!).config.ingress).toEqual([
      {
        hostname: "a.example.com",
        service: "http://localhost:5173",
        originRequest: { access: { required: true, teamName: "team", audTag: ["aud-a"] } },
      },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: {
          httpHostHeader: "localhost",
          access: { required: true, teamName: "team", audTag: ["aud-b"] },
        },
      },
      { service: "http_status:404" },
    ]);
  });

  it("keeps the paths of other applications on a taken address with their own check, ahead of the host (K-1623)", () => {
    const app = (name: string, aud: string, hosts: Array<string>, decision = "allow"): AccessAppListing => ({
      name,
      domain: hosts[0]!,
      aud,
      self_hosted_domains: hosts,
      policies: [{ decision }],
    });
    const portal = app("T3 Code servers", "aud-portal", ["b.example.com", "a.example.com"]);
    const apps = [
      app("kitshn T3 on a", "aud-a", ["a.example.com/*"]),
      app("t3 web build", "aud-build", ["a.example.com/assets/*", "a.example.com/favicon.ico"], "bypass"),
      app("t3 guest links", "aud-guest", ["a.example.com/guest", "a.example.com/api/guest/*"]),
      app("other host", "aud-c", ["c.example.com/x"]),
    ];
    expect(foreignPaths([portal, ...apps], "a.example.com")).toEqual([
      { path: "/api/guest/*", aud: "aud-guest" },
      { path: "/favicon.ico", aud: null },
      { path: "/assets/*", aud: null },
      { path: "/guest", aud: "aud-guest" },
    ]);
    // Only an application of another owner on the exact host holds it.
    expect([foreignHolds([portal, ...apps], "a.example.com"), foreignHolds(apps, "a.example.com")]).toEqual([
      true,
      false,
    ]);
    expect(ingressPath("/favicon.ico")).toBe("^/favicon\\.ico(/|$)");
    const taken: LiveSite = {
      ...site("a", "m", true),
      paths: [
        { path: "/assets/*", aud: null },
        { path: "/guest", aud: "aud-guest" },
      ],
    };
    const check = (aud: string) => ({ access: { required: true, teamName: "team", audTag: [aud] } });
    expect(
      tunnelConfig([taken], () => ({ kind: "check", teamName: "team", aud: "aud-a" })).config.ingress,
    ).toEqual([
      { hostname: "a.example.com", path: "^/assets/.*", service: "http://localhost:5173" },
      {
        hostname: "a.example.com",
        path: "^/guest(/|$)",
        service: "http://localhost:5173",
        originRequest: check("aud-guest"),
      },
      { hostname: "a.example.com", service: "http://localhost:5173", originRequest: check("aud-a") },
      { service: "http_status:404" },
    ]);
  });

  it("takes the Bypass decision from what Cloudflare accepted (K-403)", () => {
    const team = "team.cloudflareaccess.com";
    const rows = new Map([
      policyRow("policy:everyone:people", "p-bypass", "bypass"),
      policyRow("policy:owner:people", "p-allow", "allow"),
      appRow("app:live-m-pub:pub.example.com", ["p-bypass", "p-allow"], "aud-pub"),
      appRow("app:live-m-priv:priv.example.com", ["p-allow"], "aud-priv"),
      // A Bypass application needs no tag, so it never holds up its machine.
      appRow("app:live-m-new:new.example.com", ["p-bypass"], ""),
      appRow("app:live-m-wait:wait.example.com", ["p-allow"], ""),
    ]);
    const of = (name: string, domain = team) => ingressAccess(site(name, "m", true), rows, domain);
    expect(of("pub")).toEqual({ kind: "bypass" });
    expect(of("new")).toEqual({ kind: "bypass" });
    expect(of("priv")).toEqual({ kind: "check", teamName: "team", aud: "aud-priv" });
    expect(of("wait")).toMatchObject({ kind: "pending" });
    // An empty team domain leaves the rule without the check instead of holding up the machine.
    expect(of("priv", "")).toEqual({ kind: "pending", reason: "ACCESS_TEAM_DOMAIN is empty" });

    // Everyone to a circle: the check comes on only after Cloudflare accepted the application without
    // Bypass, so a failed update never locks out the members.
    const key = "app:live-m-pub:pub.example.com";
    expect(of("pub")).toEqual({ kind: "bypass" });
    rows.set(...appRow(key, ["p-allow"], "aud-pub"));
    expect(of("pub")).toEqual({ kind: "check", teamName: "team", aud: "aud-pub" });
    // The other way, the check stays while Cloudflare still has the application without Bypass.
    rows.set(...appRow(key, ["p-bypass"], "aud-pub", JSON.stringify({ policies: [{ id: "p-allow" }] })));
    expect(of("pub")).toEqual({ kind: "check", teamName: "team", aud: "aud-pub" });
  });

  it("writes no check while kitshn does not know if the application bypasses (K-403, K-603)", () => {
    // The daily compare clears an accepted body that Cloudflare no longer matches (K-408). A check
    // then could refuse every visitor of a public site, so the rule goes without it until the next sync.
    const rows = new Map([
      policyRow("policy:everyone:people", "p-bypass", "bypass"),
      policyRow("policy:owner:people", "p-allow", "allow"),
      appRow("app:live-m-app:app.example.com", ["p-allow"], "aud-app", ""),
    ]);
    const of = () => ingressAccess(site("app", "m", true), rows, "team.cloudflareaccess.com");
    expect(of()).toMatchObject({ kind: "pending" });

    rows.set(...appRow("app:live-m-app:app.example.com", ["p-allow", "p-bypass"], "aud-app"));
    rows.set("policy:owner:people", { ...rows.get("policy:owner:people")!, body: "" });
    // A known Bypass policy decides even when another policy body is unknown.
    expect(of()).toEqual({ kind: "bypass" });
    rows.set(...appRow("app:live-m-app:app.example.com", ["p-allow"], "aud-app"));
    expect(of()).toMatchObject({ kind: "pending" });
  });

  it("keeps a site without a known audience tag in the tunnel, without the check (K-603)", () => {
    // At deploy, rows from before the audience tag column have an id but no tag. Their rules stay,
    // without the check, until the tag is stored; no site is dropped and the machine is not held up.
    const rows = new Map([
      policyRow("policy:owner:people", "p-allow", "allow"),
      appRow("app:live-m-a:a.example.com", ["p-allow"], "aud-a"),
      appRow("app:live-m-b:b.example.com", ["p-allow"], ""),
    ]);
    const accessOf = (item: LiveSite) => ingressAccess(item, rows, "team.cloudflareaccess.com");
    expect(tunnelConfig([site("a", "m", true), site("b", "m", true)], accessOf).config.ingress).toEqual([
      {
        hostname: "a.example.com",
        service: "http://localhost:5173",
        originRequest: { access: { required: true, teamName: "team", audTag: ["aud-a"] } },
      },
      { hostname: "b.example.com", service: "http://localhost:5173" },
      { service: "http_status:404" },
    ]);
  });

  it("needs an offline route when the site is down or its machine is offline", () => {
    const sites = [site("up", "on", true), site("down", "on", false), site("away", "off", true)];
    expect(sitesNeedingRoutes(sites, new Set(["on"])).map((item) => item.name)).toEqual(["down", "away"]);
  });

  it("refuses names and targets that are not valid", () => {
    const { sites, refused } = parseSites([
      { name: "ok", target: "unix:/run/app.sock", dev: false, up: true },
      { name: "Bad Name", target: "http://localhost:1", up: true },
      { name: "remote", target: "http://10.0.0.5:80", up: true },
    ]);
    expect(sites.map((item) => item.name)).toEqual(["ok"]);
    expect(refused).toHaveLength(2);
  });

  it("writes the offline page text for both causes, escaped", () => {
    expect(offlineReason("Mac", false)).toContain("It comes back when Mac is on.");
    expect(offlineReason("Mac", true)).toContain("server on Mac");
    expect(seenText(0, 12 * 60_000)).toBe("12 minutes ago");
    expect(escapeHtml('<b>"x"</b>')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  });

  it("keeps two long site ids apart and refuses port 0", () => {
    const machine = "a-machine-name-that-is-forty-seven-characters-x";
    expect(liveSiteId(machine, "dashboard-api")).not.toBe(liveSiteId(machine, "dashboard-web"));
    expect(liveSiteId(machine, "dashboard-api").length).toBeLessThanOrEqual(63);
    expect(parseSites([{ name: "x", target: "http://localhost:0", up: true }]).sites).toEqual([]);
  });

  it("counts an address as reachable while accepted ingress, a DNS record or a route has it", () => {
    const applied = JSON.stringify(tunnelConfig([site("old", "m", true)], () => bypass));
    const reachable = reachableAddresses({
      ingress: [applied, ""],
      records: [
        { address: "dns.example.com", record_id: "r1" },
        { address: "never.example.com", record_id: "" },
      ],
      routes: [{ address: "route.example.com", route_id: "x" }],
    });
    expect([...reachable].sort()).toEqual(["dns.example.com", "old.example.com", "route.example.com"]);
  });

  it("gives each link path its own mandatory Access check and keeps its application while ingress remains", () => {
    const host = "kitshn-link-m.example.com";
    const link = {
      host,
      cardId: "live-m-proxy",
      socket: "/run/user/1/guard.sock",
      teamName: "team",
      audience: "aud",
    };
    const config = tunnelConfig([], () => bypass, [link]);
    expect(config.config.ingress).toEqual([
      {
        hostname: host,
        path: "^/site/live-m-proxy(/|$)",
        service: "unix:/run/user/1/guard.sock",
        originRequest: { access: { required: true, teamName: "team", audTag: ["aud"] } },
      },
      { service: "http_status:404" },
    ]);
    const reachable = reachableAddresses({ ingress: [JSON.stringify(config)], records: [], routes: [] });
    expect(reachable.has(`${host}/site/live-m-proxy/*`)).toBe(true);
    // A missing audience or unsafe socket never creates an unguarded path rule.
    expect(
      tunnelConfig([], () => bypass, [
        { ...link, audience: "" },
        { ...link, socket: "tcp://evil" },
      ]).config.ingress,
    ).toEqual([{ service: "http_status:404" }]);
    const removed = reachableAddresses({
      ingress: [JSON.stringify(tunnelConfig([], () => bypass))],
      records: [{ address: host, record_id: "dns" }],
      routes: [],
    });
    expect(removed.has(`${host}/site/live-m-proxy/*`)).toBe(false);
  });
});

describe("several addresses of a Compose app (K-817)", () => {
  const app: LiveSite = {
    id: "app-climbing-1-prod",
    machineId: "m1",
    name: "climbing",
    address: "climbing.example.com",
    target: "unix:/run/app.sock",
    dev: false,
    up: true,
    lastUp: 0,
    state: "ok",
  };
  const card = {
    kind: "site.compose" as const,
    addresses: ["climbing.example.com", "onion-climbers.com", "www.onion-climbers.com"],
  };

  it("serves every address of the card from the same socket, each with its own ingress rule", () => {
    const served = servedSites(app, card);
    expect(served.map((item) => item.address)).toEqual(card.addresses);
    expect(new Set(served.map((item) => item.target))).toEqual(new Set(["unix:/run/app.sock"]));
    const config = tunnelConfig(served, () => ({ kind: "bypass" }));
    const hostnames = config.config.ingress.flatMap((rule) => ("hostname" in rule ? [rule.hostname] : []));
    expect(hostnames.sort()).toEqual([...card.addresses].sort());
  });

  it("keeps a live site and a card of another kind to its own address", () => {
    expect(servedSites(app, undefined)).toEqual([app]);
    expect(servedSites(app, { ...card, kind: "site.live" })).toEqual([app]);
    expect(servedSites(app, { ...card, addresses: ["other.example.com"] })).toEqual([app]);
  });

  it("gives an address no ingress, DNS record or route before its own Access application exists (K-410)", () => {
    const pending = new Set(["onion-climbers.com"]);
    const sites = protectedLiveSites(
      [app, { ...app, id: "app-other", name: "other", address: "other.example.com", state: "checking" }],
      (id) => (id === app.id ? card : undefined),
      (item) => !pending.has(item.address),
    );
    expect(sites.map((item) => item.address)).toEqual(["climbing.example.com", "www.onion-climbers.com"]);
  });

  it("keeps the old addresses of a static card until the deploy took their domains off, and not of a Compose card", () => {
    expect(nextCardAddresses("site.static", ["a.example.com"], ["a.example.com", "old.example.com"])).toEqual(
      ["a.example.com", "old.example.com"],
    );
    expect(
      nextCardAddresses("site.compose", ["a.example.com"], ["a.example.com", "old.example.com"]),
    ).toEqual(["a.example.com"]);
  });
});

describe("DNS records of an address that moves between cards (K-817)", () => {
  it("refuses card B while card A's record of X waits for removal, and lets B in once it is gone", () => {
    // Card A dropped X; its record stays until the tunnel sync deletes it.
    const aRow = { card_id: "app-a" };
    expect(dnsRecordRefusal("x.example.com", 1, aRow, "app-b")).toMatch("another kitshn card");
    // The same card that made the record may take X back.
    expect(dnsRecordRefusal("x.example.com", 1, aRow, "app-a")).toBeNull();
    // A row from before the owner column counts as another card's.
    expect(dnsRecordRefusal("x.example.com", 1, { card_id: null }, "app-b")).toMatch("another kitshn card");
    // Once the record is gone, B deploys.
    expect(dnsRecordRefusal("x.example.com", 0, undefined, "app-b")).toBeNull();
    // A record that kitshn did not make always blocks.
    expect(dnsRecordRefusal("x.example.com", 1, undefined, "app-b")).toBe(
      "x.example.com already has a DNS record.",
    );
  });
});

describe("records that block an address (K-817, K-1111)", () => {
  it("counts A, AAAA and CNAME, and lets the MX and TXT of a zone apex stay", () => {
    const apex = [{ type: "A" }, { type: "MX" }, { type: "MX" }, { type: "TXT" }];
    expect(addressRecords(apex)).toBe(1);
    expect(addressRecords(apex.filter((record) => record.type !== "A"))).toBe(0);
    expect(addressRecords([{ type: "CNAME" }, { type: "AAAA" }])).toBe(2);
  });
});

describe("DNS records of a Compose deploy before its site is live (K-817, K-901)", () => {
  const tunnelOf = (machineId: string) => (machineId === "m" ? "t" : undefined);
  const run = (expiresAt: number, machineId: string | null = "m") => ({
    card: "app-a",
    addresses: ["a.example.com", "b.example.com"],
    machineId,
    expiresAt,
  });
  const record = { content: "t.cfargotunnel.com", cardId: "app-a" };

  it("wants the records of a planned, running or done deploy until it expires, then only a live site's", () => {
    expect([...wantedRecords([run(100)], [], tunnelOf, 50)]).toEqual([
      ["a.example.com", record],
      ["b.example.com", record],
    ]);
    // An expired deploy, or one on a machine that kitshn does not know, wants nothing.
    expect(wantedRecords([run(100)], [], tunnelOf, 100).size).toBe(0);
    expect(wantedRecords([run(100, "gone")], [], tunnelOf, 50).size).toBe(0);
    // After it expires, the live site of the card holds the main address.
    const site = { id: "app-a", machineId: "m", address: "a.example.com" };
    expect([...wantedRecords([run(100)], [site], tunnelOf, 200)]).toEqual([["a.example.com", record]]);
  });
});

describe("fitAttachment (K-619, K-909)", () => {
  const volumes = Array.from({ length: 100 }, (_, i) => ({
    name: `kitshn-app-${i}_data-${"x".repeat(60)}`,
    project: `kitshn-app-${i}`,
  }));
  const servers = Array.from({ length: 32 }, (_, i) => ({
    port: 3000 + i,
    process: "node".repeat(10),
    status: 200,
    title: "t".repeat(80),
  }));
  const base = { kind: "machine", machineId: "vps", status: null, sample: null };

  it("keeps the whole attachment in budget, whichever report came first, servers first to go", () => {
    for (const attachment of [
      fitAttachment({ ...fitAttachment({ ...base, volumes }), servers }),
      fitAttachment({ ...fitAttachment({ ...base, servers }), volumes }),
    ]) {
      expect(cloneBytes(attachment)).toBeLessThanOrEqual(ATTACHMENT_BUDGET);
      expect(attachment.volumes.length).toBeGreaterThan(0);
    }
    const small = { ...base, servers: servers.slice(0, 2), volumes: volumes.slice(0, 2) };
    expect(fitAttachment(small)).toBe(small);
  });
});
