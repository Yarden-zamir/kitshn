import { ACCESS_NAME_PREFIX } from "../core/access.ts";
import { RESERVED_SITE_NAMES } from "../core/library.ts";
import { type LiveSiteReport, siteLinkDomain } from "../core/machine.ts";
import { type Resource, fnv } from "../core/model.ts";
import { type AccessRow, appliesBypass } from "./access-sync.ts";

/** One live site of a machine (K-1104), as the Durable Object keeps it. */
export interface LiveSite {
  readonly id: string;
  readonly machineId: string;
  readonly name: string;
  readonly address: string;
  /** `http://localhost:<port>` or `unix:<path>` (K-607). */
  readonly target: string;
  /** K-1105: a dev server gets the Host header `localhost`. */
  readonly dev: boolean;
  readonly up: boolean;
  /** When the site or its machine was last seen up. */
  readonly lastUp: number;
  /** "checking" until kitshn knows that nothing else uses the address; "refused" when something does. */
  /** K-1623: the path applications of another owner on the address, whose paths keep their own Access check. */
  readonly paths?: ReadonlyArray<ForeignPath>;
  /** `handover`: the owner takes over an address that something else serves (K-1623); it ends as `ok`. */
  readonly state: "checking" | "ok" | "refused" | "handover";
}

/** K-1104: a site name, one DNS label. */
export const LIVE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TARGET = /^(http:\/\/localhost:(\d{1,5})|unix:\/[^\s]{1,200})$/;

/** A long id keeps a hash of the machine and the name instead of being cut, so two sites never meet. */
export const liveSiteId = (machineId: string, name: string) => {
  const full = `live-${machineId}-${name}`;
  return full.length <= 63 ? full : `live-${fnv(`${machineId}/${name}`)}-${name}`.slice(0, 63);
};

/** Checks the sites that a daemon reports. Returns the valid ones and a reason for each refused one. */
export function parseSites(value: unknown): { sites: Array<LiveSiteReport>; refused: Array<string> } {
  const sites: Array<LiveSiteReport> = [];
  const refused: Array<string> = [];
  if (!Array.isArray(value)) return { sites, refused: ["The site list is not a list."] };
  for (const item of value.slice(0, 50)) {
    const site = item as Partial<Record<keyof LiveSiteReport, unknown>>;
    if (typeof site.name !== "string" || !LIVE_LABEL.test(site.name))
      refused.push(`The name ${String(site.name)} is not valid.`);
    else if (RESERVED_SITE_NAMES.has(site.name))
      refused.push(`${site.name}: kitshn itself uses this name on the zone.`);
    else if (typeof site.target !== "string" || !validTarget(site.target))
      refused.push(`${site.name}: the target is not valid.`);
    else
      sites.push({
        name: site.name,
        target: site.target,
        dev: site.dev === true,
        up: site.up === true,
        ...(typeof site.endsAt === "number" && Number.isFinite(site.endsAt) ? { endsAt: site.endsAt } : {}),
        ...(typeof site.circle === "string" && site.circle !== ""
          ? { circle: site.circle.slice(0, 64) }
          : {}),
      });
  }
  return { sites, refused };
}

const validTarget = (target: string) => {
  const match = TARGET.exec(target);
  if (!match) return false;
  const port = match[2];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65535);
};

/**
 * K-603: how cloudflared guards the ingress rule of a site. "check": it drops a request without a valid
 * Access JWT of the application. "bypass": the application lets everyone in and issues no JWT (K-403).
 * "pending": kitshn cannot build the check yet (`reason` says why), so the rule goes without it until a
 * later tunnel write. A site never leaves the tunnel for this.
 */
export type IngressAccess =
  | { readonly kind: "check"; readonly teamName: string; readonly aud: string }
  | { readonly kind: "bypass" }
  | { readonly kind: "pending"; readonly reason: string };

/**
 * K-603, K-403: the Access check of a site's ingress rule, from its application `app:<site>:<address>`
 * as Cloudflare last accepted it. The check comes on only once the application no longer bypasses, and
 * goes off only once it does.
 */
export function ingressAccess(
  site: LiveSite,
  rows: ReadonlyMap<string, AccessRow>,
  teamDomain: string,
): IngressAccess {
  const row = rows.get(`app:${site.id}:${site.address}`);
  if (!row?.cfId) return { kind: "pending", reason: "its Access application is not made yet" };
  const bypass = appliesBypass(row, rows);
  if (bypass === true) return { kind: "bypass" };
  // A check on a site that still bypasses would refuse every public visitor.
  if (bypass === null) return { kind: "pending", reason: "kitshn does not know if its application bypasses" };
  if (!row.aud) return { kind: "pending", reason: "its audience tag is not known yet" };
  const teamName = teamDomain.split(".")[0];
  if (!teamName) return { kind: "pending", reason: "ACCESS_TEAM_DOMAIN is empty" };
  return { kind: "check", teamName, aud: row.aud };
}

