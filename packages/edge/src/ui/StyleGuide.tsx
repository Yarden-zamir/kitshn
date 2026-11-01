import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Circle, type Point, type Resource, type State, actorIdOf } from "../core/model.ts";
import type { Notification } from "../core/notifications.ts";
import type { AccessState, ProposalView } from "../core/protocol.ts";
import { AccessRow } from "./App.tsx";
import {
  Entry,
  GuideHead,
  KEY,
  MiniMap,
  NOW,
  Stage,
  at,
  fixtureCard,
  fixtureState,
  machineView,
  noop,
  resource,
  rootTokens,
} from "./guide-kit.tsx";
import { AskRow } from "./Asks.tsx";
import {
  Check,
  Menu,
  MenuItem,
  MenuSep,
  MoreButton,
  OverlayPanel,
  Radio,
  Switch,
  ToastView,
  TooltipLayer,
} from "./controls.tsx";
import { IconTile } from "./ItemIcon.tsx";
import { KINDS, LEVEL_COLORS, LEVEL_TILTS } from "./kinds.ts";
import { stackOffsets } from "./layout.ts";
import { KeySticker, PresenceSticker } from "./Machines.tsx";
import { CardView, CircleView, StackCard, TrayCard } from "./Map.tsx";
import { NotificationRow } from "./Notifications.tsx";
import { PanicOpener, PausedBanner, SafetyView } from "./Pause.tsx";
import type { Rect } from "./popover.ts";

/**
 * The living style guide at `kit.<zone>/neo-brutalism`: every primitive of the map, drawn by its real component or
 * its shared class, with fixtures and never the live state. Owner only, as the map: the same Access application
 * guards the host.
 */

/** The computed font size of a sample, so the type scale says what it draws. */
function Measured(props: { children: ComponentChildren }) {
  const box = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState("");
  useEffect(() => {
    const first = box.current?.firstElementChild;
    if (first) setSize(getComputedStyle(first).fontSize);
  }, []);
  return (
    <span class="guide-measured" ref={box}>
      {props.children}
      <code>{size}</code>
    </span>
  );
}

