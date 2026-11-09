// Approvals and passkey (K-1779): the options of the token actor "Deploy bot" in the Agents circle, one on with its
// warning, and the confirm that a second option waits for.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: {
            actors?: Array<{ name: string; policy?: unknown }>;
          };
        };
        const actor = data.snapshot?.actors?.find((one) => one.name === "Deploy bot");
        if (actor) actor.policy = { approvesOwnAsks: true };
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-head="agents"]').first().click();
    await page.waitForTimeout(500);
    const section = page.locator("details", { hasText: "Approvals and passkey" }).first();
    await section.locator("summary").click();
    await section.getByText("without a passkey", { exact: false }).first().click();
    await page.waitForTimeout(300);
    await section.scrollIntoViewIfNeeded();
    await shot("approvals-and-passkey");
  },
} satisfies Scenario;
