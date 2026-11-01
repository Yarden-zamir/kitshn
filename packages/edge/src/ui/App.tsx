import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Edit,
  type Item,
  type ShareDiff,
  applyChanges,
  isAppCard,
  resolveEdits,
  shareDiff,
} from "../core/changes.ts";
import {
  type Circle,
  type Level,
  RESOURCE_KINDS,
  type Resource,
  type ResourceKind,
  type Stack,
  type State,
  type PauseMode,
  type PauseReach,
  type Point,
  ADMIN_RESOURCE_ID,
  circlesHolding,
  insideCircle,
  isPublicCircle,
  memberLabel,
  pauseReach,
  shareKey,
  shareLevel,
  stackTitle,
  type UndoSource,
  type CardKind,
  type ProviderCard,
} from "../core/model.ts";
import type { ProviderCommand, ProviderSticker } from "@kitshn/local";
import { MAX_UPLOAD_BYTES, isLibraryId } from "../core/library.ts";
import {
  type Box,
  cardBox,
  circleBox,
  circleForCards,
  headAngle,
  headBox,
  placeInside,
  union,
} from "../core/place.ts";
import { awaitsAllow } from "../core/repos.ts";
import type { Command } from "../core/machine.ts";
import { ROLLBACK_DATA, RollbackDialog } from "./Rollback.tsx";
import { LogsDialog } from "./Logs.tsx";
import { hasLogs } from "../core/logs.ts";
import {
  BackupState,
  BackupsDialog,
  RESTORE_KEY,
  type RestoreWish,
  RestoreTimeDialog,
  backupLabel,
} from "./Backups.tsx";
import {
  type BackupRun,
  BACKUP_LIMIT_BYTES,
  type BucketSize,
  backupFailureShown,
  gigabytes,
} from "../core/backups.ts";
import type {
  AccessState,
  DeployNote,
  JobView,
  MachineView,
  OrphanWorker,
  RepoView,
  ProposalView,
  RevisionView,
  Snapshot,
} from "../core/protocol.ts";
import { CIRCLE_COLORS, KINDS, LEVEL_COLORS, MEMBER_ICONS, kindInfo } from "./kinds.ts";
import {
  CircleEditor,
  type DeviceSecret,
  EndsPicker,
  LEVEL_TIPS,
  LevelOverride,
  MEMBER_HELP,
  SecretDialog,
} from "./Circle.tsx";
import {
  ActionMenu,
  Menu,
  MenuItem,
  MenuSep,
  OverlayPanel,
  ResizeEdge,
  ToastView,
  TooltipLayer,
  WhyOff,
  useDialogEscape,
  useScreenWidth,
  useStoredWidth,
} from "./controls.tsx";
import { ItemIcon } from "./ItemIcon.tsx";
import { ProgressRow } from "./Progress.tsx";
import { FOLDER_SITE_PREFIX } from "../core/apps.ts";
import { peekable } from "./frames.ts";
import { type FolderFiles, droppedFolder, pickedFolder, uploadFolder } from "./folders.ts";
import { PeekRow } from "./Peek.tsx";
import {
  type Action,
  type ActionContext,
  type ActionHandlers,
  type MenuTarget,
  type UndoAnswer,
  type UndoCheck,
  actionsFor,
  itemKey,
  settleUndoCheck,
  slowUndoCheck,
  removeAppTip,
  LOGS_TIP,
  MACHINE_TIPS,
  levelEdit,
  paletteEntries,
  NEW_CIRCLE,
  ORGANIZE_TIP,
  TIME_PRESETS,
  untilText,
  reshareEdits,
  selectionActions,
  type StackPart,
  stackChoice,
  stackOntoEdits,
} from "./actions.ts";
import type { Rect } from "./popover.ts";
import { AddSite } from "./Add.tsx";
import { PortDoors, isPortCard } from "./Ports.tsx";
import { AddRepoGroup, GitHubDefaultWay, RepoGroupPanel, matchedCards } from "./RepoGroups.tsx";
import { Palette } from "./Palette.tsx";
import {
  LOCKDOWN_TIP,
  PAUSE_TIP,
  PanicOpener,
  PausedBanner,
  type PauseView,
  RESUME_TIP,
  SafetyView,
} from "./Pause.tsx";
import { playResumeSound, pressSound, showPanic, unlockAudio } from "./panic.ts";
import { GONE_STICKER, REPO_STICKERS, RepoList, setRepoState } from "./Repos.tsx";
import { AskEvents, LinkEvents, BotRuns, approveFromHash } from "./Asks.tsx";
import { PassSettingsPanel } from "./Passes.tsx";
import { LibraryView } from "./Library.tsx";
import { AddMachine, MachinePanel, MachinesView, queueJob, setAutoUpdate } from "./Machines.tsx";
import { ACCESS_TIPS, ALONE_KEY, MapView, type Selection, TrayCard, type View, measureMap } from "./Map.tsx";
import { type DropTarget, dropPlan, givesNoOne } from "./drop.ts";
import { joinPlan, leaveEdit, machineMember, memberKind } from "./members.ts";
import { connectChecklist, isNewMachine } from "./machine-signs.ts";
import { overlay } from "./held.ts";
import { HistoryView } from "./History.tsx";
import { UsageView } from "./Usage.tsx";
import { UptimeRow } from "./Uptime.tsx";
import { ReachList } from "./Reach.tsx";
import { NotificationsView } from "./Notifications.tsx";
import {
  fitMap,
  openArea,
  panInto,
  shownCardBoxes,
  type WidthLimits,
  shownWidths,
  toastPlace,
} from "./layout.ts";
import { actorLabel, undoneText } from "./revisions.ts";
import {
  type Connection,
  applyEdits,
  callApi,
  explainRefusal,
  hold,
  release,
  upload,
  toState,
  organizeMap,
  undoRevision,
  useStore,
  hiddenChecklists,
  setChecklistHidden,
} from "./store.ts";
import { whenText } from "./time.ts";

const PREVIEWS_KEY = "kitshn.previews";
/** The shelf folded or not, as the owner left it on this device; unset, it is open on a wide screen only. */
const SHELF_KEY = "kitshn.shelf";
/**
 * On a wide screen a saved view stays at least this close, so card names stay readable on a laptop. A fit
 * zooms out further when the map needs it (layout.ts fitMap).
 */
const FIT_MIN_SCALE = 0.85;
const wideScreen = () => innerWidth > 720;
/**
 * The toolbar width that holds every button in one row, measured with the labels of today. Known limit: a new
 * toolbar button or a longer label needs a new measure; revisit when the toolbar wraps at 1512 px with no panel.
 */
const TOOLBAR_FULL = 1400;
/** Below this width the tabs fold into "☰" too. Same limit as TOOLBAR_FULL. */
const TOOLBAR_TABS = 1010;
const UNDO_MS = 10_000;
/**
 * A press that started before the toast showed and ends on a toast button this soon after is the second press of the
 * button that made it; it does nothing. A press that starts on the toast always counts.
 */
const TOAST_GUARD_MS = 500;

interface Toast {
  readonly text: string;
  readonly error: boolean;
  readonly undo: number | null;
  /** More revisions that the same Undo takes back after `undo`, newest first (a drop of several files). */
  readonly alsoUndo?: ReadonlyArray<number>;
  /** The card that the change names; the toast keeps clear of it. Without one, of the last press or drop. */
  readonly card?: string | undefined;
  /** A way back that is not an undo, for example Resume after a pause (K-1504). */
  readonly action?: { readonly label: string; readonly tip: string; readonly run: () => void };
}

const VIEW_KEY = "kitshn.view";

/** K-514: this device's saved view, or null when it has none, so the map fits on load. */
const loadView = (): View | null => {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null") as View | null;
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite))
      return wideScreen() ? { ...saved, s: Math.max(saved.s, FIT_MIN_SCALE) } : saved;
  } catch {
    // A broken saved view falls back to a fit.
  }
  return null;
};

/** Typing in a field keeps its own Escape; a dialog takes it through `useDialogEscape`. */
const ownsEscape = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
  ) !== null;

const CONNECTION_TIPS: Record<Connection, string> = {
  connecting: "Connecting: the map opens a connection to kitshn.",
  live: "Live: the map shows each change at once.",
  offline: "Offline: kitshn is not reachable. The map tries again.",
  refused: "Refused: kitshn did not take the connection. The panel says why.",
};

const TABS = {
  map: "Map: circles say who, and a card inside a circle is shared with it. The panel shows what you select; after Close, this opens it again.",
  machines: "Machines: every machine and its status, in a panel over the map. Enlarge shows the full table.",
  library:
    "Library: every page and file, with a search, a preview and Delete, in a panel over the map. Enlarge shows the full table.",
  history:
    "History: every change as a sentence, with filters and Undo, in a panel over the map. Enlarge shows the full page.",
  usage: "Usage: how close the account is to the Cloudflare free plan limits, and how full each machine is.",
  notifications: "Notifications: what kitshn told you in the last 30 days, with Mute and Snooze.",
  settings: "Settings: the GitHub way of other owners, passes, and sign-out of every session.",
} as const;

/** K-516, K-519: what the overlay panel shows. History, Library, Machines and Usage also have a full view (a tab). */
/** "safety" is the big red button (K-1504) and "settings" the settings of the owner; like "details", they have no full view. */
type PanelKind =
  "details" | "safety" | "settings" | "history" | "library" | "machines" | "usage" | "notifications";
/** The panels without a full view of their own; Enlarge makes the panel large over the map. */
type NoTab = "details" | "safety" | "settings";

/** `html` font size in styles.css. */
const REM = 18;
/** K-525: the side panel and the shelf; the owner drags their edges, and each device keeps its widths. */
const PANEL_WIDTH: WidthLimits = { min: 18 * REM, max: 46 * REM, initial: 26 * REM };
const TRAY_WIDTH: WidthLimits = { min: 160, max: 420, initial: 210 };
const LIMITS = { panel: PANEL_WIDTH, tray: TRAY_WIDTH } as const;
const PANEL_HEADINGS: Record<Exclude<PanelKind, "details">, string> = {
  safety: "Big red button",
  settings: "Settings",
  history: "History",
  library: "Library",
  machines: "Machines",
  usage: "Usage",
  notifications: "Notifications",
};

/** A highlight from History shows this long, once (K-1508). */
const FLASH_MS = 1200;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const routeFromHash = (): {
  readonly tab: "map" | Exclude<PanelKind, NoTab>;
  readonly id: string;
} => {
  const [tab = "map", id = ""] = location.hash.slice(1).split("/");
  return {
    tab:
      tab === "history" ||
      tab === "machines" ||
      tab === "library" ||
      tab === "usage" ||
      tab === "notifications"
        ? tab
        : "map",
    id,
  };
};

