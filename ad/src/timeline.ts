import { staticFile } from "remotion";

/**
 * public/mv/<slug>/gen/timeline.json, written by mv/mv.py. Mirrors mv/blender/tl.py so a
 * cue reads the same in Remotion and Blender. Times are seconds; `energy` curves have one
 * 0..1 value per video frame.
 */
export type Span = { text: string; start: number; end: number; track: string };
export type Timeline = {
  version: 1;
  slug: string;
  fps: number;
  duration: number;
  frames: number;
  bpm: number;
  sections: { name: string; start: number; end: number }[];
  beats: number[];
  downbeats: number[];
  onsets: Record<string, number[]>;
  energy: Record<string, number[]>;
  words: Span[];
  lines: Span[];
  clips: {
    id: string;
    kind: "music" | "voice" | "sfx";
    file: string;
    start: number;
    end: number;
    gain_db: number;
  }[];
  markers: { name: string; t: number }[];
  mix: string;
};

export const loadTimeline = async (slug: string): Promise<Timeline> => {
  const res = await fetch(staticFile(`mv/${slug}/gen/timeline.json`));
  if (!res.ok) throw new Error(`No timeline for "${slug}". Run: .venv/Scripts/python mv/mv.py build ${slug}`);
  return res.json();
};

/** Index of the first event > t (so events[i - 1] is the last one at or before t). */
const upper = (events: number[], t: number) => {
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export const last = (events: number[], t: number): number | null => {
  const i = upper(events, t);
  return i ? events[i - 1] : null;
};

export const count = (events: number[], t: number) => upper(events, t);

/** 1 on each event, decaying exponentially (time constant `decay` seconds). */
export const pulse = (events: number[], t: number, decay = 0.2) => {
  const e = last(events, t);
  return e === null ? 0 : Math.exp(-(t - e) / decay);
};

export const energy = (tl: Timeline, name: string, frame: number) => {
  const e = tl.energy[name];
  return e ? e[Math.min(Math.max(frame, 0), e.length - 1)] : 0;
};

/** 0..1 position inside the current beat (0 on the beat). */
export const beatPhase = (tl: Timeline, t: number) => {
  const i = upper(tl.beats, t);
  if (i === 0 || i >= tl.beats.length) return 0;
  return (t - tl.beats[i - 1]) / (tl.beats[i] - tl.beats[i - 1]);
};

export const section = (tl: Timeline, t: number) => {
  const all = tl.sections.length ? tl.sections : [{ name: "All", start: 0, end: tl.duration }];
  const index = Math.max(
    0,
    all.findIndex((s, i) => t < s.end || i === all.length - 1),
  );
  const s = all[index];
  return {
    index,
    section: s,
    progress: Math.min(Math.max((t - s.start) / Math.max(s.end - s.start, 1e-6), 0), 1),
  };
};

export const word = (tl: Timeline, t: number, track?: string) =>
  tl.words.find((w) => (!track || w.track === track) && w.start <= t && t < w.end) ?? null;

/** When voice `track` says `w` (n-th time), ignoring case and punctuation. */
export const said = (tl: Timeline, track: string, w: string, n = 1) => {
  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  const hits = tl.words.filter((x) => x.track === track && clean(x.text) === clean(w));
  if (hits.length < n) throw new Error(`"${track}" never says "${w}" (${n})`);
  return hits[n - 1].start;
};

export const marker = (tl: Timeline, name: string) => {
  const m = tl.markers.find((x) => x.name === name);
  if (!m) throw new Error(`No marker "${name}" in timeline`);
  return m.t;
};

export const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
};
