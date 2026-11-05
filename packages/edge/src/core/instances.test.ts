import { describe, expect, it } from "vitest";
import {
  type Candidate,
  cardInstances,
  instanceAddress,
  placeMachines,
  placementDrift,
  primaryInstance,
  spreadRefusal,
} from "./instances.ts";

const machine = (id: string, order: number, more: Partial<Candidate> = {}): Candidate => ({
  id,
  order,
  fit: "yes",
  spreadReady: true,
  load: null,
  ...more,
});

describe("placement (K-823, K-825)", () => {
  const a = machine("a", 1, { load: 0.9 });
  const b = machine("b", 2, { load: 0.1 });
  const c = machine("c", 3, { load: 0.5 });
  const all = [c, a, b];

  it("places a new card", () => {
    expect(placeMachines("one", all, [])).toEqual(["a"]);
    expect(placeMachines("every", all, [])).toEqual(["a", "b", "c"]);
    expect(placeMachines({ spread: 2 }, all, [])).toEqual(["b", "c"]);
    // A machine without a sample counts as the busiest; ties go by order.
    expect(placeMachines({ spread: 2 }, [machine("x", 1), machine("y", 2), c], [])).toEqual(["c", "x"]);
    expect(placeMachines({ spread: 3 }, [a, { ...b, spreadReady: false }], [])).toEqual(["a"]);
    expect(
      placeMachines(
        "every",
        [
          { ...a, fit: "no" },
          { ...b, fit: "unknown" },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("keeps the instances of a card where they are, the home one first", () => {
    // The home machine stays even when it no longer fits; the deploy refuses that case itself.
    expect(placeMachines("every", [{ ...c, fit: "no" }, a, b], ["c", "a"])).toEqual(["c", "a", "b"]);
    // An offline machine keeps its instance; a machine that left or does not fit loses it.
    expect(
      placeMachines("every", [a, { ...b, fit: "unknown" }, { ...c, fit: "no" }], ["a", "b", "c", "gone"]),
    ).toEqual(["a", "b"]);
    // A spread app keeps a busy instance and fills the gap with the least busy free machine.
    expect(placeMachines({ spread: 2 }, all, ["a", "gone"])).toEqual(["a", "b"]);
    expect(placeMachines({ spread: 1 }, all, ["c", "a"])).toEqual(["c"]);
    expect(placeMachines("one", all, ["c", "a"])).toEqual(["c"]);
  });

  it("names the drift between deploys", () => {
    expect(placementDrift("every", all, ["a", "b", "c"])).toEqual({ drop: [], build: false });
    expect(placementDrift("every", all, ["a", "b"])).toEqual({ drop: [], build: true });
    expect(placementDrift("every", [a, { ...b, fit: "no" }], ["a", "b"])).toEqual({
      drop: ["b"],
      build: false,
    });
    expect(placementDrift("every", [a, { ...b, fit: "unknown" }], ["a", "b"])).toEqual({
      drop: [],
      build: false,
    });
    expect(placementDrift({ spread: 2 }, [a, { ...b, fit: "no" }, c], ["a", "b"])).toEqual({
      drop: ["b"],
      build: true,
    });
    // A spread app with all its instances does not move for load.
    expect(placementDrift({ spread: 1 }, all, ["a"])).toEqual({ drop: [], build: false });
    expect(placementDrift("one", all, ["a", "b"])).toEqual({ drop: ["b"], build: false });
  });
});

describe("instance addresses (K-824)", () => {
  const zone = "example.com";
  it("adds the machine name to the main name", () => {
    expect(instanceAddress("riffle.example.com", { id: "m1", name: "Oracle VPS" }, zone, [])).toBe(
      "riffle-oracle-vps.example.com",
    );
  });
  it("takes a hash of the machine id for a name that is taken, empty or too long", () => {
    const hashed = instanceAddress("riffle.example.com", { id: "m1", name: "VPS" }, zone, [
      "riffle-vps.example.com",
    ]);
    expect(hashed).toMatch(/^riffle-[0-9a-f]{8}\.example\.com$/);
    expect(instanceAddress("riffle.example.com", { id: "m1", name: "💻" }, zone, [])).toBe(hashed);
    const long = instanceAddress(`${"a".repeat(60)}.example.com`, { id: "m1", name: "mac" }, zone, []);
    expect(long.slice(0, -zone.length - 1)).toHaveLength(63);
  });
});

describe("the primary (K-828)", () => {
  const card = {
    machine: "a",
    addresses: ["app.example.com", "app-a.example.com", "app-b.example.com"],
    status: "stopped" as const,
    instances: [
      { machine: "a", address: "app-a.example.com", status: "running" as const },
      { machine: "b", address: "app-b.example.com", status: "running" as const },
    ],
  };
  const order = (id: string) => (id === "b" ? 0 : 1);

  it("takes the home status from the card and its own address from its instance", () => {
    expect(cardInstances(card)).toEqual([
      { machine: "a", address: "app-a.example.com", status: "stopped", home: true },
      { machine: "b", address: "app-b.example.com", status: "running", home: false },
    ]);
    expect(cardInstances({ ...card, instances: [] })[0]?.address).toBe("app.example.com");
  });

  it("stays on a healthy current primary, else takes the first healthy one in the owner's order", () => {
    const instances = cardInstances({ ...card, status: "running" });
    const pick = (online: (id: string) => boolean, current: string | null) =>
      primaryInstance(instances, order, online, { failover: true, current })?.machine;
    expect(pick(() => true, null)).toBe("b");
    // Sticky: an order that favours another healthy instance does not move a healthy primary.
    expect(pick(() => true, "a")).toBe("a");
    expect(pick((id) => id !== "a", "a")).toBe("b");
    // With none healthy, the records stay where they are.
    expect(pick(() => false, "a")).toBe("a");
    expect(
      primaryInstance(cardInstances(card), order, () => false, { failover: true, current: null })?.machine,
    ).toBe("a");
  });

  it("never takes a stale instance, and stays home without failover (K-827, K-828)", () => {
    const stale = cardInstances({
      ...card,
      status: "running",
      instances: [card.instances[0]!, { ...card.instances[1]!, stale: true as const }],
    });
    expect(primaryInstance(stale, order, () => true, { failover: true, current: null })?.machine).toBe("a");
    const instances = cardInstances(card);
    expect(primaryInstance(instances, order, () => true, { failover: false, current: "b" })?.machine).toBe(
      "a",
    );
  });
});

describe("spread on old daemons (K-826)", () => {
  const candidates = [
    { id: "a", spreadReady: true },
    { id: "b", spreadReady: false },
  ];
  it("refuses a spread deploy to a kept machine whose daemon does not check for volumes", () => {
    expect(spreadRefusal({ spread: 2 }, candidates, ["a", "b"], (id) => id.toUpperCase())).toMatch(
      /update the daemon on B first/,
    );
    expect(spreadRefusal({ spread: 1 }, candidates, ["a"], (id) => id)).toBeNull();
    expect(spreadRefusal("every", candidates, ["a", "b"], (id) => id)).toBeNull();
  });
});
