import { formatConditions, parseConditions, rightWarnings } from "../core/asks.ts";
import {
  type Circle,
  EVERYONE_CIRCLE_ID,
  MACHINE_RIGHTS,
  MACHINE_RIGHT_NAMES,
  type MachineRight,
  type Member,
  type RightMode,
} from "../core/model.ts";
import { Radio } from "./controls.tsx";

type MachineMember = Extract<Member, { _tag: "machine" }>;

const RIGHT_HELP: Record<MachineRight, string> = {
  addsApps: "Adds apps: the machine allows a waiting repo (K-819).",
  publishes: "Publishes: the machine moves a card that it added into Everyone.",
  deploys: "Deploys: the machine redeploys or builds a card that it manages.",
  runsCommands: "Runs commands: the machine runs jobs on a machine that it manages.",
  readsCode: "Reads code: a GitHub token that reads one repo.",
  writesCode:
    "Writes code: a GitHub token that pushes to one repo and opens pull requests. It never deploys.",
  addsAudiences: "Adds audiences: the machine adds an outside service that may receive its passes.",
  getsPasses: "Gets passes: a 5-minute pass for an outside service of the audience list.",
  addsPages:
    "Adds pages: the machine publishes pages, files and folder sites into its agent circles, and sets their addresses and redirects.",
  restores:
    "Restores: the machine writes a backup run of a Compose card back, after a backup of the current data (K-1820).",
  maintains:
    "Maintains: the machine restarts and updates daemons, runs diagnostics, sets machine labels and order (K-1777). Default: automatic.",
  readsMap:
    "Reads the map: kitshn state shows the whole map, without job output and History text (K-1777). Default: automatic.",
};

/**
 * K-1720: the mode of each right of a machine in an agent circle: off, automatic, or ask one circle. K-1725: the
 * warnings below it; every configuration is allowed.
 */
export function MachineRights(props: {
  readonly member: MachineMember;
  readonly circles: ReadonlyMap<string, Circle>;
  readonly onChange: (right: MachineRight, mode: RightMode | null) => void;
}) {
  const rights = props.member.rights ?? {};
  const approvers = [...props.circles.values()].filter((circle) => circle.id !== EVERYONE_CIRCLE_ID);
  const warnings = rightWarnings(props.circles, props.member.machineId, rights);
  return (
    <div class="rights">
      {MACHINE_RIGHTS.map((right) => {
        const mode = rights[right] ?? null;
        const name = `right-${props.member.machineId}-${right}`;
        return (
          <fieldset key={right} class="right-mode">
            <legend data-tip={RIGHT_HELP[right]}>{MACHINE_RIGHT_NAMES[right]}</legend>
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
              tip={`Off: the machine never ${MACHINE_RIGHT_NAMES[right]}, and no call asks.`}
              onSelect={() => props.onChange(right, { mode: "off" })}
            />
            <Radio
              name={name}
              checked={mode?.mode === "automatic"}
              label="automatic"
              tip="Automatic: kitshn runs the ask at once."
              onSelect={() => props.onChange(right, { mode: "automatic" })}
            />
            {approvers.map((circle) => (
              <Radio
                key={circle.id}
                name={name}
                checked={mode?.mode === "ask" && mode.circleId === circle.id}
                label={`ask ${circle.name}`}
                tip={`Ask ${circle.name}: one member approves each ask; a person passes a fresh passkey check when the circle needs a passkey.`}
                onSelect={() => props.onChange(right, { mode: "ask", circleId: circle.id })}
              />
            ))}
            {mode && mode.mode !== "off" ? (
              <input
                class="field"
                aria-label={`Conditions of ${MACHINE_RIGHT_NAMES[right]}`}
                placeholder="t3.project.name=kitshn,riffle; t3.subagent=false"
                value={formatConditions(mode.conditions)}
                data-tip="Conditions: attested labels that each ask must have, as key=value,value; key=value. A condition on a label that no provider of the machine sets refuses every ask (K-1754)."
                onChange={(event) => {
                  const parsed = parseConditions(event.currentTarget.value);
                  if (typeof parsed === "string") return;
                  const { conditions: _, ...rest } = mode;
                  props.onChange(right, parsed.length === 0 ? rest : { ...rest, conditions: parsed });
                }}
              />
            ) : null}
          </fieldset>
        );
      })}
      {warnings.map((warning) => (
        <p key={warning} class="warning">
          ⚠️ {warning}
        </p>
      ))}
      <span class="help">A right counts from any agent circle of this machine; automatic wins over ask.</span>
    </div>
  );
}

/** K-1720: a right that is off has no key, so the member stays as short as it was. */
export function withMode(member: MachineMember, right: MachineRight, mode: RightMode | null): MachineMember {
  const { [right]: _, ...others } = member.rights ?? {};
  const rights = mode === null ? others : { ...others, [right]: mode };
  const { rights: _old, ...rest } = member;
  return Object.keys(rights).length === 0 ? rest : { ...rest, rights };
}

/** K-1730: a sticker for each right of a machine on its chip in an agent circle; "ask" rights carry a "?". */
export function MachineRightStickers(props: { readonly member: MachineMember }) {
  return (
    <>
      {MACHINE_RIGHTS.flatMap((right) => {
        const mode = props.member.rights?.[right];
        if (!mode || mode.mode === "off") return [];
        return [
          <span
            key={right}
            class="sticker right"
            data-tip={`${RIGHT_HELP[right]} ${mode.mode === "ask" ? "Each ask waits for its approver circle." : "Runs at once."}`}
          >
            {MACHINE_RIGHT_NAMES[right]}
            {mode.mode === "ask" ? " ?" : ""}
          </span>,
        ];
      })}
    </>
  );
}