/**
 * K-817: one entry for each address that serves a live site. The socket of a Compose app serves every address of
 * its card, each with its own ingress rule, DNS record and Access application; any other site serves its own.
 */
export function servedSites(
  site: LiveSite,
  card: Pick<Resource, "kind" | "addresses"> | undefined,
): Array<LiveSite> {
  if (card?.kind !== "site.compose" || card.addresses[0] !== site.address) return [site];
  return card.addresses.map((address) => ({ ...site, address }));
}

/**
 * K-410, K-817: the live sites that may get ingress, a DNS record and an offline route: checked sites, one entry for
 * each address that serves them, and only the addresses whose Access application exists.
 */
export function protectedLiveSites(
  sites: Iterable<LiveSite>,
  cardOf: (id: string) => Pick<Resource, "kind" | "addresses"> | undefined,
  hasApplication: (site: LiveSite) => boolean,
): Array<LiveSite> {
  return [...sites]
    .filter((site) => site.state === "ok")
    .flatMap((site) => servedSites(site, cardOf(site.id)))
    .filter(hasApplication);
}

/**
 * K-817, K-410: the addresses of an existing card after a deploy. A Compose card takes the new list at once, because
 * its tunnel sync drops an old address in order. A static card keeps its old addresses until the deploy has taken
 * their custom domains off, so their Access applications stay meanwhile.
 */
export function nextCardAddresses(
  kind: Resource["kind"],
  addresses: ReadonlyArray<string>,
  existing: ReadonlyArray<string>,
): Array<string> {
  if (kind === "site.compose") return [...addresses];
  return [...addresses, ...existing.filter((address) => !addresses.includes(address))];
}

/** K-1623: a path application of another owner on a kitshn address; `aud` null for one that bypasses Access. */
export interface ForeignPath {
  readonly path: string;
  readonly aud: string | null;
}

/** One Access application as Cloudflare lists it, with the fields that K-1623 reads. */
export interface AccessAppListing {
  readonly name: string;
  readonly domain: string;
  readonly aud: string;
  readonly self_hosted_domains?: ReadonlyArray<string>;
  readonly policies?: ReadonlyArray<{ readonly decision: string }>;
}

const appHosts = (app: AccessAppListing) => [...new Set([app.domain, ...(app.self_hosted_domains ?? [])])];

/**
 * K-1623: the paths on `host` of applications that kitshn did not make. A path of an application with a Bypass
 * policy comes with no Access token, so it gets no check; any other path comes with its own application's token.
 */
export function foreignPaths(apps: ReadonlyArray<AccessAppListing>, host: string): Array<ForeignPath> {
  return apps
    .filter((app) => !app.name.startsWith(ACCESS_NAME_PREFIX))
    .flatMap((app) => {
      const bypass = (app.policies ?? []).some((policy) => policy.decision === "bypass");
      return appHosts(app)
        .filter((domain) => domain.startsWith(`${host}/`))
        .map((domain) => ({ path: domain.slice(host.length), aud: bypass ? null : app.aud }));
    })
    .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
}

/** K-1623: whether an application that kitshn did not make holds exactly `host`, with no path. */
export const foreignHolds = (apps: ReadonlyArray<AccessAppListing>, host: string) =>
  apps.some((app) => !app.name.startsWith(ACCESS_NAME_PREFIX) && appHosts(app).includes(host));

/**
 * K-1623: the cloudflared path rule of an Access application path. `*` matches anything, and a path without one also
 * covers the paths below it, as Access does (tested on Cloudflare, 2026-10-29). cloudflared takes a regular expression.
 */
export function ingressPath(path: string): string {
  const pattern = path
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return path.endsWith("*") ? `^${pattern}` : `^${pattern}(/|$)`;
}

/** One guarded site path on a reserved link host. */
export interface SiteLinkIngress {
  readonly host: string;
  readonly cardId: string;
  readonly socket: string;
  readonly teamName: string;
  readonly audience: string;
}

