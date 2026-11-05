// Section 7: what a provider (K-704) tells the daemon, and what the daemon passes on to kitshn over `/connect`.
import { Schema, SchemaGetter } from "effect";

/** K-704: names that a provider cannot take, because kitshn's own kinds start with them (K-301). */
export const RESERVED_PROVIDERS: ReadonlySet<string> = new Set([
  "kitshn",
  "site",
  "repo",
  "machine",
  "page",
  "file",
]);

/** K-704: limits per machine, so one provider cannot fill the Durable Object. */
export const PROVIDER_LIMITS = {
  providers: 8,
  kinds: 20,
  commands: 40,
  /** The cards of all providers of one machine. */
  resources: 500,
  facts: 20,
  stickers: 8,
  lists: 4,
  rows: 100,
  columns: 8,
  /** K-720: the client apps of one provider. */
  clients: 4,
  /** K-709: each part of a desired state, in bytes of its JSON. */
  stateBytes: 64 * 1024,
  /** K-1625: one resource with its facts, stickers and lists, in bytes of its JSON, so a card stays far below a row. */
  resourceBytes: 64 * 1024,
} as const;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const only = (chars: string) => (text: string) => [...text].every((char) => chars.includes(char));

export const isProviderName = (name: string) =>
  name.length >= 1 &&
  name.length <= 32 &&
  LOWER.includes(name[0] ?? "") &&
  only(`${LOWER}${DIGITS}-`)(name) &&
  !RESERVED_PROVIDERS.has(name);

export const ProviderName = Schema.String.check(
  Schema.makeFilter((name: string) => isProviderName(name) || "a provider name of a-z, 0-9 and -"),
);
/** K-302: a kind id starts with the provider name and a dot, for example `t3.thread`. */
const KindId = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(64),
  Schema.makeFilter((id: string) => only(`${LOWER}${DIGITS}.-`)(id) || "a kind id of a-z, 0-9, . and -"),
);
/** The provider's own id of a resource, unique within the provider. */
const LocalId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.makeFilter(
    (id: string) =>
      only(`${LOWER}${LOWER.toUpperCase()}${DIGITS}._-`)(id) || "an id of a-z, A-Z, 0-9, ., _ and -",
  ),
);
const LevelName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(20),
  Schema.makeFilter((name: string) => only(`${LOWER}-`)(name) || "a level name of a-z and -"),
);

/**
 * K-713: the levels of a provider kind, each named by the kitshn level that it stands for, so a circle level
 * maps to it by K-206: `{ view: "view", use: "send" }` gives "send" to a circle with `use` or `control`. A kind
 * without levels is not shareable, and the map hides it.
 */
export const ProviderLevels = Schema.Struct({
  view: Schema.optionalKey(LevelName),
  use: Schema.optionalKey(LevelName),
  control: Schema.optionalKey(LevelName),
});
export type ProviderLevels = typeof ProviderLevels.Type;

const SettingId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40),
  Schema.makeFilter(
    (id: string) => only(`${LOWER}${LOWER.toUpperCase()}${DIGITS}-`)(id) || "an id of a-z, A-Z, 0-9 and -",
  ),
);

/** K-717: a setting of each card of a kind, with a closed list of values; kitshn keeps one value per card. */
export const ProviderCardSetting = Schema.Struct({
  id: SettingId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  values: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(10),
  ),
  default: Schema.String,
});
export type ProviderCardSetting = typeof ProviderCardSetting.Type;

export const ProviderKind = Schema.Struct({
  id: KindId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  levels: ProviderLevels,
  /**
   * K-709: a kind of desired state: one JSON value with a shared part and one part per machine, and no cards. The
   * schema is a JSON Schema of the value, for the editor of the map.
   */
  state: Schema.optionalKey(Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) })),
  /** K-717: settings of each card of this kind. */
  settings: Schema.optionalKey(Schema.Array(ProviderCardSetting).check(Schema.isMaxLength(4))),
  /** K-719: the Owner circle holds every card of this kind at its top level, and nothing removes that share. */
  ownerControl: Schema.optionalKey(Schema.Boolean),
});
export type ProviderKind = typeof ProviderKind.Type;

