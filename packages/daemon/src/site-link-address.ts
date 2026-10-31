// K-1609: a machine credential must only travel to the protected Cloudflare link host.
import { lookup } from "node:dns/promises";
import { ipInRange } from "@kitshn/edge/visitor";

// Cloudflare's published proxied IPv4 and IPv6 ranges, checked 2026-10-31. A new range fails closed
// until a daemon update includes it; removing or narrowing a range requires updating this list too.
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

type Lookup = (hostname: string) => Promise<ReadonlyArray<{ readonly address: string }>>;

/** Resolve once, select a Cloudflare address, and connect to that literal address with the original TLS name. */
export async function pinnedSiteAddress(
  target: URL,
  resolve: Lookup = (hostname) => lookup(hostname, { all: true }),
): Promise<{ readonly dial: URL; readonly serverName: string }> {
  const host = target.hostname;
  if (
    target.protocol !== "https:" ||
    target.port !== "" ||
    !/^kitshn-link-[a-z0-9-]+\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host)
  )
    throw new Error("the site link is not a reserved HTTPS host");
  const addresses = await resolve(host);
  const address = addresses.find((item) => CLOUDFLARE_RANGES.some((range) => ipInRange(item.address, range)));
  if (!address) throw new Error("the site link resolved to no Cloudflare address");
  const dial = new URL(target);
  dial.hostname = address.address.includes(":") ? `[${address.address}]` : address.address;
  return { dial, serverName: host };
}