export function App() {
  const store = useStore();
  const [selection, setSelection] = useState<Selection>({ cards: new Set(), circle: null });
  const [hidden, setHidden] = useState<ReadonlySet<CardKind>>(new Set());
  const [savedView] = useState(loadView);
  const [view, setView] = useState<View>(() => savedView ?? { x: 0, y: 0, s: 1 });
  /** K-514: once the owner pans or zooms, the map stops fitting on its own until the next load. */
  const userMoved = useRef(false);
  /** The first fit check ran; it fits only a device without a saved view. */
  const loaded = useRef(false);
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(new Set());
  const toggleStack = (key: string) => {
    const next = new Set(openStacks);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenStacks(next);
  };
  const [toast, setToast] = useState<(Toast & { readonly place: ReturnType<typeof toastPlace> }) | null>(
    null,
  );
  /** Where the last press or drop ended, for a toast that names no card. */
  const lastPressY = useRef(0);
  /** When the newest pointer press started, for the toast guard. */
  const pressStartedAt = useRef(0);
  /** The palette's first query, or null while it is closed. */
  const [palette, setPalette] = useState<string | null>(null);
  const [addingMachine, setAddingMachine] = useState(false);
  const [secret, setSecret] = useState<DeviceSecret | null>(null);
  const [rollback, setRollback] = useState<{ card: Resource; mode: "card" | "run" } | null>(null);
  const [logs, setLogs] = useState<Resource | null>(null);
  const [backupsCard, setBackupsCard] = useState<Resource | null>(null);
  const [restoringTime, setRestoringTime] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [trayFilter, setTrayFilter] = useState("");
  const [previews, setPreviews] = useState(() => localStorage.getItem(PREVIEWS_KEY) === "on");
  const [wantedPanel, setPanelWidth] = useStoredWidth("kitshn.panelWidth", PANEL_WIDTH);
  const [wantedTray, setTrayWidth] = useStoredWidth("kitshn.trayWidth", TRAY_WIDTH);
  const screenWidth = useScreenWidth();
  /** K-1131: the site wizard with its first address ("" when empty), or null while it is closed. */
  const [addingSite, setAddingSite] = useState<string | null>(null);
  const [addingRepoGroup, setAddingRepoGroup] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  /** Where the next upload of the file chooser lands: a map point, or null for the tray. */
  const uploadAt = useRef<Point | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  /** K-1129: what the next folder of the folder chooser becomes: a new site, or a new version of a card. */
  const folderTarget = useRef<{ readonly at: Point | null } | { readonly card: Resource } | null>(null);
  /** K-110: a sign-out or its retry waits for Cloudflare; the server also runs one at a time. */
  const [signingOut, setSigningOut] = useState(false);
  const [menu, setMenu] = useState<{ readonly target: MenuTarget; readonly anchor: Rect } | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  useDialogEscape(confirm ? () => (confirm.resolve(false), setConfirm(null)) : null);
  const [route, setRoute] = useState(routeFromHash);
  /** The panel over the map, or null when closed. */
  // A phone opens on the map alone; its panel is a sheet that would cover half of it.
  const [panel, setPanel] = useState<PanelKind | null>(() => (wideScreen() ? "details" : null));
  /** The details panel in its full view; History, Library and Machines use their tab for that. */
  const [detailsLarge, setDetailsLarge] = useState(false);
  /** K-1508: `itemKey`s of the cards and circles that a History row highlights now. */
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const flashTimer = useRef<number | null>(null);
  const escapeRef = useRef<() => void>(() => undefined);
  /** The anchor of the open "Show" menu of kinds, or null. */
  const [showMenu, setShowMenu] = useState<Rect | null>(null);
  /** K-528: the phone's "☰" menu, which holds the tabs and the map tools that the toolbar has on a wide screen. */
  const [moreMenu, setMoreMenu] = useState<Rect | null>(null);
  /** K-509, K-528: folded, the shelf shows only its count; on a phone it is a sheet. */
  const [shelfChoice, setShelfChoice] = useState(() => localStorage.getItem(SHELF_KEY));
  const [refusal, setRefusal] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const toastShownAt = useRef(0);
  const fitRef = useRef<(() => void) | null>(null);

  // The map shows held edits on top of the server state, so a drop never jumps back (see held.ts).
  const state = useMemo(
    () => (store.snapshot ? overlay(toState(store.snapshot), store.held) : null),
    [store.snapshot, store.held],
  );
  const pausedBy = store.snapshot?.pausedBy ?? null;
  const pauseView: PauseView | null = store.snapshot?.paused
    ? {
        mode: store.snapshot.paused,
        by: pausedBy ? actorLabel(pausedBy.actor) : null,
        at: pausedBy?.at ?? null,
      }
    : null;
  // K-1504: the counts of the paused banner, only while paused; the Safety panel counts while it shows.
  const pausedReach = useMemo(
    () => (state && store.snapshot?.paused ? pauseReach(state, Date.now()) : null),
    [state, store.snapshot?.paused],
  );
  const reachNow = (): PauseReach => {
    if (!state) throw new Error("The pause counts need the map state.");
    return pauseReach(state, Date.now());
  };
  const machines = useMemo(
    () => new Map((store.snapshot?.machines ?? []).map((view) => [view.machine.id, view])),
    [store.snapshot],
  );
  const deployed = useMemo(() => new Set(store.snapshot?.deployedCards ?? []), [store.snapshot]);
  const previewCards = useMemo(() => new Set(store.snapshot?.previewCards ?? []), [store.snapshot]);
  const pullRequests = store.snapshot?.pullRequests ?? {};
  const previousVersions = useMemo(() => new Set(store.snapshot?.previousVersions ?? []), [store.snapshot]);
  const handoverCards = useMemo(() => new Set(store.snapshot?.handoverCards ?? []), [store.snapshot]);
  const folderSites = useMemo(() => new Set(store.snapshot?.folderSites ?? []), [store.snapshot]);

  /**
   * K-523, K-1507: the item whose per-item undo the open menu shows, or for the palette the selected card or
   * circle. Other items get no undo entry, so the palette sends one request, not one per item.
   */
  const undoItemOf: Item | null =
    menu?.target._tag === "card" || menu?.target._tag === "circle"
      ? { kind: menu.target._tag, id: menu.target.id }
      : palette !== null && selection.circle !== null
        ? { kind: "circle", id: selection.circle }
        : palette !== null && selection.cards.size === 1
          ? { kind: "card", id: [...selection.cards][0] ?? "" }
          : null;
  const undoKey = undoItemOf ? itemKey(undoItemOf) : null;
  const [undoCheck, setUndoCheck] = useState<UndoCheck | null>(null);
  // Asks the server when a menu or the palette opens, and again when a new revision arrives while it is open;
  // an answer for a closed menu or another item is dropped.
  const newestRevision = store.snapshot?.revision ?? 0;
  useEffect(() => {
    if (undoItemOf === null || undoKey === null) {
      setUndoCheck(null);
      return;
    }
    setUndoCheck((check) => (check?.key === undoKey ? check : { key: undoKey, answer: null, slow: false }));
    // Each request is live until this effect ends, so an answer from an earlier opening is dropped.
    let live = true;
    const slow = setTimeout(() => setUndoCheck((check) => slowUndoCheck(check, undoKey)), 150);
    void callApi<UndoAnswer>(
      "GET",
      `/api/undo-item?kind=${undoItemOf.kind}&id=${encodeURIComponent(undoItemOf.id)}`,
    ).then((answer) => {
      clearTimeout(slow);
      if (!live) return;
      setUndoCheck((check) =>
        settleUndoCheck(
          check,
          undoKey,
          "error" in answer ? { allowed: false, reason: answer.error } : answer,
        ),
      );
    });
    return () => {
      live = false;
      clearTimeout(slow);
    };
  }, [undoKey, newestRevision]);

  useEffect(() => {
    const onHash = () => {
      const next = routeFromHash();
      setRoute(next);
      setMenu(null);
      // K-519: `#map/<card id>` selects the card and shows its panel.
      if (next.tab === "map" && next.id) {
        setSelection({ cards: new Set([next.id]), circle: null });
        setPanel("details");
      }
    };
    if (location.hash.startsWith("#map/")) onHash();
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => (open === null ? "" : null));
      } else if (event.key === "Escape" && !ownsEscape(event.target)) escapeRef.current();
    };
    // A file dropped outside the map would make the browser open it and leave kitshn.
    const keepFiles = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    // K-1504: Access sends the owner back here after the fresh passkey check of "Resume".
    if (location.hash === "#resume") void finishResume();
    if (location.hash === "#restore-time") void finishRestoreTime();
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    const notePress = (event: MouseEvent) => {
      lastPressY.current = event.clientY;
    };
    addEventListener("pointerup", notePress, true);
    const notePressStart = () => {
      pressStartedAt.current = Date.now();
    };
    addEventListener("pointerdown", notePressStart, true);
    // A drag of files ends in `drop`, with no `pointerup`.
    addEventListener("drop", notePress, true);
    addEventListener("dragover", keepFiles);
    addEventListener("drop", keepFiles);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
      removeEventListener("pointerup", notePress, true);
      removeEventListener("pointerdown", notePressStart, true);
      removeEventListener("drop", notePress, true);
      removeEventListener("dragover", keepFiles);
      removeEventListener("drop", keepFiles);
    };
  }, []);

  useEffect(() => {
    if (store.connection === "refused" || (store.connection === "offline" && !store.snapshot)) {
      void explainRefusal().then(setRefusal);
    }
  }, [store.connection, store.snapshot]);

  const changeView = (next: View) => {
    setView(next);
    localStorage.setItem(VIEW_KEY, JSON.stringify(next));
  };

  /** The control that opened the panel; Close and Escape give it the focus back. */
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = () => {
    const active = document.activeElement;
    // A control inside the panel goes when the panel changes, so the control that opened the panel stays.
    if (active instanceof HTMLElement && active !== document.body && !active.closest(".overlay-panel"))
      opener.current = active;
  };

  /** Selects cards or a circle; a selection shows its details in the panel. */
  const select = (next: Selection) => {
    setSelection(next);
    if (next.cards.size > 0 || next.circle !== null) {
      if (panel !== "details") rememberOpener();
      setPanel("details");
    }
  };

  /**
   * K-204, K-210: the circles of a drop point, which every dropped card lands in exactly, also when several fan out.
   * Null when a public circle is there and the owner says no.
   */
  const confirmPublic = async (at: Point, what: string | undefined) => {
    const circles = [...(state?.circles.values() ?? [])];
    const wanted = new Set(circles.filter((circle) => insideCircle(at, circle)).map((circle) => circle.id));
    const publicHere = circles.filter((circle) => wanted.has(circle.id) && isPublicCircle(circle));
    if (publicHere.length === 0) return wanted;
    const where = publicHere.map((circle) => circle.name).join(", ");
    return (await ask(`This makes ${what} public in ${where}. Anyone with the address can open it.`))
      ? wanted
      : null;
  };

  /**
   * K-1101: uploads one file after the other. With `at` (a drop on the map), the cards land there and so get
   * the shares of the circles around that point; a public circle asks first (K-210). Without, they wait
   * in the tray, private.
   */
  const uploadFiles = async (files: Array<File>, at: Point | null) => {
    const tooBig = files.filter((file) => file.size > MAX_UPLOAD_BYTES);
    const fitting = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    const refused =
      tooBig.length > 0
        ? `${tooBig.map((file) => file.name).join(", ")}: kitshn takes at most 100 MB a file.`
        : "";
    if (fitting.length === 0 || !state) {
      if (refused) showToast({ text: refused, error: true, undo: null });
      return;
    }
    const wanted = at
      ? await confirmPublic(at, fitting.length === 1 ? fitting[0]?.name : plural(fitting.length, "file"))
      : new Set<string>();
    if (wanted === null) return;
    const added: Array<{ id: string; revision: number }> = [];
    const errors: Array<string> = [];
    for (const [index, file] of fitting.entries()) {
      const spot = at ? { x: at.x + (index % 2) * 30, y: at.y + index * 90 } : null;
      const point = spot && at ? (placeInside(state, spot, wanted) ?? at) : null;
      const step = `${index + 1} of ${fitting.length}: ${file.name}`;
      setProgress(`Uploading ${step}`);
      const result = await upload(file, point, (fraction) =>
        setProgress(`Uploading ${step} · ${Math.round(fraction * 100)}%`),
      );
      if ("error" in result) errors.push(result.error);
      else added.push(result);
    }
    setProgress(null);
    if (added.length > 0) select({ cards: new Set(added.map((item) => item.id)), circle: null });
    const done =
      added.length === 0
        ? ""
        : at
          ? `Added ${plural(added.length, "card")} where you dropped them.`
          : `Uploaded ${plural(added.length, "file")}. They wait in the tray, private.`;
    // K-503: a drop changes shares, so one Undo takes back the whole drop, newest first.
    const [last, ...earlier] = at ? added.map((item) => item.revision).reverse() : [];
    showToast({
      text: [done, ...errors, refused].filter(Boolean).join(" "),
      error: errors.length > 0 || refused !== "",
      undo: last ?? null,
      alsoUndo: earlier,
    });
  };

  /** K-521, K-522: stack actions; each is one revision through `commit`, so a public circle asks first. */
  const stacks: StackActions = {
    stackOnto: async (ids, target) => {
      if (!state) return;
      const plan = stackOntoEdits(state, ids, target, `s-${crypto.randomUUID().slice(0, 8)}`);
      if (!plan) return;
      if ("refused" in plan) {
        showToast({ text: plan.refused, error: true, undo: null });
        return;
      }
      await commit(
        plan.edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))),
        plan.done,
      );
    },
    pullOut: async (stackId, id) => {
      const stack = state?.stacks.get(stackId);
      const place = state?.places.get(id);
      if (!state || !stack || !place) return;
      const rest = stack.members.filter((member) => member !== id);
      const wanted = new Set(circlesHolding(state, id).map((circle) => circle.id));
      // Next to the stack, in the same circles, so pulling a card out changes no share.
      const after = placeInside(state, { x: place.x + 230, y: place.y }, wanted) ?? place;
      const edits: Array<Edit> = [
        { _tag: "stack", id: stackId, after: rest.length > 1 ? { ...stack, members: rest } : null },
        { _tag: "place", id, after },
      ];
      await commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Pulled ${state.resources.get(id)?.name ?? "the card"} out of ${stackTitle(state, stack)}.`,
      );
    },
    unstack: async (stackId) => {
      const stack = state?.stacks.get(stackId);
      if (!state || !stack) return;
      const first = state.places.get(stack.members[0] ?? "");
      if (!first) return;
      const wanted = new Set(circlesHolding(state, stack.members[0] ?? "").map((circle) => circle.id));
      const edits: Array<Edit> = [
        { _tag: "stack", id: stackId, after: null },
        ...stack.members.slice(1).map((id, index): Edit => ({
          _tag: "place",
          id,
          after: placeInside(state, { x: first.x, y: first.y + (index + 1) * 100 }, wanted) ?? first,
        })),
      ];
      await commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Unstacked ${stackTitle(state, stack)}.`,
      );
    },
    rename: async (stackId, name) => {
      const stack = state?.stacks.get(stackId);
      const next = name.trim().slice(0, 80);
      if (!stack || next === stack.name) return;
      await commit(
        [{ _tag: "stack", id: stackId, after: { ...stack, name: next } }],
        [],
        next ? `Renamed the stack to ${next}.` : "The stack has no name now.",
      );
    },
  };

  /**
   * K-509, K-522: a drop of cards after a drag, from the map or from the tray: `dropPlan` says what it does, `commit`
   * asks first for a public circle (K-210) and shows Undo. Cards from the tray stay selected where they land.
   */
  const drop = async (moves: ReadonlyMap<string, Point>, target: DropTarget) => {
    if (!state) return;
    const plan = dropPlan(state, moves, target, `s-${crypto.randomUUID().slice(0, 8)}`);
    if (!plan) return;
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    if (plan.ask && !(await ask(plan.ask))) return;
    await commit(
      plan.edits,
      shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))),
      plan.done,
      {
        ...(plan.note ? { note: plan.note } : {}),
        ...(plan.rightsIn ? { action: openRights(plan.rightsIn) } : {}),
      },
    );
    const fresh = [...moves.keys()].filter((id) => !state.places.has(id));
    if (fresh.length > 0 && (target._tag === "map" || target._tag === "card"))
      select({ cards: new Set(fresh), circle: null });
  };

  /** K-539: the toast's way from a new member to its rights, which the panel of its circle holds. */
  const openRights = (circle: string) => ({
    label: "Open rights",
    tip: "Open the circle's panel, where each machine has its rights.",
    run: () => select({ cards: new Set(), circle }),
  });

  /** K-539: a machine joins a circle without a drag: from its menu, its panel, the circle's panel or the palette. */
  const joinCircle = async (machine: Resource, circle: Circle) => {
    if (!state) return;
    const plan = joinPlan(state, [machine.id], circle);
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    if (plan.ask && !(await ask(plan.ask))) return;
    await commit(plan.edits, [], plan.done, plan.rightsIn ? { action: openRights(plan.rightsIn) } : {});
  };

  const leaveCircle = (machine: Resource, circle: Circle) =>
    void commit([leaveEdit(circle, machine.id)], [], `${machine.name} left ${circle.name}.`);

  /** Selects an item and puts the focus into an input of its panel, after the panel renders. */
  const selectAndFocus = (next: Selection, selector: string) => {
    select(next);
    location.hash = "map";
    queueMicrotask(() => setTimeout(() => document.querySelector<HTMLInputElement>(selector)?.focus()));
  };

  /** Opens the circle editor with its Add member input ready. */
  const addMemberTo = (circleId: string) =>
    selectAndFocus({ cards: new Set(), circle: circleId }, ".add-member input");

  /**
   * K-1504: one press pauses everything at once, with no confirm. The thunk plays at once; the klaxon and the
   * effects play only when this press made the pause, not for a second press or a refusal.
   */
  const pauseNow = async (mode: PauseMode) => {
    pressSound();
    const result = await applyEdits([{ _tag: "pause", after: mode }]);
    if (!result.ok) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    // A second press replaces the first toast, so it keeps the way back too.
    const resume = { label: "Resume with passkey", tip: RESUME_TIP, run: startResume };
    if (result.revision === null) {
      showToast({
        text: mode === "lockdown" ? "Already locked down." : "Already paused.",
        error: false,
        undo: null,
        action: resume,
      });
      return;
    }
    showPanic(mode === "lockdown" ? "lockdown" : "paused");
    showToast({
      text:
        mode === "lockdown"
          ? "Locked down. Only the Owner circle's people open the admin; public sites are closed too."
          : "Paused. Only the Owner circle's people open the admin; public sites stay open.",
      error: false,
      undo: null,
      action: resume,
    });
  };

  /** Resume needs a fresh passkey: Access checks it on `/api/fresh` and sends the owner back to `#resume`. */
  const startResume = () => location.assign("/api/fresh/start");

  const finishResume = async () => {
    history.replaceState(null, "", location.pathname + location.search);
    // MM-712: a link alone never resumes; the owner confirms once more after the passkey check.
    if (!(await ask("Your passkey check passed. Resume everything now? Every share comes back."))) return;
    unlockAudio();
    const result = await callApi<{ revision: number | null }>("POST", "/api/fresh/resume", {});
    if (!("error" in result)) playResumeSound();
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: "Resumed. Every share is back.", error: false, undo: null },
    );
  };

  /**
   * K-1722, K-1723: Access sends an approver back here with the proposal and the hash of the text that the button
   * showed. A link alone never approves: the approver reads the full text of the map's own snapshot once more, and a
   * text that differs from the hash stops it.
   */
  const pendingApprove = useRef(approveFromHash(location.hash));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once the first snapshot arrives
  useEffect(() => {
    const pending = pendingApprove.current;
    if (pending === null || !store.snapshot || !state) return;
    pendingApprove.current = null;
    void finishApprove(pending);
  }, [store.snapshot]);

  const finishApprove = async ({ id, seen }: { readonly id: string; readonly seen: string }) => {
    history.replaceState(null, "", location.pathname + location.search);
    const proposal = store.snapshot?.proposals.find((each) => each.id === id);
    if (!proposal) return showToast({ text: "This ask is no longer open.", error: true, undo: null });
    if (proposal.shownHash !== seen)
      return showToast({
        text: "This ask changed since you opened it. Read it again in the Inbox.",
        error: true,
        undo: null,
      });
    const kind = state?.circles.get(proposal.circleId)?.needsPasskey ? "passkey" : "login";
    if (
      !(await ask(
        `Approve this ask of ${proposal.machineName}? kitshn runs it at once:\n\n${proposal.shown}`,
      ))
    )
      return;
    const result = await callApi<{ result: unknown }>(
      "POST",
      `/api/approve/${kind}/${encodeURIComponent(id)}`,
      { hash: seen },
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: "Approved. kitshn ran the ask.", error: false, undo: null },
    );
  };

  /** K-1822: Access sends the owner back to `#restore-time` after the passkey check; the confirm names the time. */
  const finishRestoreTime = async () => {
    history.replaceState(null, "", location.pathname + location.search);
    const stored = sessionStorage.getItem(RESTORE_KEY);
    sessionStorage.removeItem(RESTORE_KEY);
    if (stored === null) return;
    const wish = JSON.parse(stored) as RestoreWish;
    const sure = await ask(
      `Restore kitshn to ${wish.label}? Cards, circles, shares, History, rollbacks, jobs and repos go back to then. What changed outside kitshn since then stays: a machine that joined later loses its card, a removed machine comes back, and deploy files that R2 already deleted stay gone. A second restore undoes it.`,
    );
    if (!sure) return;
    // The object names the time in History itself; the label here is for the confirm only.
    const result = await callApi<{ undo: string; warning?: string }>(
      "POST",
      "/api/fresh/restore-time",
      "at" in wish ? { at: wish.at } : { bookmark: wish.bookmark },
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: result.warning ?? `kitshn is back at ${wish.label}.`, error: false, undo: null },
    );
  };

  /** K-1817: "Back up now". */
  const backUpNow = async (resource: Resource) => {
    const result = await callApi<{ run: string }>(
      "POST",
      `/api/apps/${encodeURIComponent(resource.id)}/backups`,
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `The backup of ${resource.name} is queued.`, error: false, undo: null },
    );
  };

  const pressBeforeToast = () =>
    pressStartedAt.current < toastShownAt.current && Date.now() - toastShownAt.current < TOAST_GUARD_MS;

  const showToast = (next: Toast) => {
    toastShownAt.current = Date.now();
    const card = next.card ? document.querySelector(`[data-card="${CSS.escape(next.card)}"]`) : null;
    const rect = card?.getBoundingClientRect();
    const sheet = wideScreen() ? null : document.querySelector(".overlay-panel:not(.large)");
    const area = {
      top: document.querySelector("header.bar")?.getBoundingClientRect().bottom ?? 0,
      bottom:
        sheet?.getBoundingClientRect().top ??
        (wideScreen() ? document.querySelector(".hint")?.getBoundingClientRect().top : undefined) ??
        innerHeight,
    };
    setToast({
      ...next,
      place: toastPlace(rect ? rect.top + rect.height / 2 : lastPressY.current, area, innerHeight),
    });
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), UNDO_MS);
  };

  // A new question cancels an open one, so the edit that waits on it is released.
  const ask = (text: string) =>
    new Promise<boolean>((resolve) => {
      confirm?.resolve(false);
      setConfirm({ text, resolve });
    });

  /** Sends edits. K-210: a card that enters a public circle asks first. K-503: a share change shows Undo. */
  const commit = async (
    edits: Array<Edit>,
    diffs: Array<ShareDiff>,
    done?: string,
    /** K-539: a line after the share changes, and a next step on the toast. */
    extra?: { readonly note?: string; readonly action?: NonNullable<Toast["action"]> },
  ) => {
    const goingPublic = diffs.filter((diff) => diff.to && !diff.from && isPublicCircle(diff.circle));
    const placed = edits.find((edit) => edit._tag === "place")?.id;
    // The drop stays where the owner let go while they answer; Cancel puts it back.
    const requestId = hold(edits);
    if (goingPublic.length > 0) {
      const names = [...new Set(goingPublic.map((diff) => diff.resource.name))].join(", ");
      if (!(await ask(`This makes ${names} public. Anyone with the address can open it.`))) {
        release(requestId);
        return;
      }
    }
    const result = await applyEdits(edits, requestId);
    if (!result.ok) showToast({ text: result.error, error: true, undo: null });
    else if (diffs.length > 0) {
      const text = diffs
        .slice(0, 2)
        .map((diff) =>
          diff.to
            ? (givesNoOne(diff.resource, diff.circle, state ?? { machines: new Map(), actors: new Map() }) ??
              `Shared ${diff.resource.name} with ${diff.circle.name} · ${diff.to}`)
            : `Removed ${diff.resource.name} from ${diff.circle.name}`,
        )
        .join(". ");
      const shared = diffs.length > 2 ? `${text}. And ${diffs.length - 2} more.` : text;
      showToast({
        text: extra?.note ? `${shared}. ${extra.note}` : shared,
        error: false,
        undo: result.revision,
        card: diffs[0]?.resource.id,
        ...(extra?.action ? { action: extra.action } : {}),
      });
    } else if (done)
      showToast({
        text: done,
        error: false,
        undo: result.revision,
        card: placed,
        ...(extra?.action ? { action: extra.action } : {}),
      });
  };

  const undo = async (revision: number, source: UndoSource) => {
    const result = await undoRevision(revision, source);
    showToast(
      result.ok
        ? {
            text: [`${result.summary ? undoneText(result.summary) : "Undone"}.`, ...result.notes].join(" "),
            error: false,
            undo: result.revision,
          }
        : { text: result.error, error: true, undo: null },
    );
  };

  /** K-1507: undoes the caller's own newest change to one card or circle. */
  const undoItem = async (item: Item) => {
    const result = await callApi<{
      revision: number | null;
      notes: ReadonlyArray<string>;
      summary: string | null;
    }>("POST", "/api/undo-item", {
      item,
    });
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text: [`${result.summary ? undoneText(result.summary) : "Undone"}.`, ...result.notes].join(" "),
            error: false,
            undo: result.revision,
          },
    );
  };

  /** K-909: deletes what a removed Worker app left; the label names it, and Undo cannot bring it back. */
  const deleteOrphanWorker = async (orphan: OrphanWorker) => {
    const result = await callApi<{ deleted: ReadonlyArray<string> }>(
      "DELETE",
      `/api/worker-storage/${encodeURIComponent(orphan.card)}`,
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `Deleted ${result.deleted.join(", ")}.`, error: false, undo: null },
    );
  };

  /** K-909: no confirm; the toast and History undo it. */
  /** K-1117: no undo of its own: a second restore swaps the versions back, and History records each. */
  /** K-1120: a new address name for a page or a file; History and Undo hold the change. */
  const setAddress = async (resource: Resource, name: string) => {
    const result = await callApi<{ address: string; revision: number | null }>(
      "POST",
      `/api/cards/${encodeURIComponent(resource.id)}/address`,
      { address: name },
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `${resource.name} is now at ${result.address}.`, error: false, undo: result.revision },
    );
    return !("error" in result);
  };

  /** K-1128: adds or removes a redirect address of a site card. */
  const changeRedirect = async (resource: Resource, address: string, remove: boolean) => {
    const path = `/api/cards/${encodeURIComponent(resource.id)}/redirects`;
    const result = remove
      ? await callApi<{ address: string }>("DELETE", `${path}/${encodeURIComponent(address)}`)
      : await callApi<{ address: string }>("POST", path, { address });
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text: remove
              ? `${result.address} no longer sends visitors on to ${resource.name}.`
              : `${result.address} sends visitors on to ${resource.name} once its domain is up.`,
            error: false,
            undo: null,
          },
    );
    return !("error" in result);
  };

  const restorePrevious = async (resource: Resource) => {
    const result = await callApi<{ revision: number }>(
      "POST",
      `/api/library/${encodeURIComponent(resource.id)}/previous`,
      {},
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `Restored the previous version of ${resource.name}.`, error: false, undo: null },
    );
  };

  const removeApp = async (resource: Resource) => {
    const result = await callApi<{ revision: number | null; notes: ReadonlyArray<string> }>(
      "DELETE",
      `/api/apps/${encodeURIComponent(resource.id)}`,
    );
    if ("error" in result) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    setSelection({ cards: new Set(), circle: null });
    showToast({
      text: [`Removed ${resource.name}.`, ...result.notes].join(" "),
      error: false,
      undo: result.revision,
    });
  };

  /** K-717: History records it; the server checks control on the card. */
  const setCardSetting = async (card: Resource, key: string, value: string) => {
    const result = await callApi<{ ok: true }>("POST", `/api/cards/${encodeURIComponent(card.id)}/settings`, {
      key,
      value,
    });
    if ("error" in result) showToast({ text: result.error, error: true, undo: null });
  };

  const takeAddress = async (resource: Resource) => {
    const site = resource.provider?.site;
    const address = resource.addresses[0] ?? (site ? `${site}.${store.snapshot?.zone ?? ""}` : "its address");
    if (
      !(await ask(
        `${resource.name} will answer at ${address} through kitshn. Progress shows on the card. This needs a T3 that takes kitshn audiences.`,
      ))
    )
      return;
    const result = await callApi<object>(
      "POST",
      `/api/cards/${encodeURIComponent(resource.id)}/take-address`,
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `kitshn takes over the address of ${resource.name}.`, error: false, undo: null },
    );
  };

  const giveAddressBack = async (resource: Resource) => {
    if (
      !(await ask(
        `Give the address of ${resource.name} back? Its DNS record points at what served it before, and kitshn lets go. Do this only while that still serves the address.`,
      ))
    )
      return;
    const result = await callApi<object>(
      "POST",
      `/api/cards/${encodeURIComponent(resource.id)}/give-address-back`,
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `Gave the address of ${resource.name} back.`, error: false, undo: null },
    );
  };

  /** K-704: no confirm; the toast and History undo it. */
  const forgetProvider = async (machineId: string, provider: string, card: Resource | null) => {
    const result = await callApi<{ revision: number | null }>(
      "POST",
      `/api/machines/${encodeURIComponent(machineId)}/providers/${encodeURIComponent(provider)}/forget`,
      { card: card?.id ?? null },
    );
    if ("error" in result) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    setSelection({ cards: new Set(), circle: null });
    showToast({
      text: card ? `Forgot ${card.name}.` : `Forgot the provider ${provider} and its cards.`,
      error: false,
      undo: result.revision,
    });
  };

  const fullPage = route.tab !== "map";
  const shownPanel: PanelKind | null = fullPage ? route.tab : panel;
  const large =
    fullPage || ((panel === "details" || panel === "safety" || panel === "settings") && detailsLarge);
  /** The panel floats over the map, so the map keeps its width and fit and pan leave its part free. */
  const floating = shownPanel !== null && !large;

  const ready = state !== null;
  // K-514: fits on load without a saved view, and when the panel opens or closes until the owner pans or zooms.
  useEffect(() => {
    if (!ready) return;
    const first = !loaded.current;
    loaded.current = true;
    if (first ? savedView === null : !userMoved.current) fitRef.current?.();
  }, [ready, floating]);

  // History renders only when its data changes, not on each pan of the map; its callbacks read the latest ones.
  const historyShow = useRef<(revision: RevisionView) => void>(() => undefined);
  const historyUndo = useRef<(id: number) => void>(() => undefined);
  const historyView = useMemo(
    () =>
      state && store.snapshot ? (
        <HistoryView
          revisions={store.snapshot.revisions}
          me={store.snapshot.me}
          state={state}
          onUndo={(id) => historyUndo.current(id)}
          onShow={(revision) => historyShow.current(revision)}
          askEvents={
            <>
              <AskEvents events={store.snapshot.askEvents} />
              <LinkEvents events={store.snapshot.linkEvents} />
            </>
          }
        />
      ) : null,
    [store.snapshot, state],
  );

  /**
   * K-519: the toolbar's bottom, for the tray and the full view below it (styles.css `--bar-bottom`), and the
   * hint line's height, so a toast sits above it (`--hint-height`; 0 when the hint is hidden on a phone).
   */
  const [barRef, hintRef] = useMemo(() => {
    const measured = (property: string, measure: (rect: DOMRect) => number) => {
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries)
          document.documentElement.style.setProperty(
            property,
            `${Math.round(measure(entry.target.getBoundingClientRect()))}px`,
          );
      });
      return (element: HTMLElement | null) => {
        if (!element) return;
        observer.observe(element);
        return () => observer.unobserve(element);
      };
    };
    return [
      measured("--bar-bottom", (rect) => rect.bottom),
      measured("--hint-height", (rect) => rect.height),
    ];
  }, []);

  if (!state || !store.snapshot) {
    return (
      <div class="center">
        <div class="card">
          <h2>kitshn</h2>
          <p class="muted">
            {refusal ??
              store.reason ??
              (store.connection === "offline"
                ? "kitshn is not reachable. Trying again."
                : "Opening the map.")}
          </p>
        </div>
      </div>
    );
  }

  const tray = [...state.resources.values()].filter((resource) => !state.places.has(resource.id));
  const trayShown = tray.length > 0 && route.tab === "map";
  const wide = screenWidth > 720;
  const trayOpen = shelfChoice === null ? wide : shelfChoice === "open";
  const toggleTray = () => {
    const next = trayOpen ? "closed" : "open";
    localStorage.setItem(SHELF_KEY, next);
    setShelfChoice(next);
  };
  /** K-525: the widths that show leave room for each other and for the map; a phone keeps its own layout. */
  const widthsFor = (panel: number, shelf: number) =>
    shownWidths(
      screenWidth,
      { panel: floating ? panel : null, tray: trayShown && trayOpen ? shelf : null },
      LIMITS,
    );
  const widths = widthsFor(wantedPanel, wantedTray);
  /**
   * Below TOOLBAR_FULL, the map tools, the waiting repos and the title fold into "☰", so the toolbar stays one row
   * also beside a floating panel. A phone always folds them, with the tabs.
   */
  const barWidth = screenWidth - 20 - (floating ? widths.panel + 14 : 0);
  const foldTools = !wide || barWidth < TOOLBAR_FULL;
  // Resume takes room in the toolbar while paused.
  const foldTabs = !wide || barWidth < TOOLBAR_TABS + (pauseView ? 100 : 0);
  // The page's CSS reads these, also outside this tree's elements; a drag sets them alone until it ends.
  if (wide) {
    document.documentElement.style.setProperty("--panel-width", `${widths.panel || wantedPanel}px`);
    document.documentElement.style.setProperty("--tray-width", `${widths.tray || wantedTray}px`);
  } else {
    document.documentElement.style.removeProperty("--panel-width");
    document.documentElement.style.removeProperty("--tray-width");
  }
  /** The left edge of the overlay panel on a wide screen, for a panel `width` wide. */
  const panelLeft = (width = widths.panel || wantedPanel) =>
    innerWidth - 12 - Math.min(width, innerWidth - 24);
  const shownTray = tray
    .filter((resource) =>
      `${resource.name} ${resource.kind} ${kindInfo(resource).name} ${resource.addresses[0] ?? ""}`
        .toLowerCase()
        .includes(trayFilter.trim().toLowerCase()),
    )
    .reverse();
  /** K-509: the shelf of new cards. The map draws it, so its cards drag, drop and open menus as map cards do. */
  const trayView = (dragging: ReadonlySet<string>) => (
    <aside class={`tray${trayOpen ? "" : " closed"}`}>
      {wide && trayOpen ? (
        <ResizeEdge
          label="Shelf width"
          width={widths.tray}
          limits={TRAY_WIDTH}
          grows="right"
          cssVar="--tray-width"
          fit={(wanted) => widthsFor(wantedPanel, wanted).tray}
          onCommit={setTrayWidth}
        />
      ) : null}
      <div class="tray-head">
        <button
          type="button"
          class="label tray-toggle"
          aria-expanded={trayOpen}
          data-tip={`New cards arrive here, outside every circle, so they start private. A click ${trayOpen ? "folds" : "opens"} the shelf.`}
          onClick={toggleTray}
        >
          New · private ({tray.length}) {trayOpen ? "▴" : "▾"}
        </button>
        <input
          class="field"
          type="search"
          placeholder="Filter"
          aria-label="Filter the tray"
          data-tip="Filter the tray by name, kind or address."
          value={trayFilter}
          onInput={(event) => setTrayFilter((event.target as HTMLInputElement).value)}
        />
        <span class="help">
          Drag cards onto the map, into a circle or onto a card. Shift-click picks several.
        </span>
      </div>
      <div class="tray-list">
        {shownTray.length === 0 ? <p class="help">No card matches.</p> : null}
        {shownTray.map((resource) => (
          <TrayCard
            key={resource.id}
            resource={resource}
            state={state}
            selected={selection.cards.has(resource.id)}
            dragging={dragging.has(resource.id)}
            access={store.snapshot?.access[resource.id] ?? null}
            progress={store.snapshot?.progress[resource.id] ?? null}
            machine={machines.get(resource.id) ?? null}
            zone={store.snapshot?.zone ?? ""}
            onMenu={(anchor) => setMenu({ target: { _tag: "card", id: resource.id }, anchor })}
          />
        ))}
      </div>
    </aside>
  );

  /** The right edge of the shelf where it covers the map, or 0: a closed shelf on a phone covers none of it. */
  const shelfRight = () => {
    if (!trayShown || !trayOpen) return 0;
    return (
      document.querySelector(".tray")?.getBoundingClientRect().right ??
      10 + (wide ? widths.tray : Math.min(16 * REM, screenWidth - 20))
    );
  };

  /** The part of the screen where the map shows clear of the toolbar, the tray and a floating panel. */
  const mapArea = (withPanel: boolean, panelWidth?: number): Box =>
    openArea({
      width: innerWidth,
      // The hint line at the bottom shows only on a wide screen; the map stays above it.
      height: wideScreen()
        ? (document.querySelector(".hint")?.getBoundingClientRect().top ?? innerHeight)
        : innerHeight,
      top: document.querySelector("header.bar")?.getBoundingClientRect().bottom ?? 70,
      // The tray is not drawn yet when a full view switches to the map, so its width then comes from the tray cards.
      // On a phone a closed shelf is a chip above the map, so the map takes the full width (K-528).
      left: shelfRight(),
      panelLeft: withPanel ? panelLeft(panelWidth) : null,
      narrow: !wideScreen(),
    });

  const fit = () => {
    const next = fitMap(state.circles.values(), state.places.values(), mapArea(floating));
    if (next) changeView(next);
  };

  fitRef.current = fit;

  /** K-532: one save on the server, which refuses when a share would change; the toast offers Undo. */
  const organize = async () => {
    const result = await organizeMap(measureMap(state, previews), [...hidden]);
    showToast(
      result.ok
        ? { text: `${result.summary ?? "Organized"}.`, error: false, undo: result.revision }
        : { text: result.error, error: true, undo: null },
    );
  };

  /**
   * K-1508: shows the cards and circles of a History row on the map: a pan that brings them clear of the
   * panel, and one highlight that ends by itself.
   */
  const showOnMap = (revision: RevisionView) => {
    const cards = revision.items.flatMap((item) => {
      const place = item.kind === "card" ? state.places.get(item.id) : undefined;
      const kind = state.resources.get(item.id)?.kind;
      return place && kind && !hidden.has(kind) ? [{ item, box: cardBox(place) }] : [];
    });
    const circles = revision.items.flatMap((item) => {
      const circle = item.kind === "circle" ? state.circles.get(item.id) : undefined;
      return circle ? [{ item, box: circleBox(circle) }] : [];
    });
    const shown = [...cards, ...circles];
    if (shown.length === 0) {
      showToast({
        text: "Nothing of this change shows on the map now: it is gone, in the tray, or of a hidden kind.",
        error: false,
        undo: null,
      });
      return;
    }
    if (fullPage) {
      setPanel("history");
      location.hash = "map";
    }
    // A pan to chosen items is the owner's view now, so a panel that opens next does not fit over it.
    userMoved.current = true;
    changeView(panInto(union(shown.map((entry) => entry.box)), mapArea(true), view));
    setFlash(new Set(shown.map((entry) => itemKey(entry.item))));
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
  };

  /** A toolbar tab opens its panel over the map; Enlarge in the panel opens the full view. */
  const openTab = (tab: "map" | Exclude<PanelKind, NoTab>) => {
    rememberOpener();
    setPanel(tab === "map" ? "details" : tab);
    location.hash = "map";
  };

  /** K-1504: the toolbar opener and the palette open the big red button here; Settings opens the same way. */
  const openPanel = (kind: "safety" | "settings") => {
    rememberOpener();
    setPanel(kind);
    location.hash = "map";
  };
  const openSafety = () => openPanel("safety");

  const resizePanel = (kind: PanelKind) => {
    if (kind === "details" || kind === "safety" || kind === "settings") setDetailsLarge(!large);
    else if (large) openTab(kind);
    else location.hash = kind;
  };

  const closePanel = () => {
    setPanel(null);
    setDetailsLarge(false);
    if (fullPage) location.hash = "map";
    (opener.current?.isConnected
      ? opener.current
      : document.querySelector<HTMLElement>(".bar .seg button, .bar button[aria-label='Menu']")
    )?.focus();
  };

  // K-1734: a selected repo group lights up the cards of the repos that it matches, until the selection changes.
  const selectedId = selection.cards.size === 1 ? [...selection.cards][0] : undefined;
  const selectedGroup = selectedId ? state?.resources.get(selectedId) : undefined;
  const groupFlash = new Set(
    selectedGroup?.kind === "repo.group" && store.snapshot
      ? matchedCards(selectedGroup, store.snapshot.repos).map((id) => itemKey({ kind: "card", id }))
      : [],
  );

  historyShow.current = showOnMap;
  historyUndo.current = (id) => void undo(id, "history");

  // Escape clears a selection first, then closes the panel; the palette and dialogs handle their own.
  escapeRef.current = () => {
    if (selection.cards.size > 0 || selection.circle !== null)
      setSelection({ cards: new Set(), circle: null });
    else if (shownPanel !== null) closePanel();
  };

  /** A new circle at `at`, or in the middle of the view. */
  const newCircle = async (at: Point | null) => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const center = at ?? { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
    const circle: Circle = {
      ...NEW_CIRCLE,
      id,
      color: CIRCLE_COLORS[state.circles.size % CIRCLE_COLORS.length] ?? "#6C5CE7",
      x: Math.round(center.x),
      y: Math.round(center.y),
      r: 220,
    };
    const result = await applyEdits([{ _tag: "circle", id, after: circle }]);
    if (result.ok) select({ cards: new Set(), circle: id });
    else showToast({ text: result.error, error: true, undo: null });
  };

  /**
   * K-529: one new circle around the selected cards, as one edit, so one undo takes it back. Its editor opens
   * next, because it has no members until the owner adds some.
   */
  const newCircleFor = async (wanted: ReadonlyArray<string>) => {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const color = CIRCLE_COLORS[state.circles.size % CIRCLE_COLORS.length] ?? "#6C5CE7";
    // A card that another device removed meanwhile drops out, as in `selectionActions`.
    const ids = wanted.filter((card) => state.resources.has(card));
    const plan = circleForCards(state, ids, { ...NEW_CIRCLE, id, color });
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    const result = await applyEdits(plan.edits);
    if (!result.ok) {
      showToast({ text: result.error, error: true, undo: null });
      return;
    }
    const { moved, cards } = plan;
    selectAndFocus({ cards: new Set(), circle: id }, ".add-member input");
    showToast({
      card: ids[0],
      text: `Made a circle for ${plural(cards, "card")}${moved > 0 ? `; ${plural(moved, "card")} moved to keep their circles` : ""}. Add members next.`,
      error: false,
      undo: result.revision,
    });
  };

  /** K-511: share or unshare without a drag, by placing the card where exactly the wanted circles hold it. */
  const reshare = async (resource: Resource, circle: Circle, share: boolean, part: StackPart) => {
    const plan = reshareEdits(state, resource, circle, share, part);
    if ("refused" in plan) {
      showToast({ text: plan.refused, error: true, undo: null });
      return;
    }
    // A stacked card takes its stack along (K-521), so the diff comes from the resolved changes.
    await commit(plan.edits, shareDiff(state, applyChanges(state, resolveEdits(state, plan.edits))));
  };

  /** No confirm: Undo in the toast and in History brings the circle back. */
  const deleteCircle = async (circle: Circle) => {
    const result = await applyEdits([{ _tag: "circle", id: circle.id, after: null }]);
    if (result.ok) {
      setSelection({ cards: new Set(), circle: null });
      showToast({ text: `Deleted circle ${circle.name}.`, error: false, undo: result.revision });
    } else showToast({ text: result.error, error: true, undo: null });
  };

  /** K-615: no confirm, and no undo; History records it. */
  const removeMachine = async (machine: MachineView) => {
    const result = await callApi<{ removed: string }>(
      "DELETE",
      `/api/machines/${encodeURIComponent(machine.machine.id)}`,
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text: `Removed ${machine.machine.name}: its token and tunnel are gone. History records it.`,
            error: false,
            undo: null,
          },
    );
  };

  /**
   * K-110: no confirm; History records the start and the outcome. Sessions left show as a warning with
   * Retry, which calls the same endpoint family.
   */
  const signOut = async (retry: boolean) => {
    setSigningOut(true);
    const result = await callApi<{ ended: number; failed: Array<string> }>(
      "POST",
      retry ? "/api/sign-out/retry" : "/api/sign-out",
      {},
    ).finally(() => setSigningOut(false));
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text:
              `Ended the sessions of ${plural(result.ended, "application")}. Everyone logs in again.` +
              (result.failed.length > 0 ? ` Failed: ${result.failed.join("; ")}` : ""),
            error: result.failed.length > 0,
            undo: null,
          },
    );
  };

  const runJob = (machine: MachineView, command: Command) =>
    queueJob(machine.machine.id, command).then(({ text, error }) => showToast({ text, error, undo: null }));

  const placeInView = (resource: Resource) => {
    const center = { x: (innerWidth / 2 - view.x) / view.s, y: (innerHeight / 2 - view.y) / view.s };
    const to = placeInside(state, center, new Set());
    if (to) void commit([{ _tag: "place", id: resource.id, after: to }], []);
  };

  /**
   * K-1129: publishes folders as folder sites, one after the other. A new site lands at `at` like a dropped file
   * (a public circle asks first, K-210) or waits in the tray; `card` gets a new version at its address.
   */
  const uploadFolders = async (
    folders: ReadonlyArray<FolderFiles & { readonly folder: string }>,
    target: { readonly at: Point | null } | { readonly card: Resource },
  ) => {
    if (!state || folders.length === 0) return;
    const at = "at" in target ? target.at : null;
    const wanted = at
      ? await confirmPublic(at, folders.length === 1 ? folders[0]?.folder : plural(folders.length, "folder"))
      : new Set<string>();
    if (wanted === null) return;
    const done: Array<string> = [];
    const errors: Array<string> = [];
    const added: Array<string> = [];
    for (const [index, { folder, ...files }] of folders.entries()) {
      const spot = at
        ? (placeInside(state, { x: at.x + index * 30, y: at.y + index * 90 }, wanted) ?? at)
        : null;
      const prefix = folders.length > 1 ? `${index + 1} of ${folders.length}, ${folder}: ` : "";
      const result = await uploadFolder(
        "card" in target ? { card: target.card.id } : { folder, at: spot },
        files,
        (text) => setProgress(`${prefix}${text}`),
      );
      if ("error" in result) errors.push(`${folder}: ${result.error}`);
      else {
        added.push(result.card);
        done.push(
          result.updated
            ? `Uploaded a new version of ${"card" in target ? target.card.name : folder}.`
            : `Published ${folder} at https://${result.address}${at ? "" : "; it waits in the tray, private"}.`,
        );
      }
    }
    setProgress(null);
    if (added.length > 0) select({ cards: new Set(added), circle: null });
    showToast({ text: [...done, ...errors].join(" "), error: errors.length > 0, undo: null });
  };

  const uploadTo = (at: Point | null) => {
    uploadAt.current = at;
    location.hash = "map";
    setTimeout(() => uploadInput.current?.click());
  };

  /** K-525: after a panel resize, selected cards that the panel now covers pan clear of it. */
  const keepSelectionClear = (panelWidth: number) => {
    const boxes = [...selection.cards].flatMap((id) => {
      const place = state.places.get(id);
      return place ? [cardBox(place)] : [];
    });
    if (boxes.length === 0) return;
    const next = panInto(union(boxes), mapArea(true, panelWidth), view);
    if (next !== view) changeView(next);
  };

  /** K-212: one service for the panel, the menu, the palette and agents; the toast offers Undo. */
  const setTime = async (resource: Resource, endsAt: number | null | "now") => {
    const result = await callApi<{ revision: number | null }>(
      "POST",
      `/api/cards/${encodeURIComponent(resource.id)}/time`,
      endsAt === "now" ? { now: true } : { endsAt },
    );
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : {
            text:
              endsAt === "now"
                ? `Ended ${resource.name}: it is in the tray, out of every circle.`
                : endsAt === null
                  ? `${resource.name} stays until someone moves it.`
                  : `${resource.name} moves to the tray ${untilText(endsAt).replace("until", "at")}.`,
            error: false,
            undo: result.revision,
            card: resource.id,
          },
    );
  };

  /** K-534: the way out of a port card, from its menu, its panel and the palette; it has no Undo, so it asks. */
  const removePortCard = async (resource: Resource) => {
    if (
      !(await ask(
        `Remove the port card ${resource.name}? Its doors close for everyone at once and its records go. This has no Undo.`,
      ))
    )
      return;
    const result = await callApi<object>("DELETE", `/api/ports/${encodeURIComponent(resource.id)}`);
    showToast(
      "error" in result
        ? { text: result.error, error: true, undo: null }
        : { text: `Removed the port card ${resource.name}.`, error: false, undo: null },
    );
  };

  /** K-523: the menu and the palette run these, the same as the toolbar and the panel. */
  const handlers: ActionHandlers = {
    select: (selected) => {
      select(selected);
      location.hash = "map";
      // "Show details" brings the item clear of the panel.
      const boxes = [
        ...[...selected.cards].flatMap((id) => {
          const place = state.places.get(id);
          return place ? [cardBox(place)] : [];
        }),
        ...[state.circles.get(selected.circle ?? "")].flatMap((circle) =>
          circle ? [headBox(circle, headAngle(circle, shownCardBoxes(state, hidden)))] : [],
        ),
      ];
      if (boxes.length > 0) {
        userMoved.current = true;
        changeView(panInto(union(boxes), mapArea(true), view));
      }
    },
    openAddress: (address) => void open(`https://${address}`, "_blank", "noreferrer"),
    copyAddress: (address) => void navigator.clipboard.writeText(`https://${address}`),
    copyRepoCommand: (resource) =>
      void navigator.clipboard
        .writeText(
          `kitshn repo ${resource.id}${resource.kind === "page" ? "" : " <folder>"} --repo <owner>/<name>`,
        )
        .then(() =>
          showToast({
            text: `Copied the kitshn repo command of ${resource.name}. An agent key runs it where gh is logged in.`,
            error: false,
            undo: null,
          }),
        ),
    reshare: (resource, circle, share, part) => void reshare(resource, circle, share, part),
    setLevel: (resource, circle, level) =>
      void applyEdits([levelEdit(state, resource, circle, level)]).then(
        (result) => result.ok || showToast({ text: result.error, error: true, undo: null }),
      ),
    place: placeInView,
    setTime: (resource, endsAt) => void setTime(resource, endsAt),
    toTray: (resource) => {
      const edits: Array<Edit> = [{ _tag: "place", id: resource.id, after: null }];
      void commit(
        edits,
        shareDiff(state, applyChanges(state, resolveEdits(state, edits))),
        `Moved ${resource.name} to the tray.`,
      );
    },
    stackOnto: (ids, target) => void stacks.stackOnto(ids, target),
    joinCircle: (machine, circle) => void joinCircle(machine, circle),
    leaveCircle,
    pullOut: (stackId, id) => void stacks.pullOut(stackId, id),
    unstack: (stackId) => void stacks.unstack(stackId),
    toggleStack,
    renameStack: (stackId) =>
      selectAndFocus(
        { cards: new Set(state.stacks.get(stackId)?.members ?? []), circle: null },
        'input[aria-label="Stack name"]',
      ),
    removeApp: (resource) => void removeApp(resource),
    removePortCard: (resource) => void removePortCard(resource),
    forgetProvider: (machineId, provider, card) => void forgetProvider(machineId, provider, card),
    takeAddress: (resource) => void takeAddress(resource),
    giveAddressBack: (resource) => void giveAddressBack(resource),
    rollback: (resource, mode) => setRollback({ card: resource, mode }),
    restorePrevious: (resource) => void restorePrevious(resource),
    editAddress: (resource) =>
      selectAndFocus({ cards: new Set([resource.id]), circle: null }, 'input[aria-label="Address name"]'),
    editRedirects: (resource) =>
      selectAndFocus({ cards: new Set([resource.id]), circle: null }, 'input[aria-label="Redirect address"]'),
    logs: setLogs,
    backups: setBackupsCard,
    runJob: (machine, command) => void runJob(machine, command),
    setAutoUpdate: (machine, on) =>
      void setAutoUpdate(machine.machine.id, on).then(({ text, error }) =>
        showToast({ text, error, undo: null }),
      ),
    runProviderCommand: (machine, command, question) =>
      void (async () => {
        if (question !== null && !(await ask(question))) return;
        await runJob(machine, command);
      })(),
    removeMachine: (machine) => void removeMachine(machine),
    editCircle: (circleId) => {
      select({ cards: new Set(), circle: circleId });
      location.hash = "map";
    },
    renameCircle: (circleId) =>
      selectAndFocus({ cards: new Set(), circle: circleId }, 'input[aria-label="Circle name"]'),
    addMember: addMemberTo,
    deleteCircle: (circle) => void deleteCircle(circle),
    newCircle: (at) => void newCircle(at),
    upload: uploadTo,
    uploadFolder: (target) => {
      folderTarget.current = target;
      location.hash = "map";
      setTimeout(() => folderInput.current?.click());
    },
    addSite: () => setAddingSite(""),
    addRepoGroup: () => setAddingRepoGroup(true),
    addMachine: () => setAddingMachine(true),
    newCircleFor: (ids) => void newCircleFor(ids),
    fit,
    organize: () => void organize(),
    undoItem: (item) => void undoItem(item),
  };
  const actionContext: ActionContext = {
    state,
    deployed,
    previews: previewCards,
    machines,
    version: store.snapshot.version,
    undoCheck,
    selected: selection.cards,
    previousVersions,
    handoverCards,
    addressHolds: store.snapshot?.addressHolds ?? {},
    openStacks,
    folderSites,
    providerCommands: store.snapshot.providerCommands,
  };

  const waitingRepos = store.snapshot?.repos.filter(awaitsAllow).length ?? 0;
  return (
    <>
      {route.tab === "map" ? (
        <MapView
          onDropFiles={(files, at) => void uploadFiles(files, at)}
          onDropFolders={(entries, at) =>
            void Promise.all(
              entries.map(async (entry) => ({ folder: entry.name, ...(await droppedFolder(entry)) })),
            ).then(
              (folders) => uploadFolders(folders, { at }),
              (error: unknown) =>
                showToast({
                  text: `kitshn could not read the folder: ${String(error)}`,
                  error: true,
                  undo: null,
                }),
            )
          }
          onDrop={(moves, target) => void drop(moves, target)}
          onDropSite={setAddingSite}
          tray={trayShown ? trayView : null}
          previews={previews}
          peek={wide}
          zone={store.snapshot.zone}
          state={state}
          access={store.snapshot.access}
          uptime={store.snapshot.uptime}
          progress={store.snapshot.progress}
          selection={selection}
          onSelect={select}
          hidden={hidden}
          view={view}
          onView={(next) => {
            userMoved.current = true;
            changeView(next);
          }}
          panelLeft={floating && wideScreen() ? panelLeft() : null}
          trayRight={shelfRight()}
          flash={groupFlash.size > 0 ? new Set([...flash, ...groupFlash]) : flash}
          openStacks={openStacks}
          pullRequests={pullRequests}
          onToggleStack={toggleStack}
          onCommit={(edits, diffs) => void commit(edits, diffs)}
          machines={machines}
          onMenu={setMenu}
        />
      ) : null}
      {floating && wide ? (
        <ResizeEdge
          label="Panel width"
          width={widths.panel}
          limits={PANEL_WIDTH}
          grows="left"
          cssVar="--panel-width"
          fit={(wanted) => widthsFor(wanted, wantedTray).panel}
          onCommit={(width) => {
            setPanelWidth(width);
            keepSelectionClear(width);
          }}
        />
      ) : null}
      {shownPanel ? (
        <OverlayPanel
          // New content mounts a new panel, so the focus moves to its heading.
          key={shownPanel}
          heading={
            shownPanel !== "details"
              ? PANEL_HEADINGS[shownPanel]
              : selection.circle !== null && state.circles.has(selection.circle)
                ? "Circle"
                : selection.cards.size === 1
                  ? "Card"
                  : selection.cards.size > 1
                    ? "Selection"
                    : "The map"
          }
          large={large}
          onResize={() => resizePanel(shownPanel)}
          onClose={closePanel}
        >
          {shownPanel === "safety" ? (
            <>
              <SafetyView
                reach={reachNow}
                pause={pauseView}
                onPress={() => void pauseNow("keep-public")}
                onLockdown={() => void pauseNow("lockdown")}
              />
              <button
                type="button"
                class="btn"
                data-tip="Rewind everything that kitshn keeps to a time of the past 30 days. It needs a fresh passkey."
                onClick={() => setRestoringTime(true)}
              >
                Restore kitshn to a time…
              </button>
              <a
                class="btn"
                href="/api/state/export"
                download
                data-tip="Save the state of kitshn as one file, with no secret. The bootstrap rebuilds an install from it (K-1832, K-1833)."
              >
                Download state export
              </a>
            </>
          ) : shownPanel === "settings" ? (
            <section>
              <GitHubDefaultWay
                way={store.snapshot.githubDefaultWay}
                onToast={(text, error) => showToast({ text, error, undo: null })}
              />
              <PassSettingsPanel onToast={(text, error) => showToast({ text, error, undo: null })} />
              <div class="label" data-tip="Sessions: who is signed in to kitshn's apps.">
                Sessions
              </div>
              <p class="muted">You are {actorLabel(store.snapshot.me)}.</p>
              <button
                class="btn danger"
                data-tip="Sign out everywhere: ends every Access session of kitshn's apps at once. Everyone logs in again, you too. History records it."
                disabled={signingOut}
                onClick={() => void signOut(false)}
              >
                Sign out everywhere: ends every session
              </button>
            </section>
          ) : shownPanel === "history" ? (
            historyView
          ) : shownPanel === "library" ? (
            <LibraryView
              state={state}
              revision={store.snapshot.revision}
              onToast={(text, error) => showToast({ text, error, undo: null })}
              onShowCard={(id) => handlers.select({ cards: new Set([id]), circle: null })}
            />
          ) : shownPanel === "machines" ? (
            <MachinesView
              machines={store.snapshot.machines}
              accessApps={store.snapshot.accessApps}
              onAdd={() => setAddingMachine(true)}
              onToast={(text, error) => showToast({ text, error, undo: null })}
            />
          ) : shownPanel === "usage" ? (
            <UsageView machines={store.snapshot.machines} r2Bucket={store.snapshot.r2Bucket} />
          ) : shownPanel === "notifications" ? (
            <NotificationsView
              state={state}
              bell={store.snapshot.bell}
              proposals={store.snapshot.proposals}
              machine={fullPage && route.tab === "notifications" ? decodeURIComponent(route.id) : ""}
              onToast={(text, error) => showToast({ text, error, undo: null })}
            />
          ) : (
            <Panel
              state={state}
              zone={store.snapshot.zone}
              peek={!wide}
              repos={store.snapshot.repos}
              proposals={store.snapshot.proposals}
              onOpenInbox={() => openTab("notifications")}
              botRuns={store.snapshot.botRuns}
              selection={selection}
              access={store.snapshot.access}
              accessTeam={store.snapshot.accessTeam}
              onSelectCard={(id) => select({ cards: new Set([id]), circle: null })}
              onSelectCircle={(id) => select({ cards: new Set(), circle: id })}
              stacks={stacks}
              onSecret={setSecret}
              onEdit={async (edits) => {
                const result = await applyEdits(edits);
                if (result.ok) return null;
                showToast({ text: result.error, error: true, undo: null });
                return result.error;
              }}
              onDeleteCircle={handlers.deleteCircle}
              onPlace={placeInView}
              onReshare={(resource, circle, share, part) => void reshare(resource, circle, share, part)}
              onTime={handlers.setTime}
              onRemovePortCard={handlers.removePortCard}
              onNewCircle={(ids) => void newCircleFor(ids)}
              onJoinCircle={(machine, circle) => void joinCircle(machine, circle)}
              onLeaveCircle={leaveCircle}
              onRemoveApp={(resource) => void removeApp(resource)}
              onRollback={(resource, mode) => setRollback({ card: resource, mode })}
              previousVersions={previousVersions}
              onRestorePrevious={(resource) => void restorePrevious(resource)}
              onSetAddress={setAddress}
              redirects={store.snapshot?.redirects ?? {}}
              onRedirect={changeRedirect}
              onLogs={setLogs}
              backups={store.snapshot.backups}
              r2Bucket={store.snapshot.r2Bucket}
              backupsOff={store.snapshot.backupsOff}
              onBackUpNow={(resource) => void backUpNow(resource)}
              onBackups={setBackupsCard}
              orphanWorkers={store.snapshot.orphanWorkers}
              onDeleteOrphanWorker={(orphan) => void deleteOrphanWorker(orphan)}
              deployed={deployed}
              previewCards={previewCards}
              pullRequests={pullRequests}
              cardSettings={store.snapshot.cardSettings}
              providerCommands={store.snapshot.providerCommands}
              onSetCardSetting={(card, key, value) => void setCardSetting(card, key, value)}
              deployNotes={store.snapshot.deployNotes}
              uptime={store.snapshot.uptime}
              machines={machines}
              version={store.snapshot.version}
              jobs={store.snapshot.jobs}
              onToast={(text, error) => showToast({ text, error, undo: null })}
              onRemoveMachine={handlers.removeMachine}
              onRunJob={runJob}
              onRunProviderCommand={handlers.runProviderCommand}
              warnings={store.snapshot.accessWarnings}
              onOpenSettings={() => openPanel("settings")}
              selectionActions={selectionActions(actionContext, handlers)}
              onSignOut={(retry) => void signOut(retry)}
              signOutWarning={store.snapshot.signOutWarning}
              signingOut={signingOut}
            />
          )}
        </OverlayPanel>
      ) : null}
      {addingMachine ? <AddMachine onClose={() => setAddingMachine(false)} /> : null}
      {addingRepoGroup ? (
        <AddRepoGroup
          onClose={() => setAddingRepoGroup(false)}
          onDone={(text) => showToast({ text, error: false, undo: null })}
        />
      ) : null}
      {addingSite !== null ? (
        <AddSite
          zone={store.snapshot.zone}
          machines={store.snapshot.machines}
          initial={addingSite}
          cardOf={(host) =>
            [...state.resources.values()].find((resource) => resource.addresses.includes(host)) ?? null
          }
          onShowCard={(card) => {
            setAddingSite(null);
            handlers.select({ cards: new Set([card.id]), circle: null });
          }}
          circles={[...state.circles.values()]}
          // K-210: a card that enters a public circle asks first, also when it arrives later.
          onConfirmPublic={(circle) =>
            ask(`A new site in ${circle} is public. Anyone with the address can open it.`)
          }
          onClose={() => setAddingSite(null)}
          onDone={(text) => showToast({ text, error: false, undo: null })}
        />
      ) : null}
      {secret ? <SecretDialog secret={secret} onClose={() => setSecret(null)} /> : null}
      {rollback ? (
        <RollbackDialog
          card={rollback.card}
          mode={rollback.mode}
          onClose={() => setRollback(null)}
          onDone={(text, error) => showToast({ text, error, undo: null })}
        />
      ) : null}
      {logs ? <LogsDialog card={logs} onClose={() => setLogs(null)} /> : null}
      {backupsCard ? (
        <BackupsDialog
          card={backupsCard}
          ask={ask}
          onClose={() => setBackupsCard(null)}
          onDone={(text, error) => showToast({ text, error, undo: null })}
        />
      ) : null}
      {restoringTime ? (
        <RestoreTimeDialog restoreUndo={store.snapshot.restoreUndo} onClose={() => setRestoringTime(false)} />
      ) : null}
      {progress ? (
        <div class="progress" role="status">
          <span class="sticker wait" data-tip="Upload: kitshn sends the files one after the other.">
            upload
          </span>{" "}
          {progress}
        </div>
      ) : null}
      <TooltipLayer />
      {/* Outside the map toolbar, so an upload from the palette on another tab finds it. */}
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          const at = uploadAt.current;
          uploadAt.current = null;
          void uploadFiles(files, at);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        // K-1129: the browser asks for one folder and gives its files with their paths.
        {...{ webkitdirectory: true }}
        hidden
        onChange={(event) => {
          const picked = pickedFolder([...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
          const target = folderTarget.current;
          folderTarget.current = null;
          if (target && picked.files.length > 0) void uploadFolders([picked], target);
        }}
      />
      <header class={`bar${floating ? " beside-panel" : ""}${foldTools ? " folded" : ""}`} ref={barRef}>
        <h1>kitshn</h1>
        {!foldTabs ? (
          <div class="seg">
            {(["map", "machines", "library", "history", "usage"] as const).map((tab) => (
              <button
                key={tab}
                aria-pressed={
                  fullPage ? route.tab === tab : tab === "map" ? panel === "details" : panel === tab
                }
                data-tip={TABS[tab]}
                onClick={() => openTab(tab)}
              >
                {tab[0]?.toUpperCase()}
                {tab.slice(1)}
              </button>
            ))}
          </div>
        ) : null}
        {foldTools ? (
          <button
            type="button"
            class="btn"
            aria-haspopup="menu"
            aria-expanded={moreMenu !== null}
            aria-label="Menu"
            data-tip={
              !wide
                ? "The tabs, the kinds to show, Fit, Organize, Previews and Settings."
                : foldTabs
                  ? "The tabs, the kinds to show, Organize and Previews."
                  : "The kinds to show, Organize and Previews."
            }
            onClick={(event) => setMoreMenu(event.currentTarget.getBoundingClientRect())}
          >
            ☰
          </button>
        ) : null}
        {moreMenu ? (
          <Menu label="Menu" anchor={moreMenu} onClose={() => setMoreMenu(null)}>
            {!foldTabs
              ? null
              : (["map", "machines", "library", "history", "usage"] as const).map((tab) => (
                  <MenuItem
                    key={tab}
                    checked={
                      fullPage ? route.tab === tab : tab === "map" ? panel === "details" : panel === tab
                    }
                    tip={TABS[tab]}
                    onSelect={() => openTab(tab)}
                  >
                    {tab[0]?.toUpperCase()}
                    {tab.slice(1)}
                  </MenuItem>
                ))}
            {wide ? null : (
              <MenuItem
                checked={panel === "settings"}
                tip={TABS.settings}
                onSelect={() => openPanel("settings")}
              >
                Settings
              </MenuItem>
            )}
            {waitingRepos > 0 ? (
              <MenuItem
                tip="Repos that wait for you to allow their first deploy. It shows them in the panel."
                onSelect={() => {
                  setSelection({ cards: new Set(), circle: null });
                  openTab("map");
                }}
              >
                {plural(waitingRepos, "repo")} waiting
              </MenuItem>
            ) : null}
            {route.tab === "map" ? (
              <>
                <MenuSep />
                <MenuItem
                  tip="Show or hide kinds of cards on the map."
                  onSelect={() => setShowMenu(moreMenu)}
                >
                  Show{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""} ▸
                </MenuItem>
                <MenuItem tip="Fit every circle and card in the view." onSelect={fit}>
                  Fit
                </MenuItem>
                <MenuItem tip={ORGANIZE_TIP} onSelect={() => void organize()}>
                  Organize
                </MenuItem>
                <MenuItem
                  checkbox
                  checked={previews}
                  tip={`${previews ? "Hide" : "Show"} live previews of up to four site and page cards near the centre, from zoom 80%.`}
                  onSelect={() => {
                    localStorage.setItem(PREVIEWS_KEY, previews ? "off" : "on");
                    setPreviews(!previews);
                  }}
                >
                  Previews{previews && view.s < 0.8 ? " (zoom in)" : ""}
                </MenuItem>
              </>
            ) : null}
          </Menu>
        ) : null}
        {route.tab === "map" ? (
          <>
            {wide ? <span class="sep" /> : null}
            {/* K-501: one menu for the kinds, so the toolbar stays short and "Machines" names only the tab. */}
            {!foldTools ? (
              <button
                type="button"
                class="btn"
                aria-haspopup="menu"
                data-tip="Show or hide kinds of cards on the map. Hidden kinds still count for their circles."
                onClick={(event) => setShowMenu(event.currentTarget.getBoundingClientRect())}
              >
                Show{hidden.size > 0 ? ` (${hidden.size} hidden)` : ""} ▾
              </button>
            ) : null}
            {showMenu ? (
              <Menu label="Show kinds on the map" anchor={showMenu} onClose={() => setShowMenu(null)}>
                {/* K-501: each kind on the map, the built-in ones first, then the kinds of providers (K-302). */}
                {[
                  ...(Object.keys(RESOURCE_KINDS) as Array<ResourceKind>).flatMap((kind) => {
                    const card = [...state.resources.values()].find((resource) => resource.kind === kind);
                    return card ? [{ kind: kind as CardKind, info: KINDS[kind] }] : [];
                  }),
                  ...[
                    ...new Map(
                      [...state.resources.values()]
                        .filter((resource) => resource.provider)
                        .map((resource) => [resource.kind, kindInfo(resource)] as const),
                    ),
                  ].map(([kind, info]) => ({ kind, info })),
                ].map(({ kind, info }) => (
                  <MenuItem
                    key={kind}
                    checkbox
                    checked={!hidden.has(kind)}
                    keepOpen
                    tip={`${hidden.has(kind) ? "Show" : "Hide"} ${info.label.toLowerCase()} on the map.`}
                    onSelect={() => {
                      const next = new Set(hidden);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      setHidden(next);
                    }}
                  >
                    {info.icon} {info.label}
                  </MenuItem>
                ))}
              </Menu>
            ) : null}
            {wide ? <span class="sep" /> : null}
            <button
              class="btn primary add"
              aria-haspopup="menu"
              aria-label="Add"
              data-tip="Add a circle, a page or a file, a site, a machine or a member (K-526)."
              onClick={(event) =>
                setMenu({ target: { _tag: "add" }, anchor: event.currentTarget.getBoundingClientRect() })
              }
            >
              +
            </button>
            {/* Fit stays on a folded wide toolbar: it is the map tool that people use most. */}
            {wide ? (
              <button class="btn" data-tip="Fit every circle and card in the view." onClick={fit}>
                Fit
              </button>
            ) : null}
            {!foldTools ? (
              <>
                <button class="btn" data-tip={ORGANIZE_TIP} onClick={() => void organize()}>
                  Organize
                </button>
                <button
                  class="btn toggle"
                  aria-pressed={previews}
                  data-tip={`${previews ? "Hide" : "Show"} live previews of up to four site and page cards near the centre, from zoom 80%.`}
                  onClick={() => {
                    localStorage.setItem(PREVIEWS_KEY, previews ? "off" : "on");
                    setPreviews(!previews);
                  }}
                >
                  Previews{previews && view.s < 0.8 ? " (zoom in)" : ""}
                </button>
              </>
            ) : null}
          </>
        ) : null}
        <span class="grow" />
        <button
          class="btn"
          aria-pressed={fullPage ? route.tab === "notifications" : panel === "notifications"}
          aria-label={`Notifications, ${store.snapshot.bell} open`}
          data-tip={TABS.notifications}
          onClick={() => openTab("notifications")}
        >
          🔔
          {store.snapshot.bell > 0 ? <span class="sticker">{store.snapshot.bell}</span> : null}
        </button>
        {waitingRepos > 0 && !foldTools ? (
          <button
            class="btn"
            data-tip="Repos that wait for you to allow their first deploy. A click shows them in the panel."
            onClick={() => {
              setSelection({ cards: new Set(), circle: null });
              openTab("map");
            }}
          >
            <span class="sticker wait">
              {wide ? `${plural(waitingRepos, "repo")} waiting` : `${waitingRepos} waiting`}
            </span>
          </button>
        ) : null}
        {/* On a phone Resume takes the opener's place while paused; the banner shows the paused state. */}
        {wide || !pauseView ? (
          <PanicOpener pause={pauseView} open={shownPanel === "safety"} onOpen={openSafety} />
        ) : null}
        {pauseView ? (
          <button class="btn resume" onClick={startResume} data-tip={RESUME_TIP}>
            Resume
          </button>
        ) : null}
        {wide ? (
          <button
            type="button"
            class="btn"
            aria-pressed={panel === "settings"}
            aria-label="Settings"
            data-tip={TABS.settings}
            onClick={() => openPanel("settings")}
          >
            ⚙
          </button>
        ) : null}
        <button
          class="btn"
          onClick={() => setPalette("")}
          aria-label="Command palette"
          data-tip="Command palette (Cmd+K or Ctrl+K): find every card, circle and action."
        >
          {wide ? "⌘K" : "Find"}
        </button>
        {/* A phone shows the connection only when it is not live, so the toolbar fits one row. */}
        {wide || store.connection !== "live" ? (
          <span
            class={`sticker ${store.connection === "live" ? "ok" : "wait"}`}
            style={{ "--tilt": "3deg" }}
            data-tip={CONNECTION_TIPS[store.connection]}
          >
            {store.connection}
          </span>
        ) : null}
      </header>
      {pauseView && pausedReach ? (
        <PausedBanner
          pause={pauseView}
          reach={pausedReach}
          besidePanel={floating}
          onLockdown={() => void pauseNow("lockdown")}
          onResume={startResume}
        />
      ) : null}
      {palette !== null ? (
        <Palette
          initialQuery={palette}
          onClose={() => setPalette(null)}
          entries={[
            { label: "Open History", tip: TABS.history, run: () => openTab("history") },
            { label: "Open Usage", tip: TABS.usage, run: () => openTab("usage") },
            { label: "Open Notifications", tip: TABS.notifications, run: () => openTab("notifications") },
            { label: "Open Settings", tip: TABS.settings, run: () => openPanel("settings") },
            ...(pauseView
              ? [
                  { label: "Resume with passkey", tip: RESUME_TIP, run: startResume },
                  ...(pauseView.mode === "keep-public"
                    ? [
                        {
                          label: "Close public sites too",
                          danger: true as const,
                          tip: LOCKDOWN_TIP,
                          run: () => void pauseNow("lockdown"),
                        },
                      ]
                    : []),
                ]
              : [
                  {
                    label: "Emergency pause: open the big red button",
                    danger: true as const,
                    tip: PAUSE_TIP,
                    run: openSafety,
                  },
                ]),
            ...(store.snapshot.signOutWarning
              ? [
                  {
                    label: "Retry sign-out everywhere",
                    danger: true as const,
                    tip: store.snapshot.signOutWarning,
                    run: () => void signOut(true),
                  },
                ]
              : []),
            ...paletteEntries(actionContext, handlers),
          ]}
        />
      ) : null}
      {menu && route.tab === "map" ? (
        <ContextMenu menu={menu} context={actionContext} handlers={handlers} onClose={() => setMenu(null)} />
      ) : null}
      {confirm ? (
        <div class="scrim">
          <div class="dialog" role="alertdialog">
            <p style={{ marginTop: 0, fontWeight: 700 }}>{confirm.text}</p>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                class="btn"
                data-tip="Cancel: nothing changes."
                onClick={() => (confirm.resolve(false), setConfirm(null))}
              >
                Cancel
              </button>
              <button
                class="btn primary"
                autoFocus
                data-tip="Continue with the change."
                onClick={() => (confirm.resolve(true), setConfirm(null))}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <ToastView
          text={toast.text}
          error={toast.error}
          besidePanel={floating}
          place={toast.place}
          onUndo={
            toast.undo === null
              ? null
              : () => {
                  if (pressBeforeToast()) return;
                  const revisions = [...(toast.undo === null ? [] : [toast.undo]), ...(toast.alsoUndo ?? [])];
                  setToast(null);
                  void (async () => {
                    for (const revision of revisions) await undo(revision, "toast");
                  })();
                }
          }
          action={
            toast.action
              ? {
                  label: toast.action.label,
                  tip: toast.action.tip,
                  run: () => {
                    if (pressBeforeToast()) return;
                    setToast(null);
                    toast.action?.run();
                  },
                }
              : null
          }
          onClose={() => setToast(null)}
        />
      ) : null}
      {route.tab === "map" ? (
        // Beside a floating panel the hint stops at the panel and wraps, so it stays readable.
        <div class={`hint${floating ? " beside-panel" : ""}`} ref={hintRef}>
          Drag a card into a circle to share it · Right-click, a long press or ⋯: actions · Shift-click or
          drag empty space: select many · {ALONE_KEY.label}-drag a circle head: move it alone · Ctrl or ⌘ +
          wheel: zoom
        </div>
      ) : null}
    </>
  );
}

function Panel(props: {
  state: State;
  zone: string;
  /** K-520: a phone offers the preview on the kind sticker in the card sheet, not on the card on the map. */
  peek: boolean;
  /** K-819: the repos that deploy or wait to deploy. */
  repos: ReadonlyArray<RepoView>;
  /** K-1722: the asks that wait for an approver circle. */
  proposals: ReadonlyArray<ProposalView>;
  /** K-1607: the asks wait in the Inbox of the Notifications view; the map panel only points there. */
  onOpenInbox: () => void;
  /** K-1767: App pull request runs that wait for Deploy. */
  botRuns: Snapshot["botRuns"];
  selection: Selection;
  access: Readonly<Record<string, AccessState>>;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onDeleteCircle: (circle: Circle) => void;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean, part: StackPart) => void;
  /** K-212: a new end time, null for no end, or "now". */
  onTime: (resource: Resource, endsAt: number | null | "now") => void;
  /** K-534: removes a port card after a confirm. */
  onRemovePortCard: (resource: Resource) => void;
  onNewCircle: (ids: ReadonlyArray<string>) => void;
  onJoinCircle: (machine: Resource, circle: Circle) => void;
  onLeaveCircle: (machine: Resource, circle: Circle) => void;
  onRemoveApp: (resource: Resource) => void;
  onRollback: (resource: Resource, mode: "card" | "run") => void;
  /** K-1117: the pages and files that have a previous version. */
  previousVersions: ReadonlySet<string>;
  onRestorePrevious: (resource: Resource) => void;
  onSetAddress: (resource: Resource, name: string) => Promise<boolean>;
  redirects: Readonly<Record<string, ReadonlyArray<string>>>;
  onRedirect: (resource: Resource, address: string, remove: boolean) => Promise<boolean>;
  onLogs: (resource: Resource) => void;
  backups: Readonly<Record<string, BackupRun>>;
  r2Bucket: BucketSize | null;
  /** K-1815: no backup key, so backups are off. */
  backupsOff: boolean;
  onBackUpNow: (resource: Resource) => void;
  onBackups: (resource: Resource) => void;
  orphanWorkers: ReadonlyArray<OrphanWorker>;
  onDeleteOrphanWorker: (orphan: OrphanWorker) => void;
  /** K-909 */
  deployed: ReadonlySet<string>;
  previewCards: ReadonlySet<string>;
  pullRequests: Readonly<Record<string, number>>;
  deployNotes: Readonly<Record<string, DeployNote>>;
  uptime: Snapshot["uptime"];
  /** K-717, K-1625: the card settings and the provider commands of the snapshot. */
  cardSettings: Snapshot["cardSettings"];
  providerCommands: Snapshot["providerCommands"];
  onSetCardSetting: (card: Resource, key: string, value: string) => void;
  warnings: ReadonlyArray<string>;
  machines: ReadonlyMap<string, MachineView>;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  onRunJob: (view: MachineView, command: Command) => Promise<void>;
  /** K-707, K-1615: a provider command; a question asks first. */
  onRunProviderCommand: (view: MachineView, command: Command, question: string | null) => void;
  version: string;
  onToast: (text: string, error: boolean) => void;
  onOpenSettings: () => void;
  /** K-521, K-529: the shared selection actions, so the panel shows the same refusals as the menu and the palette. */
  selectionActions: ReadonlyArray<Action>;
  onSignOut: (retry: boolean) => void;
  signOutWarning: string | null;
  signingOut: boolean;
  accessTeam: string;
  onSelectCard: (id: string) => void;
  onSelectCircle: (id: string) => void;
  stacks: StackActions;
  onSecret: (secret: DeviceSecret) => void;
}) {
  const { state, selection } = props;
  const circle = selection.circle ? state.circles.get(selection.circle) : undefined;
  const cards = [...selection.cards].flatMap((id) => {
    const resource = state.resources.get(id);
    return resource ? [resource] : [];
  });
  let body;
  if (circle)
    body = (
      <CircleEditor
        key={circle.id}
        circle={circle}
        state={state}
        accessTeam={props.accessTeam}
        onEdit={props.onEdit}
        onDelete={props.onDeleteCircle}
        onSelectCard={props.onSelectCard}
        onSecret={props.onSecret}
        onJoinMachine={(id) => {
          const machine = state.resources.get(id);
          if (machine) props.onJoinCircle(machine, circle);
        }}
      />
    );
  else if (cards.length === 1 && cards[0]) {
    body = (
      <CardPanel
        // A new card is a new panel, so an open choice of another card never shows again.
        key={cards[0].id}
        resource={cards[0]}
        state={state}
        zone={props.zone}
        peek={props.peek}
        repo={props.repos.find((repo) => repo.resourceIds.includes(cards[0]?.id ?? "")) ?? null}
        repos={props.repos}
        access={props.access[cards[0].id] ?? null}
        onEdit={props.onEdit}
        onPlace={props.onPlace}
        onReshare={props.onReshare}
        onTime={props.onTime}
        onRemovePortCard={props.onRemovePortCard}
        onNewCircle={props.onNewCircle}
        onJoinCircle={props.onJoinCircle}
        onLeaveCircle={props.onLeaveCircle}
        onRemoveApp={props.onRemoveApp}
        onRollback={props.onRollback}
        onRestorePrevious={props.previousVersions.has(cards[0].id) ? props.onRestorePrevious : null}
        onSetAddress={props.onSetAddress}
        redirects={props.redirects[cards[0].id] ?? []}
        onRedirect={props.onRedirect}
        onLogs={props.onLogs}
        backup={props.backups[cards[0].id] ?? null}
        r2Bucket={props.r2Bucket}
        backupsOff={props.backupsOff}
        onBackUpNow={props.onBackUpNow}
        onBackups={props.onBackups}
        orphanWorkers={cards[0].id === ADMIN_RESOURCE_ID ? props.orphanWorkers : []}
        onDeleteOrphanWorker={props.onDeleteOrphanWorker}
        deployed={props.deployed.has(cards[0].id)}
        preview={props.previewCards.has(cards[0].id)}
        pullRequest={props.pullRequests[cards[0].id] ?? null}
        deployNote={props.deployNotes[cards[0].id] ?? null}
        uptime={props.uptime[cards[0].id] ?? null}
        machine={props.machines.get(cards[0].id) ?? null}
        providerMachine={props.machines.get(cards[0].machine ?? "") ?? null}
        cardSettings={props.cardSettings[cards[0].id] ?? {}}
        providerCommands={props.providerCommands}
        onSetCardSetting={props.onSetCardSetting}
        version={props.version}
        jobs={props.jobs}
        onRemoveMachine={props.onRemoveMachine}
        onRunJob={props.onRunJob}
        onRunProviderCommand={props.onRunProviderCommand}
        onToast={props.onToast}
      />
    );
  } else if (cards.length > 1) {
    const ids = new Set(cards.map((card) => card.id));
    const stackOfAll = [...state.stacks.values()].find(
      (stack) => stack.members.length === ids.size && stack.members.every((id) => ids.has(id)),
    );
    body = (
      <section>
        <div class="label" data-tip="Selection: the cards that you picked. They move as one.">
          Selection
        </div>
        <h2>{cards.length} cards</h2>
        <p>Drag them together into or out of a circle, or stack them to keep them together.</p>
        <ul>
          {cards.map((resource) => (
            <li key={resource.id}>
              <ItemIcon resource={resource} />
              {resource.name}
            </li>
          ))}
        </ul>
        <div class="row">
          {props.selectionActions.map((action, index) =>
            "run" in action ? (
              <button
                key={action.id}
                class={index === 0 ? "btn primary" : "btn"}
                disabled={action.refused !== undefined}
                data-tip={action.refused ?? action.tip}
                onClick={action.run}
              >
                {action.short ?? action.label}
              </button>
            ) : null,
          )}
        </div>
        {props.selectionActions.map((action) =>
          action.refused === undefined ? null : (
            <WhyOff key={action.id} reason={`${action.short ?? action.label}: ${action.refused}`} />
          ),
        )}
      </section>
    );
    if (stackOfAll)
      body = (
        <StackPanel
          stack={stackOfAll}
          state={state}
          actions={props.stacks}
          onSelectCard={props.onSelectCard}
        />
      );
  } else {
    body = (
      <section>
        <p>
          Circles say <b>who</b>: people, email domains, devices, networks. A card inside a circle is shared
          with that circle at its level.
        </p>
        <p>
          A card counts for every circle it sits in. Select a card to see who can open it, or a circle head to
          edit it.
        </p>
        <div class="label" data-tip="Circles: every circle on the map. A click edits one.">
          Circles
        </div>
        <ul class="opens">
          {[...state.circles.values()].map((item) => (
            <li key={item.id}>
              <button
                type="button"
                class="open-card"
                data-tip={`Edit ${item.name}: its members, level, match and end.`}
                onClick={() => props.onSelectCircle(item.id)}
              >
                <span class="name">
                  <span class="swatch" style={{ background: item.color }} /> {item.name}
                </span>
                <span class="muted">
                  {plural(
                    [...state.places.keys()].filter((id) =>
                      circlesHolding(state, id).some((held) => held.id === item.id),
                    ).length,
                    "card",
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <BotRuns runs={props.botRuns} onToast={props.onToast} />
        {props.proposals.length > 0 ? (
          <button
            class="btn"
            data-tip="Agents wait for an answer. The Inbox shows each ask with Approve and Deny."
            onClick={props.onOpenInbox}
          >
            <span class="sticker wait">
              {props.proposals.length === 1 ? "1 ask waits" : `${props.proposals.length} asks wait`}
            </span>
          </button>
        ) : null}
        <RepoList repos={props.repos} onToast={props.onToast} />
        {props.warnings.length > 0 || props.signOutWarning ? (
          <>
            <div
              class="label"
              data-tip="Access warnings: Access applications that kitshn did not make and that cover a kitshn address."
            >
              Access warnings
            </div>
            <ul>
              {props.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {props.signOutWarning ? (
                <li>
                  {props.signOutWarning}{" "}
                  <button
                    type="button"
                    class="btn"
                    disabled={props.signingOut}
                    data-tip="Retry sign-out: revoke the sessions of the applications above again. The warning goes once every session ended."
                    onClick={() => props.onSignOut(true)}
                  >
                    Retry sign-out
                  </button>
                </li>
              ) : null}
            </ul>
          </>
        ) : null}
        <div class="row">
          <button type="button" class="btn" data-tip={TABS.settings} onClick={props.onOpenSettings}>
            Settings…
          </button>
        </div>
      </section>
    );
  }
  return body;
}

interface StackActions {
  stackOnto: (ids: Array<string>, target: string) => Promise<void>;
  pullOut: (stackId: string, id: string) => Promise<void>;
  unstack: (stackId: string) => Promise<void>;
  rename: (stackId: string, name: string) => Promise<void>;
}

/** K-521: one stack of the owner: its name, its cards with "Pull out", and "Unstack". */
function StackPanel(props: {
  stack: Stack;
  state: State;
  actions: StackActions;
  onSelectCard: (id: string) => void;
}) {
  const { stack, state } = props;
  const holding = circlesHolding(state, stack.members[0] ?? "");
  return (
    <section class="editor">
      <div class="label">Stack</div>
      <input
        class="field title"
        aria-label="Stack name"
        placeholder="No name"
        data-tip="The name of the stack. Enter saves it; an empty name shows only its cards."
        key={stack.name}
        defaultValue={stack.name}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        onBlur={(event) => void props.actions.rename(stack.id, (event.target as HTMLInputElement).value)}
      />
      <p class="help">
        Its {stack.members.length} cards move as one and share every circle:{" "}
        {holding.length > 0 ? holding.map((circle) => circle.name).join(", ") : "none, so they are private"}.
      </p>
      <h3 class="label">Cards</h3>
      <ul class="opens">
        {stack.members.map((id) => {
          const resource = state.resources.get(id);
          return (
            <li key={id}>
              <div class="open-card">
                {/* One card's own level and end date (K-205, K-209) are in its panel. */}
                <button
                  type="button"
                  class="name link"
                  data-tip="Show this card's panel, with its own level and end date."
                  onClick={() => props.onSelectCard(id)}
                >
                  {resource ? (
                    <>
                      <ItemIcon resource={resource} />
                      {resource.name}
                    </>
                  ) : (
                    id
                  )}
                </button>
                <button
                  type="button"
                  class="btn"
                  data-tip="Pull out: the card lands next to the stack, in the same circles, so no share changes."
                  onClick={() => void props.actions.pullOut(stack.id, id)}
                >
                  Pull out
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        class="btn"
        data-tip="Unstack: spread all cards in the same circles."
        onClick={() => void props.actions.unstack(stack.id)}
      >
        Unstack
      </button>
    </section>
  );
}

/**
 * K-1120: the name in the address of a page or a file. Enter or Save sends a changed name; leaving the field sends
 * nothing, and a refused name or Escape puts the current one back. An id address shows an empty field.
 */
function AddressName(props: { address: string; onSave: (name: string) => Promise<boolean> }) {
  // A page or a file has its name after the host; a folder site has it as the first label of its host (K-1123).
  const segment = props.address.includes("/")
    ? (props.address.split("/")[1] ?? "")
    : (props.address.split(".")[0] ?? "");
  const current = isLibraryId(segment) ? "" : segment;
  const field = useRef<HTMLInputElement>(null);
  // A second Enter while the first save runs would send the same name again and replace its Undo toast.
  const saving = useRef(false);
  const save = async () => {
    const input = field.current;
    const name = input?.value.trim() ?? "";
    if (!input || name === "" || name === current || saving.current) return;
    saving.current = true;
    try {
      if (!(await props.onSave(name)) && input.isConnected) input.value = current;
    } finally {
      saving.current = false;
    }
  };
  return (
    <div class="row">
      <span class="label">Name</span>
      <input
        class="field"
        ref={field}
        aria-label="Address name"
        data-tip="The name in the address: a to z, 0 to 9 and hyphens. Enter saves it; the old address keeps working."
        placeholder="a name, such as my-design"
        key={props.address}
        defaultValue={current}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
          if (event.key === "Escape") event.currentTarget.value = current;
        }}
      />
      <button type="button" class="btn" data-tip="Save the new address name." onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}

/**
 * K-1128: the hostnames that only send visitors on to this card, each with Remove, and a field to add one. Enter or Add
 * sends it; a refused one stays in the field to fix.
 */
function Redirects(props: {
  addresses: ReadonlyArray<string>;
  onAdd: (address: string) => Promise<boolean>;
  onRemove: (address: string) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const add = async () => {
    const input = field.current;
    const address = input?.value.trim() ?? "";
    if (!input || address === "") return;
    if ((await props.onAdd(address)) && input.isConnected) input.value = "";
  };
  return (
    <>
      <div class="label" data-tip="Hostnames that only send visitors on to this card's address (K-1128).">
        Redirects
      </div>
      {props.addresses.map((address) => (
        <div class="row" key={address}>
          <code>{address}</code>
          <button
            type="button"
            class="btn"
            data-tip={`Stop sending visitors from ${address} on to this card.`}
            onClick={() => props.onRemove(address)}
          >
            Remove
          </button>
        </div>
      ))}
      <div class="row">
        <input
          class="field"
          ref={field}
          aria-label="Redirect address"
          data-tip="A hostname under one of kitshn's zones, such as old-name.example.com. At most 5 per card."
          placeholder="old-name.example.com"
          onKeyDown={(event) => event.key === "Enter" && void add()}
        />
        <button type="button" class="btn" data-tip="Add this redirect address." onClick={() => void add()}>
          Add
        </button>
      </div>
    </>
  );
}

function CardPanel(props: {
  resource: Resource;
  /** K-1733: every repo that kitshn knows, for the matches of a repo group. */
  repos: ReadonlyArray<RepoView>;
  /** K-303: the pull request of a preview card, from its deploy environment. */
  pullRequest: number | null;
  state: State;
  zone: string;
  peek: boolean;
  /** K-819: the repo gate of the repo that deploys this card, when it has one. */
  repo: RepoView | null;
  access: AccessState | null;
  onEdit: (edits: Array<Edit>) => Promise<string | null>;
  onPlace: (resource: Resource) => void;
  onReshare: (resource: Resource, circle: Circle, share: boolean, part: StackPart) => void;
  /** K-212: a new end time, null for no end, or "now". */
  onTime: (resource: Resource, endsAt: number | null | "now") => void;
  /** K-534: removes a port card after a confirm. */
  onRemovePortCard: (resource: Resource) => void;
  onNewCircle: (ids: ReadonlyArray<string>) => void;
  onJoinCircle: (machine: Resource, circle: Circle) => void;
  onLeaveCircle: (machine: Resource, circle: Circle) => void;
  onRemoveApp: (resource: Resource) => void;
  onRollback: (resource: Resource, mode: "card" | "run") => void;
  /** K-1117: swaps a page or a file with its previous version, or null when it has none. */
  onRestorePrevious: ((resource: Resource) => void) | null;
  /** K-1120: a page or a file gets a new address name. */
  onSetAddress: (resource: Resource, name: string) => Promise<boolean>;
  redirects: ReadonlyArray<string>;
  onRedirect: (resource: Resource, address: string, remove: boolean) => Promise<boolean>;
  onLogs: (resource: Resource) => void;
  /** K-1819: the newest backup run of this card, or null. */
  backup: BackupRun | null;
  r2Bucket: BucketSize | null;
  /** K-1815: no backup key, so backups are off. */
  backupsOff: boolean;
  onBackUpNow: (resource: Resource) => void;
  onBackups: (resource: Resource) => void;
  /** K-909: on the admin card, what removed Worker apps left in Cloudflare. */
  orphanWorkers: ReadonlyArray<OrphanWorker>;
  onDeleteOrphanWorker: (orphan: OrphanWorker) => void;
  /** K-909: a deploy made this card, so "Remove app" applies. */
  deployed: boolean;
  /** K-821: a pull request preview, which has no rollback. */
  preview: boolean;
  /** K-820: the newest deploy of this card failed or did not run. */
  deployNote: DeployNote | null;
  /** K-1125: up or down, when kitshn checks this card. */
  uptime: Snapshot["uptime"][string] | null;
  machine: MachineView | null;
  /** K-1625: the machine of a provider card, for the commands of its list rows. */
  providerMachine: MachineView | null;
  cardSettings: Readonly<Record<string, string>>;
  providerCommands: Snapshot["providerCommands"];
  onSetCardSetting: (card: Resource, key: string, value: string) => void;
  jobs: ReadonlyArray<JobView>;
  onRemoveMachine: (view: MachineView) => void;
  onRunJob: (view: MachineView, command: Command) => Promise<void>;
  /** K-707, K-1615: a provider command; a question asks first. */
  onRunProviderCommand: (view: MachineView, command: Command, question: string | null) => void;
  version: string;
  onToast: (text: string, error: boolean) => void;
}) {
  const { resource, state, machine } = props;
  const progress = useStore().snapshot?.progress[resource.id] ?? null;
  const holding = circlesHolding(state, resource.id);
  const address = resource.addresses[0];
  const stack = [...state.stacks.values()].find((each) => each.members.includes(resource.id));
  const [removing, setRemoving] = useState<{ readonly circle: Circle; readonly anchor: Rect } | null>(null);
  /** The circle row whose level and share end show; the row itself shows a set end as a sticker. */
  const [opened, setOpened] = useState<string | null>(null);
  // The stack went while the choice was open (another device, or undo): the choice ends with it.
  if (removing && !stack) setRemoving(null);
  return (
    <section>
      {removing && stack ? (
        <Menu
          label={`Remove from ${removing.circle.name}`}
          anchor={removing.anchor}
          onClose={() => setRemoving(null)}
        >
          {stackChoice(state, stack).map(({ part, label, tip }) => (
            <MenuItem
              key={part}
              tip={`${tip} out of ${removing.circle.name}.`}
              onSelect={() => props.onReshare(resource, removing.circle, false, part)}
            >
              {label}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      <div class="label" data-tip={kindInfo(resource).help}>
        {kindInfo(resource).name}
      </div>
      <h2>
        <ItemIcon resource={resource} />
        {resource.name}
      </h2>
      {address ? (
        <div class="row">
          <code>{address}</code>
          <button
            class="btn"
            data-tip={`Copy https://${address} to the clipboard.`}
            onClick={() => void navigator.clipboard.writeText(`https://${address}`)}
          >
            Copy address
          </button>
          <a
            class="btn"
            href={`https://${address}`}
            target="_blank"
            rel="noreferrer"
            data-tip="Open the address in a new tab."
          >
            Open
          </a>
        </div>
      ) : null}
      {props.peek && peekable(resource) ? (
        <PeekRow key={resource.id} resource={resource} state={state} zone={props.zone} />
      ) : null}
      {address &&
      (resource.kind === "page" ||
        resource.kind === "file" ||
        (resource.id.startsWith(FOLDER_SITE_PREFIX) && !props.repo)) ? (
        <AddressName address={address} onSave={(name) => props.onSetAddress(resource, name)} />
      ) : null}
      {address && props.repo ? (
        <p class="help">Its repo sets this address: change it in kitshn.config.ts.</p>
      ) : null}
      {props.pullRequest !== null && props.repo ? (
        <div class="row">
          <a
            class="btn"
            href={`https://github.com/${props.repo.name}/pull/${props.pullRequest}`}
            target="_blank"
            rel="noreferrer"
            data-tip={`Open pull request #${props.pullRequest} of ${props.repo.name} on GitHub. This preview goes when it closes.`}
          >
            Pull request #{props.pullRequest} ↗
          </a>
        </div>
      ) : null}
      {resource.kind === "repo.group" ? (
        <RepoGroupPanel group={resource} repos={props.repos} onToast={props.onToast} />
      ) : null}
      {progress ? (
        <ProgressRow
          cardId={resource.id}
          progress={progress}
          // A failed daemon update offers its next steps where it failed, not only in the machine panel below.
          next={
            machine && progress.action === "Update daemon"
              ? [
                  {
                    label: "Try again",
                    tip: MACHINE_TIPS.update(props.version),
                    run: () => void props.onRunJob(machine, { kind: "update", version: props.version }),
                  },
                  {
                    label: "Diagnostics",
                    tip: "Collect diagnostics of the daemon as a job; the output shows in the machine panel.",
                    run: () => void props.onRunJob(machine, { kind: "diagnostics" }),
                  },
                ]
              : []
          }
          onToast={props.onToast}
        />
      ) : null}
      {props.access ? <AccessRow access={props.access} /> : null}
      {props.uptime ? <UptimeRow resource={resource} uptime={props.uptime} /> : null}
      {props.deployNote ? (
        <div class="row">
          <span
            class="label"
            data-tip="The newest deploy of this card. The card still serves its last good deploy."
          >
            Deploy
          </span>
          <span class="sticker">{props.deployNote.state === "skipped" ? "not run" : "failed"}</span>
          <span class="muted">{props.deployNote.reason}</span>
        </div>
      ) : null}
      {!state.places.has(resource.id) ? (
        <button
          class="btn primary"
          data-tip="Place the card in the middle of the view, outside every circle, so it stays private."
          onClick={() => props.onPlace(resource)}
        >
          Place on the map
        </button>
      ) : null}
      <div
        class="label"
        style={{ marginTop: "12px" }}
        data-tip="Who can open it: each circle that holds the card, its members and the level."
      >
        Who can open it
      </div>
      {holding.length === 0 ? (
        <p>
          No circle holds it, so <b>no one</b> can open it.
        </p>
      ) : (
        <ul>
          {holding.map((circle) => {
            const setting = state.shareSettings.get(shareKey(resource.id, circle.id));
            const level = shareLevel(state, resource, circle);
            const put = (next: { level: Level | null; endsAt: number | null }) =>
              props.onEdit([
                {
                  _tag: "shareSetting",
                  resourceId: resource.id,
                  circleId: circle.id,
                  after: next.level === null && next.endsAt === null ? null : next,
                },
              ]);
            return (
              <li key={circle.id}>
                <div class="row">
                  <span class="swatch" style={{ background: circle.color }} /> <b>{circle.name}</b>
                  <span
                    class="sticker"
                    data-tip={
                      level
                        ? LEVEL_TIPS[level]
                        : "None: this kind has no level at or below the circle's level."
                    }
                    style={{ background: level ? LEVEL_COLORS[level] : undefined }}
                  >
                    {level ?? "none"}
                  </span>
                  <button
                    class="btn"
                    aria-haspopup={stack ? "menu" : undefined}
                    aria-expanded={stack ? removing?.circle.id === circle.id : undefined}
                    data-tip={
                      stack
                        ? `Remove ${resource.name} or all of ${stackTitle(state, stack)} from ${circle.name}, without a drag.`
                        : `Remove ${resource.name} from ${circle.name}, without a drag.`
                    }
                    onClick={(event) => {
                      // K-527: a stacked card asks which part leaves; Escape or a click outside does nothing.
                      if (stack) setRemoving({ circle, anchor: event.currentTarget.getBoundingClientRect() });
                      else props.onReshare(resource, circle, false, "stack");
                    }}
                  >
                    Remove
                  </button>
                  {setting?.endsAt != null ? (
                    <span
                      class="sticker wait"
                      data-tip={`Share ends: ${resource.name} leaves ${circle.name} at this time; its other circles stay.`}
                    >
                      share ends {untilText(setting.endsAt).replace("until ", "")}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    class="more"
                    aria-expanded={opened === circle.id}
                    aria-label={`Level and share end in ${circle.name}`}
                    data-tip={`${opened === circle.id ? "Hide" : "Show"} the level of ${resource.name} in ${circle.name} and when this share ends.`}
                    onClick={() => setOpened(opened === circle.id ? null : circle.id)}
                  >
                    ⋯
                  </button>
                </div>
                <div class="row">
                  {circle.members.map((member, index) => (
                    <span class="chip" key={index} data-tip={MEMBER_HELP[memberKind(member, state)]}>
                      {MEMBER_ICONS[memberKind(member, state)]} {memberLabel(member, state)}
                    </span>
                  ))}
                </div>
                {opened === circle.id ? (
                  <>
                    <div class="field-row">
                      <span
                        class="label"
                        data-tip="Level: the level of this card in this circle. Default follows the circle."
                      >
                        Level
                      </span>
                      <LevelOverride
                        resource={resource}
                        circle={circle}
                        state={state}
                        onEdit={props.onEdit}
                      />
                    </div>
                    <div class="field-row">
                      <span
                        class="label"
                        data-tip="Share ends: at this date the card leaves this one circle; its other circles stay."
                      >
                        Share ends
                      </span>
                      <EndsPicker
                        key={`${resource.id}/${circle.id}`}
                        endsAt={setting?.endsAt ?? null}
                        ends="kitshn moves the card out of this circle"
                        onChange={(endsAt) => void put({ level: setting?.level ?? null, endsAt })}
                      />
                    </div>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {state.places.has(resource.id) ? <ReachList state={state} selected={resource.id} /> : null}
      {resource.kind === "machine" && machine ? <ConnectChecklist view={machine} state={state} /> : null}
      {resource.kind === "machine" ? (
        <MemberOf
          machine={resource}
          circles={[...state.circles.values()]}
          onJoin={props.onJoinCircle}
          onLeave={props.onLeaveCircle}
        />
      ) : null}
      {state.places.has(resource.id) && resource.id !== ADMIN_RESOURCE_ID ? (
        <div style={{ margin: "12px 0" }}>
          <div
            class="label"
            data-tip="Card leaves every circle: at this time kitshn moves the card to the tray, out of every circle (K-212)."
          >
            Card leaves every circle
          </div>
          <div>
            <EndsPicker
              key={resource.id}
              endsAt={state.ends.get(resource.id) ?? null}
              ends="kitshn moves the card to the tray, out of every circle,"
              presets={TIME_PRESETS}
              onChange={(endsAt) => props.onTime(resource, endsAt)}
            />
            {state.ends.has(resource.id) ? (
              <button
                type="button"
                class="btn"
                data-tip={`Move ${resource.name} to the tray now, out of every circle. Undo puts it back.`}
                onClick={() => props.onTime(resource, "now")}
              >
                End now
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {state.places.has(resource.id) ? (
        <>
          <div class="label" data-tip="Share with: put the card into one more circle, without a drag.">
            Share with
          </div>
          <div class="row">
            {[...state.circles.values()]
              .filter((circle) => !holding.includes(circle))
              .map((circle) => (
                <button
                  key={circle.id}
                  class="btn"
                  data-tip={`Share ${resource.name} with ${circle.name} at ${circle.level}, without a drag.`}
                  onClick={() => props.onReshare(resource, circle, true, "stack")}
                >
                  <span class="swatch" style={{ background: circle.color }} /> {circle.name}
                </button>
              ))}
            <button
              class="btn"
              data-tip={`Make a new circle with no members around ${resource.name}; add its members next.`}
              onClick={() => props.onNewCircle([resource.id])}
            >
              New circle…
            </button>
          </div>
        </>
      ) : null}
      {isPortCard(resource) ? (
        <PortDoors resource={resource} onRemove={() => props.onRemovePortCard(resource)} />
      ) : null}
      {props.repo ? (
        <div class="row">
          <span class="label" data-tip="Deploys: whether pushes of the repo of this card deploy.">
            Deploys
          </span>
          {props.repo.goneOnGitHub ? (
            <span class={`sticker ${GONE_STICKER.style}`} data-tip={GONE_STICKER.tip}>
              deleted on GitHub
            </span>
          ) : (
            <span
              class={`sticker ${REPO_STICKERS[props.repo.state].style}`}
              data-tip={REPO_STICKERS[props.repo.state].tip}
            >
              {props.repo.state}
            </span>
          )}
          {/* A repo marked deleted keeps Block, so a wrong mark stays recoverable; it never offers Allow. */}
          {props.repo.goneOnGitHub && props.repo.state === "blocked" ? null : (
            <button
              type="button"
              class={props.repo.state === "blocked" ? "btn" : "btn danger"}
              data-tip={
                props.repo.state === "blocked"
                  ? `Allow deploys of ${props.repo.name} again.`
                  : `Block deploys of ${props.repo.name}: kitshn refuses them until you allow it again.`
              }
              onClick={async () => {
                if (!props.repo) return;
                const next = props.repo.state === "blocked" ? "allowed" : "blocked";
                const { text, error } = await setRepoState(props.repo, next);
                props.onToast(text, error);
              }}
            >
              {props.repo.state === "blocked" ? "Allow deploys" : "Block deploys"}
            </button>
          )}
        </div>
      ) : null}
      {hasLogs(resource.kind) && props.deployed ? (
        <button class="btn" data-tip={LOGS_TIP} onClick={() => props.onLogs(resource)}>
          Logs…
        </button>
      ) : null}
      {resource.kind === "site.compose" && props.deployed && !props.preview ? (
        <section aria-label="Backups">
          <div class="label" data-tip="Backups: daily copies of the volumes and the data folder (K-1811).">
            Backups
          </div>
          {props.backupsOff ? (
            <>
              <p class="error">Backups are off: kitshn has no backup key yet.</p>
              <details class="raw">
                <summary data-tip="The one step that turns backups on.">How to turn them on</summary>
                <p class="help">
                  Run the bootstrap in a terminal with <code>KITSHN_BACKUP_KEY_NOW=1</code>. It prints the key
                  once: keep it outside Cloudflare, because nobody reads the backups without it (K-1815).
                </p>
              </details>
            </>
          ) : null}
          {props.r2Bucket && props.r2Bucket.bytes >= BACKUP_LIMIT_BYTES ? (
            <p class="error">
              Backups wait: the R2 bucket holds {gigabytes(props.r2Bucket.bytes)} of the 10 GB of the free
              plan.
            </p>
          ) : null}
          <div class="row">
            {props.backup ? (
              <>
                <span>{backupLabel(props.backup)}</span>{" "}
                {backupFailureShown(props.backup, progress) ? <BackupState run={props.backup} /> : null}
              </>
            ) : props.backupsOff ? null : (
              <span class="muted">No backup yet; the first runs tonight.</span>
            )}
          </div>
          <div class="row">
            <button
              class="btn"
              disabled={props.backupsOff}
              data-tip={
                props.backupsOff
                  ? "Back up now needs the backup key first."
                  : "Back up the volumes and the data folder of this app now."
              }
              onClick={() => props.onBackUpNow(resource)}
            >
              Back up now
            </button>
            <button
              class="btn"
              data-tip="List the backups of this app, and restore one."
              onClick={() => props.onBackups(resource)}
            >
              Backups…
            </button>
          </div>
        </section>
      ) : null}
      {isAppCard(resource) && props.deployed && !props.preview ? (
        <div class="row">
          <button
            class="btn"
            data-tip={`Roll back: serve an earlier deploy of this card again. ${ROLLBACK_DATA}`}
            onClick={() => props.onRollback(resource, "card")}
          >
            Roll back…
          </button>
          {/* K-1123: a folder site comes from no workflow run. */}
          {resource.id.startsWith(FOLDER_SITE_PREFIX) && !props.repo ? null : (
            <button
              class="btn"
              data-tip={`Roll back every card of the workflow run that made this deploy. ${ROLLBACK_DATA}`}
              onClick={() => props.onRollback(resource, "run")}
            >
              Roll back this run…
            </button>
          )}
        </div>
      ) : null}
      {props.onRestorePrevious ? (
        <button
          class="btn"
          data-tip="Put the previous version back. The current one becomes the previous version, so a second restore swaps them back (K-1117)."
          onClick={() => props.onRestorePrevious?.(resource)}
        >
          Restore previous version
        </button>
      ) : null}
      {resource.provider ? (
        <ProviderFacts
          resource={resource}
          card={resource.provider}
          values={props.cardSettings}
          commands={
            props.providerCommands[resource.machine ?? ""]?.find(
              (item) => item.name === resource.provider?.name,
            )?.commands ?? []
          }
          onSetting={(key, value) => props.onSetCardSetting(resource, key, value)}
          onRow={
            props.providerMachine
              ? (command, row) =>
                  props.onRunProviderCommand(
                    props.providerMachine!,
                    {
                      kind: "provider",
                      provider: resource.provider!.name,
                      command: command.id,
                      resource: resource.id,
                      row,
                    },
                    command.confirm ? `${command.title} for this row of ${resource.name}?` : null,
                  )
              : null
          }
        />
      ) : null}
      {resource.kind.startsWith("site.") ? (
        <Redirects
          addresses={props.redirects}
          onAdd={(name) => props.onRedirect(resource, name, false)}
          onRemove={(name) => void props.onRedirect(resource, name, true)}
        />
      ) : null}
      {machine ? (
        <MachinePanel
          view={machine}
          version={props.version}
          jobs={props.jobs}
          onRemove={() => props.onRemoveMachine(machine)}
          onRun={(command) => props.onRunJob(machine, command)}
          onToast={props.onToast}
        />
      ) : null}
      {isAppCard(resource) && props.deployed ? (
        <button
          class="btn danger"
          data-tip={removeAppTip(resource, resource.id.startsWith(FOLDER_SITE_PREFIX) && !props.repo)}
          onClick={() => props.onRemoveApp(resource)}
        >
          Remove app
        </button>
      ) : null}
      {props.orphanWorkers.length > 0 ? (
        <>
          <div
            class="label"
            data-tip="Orphaned Worker storage: Workers and KV namespaces of removed apps that still hold their data in Cloudflare."
          >
            Orphaned Worker storage
          </div>
          <p class="help">
            What removed Worker apps left. Undo of a removal does not bring back deleted data.
          </p>
          <ul>
            {props.orphanWorkers.map((orphan) => {
              const parts = [
                ...(orphan.script ? [`the Worker ${orphan.script} with its Durable Objects`] : []),
                ...orphan.kv.map((name) => `the KV ${name}`),
              ];
              return (
                <li key={orphan.card}>
                  <div class="row">
                    <code>{orphan.card}</code>
                    <button
                      class="btn danger"
                      data-tip={`Delete ${parts.join(", ")} and their data. Undo cannot bring them back.`}
                      onClick={() => props.onDeleteOrphanWorker(orphan)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * K-633: the connect steps. They open by themselves for a new machine; "Show" reaches them on any machine with an open
 * step, and "Hide" is per device. They go when all are done.
 */
function ConnectChecklist(props: { view: MachineView; state: State }) {
  const { snapshot } = useStore();
  const access = snapshot?.access;
  const [asked, setAsked] = useState(false);
  const steps = useMemo(
    () => connectChecklist(props.view, props.state, access ?? {}),
    [props.view, props.state.resources, props.state.circles, access],
  );
  if (steps.every((step) => step.done)) return null;
  const id = props.view.machine.id;
  if (!asked && (!isNewMachine(props.view.machine, Date.now()) || hiddenChecklists().has(id)))
    return (
      <button
        type="button"
        class="btn"
        data-tip="Show the steps that are still open for this machine."
        onClick={() => {
          setChecklistHidden(id, false);
          setAsked(true);
        }}
      >
        Show the connect steps
      </button>
    );
  return (
    <section aria-label="Connect this machine">
      <div class="label" data-tip="Each step ticks itself off when kitshn sees it happen.">
        Connect this machine
      </div>
      <ol class="progress-steps">
        {steps.map((step) => (
          <li key={step.label} class={step.done ? "done" : "next"}>
            {step.done ? "✓" : "·"} {step.label}
            {step.done ? null : <p class="help">{step.next}</p>}
          </li>
        ))}
      </ol>
      <button
        type="button"
        class="btn"
        data-tip="Hide these steps on this device, for a machine that skips one, such as one with no T3."
        onClick={() => {
          setChecklistHidden(id, true);
          setAsked(false);
        }}
      >
        Hide
      </button>
    </section>
  );
}

/** K-539: the circles that a machine belongs to, each with its way out, and the others as one click in. */
function MemberOf(props: {
  machine: Resource;
  circles: ReadonlyArray<Circle>;
  onJoin: (machine: Resource, circle: Circle) => void;
  onLeave: (machine: Resource, circle: Circle) => void;
}) {
  const { machine } = props;
  const of = props.circles.filter((circle) => machineMember(circle, machine.id));
  const others = props.circles.filter(
    (circle) => !machineMember(circle, machine.id) && !isPublicCircle(circle),
  );
  return (
    <>
      <div
        class="label"
        data-tip={`Member of: ${machine.name} belongs to these circles and opens what they hold. Sharing the card only says who opens the machine.`}
      >
        Member of
      </div>
      {of.length === 0 ? <p class="muted">No circle yet.</p> : null}
      {of.map((circle) => (
        <div key={circle.id} class="row">
          <span class="swatch" style={{ background: circle.color }} /> <b>{circle.name}</b>
          <button
            type="button"
            class="btn"
            data-tip={`${machine.name} leaves ${circle.name}. Its share stays. Undo puts it back with its rights.`}
            onClick={() => props.onLeave(machine, circle)}
          >
            Leave
          </button>
        </div>
      ))}
      <div class="row">
        {others.map((circle) => (
          <button
            key={circle.id}
            type="button"
            class="btn"
            data-tip={`${machine.name} joins ${circle.name} as a member, with no agent right yet.`}
            onClick={() => props.onJoin(machine, circle)}
          >
            + <span class="swatch" style={{ background: circle.color }} /> {circle.name}
          </button>
        ))}
      </div>
    </>
  );
}

/** K-523: a menu of the actions of one card, stack, circle or spot; the palette has the same ones. */
function ContextMenu(props: {
  menu: { readonly target: MenuTarget; readonly anchor: Rect };
  context: ActionContext;
  handlers: ActionHandlers;
  onClose: () => void;
}) {
  const { target } = props.menu;
  const groups = actionsFor(props.context, props.handlers, target);
  if (!groups) return null;
  const { state } = props.context;
  const stackOfTarget = target._tag === "stack" ? state.stacks.get(target.id) : undefined;
  const name =
    target._tag === "card"
      ? state.resources.get(target.id)?.name
      : target._tag === "stack"
        ? stackOfTarget && stackTitle(state, stackOfTarget)
        : target._tag === "circle"
          ? state.circles.get(target.id)?.name
          : "the map";
  const label = target._tag === "add" ? "Add" : `Actions for ${name ?? "the map"}`;
  return <ActionMenu label={label} anchor={props.menu.anchor} groups={groups} onClose={props.onClose} />;
}

/** K-407: the Access row of a card panel: applied as a stamp; applying, retrying and failed as stickers with why. */
export function AccessRow(props: { readonly access: AccessState }) {
  return (
    <div class="row">
      <span class="label" data-tip="Access: whether Cloudflare has the latest shares of this card.">
        Access
      </span>
      {props.access.state === "applied" ? (
        <span class="stamp" data-tip={ACCESS_TIPS.applied}>
          ✓ applied
        </span>
      ) : (
        <span
          class={`sticker ${props.access.state === "failed" ? "" : "wait"}`}
          data-tip={
            props.access.state === "applying"
              ? ACCESS_TIPS.applying
              : props.access.state === "retrying"
                ? ACCESS_TIPS.retrying
                : "Failed: Cloudflare refused the change."
          }
        >
          {props.access.state}
        </span>
      )}
      {props.access.state === "failed" ? <span class="muted">{props.access.error}</span> : null}
      {props.access.state === "retrying" ? (
        <span class="muted">
          {props.access.error} Next try at {new Date(props.access.at).toLocaleTimeString()}.
        </span>
      ) : null}
    </div>
  );
}

const STICKER_CLASSES: Record<ProviderSticker["tone"], string> = {
  info: "info",
  good: "ok",
  warn: "wait",
  bad: "",
};

/** K-1625: the stickers and facts that a provider attaches to its card; kitshn shows them without reading them. */
function ProviderFacts(props: {
  resource: Resource;
  card: ProviderCard;
  values: Readonly<Record<string, string>>;
  commands: ReadonlyArray<ProviderCommand>;
  onSetting: (key: string, value: string) => void;
  /** Null while kitshn does not know the machine of the card. */
  onRow: ((command: ProviderCommand, row: string) => void) | null;
}) {
  const { card } = props;
  return (
    <>
      {/* K-717: a setting of the card; a missing value is the default of the setting. */}
      {card.settings.map((setting) => {
        const current = props.values[setting.id] ?? setting.default;
        return (
          <div key={setting.id} class="row">
            <span
              class="label"
              data-tip={`${setting.title}: ${card.name} gets this value on ${props.resource.name}.`}
            >
              {setting.title}
            </span>
            <div class="seg small">
              {setting.values.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === current}
                  data-tip={`Set ${setting.title} to ${value}. It needs control on this card.`}
                  onClick={() => value !== current && props.onSetting(setting.id, value)}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {/* K-1625: a list of the card, with the commands of each row. */}
      {card.lists.map((list) => (
        <section key={list.id}>
          <h3 class="label">{list.title}</h3>
          <table class="provider-list">
            <thead>
              <tr>
                {list.columns.map((column) => (
                  <th key={column.id}>{column.title}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.id}>
                  {list.columns.map((column) => (
                    <td key={column.id}>{row.cells[column.id] ?? ""}</td>
                  ))}
                  <td>
                    {(row.commands ?? []).map((id) => {
                      const command = props.commands.find((item) => item.id === id);
                      return command && props.onRow ? (
                        <button
                          key={id}
                          type="button"
                          class="btn"
                          data-tip={`${command.title} for this row; an offline machine runs it when it connects.`}
                          onClick={() => props.onRow!(command, row.id)}
                        >
                          {command.title}
                        </button>
                      ) : null;
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {card.droppedAt !== undefined ? (
        <p class="help">
          {card.name} no longer reports this card, since {whenText(card.droppedAt)}. It keeps its place and
          shares, offline, until {card.name} reports it again or you forget it.
        </p>
      ) : null}
      {card.stickers.length > 0 ? (
        <div class="row">
          {card.stickers.map((sticker, index) => {
            const tip = `${card.name} reports: ${sticker.text}.${sticker.link ? " Opens its link in a new tab." : ""}`;
            const className = `sticker ${STICKER_CLASSES[sticker.tone]}`;
            return sticker.link ? (
              <a
                key={index}
                class={className}
                href={sticker.link}
                target="_blank"
                rel="noreferrer"
                data-tip={tip}
              >
                {sticker.text}
              </a>
            ) : (
              <span key={index} class={className} data-tip={tip}>
                {sticker.text}
              </span>
            );
          })}
        </div>
      ) : null}
      {card.facts.length > 0 ? (
        <dl class="facts">
          {card.facts.map((fact) => (
            <div key={fact.label} class="row">
              <dt class="label" data-tip={`${fact.label}, as ${card.name} reports it.`}>
                {fact.label}
              </dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}
