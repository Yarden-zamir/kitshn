import { loadFont as loadBricolage } from "@remotion/google-fonts/BricolageGrotesque";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const SLUG = "explainer";

/** The kitshn flat look (packages/edge/src/ui/styles.css, dark tokens). */
export const C = {
  canvas: "#161618",
  dots: "#f4f4ef14",
  surface: "#232327",
  raised: "#2c2c31",
  ink: "#f4f4ef",
  muted: "#a3a3aa",
  border: "#f4f4ef1a",
  yellow: "#ffd23f",
  graphite: "#19191b",
  green: "#6ee7a0",
  pink: "#ff9fb2",
  info: "#5cc8ff",
  red: "#ff5c7a",
};

export const SANS = loadBricolage("normal", {
  weights: ["400", "600", "800"],
  subsets: ["latin"],
}).fontFamily;
export const MONO = loadMono("normal", { weights: ["400", "600"], subsets: ["latin"] }).fontFamily;

/**
 * Where things sit on the plates, in CSS px of the 1920×1080 captures (public/shots/ad-boxes-dark.json, written by
 * packages/edge/scripts/captures/ad.ts). Re-capture and these follow the new layout.
 */
export const BOX = {
  // ad-map: panel closed, the whole demo map.
  cards: [
    { x: 796, y: 395, w: 151, h: 71 },
    { x: 657, y: 212, w: 151, h: 169 },
    { x: 891, y: 212, w: 151, h: 169 },
    { x: 994, y: 458, w: 151, h: 71 },
    { x: 1398, y: 395, w: 151, h: 71 },
    { x: 1398, y: 521, w: 151, h: 71 },
  ],
  heads: [
    { x: 778, y: 90, w: 186, h: 26 },
    { x: 1389, y: 170, w: 167, h: 26 },
    { x: 1207, y: 496, w: 120, h: 26 },
    { x: 562, y: 613, w: 143, h: 26 },
    { x: 1392, y: 692, w: 163, h: 26 },
  ],
  email: { x: 800, y: 128, w: 146, h: 22 },
  domain: { x: 549, y: 650, w: 82, h: 22 },
  everyone: { x: 1434, y: 207, w: 82, h: 22 },
  // ad-select / ad-drag / ad-drop: the panel is open and the map sits left of it.
  tray: { x: 240, y: 893, w: 123, h: 58 },
  grab: { x: 300, y: 913 },
  drop: { x: 1003, y: 718 },
  her: { x: 810, y: 513, w: 311, h: 311 },
  label: { x: 1021, y: 736, w: 95, h: 24 },
  toast: { x: 507, y: 108, w: 415, h: 46 },
  undo: { x: 795, y: 115, w: 68, h: 32 },
  who: { x: 1456, y: 150, w: 436, h: 225 },
  // ad-riffle: the riffle stack, open, with a preview per pull request.
  previews: [
    { x: 821, y: 568, w: 120, h: 62 },
    { x: 821, y: 648, w: 120, h: 62 },
  ],
  machines: { x: 1456, y: 195, w: 436, h: 442 },
};
