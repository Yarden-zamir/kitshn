// Asks in the Inbox (K-1722): an Owner ask that needs a passkey, a high-risk ask of a login circle, and a third one.
// The scenario sets the asks of the snapshot and answers the notification list itself.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const now = Date.now();
const hour = 3_600_000;
const ask = {
  body: null,
  verified: ["t3.thread.title"],
  shownHash: "0".repeat(64),
  state: "pending",
  expiresAt: now + 20 * hour,
};
const proposals = [
  {
    ...ask,
    id: "p1",
    machineId: "vps",
    machineName: "vps",
    action: "job",
    target: "vps",
    reason: "free disk space before the deploy",
    labels: { "t3.thread.title": "Clean the VPS" },
    right: "runs",
    circleId: "helpers",
    shown: "Run on vps: docker system prune -af",
    createdAt: now - 2 * 60_000,
  },
  {
    ...ask,
    id: "p2",
    machineId: "mac",
    machineName: "Mac",
    action: "deploy",
    target: "riffle",
    reason: "ship the fix of the login page",
    labels: { "t3.thread.title": "Fix riffle login" },
    right: "changes",
    circleId: "owner",
    shown: "Deploy riffle from main (41be0d9)",
    createdAt: now - 6 * 60_000,
  },
  {
    ...ask,
    id: "p3",
    machineId: "mac",
    machineName: "Mac",
    action: "apply",
    target: "riffle",
    reason: null,
    labels: {},
    verified: [],
    right: "shares",
    circleId: "owner",
    shown: "Share riffle with the circle Her at view",
    createdAt: now - 9 * 60_000,
  },
];
const list = {
  notifications: [
    {
      id: 7,
      source: "kitshn.ask",
      key: "p1",
      episode: "p1",
      card: null,
      recipients: { _tag: "approvers", circle: "helpers" },
      level: "warn",
      priority: "high",
      title: "vps asks: runs",
      text: "Run on vps: docker system prune -af · free disk space before the deploy",
      actions: [
        { id: "approve", label: "Approve", kind: "link", path: "/api/approve/login/start?approve=p1" },
        { id: "deny", label: "Deny", kind: "run" },
      ],
      state: "open",
      openedAt: now - 2 * 60_000,
      closedAt: null,
      snoozedUntil: null,
    },
    {
      id: 6,
      source: "kitshn.ask",
      key: "p0",
      episode: "p0",
      card: null,
      recipients: { _tag: "approvers", circle: "owner" },
      level: "warn",
      priority: "high",
      title: "Mac asks: changes",
      text: "Deploy tick3d from main (9c2a113)",
      actions: [],
      state: "approved",
      openedAt: now - 3 * hour,
      closedAt: now - 3 * hour + 4 * 60_000,
      snoozedUntil: null,
    },
  ],
  mutes: [],
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
          data.snapshot["proposals"] = proposals;
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.goto(`${page.url().split("#")[0]}#notifications`);
    await page.locator(".notifications-view .notification").first().waitFor();
    await shot("inbox");
  },
} satisfies Scenario;
