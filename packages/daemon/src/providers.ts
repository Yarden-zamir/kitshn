// K-704 to K-707: the providers of this machine. A provider belongs to the local connection that registered it; the
// daemon keeps the last registration of each one in `providers.json`, so kitshn keeps its cards while it restarts.
import {
  type CardSettingValues,
  type DesiredParts,
  type GrantTables,
  type ProviderAccess,
  type ProviderProblem,
  type ProviderReport,
  type ProviderRefusal,
  type ProviderRequest,
  type ProviderResource,
  type ProviderState,
  type ReachedCard,
  decodeClients,
  decodeProviderReports,
  decodeResources,
  isProviderName,
  PROVIDER_LIMITS,
  KITSHN_PROTOCOL,
  ROLLOUT_FIX,
  legacyProtocol,
  matchProtocol,
  parseProtocol,
  pushKey,
  screenResources,
  shapeProblem,
  siteName,
} from "@kitshn/local";
import { Schema } from "effect";
import { RESERVED_SITE_NAMES } from "kitshn/names";

interface Entry {
  readonly report: ProviderReport;
  /** The local connection that registered it; null while it is offline. */
  readonly connection: number | null;
  /** K-704: the instance of the provider that holds the connection, such as T3's environment id. */
  readonly instance: string | null;
  /** Since when it is online, or offline; null when it never connected since the daemon started. */
  readonly since: number | null;
  /** Why it is offline, while it is. */
  readonly offlineReason: string | null;
  /** Protocol 2: what the last `register` or `upsert` dropped. */
  readonly problems: ReadonlyArray<ProviderProblem>;
  /** K-704: the last refused register of another instance while this one held the connection. */
  readonly conflict: string | null;
}

/** K-704: why a provider that `providers.json` kept has no connection after a daemon start. */
export const NEVER_CONNECTED = "never connected since the daemon started";

/**
 * What `providers.json` holds: each provider's last registration, the last push of kitshn for each key (K-1608), the
 * user that each provider name belongs to, and the user that runs exec for it (K-722). It keeps no online flag: a
 * daemon start has no connections.
 */
interface Saved {
  readonly providers: ReadonlyArray<ProviderReport>;
  readonly pushed: Readonly<Record<string, unknown>>;
  /** K-704: the user id that each provider name belongs to; the first accepted `register` binds it. */
  readonly owners?: Readonly<Record<string, number>>;
  /** K-722: the user id that runs exec for a provider, when the owner set one other than the provider's own user. */
  readonly execUsers?: Readonly<Record<string, number>>;
}

/** What `providers.json` holds on disk: the providers without an online flag. */
export type SavedFile = Omit<Saved, "providers"> & {
  readonly providers: ReadonlyArray<Omit<ProviderReport, "online">>;
};

/** A refusal reason fits the text of a notification (K-1901). */
const MAX_REFUSAL_LENGTH = 500;

const decodePushed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The user ids of one record of the file, item by item; an item that is no user id is named in `problems`. */
function uidsOf(raw: unknown, what: string, problems: Array<string>): Record<string, number> {
  const uids: Record<string, number> = {};
  for (const [name, uid] of Object.entries(isRecord(raw) ? raw : {}))
    if (typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0) uids[name] = uid;
    else problems.push(`the ${what} of ${name} dropped: ${JSON.stringify(uid)} is no user id`);
  return uids;
}

/**
 * K-1608: the saved state of `providers.json`, item by item: a provider, an owner or an exec user that does not
 * decode is left out and named in `problems`, and the rest loads. Only a file that is no object at all starts empty.
 * An owner of -1, which a Windows daemon saved before it stopped binding (K-621), is such an item.
 */