/** K-707: a command that the provider runs. With no kinds, it is a command of the machine card. */
export const ProviderCommand = Schema.Struct({
  id: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(40),
    Schema.makeFilter((id: string) => only(`${LOWER}${DIGITS}-`)(id) || "a command id of a-z, 0-9 and -"),
  ),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  kinds: Schema.Array(KindId).check(Schema.isMaxLength(20)),
  /** K-1615: the map asks before it runs the command. */
  confirm: Schema.Boolean,
});
export type ProviderCommand = typeof ProviderCommand.Type;

/** K-1625: `version` is compared within one kind, and `busy` holds "when online and idle" jobs (K-1608). */
export const FACT_ROLES = ["version", "busy"] as const;
export const ProviderFact = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
  value: Schema.String.check(Schema.isMaxLength(200)),
  role: Schema.optionalKey(Schema.Literals(FACT_ROLES)),
});
export type ProviderFact = typeof ProviderFact.Type;

export const STICKER_TONES = ["info", "good", "warn", "bad"] as const;
const Link = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (link: string) => link.startsWith("https://") || link.startsWith("http://") || "an http or https link",
  ),
);
export const ProviderSticker = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24)),
  tone: Schema.Literals(STICKER_TONES),
  link: Schema.optionalKey(Link),
});
export type ProviderSticker = typeof ProviderSticker.Type;

const Text = Schema.String.check(Schema.isMaxLength(200));
/**
 * K-1625: a list on a card, such as the scheduled tasks (K-1614) or the sessions (K-1602) of a machine. A row names
 * the commands (K-707) that the card menu offers for it; the command event carries the row id.
 */
export const ProviderList = Schema.Struct({
  id: SettingId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  columns: Schema.Array(
    Schema.Struct({ id: SettingId, title: Schema.String.check(Schema.isMaxLength(40)) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(PROVIDER_LIMITS.columns)),
  rows: Schema.Array(Schema.suspend(() => ProviderRow)).check(Schema.isMaxLength(PROVIDER_LIMITS.rows)),
});

/** K-1625: one row of a list. Its id may be as long as a cell, so a provider never hashes one (protocol 2). */
export const ProviderRow = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  cells: Schema.Record(Schema.String, Text),
  commands: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(8)),
  ),
});
export type ProviderRow = typeof ProviderRow.Type;
export type ProviderList = typeof ProviderList.Type;

// The daemon, the Worker and Node all have the WHATWG `URL`; this package compiles without DOM or Node types.
declare const URL: { canParse(url: string): boolean };

/**
 * K-720: schemes of the web and of browsers. An `open` link with one of them could hand the invite to a web site, so
 * `open` takes only an app's own scheme. Exact names, then prefixes.
 */
const WEB_SCHEMES = [
  "http",
  "https",
  "intent",
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "about",
  "ftp",
  "ws",
  "wss",
  "chrome",
  "firefox",
  "market",
];
const WEB_SCHEME_PREFIXES = ["googlechrome", "x-safari-", "opera", "edge", "microsoft-edge"];

