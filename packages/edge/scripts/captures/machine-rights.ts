// Machine rights (K-1720, K-1776): the rights editor of a machine in an agent circle, with "default" (asks the Owner),
// "off", and the rights "adds pages" and "restores". The scenario puts the demo machine vps in the Agents circle.
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
          rights: {
            deploys: { mode: "automatic" },
            addsPages: { mode: "automatic" },
            runsCommands: { mode: "off" },
          },
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
    await page.locator("fieldset.right-mode", { hasText: "adds pages" }).first().scrollIntoViewIfNeeded();
    await shot("rights");
  },
} satisfies Scenario;
