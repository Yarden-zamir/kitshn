import { describe, expect, it } from "vitest";
import { type PortCard, HOUR_MS, busyPort, doorAddress, doorPlan, portCardError, openDoors } from "./port.ts";

const portCard: PortCard = {
  card: "c1",
  machine: "vps",
  name: "mc",
  ports: [{ port: 25565, proto: "tcp" }],
  doorMs: HOUR_MS,
  srv: null,
  relay: null,
};

describe("doorAddress (K-2005)", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:DB8:1:2:aaaa::1", "2001:db8:1:2::/64"],
    ["2602:ff16:6:105c::1", "2602:ff16:6:105c::/64"],
    ["10.1.2.3", null],
    ["100.64.0.1", null],
    ["172.31.0.1", null],
    ["192.168.1.1", null],
    ["127.0.0.1", null],
    ["fe80::1", null],
    ["fd00::1", null],
    ["::1", null],
    ["256.1.1.1", null],
    ["1.2.3", null],
    ["::ffff:1.2.3.4", null],
  ])("%s opens %s", (seen, address) => {
    const door = doorAddress(seen);
    expect("error" in door ? null : door.address).toBe(address);
  });
});

describe("portCardError (K-2001, K-2009)", () => {
  const ok = { name: "mc", ports: portCard.ports, doorMs: HOUR_MS, srv: null, relay: null };
  it.each([
    [{}, null],
    [{ name: "connect" }, /keeps the name/],
    [{ ports: [] }, /1 to 4 ports/],
    [{ ports: [{ port: 80, proto: "tcp" }] }, /1024 to 65535/],
    [{ ports: [portCard.ports[0], portCard.ports[0]] }, /each port once/],
    [{ doorMs: 8 * 24 * HOUR_MS }, /1 hour to 7 days/],
    [{ srv: "Mine craft" }, /SRV service/],
    [{ srv: "minecraft", ports: [{ port: 19132, proto: "udp" }] }, /needs a TCP port/],
    [{ relay: "vps", ports: [{ port: 19132, proto: "udp" }] }, /one TCP port/],
    [{ ports: [{ port: 41641, proto: "udp" }] }, /belongs to Tailscale/],
  ])("%o gives %s", (change, error) => {
    const result = portCardError({ ...ok, ...change } as typeof ok);
    if (error === null) expect(result).toBeNull();
    else expect(result).toMatch(error);
  });
});

it.each([
  [{ port: 25565, process: "java", status: null }, null],
  [{ port: 25565, process: "node", status: 200 }, 25565],
  [{ port: 25565, process: "sshd", status: null }, 25565],
  [{ port: 8080, process: "node", status: 200 }, null],
])("a running server %o makes the gated port 25565/tcp busy: %s (K-2001)", (server, busy) => {
  expect(busyPort([{ port: 25565, proto: "tcp" }], [{ title: null, ...server }])?.port ?? null).toBe(busy);
});

describe("openDoors (K-2005)", () => {
  const door = (address: string, openedAt: number, person = "a@x") => ({
    card: "c1",
    person,
    address,
    openedAt,
    endsAt: openedAt + 10_000,
  });
  const opened = (address: string) => ({
    card: "c1",
    person: "a@x",
    address,
    openedAt: 1000,
    endsAt: 1000 + HOUR_MS,
  });

  it("adds a door per new address and keeps the doors of both families", () => {
    const current = [door("203.0.113.9", 0), door("2001:db8:1:2::/64", 0), door("198.51.100.1", 0, "b@x")];
    const { open, close } = openDoors(current, portCard, "a@x", ["203.0.113.10", "198.51.100.7"], 1000);
    expect(close).toEqual([]);
    expect(open).toEqual([opened("203.0.113.10"), opened("198.51.100.7")]);
  });

  it("closes the oldest door of a family past its limit", () => {
    const current = [1, 2, 3, 4].map((n) => door(`203.0.113.${n}`, n));
    const v6 = [door("2001:db8:1::/64", 1), door("2001:db8:2::/64", 2)];
    const { open, close } = openDoors(
      [...current, ...v6],
      portCard,
      "a@x",
      ["203.0.113.5", "2001:db8:3::/64"],
      1000,
    );
    expect(open).toEqual([opened("203.0.113.5"), opened("2001:db8:3::/64")]);
    expect(close).toEqual(["203.0.113.1", "2001:db8:1::/64"]);
  });

  it("gives an open address a new end instead of a second door", () => {
    const current = [1, 2, 3, 4].map((n) => door(`203.0.113.${n}`, n));
    const { open, close } = openDoors(current, portCard, "a@x", ["203.0.113.1"], 1000);
    expect(open).toEqual([opened("203.0.113.1")]);
    expect(close).toEqual([]);
  });
});

it("the plan of a machine holds each door of a person, merges doors per address, keeps the later end, and follows a relay (K-2006, K-2009)", () => {
  const second: PortCard = { ...portCard, card: "c2", ports: [{ port: 7777, proto: "tcp" }], relay: "relay" };
  const doors = [
    { card: "c1", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 5000 },
    { card: "c1", person: "b@x", address: "203.0.113.9", openedAt: 0, endsAt: 9000 },
    { card: "c1", person: "c@x", address: "198.51.100.1", openedAt: 0, endsAt: 500 },
    { card: "c1", person: "a@x", address: "198.51.100.2", openedAt: 0, endsAt: 5000 },
    { card: "c2", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 9000 },
  ];
  expect(doorPlan("vps", [portCard, second], doors, 1000, "example.com", new Set())).toEqual({
    ports: [{ port: 25565, proto: "tcp" }],
    relays: [],
    doors: [
      { address: "198.51.100.2", ports: [{ port: 25565, proto: "tcp" }], endsAt: 5000 },
      { address: "203.0.113.9", ports: [{ port: 25565, proto: "tcp" }], endsAt: 9000 },
    ],
  });
  expect(doorPlan("relay", [portCard, second], doors, 1000, "example.com", new Set())).toMatchObject({
    ports: [{ port: 7777, proto: "tcp" }],
    relays: [{ hostname: "mc-relay.example.com", port: 7777 }],
  });
});

it("takes the ports of an open-to-all port card out of the gated set, and keeps a port that a gated port card names (K-2005)", () => {
  const second: PortCard = {
    ...portCard,
    card: "c2",
    ports: [
      { port: 25565, proto: "tcp" },
      { port: 7777, proto: "tcp" },
    ],
  };
  const doors = [
    { card: "c1", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 9000 },
    { card: "c2", person: "a@x", address: "198.51.100.2", openedAt: 0, endsAt: 9000 },
  ];
  expect(doorPlan("vps", [portCard, second], doors, 1000, "example.com", new Set(["c2"]))).toEqual({
    ports: [{ port: 25565, proto: "tcp" }],
    relays: [],
    doors: [{ address: "203.0.113.9", ports: [{ port: 25565, proto: "tcp" }], endsAt: 9000 }],
  });
  expect(doorPlan("vps", [portCard], doors, 1000, "example.com", new Set(["c1"]))).toEqual({
    ports: [],
    relays: [],
    doors: [],
  });
});