/** K-720: a valid scheme name that only an app registers, never the web or a browser. */
export function isAppScheme(scheme: string): boolean {
  const name = scheme.toLowerCase();
  return (
    name !== "" &&
    LOWER.includes(name[0]!) &&
    only(`${LOWER}${DIGITS}+.-`)(name) &&
    !WEB_SCHEMES.includes(name) &&
    !WEB_SCHEME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * K-720: a client app of the provider, which takes a device invite (K-1601). `open` is a link of the app's own scheme
 * with `{inviteUrl}`: kitshn puts the encoded invite link there. Install links are https and never carry the code.
 */
export const ProviderClient = Schema.Struct({
  id: SettingId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  open: Schema.String.check(
    Schema.isMaxLength(512),
    Schema.makeFilter(
      (open: string) =>
        (open.includes("{inviteUrl}") &&
          URL.canParse(open.replaceAll("{inviteUrl}", "x")) &&
          isAppScheme(open.slice(0, Math.max(0, open.indexOf(":"))))) ||
        "a link of the app's own scheme, with {inviteUrl}",
    ),
  ),
  install: Schema.Array(
    Schema.Struct({
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
      url: Schema.String.check(
        Schema.isMaxLength(512),
        Schema.makeFilter(
          (url: string) =>
            (url.startsWith("https://") && URL.canParse(url) && !url.includes("{inviteUrl}")) ||
            "an https link",
        ),
      ),
    }),
  ).check(Schema.isMaxLength(4)),
});
export type ProviderClient = typeof ProviderClient.Type;

const isDnsLabel = (name: string) =>
  name.length >= 1 &&
  name.length <= 63 &&
  only(`${LOWER}${DIGITS}-`)(name) &&
  !name.startsWith("-") &&
  !name.endsWith("-");

/** A DNS label from any text: lowercase, each run of other characters one `-`, at most `max` characters. */
const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .split("")
    .map((char) => (only(`${LOWER}${DIGITS}`)(char) ? char : "-"))
    .join("")
    .split("-")
    .filter((part) => part !== "")
    .join("-")
    .slice(0, max);

/** A label without the dashes at its end, which a cut can leave. */
const trimDashes = (label: string) => {
  let end = label.length;
  while (end > 0 && label[end - 1] === "-") end--;
  return label.slice(0, end);
};

/**
 * K-705: the name of a new site of a provider: `<provider>-<machine>`, or `<provider>-<resource id>-<machine>` when
 * that one is taken. A site keeps the name that it had before; this names only a site without one.
 */
export function siteName(
  provider: string,
  machineName: string,
  resourceId: string,
  taken: ReadonlySet<string>,
): string {
  const machine = trimDashes(slug(machineName, 40)) || "machine";
  const first = trimDashes(`${provider}-${machine}`.slice(0, 63));
  if (!taken.has(first)) return first;
  return trimDashes(`${provider}-${trimDashes(slug(resourceId, 20)) || "site"}-${machine}`.slice(0, 63));
}

/** K-304: what a provider reports; kitshn sets "offline" itself while the provider is not connected. */
export const PROVIDER_STATUSES = ["running", "stopped", "deploying", "failed", "unknown"] as const;

/**
 * K-705: one resource. `parent` stacks it with the card of another resource of the same provider (K-508). `site`
 * makes the card the live site `<name>.<zone>` of its machine (K-1104), served from a local port.
 */
export const ProviderResource = Schema.Struct({
  id: LocalId,
  kind: KindId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  status: Schema.Literals(PROVIDER_STATUSES),
  parent: Schema.optionalKey(LocalId),
  /**
   * K-705: a provider sends only `port`; the daemon names the site (`siteName`) and keeps that name, so the name in a
   * report to kitshn is always set. A name that a provider sends is ignored.
   */
  site: Schema.optionalKey(
    Schema.Struct({
      name: Schema.optionalKey(
        Schema.String.check(
          Schema.isMinLength(1),
          Schema.isMaxLength(63),
          Schema.makeFilter((name: string) => isDnsLabel(name) || "a DNS label of a-z, 0-9 and -"),
        ),
      ),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
  facts: Schema.optionalKey(Schema.Array(ProviderFact).check(Schema.isMaxLength(PROVIDER_LIMITS.facts))),
  stickers: Schema.optionalKey(
    Schema.Array(ProviderSticker).check(Schema.isMaxLength(PROVIDER_LIMITS.stickers)),
  ),
  lists: Schema.optionalKey(Schema.Array(ProviderList).check(Schema.isMaxLength(PROVIDER_LIMITS.lists))),
});
export type ProviderResource = typeof ProviderResource.Type;

/** K-704: one provider of a machine as the daemon reports it to kitshn: its last registration and its resources. */
export const ProviderReport = Schema.Struct({
  name: ProviderName,
  /** False while no connection of the provider is open; kitshn then shows its cards as offline. */
  online: Schema.Boolean,
  kinds: Schema.Array(ProviderKind).check(Schema.isMaxLength(PROVIDER_LIMITS.kinds)),
  commands: Schema.Array(ProviderCommand).check(Schema.isMaxLength(PROVIDER_LIMITS.commands)),
  resources: Schema.Array(ProviderResource).check(Schema.isMaxLength(PROVIDER_LIMITS.resources)),
  clients: Schema.optionalKey(
    Schema.Array(ProviderClient).check(Schema.isMaxLength(PROVIDER_LIMITS.clients)),
  ),
});
export type ProviderReport = typeof ProviderReport.Type;
export const decodeProviderReports = Schema.decodeUnknownSync(
  Schema.Array(ProviderReport).check(Schema.isMaxLength(PROVIDER_LIMITS.providers)),
);

/**
 * K-706: one member rule of a circle. `clientId` is what the Access JWT carries in `common_name`, so the provider
 * matches a device or a machine from the JWT alone.
 */
const KnownRule = Schema.Union([
  Schema.Struct({ email: Schema.String }),
  Schema.Struct({ domain: Schema.String }),
  Schema.Struct({ ip: Schema.String }),
  Schema.Struct({ device: Schema.Struct({ clientId: Schema.String, name: Schema.String }) }),
  Schema.Struct({ machine: Schema.Struct({ machineId: Schema.String, clientId: Schema.String }) }),
  Schema.Struct({ everyone: Schema.Literal(true) }),
]);
/** A rule of a type that this reader does not know. It never matches, and in an "all" circle it fails the grant. */
const UnknownRule = Schema.Struct({ unknown: Schema.String });
const isKnownRule = Schema.is(KnownRule);

/**
 * K-706: a rule decodes forward compatibly: a type that a newer kitshn adds becomes `{ unknown: <its key> }`, so the
 * rest of the table still decodes and the new rule never widens access.
 */
export const GrantRule = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Union([KnownRule, UnknownRule]), {
    decode: SchemaGetter.transform((value: unknown) =>
      isKnownRule(value)
        ? value
        : {
            unknown:
              typeof value === "object" && value !== null ? (Object.keys(value)[0] ?? "") : typeof value,
          },
    ),
    encode: SchemaGetter.transform((rule) => rule),
  }),
);
export type GrantRule = typeof GrantRule.Type;

/**
 * K-706: one share of a resource. `level` is the provider's name of the level. `endsAt` is the earlier of the end
 * of the circle and of the share (K-209), in ms; the provider ends the sessions of the share at that time itself.
 */
export const Grant = Schema.Struct({
  circle: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    match: Schema.Literals(["any", "all"]),
    needsPasskey: Schema.Boolean,
    rules: Schema.Array(GrantRule),
  }),
  level: Schema.String,
  endsAt: Schema.NullOr(Schema.Number),
});
export type Grant = typeof Grant.Type;

/** K-706: the grant table of each resource of one provider, by the provider's resource id. */
export const GrantTables = Schema.Record(Schema.String, Schema.Array(Grant));
export type GrantTables = typeof GrantTables.Type;

/** Protocol 2: one item that the daemon dropped or clipped, by its path in the request, and why. */
export interface ProviderProblem {
  readonly path: string;
  readonly reason: string;
}
export const ProviderProblem = Schema.Struct({ path: Schema.String, reason: Schema.String });

const decodeRow = Schema.decodeUnknownSync(ProviderRow);
const decodeFact = Schema.decodeUnknownSync(ProviderFact);
const decodeSticker = Schema.decodeUnknownSync(ProviderSticker);
const decodeResource = Schema.decodeUnknownSync(ProviderResource);
const decodeClient = Schema.decodeUnknownSync(ProviderClient);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keeps the items of `raw` that `decode` takes, and names each other one at `path[i]`. */
function keepDecoded<T>(
  raw: unknown,
  path: string,
  what: string,
  decode: (value: unknown) => T,
  problems: Array<ProviderProblem>,
  limit: number,
): Array<T> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push({ path, reason: `not a list; ${what}s dropped` });
    return [];
  }
  const kept: Array<T> = [];
  raw.forEach((item, index) => {
    if (index >= limit) {
      problems.push({ path: `${path}[${index}]`, reason: `more than ${limit} ${what}s; ${what} dropped` });
      return;
    }
    try {
      kept.push(decode(item));
    } catch (error) {
      problems.push({ path: `${path}[${index}]`, reason: `${reasonOf(error)}; ${what} dropped` });
    }
  });
  return kept;
}

