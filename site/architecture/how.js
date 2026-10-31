// How kitshn works: draws the wires between the parts, plays a journey step by step with packets that travel the
// wires, and shows what a part does when you click it. Plain script, no build, like the rest of the site.

const PARTS = {
  github: {
    name: "GitHub",
    where: "Your repos",
    does: "Actions runs kitshn check and kitshn deploy with the run's OIDC token, so you store no deploy keys. The kitshn GitHub App removes a preview when its pull request closes, writes deployment statuses, and starts a waiting run when you click Allow.",
  },
  you: {
    name: "You, on the map",
    where: "Your browser",
    does: "You open the map at kit.your-domain, behind Access with an email code and a passkey. The map keeps one WebSocket to the Durable Object and gets every change live, from you or from another tab.",
  },
  visitor: {
    name: "Visitors",
    where: "Anywhere",
    does: "Anyone who opens an app: people in your circles, your own devices, or the public for a site in Everyone. They open an app's address, and Access allows or blocks the request. They never interact with kitshn.",
  },
  access: {
    name: "Cloudflare Access",
    where: "Cloudflare's edge",
    does: "Protects every private address. It logs people in with an email code, GitHub or a passkey, and checks the circles before a request reaches your app. kitshn writes your circles into it: one policy per circle, one application per card.",
  },
  worker: {
    name: "kitshn Worker",
    where: "Cloudflare",
    does: "It serves the map, checks Access tokens and GitHub OIDC tokens, and serves pages, files and the offline page. A visit to an app does not pass through it.",
  },
  do: {
    name: "Durable Object",
    where: "Cloudflare, one instance",
    does: "One SQLite database holds all state: circles, shares, card places, history, app values and encrypted secrets. It keeps the sockets of the daemons and of open maps, and an alarm queue writes changes to the Cloudflare API, at most 40 calls a run.",
  },
  apps: {
    name: "App Workers",
    where: "Cloudflare",
    does: "One Worker script per environment of a static site or Worker app. Static requests are free, and a visit never wakes kitshn.",
  },
  tunnel: {
    name: "Tunnel",
    where: "Cloudflare and your machine",
    does: "One per machine, made and managed by kitshn. The daemon dials out, so no port is open on your router. The tunnel checks the Access token too, so a wrong DNS record cannot skip the login.",
  },
  r2: {
    name: "R2",
    where: "Cloudflare",
    does: "Pages and files, encrypted backups of Compose apps, a daily copy of kitshn's state, and the source of a deploy while it runs.",
  },
  daemon: {
    name: "kitshn daemon",
    where: "Your machine",
    does: "One binary per machine. It runs cloudflared, deploys Compose apps in rootless Docker, checks local sites, and keeps 30 days of samples on its own disk. It keeps one WebSocket to the Durable Object.",
  },
  compose: {
    name: "Compose app",
    where: "Your machine",
    does: "Built at low CPU priority and started on a Unix socket that cloudflared reaches directly. Its data and logs stay on the machine's disk; backups of its volumes go to R2.",
  },
  live: {
    name: "Live site",
    where: "Your machine",
    does: "A dev server on the machine, shared at its own address through the same tunnel. When the machine is off, visitors get the offline page instead of an error.",
  },
  more: {
    name: "More machines",
    where: "Anywhere",
    does: "Each machine joins with one command and gets its own daemon and its own tunnel. A Compose deploy goes to the first online machine with the labels its recipe asks for.",
  },
};

// The wires: [from, to, kind, label, bend]. A bend sends the wire around a part instead of through it.
const WIRES = [
  ["github", "worker", "", "OIDC token"],
  ["github", "r2", "", "", "left"],
  ["you", "access", ""],
  ["visitor", "access", ""],
  ["access", "worker", ""],
  ["access", "apps", ""],
  ["access", "tunnel", "tube"],
  ["worker", "do", ""],
  ["worker", "apps", "", "Workers API", "down"],
  ["do", "access", "", "Cloudflare API"],
  ["do", "daemon", "ws", "WebSocket"],
  ["r2", "daemon", ""],
  ["tunnel", "daemon", "tube", "tunnel"],
  ["daemon", "compose", ""],
  ["daemon", "live", ""],
];

