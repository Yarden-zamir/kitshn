import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Author } from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Actor,
  type Circle,
  type Credential,
  EVERYONE_CIRCLE_ID,
  type Member,
  OWNER_CIRCLE_ID,
  type Point,
  type State,
  actorIdOf,
  machineActorId,
  shareKey,
} from "../core/model.ts";
import type { ProposalView, RevisionView } from "../core/protocol.ts";
import { AccessRow } from "./App.tsx";
import { AskRow } from "./Asks.tsx";
import { OverlayPanel, ToastView, TooltipLayer } from "./controls.tsx";
import {
  GuideHead,
  MiniMap,
  NOW,
  Stage,
  at,
  fixtureCard,
  fixtureState,
  KEY,
  machineView,
  noop,
  resource,
} from "./guide-kit.tsx";
import { HistoryView } from "./History.tsx";
import { stackOffsets } from "./layout.ts";
import { RightStickers } from "./ActorRights.tsx";
import { CircleView, StackCard, TrayCard } from "./Map.tsx";
import { PanicOpener, PausedBanner } from "./Pause.tsx";

/**
 * The concepts page at `kit.<zone>/concepts` (K-531): what each idea of kitshn is, in the words of the internal docs, with a
 * small example drawn by the real components and fixtures, and how the ideas connect. Owner only, as the map.
 */

const DOCS = "https://github.com/Yarden-zamir/kitshn/blob/main/docs/internals";

/** One concept: its words, how it relates to the others, an example, its K numbers and its docs section. */
function Concept(props: {
  name: string;
  words: ComponentChildren;
  relates: ComponentChildren;
  ks: ReadonlyArray<string>;
  section: readonly [label: string, path: string];
  children: ComponentChildren;
}) {
  return (
    <section class="guide-entry concept" id={props.name.toLowerCase().replaceAll(" ", "-")}>
      <header>
        <h3>{props.name}</h3>
        <p>{props.words}</p>
        <p class="muted">
          <b>Relates:</b> {props.relates}
        </p>
        <div class="row">
          {props.ks.map((k) => (
            <code key={k}>{k}</code>
          ))}
          <a
            class="btn"
            href={`${DOCS}/${props.section[1]}`}
            target="_blank"
            rel="noreferrer"
            data-tip={`Open the section "${props.section[0]}" of the docs on GitHub.`}
          >
            Docs: {props.section[0]} ↗
          </a>
        </div>
      </header>
      <div class="guide-sample">{props.children}</div>
    </section>
  );
}

const circle = (
  id: string,
  name: string,
  color: string,
  level: Circle["level"],
  members: ReadonlyArray<Member>,
  x: number,
  y: number,
  r: number,
): Circle => ({
  id,
  name,
  color,
  level,
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x,
  y,
  r,
});

/** A state of a few circles and cards at fixed points, so each example shows its own shares. */
/** K-1778: the actors of the examples: a friend, Yarden with a login and a phone token, a script, and a machine. */
const FRIEND = { _tag: "login", email: "friend@example.com" } as const;
const YARDEN = { _tag: "login", email: "yarden@example.com" } as const;
const PHONE = { _tag: "token", tokenId: "phone", clientId: "phone.access", name: "Yarden's phone" } as const;
const BACKUP = {
  _tag: "token",
  tokenId: "backup",
  clientId: "backup.access",
  name: "nightly backup",
} as const;
const CONCEPT_ACTORS: ReadonlyArray<Actor> = [
  { id: actorIdOf(FRIEND), name: "friend@example.com", credentials: [FRIEND] },
  { id: actorIdOf(YARDEN), name: "Yarden", credentials: [YARDEN, PHONE] },
  { id: actorIdOf(BACKUP), name: "nightly backup", credentials: [BACKUP] },
  { id: machineActorId("vps"), name: "VPS", credentials: [{ _tag: "machine", machineId: "vps" }] },
];
const chip = (credential: Credential): Member => ({ _tag: "actor", actorId: actorIdOf(credential) });

