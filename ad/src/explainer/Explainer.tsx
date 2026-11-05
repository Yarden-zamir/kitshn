import type React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { said as saidIn, type Timeline } from "../timeline";
import { BOX, C, MONO, SANS, SLUG } from "./config";

export type ExplainerProps = { timeline?: Timeline };

/*
 * "What kitshn does", one minute. Audio first: public/mv/explainer/spec.json is the script, and every cue below
 * hangs off a spoken word (`said`), so a new reading retimes the picture. Product UI is never drawn: it is the real
 * map in the captures of public/shots/, with a cursor, rings and the dragged card laid over them.
 */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const ramp = (t: number, a: number, b: number) => ease(clamp((t - a) / (b - a)));
/** 0 before `a`, 1 from `a` to `b`, 0 after `b`, with `f` seconds of fade each side. */
const win = (t: number, a: number, b: number, f = 0.3) => clamp((t - a) / f) * clamp((b - t) / f);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type Cam = { t: number; d: number; x: number; y: number; z: number };
/** Each key is where the camera arrives at `t`, after travelling `d` seconds. */
const camAt = (t: number, keys: Cam[]) => {
  let at = keys[0];
  for (const k of keys.slice(1)) {
    if (t >= k.t) at = k;
    else {
      const p = ramp(t, k.t - k.d, k.t);
      return { x: lerp(at.x, k.x, p), y: lerp(at.y, k.y, p), z: lerp(at.z, k.z, p) };
    }
  }
  return at;
};

const dots: React.CSSProperties = {
  backgroundColor: C.canvas,
  backgroundImage: `radial-gradient(${C.dots} 1.6px, transparent 1.6px)`,
  backgroundSize: "28px 28px",
};

export const Explainer: React.FC<ExplainerProps> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!timeline) return null;
  const tl = timeline;
  const t = frame / fps;
  const said = (track: string, word: string, n = 1) => saidIn(tl, track, word, n);
  const first = (track: string) => tl.words.find((w) => w.track === track)!.start;
  const pop = (at: number, damping = 11) =>
    spring({ frame: frame - at * fps, fps, config: { damping, stiffness: 190 } });

  const T = {
    intro: first("intro"),
    kitchen: said("intro", "kitchen"),
    push: said("intro", "push"),
    share: said("intro", "share"),
    circleWord: said("intro", "circle"),
    deploy: first("deploy"),
    cloudflare: said("deploy", "cloudflare"),
    machinesWord: said("deploy", "machines"),
    live: said("deploy", "live"),
    pull: said("deploy", "pull"),
    preview: said("deploy", "preview"),
    map: first("map"),
    card: said("map", "card"),
    circle: said("map", "circle"),
    email: said("map", "email"),
    domain: said("map", "domain"),
    everyone: said("map", "everyone"),
    drag: said("map", "drag"),
    see: said("map", "see"),
    drop: said("map", "drop"),
    undo: said("map", "undo"),
    access: first("access"),
    cfAccess: said("access", "cloudflare"),
    only: said("access", "only"),
    machines: first("machines"),
    tunnel: said("machines", "tunnel"),
    ports: said("machines", "ports"),
    off: said("machines", "off"),
    friendly: said("machines", "friendly"),
    end: first("end"),
    endPush: said("end", "push"),
    endShare: said("end", "share"),
  };
  const dragFrom = T.drag + 0.35;
  const dragTo = T.see - 0.05;

  return (
    <AbsoluteFill style={{ ...dots, fontFamily: SANS, color: C.ink }}>
      {t < T.intro + 0.3 ? <Hook t={t} pop={pop} said={said} out={T.intro} /> : null}
      {t > T.intro - 0.3 && t < T.deploy + 0.3 ? <Intro t={t} pop={pop} T={T} /> : null}
      {t > T.deploy - 0.3 && t < T.pull + 0.3 ? <Deploy t={t} pop={pop} T={T} /> : null}
      {t > T.pull - 0.3 && t < T.tunnel + 0.3 ? (
        <Screens t={t} T={T} dragFrom={dragFrom} dragTo={dragTo} />
      ) : null}
      {t > T.tunnel - 0.3 && t < T.friendly + 0.3 ? <Tunnel t={t} pop={pop} T={T} /> : null}
      {t > T.friendly - 0.3 && t < T.end + 0.3 ? <Offline t={t} T={T} /> : null}
      {t > T.end - 0.3 ? <End t={t} pop={pop} T={T} /> : null}
      {t > T.deploy && t < T.end ? <Caption t={t} tl={tl} /> : null}

      <Audio src={staticFile(`mv/${SLUG}/gen/mix.wav`)} volume={0.8} />
      <Sfx id="pop" at={said("hook", "site")} />
      <Sfx id="pop" at={said("hook", "bot")} />
      <Sfx id="pop" at={said("hook", "app")} />
      <Sfx id="logo" at={T.kitchen - 0.15} vol={0.55} />
      <Sfx id="whoosh" at={T.deploy - 0.3} />
      <Sfx id="keys" at={T.deploy + 0.1} vol={0.35} />
      <Sfx id="pop" at={T.live} />
      <Sfx id="whoosh" at={T.pull - 0.3} />
      <Sfx id="whoosh" at={T.map - 0.3} />
      <Sfx id="whoosh" at={T.email - 0.35} vol={0.3} />
      <Sfx id="whoosh" at={T.domain - 0.35} vol={0.3} />
      <Sfx id="whoosh" at={T.everyone - 0.35} vol={0.3} />
      <Sfx id="click" at={dragFrom} />
      <Sfx id="pop" at={T.drop} />
      <Sfx id="whoosh" at={T.undo - 0.35} vol={0.3} />
      <Sfx id="whoosh" at={T.access - 0.3} vol={0.3} />
      <Sfx id="pop" at={T.only + 0.2} vol={0.35} />
      <Sfx id="whoosh" at={T.tunnel - 0.3} />
      <Sfx id="pop" at={T.ports} />
      <Sfx id="whoosh" at={T.friendly - 0.3} />
      <Sfx id="logo" at={T.end - 0.1} vol={0.6} />
    </AbsoluteFill>
  );
};

