import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_LINK, TOKEN_PERMISSIONS } from "./token.ts";

const install = readFileSync(join(import.meta.dirname, "../../public/install"), "utf8");
const site = readFileSync(join(import.meta.dirname, "../../../../site/install/index.html"), "utf8");
const labels = new Set<string>(Object.values(TOKEN_PERMISSIONS).map((permission) => permission.label));

/** The text between the first `start` and the next `end`. */
const linkAfter = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  return text.slice(from + start.length, text.indexOf(end, from + start.length));
};

describe("the token link (K-1202)", () => {
  it("names each permission group of the list by its id", () => {
    const keys = JSON.parse(new URL(TOKEN_LINK).searchParams.get("permissionGroupKeys") ?? "[]") as Array<{
      key: string;
    }>;
    expect(keys.map(({ key }) => key)).toEqual(Object.values(TOKEN_PERMISSIONS).map(({ id }) => id));
    expect(new Set(keys.map(({ key }) => key)).size).toBe(keys.length);
  });

  it("is the link of the bootstrap and of the install page", () => {
    expect(linkAfter(install, "TOKEN_LINK='", "'")).toBe(TOKEN_LINK);
    expect(linkAfter(site, 'href="https://dash.cloudflare.com/', '"').replaceAll("&amp;", "&")).toBe(
      TOKEN_LINK.slice("https://dash.cloudflare.com/".length),
    );
  });

  it("covers every permission that the bootstrap names", () => {
    const named = [...install.matchAll(/(?:Account|Zone) > [^">\\]+ > (?:Edit|Read)/g)].map(
      ([label]) => label,
    );
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((label) => !labels.has(label))).toEqual([]);
  });
});

/**
 * Runs step 1 of the bootstrap against a fake `curl` that answers as Cloudflare does for a user token or an account
 * token. Step 2 then stops the script, because the fake has no Zero Trust organization.
 */
function bootstrapStepOne(kind: "user" | "account") {
  const dir = mkdtempSync(join(tmpdir(), "kitshn-token-"));
  try {
    const curl = join(dir, "curl");
    writeFileSync(
      curl,
      `#!/bin/sh
out=""; code=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; -w) code=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
active='{"success":true,"errors":[],"result":{"status":"active"}}'
invalid='{"success":false,"errors":[{"code":1000,"message":"Invalid API Token"}]}'
status=200
case "$FAKE_KIND \${url#https://api.cloudflare.com/client/v4}" in
"user /user/tokens/verify" | "account /accounts/acc/tokens/verify") body=$active ;;
"account /user/tokens/verify" | "user /accounts/acc/tokens/verify") body=$invalid status=401 ;;
*" /accounts") body='{"success":true,"result":[{"id":"acc","name":"Account"}]}' ;;
*" /zones?"*) body='{"success":true,"result":[{"id":"zone","name":"example.com"}]}' ;;
*) body='{"success":false,"errors":[{"code":9109,"message":"Unauthorized"}]}' status=403 ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
[ -z "$code" ] || printf '%s' "$status"
`,
    );
    chmodSync(curl, 0o755);
    return spawnSync("sh", ["-c", install], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        FAKE_KIND: kind,
        CLOUDFLARE_API_TOKEN: "token",
        KITSHN_HOST: "kit.example.com",
        KITSHN_OWNER_EMAILS: "owner@example.com",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the bootstrap token check (K-1202)", () => {
  it.each(["user", "account"] as const)("accepts a token of kind %s", (kind) => {
    const run = bootstrapStepOne(kind);
    expect(run.stdout).toContain(`ok:      account acc, zone example.com, ${kind} token`);
    expect(run.stderr).toContain("no Zero Trust organization");
  });
});