function scene(
  base: State,
  circles: ReadonlyArray<Circle>,
  places: ReadonlyArray<readonly [string, Point]>,
  extra: Partial<State> = {},
): State {
  return {
    ...base,
    actors: new Map([...base.actors, ...CONCEPT_ACTORS.map((actor) => [actor.id, actor] as const)]),
    circles: new Map(circles.map((each) => [each.id, each])),
    places: new Map(places),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    ...extra,
  };
}

/** One circle drawn with its fixed state. */
const ring = (state: State, each: Circle) => (
  <CircleView
    key={each.id}
    circle={each}
    state={state}
    selected={false}
    preview={false}
    flash={false}
    headAngle={0}
    zoomedOut={false}
    hidden={new Set()}
    onMenu={noop}
  />
);

/** A numbered marker on the overview diagram, at a point of the map. */
const marker = (n: number, point: Point) => (
  <span key={n} class="sticker wait concept-marker" style={{ left: `${point.x}px`, top: `${point.y}px` }}>
    {n}
  </span>
);

function Overview(props: { base: State }) {
  const friends = circle("friends", "Friends", "#FF5277", "view", [chip(FRIEND), chip(YARDEN)], -150, 0, 210);
  const everyone = circle("everyone-o", "Everyone", "#7CFF8A", "view", [{ _tag: "everyone" }], 190, 20, 190);
  const tick3d = resource("tick3d", "site.static", "tick3d", "tick3d.example.com");
  const notes = resource("notes", "page", "notes", null);
  const slides = resource("slides", "file", "slides.pdf", null);
  const state = scene(
    { ...props.base, resources: new Map([tick3d, notes, slides].map((each) => [each.id, each])) },
    [friends, everyone],
    [
      ["tick3d", at(20, 10)],
      ["notes", at(-230, 40)],
      ["slides", at(520, 60)],
    ],
  );
  return (
    <section class="guide-entry concept-overview">
      <header>
        <h3>How they connect</h3>
        <p>
          Circles on the map say who. A card inside a circle is shared with that circle, at the circle's
          level. The same map holds every app, site, page, file and machine.
        </p>
      </header>
      <div class="guide-sample">
        <MiniMap width={1000} height={520} center={at(120, 10)}>
          {ring(state, friends)}
          {ring(state, everyone)}
          {fixtureCard(state, tick3d, at(20, 10))}
          {fixtureCard(state, notes, at(-230, 40))}
          {fixtureCard(state, slides, at(520, 60))}
          {marker(1, at(-250, -10))}
          {marker(2, at(-40, -250))}
          {marker(3, at(-360, -215))}
          {marker(4, at(110, -40))}
          {marker(5, at(620, 10))}
        </MiniMap>
        <ol class="concept-legend">
          <li>
            <b>Share.</b> A card inside a circle is shared with that circle: notes is shared with Friends.
          </li>
          <li>
            <b>Level.</b> The head names the circle and its default level, here view; each share gets it, or
            an override of one card.
          </li>
          <li>
            <b>Members.</b> The chips on the edge say who is in the circle: people, domains, networks,
            devices, machines, or everyone.
          </li>
          <li>
            <b>Overlap.</b> tick3d sits in Friends and Everyone, so it has two shares; a visitor gets the
            highest level of the shares that match.
          </li>
          <li>
            <b>Private.</b> slides.pdf sits in no circle, so only the admin sees it. New cards start like
            this, in the tray.
          </li>
        </ol>
      </div>
    </section>
  );
}

