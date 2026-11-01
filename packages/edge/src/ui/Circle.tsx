import { useId, useRef, useState } from "preact/hooks";
import { type Edit, deepEqual } from "../core/changes.ts";
import {
  type Actor,
  type Circle,
  LEVELS,
  type Level,
  type Member,
  type Resource,
  type State,
  actorIdOf,
  circlesHolding,
  isPerson,
  machineIdOf,
  memberActor,
  memberLabel,
  shareKey,
  shareLevel,
  levelName,
  levelsOf,
} from "../core/model.ts";
import { CIRCLE_COLORS, LEVEL_COLORS, LEVEL_TILTS, MEMBER_ICONS } from "./kinds.ts";
import {
  type MemberKind,
  TYPED_KINDS,
  type TypedKind,
  actorMember,
  deleteActorEdits,
  isAgentCircle,
  machineMember,
  memberFrom,
  memberKind,
} from "./members.ts";
import { callApi } from "./store.ts";
import { Switch, useDialogEscape } from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { ActorRights, withMode } from "./ActorRights.tsx";
import { formatConditions, parseConditions, selfApprovers } from "../core/asks.ts";
import type { ComponentChildren } from "preact";
import { levelEdit } from "./actions.ts";
import { type DeviceInvite, InviteDialog } from "./Invite.tsx";
import { whenText } from "./time.ts";

/** The sticker of each member kind: its name and a light sticker colour with black text. */
const MEMBER_STICKERS: Record<MemberKind, { readonly label: string; readonly color: string }> = {
  person: { label: "person", color: "var(--green)" },
  token: { label: "token", color: "var(--pink)" },
  machine: { label: "machine", color: "var(--yellow)" },
  agent: { label: "agent", color: "var(--yellow)" },
  domain: { label: "domain", color: "var(--info)" },
  ip: { label: "network", color: "var(--warning)" },
  everyone: { label: "everyone", color: "var(--green)" },
};

const COLOR_NAMES: Record<string, string> = {
  "#6C5CE7": "purple",
  "#FF5277": "red",
  "#00B3FF": "blue",
  "#FFB347": "orange",
  "#7CFF8A": "green",
  "#14B8A6": "teal",
};

/** What each member kind matches, with an example (K-106, K-107, K-202, K-1778). */
export const MEMBER_HELP: Record<MemberKind, string> = {
  person:
    "Person: an actor who logs in with an email, and the tokens of their phone and desktop apps. A passkey circle lets in only the login.",
  token: "Token: an actor that proves itself with an Access service token, for example a script.",
  machine: "Machine: a machine with a daemon, and every agent on it that no agent actor narrows.",
  agent:
    "Agent: the calls of a machine that carry these attested labels, for example the threads of one project. It never opens a site.",
  domain: "Domain: every email of an email domain that logs in, for example example.com.",
  ip: "Network: a visitor from an IP range, with no login, for example 10.0.0.0/8 or 203.0.113.9.",
  everyone: "Everyone: anyone who can reach the address, with no login.",
};

type AddKind = TypedKind | "actor" | "token" | "machine";

const KIND_OPTIONS: Record<AddKind, { readonly label: string; readonly tip: string }> = {
  auto: {
    label: "auto",
    tip: "Auto: the text decides the kind, for example name@example.com is a person, example.com a domain and 10.0.0.0/8 a network.",
  },
  email: { label: "person", tip: MEMBER_HELP.person },
  domain: { label: "domain", tip: MEMBER_HELP.domain },
  ip: { label: "network", tip: MEMBER_HELP.ip },
  everyone: { label: "everyone", tip: MEMBER_HELP.everyone },
  actor: { label: "actor", tip: "Actor: pick a person, token or agent that is in another circle already." },
  token: { label: "token", tip: `${MEMBER_HELP.token} Invite an app or make a token for a new actor.` },
  machine: { label: "machine", tip: `${MEMBER_HELP.machine} Pick one of the joined machines.` },
};