// A step: t is its title, d its words, go the chains of parts that a packet travels, lit the parts it lights besides
// those, say the notes on parts.
const JOURNEYS = {
  visit: {
    title: "Someone opens a private app",
    sum: "A person in the Friends circle opens a photo album that runs in Docker on your machine.",
    steps: [
      {
        t: "The visitor opens the address",
        d: "The visitor requests photos.you.dev. The app runs in Docker on your machine.",
        lit: ["visitor"],
        say: { visitor: "photos.you.dev" },
      },
      {
        t: "Access asks for a login",
        d: "Cloudflare Access intercepts the request and asks the visitor to log in with a code sent to their email.",
        go: [["visitor", "access"]],
        say: { access: "login" },
      },
      {
        t: "Access checks the policy",
        d: "The app is in Friends, and the visitor is in Friends, so the policy allows the request. Cloudflare does this at its edge, without calling kitshn.",
        lit: ["access", "visitor"],
        say: { access: ["Friends ✓", "ok"] },
      },
      {
        t: "The tunnel forwards the request",
        d: "The tunnel validates the Access token and forwards the request to your machine. No inbound port is open, because the daemon opened the tunnel from the machine.",
        go: [["access", "tunnel", "daemon"]],
        say: { tunnel: "token ✓" },
      },
      {
        t: "The app answers",
        d: "cloudflared, run by the daemon, passes the request to the app's Unix socket, and the app responds.",
        go: [["daemon", "compose"]],
        say: { compose: ["200 OK", "ok"] },
      },
      {
        t: "kitshn is not involved",
        d: "The kitshn Worker and Durable Object are not on this path. A static site has a shorter one: Access, then its own Worker, where static requests are free.",
        go: [["visitor", "access", "apps"]],
        say: { worker: "not on this path", apps: "free" },
      },
    ],
  },
  share: {
    title: "You share an app",
    sum: "You drag a trip planner into the Friends circle.",
    steps: [
      {
        t: "You drop the card",
        d: "You drag Trip planner into Friends on the map. The map itself is behind Access, with an email code and a passkey.",
        go: [["you", "access", "worker"]],
        say: { you: "Trip planner → Friends" },
      },
      {
        t: "The change is stored",
        d: "The Worker passes the change to the Durable Object, which writes the share and a history entry to SQLite.",
        go: [["worker", "do"]],
        say: { do: "+ share  + history" },
      },
      {
        t: "Connected clients update",
        d: "The Durable Object pushes the change over WebSockets to every open map and to the machines that need it.",
        go: [
          ["do", "worker", "access", "you"],
          ["do", "daemon"],
        ],
        say: { you: ["updated", "ok"] },
      },
      {
        t: "kitshn updates Access",
        d: "An alarm queue writes the change to Access through the Cloudflare API, so the Friends policy now covers the trip planner. Each run makes at most 40 calls.",
        go: [["do", "access"]],
        say: { access: "Friends → Trip planner" },
      },
      {
        t: "Members can open the app",
        d: "People in Friends now pass the policy. If you remove someone from Friends later, kitshn ends their open sessions.",
        go: [["visitor", "access", "apps"]],
        say: { access: ["allowed", "ok"] },
      },
    ],
  },
  deploy: {
    title: "You push code",
    sum: "A push to main deploys a Compose app to your machine.",
    steps: [
      {
        t: "You push",
        d: "A push to main starts GitHub Actions. kitshn check reads kitshn.config.ts as data, and kitshn never runs your recipe.",
        lit: ["github"],
        say: { github: "git push" },
      },
      {
        t: "Actions sends the recipe",
        d: "Actions sends the recipe with the run's OIDC token, which GitHub signs, so no deploy key is stored.",
        go: [["github", "worker"]],
        say: { worker: ["OIDC ✓", "ok"] },
      },
      {
        t: "kitshn checks the repo",
        d: "kitshn accepts only repos of the GitHub accounts on its list. A repo it has not deployed before waits for Allow on the map. Later pushes deploy directly.",
        go: [["worker", "do"]],
        say: { do: "allowed ✓" },
      },
      {
        t: "The source goes to R2",
        d: "For a Compose app, Actions uploads the source to R2 through the Worker.",
        go: [["github", "r2"]],
        say: { r2: "source.tar.gz" },
      },
      {
        t: "A machine gets the job",
        d: "kitshn picks the first online machine with the labels the recipe asks for and sends the job over its WebSocket. The daemon downloads the source from R2.",
        go: [
          ["do", "daemon"],
          ["r2", "daemon"],
        ],
        say: { daemon: "job: photos" },
      },
      {
        t: "The daemon builds it",
        d: "The daemon checks the Compose file, builds at low CPU priority and starts the app on a Unix socket. Logs stream back to the Actions step.",
        go: [["daemon", "compose"]],
        say: { compose: ["running", "ok"] },
      },
      {
        t: "kitshn publishes the address",
        d: "kitshn creates the Access application first, then the DNS record and the tunnel route, so the address is never reachable without a check.",
        go: [["do", "access", "tunnel"]],
        say: { access: "1 · Access", tunnel: "2 · route" },
      },
      {
        t: "Static sites and Workers skip the machine",
        d: "For a static site or Worker app, Actions uploads the files and kitshn deploys the Worker through the Cloudflare API. No machine is involved.",
        go: [["worker", "apps"]],
        say: { apps: ["deployed", "ok"] },
      },
    ],
  },
  offline: {
    title: "A machine goes offline",
    sum: "A machine loses power while someone tries to open an app on it.",
    steps: [
      {
        t: "The machine goes offline",
        d: "The machine loses power, and the daemon's WebSocket to kitshn closes.",
        lit: ["daemon", "do"],
        off: true,
        broken: ["do", "daemon"],
        say: { daemon: ["offline", "warn"] },
      },
      {
        t: "kitshn adds a route",
        d: "The Durable Object sees the socket close and adds a Worker route for each address on that machine.",
        go: [["do", "worker"]],
        off: true,
        broken: ["do", "daemon"],
        say: { worker: "+ route" },
      },
      {
        t: "Access still checks first",
        d: "A visitor opens the app. Access checks the policy before anything else, as usual.",
        go: [["visitor", "access"]],
        off: true,
        broken: ["do", "daemon"],
        say: { access: ["Friends ✓", "ok"] },
      },
      {
        t: "The Worker serves the offline page",
        d: "The route sends the request to the Worker, which tries the machine, gets no answer, and serves an offline page with a retry button.",
        go: [["access", "worker"]],
        off: true,
        broken: ["do", "daemon"],
        say: { visitor: "offline page" },
      },
      {
        t: "The machine comes back",
        d: "The daemon reconnects and kitshn removes the route. Requests go directly through the tunnel again, and use no Worker requests.",
        go: [
          ["daemon", "do"],
          ["visitor", "access", "tunnel", "daemon"],
        ],
        say: { worker: "− route", daemon: ["online", "ok"] },
      },
    ],
  },
};