export function parseSaved(value: unknown): { saved: Saved; problems: ReadonlyArray<string> } {
  const empty: Saved = { providers: [], pushed: {} };
  if (value === null) return { saved: empty, problems: [] };
  if (!isRecord(value)) return { saved: empty, problems: ["the file holds no object, so no provider loads"] };
  const problems: Array<string> = [];
  const providers: Array<ProviderReport> = [];
  for (const [index, item] of (Array.isArray(value["providers"]) ? value["providers"] : []).entries())
    try {
      // The file keeps no online flag; a start has no connections.
      const [report] = decodeProviderReports([isRecord(item) ? { ...item, online: false } : item]);
      if (report) providers.push(report);
    } catch (error) {
      problems.push(`providers[${index}] dropped: ${String(error)}`);
    }
  const owners = uidsOf(value["owners"], "owner", problems);
  const execUsers = uidsOf(value["execUsers"], "exec user", problems);
  let pushed: Readonly<Record<string, unknown>> = {};
  try {
    pushed = decodePushed(value["pushed"] ?? {});
  } catch (error) {
    problems.push(`the saved pushes dropped: ${String(error)}`);
  }
  return { saved: { providers, pushed, owners, execUsers }, problems };
}

/** The outcome of one provider request: an error text, or what changed and what it dropped. */
export type ProviderOutcome =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly problems: ReadonlyArray<ProviderProblem>;
      /** K-704: the connection that the same instance held before this register, which the caller closes. */
      readonly replaced: number | null;
      /** K-724: the provider speaks another minor of the protocol; the daemon logs this line. */
      readonly warning: string | null;
    };

/** What a `register` or `upsert` needs from the daemon besides the request. */
export interface ProviderCaller {
  readonly connection: number;
  readonly uid: number;
  /** The daemon user or root, who may claim a provider saved before binds existed. */
  readonly privileged: boolean;
  /** The names of `sites.json`. */
  readonly takenSites: ReadonlySet<string>;
  /** K-705: the name of this machine on the map, for the names of new sites. */
  readonly machineName: string;
  readonly now?: number;
}

export class Providers {
  private readonly entries = new Map<string, Entry>();
  // Known limit: memory only, so a daemon restart forgets a refusal until the provider tries again.
  private readonly refusals = new Map<string, ProviderRefusal>();
  /** K-724: the providers whose last register was refused only because they speak an older major. */
  private readonly olderMajor = new Set<string>();
  private pushed: Record<string, unknown>;
  private readonly owners: Map<string, number>;
  private readonly execUsers: Map<string, number>;

  constructor(
    saved: Saved,
    private readonly save: (saved: SavedFile) => void,
    /** K-704: a refusal or a connection changed, so the status of the machine changed. */
    private readonly refusalsChanged: () => void,
    startedAt = Date.now(),
  ) {
    for (const report of saved.providers)
      this.entries.set(report.name, {
        report: { ...report, online: false },
        connection: null,
        instance: null,
        since: startedAt,
        offlineReason: NEVER_CONNECTED,
        problems: [],
        conflict: null,
      });
    this.pushed = { ...saved.pushed };
    this.owners = new Map(Object.entries(saved.owners ?? {}));
    this.execUsers = new Map(Object.entries(saved.execUsers ?? {}));
  }

  /** K-704: the user id that a provider name belongs to, or undefined before its first accepted `register`. */
  ownerOf(provider: string): number | undefined {
    return this.owners.get(provider);
  }

  /** K-722: the user id that runs exec for a provider: the one set for it, else the user that registered it. */
  execUserOf(provider: string): number | null {
    return this.execUsers.get(provider) ?? this.owners.get(provider) ?? null;
  }

  /** K-722: `kitshn providers exec-user`: who runs exec for a provider from now on. */
  setExecUser(provider: string, uid: number): string | null {
    if (!this.entries.has(provider)) return `this machine has no provider ${provider}.`;
    this.execUsers.set(provider, uid);
    this.persist();
    this.refusalsChanged();
    return null;
  }

  /** K-722: every user id that a provider name belongs to, so a machine with one never runs exec as the daemon user. */
  providerUsers(): ReadonlySet<number> {
    return new Set(this.owners.values());
  }

