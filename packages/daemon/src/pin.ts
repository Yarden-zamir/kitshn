// K-632: the tunnel's edge pin. cloudflared connects to two edge regions, and from some ISPs region 2 lands far
// away; every visitor of a card then takes that detour. The daemon measures both regions and pins the near one.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { resolve4 } from "node:dns/promises";

export const REGIONS = ["region1.v2.argotunnel.com", "region2.v2.argotunnel.com"] as const;
export const EDGE_PORT = 7844;
export const MEASURE_EVERY_MS = 6 * 60 * 60_000;
/** A pinned tunnel that says not ready this long loses the pin. */
export const PIN_GRACE_MS = 60_000;
export const READY_CHECK_MS = 30_000;
/** A longer gap between two checks means that the clock jumped, as after a wake from sleep. */
const CLOCK_JUMP_MS = 3 * READY_CHECK_MS;
const FASTER_BY_MS = 20;

/** One measurement: the best median connect time of each region, and the addresses that it measured. */
export interface Measurement {
  readonly ms: Readonly<Record<(typeof REGIONS)[number], number | null>>;
  readonly addresses: Readonly<Record<(typeof REGIONS)[number], ReadonlyArray<string>>>;
}

/** The pin that the tunnel service carries, or none. */
export interface PinState {
  readonly pin: { readonly region: (typeof REGIONS)[number]; readonly edges: ReadonlyArray<string> } | null;
  /** The result of the last measure with an answer, so a change needs two in a row. */
  readonly faster: (typeof REGIONS)[number] | null;
  /** The watch dropped the pin, and no measure has decided since. */
  readonly dropped: boolean;
}

export const NO_PIN: PinState = { pin: null, faster: null, dropped: false };

/** The region that is faster by at least 20 ms, or null. A region with no answer is never the faster one. */
export function fasterRegion(measurement: Measurement): (typeof REGIONS)[number] | null {
  const [a, b] = REGIONS.map((region) => measurement.ms[region]);
  if (a === null || b === null || a === undefined || b === undefined) return null;
  if (b - a >= FASTER_BY_MS) return REGIONS[0];
  if (a - b >= FASTER_BY_MS) return REGIONS[1];
  return null;
}

/**
 * K-632: a pin changes only when two measures in a row agree: on a region, which gets the pin, or on no faster region,
 * which removes it. A region that stays keeps its edges, because DNS rotates them. A measure with no answer changes
 * nothing.
 */
export function nextPin(state: PinState, measurement: Measurement): PinState {
  if (REGIONS.some((region) => measurement.ms[region] === null)) return state;
  const faster = fasterRegion(measurement);
  if (faster !== state.faster) return { ...state, faster };
  if (faster === null) return { pin: null, faster, dropped: false };
  const pin =
    state.pin?.region === faster
      ? state.pin
      : { region: faster, edges: measurement.addresses[faster].slice(0, 2) };
  return { pin, faster, dropped: false };
}

/** K-632: a drop while a measure ran wins, so that measure counts for nothing. */
export const afterMeasure = (started: PinState, current: PinState, measurement: Measurement): PinState =>
  JSON.stringify(started) === JSON.stringify(current) ? nextPin(current, measurement) : current;

/** The pin's tunnel flags: `--edge` per address and HTTP/2, because a pin with QUIC timed out in the test. */
export const pinArgs = (state: PinState): Array<string> =>
  state.pin === null
    ? []
    : [...state.pin.edges.flatMap((edge) => ["--edge", `${edge}:${EDGE_PORT}`]), "--protocol", "http2"];

/** Whether the tunnel has a connection, from cloudflared's `/ready` body; null when something else answered or nothing. */
export function readyFrom(body: string | null): boolean | null {
  try {
    const ready = (JSON.parse(body ?? "") as { readyConnections?: unknown }).readyConnections;
    return typeof ready === "number" ? ready > 0 : null;
  } catch {
    return null;
  }
}

export interface ReadyWatch {
  readonly notReadySince: number | null;
  readonly checkedAt: number;
}

/**
 * K-632: only an unbroken row of "not ready" for 60 seconds drops the pin. A ready tunnel, a read with no answer and a
 * clock jump each start the row again. The next measure can set the pin again.
 */
export function afterReadyCheck(
  state: PinState,
  ready: boolean | null,
  watch: ReadyWatch,
  now: number,
): { readonly state: PinState; readonly watch: ReadyWatch } {
  if (ready !== false || now - watch.checkedAt > CLOCK_JUMP_MS)
    return { state, watch: { notReadySince: null, checkedAt: now } };
  const notReadySince = watch.notReadySince ?? now;
  return state.pin !== null && now - notReadySince >= PIN_GRACE_MS
    ? { state: { ...state, pin: null, dropped: true }, watch: { notReadySince: null, checkedAt: now } }
    : { state, watch: { notReadySince, checkedAt: now } };
}

/** The current data center of each tunnel connection, from cloudflared's metrics: `hfa02 ×4`. Only for the names. */
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
export const locationsText = (counts: ReadonlyMap<string, number>, state: PinState) =>
  counts.size === 0
    ? null
    : `${[...counts].map(([location, count]) => `${location} ×${count}`).join(", ")}${
        state.pin !== null ? " (pinned)" : state.dropped ? " (pin dropped: no connection for 60 s)" : ""
      }`;

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
 * K-632: the metrics port of the tunnel. It moves only when the tunnel does not run and another program holds the port,
 * because cloudflared exits on a busy `--metrics` port. A read of the port decides nothing.
 */
export async function chooseMetricsPort(
  kept: number | null,
  running: boolean,
  isFree: (port: number) => Promise<boolean>,
  freePort: () => Promise<number>,
): Promise<number> {
  if (kept !== null && (running || (await isFree(kept)))) return kept;
  return freePort();
}

const removedMark = (data: string) => join(data, "tunnel-removed");

/** K-615: the owner removed this machine, so its tunnel service stays gone, also after a restart, until a new join. */
export const markTunnelRemoved = (data: string) => writeFileSync(removedMark(data), "");
export const clearTunnelRemoved = (data: string) => rmSync(removedMark(data), { force: true });
export const unlessTunnelRemoved = async (data: string, work: () => Promise<void>) => {
  if (!existsSync(removedMark(data))) await work();
};

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
          dropped: value.dropped === true,
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