/**
 * Protocol 2: the resources of a `register` or `upsert` that decode, item by item. A bad list row, fact or sticker
 * goes alone; a resource that still does not decode goes whole. Each dropped item is a problem with its path.
 */
export function decodeResources(
  raw: ReadonlyArray<unknown>,
  path = "resources",
): { readonly resources: Array<ProviderResource>; readonly problems: Array<ProviderProblem> } {
  const problems: Array<ProviderProblem> = [];
  const resources: Array<ProviderResource> = [];
  raw.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (!isRecord(item)) {
      problems.push({ path: at, reason: "not an object; resource dropped" });
      return;
    }
    const clean: Record<string, unknown> = { ...item };
    if ("facts" in item)
      clean["facts"] = keepDecoded(
        item["facts"],
        `${at}.facts`,
        "fact",
        decodeFact,
        problems,
        PROVIDER_LIMITS.facts,
      );
    if ("stickers" in item)
      clean["stickers"] = keepDecoded(
        item["stickers"],
        `${at}.stickers`,
        "sticker",
        decodeSticker,
        problems,
        PROVIDER_LIMITS.stickers,
      );
    if (Array.isArray(item["lists"]))
      clean["lists"] = item["lists"].slice(0, PROVIDER_LIMITS.lists).map((list, listIndex) =>
        isRecord(list)
          ? {
              ...list,
              rows: keepDecoded(
                list["rows"],
                `${at}.lists[${listIndex}].rows`,
                "row",
                decodeRow,
                problems,
                PROVIDER_LIMITS.rows,
              ),
            }
          : list,
      );
    try {
      resources.push(decodeResource(clean));
    } catch (error) {
      problems.push({ path: at, reason: `${reasonOf(error)}; resource dropped` });
    }
  });
  return { resources, problems };
}

