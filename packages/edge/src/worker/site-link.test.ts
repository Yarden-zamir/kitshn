import { afterEach, describe, expect, it, vi } from "vitest";
import { type SiteLinkInventory, inspectSiteLinkHost, siteLinkHostRefusal } from "./site-link.ts";

const host = "kitshn-link-mac.example.com";
const path = `${host}/site/live-mac-proxy/*`;
const base: SiteLinkInventory = {
  host,
  locallyHeld: false,
  dns: [],
  domains: [],
  routes: [],
  apps: [],
  ownDns: null,
  ownApps: new Map(),
};

describe("the reserved machine-link hostname", () => {
  it("requires a complete inventory and refuses an existing local address", () => {
    expect(siteLinkHostRefusal(base)).toBeNull();
    expect(siteLinkHostRefusal({ ...base, host: "example.com" })).toContain("not a reserved");
    for (const kind of ["dns", "domains", "routes", "apps"] as const)
      expect(siteLinkHostRefusal({ ...base, [kind]: null })).toContain("incomplete");
    expect(siteLinkHostRefusal({ ...base, locallyHeld: true })).toContain("already belongs");
  });

  it("accepts only its own proxied DNS record pointing at the destination tunnel", () => {
    const record = { id: "one", type: "CNAME", content: "tunnel.cfargotunnel.com", proxied: true };
    const current: SiteLinkInventory = {
      ...base,
      dns: [record],
      ownDns: { id: "one", content: record.content },
    };
    expect(siteLinkHostRefusal(current)).toBeNull();
    for (const dns of [
      [{ ...record, id: "foreign" }],
      [{ ...record, type: "A" }],
      [{ ...record, content: "other.cfargotunnel.com" }],
      [{ ...record, proxied: false }],
      [record, { ...record, id: "extra" }],
    ])
      expect(siteLinkHostRefusal({ ...current, dns })).toContain("DNS record");
  });

  it("refuses Worker domains and routes that can match the host, including wildcard routes", () => {
    expect(siteLinkHostRefusal({ ...base, domains: [{ hostname: host }] })).toContain("custom domain");
    for (const pattern of [`${host}/*`, "*.example.com/*", "https://*example.com/anything*"])
      expect(siteLinkHostRefusal({ ...base, routes: [{ pattern }] })).toContain("Worker route");
    expect(siteLinkHostRefusal({ ...base, routes: [{ pattern: "elsewhere.example.com/*" }] })).toBeNull();
    expect(siteLinkHostRefusal({ ...base, routes: [{ pattern: "" }] })).toContain("Worker route");
  });

  it("refuses overlapping foreign Access applications, even if their name resembles a kitshn object", () => {
    const own = { id: "app-a", type: "self_hosted", domain: path, policies: [{ decision: "non_identity" }] };
    const apps = [own];
    const current: SiteLinkInventory = { ...base, apps, ownApps: new Map([[own.id, path]]) };
    expect(siteLinkHostRefusal(current)).toBeNull();
    expect(
      siteLinkHostRefusal({ ...current, apps: [{ id: own.id, type: own.type, domain: own.domain }] }),
    ).toContain("not verified");
    expect(
      siteLinkHostRefusal({
        ...current,
        apps: [{ ...own, policies: [{ decision: "non_identity" }, { decision: "bypass" }] }],
      }),
    ).toContain("bypass");
    expect(siteLinkHostRefusal({ ...base, apps })).toContain("another Access application");
    expect(siteLinkHostRefusal({ ...base, apps: [{ ...own, type: "other" }] })).toContain(
      "another Access application",
    );
    expect(siteLinkHostRefusal({ ...current, apps: [{ ...own, domain: `${host}/*` }] })).toContain(
      "another Access",
    );
    expect(
      siteLinkHostRefusal({
        ...base,
        apps: [{ id: "wildcard", type: "self_hosted", domain: "*.example.com/*" }],
      }),
    ).toContain("another Access");
    // A modern destinations array supersedes the deprecated domain field.
    expect(
      siteLinkHostRefusal({
        ...base,
        apps: [
          {
            id: "foreign",
            type: "self_hosted",
            domain: "other.example.com",
            destinations: [{ type: "public", uri: path }],
          },
        ],
      }),
    ).toContain("another Access");
    expect(
      siteLinkHostRefusal({
        ...base,
        apps: [{ id: "foreign", type: "self_hosted", destinations: [{ type: "public" }] }],
      }),
    ).toContain("unknown public destination");
    expect(
      siteLinkHostRefusal({
        ...current,
        apps: [
          {
            id: "app-a",
            type: "self_hosted",
            policies: [{ decision: "non_identity" }],
            destinations: [{ uri: path, overrides: [{ behavior: "public", path_pattern: "/*" }] }],
          },
        ],
      }),
    ).toContain("bypass");
    expect(
      siteLinkHostRefusal({
        ...base,
        apps: [{ id: "other", type: "self_hosted", domain: "other.example.com" }],
      }),
    ).toBeNull();
  });
});

describe("Cloudflare ownership inspection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires complete DNS, Worker-domain and Access pages and checks the unpaginated zone routes", async () => {
    const paths: string[] = [];
    let incomplete = false;
    let routes: Array<{ pattern: string }> = [];
    vi.stubGlobal("fetch", async (url: string) => {
      paths.push(url);
      const isRoutes = url.includes("/workers/routes");
      return Response.json({
        success: true,
        result: isRoutes ? routes : [],
        ...(!isRoutes && {
          result_info: { page: 1, count: 0, per_page: 1000, total_pages: incomplete ? 2 : 0 },
        }),
      });
    });
    const input = { host, locallyHeld: false, ownDns: null, ownApps: new Map<string, string>() };
    expect(await inspectSiteLinkHost("token", "account", "zone", input)).toBeNull();
    expect(paths).toHaveLength(4);
    expect(
      paths.some((url) => url.includes(`/dns_records?name=${encodeURIComponent(host)}&per_page=1000`)),
    ).toBe(true);
    expect(paths.some((url) => url.includes("/workers/routes"))).toBe(true);
    incomplete = true;
    expect(await inspectSiteLinkHost("token", "account", "zone", input)).toContain("could not be verified");
    incomplete = false;
    routes = [{ pattern: "*.example.com/*" }];
    expect(await inspectSiteLinkHost("token", "account", "zone", input)).toContain("Worker route");
    paths.length = 0;
    expect(await inspectSiteLinkHost("token", "account", "zone", { ...input, locallyHeld: true })).toContain(
      "already belongs",
    );
    expect(paths).toEqual([]);
  });
});
