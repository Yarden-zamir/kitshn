import { AUTOMATIC_WARNING, formatConditions, rightWarnings } from "../core/asks.ts";
import {
  type Actor,
  EFFECTS,
  EVERYONE_CIRCLE_ID,
  type Effect,
  type Member,
  type RightMode,
  type State,
} from "../core/model.ts";
import { EFFECT_DEFAULTS } from "../core/operations.ts";
import { Radio } from "./controls.tsx";

type ActorMember = Extract<Member, { _tag: "actor" }>;

const EFFECT_HELP: Record<Effect, string> = {
  reads: "Reads: the map, logs, History, job output and repo read tokens.",
  maintains:
    "Maintains: closed machine care (restart, update, tunnel restart, diagnostics, order, automatic update), and closing invites and asks.",
  creates:
    "Creates: new cards (apps, pages, sites, ports, repos). They land only in the actor's own circles, so creating never shares.",
  changes:
    "Changes: existing cards in scope: deploys, settings, desired state, repo push tokens and backups.",
  runs: "Runs: shell and exec on machines in scope.",
  destroys:
    "Destroys: anything without Undo: remove an app, restore over data, delete volumes, forget a card.",
  shares:
    "Shares: raises access: a card into a circle, a member, a higher level, public, deploy labels, passes and audiences. A person approves an ask of it with a passkey.",
  secrets:
    "Secrets: hands out a secret: invite codes, key reset codes and tokens. A person approves an ask of it with a passkey.",
};

/**
 * K-1720, K-1730: the mode of each effect of an actor chip: default, off, automatic, or ask one circle. K-1725: the
 * warnings below it; every configuration is allowed. K-1754: the conditions belong to the actor, not to an effect, so
 * they show here and do not change here.
 */
export function ActorRights(props: {
  readonly member: ActorMember;
  readonly actor: Actor;
  readonly state: Pick<State, "circles" | "actors" | "machines">;
  readonly onChange: (effect: Effect, mode: RightMode | null) => void;
}) {
  const rights = props.member.rights ?? {};
  const approvers = [...props.state.circles.values()].filter((circle) => circle.id !== EVERYONE_CIRCLE_ID);
  const warnings = rightWarnings(props.state, props.actor, rights);
  const conditions = formatConditions(props.actor.conditions);
  return (
    <div class="rights">
      {conditions ? (
        <p
          class="help"
          data-tip="Conditions: attested labels that a call of the machine must carry to be this actor (K-1754)."
        >
          Only calls with {conditions}
        </p>
      ) : null}
      {EFFECTS.map((right) => {
        const mode = rights[right] ?? null;
        const name = `right-${props.member.actorId}-${right}`;
        return (
          <fieldset key={right} class="right-mode">
            <legend data-tip={EFFECT_HELP[right]}>{right}</legend>
            <Radio
              name={name}
              checked={mode === null}
              label="default"
              tip={`Default: ${EFFECT_DEFAULTS[right]} in an agent circle; outside one, automatic asks the Owner (K-1730).`}
              onSelect={() => props.onChange(right, null)}
            />
            <Radio
              name={name}
              checked={mode?.mode === "off"}
              label="off"
              tip={`Off: the actor never ${right}, and no call asks.`}
              onSelect={() => props.onChange(right, { mode: "off" })}
            />
            <Radio
              name={name}
              checked={mode?.mode === "automatic"}
              label="automatic"
              tip="Automatic: kitshn runs the call at once."
              onSelect={() => props.onChange(right, { mode: "automatic" })}
            />
            {approvers.map((circle) => (
              <Radio
                key={circle.id}
                name={name}
                checked={mode?.mode === "ask" && mode.circleId === circle.id}
                label={`ask ${circle.name}`}
                tip={`Ask ${circle.name}: one member approves each call; a person passes a fresh passkey check when the circle needs a passkey.`}
                onSelect={() => props.onChange(right, { mode: "ask", circleId: circle.id })}
              />
            ))}
          </fieldset>
        );
      })}
      {warnings.map((warning) => (
        <p key={warning} class="warning">
          ⚠️ {warning}
        </p>
      ))}
      <span class="help">
        An effect counts from every circle of this actor; automatic from any matched actor wins over ask.
      </span>
    </div>
  );
}

/** K-1720: an effect that is default has no key, so the member stays as short as it was. */
export function withMode(member: ActorMember, right: Effect, mode: RightMode | null): ActorMember {
  const { [right]: _, ...others } = member.rights ?? {};
  const rights = mode === null ? others : { ...others, [right]: mode };
  const { rights: _old, ...rest } = member;
  return Object.keys(rights).length === 0 ? rest : { ...rest, rights };
}

/**
 * K-1730: a sticker for each open effect of an actor chip; "ask" effects carry a "?". K-1725: "shares", "secrets",
 * "runs" and "destroys" at automatic carry a warning.
 */
export function RightStickers(props: { readonly member: ActorMember }) {
  return (
    <>
      {EFFECTS.flatMap((right) => {
        const mode = props.member.rights?.[right];
        if (!mode || mode.mode === "off") return [];
        const warning = mode.mode === "automatic" ? AUTOMATIC_WARNING[right] : undefined;
        return [
          <span
            key={right}
            class={warning === undefined ? "sticker right" : "sticker right warn"}
            data-tip={`${EFFECT_HELP[right]} ${warning ?? (mode.mode === "ask" ? "Each call waits for its approver circle." : "Runs at once.")}`}
          >
            {warning === undefined ? "" : "⚠️ "}
            {right}
            {mode.mode === "ask" ? " ?" : ""}
          </span>,
        ];
      })}
    </>
  );
}