const Sfx: React.FC<{ id: string; at: number; vol?: number }> = ({ id, at, vol = 0.35 }) => {
  const { fps } = useVideoConfig();
  return (
    <Sequence from={Math.max(0, Math.round(at * fps))} layout="none">
      <Audio src={staticFile(`mv/${SLUG}/gen/sfx.${id}.mp3`)} volume={vol} />
    </Sequence>
  );
};

type Pop = (at: number, damping?: number) => number;
type Times = Record<string, number>;

/** A small flat card in the map's style: icon, name, address, kind sticker. */
const MiniCard: React.FC<{
  icon: string;
  name: string;
  sub: string;
  kind: string;
  tone?: string;
  style?: React.CSSProperties;
}> = ({ icon, name, sub, kind, tone = C.green, style }) => (
  <div
    style={{
      width: 300,
      padding: "18px 22px",
      background: C.surface,
      borderRadius: 26,
      boxShadow: "0 18px 40px -20px #000c",
      ...style,
    }}
  >
    <div style={{ fontSize: 34, fontWeight: 800, display: "flex", gap: 12, alignItems: "center" }}>
      <span>{icon}</span>
      {name}
    </div>
    <div style={{ fontFamily: MONO, fontSize: 20, color: C.muted, marginTop: 4 }}>{sub}</div>
    <Sticker tone={tone} style={{ marginTop: 16 }}>
      {kind}
    </Sticker>
  </div>
);

const Sticker: React.FC<{
  tone?: string;
  tilt?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ tone = C.yellow, tilt = -3, style, children }) => (
  <span
    style={{
      display: "inline-block",
      padding: "2px 14px",
      borderRadius: 999,
      background: tone,
      color: C.graphite,
      fontWeight: 700,
      fontSize: 22,
      transform: `rotate(${tilt}deg)`,
      ...style,
    }}
  >
    {children}
  </span>
);

