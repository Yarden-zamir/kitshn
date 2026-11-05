// Actors (K-1778): the Agents circle holds the token actor "Deploy bot", the machine actor VPS, and the agent actor
// "kitshn builder" (VPS with t3.project.name = kitshn). The Her circle shows a person with a phone token.
import { actorIdOf, machineActorId } from "../../src/core/model.ts";
import { DESKTOP, type Scenario } from "../capture-views.ts";

const conditions = [{ key: "t3.project.name", values: ["kitshn"] }];
const builder = {
  id: actorIdOf({ _tag: "machine", machineId: "vps" }, conditions),
  name: "kitshn builder",
  credentials: [{ _tag: "machine", machineId: "vps" }],
  conditions,
};
const her = actorIdOf({ _tag: "login", email: "her@example.com" });

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: {
            circles?: Array<{ id: string; members: Array<unknown> }>;
            actors?: Array<{ id: string; credentials: Array<unknown> }>;
          };
        };
        const agents = data.snapshot?.circles?.find((circle) => circle.id === "agents");
        agents?.members.push(
          { _tag: "actor", actorId: machineActorId("vps"), rights: { maintains: { mode: "automatic" } } },
          { _tag: "actor", actorId: builder.id, rights: { changes: { mode: "automatic" } } },
        );
        data.snapshot?.actors?.push(builder);
        const person = data.snapshot?.actors?.find((actor) => actor.id === her);
        person?.credentials.push({
          _tag: "token",
          tokenId: "t-her",
          clientId: "her.access",
          name: "Her phone",
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
    await shot("agents");
    await page.locator('[data-head="her"]').first().click();
    await page.waitForTimeout(500);
    await shot("person");
  },
} satisfies Scenario;
