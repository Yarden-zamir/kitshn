import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** A GitHub App key for the tests; the tests stub every GitHub call, so it signs only test tokens. */
const githubAppKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

export default defineConfig({
  test: {
    projects: [
      {
        // The UI tests render Preact components (menu.test.ts).
        oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
        test: { name: "node", include: ["src/**/*.test.ts"] },
      },
      {
        // The Worker and its Durable Object, in workerd through Miniflare.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // The tests check real Access tokens, so they turn off DEV_IDENTITY of a local .dev.vars.
            miniflare: {
              bindings: {
                KITSHN_HOST: "kit.example.com",
                KITSHN_ZONE: "example.com",
                ACCESS_TEAM_DOMAIN: "team.example.com",
                ACCESS_ADMIN_AUD: "admin-aud",
                ACCESS_AGENT_AUD: "agent-aud",
                ACCESS_DEVICE_AUD: "device-aud",
                KITSHN_HELP_PAGES: "1",
                ACCESS_CONNECT_AUD: "connect-aud",
                KITSHN_BACKUP_KEY: "test-backup-key",
                KITSHN_SECRETS_KEY: "test-secrets-key",
                DEV_IDENTITY: "",
                DEV_DEMO: "",
                GITHUB_APP_ID: "1",
                GITHUB_APP_KEY: githubAppKey,
              },
            },
          }),
        ],
        test: { name: "workers", include: ["test/**/*.test.ts"], exclude: ["test/deploy-worker.test.ts"] },
      },
      {
        // K-806: Worker deploys through the deploy steps, against a fake of the Cloudflare API, so this project
        // has an API token and a trusted GitHub owner, which the other tests must not have.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                KITSHN_HOST: "kit.example.com",
                KITSHN_ZONE: "example.com",
                ACCESS_TEAM_DOMAIN: "team.example.com",
                ACCESS_ADMIN_AUD: "admin-aud",
                ACCESS_AGENT_AUD: "agent-aud",
                ACCESS_CONNECT_AUD: "connect-aud",
                KITSHN_BACKUP_KEY: "test-backup-key",
                KITSHN_SECRETS_KEY: "test-secrets-key",
                DEV_IDENTITY: "",
                DEV_DEMO: "",
                CLOUDFLARE_API_TOKEN: "test-token",
                // K-1209: these deploys run during a host move.
                KITSHN_OLD_HOST: "old.example.com",
                CLOUDFLARE_ACCOUNT_ID: "acct",
                CLOUDFLARE_ZONE_ID: "zone",
                DEPLOY_OWNER_IDS: "1",
              },
            },
          }),
        ],
        test: { name: "deploys", include: ["test/deploy-worker.test.ts"] },
      },
    ],
  },
});
