import { describe, expect, it } from "vitest";
import type { AccessRow, Api } from "./access-sync.ts";
import { BIC_RULE_REF, bicRule, privateHosts, syncBic } from "./bic-sync.ts";
import { CloudflareError } from "./cloudflare.ts";

const zones = [
  { name: "example.com", id: "z1" },
  { name: "other.org", id: "z2" },
];

const policy = (key: string, cfId: string, decision: string): AccessRow => ({
  key,
  cfId,
  aud: "",
  body: JSON.stringify({ name: `kitshn ${key}`, decision, include: [], require: [], exclude: [] }),
  tried: "",
  error: null,
});

const app = (
  key: string,
  domain: string,
  policies: ReadonlyArray<string>,
  cfId = `cf-${key}`,
): AccessRow => ({
  key,
  cfId,
  aud: "",
  body: JSON.stringify({ name: `kitshn ${key}`, domain, policies: policies.map((id) => ({ id })) }),
  tried: "",
  error: null,
});

const rowsOf = (...rows: ReadonlyArray<AccessRow>) => new Map(rows.map((row) => [row.key, row]));

describe("privateHosts (K-412)", () => {
  const rows = rowsOf(
    policy("policy:owner:people", "p-owner", "allow"),
    policy("policy:everyone:people", "p-everyone", "bypass"),
    app("app:admin:kit.example.com", "kit.example.com", ["p-owner"]),
    app("app:proxy:proxy.example.com", "proxy.example.com/*", ["p-owner"]),
    app("app:blog:blog.example.com", "blog.example.com", ["p-everyone", "p-owner"]),
    app("app:ask:help", "kit.example.com/ask", ["p-owner"]),
    app("app:closed:closed.other.org", "closed.other.org", []),
    app("app:new:new.example.com", "new.example.com", ["p-owner"], ""),
    app("app:far:far.elsewhere.net", "far.elsewhere.net", ["p-owner"]),
  );

  it("lists each host whose application Cloudflare holds without a Bypass policy, by zone", () => {
    expect(privateHosts(rows, zones)).toEqual({
      z1: ["kit.example.com", "proxy.example.com"],
      z2: ["closed.other.org"],
    });
  });

  it("drops a host whose card went public or away", () => {
    const changed = new Map(rows);
    changed.set(
      "app:proxy:proxy.example.com",
      app("app:proxy:proxy.example.com", "proxy.example.com/*", ["p-everyone"]),
    );
    changed.delete("app:closed:closed.other.org");
    expect(privateHosts(changed, zones)).toEqual({ z1: ["kit.example.com"], z2: [] });
  });

  it("leaves out an application whose accepted body is unknown", () => {
    const unknown = rowsOf(policy("policy:owner:people", "p-owner", "allow"), {
      ...app("app:admin:kit.example.com", "kit.example.com", ["p-owner"]),
      body: "",
    });
    expect(privateHosts(unknown, zones)).toEqual({ z1: [], z2: [] });
  });
});

describe("bicRule (K-412)", () => {
  it("turns only the Browser Integrity Check off, for the listed hosts", () => {
    expect(bicRule(["a.example.com", "b.example.com"])).toEqual({
      rule: {
        ref: BIC_RULE_REF,
        description: expect.any(String),
        expression: 'http.host in {"a.example.com" "b.example.com"}',
        action: "set_config",
        action_parameters: { bic: false },
        enabled: true,
      },
      left: 0,
    });
  });

  it("keeps the expression inside the Cloudflare limit and counts the hosts left out", () => {
    const hosts = Array.from(
      { length: 200 },
      (_, index) => `host-${String(index).padStart(3, "0")}.example.com`,
    );
    const { rule, left } = bicRule(hosts);
    expect(rule.expression.length).toBeLessThanOrEqual(4096);
    expect(left).toBeGreaterThan(0);
    expect(rule.expression).toContain(`"${hosts[0]}"`);
  });
});

type Ruleset = { id: string; rules: Array<Record<string, unknown>> };