const LEVEL_HELP: Record<Level, string> = {
  view: "Members can open what the circle holds.",
  use: "Members can also use machines: terminals and files.",
  control: "Members can also run commands and change settings.",
};

/** What each level allows on each resource kind (K-206, K-301). */
export const LEVEL_TIPS: Record<Level, string> = {
  view: "View: members open what the circle holds. Sites, pages, files and repos have only this level.",
  use: "Use: on a machine, members also use terminals and files. A kind without use, such as a site, gets view.",
  control:
    "Control: on a machine, members also run commands and change settings; on the kitshn admin, they change kitshn. A site gets view.",
};

/** K-203 */
export const MATCH_TIPS = {
  any: "Any: the visitor matches at least one member.",
  all: "All must match: the visitor matches every member, for example a domain and an IP range.",
} as const;

/** K-103 */
export const PASSKEY_TIP =
  "Needs a passkey: after the login, a visitor also confirms with a passkey or a security key.";

const DAY = 24 * 60 * 60 * 1000;
const END_PRESETS = [
  { label: "Never", after: null },
  { label: "1 day", after: DAY },
  { label: "1 week", after: 7 * DAY },
  { label: "1 month", after: 30 * DAY },
] as const;

/**
 * The end of the day that is `days` days from now (0 is today), in local time. Null for text that is no
 * such day, or for an end that has passed already.
 */
const endOfDayIn = (days: string): number | null => {
  const count = Number(days);
  if (days === "" || !Number.isInteger(count) || count < 0) return null;
  const date = new Date();
  date.setDate(date.getDate() + count);
  date.setHours(23, 59, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) && time > Date.now() ? time : null;
};

/**
 * K-209, K-201: an end date from presets; Custom takes a number of days, so no native date picker shows.
 * `ends` says what happens at the end, for the tooltips.
 */
export function EndsPicker(props: {
  endsAt: number | null;
  ends: string;
  /** The choices before Custom; the one with `after: null` means no end. */
  presets?: ReadonlyArray<{ readonly label: string; readonly after: number | null }>;
  onChange: (endsAt: number | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState("");
  const customEnd = endOfDayIn(days);
  const invalid = days !== "" && customEnd === null;
  const errorId = useId();
  return (
    <div>
      <div class="pills">
        {(props.presets ?? END_PRESETS).map((preset) => (
          <button
            key={preset.label}
            type="button"
            aria-pressed={!custom && preset.after === null && props.endsAt === null}
            data-tip={
              preset.after === null
                ? `${preset.label}: no end date.`
                : `${preset.label}: ${props.ends} ${preset.label} from now.`
            }
            onClick={() => {
              setCustom(false);
              props.onChange(preset.after === null ? null : Date.now() + preset.after);
            }}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom || props.endsAt !== null}
          data-tip={`Custom: pick the number of days; ${props.ends} at the end of that day.`}
          onClick={() => setCustom(true)}
        >
          Custom…
        </button>
      </div>
      {custom ? (
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (customEnd !== null) props.onChange(customEnd);
          }}
        >
          <input
            class="field grow"
            inputMode="numeric"
            aria-label="Days from now"
            placeholder="Days from now, for example 3"
            data-tip={`The number of days from today, 0 for today; ${props.ends} at the end of that day.`}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            value={days}
            onInput={(event) => setDays(event.currentTarget.value.trim())}
          />
          <button class="btn" disabled={customEnd === null} data-tip="Set this end date.">
            Set
          </button>
        </form>
      ) : null}
      {custom && invalid ? (
        <p class="error" id={errorId}>
          Type a whole number of days: 0 for today, 1 for tomorrow.
        </p>
      ) : null}
      {props.endsAt !== null ? (
        <p class="help">
          <span class="sticker wait" data-tip={`Ends: ${props.ends} at this time.`}>
            ends
          </span>{" "}
          {whenText(props.endsAt)}
        </p>
      ) : null}
    </div>
  );
}

/** K-205: the level of one card in one circle; "default" follows the circle. */
export function LevelOverride(props: {
  resource: Resource;
  circle: Circle;
  state: State;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
}) {
  const { resource, circle, state } = props;
  const setting = state.shareSettings.get(shareKey(resource.id, circle.id));
  const levels = levelsOf(resource);
  const put = (level: Level | null) => props.onEdit([levelEdit(state, resource, circle, level)]);
  return (
    <div class="seg small">
      <button
        type="button"
        aria-pressed={!setting?.level}
        data-tip={`Default: this card follows the level of ${circle.name}, now ${circle.level}.`}
        onClick={() => void put(null)}
      >
        default
      </button>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          aria-pressed={setting?.level === level}
          data-tip={`${levelName(resource, level)}: this card gets ${levelName(resource, level)} in ${circle.name}, whatever the default. The card shows the override as a chip.`}
          onClick={() => void put(level)}
        >
          {levelName(resource, level)}
        </button>
      ))}
    </div>
  );
}