  /**
   * K-704: moves a provider name to another user id. The cards stay the same cards; a connection of the old user
   * goes offline, so its next request must `register` again, which the new bind refuses.
   */
  rebind(provider: string, uid: number, now = Date.now()): string | null {
    const entry = this.entries.get(provider);
    if (!entry) return `this machine has no provider ${provider}.`;
    this.owners.set(provider, uid);
    if (entry.connection !== null) {
      this.entries.set(provider, {
        ...entry,
        report: { ...entry.report, online: false },
        connection: null,
        since: now,
        offlineReason: `it moved to the user id ${uid}`,
      });
      this.refusalsChanged();
    }
    this.persist();
    return null;
  }

  /**
   * K-704: one `register` of protocol 2. One bad item never refuses it: each bad resource, row, fact, sticker or
   * client goes, named in `problems`. Only a broken shape, another protocol major (K-724), another user or another
   * live instance refuses the whole register.
   */
  register(request: Extract<ProviderRequest, { type: "register" }>, caller: ProviderCaller): ProviderOutcome {
    const now = caller.now ?? Date.now();
    const name = request.provider;
    const version =
      request.protocolVersion ?? (request.protocol === undefined ? "none" : legacyProtocol(request.protocol));
    const protocol = matchProtocol(
      { name: "this daemon", version: KITSHN_PROTOCOL, update: ROLLOUT_FIX },
      {
        name: `the provider ${name}`,
        version,
        update: `install a release of ${name} that speaks kitshn protocol ${KITSHN_PROTOCOL}`,
      },
    );
    if (protocol.outcome === "refuse") {
      this.refuse(name, protocol.reason, now);
      const major = parseProtocol(version)?.major;
      if (major !== undefined && major < (parseProtocol(KITSHN_PROTOCOL)?.major ?? 0))
        this.olderMajor.add(name);
      return { ok: false, error: protocol.reason };
    }
    // K-724: the two fields of one register name one major, or the daemon cannot tell which one the provider speaks.
    if (
      request.protocolVersion !== undefined &&
      request.protocol !== undefined &&
      parseProtocol(request.protocolVersion)?.major !== request.protocol
    ) {
      const error = `the register names protocol ${request.protocol} and protocolVersion ${request.protocolVersion}, whose majors differ (K-724).`;
      this.refuse(name, error, now);
      return { ok: false, error };
    }
    if (request.instance === undefined) {
      const error = "a register of protocol 2 names its instance (K-704).";
      this.refuse(name, error, now);
      return { ok: false, error };
    }
    // K-704: one connection holds one provider, so `check`, `exec` and the events know which one it is.
    const held = this.providerOf(caller.connection);
    if (held !== null && held !== name)
      return {
        ok: false,
        error: `this connection holds the provider ${held}; a second provider needs its own connection (K-704).`,
      };
    const old = this.entries.get(name);
    const owner = this.owners.get(name);
    // Neither refusal marks the provider as refused: it belongs to another user, who still runs it (K-704).
    if (owner !== undefined && owner !== caller.uid)
      return {
        ok: false,
        error: `${name} belongs to the user id ${owner}, not to ${caller.uid}; root or the daemon user moves it with kitshn providers rebind ${name} --to-user <user> (K-704).`,
      };
    if (owner === undefined && old !== undefined && !caller.privileged)
      return {
        ok: false,
        error: `${name} was saved before providers had users; root or the daemon user registers it or moves it with kitshn providers rebind ${name} --to-user <user> (K-704).`,
      };
    // K-704: one live instance holds a provider; another one is refused, and the first keeps working.
    if (
      old?.connection != null &&
      old.connection !== caller.connection &&
      old.instance !== request.instance
    ) {
      const error = `the provider ${name} is connected as the instance ${old.instance}; stop it first (K-704).`;
      this.entries.set(name, {
        ...old,
        conflict: `the instance ${request.instance} tried to register: ${error}`,
      });
      this.refusalsChanged();
      return { ok: false, error };
    }
    const problems: Array<ProviderProblem> = [];
    const decoded = decodeResources(request.resources);
    problems.push(...decoded.problems);
    const clients = request.clients ? decodeClients(request.clients, problems) : undefined;
    const others = this.othersThan(name);
    const named = this.withSiteNames(name, decoded.resources, old?.report, others, caller);
    const draft: ProviderReport = {
      name,
      online: true,
      kinds: request.kinds,
      commands: request.commands,
      resources: named,
      ...(clients ? { clients } : {}),
    };
    const shape = shapeProblem(draft, others);
    if (shape) {
      const error = `${name}: ${shape}`;
      this.refuse(name, error, now);
      return { ok: false, error };
    }
    const indexOf = new Map(decoded.resources.map((resource, index) => [resource.id, index]));
    const screened = screenResources(
      draft,
      others,
      caller.takenSites,
      RESERVED_SITE_NAMES,
      (id) => `resources[${indexOf.get(id) ?? "?"}]`,
    );
    problems.push(...screened.problems);
    this.olderMajor.delete(name);
    if (this.refusals.delete(name)) this.refusalsChanged();
    const replaced = old?.connection != null && old.connection !== caller.connection ? old.connection : null;
    this.entries.set(name, {
      report: screened.report,
      connection: caller.connection,
      instance: request.instance,
      since: old?.connection === caller.connection ? old.since : now,
      offlineReason: null,
      problems,
      conflict: null,
    });
    // K-704: a provider that comes back changes the status of the machine.
    if (old?.connection !== caller.connection) this.refusalsChanged();
    // K-621: Windows has no user ids, and its pipe admits only the daemon's own account, so nothing to bind there.
    const bound = owner === undefined && caller.uid >= 0;
    if (bound) this.owners.set(name, caller.uid);
    const changed = JSON.stringify(old?.report) !== JSON.stringify(screened.report);
    if (changed || bound) this.persist();
    return {
      ok: true,
      changed,
      problems,
      replaced,
      warning: protocol.outcome === "tolerate" ? protocol.warning : null,
    };
  }