function fakeRulesets(start: Record<string, Ruleset> = {}, refuse = false) {
  const rulesets = new Map(Object.entries(start));
  const calls: Array<string> = [];
  let next = 1;
  const api: Api = async <T>(method: Parameters<Api>[0], path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    if (refuse) throw new CloudflareError(403, `${method} ${path} failed (403): request is not authorized`);
    const [, zone = "", rest = ""] = /^\/zones\/([^/]+)\/rulesets(.*)$/.exec(path) ?? [];
    const ruleset = rulesets.get(zone);
    const withId = (rule: unknown) => ({ ...(rule as Record<string, unknown>), id: `rule${next++}` });
    if (method === "GET") {
      if (!ruleset) throw new CloudflareError(404, "not found");
      return ruleset as T;
    }
    if (rest === "" && method === "POST") {
      const made = {
        id: `rs${next++}`,
        rules: ((body as { rules: Array<unknown> }).rules ?? []).map(withId),
      };
      rulesets.set(zone, made);
      return made as T;
    }
    if (!ruleset) throw new CloudflareError(404, "no ruleset");
    const ruleId = rest.split("/rules/")[1];
    if (method === "POST") ruleset.rules.push(withId(body));
    if (method === "PATCH")
      ruleset.rules = ruleset.rules.map((rule) =>
        rule["id"] === ruleId ? { ...(body as object), id: ruleId } : rule,
      );
    if (method === "DELETE") ruleset.rules = ruleset.rules.filter((rule) => rule["id"] !== ruleId);
    return ruleset as T;
  };
  return { api, calls, rulesets };
}

const ownersRule = {
  id: "theirs",
  ref: "owner_rule",
  expression: "true",
  action: "set_config",
  action_parameters: { bic: true },
};

describe("syncBic (K-412)", () => {
  it("makes the entry point ruleset with the kitshn rule when the zone has none", async () => {
    const cloudflare = fakeRulesets();
    const result = await syncBic(cloudflare.api, { z1: ["kit.example.com"] }, {});
    expect(result).toEqual({ applied: { z1: ["kit.example.com"] }, calls: 2 });
    expect(cloudflare.calls).toEqual([
      "GET /zones/z1/rulesets/phases/http_config_settings/entrypoint",
      "POST /zones/z1/rulesets",
    ]);
    expect(cloudflare.rulesets.get("z1")?.rules).toEqual([
      expect.objectContaining({ ref: BIC_RULE_REF, expression: 'http.host in {"kit.example.com"}' }),
    ]);
  });

  it("adds, changes and deletes only its own rule, next to the owner's rules", async () => {
    const cloudflare = fakeRulesets({ z1: { id: "rs", rules: [ownersRule] } });
    await syncBic(cloudflare.api, { z1: ["a.example.com"] }, {});
    expect(cloudflare.calls.at(-1)).toBe("POST /zones/z1/rulesets/rs/rules");
    const ours = cloudflare.rulesets.get("z1")?.rules[1]?.["id"];
    await syncBic(cloudflare.api, { z1: ["a.example.com", "b.example.com"] }, { z1: ["a.example.com"] });
    expect(cloudflare.calls.at(-1)).toBe(`PATCH /zones/z1/rulesets/rs/rules/${String(ours)}`);
    expect(cloudflare.rulesets.get("z1")?.rules[1]).toMatchObject({
      expression: 'http.host in {"a.example.com" "b.example.com"}',
    });
    await syncBic(cloudflare.api, { z1: [] }, { z1: ["a.example.com", "b.example.com"] });
    expect(cloudflare.calls.at(-1)).toBe(`DELETE /zones/z1/rulesets/rs/rules/${String(ours)}`);
    expect(cloudflare.rulesets.get("z1")?.rules).toEqual([ownersRule]);
  });

  it("calls nothing for a zone that holds the wanted hosts, and writes nothing when Cloudflare already has the rule", async () => {
    const cloudflare = fakeRulesets({
      z1: { id: "rs", rules: [{ id: "r", ...bicRule(["a.example.com"]).rule }] },
    });
    expect(await syncBic(cloudflare.api, { z1: ["a.example.com"] }, { z1: ["a.example.com"] })).toEqual({
      applied: { z1: ["a.example.com"] },
      calls: 0,
    });
    // The daily run forgot what Cloudflare holds: one read, and no write.
    expect((await syncBic(cloudflare.api, { z1: ["a.example.com"] }, {})).calls).toBe(1);
  });

  it("stops at the budget and leaves the rest of the zones for the next run (K-406)", async () => {
    const cloudflare = fakeRulesets();
    const wanted = { z1: ["a.example.com"], z2: ["b.other.org"], z3: ["c.third.net"] };
    const first = await syncBic(cloudflare.api, wanted, {}, 4);
    expect(first).toEqual({ applied: { z1: ["a.example.com"], z2: ["b.other.org"] }, calls: 4 });
    const second = await syncBic(cloudflare.api, wanted, first.applied, 4);
    expect(second).toEqual({ applied: wanted, calls: 2 });
  });

  it("fails with the permission to add when the token cannot read the rules", async () => {
    const cloudflare = fakeRulesets({}, true);
    await expect(syncBic(cloudflare.api, { z1: ["a.example.com"] }, {})).rejects.toThrow(
      '"Zone > Config Rules > Edit"',
    );
  });
});
