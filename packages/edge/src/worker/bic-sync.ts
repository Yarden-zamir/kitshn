import { TOKEN_PERMISSIONS, addPermission } from "../core/token.ts";
import { type AccessRow, type Api, appliesBypass } from "./access-sync.ts";
import { CloudflareError } from "./cloudflare.ts";
import { type Zone, zoneFor } from "./zones.ts";

/** K-412: kitshn owns the Configuration Rule with this ref in each zone, and no other rule there. */
export const BIC_RULE_REF = "kitshn_private_cards_bic_off";
/** K-406: the most Cloudflare calls of one run of the step: two zones of two calls each. */
export const BIC_CALLS = 4;
const PHASE = "http_config_settings";
/** The longest rule expression that Cloudflare accepts. */
const EXPRESSION_MAX = 4096;

/** The private hosts of each zone, by zone id, sorted. A zone without one has an empty list. */
export type BicHosts = Readonly<Record<string, ReadonlyArray<string>>>;

export interface BicRule {
  readonly ref: string;
  readonly description: string;
  readonly expression: string;
  readonly action: "set_config";
  readonly action_parameters: { readonly bic: false };
  readonly enabled: true;
}

interface LiveRule {
  readonly id: string;
  readonly ref?: string;
  readonly expression?: string;
  readonly action?: string;
  readonly action_parameters?: unknown;
  readonly enabled?: boolean;
}

/**
 * K-412: the hosts whose kitshn Access application Cloudflare holds without a Bypass policy, by zone. It reads what
 * Cloudflare accepted, not the wanted body, so a host keeps the check until its application exists.
 */
export function privateHosts(rows: ReadonlyMap<string, AccessRow>, zones: ReadonlyArray<Zone>): BicHosts {
  const hosts = new Map(zones.map((zone) => [zone.id, new Set<string>()]));
  for (const row of rows.values()) {
    if (!row.key.startsWith("app:") || !row.cfId || appliesBypass(row, rows) !== false) continue;
    const domain = (JSON.parse(row.body) as { domain?: unknown }).domain;
    if (typeof domain !== "string") continue;
    const slash = domain.indexOf("/");
    // An application of one path leaves the rest of the host to others. `<host>/*` covers the whole host (K-1623).
    if (slash !== -1 && domain.slice(slash) !== "/*") continue;
    const host = slash === -1 ? domain : domain.slice(0, slash);
    const zone = zoneFor(host, zones);
    if (zone) hosts.get(zone.id)?.add(host);
  }
  return Object.fromEntries([...hosts].map(([id, set]) => [id, [...set].sort()]));
}

/** K-412: the rule of one zone, with the hosts that fit in one expression. */
export function bicRule(hosts: ReadonlyArray<string>): { readonly rule: BicRule; readonly left: number } {
  const expression = (list: ReadonlyArray<string>) =>
    `http.host in {${list.map((host) => JSON.stringify(host)).join(" ")}}`;
  // Known limit: one expression holds about 100 hosts. Split the hosts into more rules when a zone has more.
  let count = hosts.length;
  while (count > 0 && expression(hosts.slice(0, count)).length > EXPRESSION_MAX) count--;
  return {
    rule: {
      ref: BIC_RULE_REF,
      description: "kitshn: Browser Integrity Check off on private cards (K-412)",
      expression: expression(hosts.slice(0, count)),
      action: "set_config",
      action_parameters: { bic: false },
      enabled: true,
    },
    left: hosts.length - count,
  };
}

const sameRule = (live: LiveRule, rule: BicRule) =>
  live.expression === rule.expression &&
  live.action === rule.action &&
  JSON.stringify(live.action_parameters) === JSON.stringify(rule.action_parameters) &&
  live.enabled !== false;

/**
 * K-412: brings the kitshn rule of each zone whose hosts differ from `applied` to `wanted`, in at most `budget` calls.
 * It changes only the rule with `BIC_RULE_REF`. Returns what Cloudflare now holds and the calls; a zone that did not
 * fit in the budget keeps its old value, so the next run takes it.
 */
export async function syncBic(
  api: Api,
  wanted: BicHosts,
  applied: BicHosts,
  budget = BIC_CALLS,
): Promise<{ readonly applied: BicHosts; readonly calls: number }> {
  const done: Record<string, ReadonlyArray<string>> = Object.fromEntries(
    Object.entries(applied).filter(([id]) => id in wanted),
  );
  let calls = 0;
  const errors: Array<string> = [];
  for (const [zoneId, hosts] of Object.entries(wanted)) {
    if (JSON.stringify(applied[zoneId]) === JSON.stringify(hosts)) continue;
    if (calls + 2 > budget) break;
    const base = `/zones/${zoneId}/rulesets`;
    calls++;
    let ruleset: { readonly id: string; readonly rules?: ReadonlyArray<LiveRule> } | null;
    try {
      ruleset = await api("GET", `${base}/phases/${PHASE}/entrypoint`);
    } catch (error) {
      if (error instanceof CloudflareError && error.status === 404) ruleset = null;
      else if (error instanceof CloudflareError && (error.status === 401 || error.status === 403))
        throw new Error(
          `The API token cannot read the Configuration Rules of zone ${zoneId}, so private cards refuse many machines (K-412). ${addPermission(TOKEN_PERMISSIONS.configRules)} ${error.message}`,
        );
      else throw error;
    }
    if (ruleset !== null && (typeof ruleset !== "object" || typeof ruleset.id !== "string"))
      throw new Error(`The ${PHASE} ruleset of zone ${zoneId} has no id: ${JSON.stringify(ruleset)}`);
    const live = ruleset?.rules?.find((rule) => rule.ref === BIC_RULE_REF);
    const { rule, left } = bicRule(hosts);
    if (left > 0) errors.push(`${left} private hosts of zone ${zoneId} do not fit in one rule`);
    if (hosts.length === 0) {
      if (ruleset && live) {
        calls++;
        await api("DELETE", `${base}/${ruleset.id}/rules/${live.id}`);
      }
    } else if (ruleset && live) {
      if (!sameRule(live, rule)) {
        calls++;
        await api("PATCH", `${base}/${ruleset.id}/rules/${live.id}`, rule);
      }
    } else if (ruleset) {
      // A new rule goes last, so it wins over an earlier rule of the owner that sets the same field.
      calls++;
      await api("POST", `${base}/${ruleset.id}/rules`, rule);
    } else {
      calls++;
      await api("POST", base, { name: "default", kind: "zone", phase: PHASE, rules: [rule] });
    }
    if (left === 0) done[zoneId] = hosts;
  }
  if (errors.length > 0) throw new Error(`Browser Integrity Check (K-412): ${errors.join("; ")}.`);
  return { applied: done, calls };
}
