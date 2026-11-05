// K-1730: the one move of rights to effects (migration 46). Pure, for tests: it reads the stored circle bodies of
// migration 44, whose chips hold the rights of before, and gives the circle bodies with effects.
import {
  type Actor,
  type Circle,
  EFFECTS,
  type Effect,
  type Member,
  OWNER_CIRCLE_ID,
  type RightMode,
  isPerson,
} from "./model.ts";
import { EFFECT_DEFAULTS } from "./operations.ts";

/** The rights of before the effects, as migration 44 writes them on the chips. */
export const LEGACY_RIGHTS = [
  "addsApps",
  "publishes",
  "deploys",
  "runsCommands",
  "readsCode",
  "writesCode",
  "addsAudiences",
  "getsPasses",
  "addsPages",
  "restores",
  "maintains",
  "readsMap",
  "raisesAccess",
] as const;
export type LegacyRight = (typeof LEGACY_RIGHTS)[number];

export const LEGACY_NAMES: Record<LegacyRight, string> = {
  addsApps: "adds apps",
  publishes: "publishes",
  deploys: "deploys",
  runsCommands: "runs commands",
  readsCode: "reads code",
  writesCode: "writes code",
  addsAudiences: "adds audiences",
  getsPasses: "gets passes",
  addsPages: "adds pages",
  restores: "restores",
  maintains: "maintains",
  readsMap: "reads the map",
  raisesAccess: "raises access",
};

/** K-1730: the effect of each right of before. */
export const EFFECT_OF: Record<LegacyRight, Effect> = {
  readsCode: "reads",
  readsMap: "reads",
  maintains: "maintains",
  addsApps: "creates",
  addsPages: "creates",
  deploys: "changes",
  writesCode: "changes",
  runsCommands: "runs",
  restores: "destroys",
  publishes: "shares",
  addsAudiences: "shares",
  getsPasses: "shares",
  raisesAccess: "shares",
};

/** A chip of migration 44, with the rights of before. */
export type LegacyChip = {
  readonly _tag: "actor";
  readonly actorId: string;
  readonly rights?: Readonly<Partial<Record<LegacyRight, RightMode>>>;
};
export type LegacyRightsCircle = Omit<Circle, "members"> & {
  readonly members: ReadonlyArray<LegacyChip | Exclude<Member, { _tag: "actor" }>>;
};

export interface EffectsMigration {
  readonly circles: ReadonlyArray<Circle>;
  /** What the owner reads in History: each merge of rights with different modes, and each mode that kitshn dropped. */
  readonly notes: ReadonlyArray<string>;
}

const RANK = { off: 0, ask: 1, automatic: 2 } as const;
const OWNER_ASK: RightMode = { mode: "ask", circleId: OWNER_CIRCLE_ID };
const sameMode = (a: RightMode, b: RightMode) =>
  a.mode === b.mode && (a.mode !== "ask" || (b.mode === "ask" && a.circleId === b.circleId));

/**
 * K-1730: the effects of the chips.
 * - The rights of one effect merge into the narrowest of their modes (off < ask < automatic; of two asks, the first),
 *   so nothing widens. An unset right counts with the mode that it had then: "ask the Owner", or "automatic" for
 *   "maintains" and "reads the map" of an actor in an agent circle. A History note names each merge of different modes.
 * - "reads code" and "writes code" count only in a circle that holds a repo or a repo group (`holdsRepo`), because
 *   elsewhere they had no effect.
 * - An effect stays unset when none of its rights was set and the merge equals its new default.
 * - A chip with "raises access" automatic acted as the owner, so it gets "shares" and "secrets" automatic.
 * - Effects now count in every circle, also one with people or rules. There, a chip of an actor that is not a person
 *   keeps only "off", because its rights counted only in agent circles before.
 */