/** Protocol 2, K-720: the client apps that decode; each other one is a problem. */
export const decodeClients = (raw: ReadonlyArray<unknown>, problems: Array<ProviderProblem>) =>
  keepDecoded(raw, "clients", "client", decodeClient, problems, PROVIDER_LIMITS.clients);

/**
 * K-704: why the shape of a provider is broken, so the whole `register` is refused, or null. Each kind id starts with
 * the provider name, kind and command ids are unique, each command names known kinds, resource ids are unique, and
 * the machine stays within the limits of providers and cards.
 */
export function shapeProblem(report: ProviderReport, others: ReadonlyArray<ProviderReport>): string | null {
  const kinds = new Map(report.kinds.map((kind) => [kind.id, kind]));
  if (kinds.size !== report.kinds.length) return "two kinds have the same id.";
  for (const id of kinds.keys())
    if (!id.startsWith(`${report.name}.`) || id.length === report.name.length + 1)
      return `the kind ${id} does not start with ${report.name}. (K-302).`;
  for (const kind of kinds.values())
    for (const setting of kind.settings ?? [])
      if (!setting.values.includes(setting.default))
        return `the setting ${setting.id} of ${kind.id} has a default that is not one of its values.`;
  const commands = new Map(report.commands.map((command) => [command.id, command]));
  if (commands.size !== report.commands.length) return "two commands have the same id.";
  for (const command of report.commands)
    for (const kind of command.kinds)
      if (!kinds.has(kind)) return `the command ${command.id} names the unknown kind ${kind}.`;
  const ids = new Set(report.resources.map((resource) => resource.id));
  if (ids.size !== report.resources.length) return "two resources have the same id.";
  const total = others.reduce((sum, other) => sum + other.resources.length, report.resources.length);
  if (total > PROVIDER_LIMITS.resources)
    return `the providers of this machine would have ${total} resources, more than ${PROVIDER_LIMITS.resources}.`;
  if (!others.some((other) => other.name === report.name) && others.length >= PROVIDER_LIMITS.providers)
    return `this machine has ${PROVIDER_LIMITS.providers} providers already.`;
  return null;
}

