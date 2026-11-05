// Section 20: the rows, records and status fields of port cards, for the Durable Object.
import { type Door, type PortCard, type ServicePort, doorAddress, doorMachine } from "../core/port.ts";
import type { MachineStatus } from "../core/machine.ts";

export interface PortRow extends Record<string, SqlStorageValue> {
  card_id: string;
  machine_id: string;
  name: string;
  ports: string;
  door_ms: number;
  srv: string | null;
  relay_id: string | null;
  v4: string | null;
  v6: string | null;
}

export interface DoorRow extends Record<string, SqlStorageValue> {
  card_id: string;
  person: string;
  address: string;
  opened_at: number;
  ends_at: number;
  /** K-2006: the address that opened the door, for the share check of `closeLostDoors`. */
  seen_ip: string | null;
}

export interface PortRecordRow extends Record<string, SqlStorageValue> {
  type: string;
  name: string;
  card_id: string;
  content: string;
  record_id: string;
  error: string | null;
  retry_at: number;
}

export const portOf = (row: PortRow): PortCard => ({
  card: row.card_id,
  machine: row.machine_id,
  name: row.name,
  ports: JSON.parse(row.ports) as Array<ServicePort>,
  doorMs: row.door_ms,
  srv: row.srv,
  relay: row.relay_id,
});

export const doorOf = (row: DoorRow): Door => ({
  card: row.card_id,
  person: row.person,
  address: row.address,
  openedAt: row.opened_at,
  endsAt: row.ends_at,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** K-2003, K-2007: the port card fields of a daemon status, checked; a bad field is left out. */
export function portStatus(
  raw: Record<string, unknown>,
): Pick<MachineStatus, "publicAddresses" | "doorsProblem" | "listening" | "hostFirewall" | "relays"> {
  const address = (value: unknown, family: 4 | 6) => {
    if (typeof value !== "string" || value.length > 45) return null;
    const door = doorAddress(value);
    return "error" in door || door.family !== family ? null : value;
  };
  const found = raw["publicAddresses"];
  const problem = raw["doorsProblem"];
  const listening = raw["listening"];
  return {
    ...(isRecord(found)
      ? { publicAddresses: { v4: address(found["v4"], 4), v6: address(found["v6"], 6) } }
      : {}),
    ...(typeof problem === "string" ? { doorsProblem: problem.slice(0, 200) } : {}),
    ...(typeof raw["hostFirewall"] === "string" ? { hostFirewall: raw["hostFirewall"].slice(0, 400) } : {}),
    ...(Array.isArray(raw["relays"])
      ? {
          relays: raw["relays"]
            .filter((item): item is string => typeof item === "string" && item.length <= 300)
            .slice(0, 40),
        }
      : {}),
    ...(Array.isArray(listening)
      ? {
          listening: listening
            .filter((item): item is string => typeof item === "string" && /^\d{1,5}\/(tcp|udp)$/.test(item))
            .slice(0, 40),
        }
      : {}),
  };
}

/** K-2008: one DNS record of a port card. `content` of an SRV record is `priority weight port target`. */
export interface PortRecord {
  readonly type: "A" | "AAAA" | "SRV";
  readonly name: string;
  readonly card: string;
  readonly content: string;
}

/** K-2008: the records that the port cards want: A and AAAA to the door machine, and SRV to the first TCP port. */
export function portRecords(rows: ReadonlyArray<PortRow>, zone: string): Array<PortRecord> {
  return rows.flatMap((row): Array<PortRecord> => {
    const host = `${row.name}.${zone}`;
    const tcp = portOf(row).ports.find((port) => port.proto === "tcp");
    return [
      ...(row.v4 ? [{ type: "A" as const, name: host, card: row.card_id, content: row.v4 }] : []),
      // A relay listens on IPv4 only (cloudflared access tcp has one listener); revisit if players need IPv6 there.
      ...(row.v6 && !row.relay_id
        ? [{ type: "AAAA" as const, name: host, card: row.card_id, content: row.v6 }]
        : []),
      ...(row.srv && tcp
        ? [
            {
              type: "SRV" as const,
              name: `_${row.srv}._tcp.${host}`,
              card: row.card_id,
              content: `0 5 ${tcp.port} ${host}`,
            },
          ]
        : []),
    ];
  });
}

/** K-2008: the Cloudflare body of a record. Port traffic is not HTTP, so no record is proxied. */
export function recordBody(record: PortRecord) {
  const comment = `kitshn port card ${record.card} (K-2008)`;
  if (record.type !== "SRV")
    return {
      type: record.type,
      name: record.name,
      content: record.content,
      proxied: false,
      ttl: 300,
      comment,
    };
  const [priority, weight, port, target] = record.content.split(" ");
  return {
    type: "SRV",
    name: record.name,
    data: { priority: Number(priority), weight: Number(weight), port: Number(port), target },
    ttl: 300,
    comment,
  };
}

/** K-2003: the port card rows whose door machine is `machineId`, so a new public address moves their records. */
export const portsOn = (rows: ReadonlyArray<PortRow>, machineId: string) =>
  rows.filter((row) => doorMachine(portOf(row)) === machineId);