  /** K-705: one `upsert` or `remove` of the connection that registered the provider; item by item, as `register`. */
  change(
    request: Extract<ProviderRequest, { type: "upsert" | "remove" }>,
    caller: ProviderCaller,
  ): ProviderOutcome {
    const name = request.provider;
    const old = this.entries.get(name);
    if (!old || old.connection !== caller.connection)
      return { ok: false, error: `register ${name} on this connection first (K-704).` };
    const problems: Array<ProviderProblem> = [];
    let resources: Array<ProviderResource>;
    if (request.type === "remove") {
      const gone = new Set(request.ids);
      resources = old.report.resources.filter((resource) => !gone.has(resource.id));
    } else {
      const decoded = decodeResources(request.resources);
      problems.push(...decoded.problems);
      const next = new Map(old.report.resources.map((resource) => [resource.id, resource]));
      for (const resource of decoded.resources) next.set(resource.id, resource);
      resources = [...next.values()];
    }
    const others = this.othersThan(name);
    const draft: ProviderReport = {
      ...old.report,
      resources: this.withSiteNames(name, resources, old.report, others, caller),
    };
    const shape = shapeProblem(draft, others);
    if (shape) return { ok: false, error: `${name}: ${shape}` };
    const screened = screenResources(draft, others, caller.takenSites, RESERVED_SITE_NAMES);
    problems.push(...screened.problems);
    this.entries.set(name, { ...old, report: screened.report, problems });
    const changed = JSON.stringify(old.report) !== JSON.stringify(screened.report);
    if (changed) this.persist();
    return { ok: true, changed, problems, replaced: null, warning: null };
  }

  private othersThan(name: string): Array<ProviderReport> {
    return [...this.entries.values()].map((entry) => entry.report).filter((other) => other.name !== name);
  }

