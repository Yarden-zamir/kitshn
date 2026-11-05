import type { ProviderRefusal } from "@kitshn/local";
import { type AccessState, type MachineView } from "../core/protocol.ts";
import type { Resource, State } from "../core/model.ts";
import type { Machine } from "../core/machine.ts";
import { machineMember } from "./members.ts";
import { refusalText } from "./refusal.ts";
import { whenText } from "./time.ts";

/** "t3" reads as "T3", "riffle" as "Riffle". */
const providerLabel = (provider: string) =>
  provider.length <= 3 ? provider.toUpperCase() : `${provider[0]?.toUpperCase()}${provider.slice(1)}`;

export interface MachineProblem {
  /** Fits a sticker. */
  readonly short: string;
  /** What is wrong and the next step, for the tip and the panel. */
  readonly long: string;
}

/**
 * K-515: what is wrong on a machine, worst first. A healthy machine has none, so its card shows nothing new. Known
 * limit: a provider that hangs while its bridge stays alive keeps its connection, so it reports nothing (K-704).
 * Revisit if owners meet a hung T3. Offline is the presence sticker's job, but a failed key check is often why the
 * machine is offline (kitshn closes its socket), so that sign shows then too.
 */
export function machineProblems(
  view: MachineView,
  checks: ReadonlyArray<string>,
): ReadonlyArray<MachineProblem> {
  const name = view.machine.name;
  const key = view.keyFailure
    ? [
        {
          short: "key check failed",
          long: `${name} failed its key check ${whenText(view.keyFailure.at)}: ${view.keyFailure.reason}. Reset key in its panel gives it a new one.`,
        },
      ]
    : [];
  if (!view.online) return key;
  const offline = (entry: ProviderRefusal) => ({
    short: `${providerLabel(entry.provider)} lost kitshn`,
    long: `${providerLabel(entry.provider)} on ${name} has no connection to its kitshn daemon since ${whenText(entry.at)}: ${entry.reason}. Its cards do not update. Start ${providerLabel(entry.provider)}, and it registers again by itself.`,
  });
  const refused = (entry: ProviderRefusal) => ({
    short: `kitshn refused ${providerLabel(entry.provider)}`,
    long: `Since ${whenText(entry.at)}: ${refusalText(providerLabel(entry.provider), name, entry.reason)}`,
  });
  return [
    // K-724: kitshn sends this daemon only its update, so its cards and links do not update until the rollout.
    ...(view.protocolRefusal ? [{ short: "protocol refused", long: view.protocolRefusal }] : []),
    ...(view.status?.refusedProviders ?? []).map(refused),
    ...(view.status?.offlineProviders ?? []).map(offline),
    ...(view.status?.tunnel === "stopped"
      ? [
          {
            short: "tunnel stopped",
            long: `The tunnel of ${name} stopped, so its addresses do not answer. Restart its daemon.`,
          },
        ]
      : []),
    ...key,
    ...checks.map((check) => ({
      short: "check red",
      long: `Health check: ${check}. The Machines view shows every check.`,
    })),
  ];
}

const NEW_MACHINE_MS = 7 * 24 * 60 * 60_000;

/** K-633: a machine that joined in the last 7 days. One from before `joinedAt` existed is never new. */
export const isNewMachine = (machine: Machine, now: number) =>
  machine.joinedAt !== undefined && now - machine.joinedAt < NEW_MACHINE_MS;

export interface ChecklistRow {
  readonly label: string;
  readonly done: boolean;
  /** The next step while it is not done. */
  readonly next: string;
}

/**
 * K-633: the steps of a machine, from what kitshn knows now. A row is live, so it can flip back: the machine leaves
 * its last circle, T3 is dropped, or an Access write of the T3 card runs. It keeps its tick while the machine is offline.
 */
export function connectChecklist(
  view: MachineView,
  state: State,
  access: Readonly<Record<string, AccessState>>,
): ReadonlyArray<ChecklistRow> {
  const id = view.machine.id;
  const own = [...state.resources.values()].filter((card) => card.id === id || card.machine === id);
  const hasProvider = (card: Resource) =>
    card.provider?.name === "t3" && card.provider.droppedAt === undefined;
  const t3 = own.filter(hasProvider);
  return [
    {
      label: "Daemon connected",
      done: view.lastSeen !== null,
      next: "Run the join command on the machine.",
    },
    {
      label: "T3 registered",
      done:
        own.some(hasProvider) ||
        (view.status?.offlineProviders ?? []).some((entry) => entry.provider === "t3"),
      next: `Start T3 on ${view.machine.name}. It registers by itself.`,
    },
    {
      // Access having its rule is what kitshn knows. It does not know that the address answers.
      label: "T3 address has its Access rule",
      done: t3.some((card) => card.addresses.length > 0 && access[card.id]?.state === "applied"),
      next: "It follows T3. Take the address in the T3 card's menu if something else serves it.",
    },
    {
      label: "Member of a circle",
      done: [...state.circles.values()].some((circle) => machineMember(circle, id)),
      next: "Drop its card on a circle's title, or use Member of below.",
    },
  ];
}
