// The concepts page at /concepts: one shot per section and per entry, in both schemes. Reports page errors, the
// links to the docs and the style guide, and the tokens that the scheme switch sets.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, scheme, shot }) => {
    const errors: Array<string> = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("/concepts", page.url()).toString());
    await page.locator(".concept").first().waitFor();
    console.log(
      `concepts: ${await page.locator(".concept").count()}, docs links: ${await page.locator('.concept a[href*="docs/internals/"]').count()}, guide link: ${await page.locator('a[href="/neo-brutalism"]').count()}`,
    );
    const canvas = () =>
      page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()`);
    const seen: Array<string> = [];
    for (const each of ["dark", "light", "system"]) {
      await page.getByRole("button", { name: each, exact: true }).click();
      seen.push(`${each}=${await canvas()}`);
    }
    console.log(`toggle (${scheme} system): ${seen.join(", ")}`);
    await shot("00-top");
    const sections = await page.locator(".guide > h2.label").count();
    for (let index = 0; index < sections; index++) {
      await page.evaluate(`document.querySelectorAll(".guide > h2.label")[${index}].scrollIntoView()`);
      await page.waitForTimeout(250);
      await shot(`${String(index + 1).padStart(2, "0")}-section`);
    }
    const entries = page.locator(".guide-entry");
    const out = `${process.env["HOME"]}/.cache/kitshn-captures/concepts-entries`;
    for (let index = 0; index < (await entries.count()); index++)
      await entries
        .nth(index)
        .screenshot({ path: `${out}/${String(index + 1).padStart(2, "0")}-${scheme}.png` });
    console.log(`page errors: ${errors.length === 0 ? "none" : errors.join(" | ")}`);
  },
} satisfies Scenario;