const STEP_MS = 5200;
const HOP_MS = 650;
const still = matchMedia("(prefers-reduced-motion: reduce)");

const stage = document.getElementById("stage");
const svg = stage.querySelector(".wires");
const panel = document.querySelector(".panel-body");
const controls = document.querySelector(".controls");
const playButton = controls.querySelector('[data-ctl="play"]');
const count = controls.querySelector(".count");
const tabs = [...document.querySelectorAll(".journeys [data-journey]")];
const nodes = Object.fromEntries([...stage.querySelectorAll(".node")].map((n) => [n.dataset.node, n]));
const NS = "http://www.w3.org/2000/svg";

const key = (a, b) => [a, b].sort().join("|");
const wires = new Map();
for (const [from, to, kind, label, bend] of WIRES) {
  const path = document.createElementNS(NS, "path");
  path.setAttribute("class", `wire ${kind}`);
  svg.append(path);
  let text = null;
  if (label) {
    text = document.createElementNS(NS, "text");
    text.setAttribute("class", "wire-label");
    text.textContent = label;
  }
  wires.set(key(from, to), { from, to, bend, path, text });
}
// Labels go last, so they sit on top of every wire.
for (const wire of wires.values()) if (wire.text) svg.append(wire.text);

const box = (id) => {
  const n = nodes[id];
  return {
    x: n.offsetLeft,
    y: n.offsetTop,
    r: n.offsetLeft + n.offsetWidth,
    b: n.offsetTop + n.offsetHeight,
  };
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// A wire runs straight when two parts share a column or a row, and as a soft S between them otherwise.
function shape({ from, to, bend }) {
  const a = box(from);
  const b = box(to);
  if (bend === "left") {
    const ay = (a.y + a.b) / 2;
    const by = (b.y + b.b) / 2;
    return `M${a.x} ${ay} C${a.x - 34} ${ay} ${b.x - 34} ${by} ${b.x} ${by}`;
  }
  if (bend === "down") {
    const ax = (a.x + a.r) / 2;
    const bx = (b.x + b.r) / 2;
    return `M${ax} ${a.b} C${ax} ${a.b + 46} ${bx} ${b.b + 46} ${bx} ${b.b}`;
  }
  const [top, bottom, flip] = a.b <= b.y ? [a, b, false] : b.b <= a.y ? [b, a, true] : [null, null, false];
  if (!top) {
    const [left, right] = a.r <= b.x ? [a, b] : [b, a];
    const y = (Math.max(a.y, b.y) + Math.min(a.b, b.b)) / 2;
    const d = `M${left.r} ${y} L${right.x} ${y}`;
    return left === a ? d : reverse(left.r, y, right.x, y);
  }
  const lo = Math.max(top.x, bottom.x);
  const hi = Math.min(top.r, bottom.r);
  let x1, x2;
  if (hi - lo > 24) {
    x1 = x2 = (lo + hi) / 2;
  } else {
    x1 = clamp((bottom.x + bottom.r) / 2, top.x + 18, top.r - 18);
    x2 = clamp((top.x + top.r) / 2, bottom.x + 18, bottom.r - 18);
  }
  const mid = (top.b + bottom.y) / 2;
  const d = `M${x1} ${top.b} C${x1} ${mid} ${x2} ${mid} ${x2} ${bottom.y}`;
  return flip ? `M${x2} ${bottom.y} C${x2} ${mid} ${x1} ${mid} ${x1} ${top.b}` : d;
}
function reverse(x1, y1, x2, y2) {
  return `M${x2} ${y2} L${x1} ${y1}`;
}

function layout() {
  svg.setAttribute("viewBox", `0 0 ${stage.offsetWidth} ${stage.offsetHeight}`);
  for (const wire of wires.values()) {
    wire.path.setAttribute("d", shape(wire));
    wire.length = wire.path.getTotalLength();
    if (wire.text) {
      const p = wire.path.getPointAtLength(wire.length / 2);
      wire.text.setAttribute("x", p.x);
      wire.text.setAttribute("y", p.y);
    }
  }
  placeBubbles();
}

// --- What plays --------------------------------------------------------------------------------------------------

let journey = "visit";
let step = 0;
let playing = false;
let elapsed = 0;
let picked = null;
let seen = false;
let hops = [];
let bubbles = [];

function hopsOf(chains) {
  // Each chain is a list of parts; its packet takes one hop per wire, one after another.
  return chains.map((chain) =>
    chain.slice(1).map((to, i) => {
      const from = chain[i];
      const wire = wires.get(key(from, to));
      return { wire, back: wire.from !== from };
    }),
  );
}

function render() {
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.journey === journey));
  for (const n of Object.values(nodes)) n.classList.remove("lit", "sel");
  for (const wire of wires.values()) {
    wire.path.classList.remove("on", "broken");
    wire.text?.classList.remove("on");
  }
  for (const b of bubbles) b.el.remove();
  bubbles = [];
  svg.querySelectorAll(".packet").forEach((p) => p.remove());
  hops = [];

  if (journey === "parts") {
    stage.classList.remove("running", "off");
    controls.hidden = true;
    if (picked) nodes[picked].classList.add("sel");
    renderPart();
    return;
  }

  const j = JOURNEYS[journey];
  const s = j.steps[step];
  stage.classList.add("running");
  stage.classList.toggle("off", Boolean(s.off));
  controls.hidden = false;
  playButton.textContent = playing ? "❚❚" : "▶";
  playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
  count.textContent = `${step + 1} / ${j.steps.length}`;

  const chains = s.go ?? [];
  for (const id of [...chains.flat(), ...(s.lit ?? [])]) nodes[id].classList.add("lit");
  hops = hopsOf(chains);
  for (const chain of hops) {
    for (const { wire } of chain) {
      wire.path.classList.add("on");
      wire.text?.classList.add("on");
    }
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("class", "packet");
    dot.setAttribute("r", 6);
    dot.style.opacity = 0;
    svg.append(dot);
    chain.dot = dot;
  }
  if (s.broken) wires.get(key(...s.broken)).path.classList.add("broken");
  for (const [id, said] of Object.entries(s.say ?? {})) {
    const [text, tone] = Array.isArray(said) ? said : [said, ""];
    const el = document.createElement("span");
    el.className = `bubble ${tone}`;
    el.textContent = text;
    stage.append(el);
    bubbles.push({ id, el });
  }
  placeBubbles();
  renderSteps(j);
}