function Tokens() {
  const [tokens] = useState(rootTokens);
  const colours = [...tokens.light].filter(([, value]) => value.startsWith("#"));
  const others = [...tokens.light].filter(([name, value]) => name.startsWith("--") && !value.startsWith("#"));
  return (
    <>
      <Entry
        heading="Colour tokens"
        what="Every colour of the map. Components use the tokens, never a literal colour, so dark mode changes tokens only."
        source=":root and @media (prefers-color-scheme: dark) · styles.css"
      >
        <div class="guide-swatches">
          {colours.map(([name, light]) => {
            const dark = tokens.dark.get(name) ?? light;
            return (
              <div key={name} class="guide-swatch">
                <span class="chip-pair">
                  <span style={{ background: light }} data-tip={`Light: ${light}`} />
                  <span style={{ background: dark }} data-tip={`Dark: ${dark}`} />
                </span>
                <code>{name}</code>
                <span class="muted">
                  {light}
                  {dark === light ? " (both)" : ` · ${dark}`}
                </span>
              </div>
            );
          })}
        </div>
      </Entry>
      <Entry
        heading="Size, radius, border, shadow and fonts"
        what="The other tokens: the 2px ink border, the 0.25rem radius, the hard 4px card shadow, and the two fonts."
        source=":root · styles.css"
      >
        <dl class="guide-values">
          {others.map(([name, value]) => (
            <div key={name}>
              <dt>
                <code>{name}</code>
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div class="row">
          <span
            class="guide-shadow"
            style={{ boxShadow: "var(--shadow)" }}
            data-tip="var(--shadow): cards, dialogs, panels."
          >
            card 4px
          </span>
          <span
            class="guide-shadow"
            style={{ boxShadow: "3px 3px 0 0 var(--shadow-ink)" }}
            data-tip="3px: controls, menus, tooltips."
          >
            control 3px
          </span>
          <span
            class="guide-shadow"
            style={{ boxShadow: "2px 2px 0 0 var(--shadow-ink)" }}
            data-tip="2px: stickers, checkboxes."
          >
            sticker 2px
          </span>
        </div>
      </Entry>
      <Entry
        heading="Type scale"
        what="An 18px base on html, body text at 1rem, headings at weight 800, section labels in caps, ids in the mono font."
        source="html, body, h1–h3, .label, .help, .muted, code · styles.css"
      >
        <div class="guide-type">
          <Measured>
            <h1>Heading 1</h1>
          </Measured>
          <Measured>
            <h2>Heading 2</h2>
          </Measured>
          <Measured>
            <h3>Heading 3</h3>
          </Measured>
          <Measured>
            <span>Body text</span>
          </Measured>
          <Measured>
            <span class="label">Section label</span>
          </Measured>
          <Measured>
            <span class="help">Help text under a control</span>
          </Measured>
          <Measured>
            <span class="muted">Muted text</span>
          </Measured>
          <Measured>
            <code>code-and-ids-01</code>
          </Measured>
        </div>
      </Entry>
    </>
  );
}

function Controls() {
  const [segment, setSegment] = useState("view");
  const [checked, setChecked] = useState(true);
  const [on, setOn] = useState(true);
  const [radio, setRadio] = useState("a");
  const [menu, setMenu] = useState<Rect | null>(null);
  return (
    <>
      <Entry
        heading="Buttons"
        what="Every action. A press lifts the button on hover and pushes it into its shadow on click."
        source=".btn, .btn.primary, .btn.danger, .btn.resume, .btn.toggle, .btn.add · styles.css"
      >
        <div class="row">
          <button
            class="btn"
            data-tip="A plain button: hover lifts it, a press moves it 3px into its shadow."
          >
            Plain
          </button>
          <button class="btn primary" data-tip="The main action of a view.">
            Primary
          </button>
          <button class="btn danger" data-tip="An action that removes something; its label says what goes.">
            Danger
          </button>
          <button class="btn resume" data-tip="Resume after a pause (K-1504).">
            Resume
          </button>
          <button class="btn toggle" aria-pressed="true" data-tip="A toggle that is on.">
            Toggle on
          </button>
          <button class="btn toggle" aria-pressed="false" data-tip="A toggle that is off.">
            Toggle off
          </button>
          <button class="btn primary add" aria-label="Add" data-tip="The one + of the toolbar (K-526).">
            +
          </button>
          <button class="btn" disabled data-tip="A disabled button: no hover, no press.">
            Disabled
          </button>
        </div>
        <p class="help">
          Hover and press any of them to see the lift and the press. kitshn has no send button.
        </p>
      </Entry>
      <Entry
        heading="Segmented control and tabs"
        what="One choice of a few, and the tabs of the toolbar. The chosen part is filled with the selection colour."
        source=".seg, .seg.small with aria-pressed · styles.css"
      >
        <div class="row">
          <div class="seg">
            {["view", "use", "control"].map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={segment === level}
                data-tip={`Choose ${level}.`}
                onClick={() => setSegment(level)}
              >
                {level}
              </button>
            ))}
          </div>
          <div class="seg small">
            {["Map", "Machines", "Library", "History"].map((tab, index) => (
              <button key={tab} type="button" aria-pressed={index === 0} data-tip={`The ${tab} tab.`}>
                {tab}
              </button>
            ))}
          </div>
        </div>
      </Entry>
      <Entry
        heading="Checkbox, radio and switch"
        what="On or off, one of a group, and a setting that takes effect at once. The native input keeps the keyboard; the look is kitshn's."
        source="Check, Radio, Switch · controls.tsx"
      >
        <div class="row">
          <Check label="Checked" tip="A checkbox that is on." checked={checked} onChange={setChecked} />
          <Check
            label="Disabled"
            tip="A checkbox that is off and disabled."
            checked={false}
            disabled
            onChange={noop}
          />
          <Radio
            label="One"
            tip="The first radio of a group."
            name="guide"
            checked={radio === "a"}
            onSelect={() => setRadio("a")}
          />
          <Radio
            label="Two"
            tip="The second radio of a group."
            name="guide"
            checked={radio === "b"}
            onSelect={() => setRadio("b")}
          />
          <Switch
            label="Switch"
            tip="A switch that changes a setting at once."
            checked={on}
            onChange={setOn}
          />
          <Switch
            label="Disabled"
            tip="A switch that is off and disabled."
            checked={false}
            disabled
            onChange={noop}
          />
        </div>
      </Entry>
      <Entry
        heading="Text field"
        what="Text input, and a field whose value kitshn refuses. kitshn has no select list (K-517): a choice of many is a menu or a segmented control."
        source=".field, .field[aria-invalid] · styles.css"
      >
        <div class="row">
          <input
            class="field"
            type="text"
            placeholder="name@example.com"
            aria-label="A text field"
            data-tip="A text field."
          />
          <input
            class="field"
            type="search"
            placeholder="Filter"
            aria-label="A search field"
            data-tip="A search field; Escape clears it."
          />
          <input
            class="field"
            type="text"
            value="not-an-email"
            aria-invalid="true"
            aria-label="A field with a refused value"
            data-tip="A field whose value kitshn refuses: the error colours."
          />
          <input class="field" type="text" value="Disabled" disabled aria-label="A disabled field" />
        </div>
      </Entry>
      <Entry
        heading="Menu"
        what="The context menu of cards, stacks, circles and the map, and every dropdown. Items with a key hint, a danger item, a separator."
        source="Menu, MenuItem, MenuSep, MoreButton · controls.tsx"
      >
        <div class="row">
          <button
            class="btn"
            aria-haspopup="menu"
            data-tip="Open a real menu here."
            onClick={(event) => setMenu(event.currentTarget.getBoundingClientRect())}
          >
            Open the menu
          </button>
          <MoreButton name="this sample" onOpen={setMenu} />
        </div>
        {menu ? (
          <Menu label="Sample menu" anchor={menu} onClose={() => setMenu(null)}>
            <MenuItem tip="An item." onSelect={noop}>
              Show details
            </MenuItem>
            <MenuItem tip="An item with a key hint." keys="⌘K" onSelect={noop}>
              Find
            </MenuItem>
            <MenuItem tip="An item that opens a sub-list." opens keepOpen onSelect={noop}>
              Share with
            </MenuItem>
            <MenuItem tip="A refused item: its reason is the tooltip." disabled onSelect={noop}>
              Unstack
            </MenuItem>
            <MenuSep />
            <MenuItem tip="A dangerous item: it runs at once and shows Undo." danger onSelect={noop}>
              Remove app
            </MenuItem>
          </Menu>
        ) : null}
      </Entry>
      <Entry
        heading="Keyboard focus"
        what="An accent ring and a pink glow, so focus is easy to find on the dots canvas. Components with their own hard shadow (card, checkbox, radio, switch) keep that shadow and show only the ring, on purpose."
        source=":focus-visible · styles.css"
      >
        <div class="row">
          <button class="btn" data-tip="Tab to me: the ring and the glow.">
            Tab to me
          </button>
          <Check
            label="Tab to me"
            tip="Tab to me: the ring only, with the box's own shadow."
            checked={false}
            onChange={noop}
          />
        </div>
      </Entry>
      <Entry
        heading="Tooltip"
        what="Every control says what it is and what happens: after 300 ms on hover, at once on keyboard focus."
        source="TooltipLayer with data-tip · controls.tsx"
      >
        <button class="btn" data-tip="This is a tooltip: one short sentence.">
          Hover or focus me
        </button>
      </Entry>
    </>
  );
}

function Surfaces() {
  return (
    <>
      <Entry
        heading="Dialog with scrim"
        what="A question or a form over the page. The scrim dims the page with a flat layer, no blur."
        source=".scrim, .dialog · styles.css"
      >
        <Stage height={340}>
          <div class="scrim">
            <section class="dialog" role="dialog" aria-label="Sample dialog">
              <h2>Make tick3d public?</h2>
              <p>Anyone with the address can open it.</p>
              <div class="row">
                <button class="btn" data-tip="Cancel: nothing changes.">
                  Cancel
                </button>
                <button class="btn primary" data-tip="Continue with the change.">
                  Continue
                </button>
              </div>
            </section>
          </div>
        </Stage>
      </Entry>
      <Entry
        heading="Overlay panel"
        what="The side panel over the map: card details, a circle, the map. Enlarge opens its full view."
        source="OverlayPanel · controls.tsx"
      >
        <Stage height={260}>
          <OverlayPanel heading="Card" large={false} onResize={noop} onClose={noop}>
            <div class="label">Static sites</div>
            <h2>tick3d</h2>
            <p class="help">The panel scrolls inside itself.</p>
          </OverlayPanel>
        </Stage>
      </Entry>
      <Entry
        heading="Toast"
        what="What a change did, with Undo for 10 seconds. It shows in the half of the map away from the changed card."
        source="ToastView · controls.tsx; toastPlace · layout.ts"
      >
        <Stage height={170}>
          <ToastView
            text="Shared tick3d with Everyone · view"
            error={false}
            besidePanel={false}
            place={{ top: 12 }}
            onUndo={noop}
            action={null}
            onClose={noop}
          />
          <ToastView
            text="Cloudflare refused the change."
            error
            besidePanel={false}
            place={{ bottom: 12 }}
            onUndo={null}
            action={null}
            onClose={noop}
          />
        </Stage>
        <p class="help">
          Top: a change with Undo, placed at the top. Bottom: an error, placed at the bottom.
        </p>
      </Entry>
    </>
  );
}

function MapParts(props: { state: State }) {
  const { state } = props;
  const site =
    state.resources.get("tick3d") ?? resource("tick3d", "site.static", "tick3d", "tick3d.example.com");
  const framed = resource("framed", "site.static", "example", "example.com");
  const card = (item: Resource, point: Point, extra: Partial<Parameters<typeof CardView>[0]> = {}) =>
    fixtureCard(state, item, point, extra);
  const ring: Circle = {
    id: "guide-ring",
    name: "Friends",
    color: "#FF5277",
    level: "view",
    members: [{ _tag: "actor", actorId: actorIdOf({ _tag: "login", email: "her@example.com" }) }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 0,
    y: 0,
    r: 170,
  };
  const members = ["riffle", "riffle-pr-41", "riffle-pr-42"].flatMap((id) => state.resources.get(id) ?? []);
  const offsets = stackOffsets(
    members.map(() => undefined),
    124,
    16,
  );
  const access = (item: AccessState) => card(site, at(0, 0), { access: item });
  return (
    <>
      <Entry
        heading="Card"
        what="One item on the map: its icon, name, address, kind sticker, circles and actions. Selected cards fill with the selection colour."
        source="CardView · Map.tsx"
      >
        <MiniMap width={520} height={130} center={at(0, 20)}>
          {card(site, at(-120, 0))}
          {card(site, at(120, 0), { selected: true })}
        </MiniMap>
        <p class="help">Plain, and selected.</p>
        <MiniMap width={520} height={400} center={at(0, 150)}>
          {card(framed, at(-120, 0), { selected: true, peek: true })}
          {card(framed, at(120, 0), { selected: true, peek: true, previewOpen: true })}
        </MiniMap>
        <p class="help">
          A selected card that has a preview: the ▾ at the end of its kind sticker, closed and open
          (example.com).
        </p>
      </Entry>
      <Entry
        heading="Card with a preview frame"
        what="A live view of a site: a thumbnail of the top of its page. Still while it loads; Open when it never loads."
        source="CardView, CardPreview, LiveFrame · Map.tsx, Peek.tsx"
      >
        <MiniMap width={700} height={330} center={at(0, 110)}>
          {card(framed, at(-230, 0), { preview: true, previewStill: "loading" })}
          {card(framed, at(0, 0), { preview: true })}
          {card(framed, at(230, 0), { preview: true, previewStill: "failed" })}
        </MiniMap>
        <p class="help">Loading, loaded (example.com), and not available.</p>
      </Entry>
      <Entry
        heading="Circle with head"
        what="Who may open the cards inside it. The head names it and its level; member chips sit on its edge."
        source="CircleView · Map.tsx"
      >
        <MiniMap width={520} height={400} center={at(0, 10)}>
          <CircleView
            circle={ring}
            state={{ ...state, circles: new Map([[ring.id, ring]]) }}
            selected={false}
            preview={false}
            flash={false}
            headAngle={0}
            zoomedOut={false}
            hidden={new Set()}
            onMenu={noop}
          />
          {card(site, at(0, 30))}
        </MiniMap>
      </Entry>
      <Entry
        heading="Stack, closed and open"
        what="Cards that the owner keeps together. Closed it lists its cards; open it is a column, and its count closes it."
        source="StackCard, CardView · Map.tsx; stackOffsets · layout.ts"
      >
        <MiniMap width={560} height={420} center={at(0, 160)}>
          <StackCard
            id="guide-stack"
            layer={null}
            name="Sites"
            members={members}
            state={state}
            at={at(-150, 0)}
            selected={false}
            dragging={false}
            target={false}
            flash={false}
            onMenu={noop}
          />
          {members.map((member, index) =>
            card(member, at(150, offsets[index] ?? 0), {
              count: index === 0 ? members.length : null,
              open: true,
            }),
          )}
        </MiniMap>
      </Entry>
      <Entry
        heading="Tray item"
        what="A new card, private until the owner drags it onto the map."
        source="TrayCard, CardView · Map.tsx"
      >
        <div class="tray guide-tray">
          <div class="tray-list">
            <TrayCard
              resource={resource("slides", "file", "slides.pdf", null)}
              state={state}
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
              state={state}
              selected
              dragging={false}
              access={null}
              progress={null}
              machine={null}
              zone="example.com"
              onMenu={noop}
            />
          </div>
        </div>
      </Entry>
      <Entry
        heading="Access states"
        what="Whether Cloudflare holds the latest shares of a card: on the card as a sticker, in its panel as a row."
        source="AccessRow · App.tsx; CardView · Map.tsx"
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
        <div class="guide-cards">
          {(
            [
              { state: "applying" },
              { state: "retrying", error: "Cloudflare answered 504.", at: NOW + 60_000 },
              { state: "failed", error: "Cloudflare refused the policy." },
            ] as const
          ).map((item) => (
            <MiniMap key={item.state} width={230} height={140} center={at(0, 10)}>
              {access(item)}
            </MiniMap>
          ))}
        </div>
      </Entry>
    </>
  );
}

function Stickers() {
  const tones = [
    ["", "Other states: pink."],
    ["ok", "Working or done: green."],
    ["wait", "Waiting: yellow."],
    ["info", "More states: blue."],
    ["agent", "An agent key."],
    ["right", "A right of a device or machine."],
    ["cut", "Closed by the pause."],
    ["paused-sticker", "The paused state."],
  ] as const;
  return (
    <>
      <Entry
        heading="Stickers"
        what="Status, levels and tags as small tilted stickers with black text; neighbours lean different ways."
        source=".sticker and its tones · styles.css; KINDS, LEVEL_COLORS · kinds.ts"
      >
        <div class="row">
          {tones.map(([tone, tip], index) => (
            <span
              key={tone || "default"}
              class={`sticker${tone ? ` ${tone}` : ""}`}
              style={{ "--tilt": `${[-3, 2, -1.5, 3, -2, 1, -4, 4][index]}deg` }}
              data-tip={tip}
            >
              {tone || "default"}
            </span>
          ))}
        </div>
        <div class="row">
          {Object.entries(KINDS).map(([kind, value]) => (
            <span
              key={kind}
              class="sticker"
              data-tip={value.help}
              style={{ "--tilt": value.tilt, background: value.color, color: value.ink }}
            >
              {kind}
            </span>
          ))}
        </div>
        <div class="row">
          {Object.entries(LEVEL_COLORS).map(([level, colour]) => (
            <span
              key={level}
              class="sticker"
              data-tip={`The level ${level}.`}
              style={{ "--tilt": LEVEL_TILTS[level as keyof typeof LEVEL_TILTS], background: colour }}
            >
              {level}
            </span>
          ))}
        </div>
      </Entry>
      <Entry
        heading="Stamp"
        what="A settled item: an outline ✓ in the stamp colour, such as Access applied."
        source=".stamp · styles.css"
      >
        <span class="stamp" data-tip="Applied: Cloudflare holds the latest shares.">
          ✓ applied
        </span>
      </Entry>
      <Entry
        heading="Badges"
        what="A count on a toolbar button: open notifications, repos that wait for their first deploy."
        source=".btn with a .sticker · App.tsx"
      >
        <div class="row">
          <button class="btn" aria-label="Notifications, 3 open" data-tip="Notifications: 3 open.">
            🔔<span class="sticker">3</span>
          </button>
          <button class="btn" data-tip="Repos that wait for you to allow their first deploy.">
            <span class="sticker wait">1 repo waiting</span>
          </button>
        </div>
      </Entry>
      <Entry
        heading="Machine stickers and icon tiles"
        what="Whether a machine is online and has a key; the icon tile in front of every card name."
        source="PresenceSticker, KeySticker · Machines.tsx; IconTile · ItemIcon.tsx"
      >
        <div class="row">
          <PresenceSticker view={machineView(true, KEY)} />
          <PresenceSticker view={machineView(false, KEY)} />
          <KeySticker view={machineView(true, null)} />
          <KeySticker view={machineView(true, { kind: "waiting", since: NOW })} />
          <IconTile image={null} glyph="📦" tip="The icon of the kind, when the item has none." />
        </div>
      </Entry>
    </>
  );
}

function Safety() {
  const reach = { closes: 12, cards: 5, keptPublic: 3 };
  const pause = { mode: "keep-public" as const, by: "owner@example.com", at: NOW - 600_000 };
  return (
    <>
      <Entry
        heading="Big red button"
        what="The emergency pause: the toolbar opener, and the button under its lid in the Safety panel."
        source="PanicOpener, SafetyView · Pause.tsx"
      >
        <div class="row">
          <PanicOpener pause={null} open={false} onOpen={noop} />
          <PanicOpener pause={pause} open={false} onOpen={noop} />
        </div>
        <div class="guide-box">
          <SafetyView reach={() => reach} pause={null} onPress={noop} onLockdown={noop} />
        </div>
      </Entry>
      <Entry
        heading="Pause banner"
        what="While paused, the banner says what is closed, with Lockdown and Resume."
        source="PausedBanner · Pause.tsx"
      >
        <Stage height={380}>
          <PausedBanner pause={pause} reach={reach} besidePanel={false} onLockdown={noop} onResume={noop} />
        </Stage>
      </Entry>
    </>
  );
}

function Lists(props: { state: State }) {
  const notification: Notification = {
    id: 1,
    source: "deploy",
    key: "deploy:tick3d",
    episode: "d-1",
    card: "tick3d",
    recipients: { _tag: "owner" },
    level: "error",
    priority: "normal",
    title: "tick3d did not deploy",
    text: "The build failed in step 3. The card still serves its last good deploy.",
    actions: [{ id: "logs", label: "Logs", kind: "link", path: "#map/tick3d" }],
    state: "open",
    openedAt: NOW - 3_600_000,
    closedAt: null,
    snoozedUntil: null,
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
    right: "publishes",
    circleId: "owner",
    shown: "publish tick3d",
    shownHash: "0",
    state: "pending",
    createdAt: NOW - 120_000,
    expiresAt: NOW + 86_000_000,
  };
  return (
    <>
      <Entry
        heading="Notification row"
        what="What kitshn told the owner, with its state, source and card, its actions, Snooze, Dismiss and Mute."
        source="NotificationRow · Notifications.tsx"
      >
        <NotificationRow
          notification={notification}
          card="tick3d"
          shown
          now={NOW}
          onPost={noop}
          onMute={noop}
        />
        <NotificationRow
          notification={{
            ...notification,
            id: 2,
            level: "info",
            state: "closed",
            closedAt: NOW,
            title: "tick3d is up again",
          }}
          card="tick3d"
          shown={false}
          now={NOW}
          onPost={noop}
          onMute={noop}
        />
      </Entry>
      <Entry
        heading="Inbox ask row"
        what="An agent's ask that waits for one member of the approver circle: Approve or Deny."
        source="AskRow · Asks.tsx"
      >
        <ul class="repo-list">
          <AskRow
            proposal={proposal}
            circleName={(id) => props.state.circles.get(id)?.name ?? id}
            busy={false}
            onApprove={noop}
            onDeny={noop}
          />
        </ul>
      </Entry>
    </>
  );
}

/**
 * Where kitshn and the neo-brutalism skill still differ, after the decisions of 2026-10-29. Kept on purpose: kitshn
 * stays as it is. The skill follows kitshn: the skill changes to match.
 */
const DIFFERENCES: ReadonlyArray<{ readonly what: string; readonly decision: "kept" | "skill" }> = [
  {
    what: "Tokens: the skill has --code-bg, --warning-fg, --warning-surface, --info-fg and --info-surface; kitshn adds them only when a state needs them.",
    decision: "kept",
  },
  { what: "Send button: the skill defines .btn.send; kitshn has no send button.", decision: "kept" },
  {
    what: "Select: the skill styles .select; kitshn has no select list at all (its native-UI test forbids the select element, K-517), so it has no .select rule.",
    decision: "kept",
  },
  { what: "Stickers: kitshn sets 0.72rem; the skill sets 0.65rem.", decision: "skill" },
  {
    what: "Buttons: kitshn uses 0.9rem text, 3px 10px padding and a 3px shadow on hover; the skill uses 1rem, 4px 10px and the 4px card shadow.",
    decision: "skill",
  },
  {
    what: "Tabs: kitshn marks the chosen tab with aria-pressed; the skill names aria-pressed or aria-selected, and either is fine.",
    decision: "skill",
  },
  {
    what: "Components that kitshn has and the skill does not define (toast, card, circle with head, stack, tray, badge, Access row, big red button, pause banner, notification row): the skill gets a section that points to them and to this page.",
    decision: "skill",
  },
];

export function StyleGuide() {
  const [state] = useState(fixtureState);
  return (
    <main class="guide">
      <GuideHead page="neo-brutalism">
        The primitives of the kitshn map, drawn by their real components with fixtures. Nothing here reads or
        changes the live state.
      </GuideHead>
      <h2 class="label">Tokens</h2>
      <Tokens />
      <h2 class="label">Controls</h2>
      <Controls />
      <h2 class="label">Stickers and badges</h2>
      <Stickers />
      <h2 class="label">Surfaces</h2>
      <Surfaces />
      <h2 class="label">Map</h2>
      <MapParts state={state} />
      <h2 class="label">Safety</h2>
      <Safety />
      <h2 class="label">Lists</h2>
      <Lists state={state} />
      <section class="guide-entry guide-differences">
        <header>
          <h3>Differences with the neo-brutalism skill</h3>
          <p>The differences that are left. The skill follows kitshn on stickers, buttons and tabs.</p>
        </header>
        <ol>
          {DIFFERENCES.map((difference) => (
            <li key={difference.what}>
              <span
                class={`sticker${difference.decision === "kept" ? " ok" : " wait"}`}
                data-tip={
                  difference.decision === "kept"
                    ? "Kept on purpose: kitshn stays as it is."
                    : "The skill follows kitshn: the skill changes to match."
                }
              >
                {difference.decision === "kept" ? "kept" : "skill follows"}
              </span>{" "}
              {difference.what}
            </li>
          ))}
        </ol>
      </section>
      <TooltipLayer />
    </main>
  );
}
