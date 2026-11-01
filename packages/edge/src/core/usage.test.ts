import { describe, expect, it } from "vitest";
import {
  type Analytics,
  PERMISSION,
  analyticsRows,
  bucketRow,
  countRows,
  usageLevel,
  withBucket,
} from "./usage.ts";

const used = (rows: ReadonlyArray<{ label: string; used: number | null }>, label: string) =>
  rows.find((row) => row.label === label)?.used;

describe("free plan usage (K-1303)", () => {
  it("sorts R2 actions into class A, class B and free, and names an unknown action", () => {
    const rows = analyticsRows(
      {
        r2: [
          { sum: { requests: 3 }, dimensions: { actionType: "PutObject" } },
          { sum: { requests: 5 }, dimensions: { actionType: "GetObject" } },
          { sum: { requests: 7 }, dimensions: { actionType: "DeleteObject" } },
          { sum: { requests: 11 }, dimensions: { actionType: "NewThing" } },
        ],
      },
      {},
    );
    expect(used(rows, "R2 class A operations")).toBe(3 + 11);
    expect(used(rows, "R2 class B operations")).toBe(5);
    expect(rows.find((row) => row.label === "R2 class A operations")?.note).toContain("NewThing");
  });

  it("shows a refused or empty storage value as unknown with its reason, never as 0", () => {
    const data: Analytics = { rows: null, objectStorage: [], kv: [] };
    const rows = analyticsRows(data, { rows: "not authorized" });
    const read = rows.find((row) => row.label === "Durable Object rows read");
    expect(read?.used).toBeNull();
    expect(read?.error).toContain(PERMISSION.analytics);
    expect(used(rows, "Durable Object storage")).toBeNull();
    // No group of operations means no operation today.
    expect(used(rows, "KV reads")).toBe(0);
  });

  it("counts WebSocket messages 20:1, as the bill does", () => {
    const rows = analyticsRows(
      {
        objects: [
          { sum: { requests: 100 }, dimensions: { type: "alarm" } },
          { sum: { requests: 2_000 }, dimensions: { type: "hibernation" } },
        ],
      },
      {},
    );
    expect(used(rows, "Durable Object requests")).toBe(100 + 100);
  });

  it("gives a zone made after 2024-09-01 the limit of 200 DNS records, and a failed count no value", () => {
    const rows = countRows({
      seats: { error: "refused" },
      applications: { used: 0 },
      serviceTokens: { used: 0 },
      scripts: { used: 0 },
      zones: [
        {
          name: "new.example",
          records: { used: 1 },
          createdOn: { used: Date.parse("2026-09-29T10:00:00Z") },
        },
        {
          name: "old.example",
          records: { used: 1 },
          createdOn: { used: Date.parse("2024-08-31T23:59:59Z") },
        },
      ],
    });
    expect(rows.find((row) => row.label === "DNS records of new.example")?.limit).toBe(200);
    expect(rows.find((row) => row.label === "DNS records of old.example")?.limit).toBe(1000);
    expect(used(rows, "Access seats")).toBeNull();
  });

  it("puts the kitshn bucket right after the account's R2 storage, and warns where backups wait (K-1818)", () => {
    const rows = withBucket(analyticsRows({ r2Storage: [] }, {}), { bytes: 8_000_000_000, at: 0 });
    const labels = rows.map((row) => row.label);
    expect(labels[labels.indexOf("R2 storage") + 1]).toBe("R2 bucket kitshn");
    expect(usageLevel(bucketRow({ bytes: 8_000_000_000, at: 0 }))).toBe("warn");
    expect(withBucket(rows, null)).toBe(rows);
  });

  it("warns at 80%, is full at the limit, and unknown without a value", () => {
    const row = { label: "x", limit: 50, period: "now", unit: "count", docs: "" } as const;
    expect(usageLevel({ ...row, used: 39 })).toBe("ok");
    expect(usageLevel({ ...row, used: 40 })).toBe("warn");
    expect(usageLevel({ ...row, used: 50 })).toBe("full");
    expect(usageLevel({ ...row, used: null })).toBe("unknown");
  });
});
