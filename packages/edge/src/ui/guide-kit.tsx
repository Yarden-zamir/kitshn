import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { demo, DEMO_MACHINES } from "../core/demo.ts";
import type { MachineKey } from "../core/machine.ts";
import type { Point, Resource, State } from "../core/model.ts";
import type { MachineView } from "../core/protocol.ts";
import { seed } from "../core/seed.ts";
import { HEAD_LAYER } from "./layout.ts";
import { CardView } from "./Map.tsx";

/** What the two guide pages (`/neo-brutalism`, `/concepts`) share: fixtures, the scheme switch and their frames. */

export const NOW = Date.now();
export const noop = () => undefined;
export const at = (x: number, y: number): Point => ({ x, y });

/** The fixtures: the seed of a fresh kitshn and the local demo, as the Worker's demo mode makes them. */
export function fixtureState(): State {
  const initial = seed(["owner@example.com"], "kit.example.com");
  const extra = demo();
  return {
    circles: new Map([...initial.circles, ...extra.circles].map((circle) => [circle.id, circle])),
    resources: new Map([...initial.resources, ...extra.resources].map((resource) => [resource.id, resource])),
    places: new Map([...initial.places, ...extra.places]),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(DEMO_MACHINES.map(({ machine }) => [machine.id, machine])),
    actors: new Map([...initial.actors, ...extra.actors].map((actor) => [actor.id, actor])),
  };
}

export const resource = (
  id: string,
  kind: Resource["kind"],
  name: string,
  address: string | null,
): Resource => ({
  id,
  kind,
  name,
  addresses: address ? [address] : [],
  status: "running",
  group: null,
  machine: null,
});

export const machineView = (online: boolean, key: MachineKey | null): MachineView => {
  const first = DEMO_MACHINES[0];
  if (!first) throw new Error("The demo has no machine.");
  return {
    machine: key ? { ...first.machine, key } : first.machine,
    online,
    lastSeen: online ? NOW : NOW - 3_600_000,
    status: null,
    facts: [],
    sample: null,
    os: first.os,
    keyFailure: null,
    orphanVolumes: [],
    health: null,
    servers: [],
    queued: 0,
    update: null,
  };
};
export const KEY: MachineKey = { kind: "public", publicKey: "demo", fingerprint: "SHA256:demo", since: NOW };

/** The tokens of the page's own stylesheet: the light `:root` block and its dark override. */
export function rootTokens() {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const collect = (style: CSSStyleDeclaration, into: Map<string, string>) => {
    for (let index = 0; index < style.length; index++) {
      const name = style.item(index);
      into.set(name, style.getPropertyValue(name).trim());
    }
  };
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // The font stylesheet of another origin.
    }
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && rule.selectorText === ":root") collect(rule.style, light);
      if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-color-scheme: dark"))
        for (const inner of rule.cssRules)
          if (inner instanceof CSSStyleRule && inner.selectorText === ":root") collect(inner.style, dark);
    }
  }
  return { light, dark };
}

type Scheme = "system" | "light" | "dark";

/** Sets the tokens of one scheme on the page itself, so both show without a change of the system setting. */
function applyScheme(scheme: Scheme) {
  const { light, dark } = rootTokens();
  const root = document.documentElement.style;
  // Only the names that the dark block changes differ between the two schemes.
  for (const name of dark.keys()) {
    const value = scheme === "dark" ? dark.get(name) : scheme === "light" ? light.get(name) : undefined;
    if (value === undefined) root.removeProperty(name);
    else root.setProperty(name, value);
  }
}

function useScheme(): [Scheme, (scheme: Scheme) => void] {
  const [scheme, setScheme] = useState<Scheme>("system");
  return [
    scheme,
    (next) => {
      applyScheme(next);
      setScheme(next);
    },
  ];
}

/** One entry: what it is, what it is for, and where it lives. */
export function Entry(props: { heading: string; what: string; source: string; children: ComponentChildren }) {
  return (
    <section class="guide-entry">
      <header>
        <h3>{props.heading}</h3>
        <p>{props.what}</p>
        <code>{props.source}</code>
      </header>
      <div class="guide-sample">{props.children}</div>
    </section>
  );
}

/** A small map: a `.world` at a fixed view, so map components draw where they do on the map. */
export function MiniMap(props: {
  width: number;
  height: number;
  center: Point;
  children: ComponentChildren;
}) {
  return (
    <div class="guide-map" style={{ width: `${props.width}px`, height: `${props.height}px` }}>
      <div
        class="world"
        style={{
          transform: `translate(${props.width / 2 - props.center.x}px, ${props.height / 2 - props.center.y}px)`,
          "--head-layer": HEAD_LAYER,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

/** A box that keeps fixed surfaces (dialogs, panels, toasts, the banner) inside it: a transform makes it their frame. */
export function Stage(props: { height: number; children: ComponentChildren }) {
  return (
    <div class="guide-stage" style={{ height: `${props.height}px` }}>
      {props.children}
    </div>
  );
}

/** The two guide pages, for the link between them. */
const PAGES = [
  {
    path: "/neo-brutalism",
    name: "neo-brutalism",
    tip: "The primitives: every component of the map with its states.",
  },
  {
    path: "/concepts",
    name: "concepts",
    tip: "The ideas: what cards, circles, shares and the rest are, and how they connect.",
  },
] as const;

/** The head of a guide page: its title and intro, the link to the other page, and the light/dark switch. */
export function GuideHead(props: { page: (typeof PAGES)[number]["name"]; children: ComponentChildren }) {
  const [scheme, setScheme] = useScheme();
  const other = PAGES.find((page) => page.name !== props.page);
  return (
    <header class="guide-head">
      <div>
        <h1>{props.page}</h1>
        <p class="muted">{props.children}</p>
      </div>
      <div class="row">
        {other ? (
          <a class="btn" href={other.path} data-tip={other.tip}>
            {other.name} →
          </a>
        ) : null}
        <div class="seg" role="group" aria-label="Colour scheme">
          {(["system", "light", "dark"] as const).map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={scheme === each}
              data-tip={each === "system" ? "Follow the system setting." : `Show the ${each} scheme.`}
              onClick={() => setScheme(each)}
            >
              {each}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

/** A card of the map with fixtures: a plain, unselected card unless `extra` says otherwise. */
export function fixtureCard(
  state: State,
  item: Resource,
  point: Point,
  extra: Partial<Parameters<typeof CardView>[0]> = {},
) {
  return (
    <CardView
      key={`${item.id}-${point.x}-${point.y}`}
      resource={item}
      layer={null}
      state={state}
      at={point}
      selected={false}
      dragging={false}
      target={false}
      flash={false}
      count={null}
      open={false}
      access={null}
      progress={null}
      downSince={null}
      machine={null}
      pullRequest={null}
      preview={false}
      peek={false}
      zone="example.invalid"
      now={Date.now()}
      onMenu={noop}
      onClose={noop}
      {...extra}
    />
  );
}
