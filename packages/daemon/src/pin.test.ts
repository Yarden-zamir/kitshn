import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type Measurement,
  NO_PIN,
  PIN_GRACE_MS,
  type ReadyWatch,
  afterMeasure,
  afterReadyCheck,
  chooseMetricsPort,
  clearTunnelRemoved,
  markTunnelRemoved,
  readyFrom,
  unlessTunnelRemoved,
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

const pinned = () => nextPin(nextPin(NO_PIN, measured(10, 60)), measured(10, 60));

describe("the tunnel's edge pin (K-632)", () => {
  it("pins a region that is 20 ms faster twice in a row, and drops the pin when no region is", () => {
    const once = nextPin(NO_PIN, measured(12, 60));
    expect(once.pin).toBeNull();
    const twice = nextPin(once, measured(10, 55));
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
    // A region with no answer never wins.
    expect(nextPin(nextPin(NO_PIN, measured(null, 60)), measured(null, 60)).pin).toBeNull();
  });

  it("keeps the edges of a region that stays the pin, because DNS rotates its addresses", () => {
    const rotated: Measurement = {
      ...measured(10, 60),
      addresses: {
        "region1.v2.argotunnel.com": ["198.41.192.99", "198.41.192.98"],
        "region2.v2.argotunnel.com": [],
      },
    };
    expect(pinArgs(nextPin(pinned(), rotated))).toEqual(pinArgs(pinned()));
  });

  it("keeps the pin and the count through a measure with no answer", () => {
    const state = pinned();
    expect(nextPin(state, measured(null, null))).toBe(state);
    expect(nextPin(state, measured(null, 60))).toBe(state);
  });

  it("removes a pin only after two measures with no faster region", () => {
    const once = nextPin(pinned(), measured(40, 55));
    expect(once.pin).not.toBeNull();
    expect(nextPin(once, measured(10, 60)).pin).not.toBeNull();
    expect(nextPin(once, measured(40, 55)).pin).toBeNull();
  });

  it("moves a pin only after two measures with the other region faster", () => {
    const once = nextPin(pinned(), measured(60, 10));
    expect(once.pin?.region).toBe("region1.v2.argotunnel.com");
    expect(nextPin(once, measured(60, 10)).pin?.region).toBe("region2.v2.argotunnel.com");
  });

  it("reads connected from /ready, and anything else as no answer", () => {
    expect(readyFrom('{"status":200,"readyConnections":1,"connectorId":"a"}')).toBe(true);
    expect(readyFrom('{"status":503,"readyConnections":0,"connectorId":"a"}')).toBe(false);
    expect(readyFrom(null)).toBeNull();
    expect(readyFrom("<html>another program</html>")).toBeNull();
    expect(readyFrom('{"ok":true}')).toBeNull();
  });

  it("drops a pin only after an unbroken 60 seconds of not ready, whenever the connection went", () => {
    const state = pinned();
    const step = (watch: ReadyWatch, ready: boolean | null, now: number) =>
      afterReadyCheck(state, ready, watch, now);
    const start: ReadyWatch = { notReadySince: null, checkedAt: 0 };
    const first = step(start, false, 30_000);
    expect(first.state).toBe(state);
    expect(step(first.watch, false, 30_000 + PIN_GRACE_MS - 1).state).toBe(state);
    expect(step(first.watch, false, 30_000 + PIN_GRACE_MS).state).toEqual({
      ...state,
      pin: null,
      dropped: true,
    });
    // A ready tunnel and a read with no answer both start the count again.
    for (const ready of [true, null]) {
      const again = step(first.watch, ready, 60_000);
      expect(again.state).toBe(state);
      expect(step(again.watch, false, 90_000).state).toBe(state);
    }
  });

  it("drops nothing on the first check after a clock jump, such as a wake from sleep", () => {
    const state = pinned();
    const asleep: ReadyWatch = { notReadySince: 0, checkedAt: 30_000 };
    const woken = afterReadyCheck(state, false, asleep, 8 * 60 * 60_000);
    expect(woken.state).toBe(state);
    expect(woken.watch.notReadySince).toBeNull();
  });

  it("keeps a dropped pin off until the next measure, says why, and clears the reason then", () => {
    const dropped = { ...pinned(), pin: null, dropped: true };
    expect(locationsText(new Map([["fra08", 4]]), dropped)).toContain("pin dropped");
    const next = nextPin(dropped, measured(10, 60));
    expect(next.pin).not.toBeNull();
    expect(next.dropped).toBe(false);
  });

  it("lets a drop win over a measure that was running", () => {
    const started = pinned();
    const current = { ...started, pin: null, dropped: true };
    expect(afterMeasure(started, current, measured(10, 60))).toBe(current);
    expect(afterMeasure(started, started, measured(40, 55)).faster).toBeNull();
  });

  it("moves the metrics port only when the tunnel does not run and the port is busy", async () => {
    const choose = (kept: number | null, running: boolean, free: boolean) =>
      chooseMetricsPort(
        kept,
        running,
        async () => free,
        async () => 50000,
      );
    expect(await choose(40000, true, false)).toBe(40000);
    expect(await choose(40000, false, true)).toBe(40000);
    expect(await choose(40000, false, false)).toBe(50000);
    expect(await choose(null, true, false)).toBe(50000);
  });

  it("never brings back the tunnel of a removed machine, until a new join", async () => {
    const data = mkdtempSync(join(tmpdir(), "kitshn-removed-"));
    using _cleanup = { [Symbol.dispose]: () => rmSync(data, { recursive: true }) };
    const work = vi.fn(async () => {});
    await unlessTunnelRemoved(data, work);
    expect(work).toHaveBeenCalledTimes(1);
    markTunnelRemoved(data);
    await unlessTunnelRemoved(data, work);
    expect(work).toHaveBeenCalledTimes(1);
    clearTunnelRemoved(data);
    await unlessTunnelRemoved(data, work);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("reads the current data center of each connection from the metrics", () => {
    const metrics = [
      'cloudflared_tunnel_server_locations{connection_id="0",edge_location="hfa02"} 1',
      'cloudflared_tunnel_server_locations{connection_id="1",edge_location="fra08"} 0',
      'cloudflared_tunnel_server_locations{connection_id="1",edge_location="hfa02"} 1',
    ].join("\n");
    expect(locationsText(serverLocations(metrics), pinned())).toBe("hfa02 ×2 (pinned)");
    expect(locationsText(serverLocations(""), NO_PIN)).toBeNull();
  });

  it("puts the metrics port and the pin into the tunnel service of each platform", () => {
    const pin = ["--metrics", "127.0.0.1:49152", "--edge", "198.41.192.7:7844", "--protocol", "http2"];
    expect(tunnelServiceFile("linux", "/c", "/t", {}, pin)).toContain(
      '"/c" --no-autoupdate tunnel --metrics 127.0.0.1:49152 --edge 198.41.192.7:7844 --protocol http2 run --token-file "/t"',
    );
    expect(tunnelServiceFile("darwin", "/c", "/t", {}, pin)).toContain(
      "<string>--edge</string><string>198.41.192.7:7844</string>",
    );
    expect(tunnelServiceFile("win32", "C:\\c.exe", "C:\\k\\t", { USERNAME: "ya" }, pin)).toContain(
      "tunnel --metrics 127.0.0.1:49152 --edge 198.41.192.7:7844 --protocol http2 run",
    );
  });
});
