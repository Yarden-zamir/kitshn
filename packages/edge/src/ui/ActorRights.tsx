import { formatConditions, rightWarnings } from "../core/asks.ts";
import {
  type Actor,
  EVERYONE_CIRCLE_ID,
  RIGHTS,
  RIGHT_NAMES,
  type Right,
  type Member,
  type RightMode,
  type State,
} from "../core/model.ts";
import { Radio } from "./controls.tsx";

type ActorMember = Extract<Member, { _tag: "actor" }>;

const RIGHT_HELP: Record<Right, string> = {
  addsApps: "Adds apps: the actor allows a waiting repo (K-819).",
  publishes: "Publishes: the actor moves a card that it added into Everyone.",
  deploys: "Deploys: the actor redeploys or builds a card that it manages.",
  runsCommands: "Runs commands: the actor runs jobs on a machine that it manages.",
  readsCode: "Reads code: a GitHub token that reads one repo.",
  writesCode:
    "Writes code: a GitHub token that pushes to one repo and opens pull requests. It never deploys.",
  addsAudiences: "Adds audiences: the actor adds an outside service that may receive its passes.",
  getsPasses: "Gets passes: a 5-minute pass for an outside service of the audience list.",
  addsPages:
    "Adds pages: the actor publishes pages, files and folder sites into its agent circles, and sets their addresses and redirects.",
  restores:
    "Restores: the actor writes a backup run of a Compose card back, after a backup of the current data (K-1820).",
  maintains:
    "Maintains: machine care (restart, update, diagnostics, order, its own key), and closing device invites and asks (K-1777). Default: automatic.",
  readsMap:
    "Reads the map: kitshn state shows the whole map, without job output and History text (K-1777). Default: automatic.",
  raisesAccess:
    "Raises access: the calls that the Owner decides, such as a share, a new member or a higher level (K-715). Automatic acts as the owner. Default: a person approves with a passkey (K-1778).",
};

/**
 * K-1720: the mode of each right of an actor chip in an agent circle: default, off, automatic, or ask one circle.
 * K-1725: the warnings below it; every configuration is allowed. K-1754: the conditions belong to the actor, not to a
 * right, so they show here and do not change here.
 */
export function ActorRights(props: {
  readonly member: ActorMember;
  readonly actor: Actor;
  readonly state: Pick<State, "circles" | "actors" | "machines">;
  readonly onChange: (right: Right, mode: RightMode | null) => void;
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
      {RIGHTS.map((right) => {
        const mode = rights[right] ?? null;
        const name = `right-${props.member.actorId}-${right}`;
        return (
          <fieldset key={right} class="right-mode">
            <legend data-tip={RIGHT_HELP[right]}>{RIGHT_NAMES[right]}</legend>
            <Radio
              name={name}
              checked={mode === null}
              label="default"
              tip="Default: each call asks the Owner, and one approval runs that call (K-1776)."
              onSelect={() => props.onChange(right, null)}
            />
            <Radio
              name={name}
              checked={mode?.mode === "off"}
              label="off"
              tip={`Off: the actor never ${RIGHT_NAMES[right]}, and no call asks.`}
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
        A right counts from any agent circle of this actor; automatic from any matched actor wins over ask.
      </span>
    </div>
  );
}

/** K-1720: a right that is default has no key, so the member stays as short as it was. */
export function withMode(member: ActorMember, right: Right, mode: RightMode | null): ActorMember {
  const { [right]: _, ...others } = member.rights ?? {};
  const rights = mode === null ? others : { ...others, [right]: mode };
  const { rights: _old, ...rest } = member;
  return Object.keys(rights).length === 0 ? rest : { ...rest, rights };
}

/** K-1730: a sticker for each open right of an actor chip in an agent circle; "ask" rights carry a "?". */
export function RightStickers(props: { readonly member: ActorMember }) {
  return (
    <>
      {RIGHTS.flatMap((right) => {
        const mode = props.member.rights?.[right];
        if (!mode || mode.mode === "off") return [];
        return [
          <span
            key={right}
            class="sticker right"
            data-tip={`${RIGHT_HELP[right]} ${mode.mode === "ask" ? "Each call waits for its approver circle." : "Runs at once."}`}
          >
            {RIGHT_NAMES[right]}
            {mode.mode === "ask" ? " ?" : ""}
          </span>,
        ];
      })}
    </>
  );
}