/** 0–7 s: you built something; who gets to open it? */
const Hook: React.FC<{
  t: number;
  pop: Pop;
  said: (track: string, word: string, n?: number) => number;
  out: number;
}> = ({ t, pop, said, out }) => {
  const head = ["You", "built", "something."];
  const question = ["Now:", "who", "gets", "to", "open", "it?"];
  const now = said("hook", "now");
  const cards = [
    { at: said("hook", "site"), icon: "🗺️", name: "trip-plan", sub: "trip.you.dev", kind: "static" },
    { at: said("hook", "bot"), icon: "🤖", name: "standup-bot", sub: "bot.you.dev", kind: "compose" },
    { at: said("hook", "app"), icon: "🧩", name: "tiny-api", sub: "api.you.dev", kind: "worker" },
  ];
  const asked = ramp(t, now, now + 0.5);
  return (
    <AbsoluteFill style={{ opacity: win(t, -1, out, 0.3), alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          position: "absolute",
          top: 210,
          display: "flex",
          gap: 26,
          fontSize: 112,
          fontWeight: 800,
          letterSpacing: "-0.03em",
        }}
      >
        {(asked < 0.5 ? head : question).map((word, i) => {
          const at = said("hook", word.replace(/\W/g, ""));
          const k = pop(at);
          return (
            <span
              key={`${asked < 0.5}-${i}`}
              style={{
                display: "inline-block",
                opacity: clamp(k * 2),
                transform: `translateY(${(1 - k) * 40}px) scale(${0.7 + 0.3 * k})`,
              }}
            >
              {word}
            </span>
          );
        })}
      </div>
      <div style={{ position: "absolute", top: 520, display: "flex", gap: 60 }}>
        {cards.map((card, i) => {
          const k = pop(card.at, 9);
          const wobble = asked * Math.sin(t * 5 + i * 2) * 4;
          return (
            <div
              key={card.name}
              style={{
                position: "relative",
                transform: `translateY(${(1 - k) * 160}px) scale(${k}) rotate(${(i - 1) * 3 + wobble}deg)`,
                opacity: clamp(k * 3),
              }}
            >
              <MiniCard {...card} />
              <div
                style={{
                  position: "absolute",
                  right: -18,
                  top: -22,
                  opacity: asked,
                  transform: `scale(${pop(now + 0.25 + i * 0.12, 8)})`,
                }}
              >
                <Sticker tilt={8 - i * 6} style={{ fontSize: 40, padding: "0 18px" }}>
                  ?
                </Sticker>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** The logo and the promise; a yellow ring draws itself around "circle". */
const Intro: React.FC<{ t: number; pop: Pop; T: Times }> = ({ t, pop, T }) => {
  const logo = pop(T.intro, 9);
  const name = pop(T.kitchen);
  const ring = ramp(t, T.circleWord, T.circleWord + 0.55);
  return (
    <AbsoluteFill
      style={{
        opacity: win(t, T.intro - 0.3, T.deploy, 0.3),
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 36, transform: `translateY(-90px)` }}>
        <Img
          src={staticFile("logo.svg")}
          style={{ width: 190, height: 190, transform: `scale(${logo}) rotate(${(1 - logo) * -25}deg)` }}
        />
        <div
          style={{
            fontSize: 170,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            opacity: clamp(name * 2),
            transform: `translateX(${(1 - name) * -40}px)`,
          }}
        >
          kitshn
        </div>
      </div>
      <div
        style={{ position: "absolute", top: 640, display: "flex", gap: 22, fontSize: 64, fontWeight: 600 }}
      >
        <span
          style={{ opacity: clamp(pop(T.push) * 2), transform: `translateY(${(1 - pop(T.push)) * 30}px)` }}
        >
          Push a repo.
        </span>
        <span
          style={{
            position: "relative",
            opacity: clamp(pop(T.share) * 2),
            transform: `translateY(${(1 - pop(T.share)) * 30}px)`,
          }}
        >
          Share it with a{" "}
          <span style={{ position: "relative" }}>
            circle.
            <svg
              width="260"
              height="130"
              viewBox="0 0 260 130"
              style={{ position: "absolute", left: -12, top: -30, overflow: "visible" }}
            >
              <ellipse
                cx="128"
                cy="64"
                rx="118"
                ry="52"
                fill="none"
                stroke={C.yellow}
                strokeWidth="7"
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray="1"
                strokeDashoffset={1 - ring}
                transform="rotate(-6 128 64)"
              />
            </svg>
          </span>
        </span>
      </div>
    </AbsoluteFill>
  );
};

/** git push → Cloudflare and your machines → live. */
const Deploy: React.FC<{ t: number; pop: Pop; T: Times }> = ({ t, pop, T }) => {
  const command = "git push origin main";
  const typed = command.slice(0, Math.floor(clamp((t - T.deploy - 0.1) / 1.0) * command.length));
  const line = ramp(t, T.deploy + 1.2, T.cloudflare + 0.2);
  const dest = [
    { at: T.cloudflare, icon: "☁️", name: "Cloudflare", sub: "static sites · Workers" },
    { at: T.machinesWord, icon: "🖥️", name: "Your machines", sub: "Compose, through a tunnel" },
  ];
  const live = pop(T.live, 8);
  return (
    <AbsoluteFill style={{ opacity: win(t, T.deploy - 0.3, T.pull, 0.3) }}>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 330,
          width: 720,
          padding: "28px 34px",
          background: C.surface,
          borderRadius: 28,
          fontFamily: MONO,
          fontSize: 31,
          whiteSpace: "nowrap",
          boxShadow: "0 24px 60px -30px #000",
        }}
      >
        <div style={{ display: "flex", gap: 10, marginBottom: 22 }}>
          {[C.red, C.yellow, C.green].map((c) => (
            <span key={c} style={{ width: 16, height: 16, borderRadius: 99, background: c, opacity: 0.8 }} />
          ))}
        </div>
        <span style={{ color: C.muted }}>~/riffle $ </span>
        {typed}
        <span style={{ opacity: Math.floor(t * 3) % 2 ? 1 : 0, color: C.yellow }}>▍</span>
        <div
          style={{
            marginTop: 26,
            color: C.muted,
            fontSize: 24,
            whiteSpace: "normal",
            opacity: ramp(t, T.deploy + 1.15, T.deploy + 1.4),
          }}
        >
          kitshn deploy · GitHub signs the run, no secret in the repo
        </div>
      </div>
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        {[0, 1].map((i) => (
          <path
            key={i}
            d={`M 830 ${470} C 960 470, 960 ${300 + i * 380}, 1110 ${300 + i * 380}`}
            fill="none"
            stroke={C.yellow}
            strokeWidth="5"
            strokeDasharray="14 14"
            strokeDashoffset={-t * 60}
            opacity={0.85 * clamp(line * 2 - i)}
          />
        ))}
      </svg>
      {dest.map((d, i) => {
        const k = pop(d.at);
        return (
          <div
            key={d.name}
            style={{
              position: "absolute",
              left: 1120,
              top: 210 + i * 380,
              width: 620,
              padding: "26px 32px",
              background: C.surface,
              borderRadius: 28,
              transform: `scale(${k})`,
              opacity: clamp(k * 2),
              display: "flex",
              gap: 24,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 64 }}>{d.icon}</span>
            <div>
              <div style={{ fontSize: 46, fontWeight: 800 }}>{d.name}</div>
              <div style={{ fontSize: 26, color: C.muted }}>{d.sub}</div>
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 300,
          top: 690,
          transform: `scale(${live}) rotate(-4deg)`,
          opacity: clamp(live * 2),
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "14px 26px",
          borderRadius: 999,
          background: C.surface,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 30 }}>riffle.example.com</span>
        <Sticker tone={C.green} tilt={4} style={{ fontSize: 28 }}>
          live
        </Sticker>
      </div>
    </AbsoluteFill>
  );
};

/** The real map: preview cards, circles and members, the drag with its preview, the toast, the panel, machines. */
const Screens: React.FC<{ t: number; T: Times; dragFrom: number; dragTo: number }> = ({
  t,
  T,
  dragFrom,
  dragTo,
}) => {
  const shot = (name: string) => staticFile(`shots/ad-${name}-dark.png`);
  const plates: { name: string; from: number; to: number }[] = [
    { name: "riffle", from: T.pull - 0.3, to: T.map },
    { name: "map", from: T.map, to: T.drag },
    { name: "select", from: T.drag, to: dragTo },
    { name: "drag", from: dragTo, to: T.drop + 0.1 },
    { name: "drop", from: T.drop + 0.1, to: T.machines },
    { name: "machines", from: T.machines, to: T.tunnel + 0.3 },
  ];
  const cx = (b: { x: number; w: number }) => b.x + b.w / 2;
  const cy = (b: { y: number; h: number }) => b.y + b.h / 2;
  const cam = camAt(t, [
    { t: 0, d: 0, x: 880, y: 600, z: 1.5 },
    { t: T.preview + 0.2, d: 1.2, x: 880, y: 630, z: 2.4 },
    { t: T.map, d: 0, x: 960, y: 540, z: 1.0 },
    { t: T.circle + 0.4, d: 2.2, x: 1000, y: 520, z: 1.07 },
    { t: T.email, d: 0.45, x: cx(BOX.email), y: cy(BOX.email) + 40, z: 2.4 },
    { t: T.domain, d: 0.45, x: cx(BOX.domain) + 20, y: cy(BOX.domain) + 40, z: 2.4 },
    { t: T.everyone, d: 0.45, x: cx(BOX.everyone), y: cy(BOX.everyone) + 40, z: 2.4 },
    { t: T.drag, d: 0, x: 700, y: 640, z: 1.35 },
    { t: dragTo, d: dragTo - dragFrom, x: 860, y: 680, z: 1.45 },
    { t: T.see + 0.6, d: 0.6, x: cx(BOX.label) - 30, y: cy(BOX.label) - 10, z: 2.3 },
    { t: T.drop + 0.6, d: 0.5, x: 900, y: 600, z: 1.3 },
    { t: T.undo + 0.2, d: 0.5, x: cx(BOX.toast), y: cy(BOX.toast) + 20, z: 2.3 },
    { t: T.access + 0.5, d: 0.8, x: cx(BOX.who) - 150, y: cy(BOX.who) + 30, z: 2.0 },
    { t: T.machines, d: 0, x: cx(BOX.machines), y: cy(BOX.machines), z: 1.8 },
    { t: T.tunnel, d: 1.2, x: cx(BOX.machines), y: cy(BOX.machines) - 40, z: 2.0 },
  ]);
  // The dragged card: a crop of the tray card that follows the pointer from grab to drop.
  const k = ramp(t, dragFrom, dragTo);
  const px = lerp(BOX.grab.x, BOX.drop.x, k);
  const py = lerp(BOX.grab.y, BOX.drop.y, k) - Math.sin(k * Math.PI) * 120;
  const dragging = t >= dragFrom && t < dragTo;
  const pointerOn = t >= T.drag && t < T.drop + 0.6;
  const pointer =
    t < dragFrom
      ? {
          x: BOX.grab.x + 90 * (1 - ramp(t, T.drag, dragFrom)),
          y: BOX.grab.y + 70 * (1 - ramp(t, T.drag, dragFrom)),
        }
      : t < dragTo
        ? { x: px, y: py }
        : BOX.drop;
  const pressed = t >= dragFrom - 0.08 && t < T.drop;
  const rings: {
    box: { x: number; y: number; w: number; h: number };
    from: number;
    to: number;
    r?: number;
  }[] = [
    ...BOX.previews.map((box, i) => ({ box, from: T.preview + 0.1 * i, to: T.map, r: 14 })),
    ...BOX.cards.map((box, i) => ({ box, from: T.card + i * 0.07, to: T.circle, r: 14 })),
    ...BOX.heads.map((box, i) => ({ box, from: T.circle + i * 0.07, to: T.email - 0.2, r: 999 })),
    { box: BOX.email, from: T.email, to: T.domain - 0.2, r: 999 },
    { box: BOX.domain, from: T.domain, to: T.everyone - 0.2, r: 999 },
    { box: BOX.everyone, from: T.everyone, to: T.drag - 0.1, r: 999 },
    { box: BOX.label, from: T.see, to: T.drop, r: 999 },
    { box: BOX.undo, from: T.undo + 0.1, to: T.access, r: 999 },
    { box: BOX.who, from: T.cfAccess, to: T.machines, r: 18 },
  ];
  return (
    <AbsoluteFill style={{ opacity: win(t, T.pull - 0.3, T.tunnel + 0.3, 0.3), overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1920,
          height: 1080,
          transformOrigin: "0 0",
          transform: `translate(${960 - cam.x * cam.z}px, ${540 - cam.y * cam.z}px) scale(${cam.z})`,
        }}
      >
        {plates.map((p) => {
          const o = win(t, p.from, p.to, 0.18);
          return o > 0 ? (
            <Img
              key={p.name}
              src={shot(p.name)}
              style={{ position: "absolute", inset: 0, width: 1920, height: 1080, opacity: o }}
            />
          ) : null;
        })}
        {dragging ? (
          <>
            <div
              style={{
                position: "absolute",
                left: BOX.tray.x - 10,
                top: BOX.tray.y - 10,
                width: BOX.tray.w + 20,
                height: BOX.tray.h + 20,
                ...dots,
                backgroundSize: "22px 22px",
                backgroundPosition: `${-(BOX.tray.x - 10)}px ${-(BOX.tray.y - 10)}px`,
                borderRadius: 14,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: px - (BOX.grab.x - BOX.tray.x),
                top: py - (BOX.grab.y - BOX.tray.y),
                width: BOX.tray.w,
                height: BOX.tray.h,
                overflow: "hidden",
                borderRadius: 14,
                transform: `rotate(${-3 * Math.sin(k * Math.PI)}deg) scale(${1 + 0.06 * Math.sin(k * Math.PI)})`,
                boxShadow: "0 20px 30px -16px #000",
              }}
            >
              <Img
                src={shot("select")}
                style={{
                  position: "absolute",
                  left: -BOX.tray.x,
                  top: -BOX.tray.y,
                  width: 1920,
                  height: 1080,
                }}
              />
            </div>
          </>
        ) : null}
        {rings.map(({ box, from, to, r = 14 }, i) => {
          const o = win(t, from, to, 0.2);
          if (o <= 0) return null;
          const grow = 1 + 0.08 * Math.sin((t - from) * 6);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: box.x - 6,
                top: box.y - 6,
                width: box.w + 12,
                height: box.h + 12,
                borderRadius: r,
                border: `3px solid ${C.yellow}`,
                boxShadow: `0 0 0 6px ${C.yellow}33`,
                opacity: o,
                transform: `scale(${grow})`,
              }}
            />
          );
        })}
        {pointerOn ? (
          <Pointer
            x={pointer.x}
            y={pointer.y}
            pressed={pressed}
            scale={1 / cam.z}
            opacity={win(t, T.drag, T.drop + 0.6, 0.2)}
          />
        ) : null}
      </div>
      <Chip show={win(t, T.cfAccess, T.machines, 0.25)} at={{ left: 90, top: 90 }}>
        🔒 Cloudflare Access
      </Chip>
      <Gate t={t} at={T.only} until={T.machines} />
    </AbsoluteFill>
  );
};

const Pointer: React.FC<{ x: number; y: number; pressed: boolean; scale: number; opacity: number }> = ({
  x,
  y,
  pressed,
  scale,
  opacity,
}) => (
  <svg
    width="40"
    height="48"
    viewBox="0 0 20 24"
    style={{
      position: "absolute",
      left: x,
      top: y,
      transformOrigin: "0 0",
      transform: `scale(${scale * 1.9 * (pressed ? 0.88 : 1)})`,
      opacity,
      overflow: "visible",
      filter: "drop-shadow(0 3px 4px #0008)",
    }}
  >
    <path
      d="M1 1 L1 19 L6 14.5 L9.5 22 L13 20.5 L9.6 13.2 L16 13 Z"
      fill={C.ink}
      stroke={C.graphite}
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

const Chip: React.FC<{ show: number; at: React.CSSProperties; children: React.ReactNode }> = ({
  show,
  at,
  children,
}) =>
  show > 0 ? (
    <div
      style={{
        position: "absolute",
        ...at,
        padding: "14px 30px",
        borderRadius: 999,
        background: C.yellow,
        color: C.graphite,
        fontSize: 40,
        fontWeight: 800,
        opacity: show,
        transform: `translateY(${(1 - show) * -20}px) rotate(-2deg)`,
        boxShadow: "0 18px 40px -18px #000",
      }}
    >
      {children}
    </div>
  ) : null;

/** Access as a door: the circle's member walks in, anyone else stays out. */
const Gate: React.FC<{ t: number; at: number; until: number }> = ({ t, at, until }) => {
  const rows = [
    { who: "her@example.com", ok: true },
    { who: "anyone else", ok: false },
  ];
  return (
    <div style={{ position: "absolute", left: 90, top: 190, display: "grid", gap: 18 }}>
      {rows.map((row, i) => {
        const o = win(t, at + i * 0.35, until, 0.25);
        return o > 0 ? (
          <div
            key={row.who}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "12px 26px",
              borderRadius: 999,
              background: C.surface,
              fontSize: 34,
              fontWeight: 600,
              opacity: o,
              transform: `translateX(${(1 - o) * -40}px)`,
              boxShadow: "0 18px 40px -18px #000",
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 30 }}>{row.who}</span>
            <Sticker tone={row.ok ? C.green : C.pink} tilt={row.ok ? -4 : 4} style={{ fontSize: 28 }}>
              {row.ok ? "✓ in" : "✗ stopped"}
            </Sticker>
          </div>
        ) : null;
      })}
    </div>
  );
};

/** A machine and Cloudflare, joined by a tunnel the machine opens itself: no port to open. */
const Tunnel: React.FC<{ t: number; pop: Pop; T: Times }> = ({ t, pop, T }) => {
  const off = ramp(t, T.off, T.off + 0.3);
  const lock = pop(T.ports, 8);
  const tile = (left: number, icon: string, name: string, sub: string, at: number, grey = 0) => {
    const k = pop(at);
    return (
      <div
        style={{
          position: "absolute",
          left,
          top: 360,
          width: 460,
          padding: "34px 36px",
          borderRadius: 32,
          background: C.surface,
          transform: `scale(${k})`,
          opacity: clamp(k * 2) * (1 - grey * 0.45),
          filter: `grayscale(${grey})`,
        }}
      >
        <div style={{ fontSize: 80 }}>{icon}</div>
        <div style={{ fontSize: 50, fontWeight: 800, marginTop: 6 }}>{name}</div>
        <div style={{ fontSize: 28, color: C.muted }}>{sub}</div>
      </div>
    );
  };
  return (
    <AbsoluteFill style={{ opacity: win(t, T.tunnel - 0.3, T.friendly, 0.3) }}>
      {tile(190, "🐧", "VPS", "rootless Docker · Compose", T.tunnel - 0.25, off)}
      {tile(1270, "☁️", "Cloudflare", "your address, your Access", T.tunnel)}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
        <path
          d="M 650 520 L 1270 520"
          stroke={C.yellow}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray="2 26"
          strokeDashoffset={-t * 90}
          opacity={(1 - off) * ramp(t, T.tunnel, T.tunnel + 0.4)}
        />
        <path
          d="M 650 520 L 1270 520"
          stroke={C.muted}
          strokeWidth="4"
          strokeDasharray="10 14"
          opacity={off * 0.6}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 830,
          top: 440,
          fontSize: 30,
          color: C.muted,
          opacity: ramp(t, T.tunnel, T.tunnel + 0.4) * (1 - off),
        }}
      >
        tunnel
      </div>
      <div
        style={{
          position: "absolute",
          left: 470,
          top: 300,
          transform: `scale(${lock}) rotate(6deg)`,
          opacity: clamp(lock * 2) * (1 - off),
        }}
      >
        <Sticker tone={C.green} tilt={0} style={{ fontSize: 30, padding: "6px 20px" }}>
          🔒 no open ports
        </Sticker>
      </div>
      <div
        style={{
          position: "absolute",
          left: 470,
          top: 300,
          transform: `scale(${pop(T.off, 8)}) rotate(-5deg)`,
          opacity: off,
        }}
      >
        <Sticker tone={C.pink} tilt={0} style={{ fontSize: 30, padding: "6px 20px" }}>
          offline
        </Sticker>
      </div>
    </AbsoluteFill>
  );
};

