// kitshn for enterprise: the policy evaluator, an ask of an agent, and the copy button. Plain script, no build, like the rest of the site. Without it, each part shows its first state.

// Each table cell learns its column's name, for the stacked rows of a phone (ent.css).
for (const table of document.querySelectorAll(".ent-table")) {
  const names = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
  for (const row of table.querySelectorAll("tbody tr")) {
    [...row.children].forEach((cell, i) => (cell.dataset.column = names[i] ?? ""));
  }
}

// The button copies its text, and says so for a moment.
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.textContent;
  let timer = 0;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied ✓";
    } catch {
      button.textContent = "Copy failed. See all install steps";
    }
    clearTimeout(timer);
    timer = setTimeout(() => (button.textContent = label), 2000);
  });
}

// Access: Engineering asks for every rule (K-203) and a passkey (K-103); Contractors lets in one email until its end
// date (K-209). Access lets a visitor in when one circle that holds the card matches (K-207).
const gate = document.getElementById("gate");
if (gate) {
  const verdict = gate.querySelector(".gate-verdict");
  const pick = (name) => gate.querySelector(`input[name="${name}"]:checked`).value;
  const answer = () => {
    const rules = {
      domain: pick("who") === "dana",
      net: pick("net") === "office",
      key: pick("key") === "yes",
      member: pick("who") === "lee",
      date: pick("day") === "now",
    };
    for (const [rule, ok] of Object.entries(rules)) {
      const el = gate.querySelector(`[data-rule="${rule}"]`);
      el.classList.toggle("ok", ok);
      el.classList.toggle("no", !ok);
    }
    let allowed = false;
    for (const lane of gate.querySelectorAll(".lane")) {
      const passes = lane.querySelector(".no") === null;
      lane.classList.toggle("passes", passes);
      allowed ||= passes;
    }
    verdict.textContent = allowed ? "Allow" : "Deny";
    verdict.classList.toggle("yes", allowed);
    verdict.classList.toggle("no", !allowed);
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
