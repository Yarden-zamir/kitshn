// Logs (K-1801): search, deploy runs, Live, and the message of a token without Workers Logs search. The demo has no
// daemon and no Cloudflare token, so the scenario answers the logs API and the tail itself.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const now = Date.parse("2026-10-28T12:00:00Z");
const line = (seconds: number, source: string, text: string) => ({ at: now - seconds * 1000, source, text });
const lines = [
  line(840, "web-1", "GET /feed 200 41ms"),
  line(610, "worker-1", "ERROR fetch https://news.example.com/rss failed: ETIMEDOUT"),
  line(605, "worker-1", "retry 1 of 3 in 5 s"),
  line(300, "web-1", "ERROR GET /api/items 500: database is locked"),
  line(120, "db-1", "checkpoint complete: wrote 12 buffers"),
];
const runs = [
  {
    id: "d3",
    at: now - 3_600_000,
    sha: "9f1c2ab77e",
    state: "failed",
    reason: "docker compose build failed",
    runUrl: "https://github.com/Yarden-zamir/riffle/actions/runs/4412/attempts/1",
    lines: [
      '#7 ERROR: failed to solve: process "/bin/sh -c pnpm install" did not complete successfully: exit code: 1',
    ],
  },
  {
    id: "d2",
    at: now - 26 * 3_600_000,
    sha: "41be0d913c",
    state: "done",
    reason: null,
    runUrl: "https://github.com/Yarden-zamir/riffle/actions/runs/4398/attempts/1",
    lines: [],
  },
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    let permission = false;
    await page.route(/\/api\/apps\/[^/]+\/logs$/, async (route) => {
      const body = route.request().postDataJSON() as { tab: string; text: string };
      if (body.tab === "deploys") return route.fulfill({ json: { runs } });
      if (permission) return route.fulfill({ json: { answer: { state: "needs-permission" } } });
      const found = lines.filter((item) =>
        `${item.source} ${item.text}`.toLowerCase().includes(body.text.toLowerCase()),
      );
      return route.fulfill({ json: { answer: { state: "lines", lines: found, matched: found.length } } });
    });
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; requestId?: string };
        if (data.type !== "tail") return server.send(message);
        socket.send(
          JSON.stringify({
            type: "tail",
            requestId: data.requestId,
            answer: { kind: "compose", tail: "t1" },
          }),
        );
        socket.send(JSON.stringify({ type: "tailLines", tail: "t1", lines: lines.slice(-3), skipped: 0 }));
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
    await page.getByRole("button", { name: "Logs…" }).click();
    const dialog = page.locator(".scrim .dialog");
    await dialog.getByText("5 lines.").waitFor();
    await dialog.getByRole("searchbox", { name: "Search the logs" }).fill("error");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await dialog.getByText("2 lines.").waitFor();
    await shot("search");
    await dialog.getByText("Deploy runs").click();
    await dialog.getByText("docker compose build failed").waitFor();
    await shot("deploy-runs");
    await dialog.getByText("App", { exact: true }).click();
    await dialog.getByRole("searchbox", { name: "Search the logs" }).fill("");
    await dialog.getByText("Live").click();
    await dialog.getByText("checkpoint complete").waitFor();
    await shot("live");
    await dialog.getByText("Live").click();
    permission = true;
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await dialog.getByText("Account > Workers Observability > Edit", { exact: false }).first().waitFor();
    await shot("worker-permission");
  },
} satisfies Scenario;