/**
 * Protocol 2: the report without the resources and rows that break a rule of their own, each named as a problem: a
 * resource with an unknown kind, a kind without levels, an unknown parent, too many bytes, or a site name that kitshn
 * or another card holds; a row that names a command its kind does not have, or a cell of no column.
 */
export function screenResources(
  report: ProviderReport,
  others: ReadonlyArray<ProviderReport>,
  takenSites: ReadonlySet<string>,
  /** The site names of kitshn itself, such as `pages` (K-817). */
  reserved: ReadonlySet<string>,
  /** The index of each resource in the request, for the path of a problem. */
  pathOf: (id: string) => string = (id) => `resources[id=${id}]`,
): { readonly report: ProviderReport; readonly problems: Array<ProviderProblem> } {
  const problems: Array<ProviderProblem> = [];
  const kinds = new Map(report.kinds.map((kind) => [kind.id, kind]));
  const commands = new Map(report.commands.map((command) => [command.id, command]));
  const otherSites = new Map(
    others.flatMap((other) =>
      other.resources.flatMap((resource) =>
        resource.site ? [[resource.site.name, other.name] as const] : [],
      ),
    ),
  );
  const sites = new Set<string>();
  const drop = (resource: ProviderResource, reason: string) => {
    problems.push({ path: pathOf(resource.id), reason: `${reason}; resource dropped` });
    return [];
  };
  const firstPass = report.resources.flatMap((resource): Array<ProviderResource> => {
    const kind = kinds.get(resource.kind);
    if (!kind) return drop(resource, `the kind ${resource.kind} is unknown`);
    if (Object.keys(kind.levels).length === 0)
      return drop(resource, `the kind ${kind.id} has no levels, so it has no cards (K-709)`);
    if (bytesOf(resource) > PROVIDER_LIMITS.resourceBytes)
      return drop(resource, `it holds more than ${PROVIDER_LIMITS.resourceBytes} bytes`);
    if (resource.site) {
      const name = resource.site.name;
      // The daemon names each site before it screens, so a site without a name is never kept (K-705).
      if (name === undefined) return drop(resource, "its site has no name");
      if (reserved.has(name)) return drop(resource, `the site name ${name} is a name of kitshn itself`);
      if (sites.has(name) || takenSites.has(name))
        return drop(resource, `the site name ${name} is in use on this machine`);
      const owner = otherSites.get(name);
      if (owner) return drop(resource, `the site name ${name} belongs to the provider ${owner}`);
      sites.add(name);
    }
    const lists = (resource.lists ?? []).map((list, listIndex) => {
      const columns = new Set(list.columns.map((column) => column.id));
      return {
        ...list,
        rows: list.rows.filter((row, rowIndex) => {
          const command = (row.commands ?? []).find((id) => !commands.get(id)?.kinds.includes(resource.kind));
          const cell = Object.keys(row.cells).find((key) => !columns.has(key));
          const reason =
            command !== undefined
              ? `it names the command ${command}, which the kind ${resource.kind} does not have`
              : cell !== undefined
                ? `its cell ${cell} is no column`
                : null;
          if (reason)
            problems.push({
              path: `${pathOf(resource.id)}.lists[${listIndex}].rows[${rowIndex}]`,
              reason: `${reason}; row dropped`,
            });
          return reason === null;
        }),
      };
    });
    return [resource.lists ? { ...resource, lists } : resource];
  });
  // A parent that went with a dropped resource takes its children along.
  let kept = firstPass;
  for (;;) {
    const ids = new Set(kept.map((resource) => resource.id));
    const next = kept.filter((resource) => {
      if (resource.parent === undefined || (resource.parent !== resource.id && ids.has(resource.parent)))
        return true;
      problems.push({
        path: pathOf(resource.id),
        reason: `the parent ${resource.parent} is unknown; resource dropped`,
      });
      return false;
    });
    if (next.length === kept.length) break;
    kept = next;
  }
  return { report: { ...report, resources: kept }, problems };
}

