// Section 20: game servers. A game card gates ports of one machine; a door opens them for one address for a time.

export type GameProto = "tcp" | "udp";

export interface GamePort {
  readonly port: number;
  readonly proto: GameProto;
}

/** K-2001: a game card, beside its resource of the kind `game`. */
export interface Game {
  readonly card: string;
  readonly machine: string;
  /** The address name, so the game address is `<name>.<zone>` and the join page `pages.<zone>/join/<name>`. */
  readonly name: string;
  readonly ports: ReadonlyArray<GamePort>;
  /** How long a door stays open. */
  readonly doorMs: number;
  /** K-2007: the SRV service (`minecraft` makes `_minecraft._tcp.<name>`), so a player types no port; null for none. */
  readonly srv: string | null;
  /** K-2008: the machine with a public address that carries the TCP ports of a machine behind NAT; null for none. */
  readonly relay: string | null;
}

/** K-2008: the hostname that the relay machine reaches the game through, on the tunnel of the game's machine. */
export const relayHost = (name: string, zone: string) => `${name}-relay.${zone}`;

/** K-2008: the machine whose firewall holds the doors of a game: its relay, or its own machine. */
export const doorMachine = (game: Pick<Game, "machine" | "relay">) => game.relay ?? game.machine;

/** K-2004: one open address of one person on one game card. */
export interface Door {
  readonly card: string;
  readonly person: string;
  /** An IPv4 address, or the `/64` of an IPv6 address. */
  readonly address: string;
  readonly openedAt: number;
  readonly endsAt: number;
}

export const HOUR_MS = 60 * 60_000;
export const DEFAULT_DOOR_MS = 12 * HOUR_MS;
export const MAX_DOOR_MS = 7 * 24 * HOUR_MS;
export const MAX_GAME_PORTS = 4;

/** K-2001: ports that machines use for kitshn and its neighbours, which a door must never close. */
export const RESERVED_GAME_PORTS: ReadonlyArray<GamePort & { readonly by: string }> = [
  { port: 41641, proto: "udp", by: "Tailscale" },
  { port: 3773, proto: "tcp", by: "T3 Code" },
];

/**
 * K-2001: a game name is one DNS label, 1 to 63 characters, so `mc` works. `join` stays free for the join path of
 * K-2003, and an id-shaped name for the ids of K-1003.
 */
export function gameNameError(name: string): string | null {
  if (name.length < 1 || name.length > 63) return "A game name has 1 to 63 characters.";
  const allowed = [...name].every(
    (char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-",
  );
  if (!allowed || name.startsWith("-") || name.endsWith("-"))
    return "A game name has only a to z, 0 to 9 and inner hyphens.";
  if (name === "join" || name === "login") return `kitshn keeps the name "${name}" for itself.`;
  return null;
}

/** K-2001: the fields of a new game card, or why kitshn refuses them. */
export function gameError(input: {
  readonly name: string;
  readonly ports: ReadonlyArray<GamePort>;
  readonly doorMs: number;
  readonly srv: string | null;
  readonly relay: string | null;
}): string | null {
  const name = gameNameError(input.name);
  if (name) return name;
  if (input.ports.length < 1 || input.ports.length > MAX_GAME_PORTS)
    return `A game card has 1 to ${MAX_GAME_PORTS} ports.`;
  for (const { port, proto } of input.ports) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return `A game port is a number from 1024 to 65535, not ${port}.`;
    if (proto !== "tcp" && proto !== "udp") return `A game port is tcp or udp, not ${String(proto)}.`;
  }
  const keys = input.ports.map(portKey);
  if (new Set(keys).size !== keys.length) return "A game card names each port once.";
  const reserved = RESERVED_GAME_PORTS.find((port) => keys.includes(portKey(port)));
  if (reserved) return `${portKey(reserved)} belongs to ${reserved.by}, so a game card cannot close it.`;
  if (!Number.isInteger(input.doorMs) || input.doorMs < HOUR_MS || input.doorMs > MAX_DOOR_MS)
    return "A door stays open from 1 hour to 7 days.";
  if (input.srv !== null && !/^[a-z0-9][a-z0-9-]{0,29}$/.test(input.srv))
    return "An SRV service is a name like minecraft: a to z, 0 to 9 and hyphens.";
  if (input.srv !== null && !input.ports.some((port) => port.proto === "tcp"))
    return "An SRV record needs a TCP port.";
  // A relay is a Cloudflare tunnel, which carries TCP only. One port keeps one relay host per game; revisit when a
  // game behind NAT needs a second TCP port.
  if (input.relay !== null && (input.ports.length !== 1 || input.ports[0]?.proto !== "tcp"))
    return "A game behind a relay has one TCP port.";
  return null;
}