/** The real page a visitor gets while the machine is off. */
const Offline: React.FC<{ t: number; T: Times }> = ({ t, T }) => {
  const k = ramp(t, T.friendly - 0.3, T.friendly + 0.4);
  return (
    <AbsoluteFill style={{ opacity: win(t, T.friendly - 0.3, T.end, 0.3), overflow: "hidden" }}>
      <Img
        src={staticFile("shots/ad-offline-dark.png")}
        style={{
          position: "absolute",
          inset: 0,
          width: 1920,
          height: 1080,
          transform: `scale(${lerp(1.15, 1.6, ramp(t, T.friendly, T.end))}) translateY(${(1 - k) * 80}px)`,
          transformOrigin: "960 520px",
        }}
      />
    </AbsoluteFill>
  );
};

const End: React.FC<{ t: number; pop: Pop; T: Times }> = ({ t, pop, T }) => {
  const logo = pop(T.end, 9);
  const a = pop(T.endPush);
  const b = pop(T.endShare);
  const url = pop(T.endPush + 0.2, 9);
  return (
    <AbsoluteFill
      style={{ opacity: clamp((t - T.end + 0.3) / 0.3), alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 30, transform: "translateY(-150px)" }}>
        <Img
          src={staticFile("logo.svg")}
          style={{ width: 150, height: 150, transform: `scale(${logo}) rotate(${(1 - logo) * 20}deg)` }}
        />
        <div style={{ fontSize: 140, fontWeight: 800, letterSpacing: "-0.04em", opacity: clamp(logo * 2) }}>
          kitshn
        </div>
      </div>
      <div
        style={{ position: "absolute", top: 560, fontSize: 60, fontWeight: 600, display: "flex", gap: 22 }}
      >
        <span style={{ opacity: clamp(a * 2), transform: `translateY(${(1 - a) * 30}px)` }}>
          Push a repo.
        </span>
        <span style={{ opacity: clamp(b * 2), transform: `translateY(${(1 - b) * 30}px)` }}>
          Share it with a circle.
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          top: 720,
          display: "flex",
          gap: 20,
          alignItems: "center",
          transform: `scale(${url})`,
          opacity: clamp(url * 2),
        }}
      >
        <span
          style={{
            padding: "14px 36px",
            borderRadius: 999,
            background: C.yellow,
            color: C.graphite,
            fontSize: 46,
            fontWeight: 800,
          }}
        >
          kitshn.com
        </span>
        <span style={{ fontSize: 32, color: C.muted }}>open source · MIT</span>
      </div>
    </AbsoluteFill>
  );
};

/** The line being spoken, for watching without sound. The voice says "kitchen"; the screen spells kitshn. */
const Caption: React.FC<{ t: number; tl: Timeline }> = ({ t, tl }) => {
  const line = tl.lines.find((l) => l.track !== "lyrics" && l.start - 0.1 <= t && t < l.end + 0.35);
  if (!line) return null;
  const text = line.text.replace(/\[[^\]]*\]\s*/g, "").replace(/kitchen/gi, "kitshn");
  const o = win(t, line.start - 0.1, line.end + 0.35, 0.15);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 54,
        display: "flex",
        justifyContent: "center",
        opacity: o,
      }}
    >
      <div
        style={{
          maxWidth: 1500,
          padding: "12px 30px",
          borderRadius: 22,
          background: "#161618e6",
          color: C.ink,
          fontSize: 38,
          fontWeight: 600,
          textAlign: "center",
          lineHeight: 1.3,
        }}
      >
        {text}
      </div>
    </div>
  );
};
