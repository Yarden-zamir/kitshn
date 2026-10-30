// Section 7: the cards of a machine's providers (K-704, K-705) and the grant tables that kitshn pushes to them (K-706).
import {
  type DesiredParts,
  type Grant,
  type GrantRule,
  type GrantTables,
  type ProviderCommand,
  type ProviderKind,
  type ProviderReport,
  type ProviderAccess,
  type ReachedCard,
  pushKey,
} from "@kitshn/local";
import { circleMatches, visitorLevel } from "./visitor.ts";
import { circlePolicies } from "./access.ts";
import { type Machine, type ReachedSite } from "./machine.ts";
import {
  type Member,
  type Resource,
  type State,
  activeShares,
  levelName,
  providerCardId,
  shareKey,
} from "./model.ts";

/**
 * K-705: the cards that the reports of one machine describe, by card id. A card of a provider that is not online
 * shows "offline" (K-304). `zone` makes the address of a card with a site (K-1104).
 */
export function providerCards(
  machine: Pick<Machine, "id">,
  reports: ReadonlyArray<ProviderReport>,
  zone: string,
): Map<string, Resource> {
  const cards = new Map<string, Resource>();
  for (const report of reports) {
    const kinds = new Map(report.kinds.map((kind) => [kind.id, kind]));
    for (const item of report.resources) {
      const kind = kinds.get(item.kind);
      if (!kind) continue;
      const id = providerCardId(machine.id, report.name, item.id);
      cards.set(id, {
        id,
        kind: item.kind as Resource["kind"],
        name: item.name,
        addresses: item.site ? [`${item.site.name}.${zone}`] : [],
        status: report.online ? item.status : "offline",
        // K-508: a resource stacks with the card of its parent.
        group: item.parent === undefined ? null : providerCardId(machine.id, report.name, item.parent),
        machine: machine.id,
        provider: {
          name: report.name,
          localId: item.id,
          kindName: kind.name,
          levels: kind.levels,
          facts: item.facts ?? [],
          stickers: item.stickers ?? [],
          lists: item.lists ?? [],
          settings: kind.settings ?? [],
          ...(kind.ownerControl === true ? { ownerControl: true as const } : {}),
          site: item.site?.name ?? null,
        },
      });
    }
  }
  return cards;
}

const ruleOf = (member: Member, machines: ReadonlyMap<string, Machine>): GrantRule | null => {
  switch (member._tag) {
    case "email":
      return { email: member.email.toLowerCase() };
    case "domain":
      return { domain: member.domain.toLowerCase() };
    case "ip":
      return { ip: member.range };
    case "device": {
      // A machine's daemon token held as a device member is that machine (K-107): the provider admits machines only
      // through a machine rule.
      const machine = [...machines.values()].find((item) => item.clientId === member.clientId);
      return machine
        ? { machine: { machineId: machine.id, clientId: machine.clientId } }
        : { device: { clientId: member.clientId, name: member.name } };
    }
    case "machine": {
      const machine = machines.get(member.machineId);
      return machine ? { machine: { machineId: machine.id, clientId: machine.clientId } } : null;
    }
    case "everyone":
      return { everyone: true };
  }
};

/**
 * K-706: the grants of one card: each share that gives access now, with the provider's name of its level. A pause
 * closes every share of a provider card (K-1504, K-1618), and an end date ends one (K-209). A circle with "all must
 * match" that names a machine kitshn does not know gets no grant, because dropping that rule would widen it (K-006).
 */
export function grantsOf(state: State, card: Resource, now: number): Array<Grant> {
  const grants: Array<Grant> = [];
  for (const share of activeShares(state, card, now)) {
    const { circle } = share;
    const known = circle.members.map((member) => ruleOf(member, state.machines));
    if (circle.match === "all" && known.includes(null)) continue;
    const rules = known.filter((rule) => rule !== null);
    if (rules.length === 0) continue;
    const shareEnds = state.shareSettings.get(shareKey(card.id, circle.id))?.endsAt ?? null;
    const ends = [circle.endsAt, shareEnds].filter((time) => time !== null);
    grants.push({
      circle: {
        id: circle.id,
        name: circle.name,
        match: circle.match,
        needsPasskey: circle.needsPasskey,
        rules,
      },
      level: levelName(card, share.level),
      endsAt: ends.length === 0 ? null : Math.min(...ends),
    });
  }
  return grants;
}