export function migrateRights(
  circles: ReadonlyArray<LegacyRightsCircle>,
  actors: ReadonlyMap<string, Actor>,
  holdsRepo: (circleId: string) => boolean,
  now: number,
): EffectsMigration {
  const notes: Array<string> = [];
  const isAgentCircle = (circle: LegacyRightsCircle) =>
    circle.members.every((member) => {
      const actor = member._tag === "actor" ? actors.get(member.actorId) : undefined;
      return actor !== undefined && !isPerson(actor);
    });
  const hasRight = (member: LegacyRightsCircle["members"][number]) =>
    member._tag === "actor" && Object.values(member.rights ?? {}).some((mode) => mode !== undefined);
  const inAgentCircle = new Set(
    circles
      .filter(
        (circle) =>
          !circle.needsPasskey && (circle.endsAt === null || circle.endsAt > now) && isAgentCircle(circle),
      )
      .flatMap((circle) =>
        circle.members.flatMap((member) =>
          hasRight(member) && member._tag === "actor" ? [member.actorId] : [],
        ),
      ),
  );
  const modeText = (mode: RightMode) =>
    mode.mode === "ask"
      ? `ask ${circles.find((circle) => circle.id === mode.circleId)?.name ?? mode.circleId}`
      : mode.mode;

  const migrated = circles.map((circle): Circle => {
    const agentCircle = !circle.needsPasskey && isAgentCircle(circle);
    const members = circle.members.map((member): Member => {
      if (member._tag !== "actor" || !hasRight(member))
        return member._tag === "actor" ? { _tag: "actor", actorId: member.actorId } : member;
      const actor = actors.get(member.actorId);
      const name = actor?.name ?? member.actorId;
      const agent = inAgentCircle.has(member.actorId);
      const old = member.rights ?? {};
      const rights: Partial<Record<Effect, RightMode>> = {};
      for (const effect of new Set(Object.values(EFFECT_OF))) {
        const counted = LEGACY_RIGHTS.filter(
          (right) =>
            EFFECT_OF[right] === effect &&
            ((right !== "readsCode" && right !== "writesCode") || holdsRepo(circle.id)),
        );
        if (counted.length === 0) continue;
        const modes = counted.map((right): readonly [LegacyRight, RightMode] => [
          right,
          old[right] ??
            ((right === "maintains" || right === "readsMap") && agent ? { mode: "automatic" } : OWNER_ASK),
        ]);
        const [first] = modes;
        if (!first) continue;
        const narrowest = modes.reduce((low, next) =>
          RANK[next[1].mode] < RANK[low[1].mode] ? next : low,
        )[1];
        const newDefault: RightMode =
          EFFECT_DEFAULTS[effect] === "automatic" && agent
            ? { mode: "automatic" }
            : EFFECT_DEFAULTS[effect] === "off"
              ? { mode: "off" }
              : OWNER_ASK;
        const set = counted.some((right) => old[right] !== undefined);
        if (set || !sameMode(narrowest, newDefault)) rights[effect] = narrowest;
        // "raises access" automatic makes "shares" automatic below, so a merge note of "shares" would be wrong.
        const owner = effect === "shares" && old.raisesAccess?.mode === "automatic";
        if (!owner && modes.some(([, mode]) => !sameMode(mode, narrowest)))
          notes.push(
            `${name} in ${circle.name}: "${effect}" is ${modeText(narrowest)}, the narrowest of ${modes
              .map(
                ([right, mode]) =>
                  `${LEGACY_NAMES[right]} (${modeText(mode)}${old[right] === undefined ? ", default" : ""})`,
              )
              .join(", ")}.`,
          );
      }
      if (old.raisesAccess?.mode === "automatic") {
        rights.shares = { mode: "automatic" };
        rights.secrets = { mode: "automatic" };
        notes.push(`${name} in ${circle.name} acted as the owner, so "shares" and "secrets" are automatic.`);
      }
      if (!agentCircle && actor !== undefined && !isPerson(actor) && old.raisesAccess?.mode !== "automatic") {
        const open = EFFECTS.filter(
          (effect) => rights[effect] !== undefined && rights[effect]?.mode !== "off",
        );
        if (open.length > 0) {
          for (const effect of open) delete rights[effect];
          notes.push(
            `${name} in ${circle.name}: effects now count in a circle with people or rules, so only "off" stays here.`,
          );
        }
      }
      return Object.keys(rights).length === 0
        ? { _tag: "actor", actorId: member.actorId }
        : { _tag: "actor", actorId: member.actorId, rights };
    });
    return { ...circle, members };
  });
  return { circles: migrated, notes };
}
