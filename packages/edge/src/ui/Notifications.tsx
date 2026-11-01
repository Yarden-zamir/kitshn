import { useEffect, useState } from "preact/hooks";
import type { State } from "../core/model.ts";
import { type Mute, type Notification, muted } from "../core/notifications.ts";
import { Menu, MenuItem } from "./controls.tsx";
import type { Rect } from "./popover.ts";
import type { ProposalView } from "../core/protocol.ts";
import { approveVia } from "../core/asks.ts";
import { AskList } from "./Asks.tsx";
import { PushSection } from "./Push.tsx";
import { callApi } from "./store.ts";
import { untilText } from "./actions.ts";
import { whenText } from "./time.ts";

const HOUR = 60 * 60_000;

/** K-1905: a mute lasts 1 hour, 1 day or until unmute. */
const MUTES = [
  { label: "For 1 hour", ms: HOUR, tip: "for one hour" },
  { label: "For 1 day", ms: 24 * HOUR, tip: "for one day" },
  { label: "Until unmute", ms: null, tip: "until you unmute them" },
] as const;

/** K-1905: the notifications of the last 30 days, with Mute, Snooze, Unmute and the actions of each source. */
export function NotificationsView(props: {
  state: State;
  /** The open count of the snapshot; the list loads again when it changes. */
  bell: number;
  /** K-1607, K-1722: the asks that wait for an approver circle; the snapshot keeps them, so the Inbox is live. */
  proposals: ReadonlyArray<ProposalView>;
  /** K-515: the machine whose "needs you" sticker opened the Inbox, or "" for every ask. */
  machine: string;
  onToast: (text: string, error: boolean) => void;
}) {
  const asks = props.machine
    ? props.proposals.filter((proposal) => proposal.machineId === props.machine)
    : props.proposals;
  const machineName = props.state.machines.get(props.machine)?.name ?? props.machine;
  const [list, setList] = useState<{
    notifications: ReadonlyArray<Notification>;
    mutes: ReadonlyArray<Mute>;
  } | null>(null);
  const [version, setVersion] = useState(0);
  /** The open Mute menu: its notification and the button it hangs from. */
  const [muting, setMuting] = useState<{ readonly notification: Notification; readonly anchor: Rect } | null>(
    null,
  );

  useEffect(() => {
    void callApi<{ notifications: Array<Notification>; mutes: Array<Mute> }>(
      "GET",
      "/api/notifications",
    ).then((result) => {
      if ("error" in result) return props.onToast(result.error, true);
      setList(result);
      void closeStalePushes(result.notifications);
    });
  }, [props.bell, version]);

  const post = async (path: string, body: object, done: string) => {
    const result = await callApi<{ ok: true }>("POST", path, body);
    if ("error" in result) props.onToast(result.error, true);
    else {
      props.onToast(done, false);
      setVersion((each) => each + 1);
    }
  };
  const cardName = (id: string | null) => (id === null ? null : (props.state.resources.get(id)?.name ?? id));
  const now = Date.now();

  return (
    <div class="table-view notifications-view">
      <p class="muted">
        What kitshn told you in the last 30 days. Mute and Snooze hide a notification from the bell; they
        never answer it.
      </p>
      {muting ? (
        <Menu label="Mute" anchor={muting.anchor} onClose={() => setMuting(null)}>
          {MUTES.map((mute) => (
            <MenuItem
              key={mute.label}
              tip={`Hide the ${muting.notification.source} notifications of ${cardName(muting.notification.card)} ${mute.tip}.`}
              onSelect={() =>
                void post(
                  "/api/notifications/mute",
                  {
                    card: muting.notification.card,
                    source: muting.notification.source,
                    until: mute.ms === null ? null : now + mute.ms,
                  },
                  `Muted ${muting.notification.source} of ${cardName(muting.notification.card)} ${mute.tip}.`,
                )
              }
            >
              {mute.label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      <h3>Inbox</h3>
      {props.machine ? (
        <p class="muted">
          The asks of {machineName}. <a href="#notifications">Show every ask</a>
        </p>
      ) : null}
      {asks.length === 0 ? <p class="muted">No ask waits for an answer.</p> : null}
      <AskList
        proposals={asks}
        circleName={(id) => props.state.circles.get(id)?.name ?? id}
        via={(proposal) => approveVia(props.state.circles.get(proposal.circleId), proposal.right)}
        onToast={props.onToast}
      />
      <PushSection onToast={props.onToast} />
      <h3>Notifications</h3>
      {list === null ? <p class="muted">Reading the notifications…</p> : null}
      {list && list.notifications.length === 0 ? (
        <p class="muted">No notification in the last 30 days.</p>
      ) : null}
      {list?.notifications.map((notification) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          card={cardName(notification.card)}
          // K-1905: info never counts on the bell, so a hidden row is only a muted or snoozed one.
          shown={
            !muted(notification, list.mutes, now) &&
            !(notification.snoozedUntil !== null && notification.snoozedUntil > now)
          }
          now={now}
          onPost={(path, body, done) => void post(path, body, done)}
          onMute={(anchor) => setMuting({ notification, anchor })}
        />
      ))}
      {list && list.mutes.length > 0 ? (
        <>
          <h3>Muted</h3>
          {list.mutes.map((mute) => (
            <div key={`${mute.card}/${mute.source}`} class="row">
              <span>
                {mute.source} of {cardName(mute.card)}
                {mute.until ? ` ${untilText(mute.until)}` : " until you unmute"}
              </span>
              <button
                class="btn"
                onClick={() =>
                  void post(
                    "/api/notifications/unmute",
                    { card: mute.card, source: mute.source },
                    `Unmuted ${mute.source} of ${cardName(mute.card)}.`,
                  )
                }
              >
                Unmute
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * K-1905, K-1907: a closed notification sends no push, except an ask, so this browser can still show one that closed
 * elsewhere. The open list is the truth: each push of this browser that names no open notification closes.
 */
async function closeStalePushes(notifications: ReadonlyArray<Notification>) {
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (!registration) return;
  const open = new Set(
    notifications.flatMap((each) => (each.state === "open" ? [`${each.source}:${each.key}`] : [])),
  );
  for (const shown of await registration.getNotifications()) if (!open.has(shown.tag)) shown.close();
}

/** K-1905: one notification with its state, its source and card, and its actions. */
export function NotificationRow(props: {
  readonly notification: Notification;
  /** The name of its card, or null when it names none. */
  readonly card: string | null;
  /** False when a mute or a snooze hides it from the bell. */
  readonly shown: boolean;
  readonly now: number;
  readonly onPost: (path: string, body: object, done: string) => void;
  readonly onMute: (anchor: Rect) => void;
}) {
  return (
    <article class={`notification level-${props.notification.level}${props.shown ? "" : " quiet"}`}>
      <div class="notification-head">
        <strong>{props.notification.title}</strong>
        <span
          class={`sticker${props.notification.state === "open" ? (props.notification.level === "error" ? "" : " wait") : " ok"}`}
        >
          {props.notification.state}
        </span>
      </div>
      <p>{props.notification.text}</p>
      <p class="muted">
        {props.notification.source}
        {props.card ? ` · ${props.card}` : ""} · opened {whenText(props.notification.openedAt, props.now)}
        {props.notification.closedAt ? ` · closed ${whenText(props.notification.closedAt, props.now)}` : ""}
        {props.notification.snoozedUntil && props.notification.snoozedUntil > props.now
          ? ` · snoozed ${untilText(props.notification.snoozedUntil, props.now)}`
          : ""}
      </p>
      <div class="row">
        {props.notification.actions.map((action) =>
          action.kind === "link" ? (
            <a key={action.id} class="btn" href={action.path}>
              {action.label}
            </a>
          ) : (
            <button
              key={action.id}
              class="btn"
              onClick={() =>
                props.onPost(
                  `/api/notifications/${props.notification.id}/actions/${action.id}`,
                  {},
                  `${action.label}: done.`,
                )
              }
            >
              {action.label}
            </button>
          ),
        )}
        {props.notification.state === "open" ? (
          props.notification.snoozedUntil !== null && props.notification.snoozedUntil > props.now ? (
            <button
              class="btn"
              data-tip="Show this notification on the bell again now."
              onClick={() =>
                props.onPost(
                  `/api/notifications/${props.notification.id}/snooze`,
                  { until: null },
                  "Unsnoozed.",
                )
              }
            >
              Unsnooze
            </button>
          ) : (
            <button
              class="btn"
              data-tip="Hide this notification from the bell for one hour. It stays open."
              onClick={() =>
                props.onPost(
                  `/api/notifications/${props.notification.id}/snooze`,
                  { until: props.now + HOUR },
                  "Snoozed for 1 hour.",
                )
              }
            >
              Snooze 1 h
            </button>
          )
        ) : null}
        {props.notification.state === "open" ? (
          <button
            class="btn"
            data-tip="Close this notification. The same card and source notify again only when their state changes again."
            onClick={() =>
              props.onPost(`/api/notifications/${props.notification.id}/dismiss`, {}, "Dismissed.")
            }
          >
            Dismiss
          </button>
        ) : null}
        {props.notification.card !== null ? (
          <button
            class="btn"
            aria-haspopup="menu"
            data-tip={`Hide the ${props.notification.source} notifications of ${props.card} for a while.`}
            onClick={(event) => props.onMute(event.currentTarget.getBoundingClientRect())}
          >
            Mute ▾
          </button>
        ) : null}
      </div>
    </article>
  );
}
