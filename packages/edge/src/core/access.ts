import { type Machine, siteLinkDomain } from "./machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Member,
  OWNER_CIRCLE_ID,
  type State,
  activeShares,
} from "./model.ts";

/** An Access rule, in the shape of the Cloudflare API. */
export type Rule =
  | { readonly email: { readonly email: string } }
  | { readonly email_domain: { readonly domain: string } }
  | { readonly ip: { readonly ip: string } }
  | { readonly service_token: { readonly token_id: string } }
  | { readonly everyone: Record<string, never> };

export interface PolicyBody {
  readonly name: string;
  readonly decision: "allow" | "bypass" | "non_identity";
  readonly include: ReadonlyArray<Rule>;
  readonly require: ReadonlyArray<Rule>;
  readonly exclude: ReadonlyArray<Rule>;
  readonly mfa_config?: {
    readonly allowed_authenticators: ReadonlyArray<"biometrics" | "security_key">;
    readonly session_duration: string;
  };
}

export interface AppBody {
  readonly name: string;
  readonly type: "self_hosted";
  readonly domain: string;
  readonly session_duration: string;
  /** Another site cannot send the Access cookie in a request that changes state. */
  readonly same_site_cookie_attribute: "lax";
  /** K-1723: the cookie stays on the path, so the admin cookie of the whole host never replaces it. */
  readonly path_cookie_attribute?: true;
  /** Keys of `DesiredAccess.policies`, in precedence order. */
  readonly policyKeys: ReadonlyArray<string>;
  /** K-1130: the kitshn login page of the application; absent while the bootstrap made no pages. */
  readonly custom_pages?: ReadonlyArray<string>;
  /** K-1132: where Access sends a visitor whom no policy lets in, instead of its own "no access" page. */
  readonly custom_deny_url?: string;
}

/** K-1130: the ids of the kitshn Access login pages that the bootstrap made. */
export interface LoginPages {
  /** "Let me in, I'm the chef": a card that only the Owner circle's people open. */
  readonly chef: string;
  /** "This place is closed.": a card in no circle, which nobody opens. */
  readonly closed: string;
  /** The kitshn sign-in with the card name: every other application. */
  readonly login: string;
}

export interface DesiredAccess {
  readonly policies: ReadonlyMap<string, PolicyBody>;
  readonly apps: ReadonlyMap<string, AppBody>;
  /** K-1004: keys of `policies` for the login applications of pages and files, in precedence order. */
  readonly logins: { readonly login: ReadonlyArray<string>; readonly passkey: ReadonlyArray<string> };
  /** K-1130: the login page of the login applications of pages and files, or null without kitshn pages. */
  readonly loginPage: string | null;
}

/** K-1132: the key of the application of `/ask`, where a refused person asks the owner for access. */
export const ASK_APP = "app:ask:help";

/**
 * K-1132: the help pages are on (the bootstrap made the Bypass application of `/public/help`) on this host. `askLive`
 * is true once the application of `/ask` exists in Cloudflare, so a refusal may go there without a redirect loop.
 */
export interface HelpPages {
  readonly host: string;
  readonly askLive: boolean;
}

/** K-1723: the keys of the two approve applications. */
export const APPROVE_APPS = { passkey: "app:approve:passkey", login: "app:approve:login" } as const;

export const PASSKEY_MFA = {
  allowed_authenticators: ["biometrics", "security_key"],
  session_duration: "24h",
} as const;

/** Names of everything kitshn makes in Access start with this, so kitshn never touches other objects (K-408). */
export const ACCESS_NAME_PREFIX = "kitshn ";

export const peoplePolicyName = (circle: Pick<Circle, "name">) =>
  `${ACCESS_NAME_PREFIX}circle ${circle.name}`;
export const tokenPolicyName = (circle: Pick<Circle, "name">) =>
  `${ACCESS_NAME_PREFIX}circle ${circle.name} (devices and networks)`;
/** K-113: the reusable policy on the App Launcher, so people of passkey circles can enroll a passkey. */
export const ENROLLMENT_KEY = "policy:enrollment";
export const ENROLLMENT_POLICY_NAME = `${ACCESS_NAME_PREFIX}passkey enrollment`;