  /**
   * K-705: the resources with the name of each site: the name that the same resource had before, else a new one of
   * `siteName` that no other site of the machine holds.
   */
  private withSiteNames(
    provider: string,
    resources: ReadonlyArray<ProviderResource>,
    before: ProviderReport | undefined,
    others: ReadonlyArray<ProviderReport>,
    caller: ProviderCaller,
  ): Array<ProviderResource> {
    const kept = new Map(
      (before?.resources ?? []).flatMap((resource) =>
        resource.site?.name ? [[resource.id, resource.site.name] as const] : [],
      ),
    );
    const taken = new Set([
      ...caller.takenSites,
      ...RESERVED_SITE_NAMES,
      ...others.flatMap((other) => other.resources.flatMap((resource) => resource.site?.name ?? [])),
    ]);
    return resources.map((resource) => {
      if (!resource.site) return resource;
      const name = kept.get(resource.id) ?? siteName(provider, caller.machineName, resource.id, taken);
      taken.add(name);
      return { ...resource, site: { port: resource.site.port, name } };
    });
  }

  /**
   * K-704: keeps the refusal of a registration until the next accepted one. A provider retries the same request, so
   * `at` stays the start of the refusal with this reason.
   */
  refuse(provider: string, reason: string, now = Date.now()): void {
    if (!isProviderName(provider)) return;
    this.olderMajor.delete(provider);
    const clipped = reason.slice(0, MAX_REFUSAL_LENGTH);
    if (this.refusals.get(provider)?.reason === clipped) return;
    this.refusals.delete(provider);
    this.refusals.set(provider, { provider, reason: clipped, at: now });
    // A machine has at most 8 providers (K-704); the oldest refusal goes first.
    for (const name of this.refusals.keys())
      if (this.refusals.size > PROVIDER_LIMITS.providers) this.refusals.delete(name);
    this.refusalsChanged();
  }

  refused(): Array<ProviderRefusal> {
    return [...this.refusals.values()];
  }

  /** K-704: drops a provider that no connection holds, so the daemon no longer reports it; or says why not. */
  forget(provider: string): string | null {
    const entry = this.entries.get(provider);
    if (!entry) return `this machine has no provider ${provider}.`;
    if (entry.connection !== null) return `${provider} is connected; stop it first.`;
    this.entries.delete(provider);
    this.owners.delete(provider);
    this.execUsers.delete(provider);
    for (const key of Object.keys(this.pushed))
      if (
        key === pushKey.grants(provider) ||
        key === pushKey.settings(provider) ||
        key === pushKey.reach(provider) ||
        key === pushKey.access(provider) ||
        key.startsWith(`desired:${provider}:`)
      )
        delete this.pushed[key];
    this.persist();
    return null;
  }

  /** K-704: the providers of a closed connection go offline; their cards stay. Returns the names that went. */
  disconnect(connection: number, now = Date.now(), reason = "the connection closed"): Array<string> {
    const gone: Array<string> = [];
    for (const [name, entry] of this.entries)
      if (entry.connection === connection) {
        this.entries.set(name, {
          ...entry,
          report: { ...entry.report, online: false },
          connection: null,
          since: now,
          offlineReason: reason,
        });
        gone.push(name);
      }
    if (gone.length > 0) this.refusalsChanged();
    return gone;
  }

  /** K-704, K-515: the registered providers without a connection now, since when and why. */
  offline(): Array<{ readonly provider: string; readonly reason: string; readonly at: number }> {
    return [...this.entries].flatMap(([provider, entry]) =>
      entry.connection === null && entry.since !== null
        ? [{ provider, reason: entry.offlineReason ?? NEVER_CONNECTED, at: entry.since }]
        : [],
    );
  }

  /** K-704: every provider as `kitshn status` shows it. */
  states(): Array<ProviderState> {
    return [...this.entries].map(([name, entry]) => ({
      name,
      instance: entry.instance,
      online: entry.connection !== null,
      since: entry.offlineReason === NEVER_CONNECTED ? null : entry.since,
      problems: [...entry.problems],
      refusal: this.refusals.get(name)?.reason ?? entry.conflict,
      execUser: this.execUserOf(name),
    }));
  }