/** K-706: the grant table of each card of one provider of a machine, by the provider's own id of the resource. */
export function grantTables(state: State, machineId: string, provider: string, now: number): GrantTables {
  const tables: Record<string, Array<Grant>> = {};
  for (const card of state.resources.values())
    // K-705: a dropped card waits with no grants; the provider no longer has it.
    if (
      card.machine === machineId &&
      card.provider?.name === provider &&
      card.provider.droppedAt === undefined
    )
      tables[card.provider.localId] = grantsOf(state, card, now);
  return tables;
}

/** K-707: the commands of a machine's providers that fit one card, or the commands of the machine card. */
export function commandsFor(
  providers: ReadonlyArray<Pick<ProviderReport, "name" | "commands">>,
  card: Pick<Resource, "kind" | "provider">,
): Array<{ readonly provider: string; readonly command: ProviderCommand }> {
  return providers.flatMap((report) =>
    report.commands
      .filter((command) =>
        card.provider
          ? card.provider.name === report.name && command.kinds.includes(card.kind)
          : card.kind === "machine" && command.kinds.length === 0,
      )
      .map((command) => ({ provider: report.name, command })),
  );
}

/** K-1608: one push of kitshn to a machine, by the key that the daemon reports back when it applied it. */
export type ProviderPush =
  | { readonly key: string; readonly type: "grants"; readonly provider: string; readonly tables: GrantTables }
  | {
      readonly key: string;
      readonly type: "desired";
      readonly provider: string;
      readonly kind: string;
      readonly state: DesiredParts;
      readonly rev: string | null;
    }
  | { readonly key: string; readonly type: "paused"; readonly paused: boolean }
  | { readonly key: string; readonly type: "execRights"; readonly machines: ReadonlyArray<string> }
  | { readonly key: string; readonly type: "siteReach"; readonly cards: ReadonlyArray<ReachedSite> }
  | {
      readonly key: string;
      readonly type: "reach";
      readonly provider: string;
      readonly cards: ReadonlyArray<ReachedCard>;
    }
  | {
      readonly key: string;
      readonly type: "access";
      readonly provider: string;
      readonly access: ProviderAccess;
    }
  | {
      readonly key: string;
      readonly type: "settings";
      readonly provider: string;
      readonly values: Record<string, Record<string, string>>;
    };

/**
 * K-706, K-709, K-717: everything that the providers of one machine get: the grant tables and card settings of each
 * provider, and the shared part and this machine's part of each desired state. `desired` holds the parts of each kind
 * by machine id, with "" for the shared part; `settings` the stored values by card id.
 */
export function providerPushes(
  state: State,
  machineId: string,
  regs: ReadonlyArray<{ readonly name: string; readonly kinds: ReadonlyArray<ProviderKind> }>,
  desired: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  settings: ReadonlyMap<string, Readonly<Record<string, string>>>,
  now: number,
  access: {
    readonly teamDomain: string;
    readonly audiencesOf: (cardId: string) => ReadonlyArray<string>;
    /** K-1623: the host that kitshn serves for this card now, or null. */
    readonly servedHost: (cardId: string) => string | null;
    /** K-709: the rev of the last set of a desired state, or null. */
    readonly revOf: (kind: string) => string | null;
  },
): Array<ProviderPush> {
  return regs.flatMap(({ name, kinds }) => {
    const values: Record<string, Record<string, string>> = {};
    for (const card of state.resources.values())
      if (card.machine === machineId && card.provider?.name === name && card.provider.settings.length > 0)
        values[card.provider.localId] = Object.fromEntries(
          card.provider.settings.map((setting) => [
            setting.id,
            settingValue(setting, settings.get(card.id)?.[setting.id]),
          ]),
        );
    return [
      {
        key: pushKey.grants(name),
        type: "grants",
        provider: name,
        tables: grantTables(state, machineId, name, now),
      },
      {
        key: pushKey.reach(name),
        type: "reach",
        provider: name,
        cards: reachOf(state, machineId, name, now),
      },
      { key: pushKey.settings(name), type: "settings", provider: name, values },
      {
        key: pushKey.access(name),
        type: "access",
        provider: name,
        access: {
          teamDomain: access.teamDomain,
          audiences: siteAudiences(state, machineId, name, access.audiencesOf),
          served: siteCards(state, machineId, name)
            .flatMap((card) => access.servedHost(card.id) ?? [])
            .sort(),
        },
      },
      ...kinds
        .filter((kind) => kind.state !== undefined)
        .map((kind): ProviderPush => ({
          key: pushKey.desired(name, kind.id),
          type: "desired",
          provider: name,
          kind: kind.id,
          state: {
            shared: desired.get(kind.id)?.get("") ?? null,
            machine: desired.get(kind.id)?.get(machineId) ?? null,
          },
          rev: access.revOf(kind.id),
        })),
    ];
  });
}