/**
 * K-704, K-705: why a provider's set of resources is not valid, or null: the shape of `shapeProblem`, and no resource
 * or row that `screenResources` would drop. kitshn checks each report from a daemon with it; a daemon of protocol 2
 * screens first, so its reports pass.
 */
export function reportProblem(
  report: ProviderReport,
  others: ReadonlyArray<ProviderReport>,
  takenSites: ReadonlySet<string>,
  /** The site names of kitshn itself, such as `pages` (K-817). */
  reserved: ReadonlySet<string>,
): string | null {
  const shape = shapeProblem(report, others);
  if (shape) return shape;
  const [first] = screenResources(report, others, takenSites, reserved).problems;
  return first ? `${first.path}: ${first.reason}` : null;
}

/** K-709: the parts of a desired state that one machine gets: the shared part and its own; null where none is set. */
export const DesiredParts = Schema.Struct({ shared: Schema.Unknown, machine: Schema.Unknown });
export type DesiredParts = typeof DesiredParts.Type;

/** K-717: card setting values, by the provider's resource id, then by setting id. */
export const CardSettingValues = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String));
export type CardSettingValues = typeof CardSettingValues.Type;

/** K-1608: the keys of the pushes of kitshn, one per thing that a provider applies. */
export const pushKey = {
  grants: (provider: string) => `grants:${provider}`,
  settings: (provider: string) => `settings:${provider}`,
  desired: (provider: string, kind: string) => `desired:${provider}:${kind}`,
  reach: (provider: string) => `reach:${provider}`,
  access: (provider: string) => `access:${provider}`,
  /** K-721: whether kitshn is paused, for every provider of the machine. */
  paused: () => "kitshn:paused",
  /** K-722: the machines whose "runs" covers this machine at automatic. */
  execRights: () => "kitshn:execRights",
} as const;

/** The UTF-8 length of a value's JSON; this package runs without DOM types, so it counts by hand. */
function bytesOf(value: unknown): number {
  let bytes = 0;
  for (const char of JSON.stringify(value ?? null)) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * K-709: why a desired state part is refused, or null: the provider registered the kind with `state`, and the part
 * holds at most `PROVIDER_LIMITS.stateBytes`. The daemon checks it before it answers, and kitshn again when it writes.
 * kitshn does not check the value against the kind's schema; the provider validates what it applies.
 */
export function desiredProblem(
  kinds: ReadonlyArray<ProviderKind>,
  kind: string,
  value: unknown,
): string | null {
  if (!kinds.some((item) => item.id === kind && item.state !== undefined))
    return `the kind ${kind} has no desired state (K-709).`;
  if (bytesOf(value) > PROVIDER_LIMITS.stateBytes)
    return `a desired state part holds at most ${PROVIDER_LIMITS.stateBytes} bytes (K-709).`;
  return null;
}

/**
 * K-1609: one card of the same provider on another machine that this machine opens, with the provider's name of the
 * level that this machine has there. The link proxy of the daemon reaches its address with the machine token.
 */
export const ReachedCard = Schema.Struct({
  machineId: Schema.String,
  machineName: Schema.String,
  kind: Schema.String,
  id: Schema.String,
  address: Schema.NullOr(Schema.String),
  level: Schema.String,
});
export type ReachedCard = typeof ReachedCard.Type;

/**
 * K-1623: what a provider checks Access tokens against: the team domain, and the AUD tags of kitshn's Access
 * applications on the provider's site hosts on this machine. Empty while no application exists yet.
 */
export const ProviderAccess = Schema.Struct({
  teamDomain: Schema.String,
  audiences: Schema.Array(Schema.String),
  /**
   * The provider's site hosts whose DNS record points at kitshn's tunnel: after a handover, and sites that kitshn
   * served from the start. A give-back drops its host before the record moves back.
   */
  served: Schema.Array(Schema.String),
});
export type ProviderAccess = typeof ProviderAccess.Type;
