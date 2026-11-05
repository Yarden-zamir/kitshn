// Effects (K-1725, K-1730): the warning of "shares" at automatic, on the chip of VPS and below its effects. The scenario
// puts the demo machine vps in the Agents circle with "shares" automatic, as the owner may set it after migration 46.
import { machineActorId } from "../../src/core/model.ts";
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { circles?: Array<{ id: string; members: Array<unknown> }> };
        };
        const agents = data.snapshot?.circles?.find((circle) => circle.id === "agents");
        agents?.members.push({
          _tag: "actor",
          actorId: machineActorId("vps"),
          rights: { shares: { mode: "automatic" } },
        });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-head="agents"]').first().click();
    await page.waitForTimeout(500);
    await page.locator("p.warning", { hasText: '"shares" runs at once' }).first().scrollIntoViewIfNeeded();
    await shot("warning");
  },
} satisfies Scenario;
