// K-507 and K-537: share chips on cards, and the relationship lens of a selected machine and a site, with the Reach
// list in the panel. The demo has no circle of machines, so the scenario adds one around Mac and VPS.
import { machineActorId } from "../../src/core/model.ts";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, api, shot, view }) => {
    const machines = {
      id: "machines",
      name: "Machines",
      color: "#FFB347",
      level: "use",
      members: [
        { _tag: "actor", actorId: machineActorId("mac") },
        { _tag: "actor", actorId: machineActorId("vps") },
      ],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: -30,
      y: -170,
      r: 260,
    };
    await api("/api/apply", { edits: [{ _tag: "circle", id: "machines", after: machines }] });
    // Close to Mac, VPS and riffle, so the chips and lines are readable.
    await page.evaluate(`localStorage.setItem("kitshn.view", '{"x":420,"y":480,"s":0.85}')`);
    await page.reload();
    await page.locator('[data-card="vps"]').first().waitFor();
    await shot("map");
    for (const id of ["vps", "riffle"]) {
      await page.evaluate(`location.hash = "#map/${id}"`);
      await page.waitForTimeout(400);
      if (!view.touch) await shot(`lens-${id}`);
      // Main has no Reach list, so a "before" run shows the panel where the list would be.
      const reach = page.locator(".reach");
      const target = (await reach.count()) > 0 ? reach : page.getByText("Who can open it", { exact: true });
      await target.scrollIntoViewIfNeeded();
      await shot(`reach-${id}`);
    }
  },
} satisfies Scenario;
