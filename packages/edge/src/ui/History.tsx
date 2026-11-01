import { type ComponentChildren, Fragment } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Author, Item, RevisionKind } from "../core/changes.ts";
import type { State, UndoSource } from "../core/model.ts";
import type { RevisionView } from "../core/protocol.ts";
import { CHECKING_TIP, type UndoAnswer } from "./actions.ts";
import {
  type HistoryFilter,
  actorKey,
  actorLabel,
  filterHistory,
  groupHistory,
  rowText,
  undoableRow,
} from "./revisions.ts";

/** K-1509: where a whole-revision Undo came from, as its History row says it. */
const UNDO_FROM: Record<UndoSource, string> = { toast: "the toast", history: "History", api: "the API" };
import { callApi } from "./store.ts";

const KIND_LABELS: Record<RevisionKind, { readonly label: string; readonly tip: string }> = {
  card: { label: "Cards", tip: "Cards: cards moved, also into or out of a circle." },
  share: { label: "Shares", tip: "Shares: the level and the end of a share, and a share that ended." },
  circle: {
    label: "Circles",
    tip: "Circles: new, changed and deleted circles, also a circle moved with its cards.",
  },
  stack: { label: "Stacks", tip: "Stacks: cards stacked, pulled out and unstacked." },
  app: { label: "Apps", tip: "Apps: apps removed and restored." },
  pause: { label: "Pause", tip: "Pause: the emergency pause, the lockdown and Resume." },
  action: {
    label: "Actions",
    tip: "Actions: records such as a command, a deploy or a sign-out, with nothing to undo.",
  },
};

const NO_FILTER: HistoryFilter = { kind: null, actor: null, item: "" };

const timeOf = (at: number, older: boolean) =>
  older
    ? new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * K-1508: every change in plain words, grouped by day and by who made it, with filters. A click on a row shows
 * its cards and circles on the map. Undo shows only on the caller's own newest change.
 */
