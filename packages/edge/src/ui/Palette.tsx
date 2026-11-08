import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type PaletteCursor,
  type PaletteEntry,
  paletteActive,
  paletteArrow,
  paletteEnter,
} from "./actions.ts";

/** The entries whose label or keywords hold every word of the query, at most 50. */
const matching = (entries: ReadonlyArray<PaletteEntry>, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => {
      const text = `${entry.label} ${entry.keywords ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 50);
};

const fresh: PaletteCursor = { label: null, picked: false };

const keyOf = (entry: PaletteEntry) => entry.id ?? entry.label;

/** The list that these keys open from the current entries, or null when one of them is gone. */
function listAt(entries: ReadonlyArray<PaletteEntry>, keys: ReadonlyArray<string>) {
  let list = entries;
  for (const key of keys) {
    const entry = list.find((each) => keyOf(each) === key);
    if (!entry || !("items" in entry)) return null;
    list = entry.items;
  }
  return list;
}

/**
 * K-511: the command palette. It filters every entry by the words of the query; Enter runs the highlighted
 * entry, but a dangerous one only when it is the only match or the arrows picked it (K-523). An entry with a
 * sub-list opens it as a second list; Escape or Backspace in an empty query goes back (U11).
 */
export function Palette(props: {
  initialQuery: string;
  /** Over 720 px; a phone gets a short hint that fits the field. */
  wide: boolean;
  onClose: () => void;
  entries: ReadonlyArray<PaletteEntry>;
}) {
  const [query, setQuery] = useState(props.initialQuery);
  const [cursor, setCursor] = useState<PaletteCursor>(fresh);
  /**
   * The keys of the entries whose second lists are open, the newest last. Keys, so that each list comes from the
   * current entries and a change on the map never leaves an older action to run.
   */
  const [path, setPath] = useState<ReadonlyArray<string>>([]);
  const pathNow = useRef(path);
  const open = listAt(props.entries, path);
  const entries = open ?? props.entries;
  const shownPath = open ? path : [];
  /** The labels of the open lists, for the line above the input. */
  const trail = shownPath.map(
    (_, depth) =>
      listAt(props.entries, shownPath.slice(0, depth))?.find((entry) => keyOf(entry) === shownPath[depth])
        ?.label,
  );
  // Events sent in one task (a script or an agent: input, ArrowDown, Enter) arrive before any render, so the
  // keys read the query and the cursor as the last key left them, not as the last render showed them.
  const live = useRef({ query: props.initialQuery, cursor: fresh });
  const moveCursor = (query: string, next: PaletteCursor) => {
    live.current = { query, cursor: next };
    setCursor(next);
  };
  const matches = matching(entries, query);
  const labels = matches.map(keyOf);
  const { index: active } = paletteActive(labels, cursor);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // `autoFocus` only sets the HTML attribute, which a browser applies at page load, not to a dialog opened
  // later; without this, ⌘K left the focus on the panel and the typing went nowhere. On close the focus goes
  // back to where it was.
  useLayoutEffect(() => {
    const before = document.activeElement;
    input.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const go = (next: ReadonlyArray<string>, query = "") => {
    setPath(next);
    setQuery(query);
    moveCursor(query, fresh);
    pathNow.current = next;
  };
  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    // "riffle her": "her" names an item of the second list, so it stays as the filter there, and Enter runs it.
    if ("items" in entry) {
      // Each word of the parent's label takes one word of the query, so "her share her" still filters by "her".
      const parent = entry.label.toLowerCase().split(/\s+/);
      const kept = live.current.query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => {
          const taken = parent.findIndex((part) => part.includes(word));
          if (word && taken >= 0) {
            parent.splice(taken, 1);
            return false;
          }
          return word && matching(entry.items, word).length > 0;
        });
      return go([...pathNow.current, keyOf(entry)], kept.join(" "));
    }
    props.onClose();
    entry.run();
  };
  return (
    <div
      class="scrim palette-scrim"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div class="dialog" role="dialog" aria-label="Command palette">
        {shownPath.length > 0 ? (
          <p class="help palette-path">{trail.join(" › ")} · Escape goes back.</p>
        ) : null}
        <input
          class="field"
          ref={input}
          aria-label="Find"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
          placeholder={
            shownPath.length > 0
              ? "Type to filter this list."
              : props.wide
                ? "Find a card, a circle or an action. Try “share”."
                : "Find a card or an action."
          }
          value={query}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setQuery(value);
            moveCursor(value, fresh);
          }}
          onKeyDown={(event) => {
            // A key that finishes an IME composition is the composition's, not the palette's.
            if (event.isComposing) return;
            if (event.key === "Escape") {
              if (shownPath.length > 0) go(shownPath.slice(0, -1));
              else props.onClose();
            } else if (event.key === "Backspace" && event.currentTarget.value === "" && shownPath.length > 0)
              go(shownPath.slice(0, -1));
            else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
              const now = event.currentTarget.value;
              const list = matching(listAt(props.entries, pathNow.current) ?? props.entries, now);
              const names = list.map(keyOf);
              const from = now === live.current.query ? live.current.cursor : fresh;
              if (event.key === "Enter") {
                const at = paletteActive(names, from);
                const index = paletteEnter(list, at.index, at.picked);
                run(index === null ? undefined : list[index]);
              } else moveCursor(now, paletteArrow(event.key, names, from));
            } else return;
            event.preventDefault();
          }}
        />
        <ul role="listbox" id={listId} aria-label="Matches">
          {matches.map((entry, index) => (
            <li
              key={keyOf(entry)}
              id={`${listId}-${index}`}
              role="option"
              data-tip={
                entry.danger && matches.length > 1
                  ? `${entry.tip} Pick it with the arrows or a click; Enter alone does not run it.`
                  : entry.tip
              }
              data-danger={entry.danger || undefined}
              aria-selected={index === active}
              onClick={() => run(entry)}
              onMouseEnter={() => moveCursor(query, { label: keyOf(entry), picked: false })}
            >
              {entry.label}
            </li>
          ))}
          {matches.length === 0 ? (
            <li role="option" aria-disabled="true" aria-selected="false">
              Nothing matches.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
