// K-2003: the connect page of a port card, `pages.<zone>/connect/<name>`. The Worker serves it after the share check.
import type { Door } from "../core/port.ts";
import { escapeHtml } from "../core/html.ts";

export interface ConnectView {
  readonly portCard: {
    readonly name: string;
    readonly address: string;
    readonly ports: ReadonlyArray<string>;
    readonly doorHours: number;
    readonly reachable: boolean;
    readonly machineOnline: boolean;
    /** K-2004: a relayed card listens on IPv4 only, so its doors need an IPv4 address. */
    readonly needsIpv4: boolean;
  };
  /** K-2004: the card has an active share in Everyone, so its ports are open to every address and it has no doors. */
  readonly openToAll: boolean;
  readonly doors: ReadonlyArray<Door>;
  readonly seen: string | null;
  readonly error: string | null;
}

/**
 * K-2003: the browser asks each of these for its public address; all answer cross-origin (checked 2026-10-29). Two
 * IPv4 services on different networks, because a home network can leave through another address per destination.
 */
export const ADDRESS_PROBES = [
  "https://ipv4.icanhazip.com",
  "https://api.ipify.org",
  "https://ipv6.icanhazip.com",
] as const;

export function connectHeaders(nonce: string) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      `connect-src 'self' ${ADDRESS_PROBES.join(" ")}`,
      "frame-ancestors 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; "),
  };
}

export function connectPage(view: ConnectView, email: string, nonce: string): string {
  const { portCard } = view;
  // `<` cannot end the script element from inside the JSON.
  const data = JSON.stringify({ ...view, probes: ADDRESS_PROBES }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${escapeHtml(portCard.name)}</title>
<style>
:root { color-scheme: light dark; --ink: #111; --paper: #fffdf6; --accent: #7c3aed; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f3ea; --paper: #17161c; } }
body { font: 16px/1.5 system-ui, sans-serif; background: var(--paper); color: var(--ink); margin: 0; padding: 24px; }
main { max-width: 560px; margin: 0 auto; }
h1 { font-size: 28px; margin: 0 0 4px; }
section { border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); padding: 16px; margin: 16px 0; }
button { font: inherit; font-weight: 700; border: 2px solid var(--ink); background: #facc15; color: #111; padding: 8px 14px; cursor: pointer; box-shadow: 3px 3px 0 var(--ink); }
button.quiet { background: transparent; color: var(--ink); box-shadow: none; padding: 4px 10px; }
button:disabled { opacity: .5; cursor: default; }
code { font-size: 18px; font-weight: 700; }
.note { opacity: .75; font-size: 14px; }
.error { color: #dc2626; font-weight: 700; }
li { margin: 6px 0; }
</style></head>
<body><main>
<h1>${escapeHtml(portCard.name)}</h1>
${
  view.openToAll
    ? `<section><div>Open to everyone: join</div><p><code>${escapeHtml(portCard.address)}</code></p>
<div class="note">Ports: ${escapeHtml(portCard.ports.join(", "))}${portCard.reachable ? "" : ". The port card has no public address yet, so it is not reachable."}</div></section>
<p class="note">Anyone who knows the address can reach the portCard. Keep the portCard's own whitelist on if you want to choose the players.</p>
</main></body></html>`
    : `<p class="note">Logged in as ${escapeHtml(email)}</p>
<section id="connect"><div>Connect to</div><p><code id="address"></code> <button class="quiet" id="copy">Copy</button></p>
<div class="note" id="ports"></div></section>
<section id="open"><div><strong>Open the door for your addresses</strong></div><ul id="addresses"><li>Looking for your addresses…</li></ul>
<p class="note" id="probe-note"></p><button id="open-button" disabled>Open</button> <span class="error" id="error"></span></section>
<section id="doors-section"><div><strong>Your open doors</strong></div><ul id="doors"></ul><button class="quiet" id="end" hidden>End now</button></section>
<p class="note">While a door is open, everyone who shares your internet address can reach the portCard. Keep the portCard's own whitelist on.</p>
</main>
<script type="application/json" id="data">${data}</script>
<script nonce="${nonce}">
const data = JSON.parse(document.getElementById("data").textContent);
const $ = (id) => document.getElementById(id);
const item = (text, button) => { const li = document.createElement("li"); li.textContent = text; if (button) { li.append(" "); li.append(button); } return li; };
const family = (address) => (address && address.includes(":") ? "v6" : "v4");
async function probe(url) {
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 8000);
  try { const answer = await fetch(url, { signal: stop.signal, cache: "no-store" }); return answer.ok ? (await answer.text()).trim() : null; }
  catch { return null; }
}
async function send(body) {
  $("error").textContent = "";
  const answer = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await answer.json().catch(() => ({ error: "kitshn sent no answer." }));
  if (!answer.ok || result.error) { $("error").textContent = result.error || "kitshn refused."; return; }
  location.reload();
}
$("address").textContent = data.portCard.address;
$("ports").textContent = "Ports: " + data.portCard.ports.join(", ") + (data.portCard.reachable ? "" : ". The port card has no public address yet, so it is not reachable.");
$("copy").onclick = () => navigator.clipboard.writeText(data.portCard.address);
$("open-button").textContent = "Open for " + data.portCard.doorHours + " h";
if (data.error) $("error").textContent = data.error;
for (const door of data.doors) $("doors").append(item(door.address + ", until " + new Date(door.endsAt).toLocaleString()));
if (data.doors.length === 0) $("doors").append(item("None"));
$("end").hidden = data.doors.length === 0;
$("end").onclick = () => send({ action: "close" });
// K-2004: all lookups at once, 8 s each; the open button waits for them, and "Try again" asks the missing ones again.
async function check() {
  $("open-button").disabled = true;
  $("probe-note").replaceChildren("Checking your addresses…");
  const answers = await Promise.all(data.probes.map(probe));
  const addresses = [...new Set([data.seen, ...answers].filter(Boolean))];
  $("addresses").replaceChildren(...addresses.map((address) => item(address + (address === data.seen ? " (kitshn sees this one)" : ""))));
  const missing = ["v4", "v6"].filter((name) => !addresses.some((address) => family(address) === name)).map((name) => (name === "v4" ? "IPv4" : "IPv6"));
  const again = document.createElement("button");
  again.className = "quiet"; again.textContent = "Try again"; again.onclick = () => void check();
  const noIpv4 = data.portCard.needsIpv4 && missing.includes("IPv4");
  if (noIpv4) $("probe-note").replaceChildren("This server needs IPv4, and no IPv4 address answered. ", again);
  else if (missing.length > 0) $("probe-note").replaceChildren("No " + missing.join(" or ") + " address answered, so kitshn opens only the address" + (addresses.length > 1 ? "es" : "") + " above. ", again);
  else $("probe-note").replaceChildren();
  $("open-button").disabled = addresses.length === 0 || noIpv4;
  $("open-button").onclick = () => send({ action: "open", addresses });
}
void check();
</script></body></html>`
}`;
}