/** K-603, K-607, K-1105: the ingress of a machine's tunnel from its live sites. */
export function tunnelConfig(
  sites: ReadonlyArray<LiveSite>,
  accessOf: (site: LiveSite) => IngressAccess,
  links: ReadonlyArray<SiteLinkIngress> = [],
) {
  return {
    config: {
      ingress: [
        ...[...links]
          .filter(
            (link) =>
              siteLinkDomain(link.host, link.cardId) !== null &&
              link.socket.startsWith("/") &&
              !/[\r\n\0]/.test(link.socket) &&
              link.teamName !== "" &&
              link.audience !== "",
          )
          .sort((a, b) => a.host.localeCompare(b.host) || a.cardId.localeCompare(b.cardId))
          .map((link) => ({
            hostname: link.host,
            path: ingressPath(`/site/${link.cardId}`),
            service: `unix:${link.socket}`,
            originRequest: { access: { required: true, teamName: link.teamName, audTag: [link.audience] } },
          })),
        ...[...sites]
          .sort((a, b) => a.address.localeCompare(b.address))
          .flatMap((site) => {
            const access = accessOf(site);
            const check = (aud: string) =>
              access.kind === "check"
                ? { access: { required: true, teamName: access.teamName, audTag: [aud] } }
                : {};
            const rule = (extra: object, originRequest: object) => ({
              hostname: site.address,
              ...extra,
              service: site.target,
              ...(Object.keys(originRequest).length > 0 ? { originRequest } : {}),
            });
            const dev = site.dev ? { httpHostHeader: "localhost" } : {};
            // K-1623: cloudflared takes the first rule that matches, so the paths of other applications come first,
            // each with its own check; the host keeps kitshn's.
            return [
              ...(site.paths ?? []).map((item) =>
                rule({ path: ingressPath(item.path) }, { ...dev, ...(item.aud ? check(item.aud) : {}) }),
              ),
              rule({}, { ...dev, ...(access.kind === "check" ? check(access.aud) : {}) }),
            ];
          }),
        { service: "http_status:404" },
      ],
    },
  };
}

/** K-1108: the live sites that need the offline route: the site is down, or its machine is offline. */
export function sitesNeedingRoutes(sites: Iterable<LiveSite>, online: ReadonlySet<string>): Array<LiveSite> {
  return [...sites].filter((site) => !site.up || !online.has(site.machineId));
}

/** K-1106: the sentence of the offline page. */
export function offlineReason(machineName: string, machineOnline: boolean): string {
  return machineOnline
    ? `${machineName} is on, but the cook stepped out: nothing answers on its port. It comes back when the server on ${machineName} starts again.`
    : `The cook went home. ${machineName} is off, so this dish is off the menu for now. It comes back when ${machineName} is on.`;
}

