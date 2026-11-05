// The owner labels and the fact labels from the daemon (K-609, K-635) on the machine cards and in a machine panel.
// The demo machines are offline, so the scenario gives them a status, and the facts that kitshn derives from it.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const LIVE = {
  mac: {
    status: {
      version: "0f6f4f103c31",
      os: "darwin 25.6.0",
      arch: "arm64",
      hostname: "mac",
      tunnel: "running",
    },
    facts: [
      { label: "os:darwin", from: "os darwin 25.6.0" },
      { label: "unix", from: "os darwin 25.6.0" },
      { label: "arch:arm64", from: "arch arm64" },
    ],
  },
  vps: {
    status: { version: "0f6f4f103c31", os: "linux 6.8.0", arch: "x64", hostname: "vps", tunnel: "running" },
    facts: [
      { label: "os:linux", from: "os linux 6.8.0" },
      { label: "unix", from: "os linux 6.8.0" },
      { label: "arch:x64", from: "arch x64" },
    ],
  },
} as const;

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
          };
        };
        const snapshot = data.snapshot;
        if (snapshot) {
          const now = Date.now();
          snapshot.version = "0f6f4f103c31";
          for (const view of snapshot.machines) {
            const live =
              view.machine.id === "mac" || view.machine.id === "vps" ? LIVE[view.machine.id] : null;
            if (live)
              Object.assign(view, {
                online: true,
                lastSeen: now,
                status: live.status,
                facts: live.facts,
                sample: { at: now, cpu: 0.21, memory: 0.48, disk: 0.4 },
              });
          }
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator('[data-card="vps"]').first().waitFor();
    await shot("cards");
    await page.goto(`${page.url().split("#")[0]}#map/vps`);
    await page.getByText("From the daemon").scrollIntoViewIfNeeded();
    await shot("panel");
  },
} satisfies Scenario;