function MemberSticker(props: {
  member: Member;
  state: State;
  onRemove: () => void;
  extra?: ComponentChildren;
}) {
  const { member, state } = props;
  const kind = memberKind(member, state);
  const label = memberLabel(member, state);
  const actor = memberActor(member, state);
  const credentials = actor?.credentials.length ?? 0;
  return (
    <li class="member">
      <span class="sticker" style={{ background: MEMBER_STICKERS[kind].color }} data-tip={MEMBER_HELP[kind]}>
        {MEMBER_STICKERS[kind].label}
      </span>
      <span class="who" data-tip={actor ? credentialTip(actor) : undefined}>
        {MEMBER_ICONS[kind]} {label}
        {credentials > 1 ? <span class="muted"> · {credentials} credentials</span> : null}
      </span>
      <button
        type="button"
        class="remove"
        aria-label={`Remove ${label}`}
        data-tip={`Remove ${label} from this circle. The actor stays.`}
        onClick={props.onRemove}
      >
        ×
      </button>
      {props.extra}
    </li>
  );
}

/** K-1778: the credentials of an actor, for its tip: each login, token and machine. */
const credentialTip = (actor: Actor) =>
  actor.credentials
    .map((credential) =>
      credential._tag === "login"
        ? `login ${credential.email}`
        : credential._tag === "token"
          ? `token ${credential.name}`
          : `machine key ${credential.machineId}`,
    )
    .join(", ");

export const AGENT_TIP =
  "Agent: an actor that is not a person. It manages only the cards that its agent circles hold at control.";

