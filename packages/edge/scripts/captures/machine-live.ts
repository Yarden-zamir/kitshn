// The live state of machine cards (K-515, K-1616) and the "needs you" sticker that opens the Inbox of one machine
// (K-1902). The demo machines are offline with no samples, so the scenario gives them a state on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: {
            version: string;
            machines: Array<Record<string, unknown> & { machine: { id: string } }>;
            jobs: Array<unknown>;
            proposals: Array<unknown>;
            queuedJobs: Record<string, number>;
          };
        };
        const snapshot = data.snapshot;
        if (snapshot) {
          const now = Date.now();
          snapshot.version = "0f6f4f103c31";
          for (const view of snapshot.machines) {
            if (view.machine.id === "mac")
              Object.assign(view, {
                online: true,
                lastSeen: now,
                status: {
                  version: "224187cf5a22",
                  os: "darwin",
                  arch: "arm64",
                  hostname: "mac",
                  tunnel: "running",
                },
                sample: { at: now, cpu: 0.91, memory: 0.72, disk: 0.4 },
              });
            if (view.machine.id === "vps")
              Object.assign(view, {
                online: false,
                lastSeen: now - 3 * 24 * 3600_000,
                status: {
                  version: "0f6f4f103c31",
                  os: "linux",
                  arch: "x64",
                  hostname: "vps",
                  tunnel: "stopped",
                },
                sample: { at: now - 3 * 24 * 3600_000, cpu: 0.18, memory: 0.17, disk: 0.3 },
              });
          }
          snapshot.jobs = Array.from({ length: 7 }, (_, index) => ({
            id: 900 + index,
            machineId: "vps",
            labels: [],
            command: { kind: "diagnostics" },
            state: "queued",
            createdAt: now,
            expiresAt: now + 3600_000,
            actor: "owner@example.com",
            exitCode: null,
            output: "",
          }));
          // The widest sets of the review: BEHIND, 12 queued and 2 asks on mac; 3 queued and 10 asks on vps.
          const ask = (machineId: string, index: number) => ({
            id: `p-${machineId}-${index}`,
            machineId,
            machineName: machineId === "mac" ? "Mac" : "VPS",
            action: "publish",
            target: `page-${index}`,
            body: {},
            reason: "share the design page",
            labels: {},
            right: "shares",
            circleId: "owner",
            shown: `${machineId} wants to publish page-${index} to Everyone.`,
            shownHash: "x",
            state: "pending",
            createdAt: now - 60_000 - index,
            expiresAt: now + 3600_000,
            verified: [],
          });
          snapshot.proposals = [
            ...Array.from({ length: 2 }, (_, index) => ask("mac", index)),
            ...Array.from({ length: 10 }, (_, index) => ask("vps", index)),
          ];
          snapshot.queuedJobs = { mac: 12, vps: 3 };
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator('[data-card="mac"]').first().waitFor();
    await page.getByText("2 needs you").first().waitFor();
    await shot("cards");
    await page.getByText("2 needs you").first().click();
    await page.getByText("Show every ask").waitFor();
    await shot("inbox");
  },
} satisfies Scenario;
