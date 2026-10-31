// The try-it map on the home page: a small picture of how sharing works, in plain script like the rest of the site. It
// shares no code with the product and talks to nothing. Drag a site into a circle to share it, drag a circle's name to
// move it with its sites, and drag the dot on its edge to resize it. A site turns from grey to colour once it is shared.
// The opening shows the whole way: add a site, then drag it into a circle. A visitor can add their own the same way.
(() => {
  const root = document.getElementById("try");
  if (!root) return;

  const PICTURES = {
    server: `<rect width="132" height="38" fill="#ffe6c7"/><rect x="14" y="6" width="104" height="26" rx="4" fill="#19191b"/><circle cx="27" cy="19" r="4" fill="#6ee7a0"/><circle cx="40" cy="19" r="4" fill="#ffd23f"/><path d="M62 14h44M62 19h44M62 24h44" stroke="#f4f4ef" stroke-width="2"/>`,
    me: `<rect width="132" height="64" fill="#fff7d1"/><circle cx="23" cy="22" r="12" fill="#ffd23f" stroke="#19191b" stroke-width="1.5"/><rect x="44" y="13" width="76" height="6" fill="#19191b"/><rect x="44" y="24" width="52" height="4" fill="#19191b66"/><rect x="11" y="44" width="110" height="12" rx="3" fill="#ff9fb2"/>`,
    trip: `<rect width="132" height="64" fill="#d9f1ff"/><path d="M14 50C42 10 72 60 118 14" fill="none" stroke="#19191b" stroke-width="2" stroke-dasharray="4 4"/><circle cx="14" cy="50" r="5" fill="#ff9fb2" stroke="#19191b" stroke-width="1.5"/><circle cx="118" cy="14" r="5" fill="#ffd23f" stroke="#19191b" stroke-width="1.5"/>`,
    habits: `<rect width="132" height="64" fill="#e4fbee"/>${[
      1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1,
    ]
      .map(
        (done, i) =>
          `<rect x="${11 + (i % 7) * 16}" y="${9 + Math.floor(i / 7) * 16}" width="14" height="13" rx="2" fill="${done ? "#2fbf71" : "#19191b1a"}"/>`,
      )
      .join("")}`,
    notes: `<rect width="132" height="64" fill="#ffe3ea"/><rect x="12" y="11" width="70" height="7" fill="#19191b"/><rect x="12" y="25" width="108" height="4" fill="#19191b66"/><rect x="12" y="34" width="108" height="4" fill="#19191b66"/><rect x="12" y="43" width="72" height="4" fill="#19191b66"/>`,
    gallery: `<rect width="132" height="64" fill="#ece7ff"/><rect x="11" y="10" width="34" height="44" rx="3" fill="#ffd23f" stroke="#19191b" stroke-width="1.5"/><rect x="49" y="10" width="34" height="44" rx="3" fill="#5cc8ff" stroke="#19191b" stroke-width="1.5"/><rect x="87" y="10" width="34" height="44" rx="3" fill="#ff9fb2" stroke="#19191b" stroke-width="1.5"/>`,
  };

  /** What a new site is called when its name is left empty, and the pictures that new sites take in turn. */
  const SUGGESTED = ["Habit tracker", "Recipe book", "Photo album", "Family blog"];
  const NEW_PICTURES = ["notes", "gallery"];
  const MOST_CARDS = 6;

  const CIRCLES = [
    { id: "friends", name: "Friends", color: "var(--pink)", people: ["Maya", "Sam"] },
    { id: "family", name: "Family", color: "var(--info)", people: ["Mom", "Dad"] },
    { id: "everyone", name: "Everyone", color: "var(--green)", people: [], open: true },
  ];
  const CARDS = [
    { id: "me", name: "My site" },
    { id: "trip", name: "Trip planner" },
    { id: "habits", name: "Habit tracker" },
    { id: "server", name: "Home server", machine: true },
  ];

  // Where things start in a wide frame and in a phone's tall one: [x, y, r] of a circle and [x, y] of a card.
  const WIDE = {
    w: 640,
    h: 516,
    friends: [130, 162, 118],
    family: [278, 365, 130],
    everyone: [490, 210, 130],
    me: [490, 230],
    trip: [278, 385],
    habits: [546, 408],
    server: [278, 290],
  };
  const TALL = {
    w: 420,
    h: 600,
    friends: [118, 150, 100],
    family: [298, 290, 116],
    everyone: [130, 462, 118],
    me: [130, 480],
    trip: [298, 322],
    habits: [336, 458],
    server: [298, 228],
  };
  // /enterprise/ asks for a company's map with data-map="company": four teams, and their own sites and machine.
  if (root.dataset.map === "company") {
    Object.assign(CIRCLES[0], { name: "Sales", people: ["the Sales team"] });
    Object.assign(CIRCLES[1], { name: "Engineering", people: ["the Engineering team"] });
    CIRCLES.splice(2, 0, {
      id: "contractors",
      name: "Contractors",
      color: "var(--warning)",
      people: ["contractors"],
    });
    CARDS[0].name = "Status page";
    CARDS[1].name = "Internal docs";
    CARDS[2].name = "Sales report";
    CARDS[3].name = "build-01";
    SUGGESTED.splice(0, SUGGESTED.length, "Sales report", "Billing portal", "Team wiki", "HR handbook");
    Object.assign(WIDE, {
      friends: [120, 142, 100],
      family: [175, 374, 122],
      contractors: [400, 392, 80],
      everyone: [470, 182, 105],
      me: [470, 202],
      trip: [175, 400],
      server: [175, 308],
      habits: [556, 395],
    });
    Object.assign(TALL, {
      friends: [100, 118, 82],
      family: [135, 345, 130],
      contractors: [340, 385, 72],
      everyone: [285, 175, 90],
      me: [285, 195],
      trip: [135, 382],
      server: [135, 285],
      habits: [340, 515],
    });
  }

  /** A phone's window; a short desktop window keeps the wide map, only smaller. */
  const TALL_BELOW = 620;

  const CARD_W = 132;
  const CARD_H = 100;
  const MIN_R = 70;
  const MAX_R = 230;
  /** Room above a circle for its name, which sits on its edge. */
  const HEAD = 18;
  /** How long the bar stays before it leaves by itself. */
  const TOAST_MS = 3200;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));

  const clamp = (value, low, high) => (low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value)));
  const inside = (card, circle) => Math.hypot(card.x - circle.x, card.y - circle.y) < circle.r;
  const list = (names) =>
    names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

  const stage = document.createElement("div");
  stage.className = "try-stage";
  const said = document.createElement("p");
  said.className = "try-said";
  said.setAttribute("aria-live", "polite");
  const toast = document.createElement("div");
  toast.className = "try-toast";
  toast.setAttribute("aria-hidden", "true");
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "btn primary try-new";
  addButton.textContent = "+ Add site";
  const form = document.createElement("form");
  form.className = "try-form";
  form.hidden = true;
  form.innerHTML = `<label>Site name <input maxlength="24" autocomplete="off" /></label><button type="submit" class="btn primary">Add</button>`;
  const input = form.querySelector("input");
  const formAdd = form.querySelector("button");
  root.append(stage, said, toast, addButton, form);

  let plan = WIDE;
  let scale = 1;
  let touched = false;
  let held = null;
  let hintRun = 0;
  /** Ends the opening at once, before a press of the visitor counts. */
  let stopHint = () => {};
  let circles = [];
  let cards = [];

  const whoOpens = (card) => {
    const holding = circles.filter((circle) => inside(card, circle));
    if (holding.some((circle) => circle.open)) return "anyone can open it";
    const people = holding.flatMap((circle) => circle.people);
    return people.length > 0 ? `${list(people)} can open it` : "only you can open it";
  };

  const save = () => ({
    circles: circles.map(({ x, y, r }) => ({ x, y, r })),
    cards: cards.map(({ x, y }) => ({ x, y })),
  });
  const load = (saved) => {
    circles.forEach((circle, i) => Object.assign(circle, saved.circles[i]));
    cards.forEach((card, i) => Object.assign(card, saved.cards[i]));
  };

  function draw() {
    for (const circle of circles) {
      circle.el.style.left = `${circle.x - circle.r}px`;
      circle.el.style.top = `${circle.y - circle.r}px`;
      circle.el.style.width = circle.el.style.height = `${circle.r * 2}px`;
      circle.el.classList.toggle("over", held !== null && inside(held, circle));
    }
    for (const card of cards) {
      card.el.style.left = `${card.x}px`;
      card.el.style.top = `${card.y}px`;
      card.el.classList.toggle(
        "shared",
        circles.some((circle) => inside(card, circle)),
      );
      card.el.setAttribute("aria-label", `${card.name}: ${whoOpens(card)}. Arrow keys move it.`);
    }
  }

  /** The dialog of a site that would become public. It answers true or false; Escape is Cancel. */
  function ask(names) {
    const box = document.createElement("div");
    box.className = "try-ask";
    box.innerHTML = `<div class="try-ask-box" role="alertdialog" aria-modal="true"><p></p><div><button type="button" class="btn">Cancel</button><button type="button" class="btn primary">Make it public</button></div></div>`;
    box.querySelector("p").textContent =
      `This makes ${list(names)} public. Anyone with the address can open it.`;
    const [no, yes] = box.querySelectorAll("button");
    root.append(box);
    yes.focus({ preventScroll: true });
    return new Promise((done) => {
      const close = (answer) => {
        box.remove();
        done(answer);
      };
      no.addEventListener("click", () => close(false));
      yes.addEventListener("click", () => close(true));
      box.addEventListener("keydown", (event) => {
        if (event.key === "Escape") close(false);
      });
    });
  }

  /** The circles that hold each site, in the order of `cards`. */
  const holding = () => cards.map((card) => circles.filter((circle) => inside(card, circle)));
  const heldIn = (saved) => {
    const now = save();
    load(saved);
    const held = holding();
    load(now);
    return held;
  };

  /** One line for a site that changed, or null when the same circles hold it. */
  function change(card, was, now) {
    const gained = now.filter((circle) => !was.includes(circle));
    const lost = was.filter((circle) => !now.includes(circle));
    const names = (some) => list(some.map((circle) => circle.name));
    if (gained.length > 0) return `${card.name} is now shared with ${names(gained)}`;
    if (lost.length > 0 && now.length === 0) return `${card.name} is private again`;
    if (lost.length > 0) return `${card.name} is no longer shared with ${names(lost)}`;
    return null;
  }

  /** The bar slides in, stays a moment and leaves by itself; a newer change replaces it and starts the time again. */
  let toastTimer = 0;
  function announce(lines) {
    toast.replaceChildren(
      ...lines.map((line) => Object.assign(document.createElement("p"), { textContent: line })),
    );
    said.textContent = lines.join(". ");
    toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("on"), TOAST_MS);
  }
  function tell(before) {
    const was = heldIn(before);
    const now = holding();
    const lines = cards.flatMap((card, i) => change(card, was[i], now[i]) ?? []);
    if (lines.length > 0) announce(lines);
  }

  /** After a change: a site that enters Everyone asks first, and Cancel puts everything back. */
  async function settle(before) {
    const open = (held) => held.some((circle) => circle.open);
    const was = heldIn(before);
    const going = cards.filter((card, i) => open(holding()[i]) && !open(was[i]));
    if (going.length > 0 && !(await ask(going.map((card) => card.name)))) {
      stage.classList.add("glide");
      load(before);
      draw();
      setTimeout(() => stage.classList.remove("glide"), 320);
      return;
    }
    tell(before);
  }

  const point = (event) => {
    const box = stage.getBoundingClientRect();
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale };
  };

  /** One press: `press` gets the point, and answers what to do with each move and which card it was about. */
  function pressable(el, press) {
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      touched = true;
      stopHint();
      el.focus({ preventScroll: true });
      el.setPointerCapture(event.pointerId);
      const before = save();
      const { move, card } = press(point(event));
      el.classList.add("held");
      const moved = (each) => {
        move(point(each));
        draw();
      };
      const finish = (each) => {
        el.removeEventListener("pointermove", moved);
        el.removeEventListener("pointerup", finish);
        el.removeEventListener("pointercancel", finish);
        el.classList.remove("held");
        held = null;
        if (each.type === "pointercancel") load(before);
        draw();
        if (each.type === "pointerup") void settle(before);
      };
      el.addEventListener("pointermove", moved);
      el.addEventListener("pointerup", finish);
      el.addEventListener("pointercancel", finish);
    });
  }

  /** The arrow keys, as the same change a drag makes. */
  function arrowable(el, step, card) {
    el.addEventListener("keydown", (event) => {
      const delta = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (!delta) return;
      event.preventDefault();
      touched = true;
      stopHint();
      const before = save();
      step(...delta);
      draw();
      void settle(before);
    });
  }

  const moveCard = (card, x, y) => {
    card.x = clamp(x, CARD_W / 2 + 6, plan.w - CARD_W / 2 - 6);
    card.y = clamp(y, CARD_H / 2 + 6, plan.h - CARD_H / 2 - 6);
  };
  const fitCircle = (circle, x, y, r) => {
    circle.r = clamp(r, MIN_R, MAX_R);
    circle.x = clamp(x, circle.r + 4, plan.w - circle.r - 4);
    circle.y = clamp(y, circle.r + HEAD, plan.h - circle.r - 4);
  };
  const longest = (circle) =>
    Math.min(MAX_R, circle.x - 4, plan.w - circle.x - 4, circle.y - HEAD, plan.h - circle.y - 4);

  function addCard(each, x, y) {
    const el = document.createElement("div");
    el.className = "try-card";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.dataset.card = each.id;
    el.classList.toggle("machine", Boolean(each.machine));
    const picture = PICTURES[each.picture ?? each.id];
    // A site is a browser window; a server is a rack, so the two read apart at a glance.
    el.innerHTML = each.machine
      ? `<svg class="try-pic" viewBox="0 0 132 38" aria-hidden="true">${picture}</svg><span class="try-title"></span>`
      : `<span class="try-bar"><i></i><i></i><i></i></span><svg class="try-pic" viewBox="0 0 132 64" aria-hidden="true">${picture}</svg><span class="try-title"></span>`;
    el.querySelector(".try-title").textContent = each.name;
    stage.append(el);
    const card = { ...each, x, y, el };
    cards.push(card);
    pressable(el, (start) => {
      const [dx, dy] = [start.x - card.x, start.y - card.y];
      held = card;
      return { card, move: (at) => moveCard(card, at.x - dx, at.y - dy) };
    });
    arrowable(el, (dx, dy) => moveCard(card, card.x + dx * 24, card.y + dy * 24), card);
    return card;
  }

  /** The spot outside every circle that is furthest from the other sites, and clear of the bar at the bottom. */
  function freeSpot() {
    let best = { x: plan.w / 2, y: plan.h / 2 };
    let room = -1;
    for (let y = 70 + CARD_H / 2; y <= plan.h - CARD_H / 2 - 44; y += 12) {
      for (let x = CARD_W / 2 + 8; x <= plan.w - CARD_W / 2 - 8; x += 12) {
        if (circles.some((circle) => Math.hypot(x - circle.x, y - circle.y) < circle.r + 10)) continue;
        const nearest = Math.min(
          ...cards.map((card) => Math.hypot((x - card.x) / CARD_W, (y - card.y) / CARD_H)),
        );
        if (nearest > room) {
          room = nearest;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** A new site: it is online at once, and private until it is dragged into a circle. */
  function createSite(name) {
    const used = cards.filter((card) => !CARDS.some((each) => each.id === card.id));
    const first = !cards.some((card) => card.id === "habits");
    const spot = first ? { x: plan.habits[0], y: plan.habits[1] } : freeSpot();
    const each = first
      ? { id: "habits", name }
      : { id: `site-${cards.length}`, name, picture: NEW_PICTURES[used.length % NEW_PICTURES.length] };
    const card = addCard(each, spot.x, spot.y);
    card.el.classList.add("born");
    draw();
    announce([`${name} is online and private`]);
    addButton.hidden = cards.length >= MOST_CARDS;
    return card;
  }

  const closeForm = () => {
    form.hidden = true;
    input.value = "";
  };

  addButton.addEventListener("click", () => {
    touched = true;
    stopHint();
    form.hidden = !form.hidden;
    if (form.hidden) return closeForm();
    input.placeholder = SUGGESTED.find((name) => !cards.some((card) => card.name === name)) ?? "My site";
    input.focus({ preventScroll: true });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = input.value.trim() || input.placeholder;
    closeForm();
    createSite(name).el.focus({ preventScroll: true });
  });
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeForm();
    addButton.focus({ preventScroll: true });
  });

  function build() {
    stopHint();
    hintRun += 1;
    plan = innerWidth < TALL_BELOW ? TALL : WIDE;
    stage.replaceChildren();
    stage.style.width = `${plan.w}px`;
    stage.style.height = `${plan.h}px`;
    root.style.aspectRatio = `${plan.w} / ${plan.h}`;

    circles = CIRCLES.map((each) => {
      const [x, y, r] = plan[each.id];
      const el = document.createElement("div");
      el.className = "try-circle";
      el.style.setProperty("--c", each.color);
      el.innerHTML = `<button type="button" class="try-name"></button><button type="button" class="try-grip"></button>`;
      el.querySelector(".try-name").textContent = each.name;
      el.querySelector(".try-grip").setAttribute("aria-label", `Resize ${each.name} with the arrow keys`);
      el.querySelector(".try-name").setAttribute("aria-label", `Move ${each.name} with the arrow keys`);
      stage.append(el);
      return { ...each, x, y, r, el };
    });

    // The opening adds Habit tracker. Without motion there is no opening, so it is there from the start.
    cards = [];
    for (const each of CARDS) {
      if (each.id !== "habits" || still) addCard(each, ...plan[each.id]);
    }

    for (const circle of circles) {
      const carry = (x, y) => {
        const [dx, dy] = [x - circle.x, y - circle.y];
        const riders = cards.filter((card) => inside(card, circle));
        fitCircle(circle, x, y, circle.r);
        for (const card of riders) moveCard(card, card.x + dx, card.y + dy);
      };
      const name = circle.el.querySelector(".try-name");
      pressable(name, (start) => {
        let last = start;
        return {
          move: (at) => {
            carry(circle.x + at.x - last.x, circle.y + at.y - last.y);
            last = at;
          },
        };
      });
      arrowable(name, (x, y) => carry(circle.x + x * 24, circle.y + y * 24));

      const grip = circle.el.querySelector(".try-grip");
      pressable(grip, (start) => {
        const gap = circle.r - Math.hypot(start.x - circle.x, start.y - circle.y);
        return {
          move: (at) => {
            const wanted = Math.hypot(at.x - circle.x, at.y - circle.y) + gap;
            circle.r = clamp(wanted, MIN_R, longest(circle));
          },
        };
      });
      arrowable(grip, (x, y) => {
        circle.r = clamp(circle.r + (x + y) * 12, MIN_R, longest(circle));
      });
    }
    draw();
  }

  /**
   * The opening, once the map is in view: a pointer clicks Add site, types a name, adds the site, and drags it into
   * Friends. A press or a key of the visitor stops it, and what it was carrying goes back.
   */
  async function hint() {
    const run = ++hintRun;
    const circle = circles.find((each) => each.id === "friends");
    const name = SUGGESTED[0];
    const cursor = document.createElement("div");
    cursor.className = "try-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 2l15 9.5-6.6 1.3 3.9 7.3-2.9 1.5-3.9-7.3L4 19z" fill="#19191b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    root.append(cursor);
    let card = null;
    let home = null;
    stopHint = () => {
      stopHint = () => {};
      hintRun += 1;
      cursor.remove();
      closeForm();
      addButton.classList.remove("down");
      formAdd.classList.remove("down");
      if (card && home) {
        Object.assign(card, home);
        card.el.classList.remove("held");
        held = null;
        draw();
      }
    };
    const live = () => run === hintRun;
    const pause = async (ms) => {
      await wait(ms);
      return live();
    };
    const centre = (el) => {
      const [box, frame] = [el.getBoundingClientRect(), root.getBoundingClientRect()];
      return { x: box.left - frame.left + box.width / 2, y: box.top - frame.top + box.height / 2 };
    };
    let at = { x: root.clientWidth - 20, y: root.clientHeight - 20 };
    /** Moves the pointer, in pixels of the frame, and answers false once the visitor took over. */
    const glide = (to, ms, step) =>
      new Promise((done) => {
        const from = at;
        const began = performance.now();
        const frame = (now) => {
          if (!live()) return done(false);
          const t = Math.min(1, (now - began) / ms);
          const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
          at = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
          cursor.style.transform = `translate(${at.x}px, ${at.y}px)`;
          step?.();
          if (t < 1) requestAnimationFrame(frame);
          else done(true);
        };
        requestAnimationFrame(frame);
      });
    const click = async (el) => {
      el.classList.add("down");
      if (!(await pause(160))) return false;
      el.classList.remove("down");
      return true;
    };

    cursor.classList.add("on");
    if (!(await glide(centre(addButton), 800))) return;
    if (!(await click(addButton))) return;
    form.hidden = false;
    if (!(await pause(260))) return;
    for (let typed = 1; typed <= name.length; typed += 1) {
      input.value = name.slice(0, typed);
      if (!(await pause(60))) return;
    }
    if (!(await glide(centre(formAdd), 420))) return;
    if (!(await click(formAdd))) return;
    closeForm();
    card = createSite(name);
    if (!(await pause(1300))) return;

    const before = save();
    home = { x: card.x, y: card.y };
    if (!(await glide({ x: card.x * scale, y: card.y * scale }, 600))) return;
    held = card;
    card.el.classList.add("held");
    const to = { x: circle.x * scale, y: (circle.y + 20) * scale };
    const carried = await glide(to, 1300, () => {
      card.x = at.x / scale;
      card.y = at.y / scale;
      draw();
    });
    if (!carried) return;
    home = null;
    stopHint();
    held = null;
    card.el.classList.remove("held");
    draw();
    tell(before);
  }

  const fit = () => {
    if (!touched && innerWidth < TALL_BELOW !== (plan === TALL)) build();
    scale = root.clientWidth / plan.w;
    stage.style.transform = `scale(${scale})`;
  };

  build();
  fit();
  new ResizeObserver(fit).observe(root);

  if (!still) {
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        seen.disconnect();
        setTimeout(() => {
          if (!touched) void hint();
        }, 900);
      },
      { threshold: 0.6 },
    );
    seen.observe(root);
  }
})();
