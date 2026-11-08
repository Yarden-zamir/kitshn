// App values (K-830, K-835): the Values section of a card that needs a redeploy, the Values dialog with each state of a
// name, and the form of a secret. The demo has no value sets, so the scenario answers the list itself.
import type { ValueSetView } from "../../src/core/values.ts";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const at = Date.parse("2026-11-08T10:00:00Z");
const by = { _tag: "person", email: "owner@example.com" } as const;
const sets: Array<ValueSetView> = [
  {
    key: "1084512:app:prod",
    label: "Yarden-zamir/riffle prod",
    repo: "Yarden-zamir/riffle",
    appKey: "app",
    environment: "prod",
    cards: [{ id: "riffle", name: "riffle", stale: ["OPENAI_KEY"] }],
    needs: { secrets: ["OPENAI_KEY", "DB_URL", "SENTRY_DSN"], vars: ["MODE"] },
    names: [
      { name: "OPENAI_KEY", kind: "secret", state: "set", version: 14, setAt: at, setBy: by },
      { name: "DB_URL", kind: "secret", state: "github", version: null, setAt: null, setBy: null },
      { name: "SENTRY_DSN", kind: "secret", state: "missing", version: null, setAt: null, setBy: null },
      {
        name: "MODE",
        kind: "var",
        state: "set",
        version: 9,
        setAt: at - 86_400_000,
        setBy: by,
        value: "fast",
      },
      {
        name: "OLD_TOKEN",
        kind: "secret",
        state: "unused",
        version: 3,
        setAt: at - 9 * 86_400_000,
        setBy: by,
      },
    ],
  },
  {
    key: "1084512:app:previews",
    label: "Yarden-zamir/riffle previews",
    repo: "Yarden-zamir/riffle",
    appKey: "app",
    environment: "previews",
    cards: [],
    needs: { secrets: ["OPENAI_KEY", "DB_URL", "SENTRY_DSN"], vars: ["MODE"] },
    names: [
      { name: "OPENAI_KEY", kind: "secret", state: "missing", version: null, setAt: null, setBy: null },
      { name: "DB_URL", kind: "secret", state: "github", version: null, setAt: null, setBy: null },
      { name: "SENTRY_DSN", kind: "secret", state: "missing", version: null, setAt: null, setBy: null },
      { name: "MODE", kind: "var", state: "set", version: 10, setAt: at, setBy: by, value: "preview" },
    ],
  },
];

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    await page.route(/\/api\/values(\?.*)?$/, (route) => route.fulfill({ json: { sets, secretsKey: true } }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot)
          data.snapshot["valuesStale"] = { riffle: ["OPENAI_KEY"] };
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    // riffle is a stack of three: the first press spreads it, the second selects the card.
    const riffle = page.locator('[data-card="riffle"]').first();
    for (const _ of [1, 2]) {
      if (view.touch) await riffle.tap();
      else await riffle.click();
      await page.waitForTimeout(200);
    }
    await page.getByRole("region", { name: "Values" }).scrollIntoViewIfNeeded();
    await shot("card");
    await page.getByRole("region", { name: "Values" }).getByRole("button", { name: "Values…" }).click();
    await page.getByText("SENTRY_DSN").first().waitFor();
    await shot("dialog");
    await page
      .locator(".scrim .dialog li", { hasText: "SENTRY_DSN" })
      .first()
      .getByRole("button", { name: "Set…" })
      .click();
    await page.getByLabel("The value of SENTRY_DSN").fill("https://key@sentry.example.com/1");
    await shot("set");
  },
} satisfies Scenario;
