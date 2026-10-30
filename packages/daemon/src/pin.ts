// K-632: the tunnel's edge pin. cloudflared connects to two edge regions, and from some ISPs region 2 lands far
// away; every visitor of a card then takes that detour. The daemon measures both regions and pins the near one.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve4 } from "node:dns/promises";

export const REGIONS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"] as const;
export const EDGE_PORT = 7844;
/** The tunnel's own metrics port, so the daemon reads its data centers (and no other cloudflared's). */
export const TUNNEL_METRICS = "127.0.0.1:20290";
export const MEASURE_EVERY_MS = 6 * 60 * 60_000;
/** A pinned tunnel with no connection this long after its start loses the pin. */
export const PIN_GRACE_MS = 60_000;
/** After a failed pin, the daemon tries a pin again only after this time. */
export const PIN_RETRY_MS = 24 * 60 * 60_000;
const FASTER_BY_MS = 20;

/** One measurement: the best median connect time of each region, and the addresses that it measured. */
export interface Measurement {
  readonly ms: Readonly<Record<(typeof REGIONS)[number], number | null>>;
  readonly addresses: Readonly<Record<(typeof REGIONS)[number], ReadonlyArray<string>>>;
}

/** The pin that the tunnel service carries, or none. */
export interface PinState {
  readonly pin: { readonly region: (typeof REGIONS)[number]; readonly edges: ReadonlyArray<string> } | null;
  /** The region that was faster in the last measurement, so a pin needs two in a row. */
  readonly faster: (typeof REGIONS)[number] | null;
  /** When a pin failed, so the next try waits PIN_RETRY_MS. */
  readonly failedAt: number | null;
}

export const NO_PIN: PinState = { pin: null, faster: null, failedAt: null };

/** The region that is faster by at least 20 ms, or null. A region with no answer is never the faster one. */
export function fasterRegion(measurement: Measurement): (typeof REGIONS)[number] | null {
  const [a, b] = REGIONS.map((region) => measurement.ms[region]);
  if (a === null || b === null || a === undefined || b === undefined) return null;
  if (b - a >= FASTER_BY_MS) return REGIONS[0];
  if (a - b >= FASTER_BY_MS) return REGIONS[1];
  return null;
}

/**
 * K-632: the next pin state after a measurement: a region that is faster twice in a row gets the pin; no faster
 * region removes it; a pin that failed waits 24 hours.
 */
export function nextPin(state: PinState, measurement: Measurement, now: number): PinState {
  const faster = fasterRegion(measurement);
  if (faster === null) return { ...state, pin: null, faster: null };
  const waiting = state.failedAt !== null && now - state.failedAt < PIN_RETRY_MS;
  if (faster !== state.faster || waiting) return { ...state, faster, pin: waiting ? null : state.pin };
  const edges = measurement.addresses[faster].slice(0, 2);
  return edges.length === 0
    ? { ...state, faster }
    : { pin: { region: faster, edges }, faster, failedAt: null };
}

/** The pin's tunnel flags: `--edge` per address and HTTP/2, because a pin with QUIC timed out in the test. */
export const pinArgs = (state: PinState): Array<string> =>
  state.pin === null
    ? []
    : [...state.pin.edges.flatMap((edge) => ["--edge", `${edge}:${EDGE_PORT}`]), "--protocol", "http2"];

/** The current data center of each tunnel connection, from cloudflared's metrics: `hfa02 ×4`. */
export function serverLocations(metrics: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of metrics.split("\n")) {
    if (!line.startsWith("cloudflared_tunnel_server_locations{")) continue;
    const location = /edge_location="([a-z0-9]+)"/.exec(line)?.[1];
    if (location && line.trim().endsWith(" 1")) counts.set(location, (counts.get(location) ?? 0) + 1);
  }
  return counts;
}

/** The status text of the tunnel's data centers, for example `hfa02 ×4 (pinned)`. */
export const locationsText = (counts: ReadonlyMap<string, number>, pinned: boolean) =>
  counts.size === 0
    ? null
    : `${[...counts].map(([location, count]) => `${location} ×${count}`).join(", ")}${pinned ? " (pinned)" : ""}`;

/** One TCP connect, in milliseconds, or null after 3 seconds or an error. */
function connectMs(address: string): Promise<number | null> {
  return new Promise((done) => {
    const start = performance.now();
    const socket = connect({ host: address, port: EDGE_PORT, timeout: 3000 });
    const finish = (ms: number | null) => {
      socket.destroy();
      done(ms);
    };
    socket.once("connect", () => finish(performance.now() - start));
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
  });
}

const median = (values: ReadonlyArray<number>) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** K-632: three connects to two addresses of each region; a region's time is its best median. */
export async function measureRegions(): Promise<Measurement> {
  const entries = await Promise.all(
    REGIONS.map(async (region) => {
      const addresses = (await resolve4(region).catch(() => [])).slice(0, 2);
      const medians: Array<number> = [];
      for (const address of addresses) {
        const times: Array<number> = [];
        for (let i = 0; i < 3; i++) {
          const ms = await connectMs(address);
          if (ms !== null) times.push(ms);
        }
        if (times.length > 0) medians.push(median(times) ?? 0);
      }
      return [region, medians.length === 0 ? null : Math.min(...medians), addresses] as const;
    }),
  );
  const [first, second] = entries;
  return {
    ms: { [REGIONS[0]]: first?.[1] ?? null, [REGIONS[1]]: second?.[1] ?? null },
    addresses: { [REGIONS[0]]: first?.[2] ?? [], [REGIONS[1]]: second?.[2] ?? [] },
  };
}

export function readPin(file: string): PinState {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PinState>;
    const pin = value.pin;
    const ok =
      pin === null ||
      (typeof pin === "object" &&
        pin !== undefined &&
        (REGIONS as ReadonlyArray<string>).includes(pin.region) &&
        Array.isArray(pin.edges) &&
        pin.edges.every((edge) => typeof edge === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(edge)));
    return ok
      ? {
          pin: pin ?? null,
          faster: (REGIONS as ReadonlyArray<string>).includes(value.faster ?? "")
            ? (value.faster ?? null)
            : null,
          failedAt: typeof value.failedAt === "number" ? value.failedAt : null,
        }
      : NO_PIN;
  } catch {
    return NO_PIN;
  }
}

export function writePin(file: string, state: PinState) {
  writeFileSync(`${file}.new`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}