  /** K-724: the providers that wait refused for their own release, because they speak an older major. */
  refusedForOlderMajor(): ReadonlySet<string> {
    return this.olderMajor;
  }

  /** The connection of an online provider, or null. */
  connectionOf(provider: string): number | null {
    return this.entries.get(provider)?.connection ?? null;
  }

  /** The provider that a connection holds, or null: a connection holds one provider (protocol 2). */
  providerOf(connection: number): string | null {
    for (const [name, entry] of this.entries) if (entry.connection === connection) return name;
    return null;
  }

  /** The last registration of a provider, or null. */
  reportOf(provider: string): ProviderReport | null {
    return this.entries.get(provider)?.report ?? null;
  }

  reports(): Array<ProviderReport> {
    return [...this.entries.values()].map((entry) => entry.report);
  }

  /** K-1104: the live sites of the providers' cards, served from local ports. */
  sites(): Array<{ readonly name: string; readonly target: string; readonly dev: boolean }> {
    return this.reports().flatMap((report) =>
      report.resources.flatMap((resource) =>
        resource.site?.name
          ? [{ name: resource.site.name, target: `http://localhost:${resource.site.port}`, dev: false }]
          : [],
      ),
    );
  }

  /** K-1608: stores the push of kitshn with this key; true when it differs from the last one. */
  setPushed(key: string, value: unknown): boolean {
    if (JSON.stringify(this.pushed[key]) === JSON.stringify(value)) return false;
    this.pushed[key] = value;
    this.persist();
    return true;
  }

  /** K-709, K-717, K-1609, K-1623: what the answer to `register` gives a provider from the saved pushes. */
  savedFor(provider: string): {
    readonly desired: Record<string, DesiredParts>;
    readonly settings: CardSettingValues;
    readonly reach: ReadonlyArray<ReachedCard>;
    readonly served: ReadonlyArray<string>;
  } {
    const prefix = `desired:${provider}:`;
    return {
      desired: Object.fromEntries(
        Object.entries(this.pushed).flatMap(([key, value]) =>
          key.startsWith(prefix) ? [[key.slice(prefix.length), desiredState(value)]] : [],
        ),
      ),
      settings: (this.pushed[pushKey.settings(provider)] as CardSettingValues | undefined) ?? {},
      reach: this.reachOf(provider),
      served: this.accessOf(provider)?.served ?? [],
    };
  }

  /** K-706, K-721: the grant tables of a provider that kitshn last sent; `check` evaluates them. */
  grantsOf(provider: string): GrantTables {
    return (this.pushed[pushKey.grants(provider)] as GrantTables | undefined) ?? {};
  }

  /** K-1623, K-721: the Access team and audiences of a provider's sites that kitshn last sent. */
  accessOf(provider: string): ProviderAccess | null {
    return (this.pushed[pushKey.access(provider)] as ProviderAccess | undefined) ?? null;
  }

  /** A saved push of kitshn by its key, or null. */
  pushedValue(key: string): unknown {
    return this.pushed[key] ?? null;
  }

  /** K-1609: the saved reach of a provider: the cards on other machines that this machine opens. */
  reachOf(provider: string): ReadonlyArray<ReachedCard> {
    return (this.pushed[pushKey.reach(provider)] as ReadonlyArray<ReachedCard> | undefined) ?? [];
  }

  private persist() {
    this.save({
      providers: this.reports().map(({ online: _online, ...report }) => report),
      pushed: this.pushed,
      owners: Object.fromEntries(this.owners),
      execUsers: Object.fromEntries(this.execUsers),
    });
  }
}

/** K-709: a saved desired push holds `{ state, rev }`; one saved before `rev` holds the state itself. */
export function desiredState(value: unknown): DesiredParts {
  const record = value as { state?: DesiredParts; rev?: unknown };
  return record.state !== undefined && "rev" in record ? record.state : (value as DesiredParts);
}
