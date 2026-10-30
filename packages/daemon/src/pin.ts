// K-632: the tunnel's edge pin. cloudflared connects to two edge regions, and from some ISPs region 2 lands far
// away; every visitor of a card then takes that detour. The daemon measures both regions and pins the near one.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { resolve4 } from "node:dns/promises";

export const REGIONS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"] as const;
export const EDGE_PORT = 7844;
export const MEASURE_EVERY_MS = 6 * 60 * 60_000;
/** A pinned tunnel with no connection for this long loses the pin. */
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
  // A measure with no answer says nothing about the regions, so it changes nothing.
  if (REGIONS.some((region) => measurement.ms[region] === null)) return state;
  const faster = fasterRegion(measurement);
  // DNS rotates the addresses of a region, so the same region keeps its edges and the tunnel keeps running.
  if (faster !== null && state.pin?.region === faster) return { ...state, faster };
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

/** K-632: drops the pin after PIN_GRACE_MS without a connection, also for a kept pin and a connection that went. */
export function afterConnectionCheck(
  state: PinState,
  connected: boolean,
  lastConnected: number,
  now: number,
): { readonly state: PinState; readonly lastConnected: number } {
  if (connected) return { state, lastConnected: now };
  return state.pin !== null && now - lastConnected >= PIN_GRACE_MS
    ? { state: { pin: null, faster: null, failedAt: now }, lastConnected: now }
    : { state, lastConnected };
}

/**
 * The current data center of each tunnel connection, from cloudflared's metrics: `hfa02 ×4`. Empty with no connection:
 * the location gauge keeps its last value after a disconnect, so `ha_connections` decides.
 */
export function serverLocations(metrics: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = metrics.split("\n");
  if (!lines.some((line) => /^cloudflared_tunnel_ha_connections [1-9]/.test(line))) return counts;
  for (const line of lines) {
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

/**
 * K-632: the metrics port of the tunnel. The kept port stays while it is free or the tunnel holds it, so the service file
 * stays the same; a port that another program took gets a new one, because cloudflared exits on a busy `--metrics` port.
 * Known limit: another cloudflared on the kept port looks like ours. Revisit when two kitshn users share a machine.
 */
export async function chooseMetricsPort(
  kept: number | null,
  isFree: (port: number) => Promise<boolean>,
  isTunnel: (port: number) => Promise<boolean>,
  freePort: () => Promise<number>,
): Promise<number> {
  if (kept !== null && ((await isFree(kept)) || (await isTunnel(kept)))) return kept;
  return freePort();
}

/** Listens on `port` (0 picks a free one) and gives the port back, or null when it is busy. */
export const bindMetricsPort = (port: number) =>
  new Promise<number | null>((done) => {
    const server = createServer();
    server.once("error", () => done(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address !== null ? address.port : null));
    });
  });

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
