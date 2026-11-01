import { type MachineOs, machineOs } from "./icons.ts";
import type { MachineStatus } from "./machine.ts";

/** K-635: the labels that kitshn derives from a daemon report. None of them is `deploy`, which stays the owner's consent. */
export const FACT_LABELS = ["os:linux", "os:darwin", "os:windows", "arch:x64", "arch:arm64", "unix"] as const;
export type FactLabel = (typeof FACT_LABELS)[number];

/** K-635: one fact label and the part of the report that it comes from. */
export interface MachineFact {
  readonly label: FactLabel;
  readonly from: string;
}

const OS_FACTS: Record<MachineOs, ReadonlyArray<FactLabel>> = {
  linux: ["os:linux", "unix"],
  macos: ["os:darwin", "unix"],
  windows: ["os:windows"],
};

/** K-635: the fact labels of a daemon report; none before the first report. */
export function machineFacts(report: Pick<MachineStatus, "os" | "arch"> | null): Array<MachineFact> {
  if (report === null) return [];
  const os = machineOs(report.os);
  const arch: FactLabel | null =
    report.arch === "x64" ? "arch:x64" : report.arch === "arm64" ? "arch:arm64" : null;
  return [
    ...(os === null ? [] : OS_FACTS[os].map((label) => ({ label, from: `os ${report.os}` }))),
    ...(arch === null ? [] : [{ label: arch, from: `arch ${report.arch}` }]),
  ];
}

/** K-635: a name that only kitshn gives. The prefixes stay reserved for facts that come later. */
export const isReservedLabel = (label: string): boolean =>
  label === "unix" || label.startsWith("os:") || label.startsWith("arch:");

/** K-610, K-635: a machine has a label when the owner set it or the daemon report gives it. */
export const hasLabels = (
  owner: ReadonlyArray<string>,
  facts: ReadonlyArray<MachineFact>,
  needed: ReadonlyArray<string>,
): boolean => needed.every((label) => owner.includes(label) || facts.some((fact) => fact.label === label));

/** K-610, K-812: a Compose app runs only on a machine that the owner labels `deploy` and that has every `runsOn` label. */
export const deployLabels = (runsOn: ReadonlyArray<string>): Array<string> => ["deploy", ...runsOn];
