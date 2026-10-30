import type { Level, Member, Resource, ResourceKind } from "../core/model.ts";

export interface KindInfo {
  readonly label: string;
  /** What a card of this kind is (K-301), for its tooltip. */
  readonly help: string;
  readonly icon: string;
  readonly color: string;
  readonly ink?: string;
  readonly tilt: string;
}

/** K-302: the sticker of a card's kind; a provider kind gets one look, with the name that its provider gives it. */
export const kindInfo = (resource: Pick<Resource, "kind" | "provider">): KindInfo =>
  resource.provider
    ? {
        label: resource.provider.kindName,
        help: `A ${resource.provider.kindName} of the provider ${resource.provider.name} on its machine (K-704).`,
        icon: "🧩",
        color: "var(--info)",
        tilt: "1.5deg",
      }
    : (KINDS[resource.kind as ResourceKind] ?? {
        label: resource.kind,
        help: `A card of the kind ${resource.kind}.`,
        icon: "❔",
        color: "var(--info)",
        tilt: "0deg",
      });

/**
 * Sticker colours follow tick3d: black text on the light sticker colours, white text on the accent.
 * `ink` is the text colour, so each pair passes WCAG AA.
 */
export const KINDS: Record<ResourceKind, KindInfo> = {
  "kitshn.admin": {
    label: "Admin",
    help: "kitshn administration: whoever opens it changes kitshn.",
    icon: "🔐",
    color: "var(--accent)",
    ink: "var(--accent-fg)",
    tilt: "-2deg",
  },
  machine: {
    label: "Machines",
    help: "A machine with a daemon.",
    icon: "🖥",
    color: "var(--info)",
    tilt: "-3deg",
  },
  "site.static": {
    label: "Static sites",
    help: "A static site on Workers static assets.",
    icon: "🌐",
    color: "var(--green)",
    tilt: "2deg",
  },
  "site.worker": {
    label: "Worker apps",
    help: "A Worker app.",
    icon: "⚙️",
    color: "var(--green)",
    tilt: "1deg",
  },
  "site.compose": {
    label: "Compose apps",
    help: "A Compose app on a machine.",
    icon: "📦",
    color: "var(--green)",
    tilt: "-1deg",
  },
  "site.live": {
    label: "Live sites",
    help: "A local site of a machine, through its tunnel.",
    icon: "📡",
    color: "var(--warning)",
    tilt: "3deg",
  },
  page: {
    label: "Pages",
    help: "An HTML page in the library.",
    icon: "📄",
    color: "var(--yellow)",
    tilt: "-1.5deg",
  },
  file: { label: "Files", help: "A file in R2.", icon: "🗂", color: "var(--warning)", tilt: "-2deg" },
  repo: {
    label: "Repos",
    help: "A repo that has a recipe; its environments are its children.",
    icon: "📚",
    color: "var(--pink)",
    tilt: "2.5deg",
  },
  port: {
    label: "Ports",
    help: "A port card on a machine. A person in its circles opens the ports for their address on its connect page.",
    icon: "🎮",
    color: "var(--green)",
    tilt: "2deg",
  },
  "repo.group": {
    label: "Repo groups",
    help: "The repos of an owner, or of a name pattern with one *. A right on it covers each repo that it matches.",
    icon: "🗃️",
    color: "var(--pink)",
    tilt: "-2.5deg",
  },
};

export const MEMBER_ICONS: Record<Member["_tag"], string> = {
  email: "👤",
  domain: "@",
  ip: "🛜",
  device: "📱",
  machine: "🖥",
  everyone: "🌍",
};

export const LEVEL_TILTS: Record<Level, string> = { view: "2deg", use: "-2deg", control: "3deg" };

/** Levels use light sticker colours with black text, in both modes, not the circle colour. */
export const LEVEL_COLORS: Record<Level, string> = {
  view: "var(--info)",
  use: "var(--warning)",
  control: "var(--pink)",
};

/**
 * Six clearly different hues; each stays visible as a ring on the light and on the dark canvas. No yellow:
 * it is the selection colour in light mode.
 */
export const CIRCLE_COLORS = ["#6C5CE7", "#FF5277", "#00B3FF", "#FFB347", "#7CFF8A", "#14B8A6"];

/**
 * K-537: the line of a level in the relationship lens. Lines stay ink, because the level colours are also circle
 * colours; the weight says how much, and a dash marks a look-only share.
 */
export const LEVEL_LINES: Record<Level, { readonly width: number; readonly dash: string | null }> = {
  view: { width: 2, dash: "7 5" },
  use: { width: 4, dash: null },
  control: { width: 7, dash: null },
};
