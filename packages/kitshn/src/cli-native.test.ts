import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("draft native deployment", () => {
  it("refuses native apps and their dependent native apps without contacting the Worker", () => {
    const dir = mkdtempSync(join(tmpdir(), "kitshn-native-cli-"));
    try {
      writeFileSync(
        join(dir, "kitshn.config.ts"),
        `import { defineApps } from "kitshn";
export default defineApps({
  engine: { native: { executable: "bin/engine" }, deploy: [{ on: "push", name: "prod" }] },
  router: { native: { executable: "bin/router" }, needs: { apps: ["engine"] },
            deploy: [{ on: "push", name: "prod" }] }
});`,
      );
      const event = join(dir, "event.json");
      writeFileSync(event, "{}");
      // No OIDC token is available. Any attempt to contact the Worker would report that instead.
      const child = spawnSync(
        process.execPath,
        [resolve("src/cli.ts"), "deploy", "--server", "http://127.0.0.1:9", "--dir", dir],
        {
          encoding: "utf8",
          env: {
            PATH: process.env["PATH"] ?? "",
            GITHUB_EVENT_NAME: "push",
            GITHUB_EVENT_PATH: event,
            GITHUB_REF_NAME: "main",
          },
        },
      );
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr.match(/native service deployment is not implemented yet/g)).toHaveLength(2);
      expect(child.stderr).not.toContain("OIDC");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
