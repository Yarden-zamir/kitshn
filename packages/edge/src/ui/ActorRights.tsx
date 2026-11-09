import { useState } from "preact/hooks";
import {
  EFFECT_HELP,
  POLICY_WARNINGS,
  automaticWarning,
  formatConditions,
  policyWarnings,
  rightWarnings,
} from "../core/asks.ts";
import {
  type Actor,
  EFFECTS,
  EVERYONE_CIRCLE_ID,
  type Effect,
  type Member,
  POLICY_TEXT,
  type PolicyOption,
  isPerson,
  withPolicyOption,
  type RightMode,
  type State,
} from "../core/model.ts";
import { EFFECT_DEFAULTS } from "../core/operations.ts";
import { Radio, Switch } from "./controls.tsx";
import { callApi } from "./store.ts";

type ActorMember = Extract<Member, { _tag: "actor" }>;

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
              tip={`Default: ${EFFECT_DEFAULTS[right]}. A default of automatic counts while the caller is in any agent circle, not only this one; else it asks the Owner (K-1730).`}
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
        const warning =
          mode.mode === "automatic" ? automaticWarning(right, props.member.rights ?? {}) : undefined;
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

/**
 * K-1779: what the owner lets one actor do without a person or a passkey. Turning an option on shows its warning and
 * waits for a confirm; turning one off runs at once, because it lowers access. The server checks the owner's passkey.
 */
export function ActorPolicyEditor(props: { readonly actor: Actor }) {
  const [pending, setPending] = useState<PolicyOption | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { actor } = props;
  const options: ReadonlyArray<PolicyOption> = isPerson(actor)
    ? ["approvesOwnAsks", "approve", "security", "owner"]
    : ["approvesOwnAsks", "approve", "security"];
  const isOn = (option: PolicyOption) =>
    option === "approvesOwnAsks"
      ? actor.policy?.approvesOwnAsks === true
      : actor.policy?.withoutPasskey?.includes(option) === true;
  const save = async (option: PolicyOption, on: boolean) => {
    setPending(null);
    const policy = withPolicyOption(actor.policy, option, on) ?? {};
    const result = await callApi<{ revision: number | null }>(
      "PUT",
      `/api/actors/${encodeURIComponent(actor.id)}/policy`,
      { policy },
    );
    setError("error" in result ? result.error : null);
  };
  return (
    <details>
      <summary data-tip="Approvals and passkey: what this actor does without a person or a passkey. Every option is off by default (K-1779).">
        Approvals and passkey
      </summary>
      {options.map((option) => (
        <Switch
          key={option}
          checked={isOn(option)}
          label={POLICY_TEXT[option]}
          tip={`${actor.name} ${POLICY_WARNINGS[option]}`}
          onChange={(on) => (on ? setPending(option) : void save(option, false))}
        />
      ))}
      {pending !== null ? (
        <>
          <p class="warning">
            ⚠️ {actor.name} {POLICY_WARNINGS[pending]}
          </p>
          <div class="choices">
            <button
              type="button"
              class="btn"
              data-tip="Turn the option on; History records it, and Undo turns it off."
              onClick={() => void save(pending, true)}
            >
              Turn on
            </button>
            <button
              type="button"
              class="btn"
              data-tip="Leave the option off."
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
      {policyWarnings(actor).map((warning) => (
        <p key={warning} class="warning">
          ⚠️ {warning}
        </p>
      ))}
      {error !== null ? <p class="warning">{error}</p> : null}
    </details>
  );
}