export const appName = (resourceName: string) =>
  resourceName.startsWith(ACCESS_NAME_PREFIX) ? resourceName : `${ACCESS_NAME_PREFIX}${resourceName}`;

const personRule = (member: Member): Rule | null =>
  member._tag === "email"
    ? { email: { email: member.email } }
    : member._tag === "domain"
      ? { email_domain: { domain: member.domain } }
      : null;

/** A device or a machine is its service token (K-106, K-107). An unknown machine compiles to no rule. */
const tokenRule = (member: Member, machines: ReadonlyMap<string, Machine>): Rule | null => {
  if (member._tag === "device") return { service_token: { token_id: member.tokenId } };
  if (member._tag !== "machine") return null;
  const machine = machines.get(member.machineId);
  return machine ? { service_token: { token_id: machine.serviceTokenId } } : null;
};

const networkRule = (member: Member): Rule | null =>
  member._tag === "ip" ? { ip: { ip: member.range } } : null;

const present = <T>(values: ReadonlyArray<T | null>): Array<T> => values.filter((value) => value !== null);

/**
 * K-402: a circle becomes reusable policies. Access needs the Service Auth decision for service tokens and
 * networks without login, so a circle makes up to two policies: people (allow, with the passkey check of
 * K-103) and devices and networks (non_identity). "Everyone" makes one Bypass policy (K-403).
 */
export function circlePolicies(
  circle: Circle,
  machines: ReadonlyMap<string, Machine>,
): Map<string, PolicyBody> {
  const policies = new Map<string, PolicyBody>();
  const people = present(circle.members.map(personRule));
  const tokens = present(circle.members.map((member) => tokenRule(member, machines)));
  const networks = present(circle.members.map(networkRule));
  const base = { exclude: [] as Array<Rule> };
  const mfa = circle.needsPasskey ? { mfa_config: PASSKEY_MFA } : {};
  const isPublic = circle.members.some((member) => member._tag === "everyone");

  if (circle.match === "any") {
    if (isPublic) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        name: peoplePolicyName(circle),
        decision: "bypass",
        include: [{ everyone: {} }],
        require: [],
      });
      return policies;
    }
    if (people.length > 0) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        ...mfa,
        name: peoplePolicyName(circle),
        decision: "allow",
        include: people,
        require: [],
      });
    }
    if (tokens.length + networks.length > 0) {
      policies.set(`policy:${circle.id}:tokens`, {
        ...base,
        name: tokenPolicyName(circle),
        decision: "non_identity",
        include: [...tokens, ...networks],
        require: [],
      });
    }
    return policies;
  }

  // "All must match": the first rule includes, the others require. "Everyone" adds nothing here.
  // A member that cannot become a require rule would widen the circle, so such a circle gets no
  // policy (K-006): an unknown machine, people with a token, or two tokens.
  const impossible =
    circle.members.some((member) => member._tag === "machine" && !machines.has(member.machineId)) ||
    (people.length > 0 && tokens.length > 0) ||
    tokens.length > 1;
  if (impossible) return policies;
  if (people.length > 0) {
    const [first, ...rest] = people;
    if (first) {
      policies.set(`policy:${circle.id}:people`, {
        ...base,
        ...mfa,
        name: peoplePolicyName(circle),
        decision: "allow",
        include: [first],
        require: [...rest, ...networks],
      });
    }
    return policies;
  }
  const [first, ...rest] = [...tokens, ...networks];
  if (first) {
    policies.set(`policy:${circle.id}:tokens`, {
      ...base,
      name: tokenPolicyName(circle),
      decision: "non_identity",
      include: [first],
      require: rest,
    });
  }
  if (!first && isPublic) {
    policies.set(`policy:${circle.id}:people`, {
      ...base,
      name: peoplePolicyName(circle),
      decision: "bypass",
      include: [{ everyone: {} }],
      require: [],
    });
  }
  return policies;
}

/** Resource kinds that the Worker serves and checks itself (K-404) get no Access application. */
// K-2003: a game card has no Access application; the Worker checks its join page like a page.
const WORKER_CHECKED = new Set(["page", "file", "game"]);