/** "12 minutes ago" for the offline page. */
export function seenText(time: number | null, now: number): string {
  if (time === null) return "a while ago";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** K-1109: an answer that means the origin is down: a bad gateway, or the tunnel error 1033. */
export const originDown = (status: number) => status === 502 || status === 530;

/**
 * K-006: the addresses that a route can still reach: hostnames in tunnel ingress that Cloudflare
 * accepted, DNS records and Worker routes that kitshn made. An Access application stays while its
 * address is here.
 */
export function reachableAddresses(input: {
  readonly ingress: Iterable<string>;
  readonly records: Iterable<{ readonly address: string; readonly record_id: string }>;
  readonly routes: Iterable<{ readonly address: string; readonly route_id: string }>;
}): Set<string> {
  const reachable = new Set<string>();
  for (const body of input.ingress) {
    if (!body) continue;
    const config = JSON.parse(body) as { config?: { ingress?: Array<{ hostname?: string; path?: string }> } };
    for (const rule of config.config?.ingress ?? []) {
      if (!rule.hostname) continue;
      reachable.add(rule.hostname);
      const link = /^\^\/site\/([a-z0-9][a-z0-9-]{0,62})\(\/\|\$\)$/.exec(rule.path ?? "");
      const domain = link?.[1] ? siteLinkDomain(rule.hostname, link[1]) : null;
      if (domain) reachable.add(domain);
    }
  }
  for (const record of input.records) if (record.record_id) reachable.add(record.address);
  for (const route of input.routes) if (route.route_id) reachable.add(route.address);
  return reachable;
}

/**
 * K-817: why a deploy may not take an address with DNS records, or null. A record that kitshn made for this
 * same card does not block; one that kitshn made for another card, also one that waits for removal, does until it
 * is gone, and so does a record of anything else.
 */
/**
 * K-817, K-1111: the records of an address that a kitshn record conflicts with. Cloudflare refuses a CNAME next to
 * an A, AAAA or CNAME of the same name; MX and TXT of a zone apex (email) can stay, as CNAME flattening serves it.
 */
export const addressRecords = (records: ReadonlyArray<{ readonly type: string }>) =>
  records.filter((record) => record.type === "A" || record.type === "AAAA" || record.type === "CNAME").length;

export function dnsRecordRefusal(
  address: string,
  records: number,
  kitshnRow: { readonly card_id: string | null } | undefined,
  cardId: string,
): string | null {
  if (kitshnRow?.card_id === cardId || records === 0) return null;
  if (kitshnRow)
    return `${address} still has the DNS record of another kitshn card; it goes when that card lets go of ${address}. Deploy again then.`;
  return `${address} already has a DNS record.`;
}

/** K-817, K-901: a Compose deploy that is planned, running or done, with the addresses that it serves. */
export interface ComposeRun {
  readonly card: string;
  readonly addresses: ReadonlyArray<string>;
  readonly machineId: string | null;
  readonly expiresAt: number;
}

/**
 * K-1104, K-817, K-901: the proxied CNAME that each address should have, to the tunnel of its machine. A Compose
 * deploy gets its records at plan time, before its build, so no lookup during the build caches another answer, such
 * as an old wildcard. Its tunnel has no ingress for the address until the site is live and its Access application
 * exists (K-410), so the record exposes nothing. A done deploy keeps the record until it expires, by when the live
 * site of its card holds it; a failed, cut-off or expired deploy gives it up unless the site went live.
 */
export function wantedRecords(
  runs: ReadonlyArray<ComposeRun>,
  sites: ReadonlyArray<Pick<LiveSite, "id" | "machineId" | "address">>,
  tunnelOf: (machineId: string) => string | undefined,
  now: number,
): Map<string, { content: string; cardId: string }> {
  const wanted = new Map<string, { content: string; cardId: string }>();
  for (const run of runs) {
    const tunnel = run.machineId === null ? undefined : tunnelOf(run.machineId);
    if (tunnel === undefined || run.expiresAt <= now) continue;
    for (const address of run.addresses)
      wanted.set(address, { content: `${tunnel}.cfargotunnel.com`, cardId: run.card });
  }
  for (const site of sites) {
    const tunnel = tunnelOf(site.machineId);
    if (tunnel !== undefined)
      wanted.set(site.address, { content: `${tunnel}.cfargotunnel.com`, cardId: site.id });
  }
  return wanted;
}

/**
 * K-619, K-909: an estimate of the bytes that a value takes as a structured clone, as workerd stores an attachment. A
 * string with any character above U+00FF takes two bytes for each of its characters, so neither JSON characters nor
 * UTF-8 bytes measure it.
 */
export function cloneBytes(value: unknown): number {
  if (typeof value === "string")
    return 5 + value.length * ([...value].some((c) => (c.codePointAt(0) ?? 0) > 0xff) ? 2 : 1);
  if (typeof value === "number") return 9;
  if (value === null || value === undefined || typeof value === "boolean") return 1;
  if (Array.isArray(value)) return 5 + value.reduce((sum: number, item) => sum + cloneBytes(item), 0);
  if (typeof value === "object")
    return Object.entries(value).reduce((sum, [key, item]) => sum + cloneBytes(key) + cloneBytes(item), 5);
  throw new Error(`cloneBytes: a ${typeof value} has no size here.`);
}

/**
 * K-619, K-909: Cloudflare keeps at most 16,384 bytes on a socket attachment. A machine's attachment keeps its status,
 * sample, volumes and servers, so the lists that only inform lose their last entries, servers first, until the clone
 * estimate fits this budget, which keeps a margin under the limit.
 */
export const ATTACHMENT_BUDGET = 15_000;

export function fitAttachment<
  T extends {
    readonly servers?: ReadonlyArray<unknown>;
    readonly volumes?: ReadonlyArray<unknown>;
    readonly health?: { readonly links: ReadonlyArray<unknown> };
  },
>(attachment: T): T {
  let fitted = attachment;
  while (cloneBytes(fitted) > ATTACHMENT_BUDGET) {
    if (fitted.servers && fitted.servers.length > 0)
      fitted = { ...fitted, servers: fitted.servers.slice(0, -1) };
    else if (fitted.volumes && fitted.volumes.length > 0)
      fitted = { ...fitted, volumes: fitted.volumes.slice(0, -1) };
    // K-630: the link checks inform too; the map then shows the cut links as no link.
    else if (fitted.health && fitted.health.links.length > 0)
      fitted = { ...fitted, health: { ...fitted.health, links: fitted.health.links.slice(0, -1) } };
    else throw new Error("fitAttachment: the attachment is too big without servers, volumes and links.");
  }
  return fitted;
}