function placeBubbles() {
  for (const { id, el } of bubbles) {
    const b = box(id);
    el.style.left = `${clamp((b.x + b.r) / 2, el.offsetWidth / 2 + 2, stage.offsetWidth - el.offsetWidth / 2 - 2)}px`;
    el.style.top = `${b.y + 6}px`;
  }
}

function renderSteps(j) {
  const list = panel.querySelector(".steps-list");
  if (!list || panel.dataset.journey !== journey) {
    panel.dataset.journey = journey;
    panel.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = j.title;
    const p = document.createElement("p");
    p.className = "sum";
    p.textContent = j.sum;
    const ol = document.createElement("ol");
    ol.className = "steps-list";
    j.steps.forEach((s, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<button><span class="n">${i + 1}</span><span class="t"></span><span class="d"></span><span class="bar"></span></button>`;
      li.querySelector(".t").textContent = s.t;
      li.querySelector(".d").textContent = s.d;
      li.querySelector("button").addEventListener("click", () => go(i, false));
      ol.append(li);
    });
    panel.append(h, p, ol);
  }
  panel.querySelectorAll(".steps-list li").forEach((li, i) => {
    li.classList.toggle("now", i === step);
    li.classList.toggle("done", i < step);
    li.querySelector(".bar").style.setProperty("--p", 0);
  });
}

function renderPart() {
  panel.dataset.journey = "parts";
  panel.innerHTML = "";
  if (!picked) {
    panel.innerHTML = `
      <h3>The parts</h3>
      <p class="sum">Click any part to see what it does. Or pick a journey above to watch a request travel.</p>
      <ul class="legend">
        <li><i class="l-net"></i> The internet: you, your visitors, GitHub</li>
        <li><i class="l-cf"></i> Cloudflare: Access, kitshn, your sites, R2</li>
        <li><i class="l-home"></i> Your machine: the daemon and its apps</li>
        <li><svg viewBox="0 0 20 8" aria-hidden="true"><path d="M1 4h18" stroke="#19191b" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/></svg> A WebSocket that stays open</li>
        <li><svg viewBox="0 0 20 8" aria-hidden="true"><path d="M1 4h18" stroke="#19191b88" stroke-width="5" stroke-dasharray="6 3"/></svg> A tunnel: the machine dials out</li>
      </ul>`;
    return;
  }
  const part = PARTS[picked];
  const where = document.createElement("span");
  where.className = "sticker blue part-where";
  where.textContent = part.where;
  const h = document.createElement("h3");
  h.textContent = part.name;
  const p = document.createElement("p");
  p.className = "part-does";
  p.textContent = part.does;
  const back = document.createElement("button");
  back.className = "btn back";
  back.textContent = "All parts";
  back.addEventListener("click", () => {
    picked = null;
    render();
  });
  panel.append(where, h, p, back);
}

function go(i, keepPlaying) {
  const j = JOURNEYS[journey];
  step = (i + j.steps.length) % j.steps.length;
  elapsed = 0;
  if (!keepPlaying) playing = false;
  render();
}

function choose(id) {
  journey = id;
  step = 0;
  elapsed = 0;
  playing = id !== "parts" && !still.matches;
  render();
}

tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => choose(tab.dataset.journey));
  tab.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    const next = tabs[(i + d + tabs.length) % tabs.length];
    next.focus();
    choose(next.dataset.journey);
  });
});
for (const [id, n] of Object.entries(nodes)) {
  n.addEventListener("click", () => {
    journey = "parts";
    playing = false;
    picked = picked === id ? null : id;
    render();
  });
}
controls.addEventListener("click", (e) => {
  const ctl = e.target.closest("[data-ctl]")?.dataset.ctl;
  if (ctl === "prev") go(step - 1, false);
  if (ctl === "next") go(step + 1, false);
  if (ctl === "play") {
    const j = JOURNEYS[journey];
    if (!playing && step === j.steps.length - 1 && elapsed >= STEP_MS) go(0, true);
    playing = !playing;
    render();
  }
});

// One clock for the packets and the step timer. Packets loop on their wires while a step shows.
let last = performance.now();
function tick(now) {
  const dt = Math.min(now - last, 100);
  last = now;
  if (journey !== "parts") {
    if (playing) {
      elapsed += dt;
      const j = JOURNEYS[journey];
      if (elapsed >= STEP_MS) {
        if (step < j.steps.length - 1) go(step + 1, true);
        else {
          elapsed = STEP_MS;
          playing = false;
          playButton.textContent = "↻";
          playButton.setAttribute("aria-label", "Play again");
        }
      }
      const bar = panel.querySelector(".steps-list li.now .bar");
      bar?.style.setProperty("--p", Math.min(elapsed / STEP_MS, 1));
    }
    movePackets(now);
  }
  requestAnimationFrame(tick);
}
function movePackets(now) {
  for (const chain of hops) {
    if (!chain.dot) continue;
    if (still.matches) {
      chain.dot.style.opacity = 0;
      continue;
    }
    const travel = chain.length * HOP_MS;
    const t = now % (travel + 700);
    if (t > travel) {
      chain.dot.style.opacity = 0;
      continue;
    }
    const hop = chain[Math.floor(t / HOP_MS)];
    const f = (t % HOP_MS) / HOP_MS;
    const ease = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    const at = hop.wire.length * (hop.back ? 1 - ease : ease);
    const p = hop.wire.path.getPointAtLength(at);
    chain.dot.setAttribute("cx", p.x);
    chain.dot.setAttribute("cy", p.y);
    chain.dot.style.opacity = 1;
  }
}

new ResizeObserver(layout).observe(stage);
document.fonts?.ready.then(layout);
layout();
render();
requestAnimationFrame(tick);

// The journey starts playing the first time the explorer comes into view.
const explorer = document.querySelector(".explorer");
new IntersectionObserver(
  (entries, observer) => {
    if (!entries.some((e) => e.isIntersecting) || seen) return;
    seen = true;
    observer.disconnect();
    if (journey !== "parts" && !still.matches) {
      playing = true;
      elapsed = 0;
      render();
    }
  },
  { threshold: 0.35 },
).observe(explorer);

// Sections fade up into view.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }
  },
  { threshold: 0.2 },
);
document.querySelectorAll(".reveal").forEach((el) => reveal.observe(el));
