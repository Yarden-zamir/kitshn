// K-534: the PortCard step of the site wizard with a reason of K-2001, the door list of a port card with its Close
// confirm, and the Remove ports confirm. The demo has no
// daemon and no port card, so the scenario marks the first machine online with the capability `doors`, adds a port card
// to the snapshots and answers `GET /api/ports` itself.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const servers = [
  { port: 25565, process: "java", status: null, title: null },
  { port: 8080, process: "node", status: 200, title: "Grafana" },
];
const hour = 60 * 60 * 1000;
const now = Date.now();

type View = { machine: { id: string }; online: boolean; status: Record<string, unknown> | null };
type Snapshot = {
  machines: Array<View>;
  resources: Array<Record<string, unknown>>;
  places: Record<string, { x: number; y: number }>;
  zone: string;
};

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    let first: string | null = null;
    let zone = "example.com";
    const able = (view: View) =>
      (first ??= view.machine.id) === view.machine.id
        ? {
            ...view,
            online: true,
            servers,
            status: {
              version: "dev",
              os: "linux",
              arch: "x64",
              hostname: "vps",
              tunnel: "running",
              capabilities: ["doors"],
              listening: ["25565/tcp"],
            },
          }
        : view;
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Snapshot; view?: View };
        if (data.type === "snapshot" && data.snapshot) {
          const snapshot = data.snapshot;
          zone = snapshot.zone;
          snapshot.machines = snapshot.machines.map(able);
          snapshot.resources = [
            ...snapshot.resources,
            {
              id: "mc",
              kind: "port",
              name: "minecraft",
              addresses: [`minecraft.${zone}`],
              status: "running",
              group: null,
              machine: first,
            },
          ];
          const vps = Object.values(snapshot.places)[0] ?? { x: 0, y: 0 };
          snapshot.places = { ...snapshot.places, mc: { x: vps.x + 40, y: vps.y + 230 } };
        }
        if (data.type === "machine" && data.view) data.view = able(data.view);
        socket.send(JSON.stringify(data));
      });
    });
    await page.route(/\/api\/portCards$/, (route) =>
      route.fulfill({
        json: [
          {
            card: "mc",
            machine: first,
            name: "minecraft",
            ports: [{ port: 25565, proto: "tcp" }],
            doorMs: 12 * hour,
            srv: "minecraft",
            relay: null,
            join: `https://pages.${zone}/join/minecraft`,
            address: `minecraft.${zone}`,
            listening: ["25565/tcp"],
            problem: null,
            doors: [
              {
                card: "mc",
                person: "her@example.com",
                address: "203.0.113.24",
                openedAt: now - hour,
                endsAt: now + 11 * hour,
              },
              {
                card: "mc",
                person: "owner@example.com",
                address: "2001:db8:1:2::/64",
                openedAt: now - 2 * hour,
                endsAt: now + 10 * hour,
              },
            ],
            records: [],
          },
        ],
      }),
    );
    await page.reload();
    await page.locator(".world > [data-card]").first().waitFor();

    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "Add a site" }).click();
    await page.getByRole("button", { name: "Ports", exact: true }).click();
    await page.getByLabel("Ports").fill("25565, 41641/udp");
    await page.getByLabel("Name").fill("minecraft");
    await page.getByLabel("SRV service").fill("minecraft");
    await page.getByText(/41641\/udp belongs to Tailscale/).waitFor();
    await page.mouse.move(5, 500);
    await shot("port-step");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.locator('.world > .card[data-card="mc"] .name').click();
    await page.getByText("her@example.com", { exact: false }).waitFor();
    // The first Close asks first.
    await page.getByRole("button", { name: "Close…", exact: true }).first().click();
    await page.getByText("Close for everyone on this address?").waitFor();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("door-list");
    await page.getByRole("button", { name: "No", exact: true }).click();
    await page.getByRole("button", { name: "Remove ports…", exact: true }).click();
    await page.getByText(/^Remove the port card minecraft\?/).waitFor();
    await page.mouse.move(5, 500);
    await shot("remove-confirm");
  },
} satisfies Scenario;
