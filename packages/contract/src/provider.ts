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

/** How long a provider may take to end after TERM, and how long the kernel may take after KILL. */
const TERM_MS = 3_000;
const KILL_MS = 2_000;

/** Whether any process of the group is left. A zombie counts until its parent reaps it. */
const groupAlive = (group: number) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Waits until the group is gone, or `ms` passed. Known limit: this polls, because the kernel has no event for the end
 * of a group of other processes, and a pipe would miss children that the provider spawned with only its own stdio.
 */
async function groupGone(group: number, ms: number) {
  const until = Date.now() + ms;
  while (groupAlive(group) && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  return !groupAlive(group);
}

/**
 * Ends the whole group of the provider, so nothing of it still writes into the daemon's home when the home goes.
 * Known limit: a process that starts its own session leaves the group; the provider must end those itself.
 */
async function endProvider(group: number) {
  if (!groupAlive(group)) return;
  process.kill(-group, "SIGTERM");
  if (await groupGone(group, TERM_MS)) return;
  console.error(`the provider still runs ${TERM_MS} ms after TERM, so it gets KILL.`);
  process.kill(-group, "SIGKILL");
  // On a runner with no init that reaps, a killed orphan stays a zombie, which writes nothing.
  await groupGone(group, KILL_MS);
}

/** Starts the provider in a process group of its own, and ends that group with the scenario. */
async function withProvider(daemon: Daemon, command: string, steps: () => Promise<void>) {
  const child: ChildProcess = spawn("/bin/sh", ["-c", command], {
    env: { ...process.env, ...daemon.env },
    stdio: "inherit",
    detached: true,
  });
  try {
    await steps();
  } finally {
    if (child.pid) await endProvider(child.pid);
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