/** K-909: the address of a removed app that its machine still serves; `id` was its card id. */
export interface RemovedSite {
  readonly id: string;
  readonly name: string;
  readonly address: string;
}

/**
 * K-401, K-402: the Access objects that the shares compile to. K-909: while a removed app still answers, its
 * application lets in only the people of the Owner circle, also during the pause, so it fails closed.
 */
/** K-1124: an old address of a site card, which the redirect Worker sends on to the card's main address. */
export interface OldAddress {
  readonly cardId: string;
  readonly address: string;
}

export function desiredAccess(
  state: State,
  now: number,
  removed: ReadonlyArray<RemovedSite> = [],
  old: ReadonlyArray<OldAddress> = [],
  pages: LoginPages | null = null,
  help: HelpPages | null = null,
  /** Card ids and reserved destination hosts that can be provisioned safely. */
  linkHosts: ReadonlyMap<string, string> = new Map(),
): DesiredAccess {
  const page = (id: string | undefined) => (id === undefined ? {} : { custom_pages: [id] });
  // K-1132: a refused person goes to `/ask` once it exists, else to the help page. The admin and `/ask` itself always
  // go to the help page, because `/ask` lies under the admin host and a refusal there would send it back to `/ask`.
  const denyUrl = (direct: boolean) =>
    help === null
      ? {}
      : {
          custom_deny_url:
            help.askLive && !direct ? `https://${help.host}/ask` : `https://${help.host}/public/help/denied`,
        };
  const policies = new Map<string, PolicyBody>();
  const apps = new Map<string, AppBody>();
  for (const resource of state.resources.values()) {
    // K-2008: the relay host of a game behind NAT lets in only the service token of its relay machine; a pause
    // closes it, as it closes every device.
    const relay = resource.kind === "game" && resource.relay ? state.machines.get(resource.relay) : undefined;
    const relayAddress = resource.addresses[1];
    if (relay && relayAddress && !state.paused) {
      const key = `policy:relay:${relay.id}`;
      policies.set(key, {
        name: `kitshn relay ${relay.name}`,
        decision: "non_identity",
        include: [{ service_token: { token_id: relay.serviceTokenId } }],
        require: [],
        exclude: [],
      });
      apps.set(`app:${resource.id}:${relayAddress}`, {
        name: appName(`${resource.name} relay`),
        type: "self_hosted",
        domain: relayAddress,
        session_duration: "24h",
        same_site_cookie_attribute: "lax",
        policyKeys: [key],
      });
    }
    if (WORKER_CHECKED.has(resource.kind) || resource.addresses.length === 0) continue;
    const policyKeys: Array<string> = [];
    const shares = activeShares(state, resource, now);
    // K-1130: no Cloudflare login of a card is the bare one: closed in no circle, the chef page when only the Owner
    // circle's people open it, else the kitshn sign-in.
    const people = shares.filter((share) =>
      circlePolicies(share.circle, state.machines).has(`policy:${share.circle.id}:people`),
    );
    const chef = people.length > 0 && people.every((share) => share.circle.id === OWNER_CIRCLE_ID);
    // A card whose circles hold no people (machines only) is closed to every person.
    const loginPage = page(people.length === 0 ? pages?.closed : chef ? pages?.chef : pages?.login);
    for (const share of shares) {
      for (const [key, body] of circlePolicies(share.circle, state.machines)) {
        // K-1504: during a pause only people pass; the devices and networks policy of Owner drops out.
        if (state.paused && !key.endsWith(":people")) continue;
        policies.set(key, body);
        policyKeys.push(key);
      }
    }
    // Bypass and Service Auth policies first, as the Access dashboard orders them.
    const order = { bypass: 0, non_identity: 1, allow: 2 } as const;
    policyKeys.sort((a, b) => order[policies.get(a)!.decision] - order[policies.get(b)!.decision]);
    // K-1124: an old address keeps the card's own policies, so its redirect tells only who may open the card where
    // it went.
    const oldOfCard = old.filter((item) => item.cardId === resource.id).map((item) => item.address);
    for (const address of [...resource.addresses, ...oldOfCard]) {
      apps.set(`app:${resource.id}:${address}`, {
        name: appName(resource.name),
        type: "self_hosted",
        // K-1623: Cloudflare accepts `<host>/*` next to another application of the host and lets it answer there,
        // so kitshn takes a provider site's host over with an application at each moment.
        domain: resource.provider?.site ? `${address}/*` : address,
        // K-109
        session_duration: resource.id === ADMIN_RESOURCE_ID ? "24h" : "720h",
        same_site_cookie_attribute: "lax",
        policyKeys,
        ...loginPage,
        ...denyUrl(resource.id === ADMIN_RESOURCE_ID),
      });
    }
    const linkHost = linkHosts.get(resource.id);
    const linkDomain = linkHost ? siteLinkDomain(linkHost, resource.id) : null;
    const tokenKeys = policyKeys.filter((key) => policies.get(key)?.decision === "non_identity");
    if (
      resource.kind === "site.live" &&
      linkDomain &&
      tokenKeys.length > 0 &&
      !policyKeys.some((key) => policies.get(key)?.decision === "bypass")
    )
      apps.set(`app:${resource.id}:${linkDomain}`, {
        name: appName(`${resource.name} machine link`),
        type: "self_hosted",
        domain: linkDomain,
        session_duration: "24h",
        same_site_cookie_attribute: "lax",
        path_cookie_attribute: true,
        policyKeys: tokenKeys,
      });
  }
  const ownerKey = `policy:${OWNER_CIRCLE_ID}:people`;
  const owner = state.circles.get(OWNER_CIRCLE_ID);
  const ownerPeople = owner ? circlePolicies(owner, state.machines).get(ownerKey) : undefined;
  // Never a Bypass; without people, the application has no policy and lets no one in (K-006).
  const removedKeys = ownerPeople?.decision === "allow" ? [ownerKey] : [];
  if (ownerPeople && removed.length > 0 && removedKeys.length > 0) policies.set(ownerKey, ownerPeople);
  for (const site of removed) {
    apps.set(`app:${site.id}:${site.address}`, {
      name: appName(site.name),
      type: "self_hosted",
      domain: site.address,
      session_duration: "720h",
      same_site_cookie_attribute: "lax",
      policyKeys: removedKeys,
      // Only the Owner circle's people open a removed app while it still answers.
      ...page(pages?.chef),
    });
  }
  // K-1004: only the people of circles that can open a page or a file may log in, so a stranger cannot
  // take a Zero Trust seat (K-111). The admin opens every item (K-104), so its circles count too.
  const login: Array<string> = [];
  const passkey: Array<string> = [];
  const seen = new Set<string>();
  for (const resource of state.resources.values()) {
    if (!WORKER_CHECKED.has(resource.kind) && resource.id !== ADMIN_RESOURCE_ID) continue;
    for (const { circle } of activeShares(state, resource, now)) {
      if (seen.has(circle.id)) continue;
      seen.add(circle.id);
      const people = circlePolicies(circle, state.machines).get(`policy:${circle.id}:people`);
      // "Everyone" compiles to a Bypass: its items open without a login, and a Bypass would let in anyone.
      if (people?.decision !== "allow") continue;
      // The login applications get their own copies, so a stuck login step never holds back a policy of a
      // site (K-409). The plain login comes before the passkey step, so its copy has no passkey check.
      const { mfa_config: _, ...plain } = people;
      policies.set(`policy:${circle.id}:login`, { ...plain, name: `${people.name} (login)` });
      login.push(`policy:${circle.id}:login`);
      if (!circle.needsPasskey) continue;
      policies.set(`policy:${circle.id}:login-passkey`, {
        ...people,
        name: `${people.name} (passkey login)`,
      });
      passkey.push(`policy:${circle.id}:login-passkey`);
    }
  }
  // K-113: the people of every passkey circle may open the App Launcher, where Access enrolls a passkey.
  // An "all must match" circle is left out: its rules joined with "or" would let in more people than the
  // circle does. Revisit if such a circle needs a passkey and its people have no other way in.
  const enrolling = new Map<string, Rule>();
  for (const circle of state.circles.values()) {
    if (!circle.needsPasskey || circle.match === "all") continue;
    if (circle.endsAt !== null && circle.endsAt <= now) continue;
    // K-1504: during a pause only the Owner circle keeps its people.
    if (state.paused && circle.id !== OWNER_CIRCLE_ID) continue;
    for (const rule of present(circle.members.map(personRule))) enrolling.set(JSON.stringify(rule), rule);
  }
  if (enrolling.size > 0) {
    policies.set(ENROLLMENT_KEY, {
      name: ENROLLMENT_POLICY_NAME,
      decision: "allow",
      include: [...enrolling.values()],
      require: [],
      exclude: [],
    });
  }
  // K-1723: the people of each approver circle of a machine right reach the approve path of their kind. A circle with
  // "needs passkey" gets a policy with the passkey check of 10 minutes on `/api/approve/passkey`, whose application has
  // no other policy, so its token proves a fresh passkey; a circle without it goes on `/api/approve/login`, where the
  // Durable Object refuses a passkey circle. "All must match" is left out, as for K-113. During a pause no ask runs.
  // K-1776: an unset right asks the Owner, so the Owner is an approver while any machine is joined, also one in the tray.
  const host = state.resources.get(ADMIN_RESOURCE_ID)?.addresses[0];
  const asked = new Set([
    ...(state.machines.size > 0 ? [OWNER_CIRCLE_ID] : []),
    ...[...state.circles.values()].flatMap((circle) =>
      circle.members.flatMap((member) =>
        member._tag === "machine"
          ? Object.values(member.rights ?? {}).flatMap((mode) =>
              mode?.mode === "ask" ? [mode.circleId] : [],
            )
          : [],
      ),
    ),
  ]);
  const approvers = { passkey: [] as Array<string>, login: [] as Array<string> };
  for (const id of state.paused || !host ? [] : asked) {
    const circle = state.circles.get(id);
    if (!circle || circle.match === "all" || (circle.endsAt !== null && circle.endsAt <= now)) continue;
    const include = present(circle.members.map(personRule));
    if (include.length === 0) continue;
    const kind = circle.needsPasskey ? "passkey" : "login";
    const key = `policy:approve-${kind}:${circle.id}`;
    policies.set(key, {
      name: `${ACCESS_NAME_PREFIX}approvers ${circle.name}${circle.needsPasskey ? " (passkey)" : ""}`,
      decision: "allow",
      include,
      require: [],
      exclude: [],
      ...(circle.needsPasskey ? { mfa_config: { ...PASSKEY_MFA, session_duration: "10m" } } : {}),
    });
    approvers[kind].push(key);
  }
  for (const kind of ["passkey", "login"] as const) {
    if (!host || approvers[kind].length === 0) continue;
    apps.set(APPROVE_APPS[kind], {
      name: `${ACCESS_NAME_PREFIX}approve (${kind})`,
      type: "self_hosted",
      domain: `${host}/api/approve/${kind}`,
      session_duration: kind === "passkey" ? "10m" : "24h",
      same_site_cookie_attribute: "lax",
      path_cookie_attribute: true,
      policyKeys: approvers[kind],
      ...page(pages?.login),
    });
  }
  // K-1132, K-111: `/ask` lets in only people whom some circle lets in already, so no stranger takes a seat. It reuses
  // the people policies of the cards, without Everyone, which compiles to a Bypass.
  const askers = [...policies.entries()]
    .filter(([key, body]) => key.endsWith(":people") && body.decision === "allow")
    .map(([key]) => key);
  if (help !== null && host && askers.length > 0)
    apps.set(ASK_APP, {
      name: `${ACCESS_NAME_PREFIX}ask for access`,
      type: "self_hosted",
      domain: `${host}/ask`,
      session_duration: "24h",
      same_site_cookie_attribute: "lax",
      path_cookie_attribute: true,
      policyKeys: askers,
      ...page(pages?.login),
      ...denyUrl(true),
    });
  return { policies, apps, logins: { login, passkey }, loginPage: pages?.login ?? null };
}