/** K-106: the service tokens of the account, and a new one; its secret shows once. */
export interface DeviceSecret {
  readonly name: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** K-106: a new token's secret, in a dialog that only "I saved it" closes; kitshn cannot show it again. */
export function SecretDialog(props: { secret: DeviceSecret; onClose: () => void }) {
  // Only "I saved it" closes it: kitshn cannot show the secret again.
  useDialogEscape(() => undefined);
  const { secret } = props;
  return (
    <div class="scrim">
      <div class="dialog secret" role="dialog" aria-label={`Secret of ${secret.name}`}>
        <div class="row">
          <span class="sticker" data-tip="kitshn shows this secret only now and cannot show it again.">
            shown once
          </span>
          <b>{secret.name}</b>
        </div>
        <p class="help">Put these on the device now. kitshn cannot show the secret again.</p>
        {[
          ["CF-Access-Client-Id", secret.clientId],
          ["CF-Access-Client-Secret", secret.clientSecret],
        ].map(([header, value]) => (
          <div class="row" key={header}>
            <code>
              {header}: {value}
            </code>
            <button
              type="button"
              class="btn"
              data-tip={`Copy the ${header} header to the clipboard.`}
              onClick={() => void navigator.clipboard.writeText(value ?? "")}
            >
              Copy
            </button>
          </div>
        ))}
        <button
          type="button"
          class="btn primary"
          data-tip="Close this dialog. The secret is gone after this."
          onClick={props.onClose}
        >
          I saved it
        </button>
      </div>
    </div>
  );
}

/**
 * K-1601, K-1778: a new token for an actor. "Invite app" makes an invite whose token joins `actorId` at the exchange, or
 * a new actor when `actorId` is null; "Make token" makes a token and shows its secret once.
 */
function NewToken(props: {
  actorId: string | null;
  /** What the new token becomes: a credential of the actor, or a new actor; null when kitshn refused it. */
  onToken: (token: { tokenId: string; clientId: string; name: string }) => Promise<string | null>;
  onSecret: (secret: DeviceSecret) => void;
  onInvite: (invite: DeviceInvite) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    if (!name.trim()) return setError("Name the new device or script, for example Her phone.");
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };
  const invite = () =>
    void run(async () => {
      const result = await callApi<DeviceInvite>("POST", "/api/devices/invites", {
        name: name.trim(),
        ...(props.actorId ? { actor: props.actorId } : {}),
      });
      if ("error" in result) return setError(result.error);
      setError(null);
      setName("");
      props.onInvite(result);
    });
  const makeToken = () =>
    void run(async () => {
      const result = await callApi<{ tokenId: string; clientId: string; clientSecret: string; name: string }>(
        "POST",
        "/api/devices",
        { name: name.trim() },
      );
      if ("error" in result) return setError(result.error);
      setError(null);
      setName("");
      props.onSecret({ name: result.name, clientId: result.clientId, clientSecret: result.clientSecret });
      const refused = await props.onToken(result);
      if (refused) setError(`The token exists, but kitshn did not take it: ${refused}`);
    });
  return (
    <form
      class="row"
      onSubmit={(event) => {
        event.preventDefault();
        invite();
      }}
    >
      <input
        class="field field-block grow"
        value={name}
        aria-label="New token name"
        data-tip="The name of a new device or script. kitshn makes its token."
        placeholder="+ New device, for example Her phone"
        onInput={(event) => setName((event.target as HTMLInputElement).value)}
      />
      <button
        class="btn primary"
        disabled={busy}
        data-tip="Invite the T3 Code app on a phone or a desktop: a QR code and a link that work once for 15 minutes."
      >
        Invite app
      </button>
      <button
        type="button"
        class="btn"
        disabled={busy}
        data-tip="Make a service token for a script, and show its secret once."
        onClick={makeToken}
      >
        Make token
      </button>
      {error ? <p class="error">{error}</p> : null}
    </form>
  );
}

/** K-1754, K-1778: "New agent" on a machine chip: an actor of the machine key and conditions on attested labels. */
function NewAgent(props: {
  machineId: string;
  machineName: string;
  onAdd: (actor: Actor) => Promise<string | null>;
}) {
  const [conditions, setConditions] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      class="row"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseConditions(conditions);
        if (typeof parsed === "string") return setError(parsed);
        if (parsed.length === 0)
          return setError("An agent needs at least one condition, for example t3.project.name=kitshn.");
        const credential = { _tag: "machine", machineId: props.machineId } as const;
        const actor: Actor = {
          id: actorIdOf(credential, parsed),
          name: name.trim() || `${props.machineName} ${formatConditions(parsed)}`.slice(0, 80),
          credentials: [credential],
          conditions: parsed,
        };
        void props.onAdd(actor).then((refused) => {
          setError(refused);
          if (!refused) {
            setConditions("");
            setName("");
          }
        });
      }}
    >
      <input
        class="field grow"
        value={conditions}
        aria-label={`Conditions of a new agent of ${props.machineName}`}
        placeholder="t3.project.name=kitshn; t3.subagent=false"
        data-tip="Conditions: attested labels that a call of this machine must carry, as key=value,value; key=value (K-1754)."
        onInput={(event) => setConditions((event.target as HTMLInputElement).value)}
      />
      <input
        class="field"
        value={name}
        aria-label="Name of the new agent"
        placeholder="kitshn builder"
        data-tip="The name of the agent in the map and in History."
        onInput={(event) => setName((event.target as HTMLInputElement).value)}
      />
      <button
        class="btn"
        data-tip={`Add an agent of ${props.machineName} to this circle, with no right set yet.`}
      >
        New agent
      </button>
      {error ? <p class="error">{error}</p> : null}
    </form>
  );
}

