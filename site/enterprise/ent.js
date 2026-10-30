// kitshn for enterprise: answers "who gets in" for the two circles of the Access section, plays an ask of an agent,
// and runs a small copy of the emergency pause. Plain script, no build, like the rest of the site. Without it, each
// part shows its first state.

// Access: Engineering asks for every rule (K-203) and a passkey (K-103); Contractors lets in one email until its end
// date (K-209). Access lets a visitor in when one circle that holds the card matches (K-207).
const gate = document.getElementById("gate");
if (gate) {
  const EMAIL = { dana: "dana@acme.com", lee: "lee@studio.io", sam: "sam@gmail.com" };
  const verdict = gate.querySelector(".gate-verdict");
  const why = gate.querySelector(".gate-why");
  const eng = gate.querySelector(".gate-circle.eng");
  const con = gate.querySelector(".gate-circle.con");
  const pick = (name) => gate.querySelector(`input[name="${name}"]:checked`).value;
  const line = (ok, text) => {
    const li = document.createElement("li");
    li.className = ok ? "ok" : "no";
    li.textContent = text;
    return li;
  };

  const answer = () => {
    const who = pick("who");
    const office = pick("net") === "office";
    const passkey = pick("key") === "yes";
    const ended = pick("day") === "later";
    const email = EMAIL[who];

    const missing = [];
    if (who !== "dana") missing.push(`${email} is not @acme.com`);
    if (!office) missing.push("not on the office network");
    if (!passkey) missing.push("no passkey");
    const engOk = missing.length === 0;
    const conOk = who === "lee" && !ended;

    why.replaceChildren(
      line(
        engOk,
        engOk
          ? "Engineering: @acme.com, the office network and a passkey all match"
          : `Engineering needs all of its rules: ${missing.join(", ")}`,
      ),
      line(
        conOk,
        who !== "lee"
          ? `Contractors: ${email} is not a member`
          : ended
            ? "Contractors: the share ended on November 30, so kitshn took the card out and ended the sessions"
            : "Contractors: lee@studio.io is a member until November 30",
      ),
    );

    const yes = engOk || conOk;
    verdict.textContent = yes ? "Let in, at view" : "Access says no";
    verdict.classList.toggle("yes", yes);
    verdict.classList.toggle("no", !yes);
    verdict.classList.remove("pop");
    void verdict.offsetWidth;
    verdict.classList.add("pop");
    eng.classList.toggle("hit", engOk);
    con.classList.toggle("hit", conOk);
    con.classList.toggle("ended", ended);
  };

  gate.addEventListener("change", answer);
  answer();
}

// AI agents: one ask in the Inbox. Approve needs a passkey (K-1723); Deny needs no proof, because it lowers access.
const ask = document.getElementById("ask");
if (ask) {
  const state = ask.querySelector(".ask-top .sticker");
  const result = ask.querySelector(".ask-result");
  const TEXT = {
    approve:
      "✓ dana@acme.com approved with a passkey. kitshn ran the deploy and sent build-01 the result. History names the thread “Invoice rounding”.",
    deny: "✕ dana@acme.com denied it. The agent hears “denied” with the proposal id, and nothing runs.",
  };
  const reset = () => {
    ask.classList.remove("done");
    result.hidden = true;
    state.className = "sticker wait";
    state.textContent = "waiting";
  };
  ask.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ask]");
    if (!button) return;
    const kind = button.dataset.ask;
    if (kind === "again") return reset();
    ask.classList.add("done");
    state.className = kind === "approve" ? "sticker ok" : "sticker";
    state.textContent = kind === "approve" ? "approved" : "denied";
    result.className = `ask-result ${kind === "approve" ? "ok" : "no"}`;
    result.textContent = TEXT[kind] + " ";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn";
    again.dataset.ask = "again";
    again.textContent = "Ask again";
    result.append(again);
    result.hidden = false;
  });
}

// Operate: the big red button (K-1504). Lift the lid, press once: every share closes but the admin, and public ones
// stay open unless it is a lockdown. Only Resume, with a fresh passkey, opens them again.
const pause = document.getElementById("pause");
if (pause) {
  const lid = pause.querySelector(".pause-lid");
  const cap = pause.querySelector(".pause-cap");
  const lockdown = pause.querySelector("#pause-lockdown");
  const resume = pause.querySelector(".pause-resume");
  const note = pause.querySelector(".pause-note");
  const stamp = pause.querySelector(".pause-stamp");
  const rows = [...pause.querySelectorAll(".pause-list li")];
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let paused = null;

  const setLid = (open) => {
    lid.setAttribute("aria-expanded", String(open));
    cap.disabled = !open && !paused;
  };

  const show = () => {
    const locked = Boolean(paused?.lockdown);
    for (const row of rows) {
      let state = "open";
      let label = "open";
      if (row.dataset.paused === "wait") {
        state = paused ? "wait" : "open";
        label = paused ? "wait" : "run";
      } else if (row.dataset.paused === "revoked") {
        state = paused ? "revoked" : "open";
        label = paused ? "revoked" : "live";
      } else if (row.dataset.stays === "always") {
        label = paused ? "owner keeps" : "open";
      } else if (paused && (row.dataset.stays !== "public" || locked)) {
        state = "closed";
        label = "closed";
      }
      row.dataset.state = state;
      row.querySelector("em").textContent = label;
    }
    pause.classList.toggle("is-paused", Boolean(paused));
    stamp.textContent = locked ? "lockdown" : "paused";
    resume.hidden = !paused;
    lockdown.disabled = locked;
    if (!paused) note.textContent = "Nothing is paused.";
    else
      note.textContent = `Paused by you at ${paused.at}. ${
        locked ? "Lockdown: public sites are closed too." : "Public sites stay open."
      }`;
  };

  lid.addEventListener("click", () => setLid(lid.getAttribute("aria-expanded") !== "true"));
  cap.addEventListener("click", () => {
    setLid(false);
    if (paused) {
      note.textContent = "Already paused.";
      return;
    }
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    paused = { at, lockdown: lockdown.checked };
    show();
    if (!still.matches) {
      pause.classList.remove("shake");
      void pause.offsetWidth;
      pause.classList.add("shake");
    }
  });
  lockdown.addEventListener("change", () => {
    if (paused && lockdown.checked) {
      paused.lockdown = true;
      show();
    }
  });
  resume.addEventListener("click", () => {
    paused = null;
    lockdown.checked = false;
    setLid(false);
    show();
    note.textContent = "Passkey ✓. Every share is back.";
  });
  show();
}

const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
document.querySelectorAll(".reveal").forEach((el) => reveal.observe(el));
