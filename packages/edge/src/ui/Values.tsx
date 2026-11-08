import { useEffect, useState } from "preact/hooks";
import type { NameState, NameView, ValueKind, ValueSetView } from "../core/values.ts";
import { Radio, WhyOff, useDialogEscape } from "./controls.tsx";
import { actorLabel } from "./revisions.ts";
import { callApi } from "./store.ts";
import { whenText } from "./time.ts";

/** K-835: the sticker of each state of a name. */
const STATE_STICKERS: Record<
  NameState,
  { readonly text: string; readonly style: string; readonly tip: string }
> = {
  set: { text: "set", style: "ok", tip: "kitshn keeps this value. A secret never shows again." },
  missing: {
    text: "missing",
    style: "",
    tip: "The recipe needs this name, and no value has it. A deploy stops before any work until you set it.",
  },
  github: {
    text: "from GitHub",
    style: "ok",
    tip: "The newest build got it from the GitHub secret or variable KITSHN_<NAME>, which wins over kitshn. Delete it in GitHub to use a kitshn value.",
  },
  kind: {
    text: "other kind",
    style: "",
    tip: "kitshn keeps this name as the other kind, so it counts as missing. Remove it, then set it as the kind of the recipe.",
  },
  unused: {
    text: "not needed",
    style: "wait",
    tip: "The newest plan of this set does not need this name, so no deploy gets it.",
  },
};

/** K-835: the text of the cards of a set that need a redeploy, or null. */
export function staleText(stale: ReadonlyArray<string>): string | null {
  return stale.length === 0
    ? null
    : `${stale.join(", ")} changed since the build that runs now. The app keeps the old value until a redeploy.`;
}

/**
 * K-830, K-835: the value sets with each needed name and its state, "Set…", "Change…" and "Remove". `only` (a card
 * or a set key) shows one set. A secret goes in a password field and never comes back; a var shows its value.
 */
