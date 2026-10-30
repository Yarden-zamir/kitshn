// K-723: the scenarios for a provider under test (`--provider <command>`). The command starts the provider with the
// daemon's environment, so its `kitshn provider` bridge finds this daemon; the fake edge sees what it registers.
import type { DaemonMessage } from "@kitshn/edge/machine";
import { type ChildProcess, spawn } from "node:child_process";
import type { Daemon } from "./daemon.ts";
import { GRACE_MS } from "./daemon.ts";
import { lineClient } from "./client.ts";
import type { Scenario } from "./scenarios.ts";
import { waitFor } from "./wait.ts";

const online = (message: DaemonMessage): message is Extract<DaemonMessage, { type: "providers" }> =>
  message.type === "providers" && message.providers.some((item) => item.online);
const offline = (message: DaemonMessage): message is Extract<DaemonMessage, { type: "providers" }> =>
  message.type === "providers" &&
  message.providers.length > 0 &&
  message.providers.every((item) => !item.online);

/** Starts the provider by its own PID and stops it with the scenario. */
async function withProvider(daemon: Daemon, command: string, steps: () => Promise<void>) {
  const child: ChildProcess = spawn("/bin/sh", ["-c", command], {
    env: { ...process.env, ...daemon.env },
    stdio: "inherit",
  });
  try {
    await steps();
  } finally {
    child.kill("SIGTERM");
  }
}

export const providerScenarios = (command: string): ReadonlyArray<Scenario> => [
  {
    id: "P-1",
    title: "the provider registers with protocol 2 and shows online (C-1)",
    run: (daemon) => withProvider(daemon, command, async () => void (await daemon.edge.next(online, true))),
  },
  {
    id: "P-6",
    title: "after a daemon restart the provider registers again (C-6)",
    run: (daemon) =>
      withProvider(daemon, command, async () => {
        await daemon.edge.next(online, true);
        await daemon.signal("SIGTERM");
        await daemon.start();
        await daemon.edge.next(online);
      }),
  },
  {
    id: "P-7",
    title:
      "the provider drops a stopped daemon after the grace time and registers again after it resumes (C-7)",
    run: (daemon) =>
      withProvider(daemon, command, async () => {
        await daemon.edge.next(online, true);
        await daemon.signal("SIGSTOP");
        // A stopped daemon gives no event to wait for, so this waits on purpose: the rule is a time (the grace).
        await new Promise<void>((done) => setTimeout(done, 2 * GRACE_MS));
        const resumedAt = Date.now();
        await daemon.signal("SIGCONT");
        // The provider closed its connection and registered again, so it is online since the resume.
        await daemon.edge.next(online);
        const client = await lineClient(daemon.socket);
        const answer = await client.request({ type: "status" });
        client.close();
        const since = answer.type === "status" ? answer.status.providers?.[0]?.since : null;
        if (typeof since !== "number" || since < resumedAt)
          throw new Error("the provider kept the connection to a stopped daemon; drop it after graceMs.");
      }),
  },
  {
    id: "P-8",
    title: "the provider answers pings, so it stays online for three grace times (C-8)",
    run: (daemon) =>
      withProvider(daemon, command, async () => {
        await daemon.edge.next(online, true);
        // The one wait for an absence: a provider that misses pings shows offline within one grace time.
        const dropped = await waitFor<boolean>(
          (done) => (void daemon.edge.next(offline).then(() => done(true)), () => {}),
          "offline",
          3 * GRACE_MS,
        ).catch(() => false);
        if (dropped) throw new Error("the provider went offline: it does not answer the daemon's pings.");
      }),
  },
];
