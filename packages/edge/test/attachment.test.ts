import { expect, it } from "vitest";
import { ATTACHMENT_BUDGET, cloneBytes, fitAttachment } from "../src/worker/live.ts";

/** K-619, K-909: workerd keeps at most 16,384 bytes on a socket attachment; the budget keeps every machine write under it. */
it("fits volumes, servers with non-Latin titles and a full status written last in workerd's attachment limit", () => {
  const volumes = Array.from({ length: 100 }, (_, i) => ({
    name: `kitshn-app-${i}_data-${"x".repeat(60)}`,
    project: `kitshn-app-${i}`,
  }));
  const servers = Array.from({ length: 32 }, (_, i) => ({
    port: 3000 + i,
    process: "node-dev-server-✓".padEnd(40, "x"),
    status: 200,
    title: "Trek dossier ✓ ".padEnd(80, "é"),
  }));
  const status = {
    version: "0123456789ab",
    os: "linux",
    arch: "arm64",
    hostname: "a-long-hostname-of-the-vps.example.com",
    tunnel: "running",
    capabilities: ["compose", "logs", "backup", "doors", "providers"],
    keptBytes: 123456789,
    providerProblems: Array.from({ length: 10 }, (_, i) => ({
      provider: `provider-${i}`,
      reason: `resources[${i}].lists[0].rows[7]: the row id is longer than 200 characters; row dropped`,
      at: 0,
    })),
  };
  const base = {
    kind: "machine",
    machineId: "vps",
    since: 0,
    challenge: "c".repeat(64),
    check: "signed",
    answered: true,
    rotateBy: null,
    status: null,
    sample: null,
  } as const;
  const [socket] = Object.values(new WebSocketPair());
  if (!socket) throw new Error("no socket");
  // Each report as the handler writes it, in this order: volumes, servers, then the status.
  let attachment: {
    readonly [key: string]: unknown;
    readonly servers?: ReadonlyArray<unknown>;
    readonly volumes?: ReadonlyArray<unknown>;
  } = fitAttachment({ ...base, volumes });
  attachment = fitAttachment({ ...attachment, servers });
  attachment = fitAttachment({ ...attachment, status });
  expect(cloneBytes(attachment)).toBeLessThanOrEqual(ATTACHMENT_BUDGET);
  expect(() => socket.serializeAttachment(attachment)).not.toThrow();
});
