import { describe, expect, it } from "vitest";
import type { Notification } from "./notifications.ts";
import { deviceWants, isQuiet, pushMessage } from "./push.ts";

const notification: Notification = {
  id: 7,
  source: "uptime",
  key: "riffle",
  episode: "1",
  card: "riffle",
  recipients: { _tag: "owner" },
  level: "warn",
  priority: "normal",
  title: "riffle is down",
  text: "kitshn gets no good answer from riffle.example.com.",
  actions: [],
  state: "open",
  openedAt: 0,
  closedAt: null,
  snoozedUntil: null,
};
// 2026-10-28 23:30 in Jerusalem (UTC+2).
const night = Date.parse("2026-10-28T21:30:00Z");
const quiet = { start: 22 * 60, end: 7 * 60, timeZone: "Asia/Jerusalem" };

describe("Web Push (K-1907)", () => {
  it("keeps quiet hours in the time zone of the device, also over midnight", () => {
    expect(isQuiet(quiet, night)).toBe(true);
    expect(isQuiet(quiet, Date.parse("2026-10-28T10:00:00Z"))).toBe(false);
    expect(
      isQuiet({ start: 9 * 60, end: 17 * 60, timeZone: "UTC" }, Date.parse("2026-10-28T10:00:00Z")),
    ).toBe(true);
    expect(isQuiet(null, night)).toBe(false);
  });

  it("lets only error and priority high through quiet hours, and never a level the device left out", () => {
    const device = { levels: ["warn", "error"] as const, quiet };
    expect(deviceWants(device, notification, night)).toBe(false);
    expect(deviceWants(device, { ...notification, level: "error" }, night)).toBe(true);
    expect(deviceWants(device, { ...notification, priority: "high" }, night)).toBe(true);
    expect(deviceWants({ levels: ["error"], quiet: null }, notification, night)).toBe(false);
    expect(
      deviceWants({ levels: ["error"], quiet: null }, { ...notification, priority: "high" }, night),
    ).toBe(true);
  });

  it("carries no address or reason text to the push service", () => {
    const message = JSON.stringify(pushMessage(notification, "riffle"));
    expect(message).not.toContain("example.com");
    expect(message).not.toContain(notification.text);
    expect(pushMessage(notification, "riffle")).toMatchObject({
      title: "riffle is down",
      body: "uptime · riffle",
    });
    // K-1908: an app writes its own title, so its push names only the card.
    expect(pushMessage({ ...notification, source: "app", title: "Secret plan" }, "riffle")).toMatchObject({
      title: "riffle has news",
      body: "app · riffle",
    });
    // K-1722: an ask carries its proposal id and its state; the command and the reason stay out of the push.
    const ask = pushMessage(
      {
        ...notification,
        source: "kitshn.ask",
        key: "p1",
        card: null,
        title: "vps asks: runs",
        text: "Run on vps: cat .env · token=abc",
        state: "approved",
        actions: [
          { id: "approve", label: "Approve", kind: "link", path: "/api/approve/login/start?approve=p1" },
          { id: "deny", label: "Deny", kind: "run" },
        ],
      },
      null,
    );
    expect(ask).toMatchObject({ ask: "p1", state: "approved", actions: [] });
    expect(JSON.stringify(ask)).not.toContain("token=abc");
    // K-1903: a run action goes with its id, so the push can run it; a link action stays in the map.
    expect(
      pushMessage(
        {
          ...notification,
          source: "repo",
          actions: [
            { id: "allow", label: "Allow", kind: "run" },
            { id: "show", label: "Show", kind: "link", path: "#map/x" },
          ],
        },
        null,
      ).actions,
    ).toEqual([{ id: "allow", label: "Allow" }]);
  });
});