export function HistoryView(props: {
  revisions: ReadonlyArray<RevisionView>;
  me: Author;
  state: State;
  onUndo: (id: number) => void;
  onShow: (revision: RevisionView) => void;
  /** K-1717: the asks of agents, shown after the changes. */
  askEvents?: ComponentChildren;
}) {
  const [filter, setFilter] = useState(NO_FILTER);
  const { state } = props;
  const nameOf = (item: Item) =>
    (item.kind === "card" ? state.resources.get(item.id)?.name : state.circles.get(item.id)?.name) ?? item.id;
  const groups = useMemo(
    () => groupHistory(filterHistory(props.revisions, filter, nameOf), Date.now()),
    [props.revisions, filter, state],
  );
  const undoable = undoableRow(props.revisions, props.me);
  /** A move that joins the row's revision (K-1505) changes its time, and its undo can change with it. */
  const undoableAt = props.revisions.find((revision) => revision.id === undoable)?.at ?? 0;
  /** kitshn's answer for the undoable row; null while it checks. */
  const [answer, setAnswer] = useState<{ readonly key: string; readonly answer: UndoAnswer } | null>(null);
  const undoKey = `${undoable}@${undoableAt}`;
  // Asks when History opens and when the caller's own newest revision changes; the undo itself checks again,
  // and closing and opening History asks again.
  useEffect(() => {
    if (undoable === null) return;
    let live = true;
    void callApi<UndoAnswer>("GET", `/api/undo?revision=${undoable}`).then((result) => {
      if (live)
        setAnswer({
          key: undoKey,
          answer: "error" in result ? { allowed: false, reason: result.error } : result,
        });
    });
    return () => {
      live = false;
    };
  }, [undoKey]);
  // A new row or a changed one shows "checking" until its own answer comes.
  const undoAnswer = answer?.key === undoKey ? answer.answer : null;
  const kinds = [...new Set(props.revisions.map((revision) => revision.kind))];
  const actors = [
    ...new Map(props.revisions.map((revision) => [actorKey(revision.actor), revision.actor])).values(),
  ];
  // Every kitshn reason groups as one actor "kitshn"; each row of it names its own reason.
  const who = (actor: Author) =>
    actor._tag === "kitshn" ? "kitshn" : actorKey(actor) === actorKey(props.me) ? "You" : actorLabel(actor);

  return (
    <div class="history-view">
      <p class="muted">
        Every change is one revision. Undo makes a new revision that reverses it. A click on a change shows
        its cards and circles on the map.
      </p>
      <div class="pills" role="group" aria-label="Kind of change">
        <button
          type="button"
          aria-pressed={filter.kind === null}
          data-tip="Every kind of change."
          onClick={() => setFilter({ ...filter, kind: null })}
        >
          All
        </button>
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={filter.kind === kind}
            data-tip={KIND_LABELS[kind].tip}
            onClick={() => setFilter({ ...filter, kind })}
          >
            {KIND_LABELS[kind].label}
          </button>
        ))}
      </div>
      <div class="pills" role="group" aria-label="Who made the change">
        <button
          type="button"
          aria-pressed={filter.actor === null}
          data-tip="Changes by anyone."
          onClick={() => setFilter({ ...filter, actor: null })}
        >
          Anyone
        </button>
        {actors.map((actor) => (
          <button
            key={actorKey(actor)}
            type="button"
            aria-pressed={filter.actor === actorKey(actor)}
            data-tip={`Only the changes by ${who(actor)}.`}
            onClick={() => setFilter({ ...filter, actor: actorKey(actor) })}
          >
            {who(actor)}
          </button>
        ))}
      </div>
      <input
        class="field"
        type="search"
        aria-label="Filter by card or circle"
        data-tip="Only the changes of a card or circle with these words in its name, or in the change."
        placeholder="Card or circle"
        value={filter.item}
        onInput={(event) => setFilter({ ...filter, item: event.currentTarget.value })}
        onKeyDown={(event) => {
          // Escape clears the search first; the panel closes on the next Escape outside the field.
          if (event.key === "Escape" && filter.item !== "") setFilter({ ...filter, item: "" });
        }}
      />
      {groups.length === 0 ? (
        <p class="muted">
          {props.revisions.length === 0 ? "No change yet." : "No change matches the filters."}
        </p>
      ) : null}
      {groups.map((group, index) => (
        <Fragment key={group.revisions[0]?.id}>
          {groups[index - 1]?.day !== group.day ? <h3 class="label history-day">{group.day}</h3> : null}
          <div class="history-group">
            <div class="history-actor">{who(group.actor)}</div>
            <ul>
              {group.revisions.map((revision) => {
                return (
                  <li key={revision.id} id={`rev-${revision.id}`}>
                    <button
                      type="button"
                      class="history-row"
                      data-tip={
                        revision.items.length > 0
                          ? "Show its cards and circles on the map."
                          : "This change has no card or circle to show."
                      }
                      onClick={() => props.onShow(revision)}
                    >
                      <span>{rowText(revision.summary)}</span>
                      <span class="muted">
                        <span class="mono">#{revision.id}</span> ·{" "}
                        {timeOf(revision.at, group.day === "Older")}
                        {revision.actor._tag === "kitshn" ? ` · ${revision.actor.reason}` : ""}
                        {revision.undoSource ? ` · from ${UNDO_FROM[revision.undoSource]}` : ""}
                      </span>
                    </button>
                    {revision.undoneBy !== null ? (
                      <span
                        class="stamp"
                        data-tip={`Undone: revision #${revision.undoneBy} reverses this one.`}
                      >
                        ✓ undone
                      </span>
                    ) : revision.id === undoable ? (
                      <button
                        type="button"
                        class="btn"
                        // Stays focusable while it checks or when refused, so its tooltip says why.
                        aria-disabled={undoAnswer?.allowed !== true || undefined}
                        data-tip={
                          undoAnswer === null
                            ? CHECKING_TIP
                            : undoAnswer.allowed
                              ? "Undo: a new revision that reverses this one."
                              : undoAnswer.reason
                        }
                        onClick={() => undoAnswer?.allowed && props.onUndo(revision.id)}
                      >
                        Undo
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </Fragment>
      ))}
      {props.askEvents}
    </div>
  );
}
