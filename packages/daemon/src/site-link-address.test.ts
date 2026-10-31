import { describe, expect, it } from "vitest";
import { pinnedSiteAddress } from "./site-link-address.ts";

describe("the protected site link address", () => {
  it("connects to an approved literal address while keeping the original hostname and path for TLS", async () => {
    const queries: string[] = [];
    const target = new URL("https://kitshn-link-mac.example.com/site/live-mac-a/v1/messages?stream=1");
    const result = await pinnedSiteAddress(target, async (host) => {
      queries.push(host);
      return [{ address: "127.0.0.1" }, { address: "104.16.1.2" }, { address: "203.0.113.1" }];
    });
    expect(queries).toEqual(["kitshn-link-mac.example.com"]);
    expect(result.dial.href).toBe("https://104.16.1.2/site/live-mac-a/v1/messages?stream=1");
    expect(result.serverName).toBe("kitshn-link-mac.example.com");
    // The input remains the host used in the Host header and cannot be changed by the resolver.
    expect(target.hostname).toBe(result.serverName);
  });

  it("handles an approved IPv6 address without another DNS lookup", async () => {
    const result = await pinnedSiteAddress(
      new URL("https://kitshn-link-mac.example.com/site/live-mac-a/"),
      async () => [{ address: "2606:4700::1234" }],
    );
    expect(result.dial.hostname).toBe("[2606:4700::1234]");
    expect(result.serverName).toBe("kitshn-link-mac.example.com");
  });

  it("fails closed for private, non-Cloudflare, empty, and invalid DNS results", async () => {
    const target = new URL("https://kitshn-link-mac.example.com/site/live-mac-a/");
    for (const addresses of [[], ["127.0.0.1"], ["192.168.1.1"], ["203.0.113.2"], ["::1"], ["bad"]])
      await expect(
        pinnedSiteAddress(target, async () => addresses.map((address) => ({ address }))),
      ).rejects.toThrow("no Cloudflare address");
  });

  it("does not send a credential to a non-reserved host, HTTP, or an alternate port", async () => {
    for (const address of [
      "https://mac.example.com/site/live-mac-a/",
      "http://kitshn-link-mac.example.com/site/live-mac-a/",
      "https://kitshn-link-mac.example.com:8443/site/live-mac-a/",
    ])
      await expect(
        pinnedSiteAddress(new URL(address), async () => [{ address: "104.16.1.2" }]),
      ).rejects.toThrow("not a reserved HTTPS host");
  });
});
