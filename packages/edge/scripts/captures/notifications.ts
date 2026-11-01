// Notifications (K-1905): the bell with its count, and the Notifications panel. The demo has no failed deploy, so
// the scenario answers the list itself and sets the count of the snapshot.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const now = Date.now();
const hour = 3_600_000;
const notification = {
  episode: "d1",
  recipients: { _tag: "owner" },
  priority: "normal",
  snoozedUntil: null,
};
const list = {
  notifications: [
    {
      ...notification,
      id: 4,
      source: "app",
      key: "riffle:Backup done",
      card: "riffle",
      level: "info",
      title: "Backup done",
      text: "The nightly backup of riffle finished: 2.1 GB, 14 new files.",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/riffle" }],
      state: "open",
      openedAt: now - 5 * 60_000,
      closedAt: null,
    },
    {
      ...notification,
      id: 3,
      source: "deploy",
      key: "riffle",
      card: "riffle",
      level: "error",
      title: "Deploy of riffle failed",
      text: "docker compose up failed: the image web has no tag 41be0d9.",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/riffle" }],
      state: "open",
      openedAt: now - 20 * 60_000,
      closedAt: null,
    },
    {
      ...notification,
      id: 2,
      source: "deploy",
      key: "tick3d",
      card: "tick3d",
      level: "warn",
      title: "Deploy of tick3d did not run",
      snoozedUntil: now + hour,
      text: "The repo waits for Allow on the map (K-819).",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/tick3d" }],
      state: "open",
      openedAt: now - 2 * hour,
      closedAt: null,
    },
    {
      ...notification,
      id: 1,
      source: "deploy",
      key: "tick3d",
      card: "tick3d",
      level: "error",
      title: "Deploy of tick3d failed",
      text: "The build step exited with 1.",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/tick3d" }],
      state: "closed",
      openedAt: now - 30 * hour,
      closedAt: now - 28 * hour,
    },
  ],
  mutes: [{ card: "her", source: "uptime", until: null }],
};

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, shot }) => {
    await page.route(/\/api\/notifications$/, (route) => route.fulfill({ json: list }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) {
          data.snapshot["bell"] = 3;
          // K-1607: one ask waits in the Inbox.
          data.snapshot["proposals"] = [
            {
              id: "p1",
              machineId: "mac",
              machineName: "Mac",
              action: "apply",
              target: "riffle",
              body: null,
              reason: "share the preview with Her for the review",
              labels: { thread: "Review riffle" },
              verified: ["thread"],
              right: "shares",
              circleId: "owner",
              shown: "Share riffle with the circle Her at view",
              shownHash: "h",
              state: "pending",
              createdAt: now - 4 * 60_000,
              expiresAt: now + 20 * hour,
            },
          ];
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.goto(`${page.url().split("#")[0]}#notifications`);
    await page.locator(".notifications-view .notification").first().waitFor();
    await shot("view");
  },
} satisfies Scenario;
