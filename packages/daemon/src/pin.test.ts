import { describe, expect, it } from "vitest";
import {
  type Measurement,
  NO_PIN,
  PIN_RETRY_MS,
  locationsText,
  nextPin,
  pinArgs,
  serverLocations,
} from "./pin.ts";
import { tunnelServiceFile } from "./service.ts";

const measured = (region1: number | null, region2: number | null): Measurement => ({
  ms: { "region1.v2.argotunnel.com": region1, "region2.v2.argotunnel.com": region2 },
  addresses: {
    "region1.v2.argotunnel.com": ["198.41.192.7", "198.41.192.27"],
    "region2.v2.argotunnel.com": ["198.41.200.13", "198.41.200.33"],
  },
});

describe("the tunnel's edge pin (K-632)", () => {
  it("pins a region that is 20 ms faster twice in a row, and drops the pin when no region is", () => {
    const once = nextPin(NO_PIN, measured(12, 60), 0);
    expect(once.pin).toBeNull();
    const twice = nextPin(once, measured(10, 55), 1);
    expect(twice.pin).toEqual({
      region: "region1.v2.argotunnel.com",
      edges: ["198.41.192.7", "198.41.192.27"],
    });
    expect(pinArgs(twice)).toEqual([
      "--edge",
      "198.41.192.7:7844",
      "--edge",
      "198.41.192.27:7844",
      "--protocol",
      "http2",
    ]);
    // 15 ms is no reason to pin, and a region with no answer never wins.
    expect(nextPin(twice, measured(40, 55), 2).pin).toBeNull();
    expect(nextPin(nextPin(NO_PIN, measured(null, 60), 0), measured(null, 60), 1).pin).toBeNull();
  });

  it("waits 24 hours after a failed pin before it pins again", () => {
    const failed = { pin: null, faster: "region1.v2.argotunnel.com" as const, failedAt: 1000 };
    expect(nextPin(failed, measured(10, 60), 1000 + PIN_RETRY_MS - 1).pin).toBeNull();
    expect(nextPin(failed, measured(10, 60), 1000 + PIN_RETRY_MS).pin).not.toBeNull();
  });

  it("reads the current data center of each connection from the metrics", () => {
    const metrics = [
      'cloudflared_tunnel_server_locations{connection_id="0",edge_location="hfa02"} 1',
      'cloudflared_tunnel_server_locations{connection_id="1",edge_location="fra08"} 0',
      'cloudflared_tunnel_server_locations{connection_id="1",edge_location="hfa02"} 1',
      "cloudflared_tunnel_ha_connections 2",
    ].join("\n");
    expect(locationsText(serverLocations(metrics), true)).toBe("hfa02 ×2 (pinned)");
    expect(locationsText(serverLocations(""), false)).toBeNull();
  });

  it("puts the metrics port and the pin into the tunnel service of each platform", () => {
    const pin = ["--edge", "198.41.192.7:7844", "--protocol", "http2"];
    expect(tunnelServiceFile("linux", "/c", "/t", {}, pin)).toContain(
      '"/c" --no-autoupdate tunnel --metrics 127.0.0.1:20290 --edge 198.41.192.7:7844 --protocol http2 run --token-file "/t"',
    );
    expect(tunnelServiceFile("darwin", "/c", "/t", {}, pin)).toContain(
      "<string>--edge</string><string>198.41.192.7:7844</string>",
    );
    expect(tunnelServiceFile("win32", "C:\\c.exe", "C:\\k\\t", { USERNAME: "ya" }, pin)).toContain(
      "tunnel --metrics 127.0.0.1:20290 --edge 198.41.192.7:7844 --protocol http2 run",
    );
  });
});