/** K-2003: what a player types into the game: the host alone with an SRV record, else the host and the first port. */
export const joinAddress = (game: Pick<Game, "srv" | "ports">, host: string) =>
  game.srv !== null ? host : `${host}:${game.ports[0]?.port ?? ""}`;

/** K-2001: processes that are never a game, so a game card never closes a port that they listen on. */
const NOT_GAMES: ReadonlySet<string> = new Set(["sshd", "cloudflared", "kitshn", "tailscaled"]);

/**
 * K-2001: the running server (K-619) that a game card would close, or null. The game itself may listen already, so
 * only another service counts: one that answers HTTP (a game server does not) or a process that is never a game.
 * Known limit: the report lists TCP only, so a UDP port of another service is not seen.
 */
export function busyPort<
  Server extends { readonly port: number; readonly process: string | null; readonly status: number | null },
>(ports: ReadonlyArray<GamePort>, servers: ReadonlyArray<Server>): Server | null {
  return (
    servers.find(
      (server) =>
        ports.some((port) => port.proto === "tcp" && port.port === server.port) &&
        (server.status !== null || NOT_GAMES.has(server.process ?? "")),
    ) ?? null
  );
}

export const portKey = ({ port, proto }: GamePort) => `${port}/${proto}`;

/** `25565/tcp` or `19132/udp`; a port without a protocol is tcp. */
export function parsePort(text: string): GamePort | null {
  const [number = "", proto = "tcp"] = text.trim().toLowerCase().split("/");
  if (!/^\d{1,5}$/.test(number) || (proto !== "tcp" && proto !== "udp")) return null;
  return { port: Number(number), proto };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The 8 groups of an IPv6 address, or null. Embedded IPv4 forms are not taken. */
function ipv6Groups(text: string): Array<number> | null {
  if (!/^[0-9a-f:]+$/i.test(text) || text.length > 39) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (value: string) => (value === "" ? [] : value.split(":"));
  const head = part(halves[0] ?? "");
  const tail = halves.length === 2 ? part(halves[1] ?? "") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * K-2004: the address that a door opens for a seen address, or why kitshn refuses it. IPv4 opens one address;
 * IPv6 opens its `/64`, because one home gets a `/64` and its devices change their address inside it. A private,
 * shared, loopback or link-local address is refused: no game client on the internet comes from there.
 */
export function doorAddress(seen: string): { address: string; family: 4 | 6 } | { error: string } {
  const text = seen.trim().toLowerCase();
  const v4 = IPV4.exec(text);
  if (v4) {
    const parts = v4.slice(1, 5).map(Number);
    if (parts.some((part) => part > 255)) return { error: `${seen} is no IPv4 address.` };
    const [a = 0, b = 0] = parts;
    const unusable =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (unusable)
      return { error: `${seen} is a private or special address, which no game client comes from.` };
    return { address: parts.join("."), family: 4 };
  }
  const groups = ipv6Groups(text);
  if (!groups) return { error: `${seen} is no IP address.` };
  const [first = 0] = groups;
  // Only global unicast (2000::/3) reaches a game server from the internet.
  if (first < 0x2000 || first > 0x3fff)
    return { error: `${seen} is a private or special address, which no game client comes from.` };
  const prefix = groups.slice(0, 4).map((group) => group.toString(16));
  return { address: `${prefix.join(":")}::/64`, family: 6 };
}

export const doorFamily = (address: string): 4 | 6 => (address.includes(":") ? 6 : 4);

/**
 * K-2004: the doors that a person keeps per card and family. A home network can leave through more than one public
 * IPv4 address, chosen per destination, so one door per family is not enough.
 */
export const DOOR_LIMITS: Readonly<Record<4 | 6, number>> = { 4: 4, 6: 2 };

/**
 * K-2004: the doors after a person opens `addresses` on a card. A new address adds a door, and an address that is
 * open already gets a new end. Past the limit of its family, the oldest door of that family closes. `addresses` come
 * first in the order that they win, so the address that kitshn sees goes first. A share that ends closes the door
 * through K-2005, so the door time does not look at the card's end.
 */
export function openDoors(
  current: ReadonlyArray<Door>,
  game: Game,
  person: string,
  addresses: ReadonlyArray<string>,
  now: number,
): { readonly open: ReadonlyArray<Door>; readonly close: ReadonlyArray<string> } {
  const endsAt = now + game.doorMs;
  const fresh = [...new Set(addresses)];
  const older = current
    .filter(
      (door) =>
        door.card === game.card &&
        door.person === person &&
        door.endsAt > now &&
        !fresh.includes(door.address),
    )
    .sort((a, b) => b.openedAt - a.openedAt)
    .map((door) => door.address);
  const kept = new Set<string>();
  for (const family of [4, 6] as const)
    [...fresh, ...older]
      .filter((address) => doorFamily(address) === family)
      .slice(0, DOOR_LIMITS[family])
      .forEach((address) => kept.add(address));
  return {
    open: fresh
      .filter((address) => kept.has(address))
      .map((address) => ({ card: game.card, person, address, openedAt: now, endsAt })),
    close: older.filter((address) => !kept.has(address)),
  };
}

/** K-2005: what the daemon of a machine puts into its firewall: the game ports, and each open door with its end. */
export interface DoorPlan {
  readonly ports: ReadonlyArray<GamePort>;
  /** K-2004, K-2009: the ports of games open to all. Nothing gates them; a Windows PC still forwards them on its router. */
  readonly openPorts: ReadonlyArray<GamePort>;
  /** K-2008: the games that this machine relays: it listens on `port` and carries it to `hostname`. */
  readonly relays: ReadonlyArray<{ readonly hostname: string; readonly port: number }>;
  readonly doors: ReadonlyArray<{
    readonly address: string;
    readonly ports: ReadonlyArray<GamePort>;
    readonly endsAt: number;
  }>;
}

/**
 * K-2005: the plan of one machine. The ports of a game in `openToAll` (K-2004) leave the gated set, so every address
 * reaches them; a port that a gated game also names stays gated, so the plan still fails closed.
 */
export function doorPlan(
  machine: string,
  games: ReadonlyArray<Game>,
  doors: ReadonlyArray<Door>,
  now: number,
  zone: string,
  openToAll: ReadonlySet<string>,
): DoorPlan {
  const mine = games.filter((game) => doorMachine(game) === machine);
  const gated = mine.filter((game) => !openToAll.has(game.card));
  const ports = new Map(gated.flatMap((game) => game.ports).map((port) => [portKey(port), port]));
  // One entry per address and port; two people behind one address, or two cards, keep the later end.
  const open = new Map<string, { address: string; port: GamePort; endsAt: number }>();
  for (const door of doors) {
    const game = gated.find((item) => item.card === door.card);
    if (!game || door.endsAt <= now) continue;
    for (const port of game.ports) {
      const key = `${door.address} ${portKey(port)}`;
      const seen = open.get(key);
      if (!seen || seen.endsAt < door.endsAt)
        open.set(key, { address: door.address, port, endsAt: door.endsAt });
    }
  }
  const byAddress = new Map<string, { address: string; ports: Array<GamePort>; endsAt: number }>();
  for (const { address, port, endsAt } of open.values()) {
    const key = `${address} ${endsAt}`;
    const entry = byAddress.get(key) ?? { address, ports: [], endsAt };
    entry.ports.push(port);
    byAddress.set(key, entry);
  }
  const byPort = (a: GamePort, b: GamePort) => a.port - b.port || a.proto.localeCompare(b.proto);
  const openPorts = new Map(
    mine
      .filter((game) => openToAll.has(game.card))
      .flatMap((game) => game.ports)
      .filter((port) => !ports.has(portKey(port)))
      .map((port) => [portKey(port), port]),
  );
  return {
    ports: [...ports.values()].sort(byPort),
    openPorts: [...openPorts.values()].sort(byPort),
    relays: mine.flatMap((game) =>
      game.relay === machine && game.ports[0]
        ? [{ hostname: relayHost(game.name, zone), port: game.ports[0].port }]
        : [],
    ),
    doors: [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address) || a.endsAt - b.endsAt),
  };
}
