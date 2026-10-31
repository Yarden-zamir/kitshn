// Projects on the home page: one file, read by kitshn, sends each part of a bigger project to where it runs. A dot travels
// from the file through kitshn to one part at a time, in the order of a real deploy: a part goes after the parts it needs.
// Plain script, no build, like the rest of the site. Without motion every part simply shows as live.
(() => {
  const root = document.getElementById("flowmap");
  if (!root) return;

  const NS = "http://www.w3.org/2000/svg";
  const stackedNow = matchMedia("(max-width: 1100px)");
  const TRIP_MS = 1300;
  const REST_MS = 3000;
  const ORDER = ["storage", "photos", "plans", "reminders", "website"];

  const svg = root.querySelector(".fm-wires");
  const hub = root.querySelector(".fm-hub");
  const fileBox = root.querySelector(".fm-file");
  const row = (id) => fileBox.querySelector(`[data-part="${id}"]`);
  const part = (id) => root.querySelector(`.fm-part[data-part="${id}"]`);

  const wire = (kind) => {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("class", `fm-wire ${kind}`);
    svg.append(path);
    return path;
  };
  const kindOf = (id) => (part(id).closest(".fm-zone").classList.contains("computer") ? "computer" : "cloud");
  const wires = Object.fromEntries(ORDER.map((id) => [id, { in: wire(kindOf(id)), out: wire(kindOf(id)) }]));
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("class", "fm-dot");
  dot.setAttribute("r", 6);
  svg.append(dot);

  const box = (el) => {
    const [a, b] = [el.getBoundingClientRect(), root.getBoundingClientRect()];
    return { x: a.left - b.left, y: a.top - b.top, r: a.right - b.left, b: a.bottom - b.top };
  };

  function layout() {
    const stacked = stackedNow.matches;
    svg.setAttribute("viewBox", `0 0 ${root.clientWidth} ${root.clientHeight}`);
    const h = box(hub);
    const midY = (h.y + h.b) / 2;
    const midX = (h.x + h.r) / 2;
    for (const id of ORDER) {
      const [from, to] = [box(row(id)), box(part(id))];
      const toY = (to.y + to.b) / 2;
      if (stacked) {
        const f = box(fileBox);
        const gutter = 8;
        wires[id].in.setAttribute("d", `M${midX} ${f.b} L${midX} ${h.y}`);
        wires[id].out.setAttribute(
          "d",
          `M${h.x} ${midY} C${gutter} ${midY} ${gutter} ${midY} ${gutter} ${midY + 30} L${gutter} ${toY - 14} Q${gutter} ${toY} ${to.x} ${toY}`,
        );
      } else {
        const fromY = (from.y + from.b) / 2;
        const bend = (h.x - from.r) / 2;
        wires[id].in.setAttribute(
          "d",
          `M${from.r} ${fromY} C${from.r + bend} ${fromY} ${h.x - bend} ${midY} ${h.x} ${midY}`,
        );
        const out = (to.x - h.r) / 2;
        wires[id].out.setAttribute(
          "d",
          `M${h.r} ${midY} C${h.r + out} ${midY} ${to.x - out} ${toY} ${to.x} ${toY}`,
        );
      }
    }
  }

  const setLive = (id, live) => {
    part(id).classList.toggle("live", live);
    row(id).classList.toggle("live", live);
    wires[id].in.classList.toggle("on", live);
    wires[id].out.classList.toggle("on", live);
  };

  new ResizeObserver(layout).observe(root);
  document.fonts?.ready.then(layout);
  layout();

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const id of ORDER) setLive(id, true);
    dot.remove();
    return;
  }

  let seen = false;
  let index = 0;
  let began = 0;
  new IntersectionObserver(([entry]) => (seen = Boolean(entry?.isIntersecting)), { threshold: 0.25 }).observe(
    root,
  );

  // One clock: a trip for each part in turn, then a rest with all of them live, then the loop starts again.
  function tick(now) {
    if (seen) {
      began ||= now;
      const t = now - began;
      if (index < ORDER.length) {
        const id = ORDER[index];
        const f = Math.min(1, t / TRIP_MS);
        const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
        const [a, b] = [wires[id].in, wires[id].out];
        const [la, lb] = [a.getTotalLength(), b.getTotalLength()];
        const along = eased * (la + lb);
        const p = along < la ? a.getPointAtLength(along) : b.getPointAtLength(along - la);
        dot.setAttribute("cx", p.x);
        dot.setAttribute("cy", p.y);
        dot.style.opacity = 1;
        dot.setAttribute("class", `fm-dot ${kindOf(id)}`);
        if (f === 1) {
          setLive(id, true);
          index += 1;
          began = now;
        }
      } else {
        dot.style.opacity = 0;
        if (t > REST_MS) {
          for (const id of ORDER) setLive(id, false);
          index = 0;
          began = now;
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
