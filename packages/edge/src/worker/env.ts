import type { LoginPages } from "../core/access.ts";
import type { Kitshn } from "./kitshn.ts";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly KITSHN: DurableObjectNamespace<Kitshn>;
  /** The admin host, for example `kitshn.yarden-zamir.com` (K-1208). */
  readonly KITSHN_HOST: string;
  /** K-1209: the old admin host, set by the bootstrap only during the host move. */
  readonly KITSHN_OLD_HOST?: string;
  /** K-1130: the ids of the kitshn Access login pages as JSON `{chef, closed, login}`, when the bootstrap made them. */
  readonly KITSHN_LOGIN_PAGES?: string;
  /** The Zero Trust team domain, for example `team.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN: string;
  /** The audience tag of the admin Access application (the map and `/api`). */
  readonly ACCESS_ADMIN_AUD: string;
  /** The audience tag of the `/connect` Access application (daemons, K-604). */
  readonly ACCESS_CONNECT_AUD: string;
  /** K-718: the audience tag of the `/agent` Access application (service tokens of agent keys). */
  readonly ACCESS_AGENT_AUD?: string;
  /** K-1601: the audience tag of the `/device` Access application (service tokens of phones and desktop apps). */
  readonly ACCESS_DEVICE_AUD?: string;
  /** K-1504: the audience tag of the `/api/fresh` application, a passkey check of at most 10 minutes. */
  readonly ACCESS_FRESH_AUD?: string;
  /** K-1004: the audience tags of the login applications of `pages.<zone>` and `files.<zone>`. */
  readonly PAGES_LOGIN_AUD: string;
  readonly PAGES_PASSKEY_AUD: string;
  readonly FILES_LOGIN_AUD: string;
  readonly FILES_PASSKEY_AUD: string;
  /** The R2 bucket of pages and files (sections 10 and 11). Missing while R2 is off on the account. */
  readonly BUCKET?: R2Bucket;
  /** Comma-separated owner emails; they seed the Owner circle on the first start (K-1204). */
  readonly OWNER_EMAILS: string;
  /** Optional JSON list of service tokens that join the Owner circle on the first start, for agents (K-106). */
  readonly OWNER_DEVICES?: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  /** K-617: the release of this Worker (12 hex characters), or "local" for a local build. */
  readonly KITSHN_VERSION: string;
  /** The zone that kitshn publishes on (K-1111), and its id. */
  readonly KITSHN_ZONE: string;
  readonly CLOUDFLARE_ZONE_ID: string;
  /**
   * K-1111, K-817: the further zones that kitshn publishes on, as a JSON object of zone name to zone id. Only the
   * extra addresses of a push entry use them. The bootstrap writes it from KITSHN_ZONES.
   */
  readonly KITSHN_ZONES?: string;
  /** K-811: comma-separated GitHub user ids whose repos may deploy. Empty refuses every deploy. */
  readonly DEPLOY_OWNER_IDS: string;
  /** The API token that writes Access changes (K-406). Missing in local development. */
  readonly CLOUDFLARE_API_TOKEN?: string;
  /** K-718, K-908: the kitshn GitHub App id and its private key (PEM), to start repo workflows. */
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_KEY?: string;
  /** K-1833: the time of a bootstrap run with `KITSHN_IMPORT`; a new value makes the Durable Object import once. */
  readonly KITSHN_IMPORT_AT?: string;
  /** K-1815: the key of the backup passwords. Without it, kitshn makes no backup. */
  readonly KITSHN_BACKUP_KEY?: string;
  /** Local development only: the email to act as. The Worker honours it only on localhost. */
  readonly DEV_IDENTITY?: string;
  /**
   * Local development only: seed sample cards, or with `teams` the map of a small company. The Durable Object
   * honours it only when the host is localhost.
   */
  readonly DEV_DEMO?: string;
}

/**
 * K-1209: the admin host, then the old one during the host move. An old host outside the kitshn zone does not count,
 * so a broken value fails closed.
 */
export function adminHosts(
  env: Pick<Env, "KITSHN_HOST" | "KITSHN_OLD_HOST" | "KITSHN_ZONE">,
): ReadonlyArray<string> {
  const trimmed = (env.KITSHN_OLD_HOST ?? "").trim().toLowerCase();
  const old = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  return old !== "" && old !== env.KITSHN_HOST && old.endsWith(`.${env.KITSHN_ZONE}`)
    ? [env.KITSHN_HOST, old]
    : [env.KITSHN_HOST];
}

/**
 * K-1130: the kitshn login pages, or null while the bootstrap made none. A binding that is not the bootstrap's JSON
 * is logged and counts as none, so Access keeps working with the Cloudflare login.
 */
export function loginPages(env: Pick<Env, "KITSHN_LOGIN_PAGES">): LoginPages | null {
  const text = env.KITSHN_LOGIN_PAGES?.trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { chef, closed, login } = value;
    if (
      typeof chef === "string" &&
      chef &&
      typeof closed === "string" &&
      closed &&
      typeof login === "string" &&
      login
    )
      return { chef, closed, login };
  } catch {
    // Logged below.
  }
  console.error(`KITSHN_LOGIN_PAGES is not {chef, closed, login} (K-1130): ${text.slice(0, 200)}`);
  return null;
}
