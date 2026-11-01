/** K-1907: the rules of Web Push for notifications, pure so the UI and the tests share them. */
import type { ProposalAction } from "./asks.ts";
import type { Notification, NotificationLevel } from "./notifications.ts";

/** Quiet hours: minutes after midnight in the browser's time zone; `start` after `end` runs over midnight. */
export interface QuietHours {
  readonly start: number;
  readonly end: number;
  readonly timeZone: string;
}

/** One subscribed browser as the map lists it; the endpoint and keys never leave the Durable Object. */
export interface PushDevice {
  readonly id: number;
  readonly label: string;
  readonly email: string;
  readonly levels: ReadonlyArray<NotificationLevel>;
  readonly quiet: QuietHours | null;
  readonly createdAt: number;
  /** The time of the last push that the push service took, or null before the first. */
  readonly lastOkAt: number | null;
}

export const DEFAULT_LEVELS: ReadonlyArray<NotificationLevel> = ["warn", "error"];
/**
 * K-1907, K-406: pushes that one invocation sends at most. An alarm run spends up to 40 calls already, and the free
 * plan allows 50 subrequests, so 5 keep 5 spare; the rest wait for the next alarm.
 */
export const PUSH_SENDS_PER_RUN = 5;
/**
 * K-1722: the asks whose shown text is a fixed sentence around one target, such as "deploy riffle (redeploy)", so
 * the sentence holds their whole meaning. Every other ask is free text, such as a command or the edits of a move.
 */
export const PUSH_FIXED_ACTIONS: ReadonlySet<ProposalAction> = new Set([
  "deploy",
  "publish",
  "allow",
  "backup",
]);
/** K-1722: the longest fixed sentence that a push offers Approve for, as its title. */
export const PUSH_FIXED_MAX = 40;
/** K-1722: the longest free text that a push offers Approve for, as its title. A heads-up banner shows one line. */
export const PUSH_FREE_MAX = 32;

/**
 * K-1722: whether the push shows the whole text that Approve hashes, so the approver sees all that runs. A heads-up
 * banner shows the title and about one line of the body, so the push shows the text as its title, and offers Approve
 * only for a fixed sentence of at most PUSH_FIXED_MAX characters or free text of at most PUSH_FREE_MAX. Both are one
 * line of printable ASCII with no run of spaces. Any other character, such as a tab, a control or a bidi character,
 * could hide a part. Everything else gets Deny only, and a tap opens the ask.
 */
export function approvesOnPush(action: ProposalAction, shown: string): boolean {
  const max = PUSH_FIXED_ACTIONS.has(action) ? PUSH_FIXED_MAX : PUSH_FREE_MAX;
  if (shown.length === 0 || shown.length > max) return false;
  if (shown.includes("  ") || shown.startsWith(" ") || shown.endsWith(" ")) return false;
  for (let index = 0; index < shown.length; index++) {
    const code = shown.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** K-1907: "Send a test" runs at most once in this time. */
export const PUSH_TEST_MS = 60_000;

/** The minutes after midnight of `now` in `timeZone`. A time zone that Intl does not know fails (K-006). */
export function minutesIn(timeZone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(now))
    .reduce<Record<string, string>>((all, part) => ({ ...all, [part.type]: part.value }), {});
  return Number(parts["hour"]) * 60 + Number(parts["minute"]);
}

export function isQuiet(quiet: QuietHours | null, now: number): boolean {
  if (quiet === null || quiet.start === quiet.end) return false;
  const minute = minutesIn(quiet.timeZone, now);
  return quiet.start < quiet.end
    ? minute >= quiet.start && minute < quiet.end
    : minute >= quiet.start || minute < quiet.end;
}

/** K-1907: a device gets a notification of a level it chose; in quiet hours only "error" and priority high. */
export function deviceWants(
  device: Pick<PushDevice, "levels" | "quiet">,
  notification: Notification,
  now: number,
) {
  if (notification.priority !== "high" && !device.levels.includes(notification.level)) return false;
  const urgent = notification.level === "error" || notification.priority === "high";
  return urgent || !isQuiet(device.quiet, now);
}

/**
 * K-1907: what the push service carries, encrypted: never an address, a reason text or a secret. The service worker
 * reads the text of an ask over the browser's own login, and runs the actions with it.
 */
export function pushMessage(notification: Notification, cardName: string | null) {
  const ask = notification.source === "kitshn.ask";
  return {
    // K-1908: an app writes its own title, so its push shows only that the card has news; the map shows the rest.
    title: notification.source === "app" ? `${cardName ?? "An app"} has news` : notification.title,
    body: ask
      ? "An agent waits for your answer."
      : cardName === null
        ? notification.source
        : `${notification.source} · ${cardName}`,
    id: notification.id,
    tag: `${notification.source}:${notification.key}`,
    path: "/#notifications",
    /** "open", or the answer that closed it, such as "approved" (K-1722). */
    state: notification.state,
    /** K-1722: the proposal id of an ask; its Approve and Deny come from the ask that the service worker reads. */
    ask: ask ? notification.key : null,
    /** K-1903: the run actions, such as Allow and Block of a repo. Android shows at most 2. */
    actions: ask
      ? []
      : notification.actions.flatMap((action) =>
          action.kind === "run" ? [{ id: action.id, label: action.label }] : [],
        ),
  };
}