function Things(props: { base: State }) {
  const { base } = props;
  const kinds: ReadonlyArray<readonly [string, Point]> = [
    ["tick3d", at(-230, 0)],
    ["riffle", at(0, 0)],
    ["ci-times", at(230, 0)],
    ["slides", at(-230, 130)],
    ["mac", at(0, 130)],
    ["kitshn-repo", at(230, 130)],
  ];
  const kindState = scene(base, [], kinds);
  const team = circle(
    "team",
    "Team",
    "#00B3FF",
    "use",
    [
      { _tag: "domain", domain: "example.com" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ],
    0,
    0,
    200,
  );
  const mac = base.resources.get("mac") ?? resource("mac", "machine", "Mac", null);
  const tick3d = base.resources.get("tick3d") ?? resource("tick3d", "site.static", "tick3d", null);
  const shareState = scene(
    base,
    [team],
    [
      ["mac", at(-10, -70)],
      ["tick3d", at(-10, 95)],
    ],
    { shareSettings: new Map([[shareKey("mac", "team"), { level: "control", endsAt: null }]]) },
  );
  const people = circle(
    "people",
    "Members",
    "#6C5CE7",
    "view",
    [chip(FRIEND), { _tag: "domain", domain: "qlik.com" }, { _tag: "ip", range: "10.0.0.0/8" }, chip(BACKUP)],
    -260,
    0,
    170,
  );
  const machines = circle(
    "machines",
    "Machines",
    "#14B8A6",
    "use",
    [chip({ _tag: "machine", machineId: "vps" })],
    260,
    0,
    170,
  );
  const memberState = scene(base, [people, machines], []);
  const owner = base.circles.get(OWNER_CIRCLE_ID);
  const everyone = base.circles.get(EVERYONE_CIRCLE_ID);
  const admin = base.resources.get(ADMIN_RESOURCE_ID);
  const builtIn =
    owner && everyone
      ? [
          { ...owner, x: -200, y: 0, r: 170 },
          { ...everyone, x: 200, y: 0, r: 170 },
        ]
      : [];
  const builtInState = scene(base, builtIn, [
    [ADMIN_RESOURCE_ID, at(-200, 20)],
    ["tick3d", at(200, 20)],
  ]);
  return (
    <>
      <Concept
        name="Card"
        words={
          <>
            A card is a resource on the map. A resource is something that kitshn can share: a machine, a site,
            a page, a file, an app, a thread. Each resource kind names its levels.
          </>
        }
        relates="A card is shared with every circle it sits in. Deploys, uploads and providers make cards; a new card waits in the tray. Each environment of an app is its own card."
        ks={["K-301", "K-303", "K-304", "K-524"]}
        section={["Resources", "circles-and-resources.md#resources"]}
      >
        <MiniMap width={700} height={300} center={at(0, 75)}>
          {kinds.flatMap(([id, point]) => {
            const item = base.resources.get(id);
            if (!item) return [];
            return [
              fixtureCard(kindState, item, point, id === "mac" ? { machine: machineView(true, null) } : {}),
            ];
          })}
        </MiniMap>
        <p class="help">A static site, a Compose app, a page, a file, a machine and a repo.</p>
      </Concept>
      <Concept
        name="Circle"
        words="A circle is a named group of who: people (emails), email domains, devices, networks (IP ranges), machines, and the flag “needs passkey”. A circle has a default level."
        relates="Members go in circles; cards inside a circle are its shares. Circles overlap freely. “Any” lets in a visitor who matches one member; “all must match” needs every member."
        ks={["K-201", "K-202", "K-203", "K-211"]}
        section={["Circles and shares", "circles-and-resources.md#circles-and-shares"]}
      >
        <MiniMap width={480} height={480} center={at(0, 0)}>
          {ring(shareState, team)}
          {fixtureCard(shareState, tick3d, at(-10, 95))}
        </MiniMap>
      </Concept>
      <Concept
        name="Share and level"
        words="A share is a card inside a circle. It gives the members of the circle the circle's default level on that resource, or the level of an override. A level is what a share allows; each kind names its own ordered levels, for example view, use, control."
        relates="A visitor in several matching circles gets the highest level. A level that a kind does not have steps down to its highest lower one. A card in no circle is private. A share can end at a date."
        ks={["K-204", "K-205", "K-206", "K-207", "K-208", "K-209"]}
        section={["Circles and shares", "circles-and-resources.md#circles-and-shares"]}
      >
        <MiniMap width={480} height={480} center={at(0, 0)}>
          {ring(shareState, team)}
          {fixtureCard(shareState, mac, at(-10, -70), { machine: machineView(true, KEY) })}
          {fixtureCard(shareState, tick3d, at(-10, 95))}
        </MiniMap>
        <p class="help">
          Team gives use. Mac has its own level in Team (the chip “Team: control”); tick3d, a site, has only
          view.
        </p>
      </Concept>
      <Concept
        name="Members"
        words="Who a circle holds: people (emails), email domains, networks (IP ranges), devices (an Access service token each), machines, and “everyone”, which means anyone who can reach the address, with no login."
        relates="A machine is a member too, so a share can give one machine access to another resource. An agent on a machine acts as its machine; an agent key is a device member that the owner makes as an exception."
        ks={["K-106", "K-107", "K-202", "K-718", "K-1731", "K-1732"]}
        section={["Identity and login", "access.md#identity-and-login"]}
      >
        <MiniMap width={1060} height={430} center={at(-40, -10)}>
          {ring(memberState, people)}
          {ring(memberState, machines)}
        </MiniMap>
      </Concept>
      <Concept
        name="Owner and Everyone"
        words="Two circles exist from the start. The Owner circle holds the person who installed kitshn and the admin card, with “needs passkey” on. The Everyone circle holds “everyone”: its cards are public."
        relates="The admin card always keeps a share to a circle with a person and “needs passkey”; kitshn refuses any change that breaks that. The first time that a card enters any circle with “everyone”, kitshn asks first: “This makes <name> public.”"
        ks={["K-104", "K-105", "K-210", "K-211"]}
        section={["Identity and login", "access.md#identity-and-login"]}
      >
        <MiniMap width={860} height={400} center={at(0, 10)}>
          {builtIn.map((each) => ring(builtInState, each))}
          {admin ? fixtureCard(builtInState, admin, at(-200, 20)) : null}
          {fixtureCard(builtInState, tick3d, at(200, 20))}
        </MiniMap>
      </Concept>
    </>
  );
}

function Arrangement(props: { base: State }) {
  const { base } = props;
  const members = ["riffle", "riffle-pr-41", "riffle-pr-42"].flatMap((id) => base.resources.get(id) ?? []);
  const offsets = stackOffsets(
    members.map(() => undefined),
    124,
    16,
  );
  return (
    <>
      <Concept
        name="Stack"
        words="Cards that sit on one point, so they move as one and get the same circles. The owner stacks cards; the environments of one app, the pages of one thread and the files of one upload stack by themselves."
        relates="A stack keeps its cards' shares together; pulling a card out lands it next to the stack in the same circles, so no share changes."
        ks={["K-508", "K-521", "K-522"]}
        section={["Map", "map.md#rules"]}
      >
        <MiniMap width={560} height={420} center={at(0, 160)}>
          <StackCard
            id="concept-stack"
            layer={null}
            name="Sites"
            members={members}
            state={base}
            at={at(-150, 0)}
            selected={false}
            dragging={false}
            target={false}
            flash={false}
            onMenu={noop}
          />
          {members.map((member, index) =>
            fixtureCard(base, member, at(150, offsets[index] ?? 0), {
              count: index === 0 ? members.length : null,
              open: true,
            }),
          )}
        </MiniMap>
        <p class="help">Closed, and open as a column.</p>
      </Concept>
      <Concept
        name="Tray"
        words="New cards arrive in a tray at the edge of the map, outside every circle, so they start private."
        relates="A drag from the tray places a card in exactly the circles at the drop point, so it gets those shares. Cards that a recipe places skip the tray."
        ks={["K-509", "K-208"]}
        section={["Map", "map.md#rules"]}
      >
        <div class="tray guide-tray">
          <div class="tray-list">
            <TrayCard
              resource={resource("slides", "file", "slides.pdf", null)}
              state={props.base}
              selected={false}
              dragging={false}
              access={null}
              progress={null}
              machine={null}
              zone="example.com"
              onMenu={noop}
            />
            <TrayCard
              resource={resource("notes", "page", "CI time table", null)}
              state={props.base}
              selected={false}
              dragging={false}
              access={null}
              progress={null}
              machine={null}
              zone="example.com"
              onMenu={noop}
            />
          </div>
        </div>
      </Concept>
    </>
  );
}

function Delivery(props: { base: State }) {
  const { base } = props;
  const riffle = base.resources.get("riffle");
  const preview = base.resources.get("riffle-pr-41");
  const framed = resource("framed", "site.static", "example", "example.com");
  return (
    <>
      <Concept
        name="Recipe and deploy"
        words="A recipe is kitshn.config.ts in an app repo. An environment is one deployed copy of an app, for example prod or pr-12. A push to the repo deploys; kitshn reads the recipe and never runs repo code."
        relates="Each environment is its own card. The recipe names the circle that a new environment starts in; after that, the map decides. The first deploy of a new repo waits for one click."
        ks={["K-801", "K-803", "K-807", "K-819"]}
        section={["Recipes", "deploys.md#recipes"]}
      >
        <pre>
          {`export default defineApp({
  compose: { runsOn: ["docker"] },
  deploy: [
    { on: "push", branch: "main", name: "prod", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true, startsIn: "Owner" },
  ],
});`}
        </pre>
        <MiniMap width={480} height={130} center={at(0, 20)}>
          {riffle ? fixtureCard(base, riffle, at(-115, 0)) : null}
          {preview ? fixtureCard(base, preview, at(115, 0), { pullRequest: 41 }) : null}
        </MiniMap>
        <p class="help">The prod environment, and the preview of pull request 41.</p>
      </Concept>
      <Concept
        name="Preview"
        words="Two things share the name. A pull request preview is an environment pr-<n> with its own address, which goes when the pull request closes. A live preview is a small frame of a site, a page or a file (of a type that a browser shows) on its card."
        relates="A pull request preview is a card like any other, with a “PR #n” sticker. A live preview shows only what the browser may open: a frame cannot log in, so a site behind Access shows only when the browser already has its Access session."
        ks={["K-901", "K-904", "K-303", "K-520"]}
        section={["Previews", "deploys.md#previews"]}
      >
        <MiniMap width={480} height={330} center={at(0, 110)}>
          {preview ? fixtureCard(base, preview, at(-115, 0), { pullRequest: 41 }) : null}
          {fixtureCard(base, framed, at(115, 0), { preview: true })}
        </MiniMap>
      </Concept>
      <Concept
        name="Access and its states"
        words="kitshn compiles shares into Cloudflare Access wherever Access can check them. The map shows a change at once; each card shows “applying” until Cloudflare has it, and “failed” with the reason if Cloudflare refuses it."
        relates="Each circle becomes Access policies, and each card with an address an Access application. A lower level takes effect at once. A daily compare repairs what drifted."
        ks={["K-401", "K-402", "K-407", "K-408", "K-409"]}
        section={["Enforcement", "access.md#enforcement"]}
      >
        <div class="guide-rows">
          <AccessRow access={{ state: "applied" }} />
          <AccessRow access={{ state: "applying" }} />
          <AccessRow access={{ state: "retrying", error: "Cloudflare answered 504.", at: NOW + 60_000 }} />
          <AccessRow access={{ state: "failed", error: "Cloudflare refused the policy." }} />
          <AccessRow
            access={{ state: "failed", error: "Access not lowered yet: Cloudflare answered 504." }}
          />
        </div>
      </Concept>
    </>
  );
}

function Safety(props: { base: State }) {
  const me: Author = { _tag: "person", email: "viewer@example.com" };
  const owner: Author = { _tag: "person", email: "owner@example.com" };
  const revisions: ReadonlyArray<RevisionView> = [
    {
      id: 3,
      at: NOW - 60_000,
      actor: owner,
      summary: "tick3d: + Everyone · view",
      undoes: null,
      undoSource: null,
      undoneBy: null,
      undoable: true,
      kind: "share",
      items: [{ kind: "card", id: "tick3d" }],
    },
    {
      id: 2,
      at: NOW - 3_600_000,
      actor: owner,
      summary: "Created circle Friends",
      undoes: null,
      undoSource: null,
      undoneBy: null,
      undoable: true,
      kind: "circle",
      items: [{ kind: "circle", id: "friends" }],
    },
  ];
  const pause = { mode: "keep-public" as const, by: "owner@example.com", at: NOW - 600_000 };
  const reach = { closes: 12, cards: 5, keptPublic: 3 };
  return (
    <>
      <Concept
        name="History and Undo"
        words="Every change makes one revision with the time, the actor and a summary. Undo makes a new revision that reverses a revision, and its toast offers Undo again."
        relates="History is the audit trail of shares, circles, stacks and apps. Undo runs the same rules as an edit, also the admin guard and the pause."
        ks={["K-1501", "K-1502", "K-1505", "K-1507", "K-1508"]}
        section={["History and Undo", "history-and-pause.md#history-and-undo"]}
      >
        <Stage height={440}>
          <OverlayPanel heading="History" large={false} onResize={noop} onClose={noop}>
            <HistoryView revisions={revisions} me={me} state={props.base} onUndo={noop} onShow={noop} />
          </OverlayPanel>
        </Stage>
        <Stage height={70}>
          <ToastView
            text="Shared tick3d with Everyone · view"
            error={false}
            besidePanel={false}
            place={{ top: 12 }}
            onUndo={noop}
            action={null}
            onClose={noop}
          />
        </Stage>
      </Concept>
      <Concept
        name="The pause"
        words="The big red button: one press closes every share except the owner's admin, and stops agent keys and new deploys. Public sites stay up, unless the pause is a lockdown. Resume needs a passkey."
        relates="During the pause kitshn refuses every change that raises access; lowering access still works. Undo and agents follow the same rule."
        ks={["K-1504"]}
        section={["History and Undo", "history-and-pause.md#history-and-undo"]}
      >
        <div class="row">
          <PanicOpener pause={null} open={false} onOpen={noop} />
          <PanicOpener pause={pause} open={false} onOpen={noop} />
        </div>
        <Stage height={380}>
          <PausedBanner pause={pause} reach={reach} besidePanel={false} onLockdown={noop} onResume={noop} />
        </Stage>
      </Concept>
    </>
  );
}

function Agents(props: { base: State }) {
  const vps: Extract<Member, { _tag: "actor" }> = {
    _tag: "actor",
    actorId: machineActorId("vps"),
    rights: { changes: { mode: "automatic" }, shares: { mode: "ask", circleId: OWNER_CIRCLE_ID } },
  };
  const proposal: ProposalView = {
    id: "p-1",
    machineId: "vps",
    credential: "machine/vps",
    machineName: "VPS",
    action: "publish",
    target: "tick3d",
    body: null,
    reason: "Release 2.4",
    labels: { agent: "claude", repo: "tick3d" },
    verified: ["repo"],
    right: "shares",
    circleId: OWNER_CIRCLE_ID,
    shown: "publish tick3d",
    shownHash: "0",
    state: "pending",
    createdAt: NOW - 120_000,
    expiresAt: NOW + 86_000_000,
  };
  return (
    <Concept
      name="Effects, modes and asks"
      words="An actor is a name that can act: a person, a script, a machine, or an agent on a machine. Each operation has one effect: reads, maintains, creates, changes, runs, destroys, shares or secrets. Each effect of an actor in a circle has a mode: default, off, automatic, or ask a circle. An ask waits for one member of that circle to approve or deny it."
      relates="Circles decide where an actor acts; effects decide what kind of action, the same for every actor. Effects sit on actor chips. A machine proves itself with its own key pair; an agent actor is the calls of a machine with given attested labels. Asks wait in the Inbox; History records each one."
      ks={["K-1701", "K-1720", "K-1721", "K-1722", "K-1730", "K-1778"]}
      section={["Machine identity and agent rights", "agent-rights.md"]}
    >
      <div class="row">
        <span class="muted">VPS in an agent circle:</span>
        <RightStickers member={vps} />
      </div>
      <ul class="repo-list">
        <AskRow
          proposal={proposal}
          circleName={(id) => props.base.circles.get(id)?.name ?? id}
          busy={false}
          onApprove={noop}
          onDeny={noop}
        />
      </ul>
    </Concept>
  );
}

export function Concepts() {
  const [base] = useState(fixtureState);
  return (
    <main class="guide">
      <GuideHead page="concepts">
        The ideas of kitshn in the words of the docs, each with a small example drawn by the map's own
        components and fixtures. Nothing here reads or changes the live state.
      </GuideHead>
      <Overview base={base} />
      <h2 class="label">What kitshn shares, and with whom</h2>
      <Things base={base} />
      <h2 class="label">On the map</h2>
      <Arrangement base={base} />
      <h2 class="label">How cards get there and who can open them</h2>
      <Delivery base={base} />
      <h2 class="label">Safety</h2>
      <Safety base={base} />
      <h2 class="label">Agents</h2>
      <Agents base={base} />
      <TooltipLayer />
    </main>
  );
}
