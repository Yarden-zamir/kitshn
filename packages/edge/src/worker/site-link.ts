import { cloudflare, cloudflareCompleteList } from "./cloudflare.ts";

/** A complete Cloudflare inventory is required before a machine token may be sent to a reserved host. */
export interface SiteLinkInventory {
  readonly host: string;
  /** A card, site, pending deploy or redirect already holds this hostname. */
  readonly locallyHeld: boolean;
  /** Null means that the listing failed or may have more pages. */
  readonly dns: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly content: string;
    readonly proxied?: boolean;
  }> | null;
  readonly domains: ReadonlyArray<{ readonly hostname: string }> | null;
  readonly routes: ReadonlyArray<{ readonly pattern: string }> | null;
  readonly apps: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly domain?: string;
    readonly policies?: ReadonlyArray<{ readonly decision?: string }>;
    readonly self_hosted_domains?: ReadonlyArray<string>;
    readonly destinations?: ReadonlyArray<{
      readonly type?: string;
      readonly uri?: string;
      readonly overrides?: ReadonlyArray<unknown>;
    }>;
  }> | null;
  /** The one DNS record that kitshn wrote for this host and the tunnel it should still point to. */
  readonly ownDns: { readonly id: string; readonly content: string } | null;
  /** Each application that kitshn wrote for a site on this host, by Cloudflare id and exact path. */
  readonly ownApps: ReadonlyMap<string, string>;
}

/** A Cloudflare hostname pattern, conservatively treating `*` as matching any hostname characters. */
function coversHost(pattern: string, host: string): boolean | null {
  const raw = pattern
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    ?.toLowerCase();
  if (!raw || !/^[a-z0-9.*-]+$/.test(raw)) return null;
  const regex = new RegExp(`^${raw.replaceAll(".", "\\.").replaceAll("*", ".*")}$`);
  return regex.test(host.toLowerCase());
}

/** Why a reserved host cannot be used, or null only when every known route belongs to this link. */
export function siteLinkHostRefusal(input: SiteLinkInventory): string | null {
  if (!/^kitshn-link-[a-z0-9-]+\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(input.host))
    return "the hostname is not a reserved machine link";
  if (input.locallyHeld) return "the hostname already belongs to another kitshn address";
  if (!input.dns || !input.domains || !input.routes || !input.apps)
    return "Cloudflare's hostname inventory is incomplete";
  for (const record of input.dns)
    if (
      !input.ownDns ||
      record.id !== input.ownDns.id ||
      record.type !== "CNAME" ||
      record.content.toLowerCase().replace(/\.$/, "") !==
        input.ownDns.content.toLowerCase().replace(/\.$/, "") ||
      record.proxied !== true
    )
      return "the hostname has a DNS record that is not this machine's protected tunnel";
  for (const domain of input.domains) {
    const covers = coversHost(domain.hostname, input.host);
    if (covers === null || covers) return "a Worker custom domain may serve the hostname";
  }
  for (const route of input.routes) {
    const covers = coversHost(route.pattern, input.host);
    if (covers === null || covers) return "a Worker route may serve the hostname";
  }
  for (const app of input.apps) {
    if (typeof app.type !== "string" || app.type === "") return "an Access application has an unknown type";
    const destinations = app.destinations;
    // Other application types may still report a hostname. Only skip them when they name no public address.
    if (
      app.type !== "self_hosted" &&
      !app.domain &&
      !app.self_hosted_domains?.length &&
      !destinations?.length
    )
      continue;
    if (
      destinations?.some(
        (destination) =>
          ((!destination.type || destination.type === "public") && !destination.uri) ||
          (destination.type !== undefined &&
            !["public", "worker", "preview_worker", "all_workers", "all_preview_workers"].includes(
              destination.type,
            )),
      )
    )
      return "an Access application has an unknown public destination";
    // destinations supersedes the deprecated domain lists when present.
    const domains = destinations
      ? destinations.flatMap((destination) => (destination.uri ? [destination.uri] : []))
      : [app.domain, ...(app.self_hosted_domains ?? [])].filter((domain): domain is string =>
          Boolean(domain),
        );
    if (app.type === "self_hosted" && domains.length === 0 && destinations === undefined)
      return "an Access application has no readable destination";
    for (const domain of domains) {
      const covers = coversHost(domain, input.host);
      if (covers === null) return "an Access application has an unknown hostname pattern";
      if (covers && input.ownApps.get(app.id)?.toLowerCase() !== domain.toLowerCase())
        return "another Access application may cover the hostname";
      if (covers) {
        if (
          !app.policies ||
          app.policies.some((policy) => !policy.decision) ||
          !app.policies.some((policy) => policy.decision === "non_identity")
        )
          return "the Access application's service-token policies are not verified";
        if (app.policies.some((policy) => policy.decision === "bypass"))
          return "an Access application can bypass the protected path";
        if (destinations?.some((destination) => destination.uri === domain && destination.overrides?.length))
          return "an Access application can bypass the protected path";
      }
    }
  }
  return null;
}

/** Fetch all Cloudflare owners of a candidate host. A failed or incomplete listing refuses the host. */
export async function inspectSiteLinkHost(
  token: string,
  accountId: string,
  zoneId: string,
  input: Pick<SiteLinkInventory, "host" | "locallyHeld" | "ownDns" | "ownApps">,
): Promise<string | null> {
  if (input.locallyHeld) return "the hostname already belongs to another kitshn address";
  try {
    const account = `/accounts/${accountId}`;
    const zone = `/zones/${zoneId}`;
    const [dns, domains, routes, apps] = await Promise.all([
      cloudflareCompleteList<NonNullable<SiteLinkInventory["dns"]>[number]>(
        token,
        `${zone}/dns_records?name=${encodeURIComponent(input.host)}`,
      ),
      cloudflareCompleteList<NonNullable<SiteLinkInventory["domains"]>[number]>(
        token,
        `${account}/workers/domains`,
      ),
      // Cloudflare's zone routes endpoint is unpaginated; it returns the whole zone in one array.
      cloudflare<NonNullable<SiteLinkInventory["routes"]>>(token, "GET", `${zone}/workers/routes`),
      cloudflareCompleteList<NonNullable<SiteLinkInventory["apps"]>[number]>(token, `${account}/access/apps`),
    ]);
    if (!Array.isArray(routes)) return "Cloudflare's hostname inventory is incomplete";
    return siteLinkHostRefusal({ ...input, dns, domains, routes, apps });
  } catch {
    return "Cloudflare's hostname inventory could not be verified";
  }
}