export function ValuesDialog(props: {
  only: string | null;
  onClose: () => void;
  onDone: (text: string, error: boolean) => void;
  onRedeploy: (cardId: string) => Promise<void>;
  ask: (text: string) => Promise<boolean>;
}) {
  useDialogEscape(props.onClose);
  const [sets, setSets] = useState<ReadonlyArray<ValueSetView> | null>(null);
  const [hasKey, setHasKey] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    set: string;
    name: string;
    kind: ValueKind;
    known: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const path = props.only === null ? "/api/values" : `/api/values?set=${encodeURIComponent(props.only)}`;
  const load = async () => {
    const result = await callApi<{ sets: Array<ValueSetView>; secretsKey: boolean }>("GET", path);
    if ("error" in result) return setError(result.error);
    setSets(result.sets);
    setHasKey(result.secretsKey);
  };
  // The dialog loads the sets when it opens and after each change.
  useEffect(() => void load(), [path]);
  const remove = async (set: ValueSetView, name: NameView) => {
    const needed = name.state !== "unused";
    const sure =
      !needed ||
      (await props.ask(
        `Remove ${name.name} of ${set.label}? The next deploy or redeploy stops until you set it again. The running app keeps the old value until then. A removed value has no undo.`,
      ));
    if (!sure || busy) return;
    setBusy(true);
    const result = await callApi<{ stale: Array<string> }>(
      "DELETE",
      `/api/values/${encodeURIComponent(set.key)}/${encodeURIComponent(name.name)}`,
    );
    setBusy(false);
    if ("error" in result) return props.onDone(result.error, true);
    props.onDone(`Removed ${name.name} of ${set.label}.`, false);
    await load();
  };
  const shown = (sets ?? []).filter(
    (set) =>
      filter.trim() === "" ||
      set.label.toLowerCase().includes(filter.trim().toLowerCase()) ||
      set.names.some((name) => name.name.includes(filter.trim().toUpperCase())),
  );
  return (
    <div class="scrim">
      <div class="dialog values" role="dialog" aria-label="Values">
        <div class="row">
          <b>Values</b>
        </div>
        <p class="help">
          The secrets and vars that apps name in <code>needs</code>. A secret never shows again, also not to
          you. A GitHub secret <code>KITSHN_&lt;NAME&gt;</code> wins over a kitshn value. A change reaches an
          app with its next deploy or a redeploy.
        </p>
        {hasKey ? null : (
          <p class="error">
            kitshn has no key for secrets yet, so it keeps vars only. Run the bootstrap again; it makes the
            Worker secret KITSHN_SECRETS_KEY (K-832).
          </p>
        )}
        {error ? <p class="error">{error}</p> : null}
        {props.only === null ? (
          <input
            class="field"
            aria-label="Search the values"
            data-tip="Find a name, an app or an environment."
            placeholder="Search: OPENAI_KEY, riffle, prod…"
            value={filter}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        ) : null}
        {sets?.length === 0 ? (
          <p class="muted">No value sets yet. A deploy of a recipe with needs makes one.</p>
        ) : null}
        {shown.map((set) => (
          <section key={set.key} aria-label={`Values of ${set.label}`}>
            <div class="row">
              <b>{set.label}</b>
              {set.environment === "previews" ? (
                <span class="muted" data-tip="One set for every pull request preview of this app.">
                  all pull requests
                </span>
              ) : null}
              <code class="muted" data-tip="The key of this set, for kitshn secret set.">
                {set.key}
              </code>
            </div>
            {set.cards
              .filter((card) => card.stale.length > 0)
              .map((card) => (
                <div class="row" key={card.id}>
                  <span class="sticker wait" data-tip={staleText(card.stale) ?? ""}>
                    {card.name} needs redeploy
                  </span>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    data-tip={`Start ${card.name} again with today's values.`}
                    onClick={() => void props.onRedeploy(card.id).then(load)}
                  >
                    Redeploy
                  </button>
                </div>
              ))}
            <ul>
              {set.names.map((name) => (
                <li key={name.name}>
                  <div class="row">
                    <code>{name.name}</code>
                    <span class="muted">{name.kind}</span>
                    <span
                      class={`sticker ${STATE_STICKERS[name.state].style}`}
                      data-tip={STATE_STICKERS[name.state].tip}
                    >
                      {STATE_STICKERS[name.state].text}
                    </span>
                    {name.value !== undefined ? (
                      <code data-tip="A var shows its value.">{name.value}</code>
                    ) : null}
                    {name.setAt !== null && name.setBy !== null ? (
                      <span class="muted when">
                        {whenText(name.setAt)} by {actorLabel(name.setBy)}
                      </span>
                    ) : null}
                    <span class="push" />
                    {name.state === "github" ? null : (
                      <button
                        type="button"
                        class="btn"
                        disabled={busy || (name.kind === "secret" && !hasKey)}
                        data-tip={
                          name.setAt === null
                            ? `Set ${name.name} for ${set.label}.`
                            : `Give ${name.name} a new value. Nothing keeps the old one.`
                        }
                        onClick={() =>
                          setEditing({
                            set: set.key,
                            name: name.name,
                            kind: name.kind,
                            known: name.setAt !== null,
                          })
                        }
                      >
                        {name.setAt === null ? "Set…" : "Change…"}
                      </button>
                    )}
                    {name.setAt !== null ? (
                      <button
                        type="button"
                        class="btn danger"
                        disabled={busy}
                        data-tip={`Remove ${name.name} from kitshn. A removed value has no undo.`}
                        onClick={() => void remove(set, name)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  {editing?.set === set.key && editing.name === name.name ? (
                    <ValueForm
                      set={set}
                      name={editing.name}
                      kind={editing.kind}
                      known={editing.known}
                      onCancel={() => setEditing(null)}
                      onSaved={async (text, redeploy) => {
                        setEditing(null);
                        props.onDone(text, false);
                        if (redeploy) for (const card of set.cards) await props.onRedeploy(card.id);
                        await load();
                      }}
                      onError={(text) => props.onDone(text, true)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            <AddName
              set={set}
              hasKey={hasKey}
              onAdd={(name, kind) => setEditing({ set: set.key, name, kind, known: false })}
            />
          </section>
        ))}
        <button type="button" class="btn" data-tip="Close the values." onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** K-830: a name that no plan needs yet, for example before a push adds it to the recipe. */
function AddName(props: {
  set: ValueSetView;
  hasKey: boolean;
  onAdd: (name: string, kind: ValueKind) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ValueKind>(props.hasKey ? "secret" : "var");
  const group = `kind-${props.set.key}`;
  return (
    <form
      class="row"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") props.onAdd(name.trim().toUpperCase(), kind);
        setName("");
      }}
    >
      <input
        class="field"
        aria-label={`A new name of ${props.set.label}`}
        data-tip="An uppercase letter, then uppercase letters, digits or _."
        placeholder="NEW_NAME"
        value={name}
        onInput={(event) => setName(event.currentTarget.value)}
      />
      <Radio
        name={group}
        checked={kind === "secret"}
        disabled={!props.hasKey}
        label="secret"
        tip="A secret never shows again."
        onSelect={() => setKind("secret")}
      />
      <Radio
        name={group}
        checked={kind === "var"}
        label="var"
        tip="A var shows its value; it is for settings, not keys."
        onSelect={() => setKind("var")}
      />
      <button type="submit" class="btn" data-tip="Give this name a value next.">
        Add value…
      </button>
    </form>
  );
}

/** K-830, K-835: the value of one name, with "Save" and "Save and redeploy". */
function ValueForm(props: {
  set: ValueSetView;
  name: string;
  kind: ValueKind;
  known: boolean;
  onCancel: () => void;
  onSaved: (text: string, redeploy: boolean) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (redeploy: boolean) => {
    if (busy) return;
    setBusy(true);
    const result = await callApi<{ version: number; stale: Array<string> }>(
      "PUT",
      `/api/values/${encodeURIComponent(props.set.key)}/${encodeURIComponent(props.name)}`,
      { kind: props.kind, value },
    );
    setBusy(false);
    if ("error" in result) return props.onError(result.error);
    setValue("");
    const verb = props.known ? "Changed" : "Set";
    const pending =
      result.stale.length > 0 && !redeploy
        ? ` ${result.stale.join(", ")} keeps the old value until a redeploy.`
        : "";
    await props.onSaved(
      `${verb} ${props.name} in ${props.set.label}.${pending}`,
      redeploy && result.stale.length > 0,
    );
  };
  const empty = value === "" ? "Write a value first." : null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save(true);
      }}
    >
      {props.kind === "secret" ? (
        <input
          class="field"
          type="password"
          // The browser must not fill in a login password here.
          autocomplete="new-password"
          aria-label={`The value of ${props.name}`}
          data-tip="Paste the secret. kitshn never shows it again."
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      ) : (
        <input
          class="field"
          aria-label={`The value of ${props.name}`}
          data-tip="A var shows its value in the map and to agents."
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      )}
      {props.known ? (
        <p class="help">
          Nothing keeps the old value, also not History. The running app keeps it until a redeploy.
        </p>
      ) : null}
      <div class="row">
        <button
          type="button"
          class="btn"
          disabled={busy || empty !== null}
          data-tip={empty ?? "Save the value."}
          onClick={() => void save(false)}
        >
          Save
        </button>
        <button
          type="submit"
          class="btn primary"
          disabled={busy || empty !== null}
          data-tip={empty ?? "Save the value, and start each card that runs with the old value again."}
        >
          Save and redeploy
        </button>
        <button type="button" class="btn" data-tip="Keep the value as it is." onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      <WhyOff reason={empty} />
    </form>
  );
}
