// Placement (K-823, K-824, K-828): a Compose card with an instance on two machines, each at its own address, and the
// primary that serves the main address. The demo deploys nothing, so the scenario gives the card its instances.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const instances = [
  { machine: "vps", address: "riffle-vps.example.com", status: "running" },
  { machine: "mac", address: "riffle-mac.example.com", status: "stopped" },
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        const resources = data.snapshot?.["resources"];
        if (data.type === "snapshot" && Array.isArray(resources))
          data.snapshot!["resources"] = resources.map((card: { id: string; addresses: Array<string> }) =>
            card.id === "riffle"
              ? {
                  ...card,
                  machine: "vps",
                  addresses: [...card.addresses, ...instances.map((instance) => instance.address)],
                  instances,
                  // K-828: the snapshot names the machine that the main address goes to now.
                  primary: "vps",
                }
              : card,
          );
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page
      .locator(".name", { hasText: /^riffle$/ })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole("region", { name: "Instances" }).scrollIntoViewIfNeeded();
    await shot("card");
  },
} satisfies Scenario;