/** One control for every member kind: the text decides the kind, the segment overrides it. */
function AddMember(props: {
  circle: Circle;
  state: State;
  /** K-539: the joined machines, for the "machine" kind. */
  machines: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onJoinMachine: (machineId: string) => void;
  onAdd: (member: Member, actor: Actor | null) => Promise<string | null>;
  onSecret: (secret: DeviceSecret) => void;
  onInvite: (invite: DeviceInvite) => void;
}) {
  const [kind, setKind] = useState<AddKind>("auto");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = kind !== "actor" && kind !== "token" && kind !== "machine" ? kind : null;
  const preview =
    typed === null || typed === "everyone" || value.trim() === ""
      ? null
      : memberFrom(typed, value, props.state);
  const add = async () => {
    if (typed === null) return;
    const result = memberFrom(typed, value, props.state);
    if (typeof result === "string") return setError(result);
    if (busy) return;
    setBusy(true);
    // A server refusal shows as a toast; the input keeps the text so the owner can fix it.
    const refused = await props.onAdd(result.member, result.actor);
    setBusy(false);
    if (!refused) setValue("");
  };
  const others = [...props.state.actors.values()].filter(
    (actor) => !actorMember(props.circle, actor.id) && machineIdOf(actor) === null,
  );
  return (
    <div class="add-member">
      <div class="pills" role="group" aria-label="Member kind">
        {[...TYPED_KINDS, "actor" as const, "token" as const, "machine" as const].map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            data-tip={KIND_OPTIONS[option].tip}
            onClick={() => {
              setKind(option);
              setError(null);
            }}
          >
            {KIND_OPTIONS[option].label}
          </button>
        ))}
      </div>
      {kind === "machine" ? (
        <div class="row">
          {props.machines.filter((machine) => !machineMember(props.circle, machine.id)).length === 0 ? (
            <span class="muted">Every joined machine is a member.</span>
          ) : null}
          {props.machines
            .filter((machine) => !machineMember(props.circle, machine.id))
            .map((machine) => (
              <button
                key={machine.id}
                type="button"
                class="btn"
                data-tip={`${machine.name} joins ${props.circle.name}, with no agent right yet.`}
                onClick={() => props.onJoinMachine(machine.id)}
              >
                + {machine.name}
              </button>
            ))}
        </div>
      ) : kind === "actor" ? (
        <ul class="picks">
          {others.length === 0 ? <li class="muted">Every actor without a machine is a member.</li> : null}
          {others.map((actor) => (
            <li key={actor.id}>
              <button
                type="button"
                disabled={busy}
                data-tip={`${actor.name} joins ${props.circle.name}. ${credentialTip(actor)}.`}
                onClick={() => void props.onAdd({ _tag: "actor", actorId: actor.id }, null).then(setError)}
              >
                {MEMBER_ICONS[memberKind({ _tag: "actor", actorId: actor.id }, props.state)]} {actor.name}
              </button>
            </li>
          ))}
        </ul>
      ) : kind === "token" ? (
        <NewToken
          actorId={null}
          onToken={(token) => {
            const credential = { _tag: "token", ...token } as const;
            const actor: Actor = { id: actorIdOf(credential), name: token.name, credentials: [credential] };
            return props.onAdd({ _tag: "actor", actorId: actor.id }, actor);
          }}
          onSecret={props.onSecret}
          onInvite={props.onInvite}
        />
      ) : (
        <form
          class="row"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          {kind !== "everyone" ? (
            <input
              class="field field-block grow"
              value={value}
              aria-label="Member"
              data-tip="An email, an email domain or a network. The kind above decides how kitshn reads it."
              placeholder="name@example.com, example.com or 10.0.0.0/8"
              onInput={(event) => {
                setValue((event.target as HTMLInputElement).value);
                setError(null);
              }}
            />
          ) : (
            <span class="help grow">Anyone who can reach the address, with no login.</span>
          )}
          <button class="btn primary" disabled={busy} data-tip={`Add this member to ${props.circle.name}.`}>
            Add
          </button>
        </form>
      )}
      {error ? (
        <p class="error">{error}</p>
      ) : preview && typeof preview !== "string" ? (
        <p class="help">
          Adds a <b>{MEMBER_STICKERS[memberKind(preview.member, props.state)].label}</b>:{" "}
          {preview.actor ? preview.actor.name : memberLabel(preview.member, props.state)}
        </p>
      ) : null}
    </div>
  );
}

