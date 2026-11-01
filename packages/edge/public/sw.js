// K-1606, K-1907: the service worker of the kitshn map. It shows Web Push notifications, runs their buttons and
// opens the map on a click. It caches nothing: the map sits behind Access, and a cache could show a stale map.
//
// K-1722: a push carries ids only. For an ask, this worker reads its text over the browser's own Access login and
// shows it with Deny, and with Approve only when the body shows the whole text that the hash covers. When the browser
// has no approve login of the right kind (a passkey check older than 10 minutes, for example), Access answers with a
// redirect, and Approve opens the passkey or login check in a window instead.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const ICON = { icon: "/icon-192.png", badge: "/favicon-32.png" };
/** The text of a notification that an answer closed. */
const OUTCOME = {
  approved: "Approved.",
  denied: "Denied.",
  expired: "Expired: nobody answered in 24 hours.",
  closed: "Closed.",
};

/**
 * One call to kitshn with the browser's own login. A redirect means that Access wants a login first: `login` is true
 * then. A network failure or a slow answer gives `ok: false` with a reason.
 */
async function call(path, init) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "manual",
      signal: abort.signal,
    });
    if (response.type === "opaqueredirect" || response.status === 401)
      return { ok: false, login: true, error: "kitshn needs a login first." };
    const data = await response.json().catch(() => null);
    if (!response.ok || data === null)
      return {
        ok: false,
        login: false,
        status: response.status,
        error: (data && data.error) || `kitshn answered ${response.status}.`,
      };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, login: false, error: `kitshn is not reachable: ${String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

const post = (path, body) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Shows the same notification again with new text and no buttons, quietly. A click opens `path`. */
const settle = (notification, body, path) =>
  self.registration.showNotification(notification.title, {
    ...ICON,
    body,
    tag: notification.tag,
    silent: true,
    data: { path, shownAt: Date.now() },
  });

async function showPush(message) {
  // `shownAt` lets the map tell a push from before its list read from a newer one (K-1905).
  const base = {
    ...ICON,
    tag: message.tag,
    data: { path: message.path, id: message.id, shownAt: Date.now() },
  };
  // K-1722: a high priority notification also tells its answer, so every device shows how the ask ended.
  if (message.state && message.state !== "open")
    return self.registration.showNotification(message.title, {
      ...base,
      body: OUTCOME[message.state] || OUTCOME.closed,
      silent: true,
    });
  if (message.ask) {
    const read = await call(`/api/notifications/${message.id}`, { method: "GET" });
    const ask = read.ok ? read.data.ask : null;
    if (!ask)
      return self.registration.showNotification(message.title, {
        ...base,
        body: read.ok ? OUTCOME.closed : "Open kitshn to read and answer this ask.",
      });
    const expires = new Date(ask.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // K-1722: a heads-up banner shows the title and about one line, so an ask with Approve shows its whole text as the
    // title. Approve only where the server says that the text fits (`approvesOnPush`); else a tap opens the ask.
    const whole = ask.approveOnPush === true;
    return self.registration.showNotification(whole ? ask.text : message.title, {
      ...base,
      body: [
        whole ? message.title : ask.text,
        ask.reason ? `Why: ${ask.reason}` : null,
        whole ? `Expires at ${expires}.` : "Open the ask to read all of it and approve.",
      ]
        .filter(Boolean)
        .join("\n"),
      requireInteraction: true,
      actions: [
        ...(whole
          ? [{ action: "approve", title: ask.via === "passkey" ? "Approve (passkey)" : "Approve" }]
          : []),
        { action: "deny", title: "Deny" },
      ],
      data: { ...base.data, ask: { id: ask.id, hash: ask.shownHash, via: ask.via } },
    });
  }
  // K-1905: Dismiss closes it for everyone, where the run actions leave room (Android shows 2 buttons).
  const actions = [
    ...(message.actions || []).map((each) => ({ action: each.id, title: each.label })),
    { action: "dismiss", title: "Dismiss" },
  ];
  return self.registration.showNotification(message.title, {
    ...base,
    body: message.body,
    actions: actions.slice(0, 2),
  });
}

self.addEventListener("push", (event) => {
  const message = event.data
    ? event.data.json()
    : { title: "kitshn", body: "", tag: "kitshn", path: "/#notifications" };
  event.waitUntil(showPush(message));
});

/** Only a path of this origin; anything else opens the Notifications view. */
function sameOrigin(path) {
  const asked = new URL(path || "/#notifications", self.location.origin);
  return asked.origin === self.location.origin
    ? asked.href
    : new URL("/#notifications", self.location.origin).href;
}

async function openPath(path) {
  const href = sameOrigin(path);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
  if (open) return open.navigate(href).then((each) => (each || open).focus());
  return self.clients.openWindow(href);
}

/** K-1722: Approve with the hash of the text that the notification showed; without a login, the check opens. */
async function approve(notification, ask) {
  const answer = await post(`/api/approve/${ask.via}/${encodeURIComponent(ask.id)}`, { hash: ask.hash });
  if (answer.ok) return settle(notification, OUTCOME.approved, "/#notifications");
  if (!answer.login)
    return settle(notification, `Not approved: ${answer.error} Tap to open the ask.`, "/#notifications");
  const check = `/api/approve/${ask.via}/start?approve=${encodeURIComponent(ask.id)}&hash=${ask.hash}`;
  const opened = await openPath(check).catch(() => null);
  if (!opened)
    return settle(
      notification,
      `Tap to approve with your ${ask.via === "passkey" ? "passkey" : "login"}.`,
      check,
    );
}

/** K-1903, K-1905: a run action of the notification, such as Deny of an ask or Allow of a repo, or Dismiss. */
async function run(notification, action) {
  const id = notification.data && notification.data.id;
  const answer = await post(
    action === "dismiss"
      ? `/api/notifications/${id}/dismiss`
      : `/api/notifications/${id}/actions/${encodeURIComponent(action)}`,
    {},
  );
  // A notification that closed already (a stale push, K-1905) answers 404: dismissed is what the person wanted.
  if (action === "dismiss" && (answer.ok || answer.status === 404)) return;
  const label = action.charAt(0).toUpperCase() + action.slice(1);
  if (answer.ok) return settle(notification, `${label}: done.`, "/#notifications");
  if (answer.login) return openPath("/#notifications");
  return settle(notification, `${label} failed: ${answer.error} Tap to open kitshn.`, "/#notifications");
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  notification.close();
  if (event.action === "approve" && data.ask) return event.waitUntil(approve(notification, data.ask));
  if (event.action) return event.waitUntil(run(notification, event.action));
  event.waitUntil(openPath(data.path));
});