/**
 * K-1623: the AUD tags of kitshn's Access applications of one provider's site cards on a machine, so the provider
 * accepts tokens of those applications. `audiencesOf` gives the applications that exist, also one whose address the
 * card just gave back, because it answers until the sync deletes it. A card without an application adds none.
 */
export function siteAudiences(
  state: State,
  machineId: string,
  provider: string,
  audiencesOf: (cardId: string) => ReadonlyArray<string>,
): Array<string> {
  const audiences = new Set<string>();
  for (const card of siteCards(state, machineId, provider))
    for (const aud of audiencesOf(card.id)) audiences.add(aud);
  return [...audiences].sort();
}

/** K-1623: the cards of one provider on a machine that have a site. */
const siteCards = (state: State, machineId: string, provider: string) =>
  [...state.resources.values()].filter(
    (card) => card.machine === machineId && card.provider?.name === provider && card.provider.site,
  );

/** K-717: a stored value that the kind still offers, else its default. */
const settingValue = (
  setting: { readonly values: ReadonlyArray<string>; readonly default: string },
  stored?: string,
) => (stored !== undefined && setting.values.includes(stored) ? stored : setting.default);

/**
 * K-1608, K-1625: a provider card of the machine reports the fact `busy` = "true" and runs: a card that is offline or
 * that its provider dropped keeps its last facts (K-705), so it never holds a job.
 */
export function machineBusy(state: State, machineId: string): boolean {
  return [...state.resources.values()].some(
    (card) =>
      card.machine === machineId &&
      card.status !== "offline" &&
      card.provider?.droppedAt === undefined &&
      card.provider?.facts.some((fact) => fact.role === "busy" && fact.value === "true") === true,
  );
}

/**
 * K-1609: the cards of one provider on other machines that a machine opens, as Access decides it for the machine's
 * token: its client id, no person and no address. A pause and an end date count as in Access (K-1504, K-209).
 */
export function reachOf(state: State, machineId: string, provider: string, now: number): Array<ReachedCard> {
  const machine = state.machines.get(machineId);
  if (!machine) return [];
  const visitor = { email: null, clientId: machine.clientId, ip: null };
  return [...state.resources.values()].flatMap((card) => {
    if (card.machine === null || card.machine === machineId || card.provider?.name !== provider) return [];
    if (card.provider.droppedAt !== undefined) return [];
    const level = visitorLevel(state, card, visitor, now);
    return level === null
      ? []
      : [
          {
            machineId: card.machine,
            machineName: state.machines.get(card.machine)?.name ?? card.machine,
            kind: card.kind,
            id: card.provider.localId,
            address: card.addresses[0] ?? null,
            level: levelName(card, level),
          },
        ];
  });
}

/** K-1609: live sites on other machines that Access admits this machine to, independent of providers. */
export function siteReachOf(state: State, machineId: string, now: number): Array<ReachedSite> {
  const machine = state.machines.get(machineId);
  if (!machine) return [];
  const visitor = { email: null, clientId: machine.clientId, ip: null };
  return [...state.resources.values()]
    .flatMap((card): Array<ReachedSite> => {
      const address = card.addresses[0];
      if (card.kind !== "site.live" || card.machine === null || card.machine === machineId || !address)
        return [];
      if (visitorLevel(state, card, visitor, now) === null) return [];
      // Access refuses impossible "all" policies (such as two tokens), even when the raw members match.
      const allowed = activeShares(state, card, now).some(({ circle }) => {
        if (!circleMatches(circle, visitor, state.machines)) return false;
        return [...circlePolicies(circle, state.machines).values()].some(
          (policy) => policy.decision === "non_identity" || policy.decision === "bypass",
        );
      });
      return allowed ? [{ id: card.id, address }] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