export function CircleEditor(props: {
  circle: Circle;
  state: State;
  accessTeam: string;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDelete: (circle: Circle) => void;
  onSelectCard: (id: string) => void;
  onSecret: (secret: DeviceSecret) => void;
  /** K-539: a machine joins this circle through the one join of `joinPlan`. */
  onJoinMachine: (machineId: string) => void;
}) {
  const { circle, state } = props;
  // Edits that finish after a wait (a new device token) build on the circle as it is then, not as it was.
  const latest = useRef(circle);
  latest.current = circle;
  const put = (next: Partial<Circle>) =>
    props.onEdit([{ _tag: "circle", id: circle.id, after: { ...latest.current, ...next } }]);
  /** K-1778: a member, and the actor that it names when that actor is new, in one write. */
  const addMember = (member: Member, actor: Actor | null) => {
    if (latest.current.members.some((other) => deepEqual(other, member)))
      return Promise.resolve(`${memberLabel(member, state)} is in ${latest.current.name} already.`);
    return props.onEdit([
      ...(actor ? [{ _tag: "actor", id: actor.id, after: actor } as const] : []),
      {
        _tag: "circle",
        id: circle.id,
        after: { ...latest.current, members: [...latest.current.members, member] },
      },
    ]);
  };
  const [draft, setDraft] = useState<string | null>(null);
  const [invite, setInvite] = useState<DeviceInvite | null>(null);
  const inside = [...state.resources.values()].filter((resource) =>
    circlesHolding(state, resource.id).includes(circle),
  );
  // K-718, K-1778: rights count only in an agent circle: actors that are not people, and no rule.
  const agentCircle = isAgentCircle(circle, state);
  const hasPeople = circle.members.some((member) => {
    const actor = memberActor(member, state);
    return member._tag === "domain" || (actor !== undefined && isPerson(actor));
  });
  const withoutPasskey = circle.members.some((member) => {
    const actor = memberActor(member, state);
    return actor !== undefined && !isPerson(actor);
  });
  return (
    <section class="editor">
      <div class="band" style={{ background: circle.color }} />
      <div class="label">Circle</div>
      <input
        class="field title"
        aria-label="Circle name"
        data-tip="The name of the circle. Enter saves it; Escape cancels."
        value={draft ?? circle.name}
        onFocus={() => setDraft(circle.name)}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.stopPropagation();
          }
        }}
        onBlur={() => {
          const name = draft?.trim();
          setDraft(null);
          if (name && name !== circle.name) void put({ name });
        }}
      />
      <div class="swatches" role="radiogroup" aria-label="Colour">
        {[...new Set([...CIRCLE_COLORS, circle.color.toUpperCase()])].map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={circle.color.toUpperCase() === color}
            aria-label={COLOR_NAMES[color] ?? color}
            data-tip={`${COLOR_NAMES[color] ?? color}: the colour of the ring on the map. It changes no access.`}
            style={{ background: color }}
            onClick={() => void put({ color })}
          />
        ))}
      </div>

      <h3 class="label" data-tip="Who: the members of the circle. A circle with no members matches nobody.">
        Who
      </h3>
      <ul class="members">
        {circle.members.map((member, index) => {
          const actor = memberActor(member, state);
          const machineId = actor ? machineIdOf(actor) : null;
          return (
            <MemberSticker
              key={member._tag === "actor" ? member.actorId : `${member._tag}-${memberLabel(member, state)}`}
              member={member}
              state={state}
              onRemove={() => void put({ members: circle.members.filter((_, other) => other !== index) })}
              extra={
                member._tag === "actor" && actor ? (
                  <>
                    {agentCircle && !isPerson(actor) ? (
                      <ActorRights
                        member={member}
                        actor={actor}
                        state={state}
                        onChange={(right, mode) =>
                          void put({
                            members: circle.members.map((other, at) =>
                              at === index ? withMode(member, right, mode) : other,
                            ),
                          })
                        }
                      />
                    ) : null}
                    {machineId === null ? (
                      <details>
                        <summary data-tip={`Add a phone, desktop app or script to ${actor.name} (K-1601).`}>
                          Add device
                        </summary>
                        {[...state.circles.values()]
                          .filter((each) =>
                            each.members.some(
                              (other) => other._tag === "actor" && other.actorId === actor.id,
                            ),
                          )
                          .every((each) => each.needsPasskey) ? (
                          <p class="warning">
                            Every circle of {actor.name} needs a passkey, so a new token of it opens nothing
                            (K-1778). Put {actor.name} in a circle without a passkey first.
                          </p>
                        ) : null}
                        <NewToken
                          actorId={actor.id}
                          onToken={(token) =>
                            props.onEdit([
                              {
                                _tag: "actor",
                                id: actor.id,
                                after: {
                                  ...actor,
                                  credentials: [...actor.credentials, { _tag: "token", ...token }],
                                },
                              },
                            ])
                          }
                          onSecret={props.onSecret}
                          onInvite={setInvite}
                        />
                      </details>
                    ) : (actor.conditions ?? []).length === 0 ? (
                      <details>
                        <summary data-tip="An agent: the calls of this machine with given attested labels (K-1754).">
                          New agent
                        </summary>
                        <NewAgent
                          machineId={machineId}
                          machineName={actor.name}
                          onAdd={(agent) => addMember({ _tag: "actor", actorId: agent.id }, agent)}
                        />
                      </details>
                    ) : null}
                    <button
                      type="button"
                      class="btn"
                      data-tip={`Delete ${actor.name}: it leaves every circle, and its tokens act as no one (K-1778).`}
                      onClick={() => void props.onEdit(deleteActorEdits(state, actor.id))}
                    >
                      Delete actor
                    </button>
                  </>
                ) : null
              }
            />
          );
        })}
        {selfApprovers(state.circles, circle).map((actorId) => (
          <li key={`self-${actorId}`} class="warning">
            ⚠️ {state.actors.get(actorId)?.name ?? actorId} can approve its own asks here: a right of it asks
            this circle (K-1727).
          </li>
        ))}
        {circle.members.length === 0 ? (
          <li class="help">Nobody yet. A circle with no members matches nobody.</li>
        ) : null}
      </ul>
      <AddMember
        circle={circle}
        state={state}
        machines={[...state.machines.values()]}
        onJoinMachine={props.onJoinMachine}
        onAdd={addMember}
        onSecret={props.onSecret}
        onInvite={setInvite}
      />
      {invite ? <InviteDialog invite={invite} onClose={() => setInvite(null)} /> : null}

      <h3 class="label">Access</h3>
      <div class="field-row">
        <span class="label" data-tip="Level: what a share allows. Each resource kind names its own levels.">
          Level
        </span>
        <div>
          <div class="seg">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={circle.level === level}
                data-tip={LEVEL_TIPS[level]}
                onClick={() => void put({ level })}
              >
                {level}
              </button>
            ))}
          </div>
          <p class="help">{LEVEL_HELP[circle.level]}</p>
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Match: how a visitor matches the members of this circle.">
          Match
        </span>
        <div>
          <div class="seg">
            <button
              type="button"
              aria-pressed={circle.match === "any"}
              data-tip={MATCH_TIPS.any}
              onClick={() => void put({ match: "any" })}
            >
              any
            </button>
            <button
              type="button"
              aria-pressed={circle.match === "all"}
              data-tip={MATCH_TIPS.all}
              onClick={() => void put({ match: "all" })}
            >
              all must match
            </button>
          </div>
          <p class="help">
            {circle.match === "any"
              ? "A visitor needs to match one member."
              : "A visitor must match every member, for example a domain and the office network."}
          </p>
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip={PASSKEY_TIP}>
          Passkey
        </span>
        <div>
          <Switch
            checked={circle.needsPasskey}
            label="Needs a passkey"
            tip={PASSKEY_TIP}
            onChange={(needsPasskey) => void put({ needsPasskey })}
          />
          <p class="help">People also confirm with Touch ID, Windows Hello or a security key.</p>
          {circle.needsPasskey && hasPeople && props.accessTeam ? (
            <p class="help">
              A new person enrolls a passkey once, on the first login:{" "}
              <a href={`https://${props.accessTeam}/AddMfaDevice`} target="_blank" rel="noreferrer">
                <code>{props.accessTeam}/AddMfaDevice</code>
              </a>
            </p>
          ) : null}
          {circle.needsPasskey && withoutPasskey ? (
            <Switch
              checked={circle.approvesWithoutPasskey === true}
              label="Approves without passkey"
              tip="Approves without passkey: a machine, agent or token of this circle approves asks with no passkey. Off: only people approve (K-1727)."
              onChange={(approvesWithoutPasskey) => void put({ approvesWithoutPasskey })}
            />
          ) : null}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Ends: after this date the circle stops giving access.">
          Ends
        </span>
        <EndsPicker
          endsAt={circle.endsAt}
          ends="the circle stops giving access"
          onChange={(endsAt) => void put({ endsAt })}
        />
      </div>

      <h3 class="label" data-tip="What it opens: every card inside the circle, with the level that it gets.">
        What it opens ({inside.length})
      </h3>
      <ul class="opens">
        {inside.map((resource) => {
          const level = shareLevel(state, resource, circle);
          return (
            <li key={resource.id}>
              <button
                type="button"
                class="open-card"
                data-tip={`Select ${resource.name} and show its panel.`}
                onClick={() => props.onSelectCard(resource.id)}
              >
                <span class="name">
                  <ItemIcon resource={resource} />
                  {resource.name}
                </span>
                <span
                  class="sticker"
                  data-tip={
                    level ? LEVEL_TIPS[level] : "None: this kind has no level at or below the circle's level."
                  }
                  style={{
                    "--tilt": level ? LEVEL_TILTS[level] : "0deg",
                    background: level ? LEVEL_COLORS[level] : undefined,
                  }}
                >
                  {level ?? "none"}
                </span>
              </button>
              {levelsOf(resource).length > 1 ? (
                <LevelOverride resource={resource} circle={circle} state={state} onEdit={props.onEdit} />
              ) : null}
            </li>
          );
        })}
        {inside.length === 0 ? <li class="help">Nothing yet. Drag cards into the circle.</li> : null}
      </ul>

      <div class="danger-zone">
        <h3 class="label">Danger</h3>
        <p class="help">Its cards stay where they are and lose this share.</p>
        <button
          type="button"
          class="btn danger"
          data-tip={`Delete ${circle.name}. Its cards stay where they are and lose this share; Undo brings it back.`}
          onClick={() => props.onDelete(circle)}
        >
          Delete {circle.name}
        </button>
      </div>
    </section>
  );
}
