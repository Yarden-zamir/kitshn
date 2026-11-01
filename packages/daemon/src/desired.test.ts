import { expect, it } from "vitest";
import { desiredProblem, readRequest } from "@kitshn/local";
import { forwardDesired, providerReports } from "./desired.ts";

it("forwards conditional initialization with its own type and the authoritative answer (K-709)", async () => {
  for (const initialized of [true, false]) {
    const decoded = readRequest(
      JSON.stringify({
        id: "d",
        type: "desired-init",
        provider: "test",
        kind: "test.settings",
        part: "machine",
        value: {},
      }),
    );
    if (!decoded.ok || decoded.request.type !== "desired-init")
      throw new Error("schema refused initialization");
    const answer = await forwardDesired(
      decoded.request,
      () => {},
      async (message) => {
        expect(message).toEqual({
          type: "desiredInit",
          provider: "test",
          kind: "test.settings",
          part: "machine",
          value: {},
        });
        return { error: null, initialized };
      },
    );
    expect(answer).toEqual({ id: "d", type: "desired-init", initialized });
  }
});

it("never treats a missing or refused initialization answer as success (K-709)", async () => {
  const request = {
    id: "d",
    type: "desired-init",
    provider: "test",
    kind: "test.settings",
    part: "shared",
    value: {},
  } as const;
  await expect(
    forwardDesired(
      request,
      () => {},
      async () => ({ error: null }),
    ),
  ).rejects.toThrow(/did not confirm/);
  await expect(
    forwardDesired(
      request,
      () => {},
      async () => ({ error: "old Worker did not answer" }),
    ),
  ).rejects.toThrow(/old Worker/);
});

it("sends a waiting provider report before a desired request, so kitshn knows a kind of a new register (K-709)", async () => {
  for (const type of ["desired-init", "desired-set"] as const) {
    const kind = { id: "test.settings", name: "Settings", levels: {}, state: {} };
    // kitshn knows the kinds of a provider only from the last report that reached it.
    let known: Array<typeof kind> = [];
    const reports = providerReports(() => {
      known = [kind];
    }, 60_000);
    // A register schedules the report with its new kind.
    reports.schedule();
    const answer = await forwardDesired(
      { id: "d", type, provider: "test", kind: kind.id, part: "machine", value: {} },
      reports.flush,
      async (message) => ({
        error: desiredProblem(known, message.kind, message.value),
        ...(message.type === "desiredInit" ? { initialized: true } : {}),
      }),
    );
    expect(answer).toMatchObject({ id: "d", type });
  }
});
