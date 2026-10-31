import { ICON_LIMIT, iconType, pageDataIcon } from "kitshn/icon";
import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";
import {
  ACCESS_NAME_PREFIX,
  ASK_APP,
  ENROLLMENT_KEY,
  type OldAddress,
  desiredAccess,
} from "../core/access.ts";
import {
  FOLDER_SITE_PREFIX,
  appRestart,
  appTeardown,
  composeUndo,
  keepsScript,
  orphanVolumes,
} from "../core/apps.ts";
import {
  type Actor,
  type AppCard,
  type Change,
  type Edit,
  type Forget,
  RuleError,
  applyChanges,
  conflictOf,
  deepEqual,
  invert,
  type Item,
  mergeMoves,
  mergedSummary,
  type StoredRevision,
  undoAnswer,
  prepareUndo,
  undoTarget,
  refuseLockout,
  refuseRaiseWhilePaused,
  refuseResume,
  removeAppChanges,
  forgetProviderChanges,
  resolveEdits,
  restoredResource,
  revisionTargets,
  type RevisionTarget,
  targetOf,
  ruleViolation,
  stacksWithout,
  endText,
  shareDiff,
  summarize,
  withAutoUpdate,
} from "../core/changes.ts";
import {
  type LiveStatus,
  type Rollout,
  type StepJob,
  advanceRollout,
  daemonUpdate,
  manualStep,
  restartsAfterUpdate,
  withoutMachine,
  isRelease,
  lastLine,
  nextAutoUpdate,
  BUSY_CAP_MS,
  releaseBusyStep,
  withBusyWaits,
  parseRollout,
  startStep,
  stepSent,
} from "../core/autoUpdate.ts";
import {
  ADMIN_RESOURCE_ID,
  AGENT_RIGHTS,
  AGENT_RIGHT_NAMES,
  MACHINE_RIGHTS,
  OWNER_CIRCLE_ID,
  shareKey,
  MACHINE_RIGHT_NAMES,
  type MachineRight,
  type GitHubWay,
  GITHUB_WAYS,
  type Circle,
  type Member,
  type Point,
  type Resource,
  type ShareSetting,
  pauseModeOf,
  type Stack,
  type State,
  UNDO_SOURCES,
  type UndoSource,
  circlesHolding,
  fnv,
  levelName,
} from "../core/model.ts";
import {
  type Command,
  type DaemonMessage,
  type Machine,
  type MachineKey,
  type MachineStatus,
  type ProjectVolume,
  type Sample,
  type ServerToDaemon,
  type AskOutcome,
  type AskResult,
  type AppAccess,
  allowedFor,
  connectText,
  FORWARD_HEADERS,
  FORWARD_WINDOW_MS,
  forwardPathProblem,
  forwardText,
  fingerprintOf,
  parseAllowances,
  parsePublicKey,
  joinLookup,
  newChallenge,
  newInviteCode,
  newJoinCode,
  rotateText,
  sealJoin,
  verifyForHosts,
} from "../core/machine.ts";
import {
  NO_SIZES,
  ORGANIZE_SUMMARY,
  type DrawnSizes,
  drawnSizes,
  organize,
  organizeSummary,
} from "../core/organize.ts";
import { inviteClients } from "../core/invite.ts";
import { placeInside } from "../core/place.ts";
import { type ServerReport, parseSiteInput, serversOf } from "../core/sites.ts";
import {
  type LogAnswer,
  type LogSearch,
  type TailAnswer,
  TAIL_BATCH,
  logAnswerOf,
  logLinesOf,
} from "../core/logs.ts";
import { type RunSource, deployRuns, searchWorker, startWorkerTail, stopWorkerTail } from "./logs.ts";
import {
  nextBackupAt,
  pauseLimit,
  BACKUP_LIMIT_BYTES,
  type BackupRun,
  type BucketSize,
  R2_FREE_BYTES,
  gigabytes,
  BACK_UP_NOW,
} from "../core/backups.ts";
import { bucketSize, stateExport, writeExport } from "./backups.ts";
import {
  IMPORT_OBJECT,
  type ImportCode,
  ImportError,
  type ImportRefusal,
  notEmptyReason,
  readExport,
  writeImport,
} from "./state-import.ts";
import { MIGRATIONS } from "./migrations.ts";
import {
  type DoorRow,
  type GameRecordRow,
  type GameRow,
  doorOf,
  gameOf,
  gameRecords,
  gameStatus,
  recordBody,
} from "./games.ts";
import {
  DEFAULT_DOOR_MS,
  type Door,
  DOOR_LIMITS,
  doorAddress,
  doorFamily,
  doorMachine,
  doorPlan,
  gameError,
  joinAddress,
  openDoors,
  parsePort,
  portKey,
  busyPort,
  relayHost,
} from "../core/game.ts";
import type {
  AddressHold,
  DeployNote,
  MachineView,
  OrphanWorker,
  AskEventView,
  LinkEventView,
  ProposalView,
  RepoView,
  RevisionView,
  ServerMessage,
  Snapshot,
} from "../core/protocol.ts";
import {
  type AllowingAgent,
  type RepoGate,
  type RepoState,
  agentAllowRefusal,
  forgetRefusal,
  gateDecision,
  keyRemoved,
} from "../core/repos.ts";
import { ClientMessage, LogQuery, TailMessage } from "../core/schema.ts";
import {
  type LastDeploy,
  agentDeployPlan,
  agentHas,
  agentHomeCircle,
  agentMayCommand,
  agentRefusal,
  cardsControlledBy,
  circlesOf,
  isEveryoneCircle,
  isPreview,
  mayDeployOn,
  agentUploadPlace,
  codeRightMode,
  codeRightOff,
  machineOf,
  machineRightMode,
  machineRightOff,
} from "../core/agent.ts";
import { DEMO_MACHINES, DEMO_ICONS, demo, demoUsage } from "../core/demo.ts";
import { type Usage, type UsageRow, usageLevel } from "../core/usage.ts";
import {
  HOUR_MS,
  MACHINE_OFFLINE_MS,
  NOTIFY_ALL_HOUR,
  NOTIFY_BODY_MAX,
  NOTIFY_PER_CARD_HOUR,
  NOTIFY_TOKENS_KEPT,
  appEvent,
  takeSlot,
} from "../core/notify.ts";
import { readUsage } from "./usage.ts";
import {
  FAILING_FOR_MS,
  UPTIME_FETCHES_PER_RUN,
  UPTIME_KEEP_MS,
  UPTIME_IDLE_MS,
  UPTIME_RUN_MS,
  UP,
  type Uptime,
  type UptimeChange,
  cardsOfRun,
  nextUptime,
  probeUp,
  stored,
} from "../core/uptime.ts";
import { githubWayOf, matchProblem, repoGroupId } from "../core/repoGroups.ts";
import {
  ASK_EVENT_COUNT,
  ASK_EVENT_DAYS,
  ASK_RIGHT,
  type AskAction,
  type ProposalAction,
  forwardShown,
  PROPOSAL_MS,
  type Proposal,
  APPROVED_WINDOW_MS,
  MAX_OPEN_PROPOSALS,
  MAX_SHOWN,
  askRequest,
  isAskAction,
  conditionProblem,
  labelProblem,
  shownAsk,
  shownHash,
  WINDOW_ACTIONS,
  answerRefusal,
} from "../core/asks.ts";
import { type MachineOs, machineOs } from "../core/icons.ts";
import {
  contentSecurityPolicy,
  type ContentVisitor,
  type LibraryItem,
  MAX_UPLOAD_BYTES,
  contentAccess,
  RESERVED_SITE_NAMES,
  addressNameError,
  addressSegment,
  fileNameError,
  isLibraryId,
  libraryAddress,
  newLibraryId,
  randomAddressName,
  objectKey,
  openToAll,
  slotKey,
  uploadKind,
} from "../core/library.ts";
import { badgeState } from "../core/badge.ts";
import { listedApps } from "../core/listing.ts";
import {
  commandsFor,
  machineBusy,
  providerCards,
  providerPushes,
  reachOf,
  siteGuardClientsOf,
} from "../core/providers.ts";
import {
  SITE_GUARD_CAPABILITY,
  SITE_GUARD_KEY,
  SITE_LINKS_CAPABILITY,
  SITE_REACH_KEY,
  reservedSiteLinkHost,
  siteLinkDomain,
  siteLinkHost,
} from "../core/machine.ts";
import { healthCell, healthNotices } from "../core/health.ts";
import {
  commandName,
  execMachinesOf,
  execOutcome,
  execProviderOn,
  migrateAgentShares,
} from "../core/exec.ts";
import {
  HealthReport as HealthReportSchema,
  type HealthReport,
  ExecFrame as ExecFrameSchema,
  ExecRun as ExecRunSchema,
  type ExecFrame,
  type ExecRun,
  type ProviderClient,
  type ProviderCommand,
  desiredProblem,
  type ProviderKind,
  type ProviderRefusal,
  type ProviderReport,
  decodeProviderReports,
  pushKey,
  reportProblem,
} from "@kitshn/local";
import {
  type ActionProgress,
  type PlannedStep,
  failProgress,
  finishProgress,
  progressShown,
  reachStep,
  startProgress,
  withRetry,
} from "../core/progress.ts";
import { seed } from "../core/seed.ts";
import { type Visitor, circleMatches, visitorLevel } from "../core/visitor.ts";
import { APPROVE_APPS } from "../core/access.ts";
import {
  DEFAULT_LEVELS,
  PUSH_SENDS_PER_RUN,
  PUSH_TEST_MS,
  type PushDevice,
  deviceWants,
  pushMessage,
} from "../core/push.ts";
import { type VapidKey, generateVapidJwk, pushTopic, sendPush, vapidKey } from "./push.ts";
import {
  type Mute,
  NOTIFICATIONS_KEEP_MS,
  INFO_OPEN_MS,
  NOTIFICATIONS_MAX,
  type Notification,
  type NotificationInput,
  TEXT_MAX,
  TITLE_MAX,
  NOTIFICATION_SOURCES,
  changed,
  clip,
  muted,
  onBell,
} from "../core/notifications.ts";
import {
  type AccessRow,
  type AccessStore,
  type Api,
  accessStates,
  appliesBypass,
  CALLS_PER_RUN,
  fillAudiences,
  hasAccessWork,
  rowsWithoutAud,
  type SignOutOutcome,
  readSignOutLeft,
  retryApps,
  revokeSessions,
  sessionApps,
  signOutSummary,
  signOutWarning,
  syncAccess,
  syncLauncher,
  LOGIN_CALLS,
  loginHeld,
  loginHeldAfter,
  loginWant,
  loginWarnings,
  syncLogins,
  syncWithLogins,
  verifyAccess,
  verifyPasskeys,
} from "./access-sync.ts";
import { approverOf } from "./auth.ts";
import { MAX_KEYS, type PassKey, RETIRED_MS, discovery, jwks, newPassKey, signPass } from "./passes.ts";
import type { Caller, Deployer } from "./auth.ts";
import { CloudflareError, cloudflare } from "./cloudflare.ts";
import {
  NotInstalled,
  type RepoOnGitHub,
  appBotLogin,
  rerunWorkflowRun,
  dispatchDeploy,
  repoToken,
  reposOnGitHub,
  revokeToken,
  sealToken,
  openToken,
} from "./github.ts";
import { REPLACED, dropLiveSite, failQueuedDowns, removalDown, requeueDowns } from "./downs.ts";
import { AGENTS_MIGRATION, REPO_GATE_MIGRATION, migrate } from "./migrations.ts";
import {
  BADGE_DEPLOY_QUERY,
  DEPLOY_MS,
  REDIRECT_SCRIPT,
  REDIRECT_WORKER,
  SCRIPT_LIMIT,
  STATIC_WORKER,
  jobError,
  keptImages,
  parseWorkerModule,
  parseWorkerSecrets,
  workerMetadata,
  environmentNames,
  eventOf,
  legacyRepos,
  parseManifest,
  FOLDER_PART_BYTES,
  parseConfigFile,
  parseSiteIcon,
  pullRequestNumber,
} from "./deploys.ts";
import { DEFAULT_APP } from "kitshn/names";
import { AppKey, type Recipe, WorkerApp, decodeRecipe, deployOrder, plan, repoSlug } from "kitshn/recipe";
import { removeStaleDomains, zoneFor, zoneOfAddressIn, zonesOf, zonesOrMain } from "./zones.ts";
import {
  type ComposeRun,
  wantedRecords,
  type LiveSite,
  ingressAccess,
  fitAttachment,
  liveSiteId,
  type AccessAppListing,
  type ForeignPath,
  foreignHolds,
  foreignPaths,
  LIVE_LABEL,
  reachableAddresses,
  offlineReason,
  parseSites,
  addressRecords,
  dnsRecordRefusal,
  nextCardAddresses,
  protectedLiveSites,
  servedSites,
  sitesNeedingRoutes,
  tunnelConfig,
} from "./live.ts";
import {
  JOB_EXPIRY_MS,
  DEVICE_INVITE_MS,
  JOIN_CODE_MS,
  type Job,
  OUTPUT_LIMIT,
  LIVENESS_CHECK_MS,
  PING_TIMEOUT_MS,
  machineIdFor,
  parseCommand,
  parseLabels,
  legacyUpdateScript,
  type MachineCheck,
  answerCheck,
  pickMachine,
  providerRefusals,
  execPathsOf,
  rekeyDecision,
  socketStart,
} from "./machines.ts";
import { adminHosts, type Env, loginPages } from "./env.ts";
import { askPage, helpPageHeaders, wantedAddress } from "./help-pages.ts";

/** What a WebSocket of this Durable Object belongs to. */
type Attachment =
  | {
      readonly kind: "map";
      readonly caller: Caller;
      /** K-1805, K-1807: the tails of this map; kept on the socket, so they survive hibernation. */
      readonly tails?: ReadonlyArray<MapTail>;
    }
  | {
      readonly kind: "machine";
      readonly machineId: string;
      readonly since: number;
      /** K-1704: the challenge of this socket. A rotation on it signs it too (K-1705). */
      readonly challenge: string;
      readonly check: MachineCheck;
      /** K-1704: each socket takes one answer only. */
      readonly answered: boolean;
      /** K-1705: who pressed "Rotate key" in the panel; History names them. */
      readonly rotateBy: Actor | null;
      /** K-605, K-606: kept on the socket, so they survive hibernation and cost no row writes. */
      readonly status: MachineStatus | null;
      readonly sample: Sample | null;
      /** K-909: the idle volumes of kitshn apps; a socket from before this field has none. */
      readonly volumes?: ReadonlyArray<ProjectVolume>;
      /** K-619: the listening ports of the machine; an older daemon sends none. */
      readonly servers?: ReadonlyArray<ServerReport>;
      /** K-630: the last health check of this connection; an older daemon sends none. */
      readonly health?: HealthReport;
    };

/** K-1805: a Compose tail runs on the daemon; K-1807: a Worker tail is a Cloudflare tail of the script. */
type MapTail =
  | { readonly kind: "compose"; readonly id: string; readonly machineId: string }
  | { readonly kind: "worker"; readonly id: string; readonly script: string };

/** The attachment of a socket; null for one that never got one, which every reader skips. */
const attachmentOf = (socket: WebSocket) => socket.deserializeAttachment() as Attachment | null;

/** K-619, K-909: every write of a machine socket's attachment, trimmed to the attachment budget. */
const saveMachine = (socket: WebSocket, attachment: Extract<Attachment, { kind: "machine" }>) =>
  socket.serializeAttachment(fitAttachment(attachment));

const decodeHealth = Schema.decodeUnknownSync(HealthReportSchema);
const decodeExecFrame = Schema.decodeUnknownSync(ExecFrameSchema);
/** K-722: the meta key that marks the `t3.agents` step of migration 42 as done. */
const AGENTS_MIGRATED = "agents-migrated";
const decodeExecRun = Schema.decodeUnknownSync(ExecRunSchema);
/** K-1610: how often the maps hear of new link events. */
const LINK_BROADCAST_MS = 10_000;
/** K-1610: the forwarded calls of one machine that kitshn records in a minute; the rest are counted and dropped. */
const LINK_CALLS_PER_MINUTE = 120;

/** K-722: one run that kitshn relays; a row of `exec_runs`, so an evicted Durable Object finds it again. */
type ExecRow = {
  readonly exec_id: string;
  readonly source: string;
  readonly target: string;
  readonly provider: string | null;
  readonly command: string;
  readonly cwd: string | null;
  readonly thread: string | null;
  readonly proposal_id: string | null;
  readonly state: "waiting" | "running";
};

/** K-704: what kitshn keeps of one provider's registration; its cards are rows of `resources`. */
interface ProviderRegistration {
  readonly name: string;
  readonly kinds: ReadonlyArray<ProviderKind>;
  readonly commands: ReadonlyArray<ProviderCommand>;
  /** K-720: the client apps that take a device invite. */
  readonly clients?: ReadonlyArray<ProviderClient>;
}

/** K-1704 */
const CHALLENGE_MS = 10_000;
/** K-1705 */
const ROTATED = 4004;
/** K-1706 */
const KEY_RESET = 4005;

/** K-110: a sign-out or retry that started longer ago than this no longer blocks a new one (a lost run). */
const SIGN_OUT_RUN_MS = 3 * 60_000;
/** The map keeps this many recent revisions in memory; History reads them (K-519). */
const RECENT_REVISIONS = 200;
/** K-1305: how long the Durable Object keeps the Usage answer. */
const USAGE_CACHE_MS = 5 * 60_000;
/** K-1503 */
const REVISION_DAYS = 90;
const REVISION_COUNT = 5000;
const DAY = 24 * 60 * 60 * 1000;

const nextUtcMidnight = (now: number) => Math.floor(now / DAY) * DAY + DAY;

const decodeClientMessage = Schema.decodeUnknownSync(ClientMessage);
const decodeLogQuery = Schema.decodeUnknownSync(LogQuery);
const decodeTailMessage = Schema.decodeUnknownSync(TailMessage);

/** K-1804 */
const LOG_ANSWER_MS = 20_000;

/** K-1502, K-1507: the revision that an undo reverses; `item` names the card or circle of a per-item undo. */
interface UndoOf {
  readonly revision: number;
  readonly item: string | null;
  /** K-1509: where a whole-revision Undo came from; a per-item undo has none. */
  readonly source: UndoSource | null;
}

/** K-1509: a stored source; null for rows before it existed. Any other value is bad data, so it throws. */
function undoSourceOf(value: string | null): UndoSource | null {
  if (value === null) return null;
  const source = UNDO_SOURCES.find((each) => each === value);
  if (!source) throw new Error(`A revision names an unknown undo source "${value}".`);
  return source;
}

/** K-1907: the `meta` key of the VAPID private key; no read path, export or backup includes it. */
const VAPID_META = "push_vapid_jwk";

interface PushRow extends Record<string, SqlStorageValue> {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  email: string;
  label: string;
  levels: string;
  quiet_start: number | null;
  quiet_end: number | null;
  time_zone: string | null;
  created_at: number;
  last_ok_at: number | null;
}

const pushDeviceOf = (row: PushRow): PushDevice => ({
  id: row.id,
  label: row.label,
  email: row.email,
  levels: (JSON.parse(row.levels) as Array<string>).map((level) =>
    oneOf(level, ["info", "warn", "error"] as const),
  ),
  quiet:
    row.quiet_start === null || row.quiet_end === null || row.time_zone === null
      ? null
      : { start: row.quiet_start, end: row.quiet_end, timeZone: row.time_zone },
  createdAt: row.created_at,
  lastOkAt: row.last_ok_at,
});

/** The bytes of a base64url text, or null when it is not base64url. */
function base64UrlBytes(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** K-1907: a subscription from the browser, checked. A push endpoint is an https address of a push service. */
function pushInput(body: unknown) {
  if (!isRecord(body)) return "Send the subscription as JSON.";
  const { endpoint, p256dh, auth, label, levels, quiet } = body;
  if (typeof endpoint !== "string" || !URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:")
    return "The endpoint is not an https address.";
  // RFC 8291: the browser key is an uncompressed P-256 point (65 bytes), the auth secret 16 bytes.
  if (
    typeof p256dh !== "string" ||
    base64UrlBytes(p256dh)?.length !== 65 ||
    base64UrlBytes(p256dh)?.[0] !== 4
  )
    return "The browser key is not a P-256 point of 65 bytes.";
  if (typeof auth !== "string" || base64UrlBytes(auth)?.length !== 16)
    return "The auth secret is not 16 bytes.";
  if (typeof label !== "string" || label.trim() === "" || label.length > 80)
    return "Name the device in at most 80 characters.";
  const chosen = Array.isArray(levels) ? levels : DEFAULT_LEVELS;
  if (!chosen.every((level) => level === "info" || level === "warn" || level === "error"))
    return "The levels are info, warn and error.";
  let hours: { start: number; end: number; timeZone: string } | null = null;
  if (quiet !== null && quiet !== undefined) {
    if (!isRecord(quiet)) return "Quiet hours have a start, an end and a time zone.";
    const { start, end, timeZone } = quiet;
    const minute = (value: unknown) =>
      Number.isInteger(value) && Number(value) >= 0 && Number(value) < 24 * 60;
    if (!minute(start) || !minute(end) || typeof timeZone !== "string")
      return "Quiet hours have a start and an end in minutes after midnight, and a time zone.";
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      return `kitshn does not know the time zone ${timeZone}.`;
    }
    hours = { start: Number(start), end: Number(end), timeZone };
  }
  return {
    endpoint,
    p256dh,
    auth,
    label: label.trim(),
    levels: chosen as Array<"info" | "warn" | "error">,
    quiet: hours,
  };
}

interface NotificationRow extends Record<string, SqlStorageValue> {
  id: number;
  source: string;
  key: string;
  card_id: string | null;
  recipients: string;
  level: string;
  priority: string;
  title: string;
  text: string;
  actions: string;
  state: string;
  opened_at: number;
  closed_at: number | null;
  snoozed_until: number | null;
  episode: string;
}

/** JSON text as a value, or null when it is no JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A stored value outside its set is a bug, so it fails loudly (K-006). */
function oneOf<const T extends string>(value: string, values: ReadonlyArray<T>): T {
  const found = values.find((each) => each === value);
  if (found === undefined) throw new Error(`kitshn read ${value}, which is none of ${values.join(", ")}.`);
  return found;
}

const notificationOf = (row: NotificationRow): Notification => ({
  id: row.id,
  source: row.source,
  key: row.key,
  card: row.card_id,
  recipients: JSON.parse(row.recipients) as Notification["recipients"],
  level: oneOf(row.level, ["info", "warn", "error"] as const),
  priority: oneOf(row.priority, ["normal", "high"] as const),
  title: row.title,
  text: row.text,
  actions: JSON.parse(row.actions) as Notification["actions"],
  episode: row.episode,
  state: row.state,
  openedAt: row.opened_at,
  closedAt: row.closed_at,
  snoozedUntil: row.snoozed_until,
});

interface DeployFacts {
  readonly deployed: ReadonlyArray<string>;
  /** The deployed cards with a deploy of a pull request environment (K-821). */
  readonly previews: ReadonlyArray<string>;
  /** K-303: the pull request number of each preview card, from its `pr-<n>` environment. */
  readonly pullRequests: ReadonlyArray<readonly [string, number]>;
  /** `id` is the newest deploy of the card, the episode of its deploy notification (K-1905). */
  readonly notes: ReadonlyArray<{ resource_id: string; id: string; state: string; reason: string | null }>;
  readonly repoCards: ReadonlyArray<{ repo_id: string; resource_id: string }>;
  /** K-817, K-901: the Compose deploys that are planned, running or done and not expired, with their addresses. */
  readonly composeRuns: ReadonlyArray<ComposeRun>;
  /** K-718: the newest deploy of each card, for `/agent/state`. */
  readonly newest: ReadonlyMap<string, { id: string; state: string; reason: string | null }>;
}

/** The POST paths that take a client message as their body. */
const API_MESSAGES: Readonly<Record<string, ClientMessage["type"]>> = {
  "/api/apply": "apply",
  "/api/undo": "undo",
  "/api/undo-item": "undoItem",
  "/api/organize": "organize",
};

/** K-003: the one Durable Object. It holds all state in SQLite and a copy in memory. */
export class Kitshn extends DurableObject<Env> {
  private state!: State;
  /**
   * K-1302: the recent History, read on first use. A wake for a daemon message or an alarm never reads it; it
   * costs about 4 rows per revision. Writers change it only when it is loaded, because SQL has their row.
   */
  private revisionCache: Array<RevisionView> | null = null;
  /** K-1126: the last uptime turn of this wake; an alarm in the same turn fetches nothing. */
  private uptimeSlot: number | null = null;
  /** K-1125: the cards that are down or failing, read on first use (K-1302); a card with no row is up. */
  private uptimeCache: Map<string, Uptime> | null = null;
  private get uptime(): Map<string, Uptime> {
    this.uptimeCache ??= new Map(
      this.sql<{ card_id: string; up: number; failing_since: number | null; since: number }>(
        "SELECT card_id, up, failing_since, since FROM uptime",
      ).map((row) => [row.card_id, { up: row.up === 1, failingSince: row.failing_since, since: row.since }]),
    );
    return this.uptimeCache;
  }
  /** K-1906: the open notifications by source and key, read on first use. */
  private openCache: Map<string, Notification> | null = null;
  private get openNotifications(): Map<string, Notification> {
    this.openCache ??= new Map(
      this.sql<NotificationRow>("SELECT * FROM notifications WHERE closed_at IS NULL").map((row) => {
        const notification = notificationOf(row);
        return [`${notification.source}\u0000${notification.key}`, notification];
      }),
    );
    return this.openCache;
  }
  /** K-1905: the mutes, read on first use. */
  private muteCache: Array<Mute> | null = null;
  private get mutes(): Array<Mute> {
    this.muteCache ??= this.sql<{ card_id: string; source: string; until: number | null }>(
      "SELECT card_id, source, until FROM notification_mutes",
    ).map((row) => ({ card: row.card_id, source: row.source, until: row.until }));
    return this.muteCache;
  }
  /** K-1905: the dismissed episode of each source and key, read on first use; the newest row wins. */
  private dismissedCache: Map<string, string> | null = null;
  private get dismissed(): Map<string, string> {
    this.dismissedCache ??= new Map(
      this.sql<{ source: string; key: string; episode: string }>(
        "SELECT source, key, episode FROM notifications WHERE state = 'dismissed' ORDER BY id",
      ).map((row) => [`${row.source}\u0000${row.key}`, row.episode]),
    );
    return this.dismissedCache;
  }
  /** K-1905: the last time the alarm looked for ended mutes and snoozes, so the bell count follows them. */
  private bellCheckedAt = 0;
  /** K-1903: the handler of "run" actions, per source. */
  private readonly actionHandlers = new Map<
    string,
    /** The error text when the action does not run, else null. */
    (notification: Notification, action: string, caller: Caller) => Promise<string | null> | string | null
  >();
  private get revisions(): Array<RevisionView> {
    this.revisionCache ??= this.loadRevisions();
    return this.revisionCache;
  }
  /**
   * K-909: the cards whose orphaned Worker storage kitshn deletes now; their deploys and Undo wait. Known limit: it
   * lives in memory. A restart in the middle of a delete ends the delete with no History entry for the part that went,
   * and can leave a KV row whose namespace Cloudflare already deleted; the storage step of the next deploy finds such a
   * row and makes the namespace again. Revisit when a delete must survive a restart, for example with a row per delete.
   */
  private readonly deletingStorage = new Set<string>();
  /**
   * K-1302: the Access rows, read on first use and then kept for the life of the object; a wake for a daemon sample
   * never needs them. Every write goes through accessStore(), which writes the map and the table together.
   */
  private accessCache: Map<string, AccessRow> | null = null;
  private get access(): Map<string, AccessRow> {
    this.accessCache ??= new Map(
      this.sql<{
        key: string;
        cf_id: string;
        aud: string;
        body: string;
        tried: string;
        error: string | null;
      }>("SELECT key, cf_id, aud, body, tried, error FROM access_objects").map((row) => [
        row.key,
        { key: row.key, cfId: row.cf_id, aud: row.aud, body: row.body, tried: row.tried, error: row.error },
      ]),
    );
    return this.accessCache;
  }
  /** Expired shares whose card has no place outside the circle. Retried once after each restart. */
  private stuckShares = new Set<string>();
  /**
   * K-532: the sizes of the last map Organize, in memory, so an agent Organize keeps the map's spacing. Known limit:
   * a new wake forgets them and an agent then uses plain card sizes; revisit if agents organize often.
   */
  private drawn: DrawnSizes | null = null;
  /**
   * K-212: the end times that site reports carry (`kitshn expose --time` or `--ends-at`) for live site cards that the
   * address check has not made yet. Known limit: in memory only, so a wake between the report and the check, a few
   * seconds, forgets one; that card then has no end, in the tray (K-509).
   */
  private pendingEnds = new Map<string, number>();
  /** K-1104: the circle of `kitshn expose --circle` for a live site card that does not exist yet; same limit. */
  private pendingCircles = new Map<string, string>();
  /**
   * K-1131: who asked for each site of the site wizard, by job id; `done` once that job succeeded. The new card's end
   * runs as that person, so the person can undo it (K-1506). Known limit: in memory only; after a wake the end runs as
   * the machine.
   */
  private siteAskers = new Map<
    number,
    { readonly siteId: string; readonly by: Actor; readonly circle: string | null; done: boolean }
  >();
  /** K-1716: false once `github_tokens` is known to be empty, so a broadcast reads no row of it. True after a wake. */
  private tokensLive = true;
  private accessWarnings: Array<string> = [];
  /** K-819: a GitHub check of the repos runs, so a second open tab starts none. */
  private checkingRepos = false;
  /** K-606: presence is stored on change; status and the latest sample live on the socket. */
  private presence = new Map<string, { online: boolean; lastSeen: number; os: MachineOs | null }>();
  /** K-2004: the last open or close of a door, by card and person. */
  private doorTurns = new Map<string, number>();
  /** K-2004: the open-to-all game cards of the last door plans; null after a restart, so the next check sends all. */
  private openGamesSent: string | null = null;
  /**
   * K-1113: the hash of each stored card icon, the bytes stay in SQLite until a map asks. K-1114: when each icon
   * last changed, so a daemon changes one at most once an hour. Read on first use (K-1302).
   */
  private iconCache: { hashes: Map<string, string>; changedAt: Map<string, number> } | null = null;
  private get icons() {
    if (!this.iconCache) {
      const rows = this.sql<{ id: string; hash: string; changed_at: number }>(
        "SELECT id, hash, changed_at FROM icons",
      );
      this.iconCache = {
        hashes: new Map(rows.map((row) => [row.id, row.hash])),
        changedAt: new Map(rows.map((row) => [row.id, row.changed_at])),
      };
    }
    return this.iconCache;
  }
  private get iconHashes() {
    return this.icons.hashes;
  }
  private get iconChangedAt() {
    return this.icons.changedAt;
  }
  /** K-1104: live sites of the machines. */
  private liveSites = new Map<string, LiveSite>();
  /** K-1610: when an audit last told the maps of new link events. */
  private linkBroadcastAt = 0;
  /** K-1610: the recorded link calls of each machine in the current minute. */
  private linkRates = new Map<string, { minute: number; count: number; dropped: number }>();
  /** K-704: the kinds and commands of each machine's providers, by machine id. */
  private providerRegs = new Map<string, Array<ProviderRegistration>>();
  /** K-1608: the hash of each push of each machine with providers, by machine id and push key. */
  private pushHashes = new Map<string, Map<string, string>>();
  /** K-1608: the hash of what each signed connection got last, by `<machine id>/<push key>`. */
  private sentGrants = new Map<string, string>();
  /** K-709: the parts of each desired state, by kind and by machine id ("" for the shared part). */
  private desiredState = new Map<string, Map<string, unknown>>();
  /** K-709: the rev of the last set of each desired state, from `desired_revs`. */
  private desiredRevs = new Map<string, string>();
  /** K-717: card setting values, by card id. */
  private cardSettings = new Map<string, Record<string, string>>();
  /** K-1608: the hash of the last push that each machine applied, by `<machine id>/<push key>`. */
  private applied = new Map<string, string>();
  /** K-1117: the library items that an update, a restore or a delete changes now. */
  private busyItems = new Set<string>();
  /**
   * K-1129: the upload of an owner's folder site: the session token, the files that it may send, and the token
   * that ends it. Known limit: in memory only, so a restart of the Durable Object ends the upload, and the owner
   * uploads again. Revisit when uploads often outlive a restart.
   */
  private folderUploads = new Map<string, { jwt: string; hashes: ReadonlySet<string>; done: string }>();
  /** K-1129: where an owner dropped a folder, until its files arrive; it goes with the upload at a restart. */
  private folderDrops = new Map<string, Point>();
  /** Address checks that failed, and when to try them again. Memory only; a restart retries at once. */
  private checkRetryAt = new Map<string, number>();
  /**
   * K-1302: the deploy rows that each snapshot needs, read once. Each scan reads the whole deploys table, which
   * kitshn never prunes; `sql` drops this memo on every write that names the table.
   */
  private deployFacts: DeployFacts | null = null;

  /** K-1305: the last Usage answer, kept in memory for 5 minutes, so the view costs no writes. */
  private usage: Usage | null = null;

  /** K-1708: the last failed challenge of each machine, for the panel. Memory only (K-1302). */
  private keyFailures = new Map<string, { readonly at: number; readonly reason: string }>();
  /** K-627: the rollout of `meta`, read once. */
  private rolloutCache: Rollout | null = null;
  private progressCache: Map<string, StoredProgress> | null = null;
  /** K-538: a job came since `reconcileProgress` last read the open jobs; true at wake, so it reads them once. */
  private jobsAdded = true;

  private meta(key: string): string | null {
    const [row] = this.sql<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
    return row?.value ?? null;
  }

  /** Writes a meta value only when it changes (K-1302). */
  private setMeta(key: string, value: string) {
    if (this.meta(key) !== value)
      this.sql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  /** K-1623: the record that served a taken address before, kept until the owner gives the address back. */
  private handoverOf(siteId: string): AddressHandover | null {
    const value = this.meta(`address-handover:${siteId}`);
    return value === null ? null : (JSON.parse(value) as AddressHandover);
  }

  private setHandover(siteId: string, value: AddressHandover | null) {
    if (value === null) this.sql("DELETE FROM meta WHERE key = ?", `address-handover:${siteId}`);
    else this.setMeta(`address-handover:${siteId}`, JSON.stringify(value));
  }

  /** K-538: the last action of each card, kept after it ends so the next run of it learns its times. */
  private progressRows(): Map<string, StoredProgress> {
    return (this.progressCache ??= new Map(
      // A key range, so the primary key index reads only these rows; LIKE would read all of meta.
      this.sql<{ key: string; value: string }>(
        "SELECT key, value FROM meta WHERE key >= 'progress:' AND key < 'progress;'",
      ).map((row) => [row.key.slice(PROGRESS_META.length), JSON.parse(row.value) as StoredProgress]),
    ));
  }

  /** Returns true when the progress of the card changed. */
  private setProgress(cardId: string, value: StoredProgress | null) {
    const rows = this.progressRows();
    if (deepEqual(rows.get(cardId) ?? null, value)) return false;
    if (value === null) {
      rows.delete(cardId);
      this.sql("DELETE FROM meta WHERE key = ?", PROGRESS_META + cardId);
    } else {
      rows.set(cardId, value);
      this.setMeta(PROGRESS_META + cardId, JSON.stringify(value));
    }
    return true;
  }

  /** K-538: a new action of a card replaces its last one. */
  private startAction(
    cardId: string,
    source: StoredProgress["source"],
    action: string,
    plan: ReadonlyArray<PlannedStep>,
    now = Date.now(),
  ) {
    const before = this.progressRows().get(cardId)?.progress ?? null;
    this.setProgress(cardId, { source, progress: startProgress(action, plan, now, before) });
  }

  /** With `only`, it moves the card's action only while that source drives it, so a newer action stays as it is. */
  private moveAction(
    cardId: string,
    change: (progress: ActionProgress) => ActionProgress,
    only?: StoredProgress["source"],
  ) {
    const row = this.progressRows().get(cardId);
    if (row && (only === undefined || deepEqual(row.source, only)))
      this.setProgress(cardId, { ...row, progress: change(row.progress) });
  }

  /**
   * K-538: one call of the CLI in a static or Worker deploy moves its card to the step with `label`. The CLI stops at
   * an answer that is not ok, so such an answer or a throw fails the action, except a 503 that says to run it again
   * (accessNotReady), which waits as a retry.
   */
  private async deployCall(row: DeployRow, label: string, call: () => Promise<Response>) {
    const move = (change: (progress: ActionProgress) => ActionProgress) => {
      this.moveAction(row.resource_id, change, { _tag: "deploy", deployId: row.id });
      this.broadcast();
    };
    move((progress) => {
      const index = progress.steps.findIndex((step) => step.label === label);
      return withRetry(index < 0 ? progress : reachStep(progress, index, Date.now()), null);
    });
    try {
      const response = await call();
      if (response.ok) {
        // A finish that went live set the row to done.
        this.settleDeployAction(row.id);
        this.broadcast();
        return response;
      }
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const reason =
        isRecord(body) && typeof body["error"] === "string"
          ? body["error"]
          : `kitshn answered ${response.status}.`;
      move((progress) =>
        response.status === 503
          ? withRetry(progress, { reason, at: Date.now() })
          : failProgress(progress, reason, Date.now()),
      );
      return response;
    } catch (error) {
      move((progress) =>
        failProgress(progress, error instanceof Error ? error.message : String(error), Date.now()),
      );
      throw error;
    }
  }

  /** K-538: a static or Worker deploy that a card shows; a first deploy has no card yet, so it shows nothing. */
  private startDeployAction(
    deployId: string,
    row: Pick<DeployRow, "app" | "worker" | "repo_id" | "resource_id">,
  ) {
    if (!this.state.resources.has(row.resource_id)) return;
    this.startAction(row.resource_id, { _tag: "deploy", deployId }, "Deploy", deployPlan(row));
    this.broadcast();
  }

  /**
   * K-538: moves each running action on from the state that drives it, and starts the action of each new job that has
   * one. It runs before each map update, so every client shows the same steps. Returns true when one changed.
   */
  /**
   * `settle` also reads the rows of deploys and run rollbacks, at wake and in the alarm: their state changes move their
   * stickers at once (settleDeployAction, settleRollbackAction), so this catches only a deploy that expired.
   */
  private reconcileProgress(now = Date.now(), wake = false, settle = wake) {
    let changed = false;
    for (const [cardId, row] of this.progressRows()) {
      if (row.progress.outcome.state !== "running") continue;
      // No client shows the action of a card that is gone, so it reads nothing until an Undo brings the card back.
      if (!this.state.resources.has(cardId)) continue;
      // A job, a handover, a deploy and a run rollback resume from their stored state. A give-back and a restore to
      // a time run only in their request and its finish, so a running one at wake lost them.
      const source = row.source;
      const progress =
        source._tag === "job"
          ? this.jobProgress(source.jobId, row.progress, now)
          : source._tag === "takeover"
            ? this.takeoverProgress(cardId, row.progress, now)
            : source._tag === "deploy"
              ? settle
                ? this.deployProgress(source.deployId, row.progress, now)
                : row.progress
              : source._tag === "rollback"
                ? settle
                  ? this.runRollbackProgress(source.id, row.progress, now)
                  : row.progress
                : source._tag === "health"
                  ? now >= source.until
                    ? failProgress(row.progress, "The daemon sent no health report within a minute.", now)
                    : row.progress
                  : wake
                    ? failProgress(row.progress, INTERRUPTED, now)
                    : row.progress;
      if (this.setProgress(cardId, { ...row, progress })) changed = true;
    }
    // The open jobs only after a new job came, so most map updates read no job rows.
    const active = this.jobsAdded
      ? this.sql<{ id: number; machine_id: string | null; command: string }>(
          "SELECT id, machine_id, command FROM jobs WHERE state IN ('queued', 'sent') ORDER BY id",
        )
      : [];
    this.jobsAdded = false;
    for (const job of active) {
      const command = JSON.parse(job.command) as Command;
      const action = jobAction(command, this.state.machines.get(job.machine_id ?? "")?.name ?? null);
      const cardId = command.kind === "update" ? job.machine_id : action ? actionCard(command) : null;
      if (!action || cardId === null || !this.state.resources.has(cardId)) continue;
      // A card shows the newest job: a job never takes the card back from itself or from a newer one.
      const shown = this.progressRows().get(cardId)?.source;
      if (shown?._tag === "job" && shown.jobId >= job.id) continue;
      // A Compose rollback job on a card whose run rollback runs is a step of that action (K-821 runs one at a time).
      const running = this.progressRows().get(cardId)?.progress.outcome.state === "running";
      if (shown?._tag === "rollback" && running && command.kind === "compose-rollback") continue;
      this.startAction(cardId, { _tag: "job", jobId: job.id }, action.action, action.plan, now);
      this.moveAction(cardId, (progress) => this.jobProgress(job.id, progress, now));
      changed = true;
    }
    return changed;
  }

  /** K-538: the step of a job's action, from the job and, for an update, the daemon's connection. */
  private jobProgress(jobId: number, progress: ActionProgress, now: number): ActionProgress {
    const [job] = this.sql<{
      state: string;
      output: string;
      expires_at: number;
      machine_id: string | null;
      command: string;
    }>("SELECT state, output, expires_at, machine_id, command FROM jobs WHERE id = ?", jobId);
    if (!job) return failProgress(progress, `${INTERRUPTED} kitshn no longer has its job.`, now);
    // The connection closed during the job; the daemon may still send its result (OFFLINE_OUTPUT).
    const closed = job.state === "failed" && job.output === OFFLINE_OUTPUT;
    if (job.state === "done") return finishProgress(progress, now);
    if (job.state === "expired" || ((closed || job.state === "queued") && job.expires_at <= now))
      return failProgress(progress, "The machine did not finish the job before it expired.", now);
    // A job that failed with an answer ran on the machine, so the failure names the work, not the wait.
    if (job.state === "failed" && !closed)
      return failProgress(reachStep(progress, 1, now), lastLine(job.output), now);
    if (job.state === "queued") return progress;
    const command = JSON.parse(job.command) as Command;
    if (command.kind !== "update") return reachStep(progress, 1, now);
    // K-629: the daemon downloads and checks, restarts, then keeps its new connection for 3 minutes.
    const status = job.machine_id === null ? null : this.liveStatus(job.machine_id);
    const step = status?.version === command.version ? 3 : closed || status === null ? 2 : 1;
    return reachStep(progress, step, now);
  }

  /** K-538: a deploy changed its state, so the sticker of its card follows. It reads the row only for a shown action. */
  private settleDeployAction(deployId: string) {
    for (const [cardId, row] of this.progressRows())
      if (row.source._tag === "deploy" && row.source.deployId === deployId)
        this.setProgress(cardId, {
          ...row,
          progress: this.deployProgress(deployId, row.progress, Date.now()),
        });
  }

  /** K-538: a run rollback moved on or ended, so the sticker of the card where it started follows. */
  private settleRollbackAction(id: string) {
    for (const [cardId, row] of this.progressRows())
      if (row.source._tag === "rollback" && row.source.id === id)
        this.setProgress(cardId, {
          ...row,
          progress: this.runRollbackProgress(id, row.progress, Date.now()),
        });
  }

  /** K-538: the end of a static or Worker deploy, from its row; the calls of the CLI move its steps (deployCall). */
  private deployProgress(deployId: string, progress: ActionProgress, now: number): ActionProgress {
    const [row] = this.sql<{ state: string; reason: string | null; expires_at: number }>(
      "SELECT state, reason, expires_at FROM deploys WHERE id = ?",
      deployId,
    );
    if (!row) return failProgress(progress, `${INTERRUPTED} kitshn no longer has its deploy.`, now);
    if (row.state === "done") return finishProgress(progress, now);
    if (row.state === "failed") return failProgress(progress, row.reason ?? "The deploy failed.", now);
    if (row.expires_at <= now)
      return failProgress(progress, "The deploy did not finish before it expired.", now);
    return progress;
  }

  /** K-538, K-821: the step of "Roll back this run": one step per card, from its row. */
  private runRollbackProgress(id: string, progress: ActionProgress, now: number): ActionProgress {
    const [row] = this.sql<{ state: string; next: number; notes: string }>(
      "SELECT state, next, notes FROM rollbacks WHERE id = ?",
      id,
    );
    if (!row) return failProgress(progress, `${INTERRUPTED} kitshn no longer has the run rollback.`, now);
    if (row.state === "done") return finishProgress(progress, now);
    if (row.state === "failed")
      return failProgress(
        progress,
        (JSON.parse(row.notes) as Array<string>).at(-1) ?? "The run rollback stopped.",
        now,
      );
    return reachStep(progress, row.next, now);
  }

  /** K-1623, K-538: the step of "Take the address", from the handover, the Access row and the machine's push. */
  private takeoverProgress(cardId: string, progress: ActionProgress, now: number): ActionProgress {
    const site = this.liveSites.get(cardId);
    const handover = this.handoverOf(cardId);
    if (handover?.switched) return finishProgress(progress, now);
    if (!site || !handover || site.state !== "handover")
      return failProgress(progress, "The handover stopped: the site or its handover went.", now);
    const app = Boolean(this.access.get(`app:${site.id}:${site.address}`)?.cfId);
    const step = !app
      ? 0
      : handover.ingressAt === null
        ? 1
        : !this.audienceApplied(site)
          ? 2
          : now < handover.ingressAt + HANDOVER_INGRESS_MS
            ? 3
            : 4;
    // K-407, K-410: a refused or unclear Cloudflare write of the step that runs shows on the sticker.
    const waiting = (alarmStep: AlarmStep) => {
      const failure = this.alarmSteps().get(alarmStep);
      return failure && failure.retryAt > now
        ? { reason: `The ${alarmStep} step of kitshn failed.`, at: failure.retryAt }
        : null;
    };
    let retry: ActionProgress["retry"] = null;
    if (step === 0) {
      const access = accessStates(this.desired(now), this.access)[cardId];
      if (access?.state === "failed") return failProgress(progress, access.error, now);
      retry = access?.state === "retrying" ? { reason: access.error, at: access.at } : waiting("Access");
    } else if (step === 1) {
      const row = this.tunnelRows().find((item) => item.machine_id === site.machineId);
      retry = row?.error ? { reason: row.error, at: row.retry_at } : waiting("tunnels");
    } else if (step === 4) {
      const [row] = this.sql<{ error: string | null; retry_at: number }>(
        "SELECT error, retry_at FROM dns_objects WHERE address = ?",
        site.address,
      );
      retry = row?.error ? { reason: row.error, at: row.retry_at } : waiting("DNS");
    }
    return withRetry(reachStep(progress, step, now), retry);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // K-604: a daemon ping never wakes the Durable Object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // K-1722: "Deny" of an ask runs from its notification; "Approve" is a link, because it needs the approver's proof.
    this.actionHandlers.set("kitshn.ask", async (notification, action, caller) => {
      if (action !== "deny") return `The ask has no action ${action}.`;
      const decided = await this.decide(notification.key, "denied", {
        ...caller,
        machineId: null,
        reason: null,
      });
      return decided.ok ? null : decided.error;
    });
    // K-819: "Allow" and "Block" of a waiting repo run from its notification, as from the repo list.
    this.actionHandlers.set("repo", async (notification, action, caller) => {
      if (action !== "allow" && action !== "block") return `The repo has no action ${action}.`;
      const answer = await this.setRepoState(caller, notification.key, {
        state: action === "allow" ? "allowed" : "blocked",
      });
      if (answer.ok) return null;
      const body: unknown = await answer.json().catch(() => null);
      return isRecord(body) && typeof body["error"] === "string"
        ? body["error"]
        : `answered ${answer.status}`;
    });
    void ctx.blockConcurrencyWhile(async () => {
      // Numbered migrations: each runs once per database, with its version, in one transaction.
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const [version] = ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
        .toArray();
      const from = Number(version?.value ?? 0);
      ctx.storage.transactionSync(() => {
        migrate((query) => ctx.storage.sql.exec(query), from);
        // The rest of migration 6 needs code: the repo id comes out of each card id.
        if (from < REPO_GATE_MIGRATION) this.backfillRepoIds();
        this.migrateAgents();
      });
      this.load();
      // K-1833: a bootstrap with KITSHN_IMPORT asks for one import, before the start steps, so they run on the
      // imported state. Each start reads the meta row of a due finish, and one more while the variable is set.
      await this.importIfDue();
      if (this.state.circles.size === 0) this.seed();
      this.syncAdminAddress();
      this.reconcilePresence();
      // K-821: a restart cut off any run rollback that did not wait for a job.
      this.settleRollbacks();
      // K-538: the progress rows and the open jobs, read at wake, so a map update reads only new jobs. An action that
      // nothing drives after a restart ends as interrupted.
      this.reconcileProgress(Date.now(), true);
      await this.scheduleAlarm();
    });
  }

  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: Array<SqlStorageValue>) {
    if (!query.trimStart().startsWith("SELECT") && query.includes("deploys")) this.deployFacts = null;
    if (query.trimStart().startsWith("INSERT INTO jobs")) this.jobsAdded = true;
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** The SQL of the job helpers in downs.ts, which tests run on node:sqlite. */
  private query = (query: string, ...bindings: Array<string | number | null>) => this.sql(query, ...bindings);

  private load() {
    const json = <T>(rows: Array<{ id: string; body: string }>) =>
      new Map(rows.map((row) => [row.id, JSON.parse(row.body) as T]));
    this.state = {
      circles: json<Circle>(this.sql("SELECT id, body FROM circles")),
      resources: json<Resource>(this.sql("SELECT id, body FROM resources")),
      places: new Map(
        this.sql<{ id: string; x: number; y: number }>("SELECT id, x, y FROM places").map((row) => [
          row.id,
          { x: row.x, y: row.y },
        ]),
      ),
      shareSettings: json<ShareSetting>(this.sql("SELECT id, body FROM share_settings")),
      ends: new Map(
        this.sql<{ id: string; ends_at: number }>("SELECT id, ends_at FROM card_ends").map((row) => [
          row.id,
          row.ends_at,
        ]),
      ),
      stacks: json<Stack>(this.sql("SELECT id, body FROM stacks")),
      paused: pauseModeOf(this.meta("paused")),
      machines: json<Machine>(this.sql("SELECT id, body FROM machines")),
    };
    this.liveSites = new Map(
      this.sql<{
        id: string;
        machine_id: string;
        name: string;
        address: string;
        target: string;
        dev: number;
        up: number;
        last_up: number;
        state: LiveSite["state"];
      }>("SELECT * FROM live_sites").map((row) => [
        row.id,
        {
          id: row.id,
          machineId: row.machine_id,
          name: row.name,
          address: row.address,
          target: row.target,
          dev: row.dev === 1,
          up: row.up === 1,
          lastUp: row.last_up,
          state: row.state,
        },
      ]),
    );
    this.desiredState = new Map();
    for (const row of this.sql<{ kind: string; machine_id: string; body: string }>(
      "SELECT kind, machine_id, body FROM desired_state",
    ))
      (this.desiredState.get(row.kind) ?? this.desiredState.set(row.kind, new Map()).get(row.kind)!).set(
        row.machine_id,
        JSON.parse(row.body) as unknown,
      );
    this.desiredRevs = new Map(
      this.sql<{ kind: string; rev: string }>("SELECT kind, rev FROM desired_revs").map((row) => [
        row.kind,
        row.rev,
      ]),
    );
    this.cardSettings = new Map();
    for (const row of this.sql<{ card_id: string; key: string; value: string }>(
      "SELECT card_id, key, value FROM card_settings",
    ))
      this.cardSettings.set(row.card_id, { ...this.cardSettings.get(row.card_id), [row.key]: row.value });
    this.applied = new Map(
      this.sql<{ machine_id: string; key: string; hash: string }>(
        "SELECT machine_id, key, hash FROM applied_state",
      ).map((row) => [`${row.machine_id}/${row.key}`, row.hash]),
    );
    this.providerRegs = new Map();
    for (const row of this.sql<{ machine_id: string; body: string }>(
      "SELECT machine_id, body FROM providers ORDER BY machine_id, name",
    ))
      (
        this.providerRegs.get(row.machine_id) ??
        this.providerRegs.set(row.machine_id, []).get(row.machine_id)!
      ).push(JSON.parse(row.body) as ProviderRegistration);
    this.presence = new Map(
      this.sql<{ id: string; online: number; last_seen: number; os: string | null }>(
        "SELECT id, online, last_seen, os FROM presence",
      ).map((row) => [
        row.id,
        // Only setMachineOs writes `os`, with a MachineOs.
        { online: row.online === 1, lastSeen: row.last_seen, os: row.os as MachineOs | null },
      ]),
    );
    this.iconCache = null;
    this.accessWarnings = JSON.parse(this.meta("access_warnings") ?? "[]") as Array<string>;
    // The Access rows stay: every write goes through accessStore() or also sets the map (the daily reset).
    this.revisionCache = null;
    this.uptimeCache = null;
    this.openCache = null;
    this.muteCache = null;
    this.dismissedCache = null;
  }

  private loadRevisions(): Array<RevisionView> {
    const rows = this.sql<{
      id: number;
      at: number;
      actor: string;
      summary: string;
      undoes: number | null;
      undo_source: string | null;
      empty: number;
      targets: string;
    }>(
      // K-1508: only the tag, id and stack members of each change, so the load never parses whole circles.
      `SELECT id, at, actor, summary, undoes, undo_source,
         NOT EXISTS (SELECT 1 FROM json_each(changes) WHERE json_extract(value, '$._tag') != 'forget') AS empty,
         (SELECT json_group_array(json_object('_tag', json_extract(value, '$._tag'), 'id', json_extract(value, '$.id'),
             'members', CASE WHEN json_extract(value, '$._tag') = 'stack'
               THEN json_array(json_extract(value, '$.before.members'), json_extract(value, '$.after.members')) END))
           FROM json_each(changes)) AS targets
       FROM revisions ORDER BY id DESC LIMIT ?`,
      RECENT_REVISIONS,
    );
    // An undo comes after the revision that it undoes, so the undo of a recent revision is a recent row too.
    const undone = new Map(
      rows.flatMap((row) => (row.undoes === null ? [] : [[row.undoes, row.id] as const])),
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      actor: JSON.parse(row.actor) as Actor,
      summary: row.summary,
      undoes: row.undoes,
      undoSource: undoSourceOf(row.undo_source),
      undoneBy: undone.get(row.id) ?? null,
      undoable: row.empty === 0,
      ...revisionTargets(JSON.parse(row.targets) as Array<RevisionTarget>),
    }));
  }

  private seed() {
    const emails = this.env.OWNER_EMAILS.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) throw new Error("OWNER_EMAILS is empty: kitshn cannot make the Owner circle.");
    const initial = seed(emails, this.env.KITSHN_HOST, ownerDevices(this.env.OWNER_DEVICES));
    const extra =
      this.env.DEV_DEMO && this.env.KITSHN_HOST === "localhost"
        ? demo()
        : { resources: [], places: [], circles: [] };
    this.ctx.storage.transactionSync(() => {
      for (const resource of [...initial.resources, ...extra.resources]) this.putResource(resource);
      const changes: Array<Change> = [
        ...[...initial.circles, ...extra.circles].map((circle): Change => ({
          _tag: "circle",
          id: circle.id,
          before: null,
          after: circle,
        })),
        ...[...initial.places, ...extra.places].map(([id, point]): Change => ({
          _tag: "place",
          id,
          before: null,
          after: point,
        })),
      ];
      this.persist(changes);
      // The local demo shows the repo gate (K-819): one repo that deploys, one that waits, and two that GitHub
      // deleted, one of them allowed by an agent key that the owner removed.
      if (extra.resources.length > 0)
        for (const [id, name, state, key, goneAt] of [
          ["1001", "Yarden-zamir/riffle", "allowed", null, null],
          ["1002", "Yarden-zamir/new-app", "waiting", null, null],
          ["1003", "Yarden-zamir/kitshn-hello", "allowed", null, Date.now()],
          ["1004", "Yarden-zamir/kitshn-agent-e2e", "allowed", "demo-removed-key", Date.now()],
        ] as const)
          this.sql(
            `INSERT OR IGNORE INTO repos (repo_id, name, state, first_seen, allowed_by_client, allowed_by_name, gone_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            name,
            state,
            Date.now(),
            key,
            key === null ? null : "Yarden's agents",
            goneAt,
          );
      // K-524, K-1113, K-1114: the demo cards show site icons and the system of each machine.
      if (extra.resources.length > 0) {
        for (const icon of DEMO_ICONS)
          this.sql(
            "INSERT OR IGNORE INTO icons (id, type, hash, bytes) VALUES (?, ?, 'demo', ?)",
            icon.id,
            icon.type,
            new TextEncoder().encode(icon.svg).slice().buffer,
          );
        for (const { machine, os } of DEMO_MACHINES) {
          this.sql(
            "INSERT OR IGNORE INTO machines (id, body) VALUES (?, ?)",
            machine.id,
            JSON.stringify(machine),
          );
          this.sql(
            "INSERT OR IGNORE INTO presence (id, online, last_seen, os) VALUES (?, 0, ?, ?)",
            machine.id,
            Date.now() - 3_600_000,
            os,
          );
        }
      }
      // The demo's riffle card counts as deployed, so the card panel shows "Remove app" (K-909).
      if (extra.resources.some((resource) => resource.id === "riffle"))
        this.sql(
          `INSERT OR IGNORE INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file)
           VALUES ('demo-riffle', 'Yarden-zamir/riffle', '1001', 'prod', 'riffle', 'riffle.example.com', '', NULL, 'deploy', 'demo', 'done', 0, 'main', 'compose', NULL, NULL)`,
        );
      this.insertRevision({ _tag: "kitshn", reason: "setup" }, "Set up kitshn", changes, null);
    });
    this.load();
  }

  /** The admin card follows the host that the bootstrap set (K-1208). */
  private syncAdminAddress() {
    const admin = this.state.resources.get(ADMIN_RESOURCE_ID);
    if (!admin || (admin.addresses.length === 1 && admin.addresses[0] === this.env.KITSHN_HOST)) return;
    const updated: Resource = { ...admin, addresses: [this.env.KITSHN_HOST] };
    this.putResource(updated);
    this.state = { ...this.state, resources: new Map(this.state.resources).set(updated.id, updated) };
  }

  private putResource(resource: Resource) {
    this.sql(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      resource.id,
      JSON.stringify(resource),
    );
  }

  private persist(changes: ReadonlyArray<Change>) {
    for (const change of changes) {
      // K-1117: the first move or share of a card ends the tray right of the key that published it.
      const card =
        change._tag === "place" ? change.id : change._tag === "shareSetting" ? change.id.split("/")[0] : null;
      if (card) this.endTrayRight(card);
      if (change._tag === "stack")
        for (const id of [...(change.before?.members ?? []), ...(change.after?.members ?? [])])
          this.endTrayRight(id);
      if (change._tag === "pause") {
        this.setMeta("paused", change.after ?? "");
        continue;
      }
      if (change._tag === "app") {
        if (change.after) this.putResource(restoredResource(change.after));
        else this.sql("DELETE FROM resources WHERE id = ?", change.id);
        continue;
      }
      if (change._tag === "providerCard") {
        if (change.after) this.putResource({ ...change.after, status: "offline" });
        else this.sql("DELETE FROM resources WHERE id = ?", change.id);
        continue;
      }
      if (change._tag === "cardEnd") {
        if (change.after === null) this.sql("DELETE FROM card_ends WHERE id = ?", change.id);
        else
          this.sql("INSERT OR REPLACE INTO card_ends (id, ends_at) VALUES (?, ?)", change.id, change.after);
        continue;
      }
      if (change._tag === "autoUpdate") {
        const machine = this.state.machines.get(change.id);
        if (!machine) throw new RuleError(`No machine "${change.id}" exists.`);
        this.sql(
          "UPDATE machines SET body = ? WHERE id = ?",
          JSON.stringify(withAutoUpdate(machine, change.after)),
          change.id,
        );
        continue;
      }
      if (change._tag === "address") {
        const resource = this.state.resources.get(change.id);
        if (!resource) throw new RuleError(`No card "${change.id}" exists.`);
        this.putResource({ ...resource, addresses: [change.after, ...resource.addresses.slice(1)] });
        const name = addressSegment(change.after);
        if (!isLibraryId(name)) this.claimName(resource.kind === "file" ? "file" : "page", name, change.id);
        continue;
      }
      const table =
        change._tag === "circle"
          ? "circles"
          : change._tag === "place"
            ? "places"
            : change._tag === "stack"
              ? "stacks"
              : "share_settings";
      if (change.after === null) this.sql(`DELETE FROM ${table} WHERE id = ?`, change.id);
      else if (change._tag === "place") {
        this.sql(
          "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
          change.id,
          change.after.x,
          change.after.y,
        );
      } else
        this.sql(
          `INSERT OR REPLACE INTO ${table} (id, body) VALUES (?, ?)`,
          change.id,
          JSON.stringify(change.after),
        );
    }
  }

  /**
   * K-1101, K-1116, K-1123: a new card in the tray (`spot` null) or at `spot`, in one revision. It runs inside the
   * caller's transaction. The UI asks before a drop makes a card public (K-210); an agent key lands only where
   * K-1116 lets it; the pause and K-105 hold for both (K-1504).
   */
  private addCard(actor: Actor, resource: Resource, spot: Point | null, what: string): number {
    this.putResource(resource);
    if (!spot) return this.insertRevision(actor, `Added ${what} to the tray`, [], null);
    const changes: Array<Change> = [{ _tag: "place", id: resource.id, before: null, after: spot }];
    this.checked(changes, {
      ...this.state,
      resources: new Map(this.state.resources).set(resource.id, resource),
    });
    this.persist(changes);
    return this.insertRevision(actor, `Added ${what} on the map`, changes, null);
  }

  /** K-1117, K-1123: the key that published a page, a file or a folder site no longer keeps it by the tray. */
  private endTrayRight(id: string) {
    this.sql("UPDATE library SET agent_tray = 0 WHERE id = ?", id);
    this.sql("UPDATE agent_sites SET agent_tray = 0 WHERE card_id = ?", id);
  }

  /** The newest revision id ever made. It never goes down, also after the cleanup of K-1503. */
  private lastRevision(): number {
    const [row] = this.sql<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'revisions'");
    return row?.seq ?? 0;
  }

  private insertRevision(
    actor: Actor,
    summary: string,
    changes: ReadonlyArray<Change | Forget>,
    undoes: number | null,
    itemUndo: number | null = null,
    undoSource: UndoSource | null = null,
  ) {
    const [row] = this.sql<{ id: number }>(
      "INSERT INTO revisions (at, actor, summary, changes, undoes, item_undo, undo_source) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      Date.now(),
      JSON.stringify(actor),
      summary,
      JSON.stringify(changes),
      undoes,
      itemUndo,
      undoSource,
    );
    if (!row) throw new Error("The revision insert returned no id.");
    return row.id;
  }

  /** K-1124: the old addresses of cards that exist and no longer serve them; a removed card's wait for its Undo. */
  private oldAddresses(): Array<OldAddress> {
    return this.sql<{ address: string; card_id: string }>(
      "SELECT address, card_id FROM old_addresses WHERE going = 0 ORDER BY rowid",
    )
      .filter((row) => this.state.resources.get(row.card_id)?.addresses.includes(row.address) === false)
      .map((row) => ({ cardId: row.card_id, address: row.address }));
  }

  /**
   * K-1124, K-1122: the addresses that a site card stops serving send their visitors on from now; an address that the
   * card serves again is no old address. A card keeps its OLD_NAMES newest old addresses.
   */
  private rememberOld(cardId: string, dropped: ReadonlyArray<string>, serving: ReadonlyArray<string>) {
    for (const address of serving)
      this.sql("DELETE FROM old_addresses WHERE address = ? AND card_id = ?", address, cardId);
    for (const address of dropped) {
      this.sql("DELETE FROM old_addresses WHERE address = ?", address);
      this.sql("INSERT INTO old_addresses (address, card_id) VALUES (?, ?)", address, cardId);
    }
    // K-1128: an address added by hand counts toward the limit, but only old addresses go to keep it.
    const [kept] = this.sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM old_addresses WHERE card_id = ? AND pinned = 1",
      cardId,
    );
    this.sql(
      `DELETE FROM old_addresses WHERE card_id = ? AND pinned = 0 AND rowid NOT IN
       (SELECT rowid FROM old_addresses WHERE card_id = ? AND pinned = 0 ORDER BY rowid DESC LIMIT ?)`,
      cardId,
      cardId,
      Math.max(0, OLD_NAMES - (kept?.n ?? 0)),
    );
  }

  /**
   * K-1124: the redirect Worker serves the old addresses whose Access application exists (K-402) and that no other
   * Worker or DNS record holds any more, and nothing else. It uploads the map again when it changed. K-406: at most
   * `budget` Cloudflare calls.
   */
  private async syncRedirects(api: Api, budget: number) {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const old = this.oldAddresses();
    const map = Object.fromEntries(
      old.map((item) => [item.address, this.state.resources.get(item.cardId)?.addresses[0] ?? ""]),
    );
    const text = JSON.stringify(map);
    let calls = 0;
    // Work that a later run finishes: an Access application or a DNS record that is not there yet, or the budget.
    let waiting = false;
    if (old.length > 0 && this.meta("redirects_map") !== text) {
      const form = new FormData();
      const metadata = {
        main_module: "worker.js",
        compatibility_date: "2026-10-20",
        bindings: [{ type: "plain_text", name: "MAP", text }],
      };
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append(
        "worker.js",
        new Blob([REDIRECT_WORKER], { type: "application/javascript+module" }),
        "worker.js",
      );
      const upload = await fetch(
        `https://api.cloudflare.com/client/v4${account}/workers/scripts/${REDIRECT_SCRIPT}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
          body: form,
        },
      );
      const uploaded = (await upload.json()) as { success: boolean; errors?: unknown };
      if (!uploaded.success)
        throw new Error(`the redirect Worker upload failed: ${JSON.stringify(uploaded.errors)}`);
      // workers.dev would skip Access, as for every kitshn script.
      await api("POST", `${account}/workers/scripts/${REDIRECT_SCRIPT}/subdomain`, {
        enabled: false,
        previews_enabled: false,
      });
      this.setMeta("redirects_map", text);
      calls += 2;
    }
    const attached = await api<Array<{ id: string; hostname: string }>>(
      "GET",
      `${account}/workers/domains?service=${REDIRECT_SCRIPT}`,
    );
    calls++;
    for (const domain of attached)
      this.sql("UPDATE old_addresses SET attached = 1 WHERE address = ?", domain.hostname);
    // K-410: an address that sends no one on any more loses its custom domain first.
    for (const domain of attached) {
      if (domain.hostname in map) continue;
      if (calls >= budget) {
        waiting = true;
        break;
      }
      await api("DELETE", `${account}/workers/domains/${domain.id}`);
      this.sql("UPDATE old_addresses SET attached = 0 WHERE address = ?", domain.hostname);
      // K-1128: a removed redirect address goes for good once its custom domain went.
      this.sql("DELETE FROM old_addresses WHERE address = ? AND going = 1", domain.hostname);
      calls++;
    }
    for (const { cardId, address } of old) {
      if (attached.some((domain) => domain.hostname === address)) continue;
      if (calls >= budget) {
        waiting = true;
        break;
      }
      const app = this.access.get(`app:${cardId}:${address}`);
      // A Compose route goes with its DNS record first (K-410); the custom domain makes its own record.
      const [record] = this.sql("SELECT 1 FROM dns_objects WHERE address = ? AND record_id != ''", address);
      if (!app?.cfId || app.error || record) {
        waiting = true;
        continue;
      }
      const domains = await api<Array<{ service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      calls++;
      // Another Worker still holds it: the deploy that dropped it takes it off. Anything else stays as it is.
      if (domains.length > 0 || calls >= budget) {
        waiting ||= calls >= budget;
        continue;
      }
      const zone = zoneOfAddressIn(address, this.env);
      if (!zone) continue;
      await api("PUT", `${account}/workers/domains`, {
        hostname: address,
        service: REDIRECT_SCRIPT,
        zone_id: zone.id,
        environment: "production",
      });
      this.sql("UPDATE old_addresses SET attached = 1 WHERE address = ?", address);
      calls++;
    }
    // A removed redirect address whose custom domain is not on the redirect Worker has nothing left to take off.
    this.sql("DELETE FROM old_addresses WHERE going = 1 AND attached = 0");
    this.setMeta("redirects_done", waiting ? "" : text);
    // A wait (an Access application, a DNS record, the budget) tries again later, so the alarm does not loop on it.
    this.setMeta("redirects_retry_at", waiting ? String(Date.now() + RETRY_MS) : "0");
    this.setMeta("redirects_wait", waiting ? text : "");
    return calls;
  }

  /** K-1124: the map of the redirect Worker, old address to main address, as JSON. */
  private redirectMap() {
    return JSON.stringify(
      Object.fromEntries(
        this.oldAddresses().map((item) => [
          item.address,
          this.state.resources.get(item.cardId)?.addresses[0] ?? "",
        ]),
      ),
    );
  }

  /** K-1124: the redirect Worker has a map or a custom domain to change. */
  private redirectWork() {
    const text = this.redirectMap();
    if (this.meta("redirects_done") === text) return false;
    // A new map runs at once; the map that waits runs again at its retry time.
    return this.meta("redirects_wait") !== text || Number(this.meta("redirects_retry_at") ?? 0) <= Date.now();
  }

  /** K-401, K-909: the Access objects, with the addresses that removed apps still serve. */
  private desired(now: number) {
    const removed = [...this.liveSites.values()].filter(
      (site) => site.state === "ok" && !this.state.resources.has(site.id),
    );
    // K-410, K-1124: an old address of a removed card keeps an Owner-only application while the redirect Worker still
    // serves it; the redirect step takes the custom domain off first.
    const attached = this.sql<{ address: string; card_id: string; going: number }>(
      "SELECT address, card_id, going FROM old_addresses WHERE attached = 1",
    );
    const leaving = attached
      .filter((row) => !this.state.resources.has(row.card_id))
      .map((row) => ({ id: row.card_id, name: row.address, address: row.address }));
    // K-1128: a redirect address that is being removed keeps its card's policies until its custom domain went.
    const going = attached
      .filter((row) => row.going === 1 && this.state.resources.has(row.card_id))
      .map((row) => ({ cardId: row.card_id, address: row.address }));
    return desiredAccess(
      this.state,
      now,
      [...removed, ...leaving],
      [...this.oldAddresses(), ...going],
      loginPages(this.env),
      // K-1132: only once the bootstrap made the help application, so the redirect lands on a page.
      this.env.KITSHN_HELP_PAGES === "1"
        ? { host: this.env.KITSHN_HOST, askLive: Boolean(this.access.get(ASK_APP)?.aud) }
        : null,
    );
  }

  /** The rules that every write keeps (K-105, K-1504). Returns the state after the changes. */
  private checked(changes: ReadonlyArray<Change>, base: State = this.state): State {
    const after = applyChanges(base, changes);
    const violation = ruleViolation(after);
    if (violation) throw new RuleError(violation);
    refuseRaiseWhilePaused(base, after);
    refuseLockout(base, after);
    return after;
  }

  /**
   * One write: checks the rules (K-105), stores the changes and one revision (K-1501), then tells everyone.
   * Moves that follow a move or drop of the same actor join its revision (K-1505). A `named` revision, such as
   * Organize (K-532) or the end of a timed card (K-212), has that summary and never joins another.
   */
  private commit(
    actor: Actor,
    changes: ReadonlyArray<Change>,
    undo: UndoOf | null,
    named: string | null = null,
  ): number | null {
    if (changes.length === 0) return null;
    const before = this.state;
    const after = this.checked(changes);
    const now = Date.now();
    const merge = undo === null && named === null ? this.movesToMerge(actor, now, changes) : null;
    const label =
      undo === null
        ? ""
        : undo.item === null
          ? `Undo #${undo.revision}: `
          : `Undo #${undo.revision} for ${undo.item}: `;
    const summary = merge
      ? mergedSummary(
          merge.summary,
          applyChanges(before, invert(merge.previous)),
          before,
          after,
          merge.changes,
        )
      : (named ?? label + summarize(before, after, changes));
    // A per-item undo is a change of its own (K-1507); only a whole undo marks its revision as undone.
    const undoes = undo?.item === null ? undo.revision : null;
    const id = this.ctx.storage.transactionSync(() => {
      this.persist(changes);
      // K-212: the actor of the revision that sets an end time, also by an Undo, is its setter; the end then runs
      // as that actor, so the actor can undo it (K-1506).
      for (const change of changes)
        if (change._tag === "cardEnd" && change.after !== null)
          this.sql("UPDATE card_ends SET set_by = ? WHERE id = ?", JSON.stringify(actor), change.id);
      // A switch to a lockdown keeps who paused first and when.
      if (changes.some((change) => change._tag === "pause" && change.after && !change.before)) {
        this.setMeta("paused_by", JSON.stringify(actor));
        this.setMeta("paused_at", String(Date.now()));
        // K-1504: jobs that devices and agent keys queued do not run after Resume.
        this.sql(
          `UPDATE jobs SET state = 'failed', output = 'The emergency pause ended this job.'
           WHERE state = 'queued' AND json_extract(visitor, '$.email') IS NULL AND json_extract(visitor, '$.clientId') IS NOT NULL`,
        );
        // K-1716: the pause denies every open ask.
        this.denyOpenProposals(null, "the emergency pause");
      }
      if (merge) {
        this.sql(
          "UPDATE revisions SET at = ?, summary = ?, changes = ? WHERE id = ?",
          now,
          summary,
          JSON.stringify(merge.changes),
          merge.id,
        );
        return merge.id;
      }
      return this.insertRevision(
        actor,
        summary,
        changes,
        undoes,
        undo?.item ? undo.revision : null,
        undo?.item === null ? undo.source : null,
      );
    });
    this.state = after;
    // K-627: Resume or the setting can let the next automatic update go.
    // K-626: a machine whose setting goes off neither holds nor stops the rollout.
    for (const change of changes)
      if (change._tag === "autoUpdate" && !change.after)
        this.saveRollout(withoutMachine(this.rollout(), change.id));
    if (changes.some((change) => change._tag === "pause" || change._tag === "autoUpdate")) this.autoUpdate();
    this.clearAccessFailures();
    this.closeLostDoors(now);
    this.syncOpenGames(now);
    for (const change of changes) {
      if (change._tag === "shareSetting" || change._tag === "cardEnd" || change._tag === "place")
        this.stuckShares.delete(change.id);
      if (change._tag === "place")
        for (const id of this.stuckShares) if (id.startsWith(`${change.id}/`)) this.stuckShares.delete(id);
    }
    if (merge) {
      const targets = revisionTargets(merge.changes.map(targetOf));
      this.revisionCache &&= this.revisionCache.map((revision) =>
        revision.id === id ? { ...revision, at: now, summary, ...targets } : revision,
      );
      this.broadcast();
    } else
      this.showRevision({
        id,
        at: now,
        actor,
        summary,
        undoes,
        undoSource: undo?.item === null ? undo.source : null,
        undoneBy: null,
        undoable: true,
        ...revisionTargets(changes.map(targetOf)),
      });
    void this.scheduleAlarm();
    return id;
  }

  /** K-1505: the newest revision with these moves merged in, when they join it. */
  private movesToMerge(actor: Actor, now: number, changes: ReadonlyArray<Change>) {
    const [row] = this.sql<{
      id: number;
      at: number;
      actor: string;
      summary: string;
      changes: string;
      undoes: number | null;
      item_undo: number | null;
    }>("SELECT id, at, actor, summary, changes, undoes, item_undo FROM revisions ORDER BY id DESC LIMIT 1");
    // A per-item undo keeps `undoes` null (K-1507), and moves never join an undo or an Organize (K-532).
    if (!row || row.item_undo !== null || row.summary.startsWith(`${ORGANIZE_SUMMARY}:`)) return null;
    const previous = JSON.parse(row.changes) as Array<Change>;
    const merged = mergeMoves(
      { actor: JSON.parse(row.actor) as Actor, at: row.at, changes: previous, undoes: row.undoes },
      actor,
      now,
      changes,
    );
    return merged && { id: row.id, summary: row.summary, previous, changes: merged };
  }

  private apply(actor: Actor, edits: ReadonlyArray<Edit>) {
    return this.commit(actor, refuseResume(resolveEdits(this.state, edits)), null);
  }

  /**
   * K-532: Organize, as one revision. It moves only the cards that `movable` names; a refusal throws and saves
   * nothing. `organize` checks already that no share changes.
   */
  private organize(actor: Actor, sizes: DrawnSizes, movable: (id: string) => boolean) {
    this.drawn = sizes;
    const plan = organize(this.state, sizes, movable);
    if ("refused" in plan) throw new RuleError(plan.refused);
    if (plan.edits.length === 0) return { revision: null, summary: "Every card is in order already" };
    const summary = organizeSummary(plan.moved);
    return { revision: this.commit(actor, resolveEdits(this.state, plan.edits), null, summary), summary };
  }

  /** K-1504: "Resume", after the Worker checked a passkey login of at most ten minutes. */
  private resume(caller: Caller) {
    // K-1504: only the owner emails of the bootstrap resume, also when an approver policy let another person pass Access.
    const owners = this.env.OWNER_EMAILS.split(",").map((email) => email.trim().toLowerCase());
    if (caller.actor._tag !== "person" || !owners.includes(caller.actor.email.toLowerCase()))
      return Response.json(
        { error: "Only an owner email of the bootstrap resumes (K-1504)." },
        { status: 403 },
      );
    if (!this.authorized(caller))
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    if (!this.state.paused) return Response.json({ revision: null });
    try {
      return Response.json({
        revision: this.commit(caller.actor, resolveEdits(this.state, [{ _tag: "pause", after: null }]), null),
      });
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  }

  /**
   * K-407: a change on the map clears every failed Access write, so the next alarm writes the wanted bodies at once,
   * also a body that failed before, such as a move back to earlier circles. Changes come at human speed.
   */
  private clearAccessFailures() {
    const store = this.accessStore();
    for (const { retryAt: _, attempts: __, ...row } of this.access.values())
      if (row.error !== null) store.put({ ...row, tried: "", error: null });
    // K-406, K-409: a waiting Access step runs in the next alarm; its tries and episode stay.
    for (const step of ["Access", "launcher", "launcher after Access"] as const) {
      const failure = this.alarmSteps().get(step);
      if (failure && failure.retryAt !== 0) this.setAlarmStep(step, { ...failure, retryAt: 0 });
    }
  }

  /** K-1502, K-1506: Undo reverses the caller's own newest revision, and runs the same rules as an edit. */
  private undo(actor: Actor, revisionId: number, source: UndoSource | null) {
    const target = undoTarget(this.state, this.storedRevisions(), actor, { revision: revisionId });
    return this.commitUndo(actor, target.changes, { revision: target.revision, item: null, source });
  }

  /** K-1507: undoes the caller's own newest change to one card or circle, and only that item's part of it. */
  private undoItem(actor: Actor, item: Item) {
    const target = undoTarget(this.state, this.storedRevisions(), actor, { item });
    const name =
      item.kind === "card"
        ? (this.state.resources.get(item.id)?.name ?? item.id)
        : `the circle ${this.state.circles.get(item.id)?.name ?? item.id}`;
    return this.commitUndo(actor, target.changes, { revision: target.revision, item: name, source: null });
  }

  /** Every revision that History keeps (K-1503: at most 5,000). */
  private storedRevisions(): Array<StoredRevision> {
    return this.sql<{ id: number; actor: string; summary: string; changes: string; undoes: number | null }>(
      "SELECT id, actor, summary, changes, undoes FROM revisions",
    ).map((row) => ({
      id: row.id,
      actor: JSON.parse(row.actor) as Actor,
      summary: row.summary,
      changes: JSON.parse(row.changes) as Array<Change>,
      undoes: row.undoes,
    }));
  }

  private commitUndo(actor: Actor, original: ReadonlyArray<Change>, undo: UndoOf) {
    return this.commitApps(actor, prepareUndo(this.state, original, Date.now()), undo);
  }

  /** K-909: the Worker storage whose card is gone: a script that "Remove app" kept, and KV namespaces. */
  private orphanWorkers(): Array<OrphanWorker> {
    const byCard = new Map<string, { script: string | null; kv: Array<string> }>();
    for (const row of this.sql<{ card_id: string; kind: string; name: string; cf_id: string }>(
      "SELECT card_id, kind, name, cf_id FROM worker_storage ORDER BY card_id, name",
    )) {
      if (this.state.resources.has(row.card_id)) continue;
      const entry = byCard.get(row.card_id) ?? { script: null, kv: [] };
      if (row.kind === "script") entry.script = row.cf_id;
      else entry.kv.push(row.name);
      byCard.set(row.card_id, entry);
    }
    return [...byCard].map(([card, entry]) => ({ card, ...entry }));
  }

  /** K-909: a deploy of this card that has not ended yet. */
  private deployRuns(card: string) {
    return (
      this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND state IN ('planned', 'running') AND expires_at > ? LIMIT 1",
        card,
        Date.now(),
      ).length > 0
    );
  }

  /**
   * K-909: deletes the orphaned Worker storage of a removed card: its kept script, and with it its Durable Objects,
   * and its KV namespaces. It refuses while a deploy of the card runs, and a deploy or an Undo of the card waits for
   * it (`deletingStorage`). Before each Cloudflare call it checks again that the card is gone and no deploy runs, and
   * stops otherwise. History records what went, also when a call failed; Undo cannot bring the data back.
   */
  private async deleteOrphanWorker(caller: Caller, card: string) {
    const orphan = this.orphanWorkers().find((item) => item.card === card);
    if (!orphan)
      return Response.json(
        { error: `${card} has no orphaned Worker storage; its card may be back on the map (K-909).` },
        { status: 409 },
      );
    if (this.deployRuns(card) || this.deletingStorage.has(card))
      return Response.json(
        {
          error: `A deploy of ${card}, or a delete of its storage, runs now. Try again after it ends (K-909).`,
        },
        { status: 409 },
      );
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const gone = (error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error);
    const steps: Array<{ readonly what: string; readonly run: () => Promise<void> }> = [
      ...(orphan.script
        ? [
            {
              what: `the Worker ${orphan.script} with its Durable Objects`,
              run: async () => {
                await api("DELETE", `${account}/workers/scripts/${orphan.script}?force=true`).catch(gone);
                this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", card);
                // K-1123: with its script gone, a folder site frees its slot and its folder name.
                this.sql("DELETE FROM agent_sites WHERE card_id = ?", card);
                // K-1124: the card cannot come back now, so its old addresses go free.
                this.sql("DELETE FROM old_addresses WHERE card_id = ?", card);
              },
            },
          ]
        : []),
      ...this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        card,
      ).map(({ name, cf_id }) => ({
        what: `the KV ${name}`,
        run: async () => {
          await api("DELETE", `${account}/storage/kv/namespaces/${cf_id}`).catch(gone);
          this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'kv' AND name = ?", card, name);
        },
      })),
    ];
    const deleted: Array<string> = [];
    let problem: string | null = null;
    this.deletingStorage.add(card);
    try {
      for (const step of steps) {
        if (this.state.resources.has(card) || this.deployRuns(card)) {
          problem = "stopped, because the card came back or a deploy of it started";
          break;
        }
        try {
          await step.run();
          deleted.push(step.what);
        } catch (error) {
          problem = `${step.what} failed: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
    } finally {
      this.deletingStorage.delete(card);
    }
    const done = deleted.length > 0 ? deleted.join(", ") : "nothing";
    this.insertRevision(
      caller.actor,
      `Deleted ${done} of the removed app ${card}${problem ? `; ${problem}` : ""}`,
      [],
      null,
    );
    this.broadcast();
    if (problem) return Response.json({ error: `Deleted ${done}; ${problem}.`, deleted }, { status: 502 });
    return Response.json({ deleted });
  }

  /**
   * K-821: the finished deploys of a card, newest first, and whether a rollback can go back to each. The newest one
   * serves now. Static and Worker deploys need their Cloudflare version; a Compose deploy needs the kept build before
   * the last one on its machine, so only the deploy before the current one counts; a preview has no rollback.
   */
  private rollbackChoices(card: string): Array<RollbackChoice> {
    const rows = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 6",
      card,
    );
    const current = rows[0];
    return rows.map((row, index) => {
      const why =
        index === 0
          ? "This deploy serves now."
          : isPreview(row.environment)
            ? "A preview has no rollback."
            : row.app === "compose"
              ? index !== 1
                ? "The machine keeps only the build before the last one."
                : row.images === null
                  ? "The machine kept no images of this deploy."
                  : null
              : row.version_id === null
                ? "kitshn has no Cloudflare version of this deploy."
                : row.version_id === current?.version_id
                  ? "This version serves now."
                  : null;
      return {
        deployId: row.id,
        sha: row.sha,
        at: row.expires_at - DEPLOY_MS,
        run: row.run_id === null ? null : `${row.run_id}.${row.run_attempt ?? "1"}`,
        note: row.reason,
        why,
      };
    });
  }

  private rollbackChoicesResponse(card: string) {
    if (!this.deployedCards(card).includes(card))
      return Response.json({ error: `A deploy did not make the card "${card}" (K-821).` }, { status: 409 });
    return Response.json({ choices: this.rollbackChoices(card) });
  }

  /**
   * K-1810: the times of each key's searches in the last minute. In memory only: a wake starts it empty, which lets
   * a key search a little more after a wake; revisit if keys loop across wakes.
   */
  private readonly logSearchTimes = new Map<string, Array<number>>();

  /** K-1810: 0 when the key may search now, else the seconds until it may. */
  private logRateWait(key: string, now: number): number {
    const recent = (this.logSearchTimes.get(key) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= 30) {
      this.logSearchTimes.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000));
    }
    recent.push(now);
    this.logSearchTimes.set(key, recent);
    return 0;
  }

  /** K-1804: searches that wait on a daemon, by id. In memory: the request keeps the object awake. */
  private readonly logSearches = new Map<string, (answer: LogAnswer) => void>();

  /** K-1801: the app logs or the deploy runs of a Compose or Worker card. */
  private async logsResponse(card: string, body: unknown) {
    let query: typeof LogQuery.Type;
    try {
      query = decodeLogQuery(body);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 400 });
    }
    const resource = this.state.resources.get(card);
    if (resource?.kind !== "site.compose" && resource?.kind !== "site.worker")
      return Response.json({ error: `The card "${card}" has no logs (K-1802).` }, { status: 409 });
    const search: LogSearch = { text: query.text, from: query.from, to: query.to };
    if (query.tab === "deploys") return Response.json({ runs: deployRuns(this.runSources(card), search) });
    const answer =
      resource.kind === "site.compose"
        ? await this.searchCompose(resource, search)
        : await this.searchWorkerCard(card, search);
    return Response.json({ answer });
  }

  /** K-1804 */
  private searchCompose(resource: Resource, search: LogSearch): Promise<LogAnswer> {
    const daemon = this.logDaemon(resource);
    if ("error" in daemon) return Promise.resolve({ state: "error", error: daemon.error });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.logSearches.delete(id);
        resolve({
          state: "error",
          error: `The daemon of ${daemon.name} did not answer in 20 seconds (K-1804).`,
        });
      }, LOG_ANSWER_MS);
      this.logSearches.set(id, (answer) => {
        clearTimeout(timer);
        this.logSearches.delete(id);
        resolve(answer);
      });
      send(daemon.socket, { type: "logs", id, project: resource.id, search } satisfies ServerToDaemon);
    });
  }

  /** K-1804, K-1805: the connection of the card's machine, when it is online and its daemon reads logs. */
  private logDaemon(resource: Resource): { socket: WebSocket; name: string } | { error: string } {
    const machine = resource.machine ? this.state.machines.get(resource.machine) : undefined;
    if (!machine) return { error: "The card has no machine, so it has no logs to read." };
    const socket = this.checkedSockets(machine.id).at(-1);
    const attachment = socket ? attachmentOf(socket) : null;
    if (!socket || attachment?.kind !== "machine")
      return { error: `${machine.name} is offline, so kitshn cannot read the logs of its apps.` };
    if (attachment.check === "token")
      return { error: `${machine.name} has no machine key yet, so it only reports (K-1708).` };
    if (!attachment.status?.capabilities?.includes("logs"))
      return {
        error: missingFeature(
          attachment.status,
          machine.name,
          "app logs",
          `Update the daemon of ${machine.name} to read logs (K-1804).`,
        ),
      };
    return { socket, name: machine.name };
  }

  /** K-1806: the script of the newest Worker deploy of the card. */
  private workerScript(card: string): string | null {
    const [row] = this.sql<{ script: string }>(
      "SELECT script FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND app = 'worker' AND script != '' ORDER BY expires_at DESC LIMIT 1",
      card,
    );
    return row?.script ?? null;
  }

  /** K-1806 */
  private async searchWorkerCard(card: string, search: LogSearch): Promise<LogAnswer> {
    const api = this.api();
    if (!api)
      return { state: "error", error: "This kitshn has no Cloudflare token, so it reads no Worker logs." };
    const script = this.workerScript(card);
    if (!script)
      return { state: "error", error: "A deploy did not make this Worker yet, so it has no logs." };
    try {
      return await searchWorker(api, this.env.CLOUDFLARE_ACCOUNT_ID, script, search);
    } catch (error) {
      return { state: "error", error: String(error instanceof Error ? error.message : error) };
    }
  }

  /** K-1808: the newest 20 deploys of a card, with the job output of each Compose deploy. */
  private runSources(card: string): Array<RunSource> {
    return this.sql<DeployRow & { job_output: string | null }>(
      `SELECT deploys.*, jobs.output AS job_output FROM deploys LEFT JOIN jobs ON jobs.id = deploys.job_id
       WHERE deploys.resource_id = ? AND deploys.kind = 'deploy' ORDER BY deploys.expires_at DESC LIMIT 20`,
      card,
    ).map((row) => ({
      id: row.id,
      at: row.expires_at - DEPLOY_MS,
      repo: row.repo,
      sha: row.sha,
      state: row.state,
      reason: row.reason,
      runId: row.run_id,
      runAttempt: row.run_attempt,
      output: row.app === "compose" ? (row.job_output ?? "") : null,
    }));
  }

  /** K-1805, K-1807: "Live" in the logs view of one map. */
  private async tailMessage(socket: WebSocket, message: TailMessage) {
    const attachment = attachmentOf(socket);
    if (attachment?.kind !== "map") return;
    if (message.type === "tailStop") {
      const tail = attachment.tails?.find((item) => item.id === message.tail);
      if (!tail) return;
      this.setTails(socket, (tails) => tails.filter((item) => item !== tail));
      await this.stopTail(tail);
      return;
    }
    let started: { answer: TailAnswer; tail: MapTail | null };
    try {
      started = await this.startTail(message.card);
    } catch (error) {
      started = {
        answer: { kind: "error", error: String(error instanceof Error ? error.message : error) },
        tail: null,
      };
    }
    const tail = started.tail;
    if (tail) this.setTails(socket, (tails) => [...tails, tail]);
    send(socket, { type: "tail", requestId: message.requestId, answer: started.answer });
  }

  private async startTail(card: string): Promise<{ answer: TailAnswer; tail: MapTail | null }> {
    const refuse = (error: string) => ({ answer: { kind: "error", error } as const, tail: null });
    const resource = this.state.resources.get(card);
    if (resource?.kind === "site.compose") {
      const daemon = this.logDaemon(resource);
      if ("error" in daemon) return refuse(daemon.error);
      const id = crypto.randomUUID();
      send(daemon.socket, { type: "tail", id, project: resource.id } satisfies ServerToDaemon);
      this.keepAwakeForTails();
      return {
        answer: { kind: "compose", tail: id },
        tail: { kind: "compose", id, machineId: resource.machine ?? "" },
      };
    }
    if (resource?.kind === "site.worker") {
      const api = this.api();
      if (!api) return refuse("This kitshn has no Cloudflare token, so it reads no Worker logs.");
      const script = this.workerScript(card);
      if (!script) return refuse("A deploy did not make this Worker yet, so it has no logs.");
      const { id, url } = await startWorkerTail(api, this.env.CLOUDFLARE_ACCOUNT_ID, script);
      return { answer: { kind: "worker", tail: id, url }, tail: { kind: "worker", id, script } };
    }
    return refuse(`The card "${card}" has no logs (K-1802).`);
  }

  private async stopTail(tail: MapTail) {
    if (tail.kind === "compose") {
      for (const socket of this.checkedSockets(tail.machineId))
        send(socket, { type: "tailStop", id: tail.id } satisfies ServerToDaemon);
      return;
    }
    const api = this.api();
    if (!api) return;
    // K-1807: a tail that kitshn could not delete ends by itself when it expires, after a few hours.
    await stopWorkerTail(api, this.env.CLOUDFLARE_ACCOUNT_ID, tail.script, tail.id).catch((error: unknown) =>
      console.error(`kitshn could not delete the tail ${tail.id}: ${String(error)}`),
    );
  }

  private setTails(socket: WebSocket, change: (tails: ReadonlyArray<MapTail>) => ReadonlyArray<MapTail>) {
    const attachment = attachmentOf(socket);
    if (attachment?.kind !== "map") return;
    socket.serializeAttachment({ ...attachment, tails: change(attachment.tails ?? []) } satisfies Attachment);
  }

  /**
   * K-1805: a quiet tail would wake the object for each batch, and each wake reads the small tables again. A timer
   * keeps the object in memory while any map holds a Compose tail, and stops itself after the last one.
   */
  private tailTimer: ReturnType<typeof setInterval> | null = null;

  private keepAwakeForTails() {
    if (this.tailTimer !== null) return;
    this.tailTimer = setInterval(() => {
      const open = this.ctx.getWebSockets("map").some((socket) => {
        const attachment = attachmentOf(socket);
        return attachment?.kind === "map" && (attachment.tails ?? []).some((tail) => tail.kind === "compose");
      });
      if (open || this.tailTimer === null) return;
      clearInterval(this.tailTimer);
      this.tailTimer = null;
    }, 30_000);
  }

  /** K-1805: the map that holds a Compose tail of this machine. */
  private tailOwner(id: string, machineId: string): WebSocket | null {
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = attachmentOf(socket);
      if (
        attachment?.kind === "map" &&
        attachment.tails?.some(
          (tail) => tail.kind === "compose" && tail.id === id && tail.machineId === machineId,
        )
      )
        return socket;
    }
    return null;
  }

  /** K-1805: tells each map that its matching tails ended, and forgets them. */
  private endTails(ends: (tail: MapTail) => boolean, reason: string) {
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = attachmentOf(socket);
      const ended = attachment?.kind === "map" ? (attachment.tails ?? []).filter(ends) : [];
      if (ended.length === 0) continue;
      this.setTails(socket, (tails) => tails.filter((tail) => !ended.includes(tail)));
      for (const tail of ended) send(socket, { type: "tailEnd", tail: tail.id, reason });
    }
  }

  /** K-1819: the newest backup run of each card, read once per wake and then kept current. */
  private backupMemory: Map<string, BackupRun> | null = null;

  private latestBackups(): Map<string, BackupRun> {
    if (this.backupMemory) return this.backupMemory;
    const memory = new Map<string, BackupRun>();
    for (const row of this.sql<BackupRow>(
      "SELECT * FROM backups WHERE (card, at) IN (SELECT card, MAX(at) FROM backups GROUP BY card)",
    ))
      memory.set(row.card, backupRun(row));
    this.backupMemory = memory;
    return memory;
  }

  private bucket(): BucketSize | null {
    const stored = this.meta("r2_bucket");
    return stored === null ? null : (JSON.parse(stored) as BucketSize);
  }

  /** K-1814: restic of a machine reaches a card's repository only while that machine runs a job of the card. */
  private backupAccess(body: { card: string; clientId: string }) {
    const machine = [...this.state.machines.values()].find((item) => item.clientId === body.clientId);
    const resource = this.state.resources.get(body.card);
    const refuse = (error: string) => Response.json({ error }, { status: 403 });
    if (!machine) return refuse("This service token is no machine of kitshn.");
    if (resource?.kind !== "site.compose" || resource.machine !== machine.id)
      return refuse(`${body.card} is no Compose card of ${machine.name} (K-1814).`);
    // A dropped socket marks the job failed for now; the job keeps its access until it expires (K-1814).
    const running = this.sql<{ command: string }>(
      `SELECT command FROM jobs WHERE machine_id = ? AND expires_at > ?
       AND (state = 'sent' OR (state = 'failed' AND output = '${OFFLINE_OUTPUT}'))`,
      machine.id,
      Date.now(),
    ).some((row) => {
      const command = JSON.parse(row.command) as Command;
      return (command.kind === "backup" || command.kind === "backup-restore") && command.card === body.card;
    });
    return running
      ? Response.json({ ok: true })
      : refuse(`${machine.name} runs no backup of ${body.card} now (K-1814).`);
  }

  /** K-1817, K-1819, K-1820: why a card cannot back up now, or null. */
  private backupRefusal(card: string): string | null {
    const common = this.restoreRefusal(card);
    if (common) return common;
    const size = this.bucket();
    if (size && size.bytes >= BACKUP_LIMIT_BYTES)
      return `Backups wait: the R2 bucket holds ${gigabytes(size.bytes)} of the ${gigabytes(R2_FREE_BYTES)} of the free plan (K-1818).`;
    return null;
  }

  /** K-1818, K-1820: a restore passes the size guard, because it is the step that the owner needs most. */
  private restoreRefusal(card: string): string | null {
    const resource = this.state.resources.get(card);
    if (resource?.kind !== "site.compose") return `The card "${card}" is no Compose app (K-1811).`;
    if (!resource.machine) return `${resource.name} runs on no machine.`;
    if (!this.env.BUCKET) return "R2 is off on this account.";
    if (!this.env.KITSHN_BACKUP_KEY)
      return "Backups are off: kitshn has no KITSHN_BACKUP_KEY. Run the bootstrap with KITSHN_BACKUP_KEY_NOW=1 (K-1815).";
    // K-1817: an online daemon says whether it can back up; an offline one gets the job when it connects.
    const socket = this.checkedSockets(resource.machine).at(-1);
    const attachment = socket ? attachmentOf(socket) : null;
    if (
      attachment?.kind === "machine" &&
      attachment.status &&
      !attachment.status.capabilities?.includes("backup-restore")
    )
      return missingFeature(
        attachment.status,
        this.state.machines.get(resource.machine)?.name ?? resource.machine,
        "backups",
        `Update the daemon of ${this.state.machines.get(resource.machine)?.name ?? resource.machine} to back up (K-1817).`,
      );
    return null;
  }

  /** K-1816: the hard limit of the next paused pass of a card, from the pause of its last run. */
  private pauseLimitOf(card: string) {
    const [row] = this.sql<{ pause_ms: number }>(
      "SELECT pause_ms FROM backups WHERE card = ? AND state = 'done' AND pause_ms IS NOT NULL ORDER BY at DESC LIMIT 1",
      card,
    );
    return pauseLimit(row?.pause_ms ?? null);
  }

  /** K-1817: when the nightly backups run next, read once per wake. */
  private backupAtMemory: number | null = null;

  private backupAt() {
    if (this.backupAtMemory === null) {
      const stored = this.meta("backup_at");
      this.backupAtMemory = stored === null ? nextBackupAt(Date.now()) : Number(stored);
      if (stored === null) this.setMeta("backup_at", String(this.backupAtMemory));
    }
    return this.backupAtMemory;
  }

  /** K-1833: imports the file of the bootstrap once per new `KITSHN_IMPORT_AT`, and keeps the outcome in meta. */
  private async importIfDue(at = this.env.KITSHN_IMPORT_AT) {
    // A done import finishes also after the bootstrap dropped KITSHN_IMPORT_AT.
    if (this.meta("import_finish") === "due") await this.finishImport();
    if (!at || this.meta("import_at") === at) return;
    const refused = await this.runImport(at).catch((error: unknown): ImportRefusal => ({
      code: "failed",
      detail: String(error),
    }));
    if (refused) {
      // The details can name an account, a card or a table, so only the log has them (K-1833).
      console.error(`kitshn refused the import (${refused.code}): ${refused.detail}`);
      this.setMeta("import_at", at);
      this.setMeta(
        "import_status",
        JSON.stringify({ state: "refused", code: refused.code } satisfies ImportStatus),
      );
      // The file holds the whole state, so it does not stay in R2 after a refusal either.
      await this.env.BUCKET?.delete(IMPORT_OBJECT).catch((error: unknown) =>
        console.error(`kitshn could not delete the refused import file: ${String(error)}`),
      );
      return;
    }
    await this.finishImport();
  }

  /**
   * K-1833: imports the file of the bootstrap. The rows, History and the "done" status go in one transaction, so a
   * later error or a restart never turns a done import into a refused one. Returns the refusal, or null.
   */
  private async runImport(at: string): Promise<ImportRefusal | null> {
    const bucket = this.env.BUCKET;
    if (!bucket) return { code: "no_file", detail: "R2 is off on this account." };
    const file = await bucket.get(IMPORT_OBJECT);
    if (!file) return { code: "no_file", detail: `R2 holds no ${IMPORT_OBJECT}.` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await new Response(file.body.pipeThrough(new DecompressionStream("gzip"))).text());
    } catch (error) {
      return { code: "bad_file", detail: `The import file is no gzip JSON: ${String(error)}` };
    }
    const state = readExport(parsed, this.env.CLOUDFLARE_ACCOUNT_ID);
    if ("code" in state) return state;
    const notEmpty = notEmptyReason(this.ctx.storage.sql, [ADMIN_RESOURCE_ID]);
    if (notEmpty) return notEmpty;
    try {
      this.ctx.storage.transactionSync(() => {
        writeImport(this.ctx.storage.sql, state, (from) => {
          if (from < REPO_GATE_MIGRATION) this.backfillRepoIds();
          // An export from before migration 42 still holds `t3.agents` shares, so its step runs again.
          if (from < AGENTS_MIGRATION) this.sql("DELETE FROM meta WHERE key = ?", AGENTS_MIGRATED);
          this.migrateAgents();
          this.insertRevision(
            IMPORT_ACTOR,
            `Imported the state of ${new Date(state.exportedAt).toISOString()} (K-1833)`,
            [],
            null,
          );
          this.setMeta("import_at", at);
          this.setMeta("import_status", JSON.stringify({ state: "done" } satisfies ImportStatus));
          this.setMeta("import_finish", "due");
        });
      });
    } catch (error) {
      // A table or a column that the schema of the export lacks rolls the whole transaction back.
      this.load();
      return error instanceof ImportError
        ? { code: error.code, detail: error.message }
        : { code: "failed", detail: String(error) };
    }
    this.load();
    return null;
  }

  /**
   * K-1833, K-1834: the steps after a done import: the import file goes, and the pass key rotates, because the
   * export holds none. A failure is logged, and the next start tries again.
   */
  private async finishImport() {
    try {
      await this.env.BUCKET?.delete(IMPORT_OBJECT);
      await this.rotatePassKey(IMPORT_ACTOR);
      this.sql("DELETE FROM meta WHERE key = 'import_finish'");
    } catch (error) {
      console.error(`kitshn finishes the import at the next start: ${String(error)}`);
    }
  }

  /** K-1833: the public import status: the state and a fixed reason code, nothing more. */
  private importStatus(): ImportStatus | { state: "none" | "pending" } {
    if (!this.env.KITSHN_IMPORT_AT) return { state: "none" };
    if (this.meta("import_at") !== this.env.KITSHN_IMPORT_AT) return { state: "pending" };
    return JSON.parse(this.meta("import_status") ?? '{"state":"pending"}') as ImportStatus;
  }

  /** K-1832: the state export of K-1831 for the admin, as a file. */
  private exportResponse() {
    const now = Date.now();
    const state = stateExport(this.ctx.storage.sql, this.env.CLOUDFLARE_ACCOUNT_ID, MIGRATIONS.length, now);
    return new Response(JSON.stringify(state), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="kitshn-state-${new Date(now).toISOString().slice(0, 10)}.json"`,
      },
    });
  }

  /** K-1817: one backup job and its row. Returns the run and the job. */
  private queueBackup(card: string, actor: Actor, prune: boolean, now: number) {
    const resource = this.state.resources.get(card);
    if (!resource?.machine) throw new Error(`${card} has no machine.`);
    const run = crypto.randomUUID();
    const jobId = this.ctx.storage.transactionSync(() => {
      const queued = this.queueKitshnJob(
        resource.machine!,
        { kind: "backup", card, run, prune, pauseLimitMs: this.pauseLimitOf(card) },
        actor,
        now + DAY,
      );
      this.insertBackup(run, card, resource.machine!, now, queued);
      return queued;
    });
    return { run, jobId };
  }

  private insertBackup(run: string, card: string, machineId: string, at: number, jobId: number) {
    this.sql(
      "INSERT INTO backups (run, card, machine_id, at, state, job_id) VALUES (?, ?, ?, ?, 'running', ?)",
      run,
      card,
      machineId,
      at,
      jobId,
    );
    this.latestBackups().set(card, {
      run,
      card,
      machineId,
      at,
      state: "running",
      bytes: null,
      added: null,
      error: null,
      pauseMs: null,
    });
  }

  private backupList(card: string) {
    const runs = this.sql<BackupRow>("SELECT * FROM backups WHERE card = ? ORDER BY at DESC LIMIT 50", card);
    return Response.json({ runs: runs.map(backupRun) });
  }

  /** K-538: the steps of a backup or restore job that someone started; the machine reports only its end. */
  private startBackupAction(card: string, jobId: number, action: string, work: string) {
    const machine =
      this.state.machines.get(this.state.resources.get(card)?.machine ?? "")?.name ?? "the machine";
    this.startAction(card, { _tag: "job", jobId }, action, [
      { label: `Wait until ${machine} takes the job`, expectedMs: 2_000 },
      { label: `${work} on ${machine}`, expectedMs: 30_000 },
    ]);
  }

  /** K-1817: "Back up now". */
  private backUpNow(actor: Actor, card: string) {
    const refusal = this.backupRefusal(card);
    if (refusal) return Response.json({ error: refusal }, { status: 409 });
    const { run, jobId } = this.queueBackup(card, actor, false, Date.now());
    // K-538: only a backup that someone started shows its steps; the daily ones keep the K-1819 sticker.
    this.startBackupAction(card, jobId, BACK_UP_NOW, "Back up the volumes and the data folder");
    this.deliverJobs();
    this.broadcast();
    return Response.json({ run });
  }

  /** K-1820: a backup as the way back, then the run written back. */
  private restoreBackup(actor: Actor, card: string, run: string) {
    const refusal = this.restoreRefusal(card);
    if (refusal) return Response.json({ error: refusal }, { status: 409 });
    const [row] = this.sql<BackupRow>("SELECT * FROM backups WHERE run = ? AND card = ?", run, card);
    if (row?.state !== "done" || row.sources === null)
      return Response.json({ error: "kitshn has no finished backup run like this." }, { status: 404 });
    const sources = JSON.parse(row.sources) as Array<string>;
    const resource = this.state.resources.get(card)!;
    const before = crypto.randomUUID();
    const now = Date.now();
    const jobId = this.ctx.storage.transactionSync(() => {
      const queued = this.queueKitshnJob(
        resource.machine!,
        { kind: "backup-restore", card, run, before, sources, pauseLimitMs: this.pauseLimitOf(card) },
        actor,
        now + DAY,
      );
      this.insertBackup(before, card, resource.machine!, now, queued);
      return queued;
    });
    this.startBackupAction(card, jobId, "Restore", "Back up the app as it is, then write the backup back");
    this.deliverJobs();
    this.broadcast();
    return Response.json({ before });
  }

  /** K-1817, K-1819, K-1820: the end of a backup or restore job. */
  private backupResult(
    command: Extract<Command, { kind: "backup" | "backup-restore" }>,
    actor: Actor,
    result: Record<string, unknown>,
  ) {
    const run = command.kind === "backup" ? command.run : command.before;
    const report = isRecord(result["backup"]) ? result["backup"] : null;
    const bytes = typeof report?.["bytes"] === "number" ? report["bytes"] : null;
    const added = typeof report?.["added"] === "number" ? report["added"] : null;
    const pauseMs = typeof report?.["pauseMs"] === "number" ? report["pauseMs"] : null;
    const sources = Array.isArray(report?.["sources"])
      ? JSON.stringify(report["sources"].filter((item): item is string => typeof item === "string"))
      : null;
    // K-1820: a restore that failed after its first backup still made that backup, the way back.
    const made = report?.["run"] === run;
    const error = result["ok"] === true ? null : String(result["output"] ?? "").slice(-2000);
    this.sql(
      "UPDATE backups SET state = ?, bytes = ?, added = ?, error = ?, sources = ?, pause_ms = ? WHERE run = ?",
      made ? "done" : "failed",
      bytes,
      added,
      made ? null : error,
      sources,
      pauseMs,
      run,
    );
    // K-1817: a run that the retention removed from the repository loses its row too.
    if (Array.isArray(report?.["kept"])) {
      const kept = new Set(report["kept"].filter((item): item is string => typeof item === "string"));
      for (const row of this.sql<{ run: string }>(
        "SELECT run FROM backups WHERE card = ? AND state = 'done'",
        command.card,
      ))
        if (!kept.has(row.run)) this.sql("DELETE FROM backups WHERE run = ?", row.run);
    }
    this.backupMemory = null;
    if (command.kind === "backup-restore") {
      const name = this.state.resources.get(command.card)?.name ?? command.card;
      const [target] = this.sql<{ at: number }>("SELECT at FROM backups WHERE run = ?", command.run);
      const when = target ? new Date(target.at).toISOString() : command.run;
      this.insertRevision(
        actor,
        error === null
          ? `Restored ${name} to its backup of ${when}; the state from before is the backup ${command.before} (K-1820)`
          : `The restore of ${name} to its backup of ${when} failed: ${error.slice(0, 300)} (K-1820)`,
        [],
        null,
      );
      this.load();
    }
  }

  /** K-1817, K-1818, K-1821: the daily backups, after the daily clean-up. */
  private async dailyBackups(now: number) {
    const bucket = this.env.BUCKET;
    if (!bucket) return;
    // A job that expired never reports, so its run fails here.
    this.sql(
      "UPDATE backups SET state = 'failed', error = 'The machine did not run the job in time.' WHERE state = 'running' AND at < ?",
      now - 2 * DAY,
    );
    // K-1819: failed and old rows go; the monthly retention keeps runs about 100 days.
    this.sql(
      "DELETE FROM backups WHERE at < ? OR (state = 'failed' AND at < ?)",
      now - 100 * DAY,
      now - 14 * DAY,
    );
    this.backupMemory = null;
    // Each step on its own: a failed export does not stop the backups of the day.
    const step = async (what: string, work: () => Promise<void>) =>
      work().catch((error: unknown) =>
        console.error(`kitshn daily backups: ${what} failed: ${String(error)}`),
      );
    await step("the state export (K-1821)", async () => {
      await writeExport(
        bucket,
        stateExport(this.ctx.storage.sql, this.env.CLOUDFLARE_ACCOUNT_ID, MIGRATIONS.length, now),
      );
    });
    await step("the bucket size (K-1818)", async () => {
      this.setMeta("r2_bucket", JSON.stringify(await bucketSize(bucket, now)));
    });
    await step("the repositories of removed cards (K-1819)", () => this.dropRemovedRepositories(bucket, now));
    // K-1815: without the key, backups stay off; one line a day says so, not one per card.
    if (!this.env.KITSHN_BACKUP_KEY) {
      console.warn("kitshn daily backups: no KITSHN_BACKUP_KEY, so backups stay off (K-1815).");
      return;
    }
    const { deployedCards, previewCards } = this.deployedAndPreviewCards();
    const previews = new Set(previewCards);
    const actor: Actor = { _tag: "kitshn", reason: "the daily backup (K-1817)" };
    // K-1817: prune once a week, on Sundays (UTC).
    const prune = new Date(now).getUTCDay() === 0;
    for (const card of deployedCards) {
      if (previews.has(card) || this.backupRefusal(card) !== null) continue;
      this.queueBackup(card, actor, prune, now);
    }
    this.deliverJobs();
  }

  /**
   * K-1819: the repository of a card that is gone for good (no card, and no backup row for 7 days, the Undo window of
   * a removal) leaves R2, so it counts no more toward K-1818 and a new card of the same id starts empty.
   */
  private async dropRemovedRepositories(bucket: R2Bucket, now: number) {
    const cards = this.sql<{ card: string }>("SELECT DISTINCT card FROM backups").map((row) => row.card);
    for (const card of cards)
      if (!this.state.resources.has(card))
        this.sql("INSERT OR IGNORE INTO backup_gone (card, since) VALUES (?, ?)", card, now);
    // An Undo that brought the card back keeps its repository.
    for (const { card } of this.sql<{ card: string }>("SELECT card FROM backup_gone"))
      if (this.state.resources.has(card)) this.sql("DELETE FROM backup_gone WHERE card = ?", card);
    const gone = this.sql<{ card: string }>("SELECT card FROM backup_gone WHERE since < ?", now - 7 * DAY);
    for (const { card } of gone) {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `backups/${card}/`, ...(cursor ? { cursor } : {}) });
        if (page.objects.length > 0) await bucket.delete(page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      this.sql("DELETE FROM backups WHERE card = ?", card);
      this.sql("DELETE FROM backup_gone WHERE card = ?", card);
    }
  }

  /** K-1822: the Durable Object storage goes back to a time; a restart completes it. */
  private restoring: { at: number } | null = null;

  private async restoreTime(caller: Caller, body: unknown) {
    if (!this.authorized(caller))
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    const wanted = isRecord(body) ? body : {};
    const at = typeof wanted["at"] === "number" && wanted["at"] < Date.now() ? wanted["at"] : null;
    const bookmark =
      typeof wanted["bookmark"] === "string"
        ? wanted["bookmark"]
        : at !== null
          ? await this.ctx.storage.getBookmarkForTime(at)
          : null;
    if (bookmark === null)
      return Response.json({ error: "Name a time in the past 30 days." }, { status: 400 });
    // The object, not the browser, names the time in History.
    const finish: RestoreFinish = {
      undo: await this.ctx.storage.onNextSessionRestoreBookmark(bookmark),
      label: at !== null ? new Date(at).toISOString() : "the state before the last restore",
      // Job ids go on after the highest one before the restore, so a late daemon result finds no other job.
      jobsAfter:
        this.sql<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'")[0]?.seq ?? 0,
      actor: caller.actor,
    };
    // K-538: the admin card shows the steps; the restore rewinds this row, so the finish brings it back from R2.
    const before = this.progressRows().get(ADMIN_RESOURCE_ID)?.progress ?? null;
    const progress = reachStep(
      startProgress(RESTORE_ACTION, RESTORE_STEPS, Date.now(), before),
      1,
      Date.now(),
    );
    this.setProgress(ADMIN_RESOURCE_ID, { source: { _tag: "restore" }, progress });
    this.broadcast();
    // Storage writes from now on are lost with the restore, so the pending finish waits in R2.
    await this.env.BUCKET?.put(RESTORE_PENDING, JSON.stringify({ ...finish, progress }));
    this.restoring = { at: Date.now() };
    // The answer goes out first; then the restart restores the storage.
    setTimeout(() => this.ctx.abort("K-1822: restore to a time"), 100);
    return Response.json(finish);
  }

  /** K-1822: the Worker's poll after the restart, with the finish that the restore sent it. */
  private async restored(caller: Caller, body: unknown) {
    if (!this.authorized(caller))
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    if (this.restoring)
      return Response.json({ error: "The restore did not restart kitshn yet." }, { status: 409 });
    const finish = restoreFinishOf(body);
    if (!finish) return Response.json({ error: "Send the finish of the restore." }, { status: 400 });
    await this.finishRestore(finish);
    return Response.json({ ok: true });
  }

  /**
   * K-1822: History, the job ids and the pass key after a restore to a time. The Worker's poll runs it, or the next
   * alarm from the copy in R2 when the poll timed out; the copy goes once it ran.
   */
  /** K-1822: the poll and the alarm can both find the pending finish; only the first runs it. */
  private finishing = false;

  private async finishRestore(finish: RestoreFinish) {
    if (this.finishing) return;
    this.finishing = true;
    try {
      await this.finishRestoreOnce(finish);
    } finally {
      this.finishing = false;
    }
  }

  private async finishRestoreOnce(finish: RestoreFinish) {
    const pending = await this.env.BUCKET?.get(RESTORE_PENDING);
    if (this.env.BUCKET && !pending) return;
    // K-538: kitshn wrote this object itself, before the restart.
    const carried = pending ? ((await pending.json()) as { progress?: ActionProgress }).progress : undefined;
    await this.env.BUCKET?.delete(RESTORE_PENDING);
    const move = (change: (progress: ActionProgress) => ActionProgress) =>
      this.moveAction(ADMIN_RESOURCE_ID, change, { _tag: "restore" });
    if (carried)
      this.setProgress(ADMIN_RESOURCE_ID, {
        source: { _tag: "restore" },
        progress: reachStep(carried, 2, Date.now()),
      });
    this.sql("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'jobs'", finish.jobsAfter);
    this.setMeta("restore_undo", finish.undo);
    this.insertRevision(
      finish.actor,
      `Restored kitshn to ${finish.label}; a restore to the bookmark ${finish.undo} undoes it (K-1822)`,
      [],
      null,
    );
    move((progress) => reachStep(progress, 3, Date.now()));
    this.load();
    this.broadcast();
    // K-1771: the restored storage can hold a pass key that was retired after that time, so the last step rotates it.
    try {
      await this.rotatePassKey(finish.actor);
    } catch (error) {
      move((progress) => failProgress(progress, `The pass key did not rotate: ${String(error)}`, Date.now()));
      this.broadcast();
      throw error;
    }
    move((progress) => finishProgress(progress, Date.now()));
    this.broadcast();
  }

  /** K-1822: a restore whose poll timed out finishes at the next alarm. */
  private async finishPendingRestore() {
    if (this.restoring) return;
    const pending = await this.env.BUCKET?.get(RESTORE_PENDING);
    const finish = pending ? restoreFinishOf(await pending.json()) : null;
    if (finish) await this.finishRestore(finish);
  }

  private async rollbackResponse(caller: Caller, card: string, deployId: string) {
    const result = await this.rollbackCard(caller.actor, card, deployId, null);
    if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
    this.broadcast();
    return Response.json(result);
  }

  /**
   * K-821: rolls one card back to an earlier finished deploy. A static or Worker card deploys that Cloudflare version
   * again at once; a Compose card starts its kept build on its machine as a job. The new deploy row repeats the old
   * one, so the card, Undo and the next rollback see it as the current deploy. Data never rolls back; the vars and
   * secrets (or the Compose params) of that deploy come back with it.
   */
  private async rollbackCard(
    actor: Actor,
    card: string,
    deployId: string,
    group: string | null,
  ): Promise<{ readonly note: string; readonly jobId: number | null } | { readonly error: string }> {
    const resource = this.state.resources.get(card);
    if (!resource || !this.deployedCards(card).includes(card))
      return { error: `A deploy did not make the card "${card}" (K-821).` };
    if (this.state.paused)
      return { error: "kitshn is paused, so it rolls nothing back until Resume (K-1504)." };
    const choice = this.rollbackChoices(card).find((item) => item.deployId === deployId);
    if (!choice) return { error: `${deployId} is not one of the last finished deploys of ${resource.name}.` };
    if (choice.why !== null) return { error: choice.why };
    // The newest row counts as the current deploy, so a deploy that ends after the rollback would hide it.
    if (this.deployRuns(card)) return { error: "A deploy of this card runs now. Roll back after it ends." };
    const [target] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    if (!target) return { error: `kitshn knows no deploy ${deployId}.` };
    // The daemon keeps a Compose build by the deploy that built it; a rollback row repeats that build.
    const origin = target.origin ?? target.id;
    const refusal = this.repoRefusal(target.repo_id);
    if (refusal) return { error: refusal };
    const sha = target.sha.slice(0, 7);
    const id = crypto.randomUUID();
    const insert = (state: "done" | "running", jobId: number | null) =>
      this.sql(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state,
           expires_at, branch, app, machine_id, job_id, compose_file, addresses, worker, app_key, reason, version_id,
           run_id, run_attempt, images, needs, origin, workflow)
         SELECT ?, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, ?, ?, branch, app,
           machine_id, ?, compose_file, addresses, worker, app_key, ?, version_id, NULL, NULL, images, needs, ?, workflow
         FROM deploys WHERE id = ?`,
        id,
        state,
        Date.now() + DEPLOY_MS,
        jobId,
        `rollback to ${sha}`,
        origin,
        deployId,
      );
    if (target.app !== "compose") {
      const api = this.api();
      if (!api) return { error: "kitshn has no Cloudflare API token here." };
      try {
        await api(
          "POST",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.script}/deployments`,
          {
            strategy: "percentage",
            versions: [{ version_id: target.version_id, percentage: 100 }],
          },
        );
      } catch (error) {
        return {
          error: `Cloudflare refused the rollback: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      this.ctx.storage.transactionSync(() => {
        insert("done", null);
        this.insertRevision(actor, `Rolled back ${resource.name} to ${sha} (K-821)`, [], null);
      });
      return {
        note: `${resource.name} serves ${sha} again, with the vars and secrets of that deploy; its data did not roll back.`,
        jobId: null,
      };
    }
    const machine = resource.machine ? this.state.machines.get(resource.machine) : undefined;
    if (!machine) return { error: `${resource.name} runs on no known machine.` };
    const offMachine = this.redeployRefusal(machine.id, card);
    if (offMachine) return { error: offMachine };
    if (!this.machineView(machine).status?.capabilities?.includes("compose-rollback"))
      return {
        error: missingFeature(
          this.machineView(machine).status,
          machine.name,
          "rollbacks",
          `Update the daemon on ${machine.name} first: it cannot roll back yet (K-821).`,
        ),
      };
    const jobId = this.ctx.storage.transactionSync(() => {
      const queued = this.queueKitshnJob(
        machine.id,
        {
          kind: "compose-rollback",
          deployId: origin,
          allowed: allowedFor(machine, target.repo),
          project: card,
          name: target.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
          environment: target.environment,
          repo: target.repo,
          file: target.compose_file,
          group,
        },
        actor,
        Date.now() + DEPLOY_MS,
      );
      insert("running", queued);
      this.insertRevision(actor, `Rolled back ${resource.name} to ${sha} (K-821)`, [], null);
      return queued;
    });
    this.deliverJobs();
    return {
      note: `${machine.name} starts the kept build ${sha} of ${resource.name}, with the params of that deploy; its data does not roll back.`,
      jobId,
    };
  }

  /**
   * K-821: the rollback of the run that made the current deploy of a card: each card of that run whose current deploy
   * is still from it, back to its newest finished deploy before the run, an app before the apps that it needs.
   */
  private runRollbackPlan(card: string): Array<RunRollbackStep> | { readonly error: string } {
    const [current] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
      card,
    );
    if (!current?.run_id)
      return { error: "The current deploy of this card came from no workflow run (K-821)." };
    const ofRun = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE repo_id = ? AND run_id = ? AND run_attempt = ? AND kind = 'deploy' AND state = 'done'",
      current.repo_id,
      current.run_id,
      current.run_attempt,
    );
    const steps: Array<RunRollbackStep & { readonly key: string; readonly needs: ReadonlyArray<string> }> =
      [];
    for (const row of ofRun) {
      const resource = this.state.resources.get(row.resource_id);
      const [newest] = this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
        row.resource_id,
      );
      if (!resource || newest?.id !== row.id) continue;
      const [before] = this.sql<DeployRow>(
        `SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' AND expires_at < ?
         AND (run_id IS NULL OR run_id != ? OR run_attempt != ?) ORDER BY expires_at DESC LIMIT 1`,
        row.resource_id,
        row.expires_at,
        current.run_id,
        current.run_attempt,
      );
      const choice = before
        ? this.rollbackChoices(row.resource_id).find((item) => item.deployId === before.id)
        : undefined;
      const why = !before
        ? "The card has no deploy before the run."
        : choice === undefined
          ? "The deploy before the run is older than the last 5."
          : choice.why;
      steps.push({
        card: row.resource_id,
        name: resource.name,
        deployId: before?.id ?? null,
        sha: before?.sha ?? null,
        why,
        key: row.app_key,
        needs: JSON.parse(row.needs ?? "[]") as Array<string>,
      });
    }
    const keys = new Set(steps.map((step) => step.key));
    const order = deployOrder(
      Object.fromEntries(
        steps.map((step) => [step.key, { needs: { apps: step.needs.filter((key) => keys.has(key)) } }]),
      ),
    );
    if ("error" in order) return { error: order.error };
    // An app goes back before the apps that it needs, the reverse of the deploy order.
    return [...order.order]
      .reverse()
      .flatMap((key) => steps.filter((step) => step.key === key))
      .map(({ key: _key, needs: _needs, ...step }) => step);
  }

  private runRollbackPlanResponse(card: string) {
    const plan = this.runRollbackPlan(card);
    if ("error" in plan) return Response.json({ error: plan.error }, { status: 409 });
    return Response.json({ steps: plan });
  }

  /** K-821: starts a run rollback; a Compose step waits for its job, and the job result goes on (continueRollback). */
  private async runRollback(caller: Caller, card: string) {
    const plan = this.runRollbackPlan(card);
    if ("error" in plan) return Response.json({ error: plan.error }, { status: 409 });
    const blocked = plan.find((step) => step.why !== null);
    if (blocked) return Response.json({ error: `${blocked.name}: ${blocked.why}` }, { status: 409 });
    const busy = new Set(
      this.sql<{ steps: string }>("SELECT steps FROM rollbacks WHERE state = 'running'").flatMap((row) =>
        (JSON.parse(row.steps) as Array<RunRollbackStep>).map((step) => step.card),
      ),
    );
    const overlap = plan.find((step) => busy.has(step.card));
    if (overlap)
      return Response.json(
        { error: `A run rollback of ${overlap.name} runs now. Wait until it ends.` },
        { status: 409 },
      );
    const id = crypto.randomUUID();
    this.sql(
      "INSERT INTO rollbacks (id, steps, next, state, actor, notes) VALUES (?, ?, 0, 'running', ?, '[]')",
      id,
      JSON.stringify(plan),
      JSON.stringify(caller.actor),
    );
    // K-538: the card where it started shows one step per card; a Compose card's step waits for its job.
    this.startAction(
      card,
      { _tag: "rollback", id },
      "Roll back this run",
      plan.map((step) => ({
        label: `Roll back ${step.name}`,
        expectedMs: this.state.resources.get(step.card)?.kind === "site.compose" ? 25_000 : 3_000,
      })),
    );
    this.broadcast();
    await this.advanceRollback(id);
    this.broadcast();
    const [row] = this.sql<{ state: string; notes: string }>(
      "SELECT state, notes FROM rollbacks WHERE id = ?",
      id,
    );
    return Response.json({
      id,
      state: row?.state ?? "failed",
      notes: JSON.parse(row?.notes ?? "[]") as Array<string>,
    });
  }

  /** K-821: the run rollbacks that a call of advanceRollback works on now; a restart empties it. */
  private readonly advancing = new Set<string>();

  /** K-821: runs the next steps of a run rollback until one waits for a machine, fails, or the last one is done. */
  private async advanceRollback(id: string) {
    this.advancing.add(id);
    try {
      for (;;) {
        const [row] = this.sql<{ steps: string; next: number; state: string; actor: string; notes: string }>(
          "SELECT steps, next, state, actor, notes FROM rollbacks WHERE id = ?",
          id,
        );
        if (!row || row.state !== "running") return;
        const steps = JSON.parse(row.steps) as Array<RunRollbackStep>;
        const notes = JSON.parse(row.notes) as Array<string>;
        const step = steps[row.next];
        if (!step) {
          this.finishRollback(id, "done", notes);
          return;
        }
        const result = await this.rollbackCard(
          JSON.parse(row.actor) as Actor,
          step.card,
          step.deployId ?? "",
          id,
        );
        if ("error" in result) {
          this.finishRollback(id, "failed", [
            ...notes,
            `${step.name}: ${result.error} The rollback stopped here.`,
          ]);
          return;
        }
        notes.push(result.note);
        this.sql(
          "UPDATE rollbacks SET next = next + ?, notes = ?, job_id = ? WHERE id = ?",
          result.jobId === null ? 1 : 0,
          JSON.stringify(notes),
          result.jobId,
          id,
        );
        // K-538: the sticker of the run moves on with each card.
        this.settleRollbackAction(id);
        this.broadcast();
        if (result.jobId !== null) return;
      }
    } finally {
      this.advancing.delete(id);
    }
  }

  /** K-821: the job of a Compose step of a run rollback ended; the run goes on, or stops at a failed job. */
  private continueRollback(id: string, error: string | null) {
    const [row] = this.sql<{ notes: string }>(
      "SELECT notes FROM rollbacks WHERE id = ? AND state = 'running'",
      id,
    );
    if (!row) return;
    const notes = JSON.parse(row.notes) as Array<string>;
    if (error !== null) {
      this.finishRollback(id, "failed", [...notes, `${error} The rollback stopped here.`]);
      return;
    }
    this.sql("UPDATE rollbacks SET next = next + 1, job_id = NULL WHERE id = ?", id);
    this.settleRollbackAction(id);
    // Set now, so the alarm does not settle the rollback before the next step starts.
    this.advancing.add(id);
    void this.advanceRollback(id).then(() => this.broadcast());
  }

  /**
   * K-821: stops each run rollback that waits for nothing: its job ended without a result (it expired, the repo was
   * blocked, the delivery failed), or a restart cut off a step. A job that failed only because its machine went
   * offline still waits until it expires, because kitshn takes its late result. Returns how many stopped.
   */
  private settleRollbacks() {
    const stuck = this.sql<{ id: string; notes: string; job_id: number | null }>(
      `SELECT rollbacks.id, rollbacks.notes, rollbacks.job_id FROM rollbacks LEFT JOIN jobs ON jobs.id = rollbacks.job_id
       WHERE rollbacks.state = 'running' AND (jobs.id IS NULL OR (jobs.state NOT IN ('queued', 'sent')
         AND NOT (jobs.state = 'failed' AND jobs.output = '${OFFLINE_OUTPUT}' AND jobs.expires_at > ?)))`,
      Date.now(),
    ).filter((row) => !this.advancing.has(row.id));
    for (const row of stuck)
      this.finishRollback(row.id, "failed", [
        ...(JSON.parse(row.notes) as Array<string>),
        row.job_id === null
          ? "kitshn restarted during this step, so it may or may not have rolled back. Check the card. The rollback stopped here."
          : "The machine sent no result for the last step. The rollback stopped here.",
      ]);
    return stuck.length;
  }

  /** K-821: the end of a run rollback; History shows it, because the toast shows only the steps before a job. */
  private finishRollback(id: string, state: "done" | "failed", notes: ReadonlyArray<string>) {
    const [row] = this.sql<{ actor: string }>(
      "UPDATE rollbacks SET state = ?, notes = ?, job_id = NULL WHERE id = ? AND state = 'running' RETURNING actor",
      state,
      JSON.stringify(notes),
      id,
    );
    if (!row) return;
    this.settleRollbackAction(id);
    this.recordRevision(
      JSON.parse(row.actor) as Actor,
      state === "done" ? "The run rollback ended (K-821)" : `The run rollback stopped: ${notes.at(-1) ?? ""}`,
    );
  }

  /** K-909: removes a deployed app; the card panel, the palette and `DELETE /api/apps/<card>` all come here. */
  private async removeApp(caller: Caller, id: string) {
    try {
      if (!this.deployedCards(id).includes(id))
        return Response.json(
          { error: `A deploy did not make the card "${id}", so it is not an app (K-909).` },
          { status: 409 },
        );
      return Response.json(await this.commitApps(caller.actor, removeAppChanges(this.state, id), null));
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      return Response.json({ error: `kitshn could not remove the app: ${String(error)}` }, { status: 502 });
    }
  }

  /**
   * K-909: commits changes that can remove or restore apps, with the work in Cloudflare and on machines that
   * goes with them. Returns the revision and a note for each app: what started or stopped, or why not.
   */
  private async commitApps(
    actor: Actor,
    changes: ReadonlyArray<Change>,
    undo: UndoOf | null,
  ): Promise<{ revision: number | null; notes: Array<string>; summary: string }> {
    const apps = changes.flatMap((change) => (change._tag === "app" ? [change] : []));
    // Check first, so that a refused change tears nothing down.
    this.checked(changes);
    for (const { after } of apps) if (after) this.refuseTakenBack(after);
    // K-410: a Worker address goes before its card, because the card keeps its Access application.
    for (const { before, after } of apps) {
      const teardown =
        before && !after ? appTeardown(before, this.env.KITSHN_ZONE, this.isFolderSite(before.id)) : null;
      if (teardown?.kind !== "worker" && teardown?.kind !== "domains") continue;
      const api = this.api();
      if (!api) throw new RuleError("kitshn has no Cloudflare API token here.");
      if (teardown.kind === "worker") {
        await this.removeWorker(api, teardown.addresses, teardown.script);
        continue;
      }
      await this.removeDomains(api, teardown.addresses, teardown.script);
      // A removed app runs no crons either, so it does not write to its kept storage; Undo puts them back. A script
      // that does not exist (a first upload failed, or someone deleted it) has none, and there is nothing to keep.
      const kept = await api(
        "PUT",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${teardown.script}/schedules`,
        [],
      ).then(
        () => true,
        (error: unknown) =>
          error instanceof CloudflareError && error.status === 404 ? false : Promise.reject(error),
      );
      if (!kept) continue;
      // K-909: the kept script is listed under "Orphaned" while its card is gone, with a way to delete it.
      this.sql(
        "INSERT OR REPLACE INTO worker_storage (card_id, kind, name, cf_id) VALUES (?, 'script', 'script', ?)",
        before!.id,
        teardown.script,
      );
    }
    // The state can change while Cloudflare answers.
    const conflict = conflictOf(this.state, changes);
    if (conflict) throw new RuleError(`${conflict._tag} "${conflict.id}" changed meanwhile. Try again.`);
    // K-909: the stop of a removed Compose app that the machine runs now ends first. A closed preview has its
    // own teardown (K-904), which the undo leaves alone.
    const restored = apps.flatMap(({ after }) =>
      after?.kind === "site.compose" && !this.closedPreview(after.id) ? [after] : [],
    );
    for (const { after } of apps)
      if (after && keepsScript(after, this.isFolderSite(after.id)) && this.deletingStorage.has(after.id))
        throw new RuleError(
          `kitshn deletes the storage of ${after.name} now; undo after it finishes (K-909).`,
        );
    for (const card of restored)
      if (composeUndo(removalDown(this.query, card.id)) === "refuse")
        throw new RuleError(`The machine is stopping ${card.name} now; undo after it finishes (K-909).`);
    // K-1502: what the change does, without the "Undo #n: " label of its History row, for the toast.
    const summary = summarize(this.state, applyChanges(this.state, changes), changes);
    const revision = this.commit(actor, changes, undo);
    // K-1123: a removed folder site ends the plans that wait for its files, so it counts for nothing and its next
    // publish is a first publish.
    for (const { before, after } of apps)
      if (before && !after && this.isFolderSite(before.id))
        for (const { id } of this.sql<{ id: string }>(
          "UPDATE deploys SET state = 'failed', reason = ? WHERE resource_id = ? AND state = 'planned' RETURNING id",
          "The owner removed the site.",
          before.id,
        ))
          this.settleDeployAction(id);
    // A stop that still waits goes, and the app starts again (a short restart where it never stopped).
    for (const card of restored) {
      failQueuedDowns(this.query, card.id, "The undo of the removal replaced this job (K-909).");
      dropLiveSite(this.query, card.id);
    }
    if (restored.length > 0) this.load();
    const notes: Array<string> = [];
    for (const { before, after } of apps) {
      if (after) notes.push(await this.restartApp(actor, after));
      else if (before?.kind === "site.compose") notes.push(this.stopCompose(actor, before));
    }
    if (apps.length > 0) {
      this.deliverJobs();
      this.broadcast();
    }
    return { revision, notes, summary };
  }

  /**
   * K-909: the cards that a deploy made, which "Remove app" accepts: a deploy with a repo id, or a finished one
   * from before the repo id (K-819). The card panel reads the same list.
   */
  private deployedCards(id: string): Array<string> {
    return this.sql<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM deploys WHERE kind = 'deploy'
       AND (repo_id IS NOT NULL OR state = 'done' OR resource_id LIKE 'folder-%')
       AND resource_id = ?`,
      id,
    )
      .map((row) => row.resource_id)
      .filter((card) => this.state.resources.has(card));
  }

  /** One scan of the deploy rows; it grows with each deploy. Revisit with a prune when it passes 10,000 rows. */
  private deploys(): DeployFacts {
    if (this.deployFacts) return this.deployFacts;
    const deployed = new Set<string>();
    const previews = new Set<string>();
    const pullRequests = new Map<string, number>();
    const repoCards = new Map<string, Set<string>>();
    const newest = new Map<string, { id: string; state: string; reason: string | null }>();
    const composeRuns: Array<ComposeRun> = [];
    for (const row of this.sql<{
      id: string;
      resource_id: string;
      repo_id: string | null;
      environment: string;
      state: string;
      reason: string | null;
      app: string;
      address: string;
      addresses: string | null;
      machine_id: string | null;
      expires_at: number;
    }>(
      `SELECT id, resource_id, repo_id, environment, state, reason, app, address, addresses, machine_id, expires_at
       FROM deploys WHERE kind = 'deploy' ORDER BY rowid`,
    )) {
      // A done deploy counts until it expires, so its record stays until the live site of its card holds it.
      if (
        row.app === "compose" &&
        (row.state === "planned" || row.state === "running" || row.state === "done") &&
        row.expires_at > Date.now()
      )
        composeRuns.push({
          card: row.resource_id,
          addresses: row.addresses === null ? [row.address] : (JSON.parse(row.addresses) as Array<string>),
          machineId: row.machine_id,
          expiresAt: row.expires_at,
        });
      if (row.repo_id !== null || row.state === "done") {
        deployed.add(row.resource_id);
        // As the GLOB 'pr-[0-9]*' of K-821: "pr-" and a digit.
        const digit = row.environment.charAt(3);
        if (row.environment.startsWith("pr-") && digit >= "0" && digit <= "9") {
          previews.add(row.resource_id);
          const number = pullRequestNumber(row.environment);
          if (number !== null) pullRequests.set(row.resource_id, number);
        }
      }
      if (row.repo_id !== null)
        repoCards.set(row.repo_id, (repoCards.get(row.repo_id) ?? new Set()).add(row.resource_id));
      newest.set(row.resource_id, { id: row.id, state: row.state, reason: row.reason });
    }
    this.deployFacts = {
      deployed: [...deployed],
      previews: [...previews],
      pullRequests: [...pullRequests],
      notes: [...newest]
        .filter(([, row]) => row.state === "failed" || row.state === "skipped")
        .map(([resource_id, row]) => ({ resource_id, ...row })),
      repoCards: [...repoCards].flatMap(([repo_id, cards]) =>
        [...cards].map((resource_id) => ({ repo_id, resource_id })),
      ),
      composeRuns,
      newest,
    };
    return this.deployFacts;
  }

  /** K-909, K-821: the deployed cards on the map and, of them, the preview cards. */
  private deployedAndPreviewCards() {
    const onMap = (cards: ReadonlyArray<string>) => cards.filter((card) => this.state.resources.has(card));
    const { deployed, previews, pullRequests } = this.deploys();
    return {
      deployedCards: onMap(deployed),
      previewCards: onMap(previews),
      pullRequests: Object.fromEntries(pullRequests.filter(([card]) => this.state.resources.has(card))),
    };
  }

  /** K-820: the cards on the map whose newest deploy failed or was skipped. */
  private deployNotes(): Record<string, DeployNote> {
    const notes: Record<string, DeployNote> = {};
    for (const row of this.deploys().notes)
      if (this.state.resources.has(row.resource_id))
        notes[row.resource_id] = {
          state: row.state === "skipped" ? "skipped" : "failed",
          reason: row.reason ?? "The deploy failed; its workflow run has the log.",
        };
    return notes;
  }

  /** K-718, K-909: the newest finished deploy of a card, or null. */
  private lastDone(id: string): DeployRow | null {
    const [row] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
      id,
    );
    return row ?? null;
  }

  /** K-909: the newest plan of this environment was a teardown, so its pull request closed (K-904). */
  private closedPreview(id: string) {
    const [row] = this.sql<{ kind: string }>(
      "SELECT kind FROM deploys WHERE resource_id = ? ORDER BY expires_at DESC LIMIT 1",
      id,
    );
    return row?.kind === "teardown";
  }

  /** K-718, K-909: the last finished deploy as the start of an app reads it. */
  private lastDeployOf(row: DeployRow): LastDeploy {
    return {
      app: row.app,
      repo: row.repo,
      branch: row.branch,
      resourceId: row.resource_id,
      environment: row.environment,
      name: row.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
      composeFile: row.compose_file,
    };
  }

  /** K-718, K-909: whether a machine can start the last good build of a card. */
  private redeployFacts(machine: Machine, card: string, repo: string) {
    return {
      canRedeploy: ["compose-redeploy", "compose-guard"].every(
        (capability) => this.machineView(machine).status?.capabilities?.includes(capability) ?? false,
      ),
      takesDeploys: machine.labels.includes("deploy"),
      runsCard: this.state.resources.get(card)?.machine === machine.id,
      allowed: allowedFor(machine, repo),
    };
  }

  /** K-909: stops a removed Compose app and keeps its volumes. The job waits for the machine, however long. */
  private stopCompose(actor: Actor, card: AppCard) {
    const teardown = appTeardown(card, this.env.KITSHN_ZONE, this.isFolderSite(card.id));
    if (teardown.kind !== "compose") throw new Error(`${card.name} is no Compose app.`);
    const machine = teardown.machineId ? this.state.machines.get(teardown.machineId) : undefined;
    if (!machine) return `kitshn knows no machine of ${card.name}, so nothing stops there.`;
    this.queueKitshnJob(machine.id, teardown.command, actor, NEVER);
    const when = this.jobMachines().has(machine.id) ? "now" : `when ${machine.name} comes online with a key`;
    return `${card.name} stops on ${machine.name} ${when}; its volumes stay on the machine.`;
  }

  /** K-909: the undo of a removal starts the app again where it can, and says why where it cannot. */
  private async restartApp(actor: Actor, card: AppCard) {
    if (keepsScript(card, this.isFolderSite(card.id))) return await this.reattachWorker(card);
    const done = this.lastDone(card.id);
    const machine = done?.machine_id ? this.state.machines.get(done.machine_id) : undefined;
    const refusal = this.state.paused
      ? "kitshn is paused, so it starts nothing until Resume."
      : done
        ? this.repoRefusal(done.repo_id)
        : null;
    const plan = appRestart(
      done ? this.lastDeployOf(done) : null,
      refusal,
      this.closedPreview(card.id),
      machine ? this.redeployFacts(machine, card.id, done?.repo ?? "") : null,
    );
    const back = `${card.name} is back on the map`;
    if (plan.kind === "none") return `${back}, but kitshn did not start it: ${plan.reason}`;
    if (plan.kind === "redeploy") {
      if (!machine) throw new Error("A redeploy plan without its machine.");
      this.queueKitshnJob(machine.id, plan.command, actor, Date.now() + DEPLOY_MS);
      return `${back} and starts its last good build on ${machine.name}.`;
    }
    try {
      const repo = await this.dispatchBuild(
        done?.repo_id ?? "",
        plan.branch,
        done?.workflow ?? AGENT_WORKFLOW,
      );
      return `${back}; kitshn started a build of ${repo} from ${plan.branch}.`;
    } catch (error) {
      return `${back}, but the build did not start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private authorized(caller: Caller) {
    return this.hasAdmin(caller.visitor);
  }

  private hasAdmin(visitor: Visitor) {
    const admin = this.state.resources.get(ADMIN_RESOURCE_ID);
    return admin !== undefined && visitorLevel(this.state, admin, visitor, Date.now()) === "control";
  }

  private snapshot(caller: Caller, repos: ReadonlyArray<RepoView> = this.repoViews()): Snapshot {
    const me = caller.actor;
    const desired = this.desired(Date.now());
    const loginError = this.meta("login_error");
    return {
      circles: [...this.state.circles.values()],
      // K-304: a provider card of an offline machine is offline, whatever its provider reported last.
      resources: [...this.state.resources.values()].map((card) =>
        card.provider && card.machine !== null && this.presence.get(card.machine)?.online !== true
          ? { ...card, status: "offline" as const }
          : card,
      ),
      places: Object.fromEntries(this.state.places) as Record<string, Point>,
      shareSettings: Object.fromEntries(this.state.shareSettings) as Record<string, ShareSetting>,
      ends: Object.fromEntries(this.state.ends),
      stacks: [...this.state.stacks.values()],
      revisions: this.revisions,
      access: accessStates(desired, this.access),
      accessWarnings: [
        ...this.accessWarnings,
        ...(loginError ? [loginError] : []),
        ...loginWarnings(desired, this.access),
      ],
      signOutWarning: signOutWarning(this.signOutLeft()),
      paused: this.state.paused,
      repos,
      ...this.deployedAndPreviewCards(),
      orphanWorkers: this.orphanWorkers(),
      deployNotes: this.deployNotes(),
      // K-1125: only the cards that are still checked, so a card that leaves the check loses its DOWN sticker.
      uptime: Object.fromEntries(
        this.uptimeTargets().map((card) => {
          const value = this.uptime.get(card.id) ?? UP;
          return [card.id, { up: value.up, since: value.since }];
        }),
      ),
      bell: [...this.openNotifications.values()].filter(
        (notification) =>
          this.receives(caller.visitor, notification) && onBell(notification, this.mutes, Date.now()),
      ).length,
      icons: Object.fromEntries([...this.iconHashes].filter(([id]) => this.state.resources.has(id))),
      previousVersions: this.sql<{ id: string }>(
        "SELECT id FROM library WHERE previous_size IS NOT NULL",
      ).map((row) => row.id),
      addressHolds: Object.fromEntries(
        [...this.liveSites.values()].flatMap((site): Array<[string, AddressHold]> => {
          if (!this.state.resources.get(site.id)?.provider) return [];
          if (site.state === "refused") return [[site.id, "in-use"]];
          if (site.state === "handover") return [[site.id, "taking"]];
          const handover = site.state === "ok" ? this.handoverOf(site.id) : null;
          return handover && !handover.released ? [[site.id, "taken"]] : [];
        }),
      ),
      progress: Object.fromEntries(
        [...this.progressRows()].flatMap(([id, row]) =>
          this.state.resources.has(id) && progressShown(row.progress, Date.now())
            ? [[id, { ...row.progress, canDismiss: this.canControl(caller.visitor, id) }]]
            : [],
        ),
      ),
      handoverCards: this.sql<{ id: string }>(
        `SELECT id FROM library WHERE added_by IS NOT NULL AND kind = 'page'
         UNION SELECT card_id AS id FROM agent_sites
         WHERE client_id NOT LIKE 'owner:%' AND card_id NOT IN (SELECT card_id FROM repo_cards)`,
      )
        .map((row) => row.id)
        .filter(
          (id) =>
            this.state.resources.get(id)?.kind === "page" ||
            this.state.resources.get(id)?.kind === "site.static",
        ),
      folderSites: this.sql<{ id: string }>(
        "SELECT card_id AS id FROM agent_sites WHERE card_id NOT IN (SELECT card_id FROM repo_cards)",
      )
        .map((row) => row.id)
        .filter((id) => this.state.resources.has(id)),
      redirects: this.sql<{ address: string; card_id: string }>(
        "SELECT address, card_id FROM old_addresses WHERE pinned = 1 AND going = 0 ORDER BY rowid",
      ).reduce<Record<string, Array<string>>>((all, row) => {
        (all[row.card_id] ??= []).push(row.address);
        return all;
      }, {}),
      pausedBy: this.state.paused ? parsePausedBy(this.meta("paused_by"), this.meta("paused_at")) : null,
      machines: [...this.state.machines.values()].map((machine) => this.machineView(machine)),
      // K-717: only of cards that exist; an undoable removal keeps the rows, so Undo brings the settings back.
      cardSettings: Object.fromEntries([...this.cardSettings].filter(([id]) => this.state.resources.has(id))),
      providerCommands: Object.fromEntries(
        [...this.providerRegs].map(([machineId, regs]) => [
          machineId,
          regs.map(({ name, commands }) => ({ name, commands })),
        ]),
      ),
      // K-1902: the live asks go only to who may answer them; History keeps every ask for the owner (K-1717).
      proposals: this.answerableProposals(caller.visitor),
      askEvents: this.recentAskEvents(),
      linkEvents: this.recentLinkEvents(),
      githubDefaultWay: this.meta("github_default_way") === "app" ? "app" : "not-kitshn",
      // K-1767: the newest 20 runs of pull requests of the App that wait for Deploy.
      botRuns: this.sql<{ repo_id: string; repo: string; pr: number; sha: string; at: number }>(
        "SELECT repo_id, repo, pr, sha, at FROM bot_runs WHERE approved = 0 ORDER BY at DESC LIMIT 20",
      ).map((row) => ({ repoId: row.repo_id, repo: row.repo, pr: row.pr, sha: row.sha, at: row.at })),
      jobs: this.recentJobs(10, 2000),
      queuedJobs: Object.fromEntries(
        this.sql<{ machine_id: string; queued: number }>(
          "SELECT machine_id, COUNT(*) AS queued FROM jobs WHERE state = 'queued' AND machine_id IS NOT NULL GROUP BY machine_id",
        ).map((row) => [row.machine_id, row.queued]),
      ),
      backups: Object.fromEntries(this.latestBackups()),
      r2Bucket: this.bucket(),
      backupsOff: !this.env.KITSHN_BACKUP_KEY,
      restoreUndo: this.meta("restore_undo"),
      version: this.env.KITSHN_VERSION,
      accessTeam: this.env.ACCESS_TEAM_DOMAIN,
      zone: this.env.KITSHN_ZONE,
      revision: this.lastRevision(),
      me,
    };
  }

  private machineView(machine: Machine): MachineView {
    const socket = this.openSocket(machine.id);
    const attachment = socket ? attachmentOf(socket) : null;
    const live = attachment?.kind === "machine" ? attachment : null;
    return {
      machine,
      online: socket !== null,
      lastSeen: this.presence.get(machine.id)?.lastSeen ?? null,
      status: live?.status ?? null,
      sample: live?.sample ?? null,
      os: this.presence.get(machine.id)?.os ?? null,
      keyFailure: this.keyFailures.get(machine.id) ?? null,
      orphanVolumes: orphanVolumes(live?.volumes ?? [], this.state),
      servers: live?.servers ?? [],
      health: live?.health ?? null,
      queued: this.queuedFor(machine, live?.status ?? null),
      // K-628: kept between the events that change it (K-627), so a view reads no job rows.
      update: daemonUpdate(this.rollout(), machine.id, this.env.KITSHN_VERSION),
    };
  }

  /**
   * K-631: the cells of the health grid in the row and the column of one machine. It reads the socket attachments
   * only, no rows (K-1715).
   */
  private healthOf(machineId: string) {
    const machines = [...this.state.machines.values()].map((machine) => {
      const socket = this.openSocket(machine.id);
      const attachment = socket ? attachmentOf(socket) : null;
      return {
        machine,
        online: socket !== null,
        health: attachment?.kind === "machine" ? (attachment.health ?? null) : null,
      };
    });
    const self = machines.find((view) => view.machine.id === machineId);
    if (!self) return [];
    const now = Date.now();
    return machines.flatMap((other) => {
      const name = (view: (typeof machines)[number]) => ({ id: view.machine.id, name: view.machine.name });
      const outgoing = { from: name(self), to: name(other), ...healthCell(self, other.machine.id, now) };
      if (other === self) return [outgoing];
      return [outgoing, { from: name(other), to: name(self), ...healthCell(other, machineId, now) }];
    });
  }

  /** The newest open socket of a machine that passed its check (K-1704), or null. */
  private openSocket(machineId: string): WebSocket | null {
    const open = this.checkedSockets(machineId).filter((socket) => socket.readyState === WebSocket.OPEN);
    return open.at(-1) ?? null;
  }

  /** K-1704: the sockets of a machine that kitshn reads and sends jobs to. */
  private checkedSockets(machineId: string) {
    return this.ctx.getWebSockets(machineId).filter((socket) => {
      const attachment = attachmentOf(socket);
      return attachment?.kind === "machine" && attachment.check !== "waiting";
    });
  }

  /** Sends one changed machine to every open map, instead of a whole snapshot. */
  private sendMachine(machine: Machine) {
    // K-538: a machine that changed can move an update on, and the steps of an action live in the snapshot.
    if (this.reconcileProgress()) return this.broadcast();
    const message: ServerMessage = { type: "machine", view: this.machineView(machine) };
    for (const socket of this.ctx.getWebSockets("map")) send(socket, message);
  }

  private broadcast() {
    const repos = this.repoViews();
    // K-1904: the sources that kitshn derives from its own state follow each change before the maps hear of it.
    this.reconcileNotifications(repos);
    this.reconcileProgress();
    // K-1716: a change can take a code right away.
    this.revokeTokens(null, true);
    // K-1608: the pushes go out, and their hashes count the queue, before the maps read the counts.
    this.pushGrants();
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = attachmentOf(socket);
      if (attachment?.kind !== "map") continue;
      const caller = attachment.caller;
      if (!this.authorized(caller)) {
        socket.close(4003, "You lost access to the kitshn admin.");
        continue;
      }
      send(socket, { type: "snapshot", snapshot: this.snapshot(caller, repos) });
    }
  }

  /** K-706: sends each provider of each signed connection its grant tables when they changed since the last send. */
  private pushGrants(now = Date.now()) {
    this.pushHashes.clear();
    for (const machineId of this.state.machines.keys()) {
      const pushes = this.pushesOf(machineId, now);
      this.pushHashes.set(machineId, new Map(pushes.map(({ key, hash }) => [key, hash])));
      const socket = this.ctx.getWebSockets(machineId).find((item) => {
        const attachment = attachmentOf(item);
        return attachment?.kind === "machine" && attachment.check === "signed";
      });
      if (!socket) continue;
      const attachment = attachmentOf(socket);
      for (const { key, hash, push } of pushes) {
        // The first push follows the signed handshake, before status names this capability.
        if (
          (push.type === "siteReach" || push.type === "siteGuard") &&
          (attachment?.kind !== "machine" ||
            !attachment.status?.capabilities?.includes(
              push.type === "siteReach" ? SITE_LINKS_CAPABILITY : SITE_GUARD_CAPABILITY,
            ))
        )
          continue;
        if (this.sentGrants.get(`${machineId}/${key}`) === hash) continue;
        this.sentGrants.set(`${machineId}/${key}`, hash);
        const { key: _key, ...message } = push;
        send(socket, { ...message, hash } as ServerToDaemon);
      }
    }
  }

  /** K-1608: every push that the providers of a machine get now, each with the hash of its content. */
  private pushesOf(machineId: string, now = Date.now()) {
    return (
      providerPushes(
        this.state,
        machineId,
        this.providerRegs.get(machineId) ?? [],
        this.desiredState,
        this.cardSettings,
        now,
        {
          teamDomain: this.env.ACCESS_TEAM_DOMAIN,
          // An application lives until the sync deletes it, so its audience stays until then, also after a give-back.
          servedHost: (cardId) => {
            const site = this.liveSites.get(cardId);
            const handover = this.handoverOf(cardId);
            return site?.state === "ok" && (handover === null || (handover.switched && !handover.returning))
              ? site.address
              : null;
          },
          audiencesOf: (cardId) => this.audiencesOf(cardId),
          revOf: (kind) => this.desiredRevs.get(kind) ?? null,
        },
      )
        .concat(
          (this.providerRegs.get(machineId) ?? []).length === 0
            ? []
            : [
                { key: pushKey.paused(), type: "paused", paused: this.state.paused !== null },
                {
                  key: pushKey.execRights(),
                  type: "execRights",
                  machines: execMachinesOf(this.state, machineId, now),
                },
              ],
        )
        // No caller may send its reusable machine credential to an ordinary live-site hostname. Keep reach empty
        // until the reserved link host, Access application, DNS and destination guard are all confirmed ready.
        .concat([{ key: SITE_REACH_KEY, type: "siteReach", cards: [] }])
        .concat([
          {
            key: SITE_GUARD_KEY,
            type: "siteGuard",
            teamDomain: this.env.ACCESS_TEAM_DOMAIN,
            grants: this.guardGrantsOf(machineId, now),
          },
        ])
        .map((push) => {
          const text = JSON.stringify(push);
          return { key: push.key, hash: `${fnv(text)}${fnv(text, 0x050c5d1f)}`, push };
        })
    );
  }

  /** The destination gets only known path audiences and locally enforced machine grants. */
  private guardGrantsOf(machineId: string, now: number) {
    const socket = this.openSocket(machineId);
    const attachment = socket ? attachmentOf(socket) : null;
    if (
      attachment?.kind !== "machine" ||
      attachment.check !== "signed" ||
      !attachment.status?.capabilities?.includes(SITE_GUARD_CAPABILITY) ||
      !attachment.status.siteGuardSocket
    )
      return [];
    const host = siteLinkHost(machineId, this.env.KITSHN_ZONE);
    if (!host) return [];
    const wanted = this.desired(now).apps;
    return [...siteGuardClientsOf(this.state, machineId, now)].flatMap(([id, clients]) => {
      const site = this.liveSites.get(id);
      const domain = siteLinkDomain(host, id);
      if (!site || site.state !== "ok" || !domain) return [];
      const key = `app:${id}:${domain}`;
      const app = this.access.get(key);
      if (!wanted.has(key) || !app?.cfId || !app.aud || appliesBypass(app, this.access) !== false) return [];
      return [{ id, name: site.name, host: site.address, audience: app.aud, clients }];
    });
  }

  /** K-603: the AUD tags of kitshn's Access applications of a card that exist in Cloudflare. */
  private audiencesOf(cardId: string) {
    return [...this.access.values()].flatMap((row) =>
      row.key.startsWith(`app:${cardId}:`) && row.cfId && row.aud ? [row.aud] : [],
    );
  }

  /** K-822: read at each deploy, redeploy and rollback, so the app always gets the current audiences. */
  private appAccess(cardId: string): AppAccess {
    return {
      teamDomain: this.env.ACCESS_TEAM_DOMAIN,
      audiences: [...new Set(this.audiencesOf(cardId))].sort(),
    };
  }

  /** K-709: the kinds of desired state that the providers registered, with their JSON Schema. */
  private stateKind(kind: string) {
    for (const regs of this.providerRegs.values())
      for (const reg of regs) {
        const found = reg.kinds.find((item) => item.id === kind && item.state !== undefined);
        if (found) return found;
      }
    return null;
  }

  /** K-709: every part of one desired state, for the editor of the map and for agents. */
  private readDesired(kind: string) {
    const found = this.stateKind(kind);
    if (!found)
      return Response.json({ error: `No provider registered the state ${kind} (K-709).` }, { status: 404 });
    const parts = this.desiredState.get(kind) ?? new Map<string, unknown>();
    return Response.json({
      kind,
      schema: found.state?.schema ?? null,
      shared: parts.get("") ?? null,
      machines: Object.fromEntries([...parts].filter(([machineId]) => machineId !== "")),
    });
  }

  /** K-709: the map sets the shared part (the admin) or the part of one machine (control on that machine). */
  private putDesired(caller: Caller, kind: string, body: unknown) {
    if (!this.stateKind(kind))
      return Response.json({ error: `No provider registered the state ${kind} (K-709).` }, { status: 404 });
    if (!isRecord(body) || !("value" in body))
      return Response.json(
        { error: "Send { machineId, value }; machineId null sets the shared part." },
        { status: 400 },
      );
    const machineId = typeof body["machineId"] === "string" ? body["machineId"] : null;
    if (machineId !== null && !this.state.machines.has(machineId))
      return Response.json({ error: `No machine "${machineId}" exists.` }, { status: 404 });
    if (machineId !== null && !this.canControl(caller.visitor, machineId))
      return Response.json({ error: "A part of a machine needs control on that machine." }, { status: 403 });
    const refusal = this.writeDesired(kind, machineId ?? "", body["value"], caller.actor);
    return refusal ? Response.json({ error: refusal }, { status: 413 }) : Response.json({ ok: true });
  }

  /**
   * K-717: one card setting of a provider card. It needs control on the card, which kitshn checks here; it changes
   * no access, so it is no proposal (K-715). History records it without Undo.
   */
  private setCardSetting(caller: Caller, cardId: string, body: unknown) {
    const card = this.state.resources.get(cardId);
    const key = isRecord(body) && typeof body["key"] === "string" ? body["key"] : null;
    const value = isRecord(body) && typeof body["value"] === "string" ? body["value"] : null;
    const setting = card?.provider?.settings.find((item) => item.id === key);
    if (!card || !setting)
      return Response.json({ error: `${cardId} has no setting ${key}.` }, { status: 404 });
    if (value === null || !setting.values.includes(value))
      return Response.json(
        { error: `${setting.title} is one of ${setting.values.join(", ")}.` },
        { status: 400 },
      );
    const state =
      this.state.paused && this.hasAdmin(caller.visitor) ? { ...this.state, paused: null } : this.state;
    if (visitorLevel(state, card, caller.visitor, Date.now()) !== "control")
      return Response.json(
        { error: `${setting.title} needs control on ${card.name} (K-717).` },
        { status: 403 },
      );
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR REPLACE INTO card_settings (card_id, key, value) VALUES (?, ?, ?)",
        card.id,
        setting.id,
        value,
      );
      this.insertRevision(caller.actor, `Set ${setting.title} of ${card.name} to ${value} (K-717)`, [], null);
    });
    this.load();
    this.broadcast();
    return Response.json({ ok: true });
  }

  /** K-1608, K-1625: a provider card of the machine reports the fact `busy` as "true". */
  private busy(machineId: string) {
    return machineBusy(this.state, machineId);
  }

  /**
   * K-1608: how many pushes a machine has not applied yet; a machine without providers has none. Null when it never
   * answered `applied`: a daemon from before K-1608 does not, so its count is unknown, not a growing number.
   */
  private queuedFor(machine: Machine, status: MachineStatus | null): number | null {
    // A machine without a key gets no pushes (K-1708), so nothing waits for it.
    if (machine.key?.kind !== "public") return 0;
    // A daemon from before K-1623 never applies the access push, so its count leaves that push out.
    const access = status === null || status.capabilities?.includes("access") === true;
    // K-721: only a daemon of provider protocol 2 applies the pushes of the pause and the exec rights.
    const v2 = status === null || status.capabilities?.includes("protocol-2") === true;
    // Until this connection reports support, do not count a push that an old daemon cannot apply.
    const siteLinks = status?.capabilities?.includes(SITE_LINKS_CAPABILITY) === true;
    const siteGuard = status?.capabilities?.includes(SITE_GUARD_CAPABILITY) === true;
    const pushes = [...this.hashesOf(machine.id)].filter(
      ([key]) =>
        (access || !key.startsWith("access:")) &&
        (v2 || !key.startsWith("kitshn:")) &&
        (siteLinks || key !== SITE_REACH_KEY) &&
        (siteGuard || key !== SITE_GUARD_KEY),
    );
    if (pushes.length === 0) return 0;
    // An online daemon that does not name `applied` never answers it, so its count is unknown.
    if (status !== null && !status.capabilities?.includes("applied")) return null;
    return pushes.filter(([key, hash]) => this.applied.get(`${machine.id}/${key}`) !== hash).length;
  }

  /** K-1608: the hash of each push of a machine, from the last `pushGrants`, or counted now after a restart. */
  private hashesOf(machineId: string): ReadonlyMap<string, string> {
    const known = this.pushHashes.get(machineId);
    if (known) return known;
    const hashes = new Map(this.pushesOf(machineId).map(({ key, hash }) => [key, hash]));
    this.pushHashes.set(machineId, hashes);
    return hashes;
  }

  /**
   * K-709: a provider of the machine sets its part of a desired state, or the shared part. kitshn stores it and pushes
   * it to every machine of the provider; History records it without Undo.
   */
  private setDesiredFromMachine(
    machine: Machine,
    message: Extract<DaemonMessage, { type: "desiredSet" }>,
  ): string | null {
    const kinds =
      this.providerRegs.get(machine.id)?.find((item) => item.name === message.provider)?.kinds ?? [];
    return (
      desiredProblem(kinds, message.kind, message.value) ??
      this.writeDesired(
        message.kind,
        message.part === "shared" ? "" : machine.id,
        message.value,
        { _tag: "machine", machineId: machine.id, name: machine.name },
        typeof message.rev === "string" ? message.rev.slice(0, 64) : null,
      )
    );
  }

  /** K-709: stores one part of a desired state, or says why not. A part of null clears it. */
  private writeDesired(
    kind: string,
    machineId: string,
    value: unknown,
    actor: Actor,
    rev: string | null = null,
  ): string | null {
    const text = JSON.stringify(value ?? null);
    const kinds = [...this.providerRegs.values()].flatMap((regs) => regs.flatMap((reg) => reg.kinds));
    const problem = desiredProblem(kinds, kind, value);
    if (problem) return problem;
    const same = deepEqual(this.desiredState.get(kind)?.get(machineId) ?? null, value ?? null);
    // K-709: a set with a rev stores the rev also when the value stays, so its provider sees that it arrived.
    if (same && (rev === null || this.desiredRevs.get(kind) === rev)) return null;
    if (same) {
      this.sql("INSERT OR REPLACE INTO desired_revs (kind, rev) VALUES (?, ?)", kind, rev);
      this.desiredRevs.set(kind, rev!);
      this.pushGrants();
      return null;
    }
    const where =
      machineId === ""
        ? "the shared part"
        : `the part of ${this.state.machines.get(machineId)?.name ?? machineId}`;
    this.ctx.storage.transactionSync(() => {
      if (rev === null) this.sql("DELETE FROM desired_revs WHERE kind = ?", kind);
      else this.sql("INSERT OR REPLACE INTO desired_revs (kind, rev) VALUES (?, ?)", kind, rev);
      if (value === null || value === undefined)
        this.sql("DELETE FROM desired_state WHERE kind = ? AND machine_id = ?", kind, machineId);
      else
        this.sql(
          "INSERT OR REPLACE INTO desired_state (kind, machine_id, body) VALUES (?, ?, ?)",
          kind,
          machineId,
          text,
        );
      this.insertRevision(actor, `Set ${where} of ${kind} (K-709)`, [], null);
    });
    this.load();
    this.broadcast();
    return null;
  }

  /**
   * K-704, K-705: the providers of one machine, as its daemon reports them. Cards of a named provider that its report
   * no longer has go, with their shares, as one History revision; the cards of a provider that the report does not
   * name stay, offline. An address that another card or another machine's site holds stays off the card.
   */
  private updateProviders(machine: Machine, value: unknown) {
    const wasBusy = this.busy(machine.id);
    let reports: ReadonlyArray<ProviderReport>;
    try {
      reports = decodeProviderReports(value);
    } catch (error) {
      console.warn(`kitshn refused the providers of ${machine.name}: ${String(error)}`);
      return;
    }
    // K-704: a forgotten provider that the daemon still reports offline stays forgotten; one that runs is back.
    const forgotten = new Set(
      this.sql<{ name: string }>("SELECT name FROM forgotten_providers WHERE machine_id = ?", machine.id).map(
        (row) => row.name,
      ),
    );
    for (const name of forgotten)
      if (!reports.some((report) => report.name === name && !report.online))
        this.sql("DELETE FROM forgotten_providers WHERE machine_id = ? AND name = ?", machine.id, name);
    reports = reports.filter((report) => !(forgotten.has(report.name) && !report.online));
    const valid = reports.filter((report) => {
      const problem = reportProblem(
        report,
        reports.filter((other) => other.name !== report.name),
        new Set(),
        RESERVED_SITE_NAMES,
      );
      if (problem) console.warn(`kitshn refused the provider ${report.name} of ${machine.name}: ${problem}`);
      return problem === null;
    });
    const named = new Set(valid.map((report) => report.name));
    const wanted = providerCards(machine, valid, this.env.KITSHN_ZONE);
    // K-705: the daemon reports a provider's site before its cards, so the site can wait under an id of its own. It
    // moves to the card that names it, and a card that kitshn made for it meanwhile goes.
    const waiting = [...wanted.values()].flatMap((card) => {
      const site = card.provider?.site
        ? this.liveSites.get(liveSiteId(machine.id, card.provider.site))
        : undefined;
      return site && !this.liveSites.has(card.id) ? [{ site, card }] : [];
    });
    if (waiting.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const { site, card } of waiting) {
          this.sql("UPDATE live_sites SET id = ? WHERE id = ?", card.id, site.id);
          if (!this.state.resources.has(site.id)) continue;
          const forgotten = this.forgetCard(site.id);
          this.insertRevision(
            { _tag: "kitshn", reason: `providers on ${machine.name}` },
            `${site.address} belongs to the provider card ${card.name}, so its own card went`,
            [forgotten],
            null,
          );
        }
      });
      this.load();
    }
    for (const [id, card] of wanted) {
      const refusals = card.addresses.flatMap((address) => {
        const label = address.slice(0, -`.${this.env.KITSHN_ZONE}`.length);
        const refusal =
          RESERVED_SITE_NAMES.has(label) || address === this.env.KITSHN_HOST
            ? `${address} is a name of kitshn itself.`
            : (this.addressTaken(address, id) ??
              ([...this.liveSites.values()].some((site) => site.id !== id && site.address === address)
                ? `${address} is a live site of another card.`
                : null));
        return refusal ? [{ address, refusal }] : [];
      });
      for (const { refusal } of refusals)
        console.warn(`kitshn kept an address off the card ${card.name}: ${refusal}`);
      // K-705, K-1111: the site's address goes on the card only after its check found it free, so no Access
      // application, DNS record or ingress rule takes a host that something else still serves (K-1623).
      const site = this.liveSites.get(id);
      const serves = site?.state === "ok" || site?.state === "handover";
      const held = card.addresses.filter((address) => !serves || site.address !== address);
      if (refusals.length === 0 && held.length === 0) continue;
      const off = new Set([...refusals.map((item) => item.address), ...held]);
      const inUse = site?.state === "refused" && held.includes(site.address);
      wanted.set(
        id,
        withAddressInUse(
          { ...card, addresses: card.addresses.filter((address) => !off.has(address)) },
          inUse,
        ),
      );
    }
    const existing = [...this.state.resources.values()].filter(
      (card) => card.machine === machine.id && card.provider !== undefined,
    );
    // K-705: a card that a report drops stays, offline with its place and shares and no grants, until its provider
    // reports it again or the owner forgets it. kitshn never forgets a share by itself.
    const now = Date.now();
    const dropped = existing.filter((card) => named.has(card.provider!.name) && !wanted.has(card.id));
    const changed = [
      ...[...wanted.values()].filter((card) => !deepEqual(this.state.resources.get(card.id), card)),
      ...dropped
        .filter((card) => card.provider!.droppedAt === undefined)
        .map((card): Resource => ({
          ...card,
          status: "offline",
          provider: { ...card.provider!, droppedAt: now },
        })),
      ...existing
        .filter((card) => !named.has(card.provider!.name) && card.status !== "offline")
        .map((card): Resource => ({ ...card, status: "offline" })),
    ];
    // K-713: a provider that changes the levels of a kind changes what existing shares give, so History says so.
    const levelChanges = valid.flatMap((report) => {
      const old = this.providerRegs.get(machine.id)?.find((reg) => reg.name === report.name);
      return report.kinds.flatMap((kind) => {
        const before = old?.kinds.find((item) => item.id === kind.id)?.levels;
        return before && !deepEqual(before, kind.levels)
          ? [`${kind.id}: ${Object.values(before).join(", ")} → ${Object.values(kind.levels).join(", ")}`]
          : [];
      });
    });
    const added = changed.filter((card) => !this.state.resources.has(card.id));
    const kept = (this.providerRegs.get(machine.id) ?? []).filter((reg) => !named.has(reg.name));
    const regs = [
      ...kept,
      ...valid.map(({ name, kinds, commands, clients }) => ({
        name,
        kinds,
        commands,
        ...(clients ? { clients } : {}),
      })),
    ];
    const regsChanged = !deepEqual(
      [...(this.providerRegs.get(machine.id) ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      [...regs].sort((a, b) => a.name.localeCompare(b.name)),
    );
    if (changed.length === 0 && !regsChanged) return;
    // K-719: a card that gains owner control loses the settings of its Owner share that the guard now refuses, in the
    // same transaction, so an older override or end date never blocks a later change, also a pause.
    const ownerKeys = changed
      .filter((card) => card.provider?.ownerControl === true)
      .map((card) => shareKey(card.id, OWNER_CIRCLE_ID))
      .filter((key) => this.state.shareSettings.has(key));
    this.ctx.storage.transactionSync(() => {
      for (const card of changed) this.putResource(card);
      for (const key of ownerKeys) this.sql("DELETE FROM share_settings WHERE id = ?", key);
      if (ownerKeys.length > 0)
        this.insertRevision(
          { _tag: "kitshn", reason: `providers on ${machine.name}` },
          `The Owner circle keeps control of ${ownerKeys.length} provider cards of ${machine.name}, so their Owner share settings went (K-719)`,
          [],
          null,
        );
      if (regsChanged) {
        this.sql("DELETE FROM providers WHERE machine_id = ?", machine.id);
        for (const reg of regs)
          this.sql(
            "INSERT INTO providers (machine_id, name, body) VALUES (?, ?, ?)",
            machine.id,
            reg.name,
            JSON.stringify(reg),
          );
      }
      if (levelChanges.length > 0)
        this.insertRevision(
          { _tag: "kitshn", reason: `providers on ${machine.name}` },
          `The providers of ${machine.name} changed levels (K-713): ${levelChanges.join("; ")}`.slice(0, 500),
          [],
          null,
        );
      // K-1502: new cards are History; a status, a fact or a sticker that changes is not.
      if (added.length > 0)
        this.insertRevision(
          { _tag: "kitshn", reason: `providers on ${machine.name}` },
          `The providers of ${machine.name} added ${added.map((card) => card.name).join(", ")}`.slice(0, 500),
          [],
          null,
        );
    });
    this.load();
    this.broadcast();
    // K-1608: a report can end `busy`, so a job that waits for an idle machine goes now.
    this.deliverJobs();
    // K-627: a machine that turns busy or idle can change which machine the rollout updates next.
    if (this.busy(machine.id) !== wasBusy) this.autoUpdate();
    void this.scheduleAlarm();
  }

  /** `via`: an HTTP request without a source is the API (K-1509); the map always names its source. */
  private async handle(
    caller: Caller,
    message: ClientMessage,
    via: "socket" | "http",
  ): Promise<Extract<ServerMessage, { type: "result" }>> {
    try {
      const { revision, notes, summary } =
        message.type === "apply"
          ? { revision: this.apply(caller.actor, message.edits), notes: [], summary: null }
          : message.type === "organize"
            ? {
                ...this.organize(caller.actor, drawnSizes(message), (id) => {
                  // K-532: the map does not draw a hidden kind, so its cards stay where they are.
                  const kind = this.state.resources.get(id)?.kind;
                  return kind !== undefined && !message.hiddenKinds.includes(kind);
                }),
                notes: [],
              }
            : message.type === "undo"
              ? await this.undo(
                  caller.actor,
                  message.revision,
                  message.source ?? (via === "http" ? "api" : null),
                )
              : await this.undoItem(caller.actor, message.item);
      return { type: "result", requestId: message.requestId, ok: true, revision, notes, summary };
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      return { type: "result", requestId: message.requestId, ok: false, error: error.message };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // The join exchange is public: the join code itself is the secret (K-602).
    if (path === "/join/exchange" && request.method === "POST") return this.exchangeJoin(request);
    if (path === "/join/rekey" && request.method === "POST") return this.rekey(request);
    // K-1601: public too; the invite code is the secret.
    if (path === "/join/device" && request.method === "POST") return this.exchangeInvite(request);
    if (path === "/internal/offline")
      return this.offlineInfo(new URL(request.url).searchParams.get("address") ?? "");
    if (path === "/internal/public-cards") return this.publicCards();
    if (path === "/internal/invite-clients") return Response.json(this.inviteClients().shared);
    if (path === "/internal/denied") return Response.json(this.refusedAt(new URL(request.url).searchParams));
    if (path === "/ask") return this.askForAccess(request);
    if (path === "/internal/badge") return this.badge(new URL(request.url).searchParams);
    if (path === "/internal/notify" && request.method === "POST") return this.appNotify(request);
    if (path === "/internal/import-status") return Response.json(this.importStatus());
    if (path === "/internal/backup-access")
      return this.backupAccess((await request.json()) as { card: string; clientId: string });
    if (path === "/internal/content") return this.contentDecision((await request.json()) as ContentRequest);
    if (path === "/internal/game") return this.gameDecision((await request.json()) as GameRequest);
    if (path === "/internal/well-known/openid-configuration" || path === "/internal/well-known/jwks.json")
      return this.wellKnown(path.slice("/internal/well-known/".length).replace(".json", ""));
    if (path.startsWith("/deploy/")) {
      const header = request.headers.get("x-kitshn-deployer");
      if (!header) return new Response("The Worker sent no deployer.", { status: 500 });
      if (path === "/deploy/archive" || path === "/deploy/params")
        return this.deployFile(path, JSON.parse(header) as Deployer, request);
      return this.deployStep(path, JSON.parse(header) as Deployer, await request.json().catch(() => null));
    }
    // K-1723: an approve or a deny on the approve path of one kind; the token must come from its own application.
    if (path.startsWith("/approve/passkey/") || path.startsWith("/approve/login/")) {
      const via = path.startsWith("/approve/passkey/") ? "passkey" : "login";
      const rest = path.slice(`/approve/${via}/`.length);
      const deny = rest.endsWith("/deny");
      const id = decodeURIComponent(deny ? rest.slice(0, -"/deny".length) : rest);
      const approver = await approverOf(
        request,
        this.env,
        this.access.get(APPROVE_APPS[via])?.aud ?? null,
        via === "passkey",
        Date.now(),
      );
      if (typeof approver === "string") return Response.json({ error: approver }, { status: 401 });
      return this.answerProposal(
        id,
        deny ? "denied" : "approved",
        approver,
        via,
        await request.json().catch(() => null),
      );
    }
    const header = request.headers.get("x-kitshn-caller");
    if (!header) return new Response("The Worker sent no caller.", { status: 500 });
    const caller = JSON.parse(header) as Caller;
    if (path === "/connect") return this.connectMachine(request, caller);
    // Only the Worker's fresh passkey route sends this path (K-1504).
    if (path === "/fresh/resume" && request.method === "POST") return this.resume(caller);
    // K-1723: the owner denies an ask from the map.
    if (path.startsWith("/api/proposals/") && path.endsWith("/deny") && request.method === "POST")
      return this.answerProposal(
        decodeURIComponent(path.slice("/api/proposals/".length, -"/deny".length)),
        "denied",
        caller,
        null,
        await request.json().catch(() => null),
      );
    if (path === "/fresh/restore-time" && request.method === "POST")
      return await this.restoreTime(caller, await request.json().catch(() => null));
    if (path === "/fresh/restored" && request.method === "POST")
      return await this.restored(caller, await request.json().catch(() => null));
    if (path.startsWith("/agent/")) return this.agentRequest(path, request, caller);
    if (path === "/device/machines" && request.method === "GET")
      return Response.json(this.deviceMachines(caller.visitor));
    if (path.startsWith("/connect/deploys/")) return this.deploySource(path, caller);
    if (!this.authorized(caller)) {
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    }
    if (path.startsWith("/api/icons/") && request.method === "GET")
      return this.icon(path.slice("/api/icons/".length));
    if (path === "/api/ws") {
      if (request.headers.get("upgrade") !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, ["map"]);
      server.serializeAttachment({ kind: "map", caller } satisfies Attachment);
      send(server, { type: "snapshot", snapshot: this.snapshot(caller) });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/api/state" && request.method === "GET") return Response.json(this.snapshot(caller));
    if (path === "/api/sign-out" && request.method === "POST") return this.signOut(caller);
    if (path === "/api/sign-out/retry" && request.method === "POST") return this.retrySignOut(caller);
    if (path === "/api/health/check" && request.method === "POST") return this.checkHealthNow(caller);
    if (path === "/api/machines" && request.method === "POST")
      return this.addMachine(caller, await request.json().catch(() => null), new URL(request.url).origin);
    if (path.startsWith("/api/desired/")) {
      const kind = decodeURIComponent(path.slice("/api/desired/".length));
      if (request.method === "GET") return this.readDesired(kind);
      if (request.method === "PUT")
        return this.putDesired(caller, kind, await request.json().catch(() => null));
    }
    if (path.startsWith("/api/cards/") && path.endsWith("/settings") && request.method === "POST")
      return this.setCardSetting(
        caller,
        decodeURIComponent(path.slice("/api/cards/".length, -"/settings".length)),
        await request.json().catch(() => null),
      );
    if (path.startsWith("/api/cards/") && path.endsWith("/take-address") && request.method === "POST") {
      const api = this.api();
      if (!api) return Response.json({ error: "kitshn has no Cloudflare token." }, { status: 503 });
      return this.takeAddress(
        caller,
        decodeURIComponent(path.slice("/api/cards/".length, -"/take-address".length)),
        api,
      );
    }
    if (path.startsWith("/api/cards/") && path.endsWith("/progress/dismiss") && request.method === "POST")
      return this.dismissProgress(
        caller,
        decodeURIComponent(path.slice("/api/cards/".length, -"/progress/dismiss".length)),
      );
    if (path.startsWith("/api/cards/") && path.endsWith("/give-address-back") && request.method === "POST") {
      const api = this.api();
      if (!api) return Response.json({ error: "kitshn has no Cloudflare token." }, { status: 503 });
      return this.giveAddressBack(
        caller,
        decodeURIComponent(path.slice("/api/cards/".length, -"/give-address-back".length)),
        api,
      );
    }
    if (path.startsWith("/api/machines/") && path.includes("/providers/") && path.endsWith("/forget")) {
      const [machineId = "", name = ""] = path
        .slice("/api/machines/".length, -"/forget".length)
        .split("/providers/")
        .map(decodeURIComponent);
      if (request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
        return this.forgetProvider(caller, machineId, name, card);
      }
    }
    if (path.startsWith("/api/machines/") && path.endsWith("/rotate-key") && request.method === "POST")
      return this.rotateFromPanel(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length, -"/rotate-key".length)),
      );
    if (path.startsWith("/api/machines/") && path.endsWith("/reset-key") && request.method === "POST")
      return this.resetKey(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length, -"/reset-key".length)),
      );
    if (path.startsWith("/api/machines/") && request.method === "POST")
      return this.updateMachine(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length)),
        await request.json().catch(() => null),
      );
    if (path.startsWith("/api/machines/") && request.method === "DELETE")
      return this.removeMachine(caller, decodeURIComponent(path.slice("/api/machines/".length)));
    if (path.startsWith("/api/worker-storage/") && request.method === "DELETE")
      return await this.deleteOrphanWorker(
        caller,
        decodeURIComponent(path.slice("/api/worker-storage/".length)),
      );
    if (path.startsWith("/api/apps/") && path.endsWith("/logs") && request.method === "POST")
      return await this.logsResponse(
        decodeURIComponent(path.slice("/api/apps/".length, -"/logs".length)),
        await request.json().catch(() => null),
      );
    if (path === "/api/state/export" && request.method === "GET") return this.exportResponse();
    if (path.startsWith("/api/apps/") && path.includes("/backups")) {
      const [card = "", , run = "", action = ""] = path
        .slice("/api/apps/".length)
        .split("/")
        .map(decodeURIComponent);
      if (run === "" && request.method === "GET") return this.backupList(card);
      if (run === "" && request.method === "POST") return this.backUpNow(caller.actor, card);
      if (action === "restore" && request.method === "POST")
        return this.restoreBackup(caller.actor, card, run);
    }
    if (path.startsWith("/api/apps/") && path.endsWith("/rollbacks") && request.method === "GET")
      return this.rollbackChoicesResponse(
        decodeURIComponent(path.slice("/api/apps/".length, -"/rollbacks".length)),
      );
    if (path.startsWith("/api/apps/") && path.endsWith("/rollback") && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { deployId?: unknown } | null;
      return await this.rollbackResponse(
        caller,
        decodeURIComponent(path.slice("/api/apps/".length, -"/rollback".length)),
        String(body?.deployId ?? ""),
      );
    }
    if (path.startsWith("/api/apps/") && path.endsWith("/run-rollback")) {
      const card = decodeURIComponent(path.slice("/api/apps/".length, -"/run-rollback".length));
      if (request.method === "GET") return this.runRollbackPlanResponse(card);
      if (request.method === "POST") return await this.runRollback(caller, card);
    }
    if (path.startsWith("/api/apps/") && request.method === "DELETE")
      return this.removeApp(caller, decodeURIComponent(path.slice("/api/apps/".length)));
    if (path === "/api/repos/check" && request.method === "POST") return await this.checkReposOnGitHub();
    // K-1770 to K-1774: the passes of Settings: on or off, the audiences, and "Rotate pass key".
    if (path === "/api/passes" && request.method === "GET") return Response.json(this.passSettings());
    if (path === "/api/passes" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body["on"] !== "boolean")
        return Response.json({ error: 'Send {"on": true | false}.' }, { status: 400 });
      const on = body["on"];
      // K-1504: while paused, access only goes down.
      if (on && this.state.paused)
        return Response.json(
          { error: "kitshn is paused, so passes stay off until Resume (K-1504)." },
          { status: 409 },
        );
      this.ctx.storage.transactionSync(() => {
        this.setMeta("passes_on", on ? "1" : "0");
        this.insertRevision(caller.actor, on ? "Turned on passes" : "Turned off passes", [], null);
      });
      this.broadcast();
      return Response.json(this.passSettings());
    }
    if (path === "/api/passes/rotate" && request.method === "POST") {
      await this.rotatePassKey(caller.actor);
      this.broadcast();
      return Response.json(this.passSettings());
    }
    if (path === "/api/passes/audiences" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const address = isRecord(body) && typeof body["address"] === "string" ? body["address"].trim() : "";
      // An audience that exists already changes only whether its passes carry labels.
      if (this.sql("SELECT 1 AS one FROM pass_audiences WHERE address = ?", address).length > 0) {
        const labels = isRecord(body) && body["labels"] === true;
        this.ctx.storage.transactionSync(() => {
          this.sql("UPDATE pass_audiences SET labels = ? WHERE address = ?", labels ? 1 : 0, address);
          this.insertRevision(
            caller.actor,
            `${labels ? "Put" : "Took"} labels ${labels ? "in" : "out of"} the passes for ${address}`,
            [],
            null,
          );
        });
        return Response.json(this.passSettings());
      }
      const added = this.addAudience(
        address,
        { machineId: null, name: "the owner" },
        isRecord(body) && body["labels"] === true,
      );
      if (added.outcome !== "done")
        return Response.json({ error: added.outcome === "refused" ? added.reason : "No." }, { status: 400 });
      return Response.json(this.passSettings());
    }
    if (path.startsWith("/api/passes/audiences/") && request.method === "DELETE") {
      const address = decodeURIComponent(path.slice("/api/passes/audiences/".length));
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM pass_audiences WHERE address = ?", address);
        this.insertRevision(caller.actor, `Removed the pass audience ${address}`, [], null);
      });
      this.broadcast();
      return Response.json(this.passSettings());
    }
    // K-1767: the owner's Deploy of a pull request of the kitshn App approves its run's commit and runs it again.
    if (path === "/api/bot-runs/deploy" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const repoId = isRecord(body) && typeof body["repoId"] === "string" ? body["repoId"] : "";
      const pr = isRecord(body) && typeof body["pr"] === "number" ? body["pr"] : -1;
      const sha = isRecord(body) && typeof body["sha"] === "string" ? body["sha"] : "";
      const [run] = this.sql<{ run_id: string; repo: string }>(
        "SELECT run_id, repo FROM bot_runs WHERE repo_id = ? AND pr = ? AND sha = ?",
        repoId,
        pr,
        sha,
      );
      if (!run) return Response.json({ error: "kitshn knows no such waiting run." }, { status: 404 });
      if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY)
        return Response.json({ error: NO_GITHUB_APP }, { status: 503 });
      this.ctx.storage.transactionSync(() => {
        this.sql(
          "UPDATE bot_runs SET approved = 1 WHERE repo_id = ? AND pr = ? AND sha = ?",
          repoId,
          pr,
          sha,
        );
        this.insertRevision(
          caller.actor,
          `Deployed pull request #${pr} of ${run.repo} (${sha.slice(0, 7)})`,
          [],
          null,
        );
      });
      try {
        await rerunWorkflowRun(
          { id: this.env.GITHUB_APP_ID, key: this.env.GITHUB_APP_KEY },
          repoId,
          run.run_id,
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 502 },
        );
      }
      this.broadcast();
      return Response.json({ deployed: pr });
    }
    // K-1756: History searches the ask events by one label.
    if (path === "/api/ask-events" && request.method === "GET") {
      const label = new URL(request.url).searchParams.get("label") ?? "";
      const equals = label.indexOf("=");
      if (equals <= 0) return Response.json({ error: "Send ?label=key=value." }, { status: 400 });
      return Response.json({
        events: this.askEventsWithLabel(label.slice(0, equals), label.slice(equals + 1), null),
      });
    }
    // K-1733, K-1760: repo groups and the default GitHub way.
    if (path === "/api/repo-groups" && request.method === "POST")
      return this.addRepoGroup(caller, await request.json().catch(() => null));
    if (path.startsWith("/api/repo-groups/") && (request.method === "POST" || request.method === "DELETE"))
      return this.changeRepoGroup(
        caller,
        decodeURIComponent(path.slice("/api/repo-groups/".length)),
        request.method === "DELETE" ? null : await request.json().catch(() => null),
      );
    if (path === "/api/settings/github-way" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const way = isRecord(body) ? body["githubWay"] : null;
      if (way !== "app" && way !== "not-kitshn")
        return Response.json({ error: 'Send {"githubWay": "app" | "not-kitshn"}.' }, { status: 400 });
      this.ctx.storage.transactionSync(() => {
        this.setMeta("github_default_way", way);
        this.insertRevision(
          caller.actor,
          `Set the default GitHub way to ${way === "app" ? "kitshn App token" : "not kitshn"}`,
          [],
          null,
        );
      });
      this.broadcast();
      return Response.json({ githubWay: way });
    }
    if (path.startsWith("/api/repos/") && request.method === "POST")
      return await this.setRepoState(
        caller,
        decodeURIComponent(path.slice("/api/repos/".length)),
        await request.json().catch(() => null),
      );
    if (path.startsWith("/api/jobs/") && path.endsWith("/cancel") && request.method === "POST") {
      const error = this.cancelJob(
        Number(path.slice("/api/jobs/".length, -"/cancel".length)),
        { caller },
        caller.actor,
      );
      return error === null ? Response.json({ ok: true }) : Response.json({ error }, { status: 409 });
    }
    if (path === "/api/jobs" && request.method === "POST")
      return this.addJob(caller, await request.json().catch(() => null));
    if (path === "/api/sites/live" && request.method === "POST")
      return this.addLiveSite(caller, await request.json().catch(() => null));
    if (path === "/api/jobs" && request.method === "GET") return Response.json(this.recentJobs(100));
    if (path === "/api/devices" && request.method === "GET") return this.listDevices();
    if (path === "/api/usage" && request.method === "GET") return await this.readUsage();
    if (path === "/api/library" && request.method === "GET") return Response.json(this.libraryItems());
    // Section 20: game cards and their doors (K-2001, K-2006).
    if (path === "/api/games" && request.method === "GET")
      return Response.json(this.gameRows().map((row) => this.gameView(row, Date.now())));
    if (path === "/api/games" && request.method === "POST")
      return this.createGame(caller.actor, await request.json().catch(() => null));
    if (path.startsWith("/api/games/") && request.method === "DELETE") {
      const [card = "", doors, address] = path.slice("/api/games/".length).split("/");
      if (doors === undefined) return this.deleteGame(caller.actor, card);
      if (doors === "doors" && address)
        return this.closeDoorBy(caller.actor, card, decodeURIComponent(address));
    }
    if (path.startsWith("/api/uptime/") && request.method === "GET")
      return Response.json(this.uptimeChanges(decodeURIComponent(path.slice("/api/uptime/".length))));
    if (path.startsWith("/api/notifications")) return this.notificationRequest(path, request, caller);
    if (path === "/api/push" || path.startsWith("/api/push/")) return this.pushRequest(path, request, caller);
    if ((path === "/api/pages" || path === "/api/files") && request.method === "POST")
      return this.upload(caller, request, path === "/api/pages" ? "page" : "file").catch((error: unknown) => {
        if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      });
    if (path.startsWith("/api/library/") && path.endsWith("/content") && request.method === "GET")
      return this.preview(path.slice("/api/library/".length, -"/content".length));
    if (path.startsWith("/api/library/") && request.method === "DELETE")
      return this.deleteItem(caller, path.slice("/api/library/".length));
    // K-1129: the owner uploads a folder as a folder site, through kitshn, because the browser cannot reach Cloudflare.
    if (path.startsWith("/api/sites/") && request.method === "POST")
      return this.ownerSite(caller, path.slice("/api/sites/".length), request);
    // K-1128: an address that only redirects to the card's main address.
    if (path.startsWith("/api/cards/") && path.includes("/redirects")) {
      const [card = "", rest = ""] = path.slice("/api/cards/".length).split("/redirects");
      if (request.method === "POST" && rest === "")
        return this.addRedirect(caller, card, await addressBody(request), false);
      if (request.method === "DELETE" && rest.startsWith("/"))
        return this.removeRedirect(caller, card, decodeURIComponent(rest.slice(1)), false);
    }
    if (path.startsWith("/api/cards/") && path.endsWith("/time") && request.method === "POST")
      return this.cardTime(
        caller,
        decodeURIComponent(path.slice("/api/cards/".length, -"/time".length)),
        await request.json().catch(() => null),
        false,
      );
    if (path.startsWith("/api/cards/") && path.endsWith("/address") && request.method === "POST")
      return this.setAddress(
        caller,
        path.slice("/api/cards/".length, -"/address".length),
        await addressBody(request),
        false,
      );
    if (path.startsWith("/api/library/") && path.endsWith("/previous") && request.method === "POST")
      return this.restorePrevious(caller, path.slice("/api/library/".length, -"/previous".length), "owner");
    if (path === "/api/devices" && request.method === "POST")
      return this.addDevice(await request.json().catch(() => null));
    if (path === "/api/devices/invites" || path.startsWith("/api/devices/invites/"))
      return this.inviteRequest(path, request, caller);
    if (path === "/api/undo-item" && request.method === "GET") {
      // K-1507: the menu asks before it offers the per-item undo; the same rule over the whole History.
      const query = new URL(request.url).searchParams;
      const kind = query.get("kind");
      const id = query.get("id");
      if ((kind !== "card" && kind !== "circle") || !id)
        return Response.json(
          { error: "Name the item with kind=card or kind=circle and an id." },
          { status: 400 },
        );
      return Response.json(
        undoAnswer(this.state, this.storedRevisions(), caller.actor, { item: { kind, id } }, Date.now()),
      );
    }
    if (path === "/api/undo" && request.method === "GET") {
      // K-1508: History asks once for the caller's newest row, by the same checks as the undo.
      const revision = Number(new URL(request.url).searchParams.get("revision"));
      if (!Number.isSafeInteger(revision) || revision <= 0)
        return Response.json({ error: "Name the revision with revision=<id>." }, { status: 400 });
      return Response.json(
        undoAnswer(this.state, this.storedRevisions(), caller.actor, { revision }, Date.now()),
      );
    }
    const type = API_MESSAGES[path];
    if (type !== undefined) {
      if (request.method !== "POST") return new Response("Use POST.", { status: 405 });
      let message: ClientMessage;
      try {
        message = decodeClientMessage({
          ...((await request.json()) as object),
          type,
          requestId: "http",
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      const result = await this.handle(caller, message, "http");
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    return new Response("Not found.", { status: 404 });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const attachment = attachmentOf(socket);
    if (attachment === null) return;
    if (attachment.kind === "machine") {
      await this.machineMessage(
        socket,
        attachment,
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      return;
    }
    const caller = attachment.caller;
    if (!this.authorized(caller)) {
      socket.close(4003, "You lost access to the kitshn admin.");
      return;
    }
    let message: ClientMessage;
    try {
      const parsed: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (isRecord(parsed) && (parsed.type === "tail" || parsed.type === "tailStop"))
        return await this.tailMessage(socket, decodeTailMessage(parsed));
      message = decodeClientMessage(parsed);
    } catch (error) {
      socket.close(4000, `kitshn cannot read the message: ${String(error).slice(0, 100)}`);
      return;
    }
    try {
      send(socket, await this.handle(caller, message, "socket"));
    } catch (error) {
      // Every request gets an answer, so a map never waits forever on an edit it shows (held.ts).
      console.error(`kitshn could not handle a ${message.type} request: ${String(error)}`);
      send(socket, {
        type: "result",
        requestId: message.requestId,
        ok: false,
        error: "kitshn could not save this change. Try again.",
      });
    }
  }

  override async webSocketClose(socket: WebSocket) {
    this.socketGone(socket);
  }

  override async webSocketError(socket: WebSocket) {
    this.socketGone(socket);
  }

  private socketGone(socket: WebSocket) {
    const attachment = attachmentOf(socket);
    if (attachment?.kind === "map") {
      for (const tail of attachment.tails ?? []) void this.stopTail(tail);
      return;
    }
    if (attachment?.kind !== "machine") return;
    // A socket that never passed its check (K-1704) never made the machine online.
    if (attachment.check === "waiting") return;
    // K-1805: the daemon stops the tails of a closed connection.
    this.endTails(
      (tail) => tail.kind === "compose" && tail.machineId === attachment.machineId,
      "The machine's connection closed (K-1805).",
    );
    const others = this.checkedSockets(attachment.machineId).filter((other) => other !== socket);
    if (others.length > 0) return;
    // K-722: a run ends with the connection of either machine.
    this.endExecRuns(attachment.machineId);
    // A job that the machine had when its connection ended has no result coming.
    requeueDowns(this.query, attachment.machineId);
    const failed = this.sql<{ id: number }>(
      `UPDATE jobs SET state = 'failed', output = '${OFFLINE_OUTPUT}' WHERE machine_id = ? AND state = 'sent' RETURNING id`,
      attachment.machineId,
    );
    this.jobsEnded(failed.map((row) => row.id));
    this.setPresence(attachment.machineId, false);
  }

  /** K-605: presence rows change only when a machine goes online or offline (K-1302). */
  private setPresence(machineId: string, online: boolean) {
    const now = Date.now();
    const before = this.presence.get(machineId);
    if (before?.online === online) return;
    const os = before?.os ?? null;
    this.presence.set(machineId, { online, lastSeen: now, os });
    this.sql(
      "INSERT OR REPLACE INTO presence (id, online, last_seen, os) VALUES (?, ?, ?, ?)",
      machineId,
      online ? 1 : 0,
      now,
      os,
    );
    this.broadcast();
    // K-1108: a machine that goes off or comes back changes the offline routes of its live sites.
    void this.scheduleAlarm();
  }

  /** Machines with an open socket. Presence rows can be stale after a deploy; sockets are not. */
  private onlineMachines() {
    return new Set([...this.state.machines.keys()].filter((id) => this.openSocket(id) !== null));
  }

  /** K-1708: only a machine that signed its connection gets jobs; one without a key reports status only. */
  private jobMachines() {
    return new Set(
      [...this.state.machines.keys()].filter((id) => {
        const socket = this.openSocket(id);
        const attachment = socket ? attachmentOf(socket) : null;
        return attachment?.kind === "machine" && attachment.check === "signed";
      }),
    );
  }

  /** K-524: the system of a machine; its presence row changes only when the system does (K-1302). */
  private setMachineOs(machineId: string, os: MachineOs | null) {
    const presence = this.presence.get(machineId);
    if (!presence) throw new Error(`kitshn read a status of ${machineId} before the machine was online.`);
    if (presence.os === os) return;
    this.presence.set(machineId, { ...presence, os });
    this.sql("UPDATE presence SET os = ? WHERE id = ?", os, machineId);
  }

  /** After a restart, a presence row says online although its socket is gone; set it offline once. */
  private reconcilePresence() {
    for (const [id, value] of this.presence)
      if (value.online && this.openSocket(id) === null) this.setPresence(id, false);
    // K-909: a restart closed every socket without a close event, so no stop stays sent forever.
    for (const id of this.state.machines.keys())
      if (this.openSocket(id) === null) requeueDowns(this.query, id);
  }

  /**
   * K-604, K-1704: a daemon connects with its machine's service token; the Worker checked the Access JWT. The
   * socket then waits for the answer to its challenge. A machine without a key counts on its token alone (K-1708).
   */
  private connectMachine(request: Request, caller: Caller) {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    const machine = [...this.state.machines.values()].find(
      (item) => item.clientId === caller.visitor.clientId,
    );
    if (!machine)
      return Response.json({ error: "This service token belongs to no joined machine." }, { status: 403 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    const start = socketStart(machine.key);
    if (start.kind === "waitsForKey") {
      // Not hibernatable and without tags, so no reader of machine sockets ever sees it. A close code, not a
      // 403, so the daemon waits long instead of trying every minute (K-1706).
      server.accept();
      server.close(KEY_RESET, "This machine has no key. Run the command of Reset key on it.");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [machine.id, "machines"]);
    const challenge = newChallenge();
    const attachment = {
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge,
      check: start.kind === "token" ? "token" : "waiting",
      answered: false,
      rotateBy: null,
      status: null,
      sample: null,
    } satisfies Attachment;
    saveMachine(server, attachment);
    const fingerprint = start.kind === "challenge" ? start.fingerprint : null;
    send(server, { type: "challenge", challenge, fingerprint } satisfies ServerToDaemon);
    if (attachment.check === "token") this.acceptMachine(server, attachment);
    else void this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The socket passed its check (K-1704), or counts on its token (K-1708): it replaces older sockets. */
  private acceptMachine(socket: WebSocket, attachment: Extract<Attachment, { kind: "machine" }>) {
    const machine = this.state.machines.get(attachment.machineId);
    if (!machine) throw new Error(`kitshn accepted a socket of the unknown machine ${attachment.machineId}.`);
    for (const old of this.ctx.getWebSockets(machine.id))
      if (old !== socket) old.close(4001, "A newer connection of this machine replaced it.");
    saveMachine(socket, attachment);
    if (attachment.check === "signed") {
      this.keyFailures.delete(machine.id);
      if (machine.key?.kind !== "public") throw new Error(`${machine.name} signed without a key.`);
      send(socket, { type: "accepted", fingerprint: machine.key.fingerprint } satisfies ServerToDaemon);
      // K-704: the daemon gives this name in its answer to register.
      send(socket, { type: "name", name: machine.name } satisfies ServerToDaemon);
      // K-706: a new connection gets every grant table again, from the registrations that kitshn keeps.
      for (const key of this.sentGrants.keys())
        if (key.startsWith(`${machine.id}/`)) this.sentGrants.delete(key);
      this.pushGrants();
      this.sendForgotten(machine.id);
    }
    // K-909: after a fast reconnect the old socket's close finds this one and requeues nothing, and a removal
    // down never expires, so its result that may never come must not keep it sent.
    requeueDowns(this.query, machine.id);
    // The jobs go first, so the map update below counts them as sent (K-515). Delivery reads sockets, not presence.
    const sent = this.deliverJobs();
    if (!this.presence.get(machine.id)?.online) this.setPresence(machine.id, true);
    else if (sent > 0) this.broadcast();
    else this.sendMachine(machine);
    void this.scheduleAlarm();
  }

  /** K-1704, K-1708: a failed check closes the socket, and the panel shows why. */
  private refuseSocket(socket: WebSocket, machine: Machine, reason: string) {
    console.warn(`kitshn refused a connection of ${machine.name}: ${reason}`);
    this.keyFailures.set(machine.id, { at: Date.now(), reason });
    // Its close event runs socketGone, so the machine goes offline once.
    socket.close(4003, reason.slice(0, 120));
    this.sendMachine(machine);
  }

  /** K-1704: checks the one answer of a socket against the stored key. */
  private async answerChallenge(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    machine: Machine,
    message: Record<string, unknown>,
  ) {
    const plan = answerCheck(machine.key, attachment);
    if (plan.kind === "refuse") return this.refuseSocket(socket, machine, plan.reason);
    saveMachine(socket, { ...attachment, answered: true });
    const valid = await verifyForHosts(
      plan.publicKey,
      adminHosts(this.env),
      (host) => connectText(host, machine.id, attachment.challenge),
      message["signature"],
    );
    // The socket can close and the key can change during the check: a rotation, a reset or a removal.
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = this.state.machines.get(machine.id);
    if (!now || !deepEqual(now.key, machine.key))
      return this.refuseSocket(socket, machine, "The key of this machine changed during the check.");
    if (!valid)
      return this.refuseSocket(
        socket,
        machine,
        `The answer does not carry a signature of ${plan.fingerprint}.`,
      );
    this.acceptMachine(socket, { ...attachment, answered: true, check: "signed" });
  }

  /**
   * K-1705: the daemon hands over to a new key with a signature of the old one, bound to this socket. kitshn
   * stores the new key and closes the machine's sockets, so only the new key connects from then on.
   */
  private async rotateKey(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    machine: Machine,
    message: Record<string, unknown>,
  ) {
    if (machine.key?.kind !== "public")
      return this.refuseSocket(socket, machine, "A machine without a key gets one on its next connection.");
    const publicKey = parsePublicKey(message["publicKey"]);
    if (publicKey === null)
      return this.refuseSocket(socket, machine, "The rotation has no valid public key.");
    const key = await this.publicKey(publicKey);
    const valid = await verifyForHosts(
      machine.key.publicKey,
      adminHosts(this.env),
      (host) => rotateText(host, machine.id, attachment.challenge, publicKey),
      message["signature"],
    );
    const now = this.state.machines.get(machine.id);
    if (!now || !deepEqual(now.key, machine.key))
      return this.refuseSocket(socket, machine, "The key of this machine changed during the rotation.");
    if (!valid)
      return this.refuseSocket(
        socket,
        machine,
        `The rotation does not carry a signature of ${machine.key.fingerprint}.`,
      );
    this.setKey(
      machine,
      key,
      attachment.rotateBy ?? deviceActor(machine),
      `Rotated the key of ${machine.name} from ${machine.key.fingerprint} to ${key.fingerprint}`,
    );
    for (const old of this.ctx.getWebSockets(machine.id)) old.close(ROTATED, "key rotated");
    this.denyOpenProposals(machine.id, "the key of the machine rotated");
  }

  private async publicKey(publicKey: string): Promise<Extract<MachineKey, { kind: "public" }>> {
    return { kind: "public", publicKey, fingerprint: await fingerprintOf(publicKey), since: Date.now() };
  }

  /**
   * K-1702: the one place that changes the key of a machine; each change is a History revision. `also` runs in
   * the same transaction.
   */
  private setKey(machine: Machine, key: MachineKey, actor: Actor, summary: string, also = () => {}) {
    const updated: Machine = { ...machine, key };
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE machines SET body = ? WHERE id = ?", JSON.stringify(updated), machine.id);
      this.insertRevision(actor, summary, [], null);
      also();
    });
    this.load();
    this.broadcast();
  }

  private async machineMessage(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    text: string,
  ) {
    const machine = this.state.machines.get(attachment.machineId);
    if (!machine) return;
    let message: DaemonMessage | null;
    try {
      message = JSON.parse(text) as DaemonMessage;
    } catch {
      message = null;
    }
    if (isRecord(message) && message.type === "answer")
      return this.answerChallenge(socket, attachment, machine, message);
    // K-1704: until the check passes, kitshn reads nothing else from the socket.
    if (attachment.check === "waiting")
      return this.refuseSocket(
        socket,
        machine,
        "The daemon sent a message before it answered the challenge.",
      );
    if (!isRecord(message)) return;
    // K-1708: a connection on the token alone only reports; it changes no site, volume or job.
    if (attachment.check === "token" && message.type !== "status" && message.type !== "sample") return;
    if (message.type === "rotate") return this.rotateKey(socket, attachment, machine, message);
    // K-1710: an ask of a local agent, only on a signed connection.
    if (message.type === "ask" && attachment.check === "signed")
      return this.answerAsk(socket, machine, message);
    if (message.type === "status" && isRecord(message.status)) {
      const status: MachineStatus = {
        version: String(message.status.version).slice(0, 40),
        os: String(message.status.os).slice(0, 80),
        arch: String(message.status.arch).slice(0, 20),
        hostname: String(message.status.hostname).slice(0, 80),
        capabilities: Array.isArray(message.status.capabilities)
          ? message.status.capabilities
              .filter((item): item is string => typeof item === "string")
              .slice(0, 20)
          : [],
        tunnel: ["starting", "running", "stopped"].includes(String(message.status.tunnel))
          ? message.status.tunnel
          : "stopped",
        ...(typeof message.status.keptBytes === "number" &&
        Number.isSafeInteger(message.status.keptBytes) &&
        message.status.keptBytes >= 0
          ? { keptBytes: message.status.keptBytes }
          : {}),
        ...gameStatus(message.status),
        // K-1708: a connection on the token alone opens no notification.
        ...(attachment.check === "signed"
          ? {
              refusedProviders: providerRefusals(message.status.refusedProviders),
              // The same shape as a refusal: the provider, since when, and why.
              offlineProviders: providerRefusals(message.status.offlineProviders),
              providerProblems: providerRefusals(message.status.providerProblems),
              execPaths: execPathsOf(message.status.execPaths),
              ...(typeof message.status.siteGuardSocket === "string" &&
              message.status.siteGuardSocket.startsWith("/") &&
              message.status.siteGuardSocket.length <= 200 &&
              !/[\r\n\0]/.test(message.status.siteGuardSocket)
                ? { siteGuardSocket: message.status.siteGuardSocket }
                : {}),
            }
          : {}),
      };
      saveMachine(socket, { ...attachment, status });
      // A supporting daemon gets its first site reach only after it reports the capability.
      if (attachment.check === "signed") {
        let fresh = false;
        for (const [capability, key] of [
          [SITE_LINKS_CAPABILITY, SITE_REACH_KEY],
          [SITE_GUARD_CAPABILITY, SITE_GUARD_KEY],
        ] as const) {
          if (
            !status.capabilities?.includes(capability) ||
            attachment.status?.capabilities?.includes(capability)
          )
            continue;
          // These grants live only for this connection, so an acknowledgement from the previous one is stale.
          if (this.applied.delete(`${machine.id}/${key}`))
            this.sql("DELETE FROM applied_state WHERE machine_id = ? AND key = ?", machine.id, key);
          fresh = true;
        }
        if (fresh) this.pushGrants();
      }
      if (status.refusedProviders) this.notifyRefusals(machine, status.refusedProviders);
      if (status.offlineProviders) this.notifyOfflineProviders(machine, status.offlineProviders, Date.now());
      // K-627: a daemon that connects, or that runs another release now, can start or end an update.
      if (attachment.status === null || attachment.status.version !== status.version) this.autoUpdate();
      this.updateGameAddresses(machine.id, status.publicAddresses);
      // K-2005: a daemon that connects gets its door plan, also an empty one: the last card may have gone while it was
      // offline for longer than a plan job waits, and only an empty plan removes its table and its boot ports.
      if (attachment.status === null && status.capabilities?.includes("doors"))
        this.queueDoors(machine.id, { _tag: "kitshn", reason: "door plan on connect (K-2005)" }, Date.now());
      this.setMachineOs(machine.id, machineOs(status.os));
      // An update job waits for the status; it can go now.
      if (this.deliverJobs() > 0) this.broadcast();
      else this.sendMachine(machine);
    } else if (message.type === "sample" && isRecord(message.sample)) {
      const share = (value: unknown) => (typeof value === "number" && value >= 0 && value <= 1 ? value : 0);
      const sample: Sample = {
        at: Date.now(),
        cpu: share(message.sample.cpu),
        memory: share(message.sample.memory),
        disk: share(message.sample.disk),
      };
      saveMachine(socket, { ...attachment, sample });
      this.sendMachine(machine);
      // K-1107: the sample woke the Durable Object anyway, so it checks the pings of every machine now.
      this.checkLiveness(Date.now());
    } else if (message.type === "sites") {
      this.updateLiveSites(machine, message.sites);
    } else if (message.type === "providers") {
      this.updateProviders(machine, message.providers);
    } else if (message.type === "cancelJob" && typeof message.requestId === "string") {
      const error = this.cancelJob(
        message.jobId,
        { machine },
        { _tag: "machine", machineId: machine.id, name: machine.name },
      );
      send(socket, {
        type: "requestAnswer",
        requestId: message.requestId.slice(0, 64),
        error,
      } satisfies ServerToDaemon);
    } else if (message.type === "health" && attachment.check === "signed") {
      let report: HealthReport;
      try {
        // kitshn's own clock, so a machine clock that is off never makes a report look old.
        report = { ...decodeHealth(message.report), at: Date.now() };
      } catch (error) {
        console.error(`kitshn refused the health report of ${machine.name}: ${String(error)}`);
        return;
      }
      saveMachine(socket, { ...attachment, health: report });
      this.notifyHealth(machine, report);
      // K-631: "Check now" ends with this report.
      if (this.progressRows().get(machine.id)?.source._tag === "health")
        this.moveAction(machine.id, (progress) =>
          progress.outcome.state === "running" ? finishProgress(progress, Date.now()) : progress,
        );
      this.broadcast();
    } else if (message.type === "execStart" && attachment.check === "signed") {
      await this.execStart(socket, machine, message);
    } else if (message.type === "linkCall" && attachment.check === "signed") {
      this.recordLinkCall(machine, message);
    } else if (message.type === "execFrame" && attachment.check === "signed") {
      this.execRelay(socket, machine, message);
    } else if (message.type === "desiredSet" && typeof message.kind === "string") {
      // K-709: the provider gets kitshn's own answer, also a refusal.
      // A failed write is an answer too, so the provider never waits for one that does not come.
      let error: string | null;
      try {
        error = this.setDesiredFromMachine(machine, message);
      } catch (thrown) {
        console.error(`kitshn could not store the desired state of ${machine.name}: ${String(thrown)}`);
        error = `kitshn could not store the state: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
      }
      if (typeof message.requestId === "string")
        send(socket, {
          type: "requestAnswer",
          requestId: message.requestId.slice(0, 64),
          error,
        } satisfies ServerToDaemon);
    } else if (
      message.type === "applied" &&
      typeof message.key === "string" &&
      typeof message.hash === "string"
    ) {
      // K-1608: written only when it changes, so a machine that applied everything writes nothing, and only for a key
      // that kitshn pushes to it now, so a daemon cannot fill the table.
      const id = `${machine.id}/${message.key}`;
      const known = this.hashesOf(machine.id).has(message.key);
      if (known && this.applied.get(id) !== message.hash) {
        this.sql(
          "INSERT OR REPLACE INTO applied_state (machine_id, key, hash) VALUES (?, ?, ?)",
          machine.id,
          message.key.slice(0, 200),
          message.hash.slice(0, 64),
        );
        this.applied.set(id, message.hash);
        this.sendMachine(machine);
        // K-411: a taken address waits for this push, so its next step runs now, not at the next cycle.
        if (this.sitesOf(machine.id).some((site) => site.state === "handover")) await this.scheduleAlarm();
      }
    } else if (message.type === "icon") {
      await this.liveIcon(machine, message.site, message.icon);
    } else if (message.type === "servers") {
      saveMachine(socket, { ...attachment, servers: serversOf(message.servers) });
      this.sendMachine(machine);
    } else if (message.type === "volumes" && Array.isArray(message.volumes)) {
      const volumes = message.volumes
        .filter(
          (item) => isRecord(item) && typeof item["name"] === "string" && typeof item["project"] === "string",
        )
        .slice(0, 200)
        .map((item): ProjectVolume => ({
          name: item.name.slice(0, 255),
          project: item.project.slice(0, 63),
        }));
      saveMachine(socket, { ...attachment, volumes });
      this.sendMachine(machine);
    } else if (message.type === "logs" && typeof message.id === "string") {
      this.logSearches.get(message.id)?.(logAnswerOf(message.answer));
    } else if (message.type === "tailLines" && typeof message.id === "string") {
      const lines = logLinesOf(message.lines, TAIL_BATCH);
      const skipped = typeof message.skipped === "number" ? message.skipped : 0;
      const owner = this.tailOwner(message.id, machine.id);
      if (owner) {
        send(owner, { type: "tailLines", tail: message.id, lines, skipped });
        // After an eviction, the first batch starts the timer again.
        this.keepAwakeForTails();
      }
      // A tail that no map holds stops, so a lost stop costs no more messages.
      else send(socket, { type: "tailStop", id: message.id } satisfies ServerToDaemon);
    } else if (message.type === "tailEnd" && typeof message.id === "string") {
      const reason = typeof message.reason === "string" ? message.reason.slice(0, 500) : "The tail stopped.";
      this.endTails(
        (tail) => tail.id === message.id && tail.kind === "compose" && tail.machineId === machine.id,
        reason,
      );
    } else if (message.type === "jobResult" && typeof message.id === "number" && isRecord(message.result)) {
      const result = message.result;
      this.sql(
        // A job failed only because the connection dropped still takes its real result.
        `UPDATE jobs SET state = ?, exit_code = ?, output = ? WHERE id = ? AND machine_id = ?
         AND (state = 'sent' OR (state = 'failed' AND output = '${OFFLINE_OUTPUT}'))`,
        result.ok === true ? "done" : "failed",
        typeof result.exitCode === "number" ? result.exitCode : null,
        // The end of the output holds the error of a failed build.
        String(result.output ?? "").slice(-OUTPUT_LIMIT),
        message.id,
        attachment.machineId,
      );
      // Only a result that this machine's job took counts; a stray or late one changes no deploy.
      const [{ taken } = { taken: 0 }] = this.sql<{ taken: number }>("SELECT changes() AS taken");
      if (taken) this.jobsEnded([message.id]);
      // K-1131: the asker of a wizard site counts only when its job made the site.
      const asker = taken ? this.siteAskers.get(message.id) : undefined;
      if (asker && result.ok === true) asker.done = true;
      else if (asker) {
        this.siteAskers.delete(message.id);
        if (asker.circle !== null)
          this.notifyNotShared(
            asker.siteId,
            attachment.machineId,
            asker.circle,
            "The machine refused the job; its output is in the machine panel.",
          );
      }
      // K-812: the source and params of a Compose deploy live only as long as its job.
      const [job] = taken
        ? this.sql<{ command: string; actor: string }>(
            "SELECT command, actor FROM jobs WHERE id = ?",
            message.id,
          )
        : [];
      const command = job ? (JSON.parse(job.command) as Command) : null;
      // K-1908: a Compose job that came up keeps its notify token; a failed one drops it.
      if (
        command?.kind === "compose" ||
        command?.kind === "compose-redeploy" ||
        command?.kind === "compose-rollback"
      )
        this.settleNotifyToken(`job:${message.id}`, result.ok === true);
      // K-909: undo never brings a deleted volume back, so History records the delete as an action once it ran.
      if (job && command?.kind === "compose-volume-remove" && result.ok === true) {
        this.insertRevision(
          JSON.parse(job.actor) as Actor,
          `Deleted the volume ${command.volume} on ${machine.name} (K-909)`,
          [],
          null,
        );
        this.load();
      }
      if (command?.kind === "compose" || command?.kind === "compose-rollback") {
        // K-820: a build that came up clears the give-up note of the CLI; a failed one keeps the machine's error.
        const error = jobError(String(result.output ?? ""));
        this.sql(
          "UPDATE deploys SET state = ?, reason = ?, images = ? WHERE job_id = ? AND state = 'running'",
          result.ok === true ? "done" : "failed",
          result.ok === true ? null : error,
          result.ok === true ? keptImages(result["images"]) : null,
          message.id,
        );
        if (command.kind === "compose-rollback" && command.group)
          this.continueRollback(command.group, result.ok === true ? null : error);
        // K-817: a failed build gives up the DNS record that its plan made.
        if (result.ok !== true) void this.scheduleAlarm();
      }
      // K-628: History shows each update of a daemon, and the next automatic update can go.
      if (job && command?.kind === "update") {
        this.insertRevision(
          JSON.parse(job.actor) as Actor,
          result.ok === true
            ? `Updated the daemon of ${machine.name} to edge-${command.version} (K-628)`
            : `The daemon of ${machine.name} did not update to edge-${command.version}: ${
                String(result.output ?? "")
                  .trim()
                  .split("\n")
                  .at(-1)
                  ?.slice(0, 200) ?? ""
              } (K-628)`,
          [],
          null,
        );
        this.load();
        this.autoUpdate();
      }
      if (job && (command?.kind === "backup" || command?.kind === "backup-restore"))
        this.backupResult(command, JSON.parse(job.actor) as Actor, result);
      if (command?.kind === "compose" && this.env.BUCKET) {
        void this.env.BUCKET.delete([
          deployObject(command.deployId, "source.tgz"),
          deployObject(command.deployId, "params.env"),
        ]);
      }
      this.broadcast();
    }
  }

  /** K-602: a new machine gets a service token, a tunnel and a one-time join code. */
  private async addMachine(caller: Caller, body: unknown, origin: string) {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof input["name"] === "string" ? input["name"].trim() : "";
    if (!name || name.length > 60)
      return Response.json({ error: "Give the machine a name of 1 to 60 characters." }, { status: 400 });
    const labels = parseLabels(input["labels"] ?? []);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const id = machineIdFor(name);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    let token: { id: string; client_id: string; client_secret: string } | null = null;
    let tunnel: { id: string } | null = null;
    try {
      const madeToken = await api<{ id: string; client_id: string; client_secret: string }>(
        "POST",
        `${account}/access/service_tokens`,
        { name: `kitshn machine ${id}`, duration: "forever" },
      );
      token = madeToken;
      const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      const madeTunnel = await api<{ id: string }>("POST", `${account}/cfd_tunnel`, {
        name: `kitshn ${id}`,
        config_src: "cloudflare",
        tunnel_secret: secret,
      });
      tunnel = madeTunnel;
      const tunnelToken = await api<string>("GET", `${account}/cfd_tunnel/${madeTunnel.id}/token`);
      const machine: Machine = {
        id,
        name,
        labels,
        order: Math.max(0, ...[...this.state.machines.values()].map((item) => item.order + 1)),
        serviceTokenId: madeToken.id,
        joinedAt: Date.now(),
        clientId: madeToken.client_id,
        tunnelId: madeTunnel.id,
        // K-1703: the key comes with the join code, so this machine never connects without one.
        key: { kind: "waiting", since: Date.now() },
      };
      const code = newJoinCode();
      const box = await sealJoin(code, {
        server: origin,
        machineId: id,
        clientId: madeToken.client_id,
        clientSecret: madeToken.client_secret,
        tunnelToken,
      });
      const expiresAt = Date.now() + JOIN_CODE_MS;
      const lookup = await joinLookup(code);
      const resource: Resource = {
        id,
        kind: "machine",
        name,
        addresses: [],
        status: "unknown",
        group: null,
        machine: id,
      };
      this.ctx.storage.transactionSync(() => {
        this.sql("INSERT INTO machines (id, body) VALUES (?, ?)", id, JSON.stringify(machine));
        this.putResource(resource);
        this.sql(
          "INSERT INTO join_codes (lookup, machine_id, iv, sealed, expires_at) VALUES (?, ?, ?, ?, ?)",
          lookup,
          id,
          box.iv,
          box.sealed,
          expiresAt,
        );
        this.insertRevision(caller.actor, `Added machine ${name}`, [], null);
      });
      this.load();
      this.broadcast();
      void this.scheduleAlarm();
      return Response.json({
        machineId: id,
        code,
        expiresAt,
        command: `curl -fsSL ${origin}/join | sh -s -- ${code} ${origin}`,
        // K-625: the same join in Windows PowerShell.
        windowsCommand: `& ([scriptblock]::Create((irm ${origin}/join/windows.ps1))) ${code} ${origin}`,
      });
    } catch (error) {
      // Leave nothing half made behind.
      if (tunnel) await api("DELETE", `${account}/cfd_tunnel/${tunnel.id}`).catch(() => undefined);
      if (token) await api("DELETE", `${account}/access/service_tokens/${token.id}`).catch(() => undefined);
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /**
   * K-602: trades a join code, once and within 10 minutes, for the sealed machine secrets. K-1703: it stores the
   * public half of the machine key in the same step.
   */
  private async exchangeJoin(request: Request) {
    const body = (await request.json().catch(() => null)) as { code?: unknown; publicKey?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) return Response.json({ error: "Send the join code." }, { status: 400 });
    // Before the code is used, so the join works again with a daemon of this kitshn.
    const publicKey = parsePublicKey(body?.publicKey);
    if (publicKey === null)
      return Response.json(
        { error: "This daemon sends no machine key. Run the join command of this kitshn again (K-1703)." },
        { status: 400 },
      );
    const key = await this.publicKey(publicKey);
    const lookup = await joinLookup(code);
    const [row] = this.sql<{ machine_id: string; iv: string; sealed: string; expires_at: number }>(
      "SELECT machine_id, iv, sealed, expires_at FROM join_codes WHERE lookup = ?",
      lookup,
    );
    if (!row)
      return Response.json(
        { error: "This join code is not valid, or someone used it already." },
        { status: 404 },
      );
    const machine = this.state.machines.get(row.machine_id);
    const used = () => this.sql("DELETE FROM join_codes WHERE lookup = ?", lookup);
    if (row.expires_at < Date.now() || !machine) {
      used();
      return Response.json(
        {
          error: machine
            ? "This join code expired. Make a new one with Add machine."
            : "The machine of this join code is gone.",
        },
        { status: machine ? 410 : 404 },
      );
    }
    // K-1703: the key and the use of the code are one step.
    this.setKey(
      machine,
      key,
      deviceActor(machine),
      `${machine.name} joined with the key ${key.fingerprint}`,
      used,
    );
    return Response.json({ iv: row.iv, sealed: row.sealed });
  }

  /** K-1706: trades a rekey code, once and within 10 minutes, for a new key of a machine that waits for one. */
  private async rekey(request: Request) {
    const body = (await request.json().catch(() => null)) as {
      code?: unknown;
      publicKey?: unknown;
      machineId?: unknown;
    } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const publicKey = parsePublicKey(body?.publicKey);
    const machineId = typeof body?.machineId === "string" ? body.machineId : "";
    if (!code || publicKey === null || !machineId)
      return Response.json(
        { error: "Send the rekey code, the machine id and the public key." },
        { status: 400 },
      );
    const key = await this.publicKey(publicKey);
    const lookup = await joinLookup(code);
    const [row] = this.sql<{ machine_id: string; expires_at: number }>(
      "SELECT machine_id, expires_at FROM rekey_codes WHERE lookup = ?",
      lookup,
    );
    if (!row)
      return Response.json(
        { error: "This rekey code is not valid, or someone used it already." },
        { status: 404 },
      );
    const machine = this.state.machines.get(row.machine_id);
    const used = () => this.sql("DELETE FROM rekey_codes WHERE lookup = ?", lookup);
    const decision = rekeyDecision(
      { machineId: row.machine_id, expiresAt: row.expires_at },
      machineId,
      machine,
      Date.now(),
    );
    if (decision.kind === "refuse") {
      if (!decision.keepCode) used();
      return Response.json({ error: decision.reason }, { status: decision.status });
    }
    if (!machine) throw new Error(`rekeyDecision stored a key for the unknown machine ${row.machine_id}.`);
    // The key and the use of the code are one step, so a failed write keeps the code.
    this.setKey(
      machine,
      key,
      deviceActor(machine),
      `${machine.name} got the key ${key.fingerprint} with a rekey code`,
      used,
    );
    // K-1708: a connection on the token alone ends; the daemon connects again and signs.
    for (const socket of this.ctx.getWebSockets(machine.id))
      socket.close(4001, "This machine has a key now; connect again and sign.");
    return Response.json({ machineId: machine.id, fingerprint: key.fingerprint });
  }

  /** K-1705: "Rotate key" in the panel asks the connected daemon; it hands over to a new key itself. */
  private rotateFromPanel(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    if (machine.key?.kind !== "public")
      return Response.json(
        { error: `${machine.name} has no key to rotate. Update its daemon, or use Reset key.` },
        { status: 409 },
      );
    const socket = this.openSocket(id);
    const attachment = socket ? attachmentOf(socket) : null;
    if (!socket || attachment?.kind !== "machine" || attachment.check !== "signed")
      return Response.json({ error: `${machine.name} is offline. Use Reset key instead.` }, { status: 409 });
    saveMachine(socket, { ...attachment, rotateBy: caller.actor });
    send(socket, { type: "rotateKey" } satisfies ServerToDaemon);
    return Response.json({ rotating: id });
  }

  /**
   * K-1706: forgets the key at once and closes the machine's sockets. The machine waits for a new key from
   * `kitshn rekey <code>`; until then it cannot connect.
   */
  private async resetKey(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    const code = newJoinCode();
    const lookup = await joinLookup(code);
    const expiresAt = Date.now() + JOIN_CODE_MS;
    const newCode = () => {
      this.sql("DELETE FROM rekey_codes WHERE machine_id = ?", id);
      this.sql(
        "INSERT INTO rekey_codes (lookup, machine_id, expires_at) VALUES (?, ?, ?)",
        lookup,
        id,
        expiresAt,
      );
    };
    const answer = Response.json({ machineId: id, code, expiresAt, command: `kitshn rekey ${code}` });
    // K-1708: a machine without a key keeps its status connection until its first key arrives.
    if (machine.key === undefined) {
      this.ctx.storage.transactionSync(() => {
        newCode();
        this.insertRevision(caller.actor, `Made a key code for ${machine.name}`, [], null);
      });
      this.broadcast();
      return answer;
    }
    const old = machine.key.kind === "public" ? ` ${machine.key.fingerprint}` : "";
    this.setKey(
      machine,
      { kind: "waiting", since: Date.now() },
      caller.actor,
      `Reset the key${old} of ${machine.name}`,
      newCode,
    );
    for (const socket of this.ctx.getWebSockets(id))
      socket.close(KEY_RESET, "The owner reset the key of this machine.");
    this.denyOpenProposals(machine.id, "the owner reset the key of the machine");
    return answer;
  }

  /** K-615: removes the service token, the tunnel and the queue of a machine. */
  private async removeMachine(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const socket of this.ctx.getWebSockets(id)) socket.close(4002, "The owner removed this machine.");
    this.denyOpenProposals(id, "the owner removed the machine");
    const notFound = (error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error);
    try {
      await api("DELETE", `${account}/access/service_tokens/${machine.serviceTokenId}`).catch(notFound);
      await api("DELETE", `${account}/cfd_tunnel/${machine.tunnelId}/connections`).catch(notFound);
      await api("DELETE", `${account}/cfd_tunnel/${machine.tunnelId}`).catch(notFound);
    } catch (error) {
      return Response.json(
        { error: `kitshn could not remove the machine in Cloudflare: ${String(error)}` },
        { status: 502 },
      );
    }
    const relaysLeft = new Set<string>();
    this.ctx.storage.transactionSync(() => {
      for (const table of ["machines", "presence"]) this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
      const forgotten = [this.forgetCard(id)];
      this.sql("DELETE FROM jobs WHERE machine_id = ? AND state IN ('queued', 'sent')", id);
      this.sql("DELETE FROM join_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM rekey_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM tunnel_objects WHERE machine_id = ?", id);
      for (const site of this.sitesOf(id)) {
        this.sql("DELETE FROM live_sites WHERE id = ?", site.id);
        this.setHandover(site.id, null);
        forgotten.push(this.forgetCard(site.id));
      }
      // K-615, K-704: the providers of the machine and their cards go with it, and its desired state part and what it
      // applied (K-709, K-1608).
      this.sql("DELETE FROM providers WHERE machine_id = ?", id);
      this.sql("DELETE FROM desired_state WHERE machine_id = ?", id);
      this.sql("DELETE FROM applied_state WHERE machine_id = ?", id);
      for (const card of this.state.resources.values())
        if (card.machine === id && card.provider && !this.sitesOf(id).some((site) => site.id === card.id))
          forgotten.push(this.forgetCard(card.id));
      // K-2001: the game cards of the machine, or that it relays, go too, with their doors; the alarm removes their
      // records, so no name keeps pointing at an address that the provider may give to someone else.
      for (const row of this.gameRows("machine_id = ? OR relay_id = ?", id, id)) {
        this.sql("DELETE FROM games WHERE card_id = ?", row.card_id);
        this.sql("DELETE FROM doors WHERE card_id = ?", row.card_id);
        forgotten.push(this.forgetCard(row.card_id));
        const other = doorMachine(gameOf(row));
        if (other !== id) relaysLeft.add(other);
      }
      const key = machine.key?.kind === "public" ? ` and its key ${machine.key.fingerprint}` : "";
      this.insertRevision(caller.actor, `Removed machine ${machine.name}${key}`, forgotten, null);
    });
    this.presence.delete(id);
    this.keyFailures.delete(id);
    this.load();
    // A relay machine that stays drops the ports of the removed machine's games.
    for (const relay of relaysLeft) this.queueDoors(relay, caller.actor, Date.now());
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: id });
  }

  /**
   * K-614, K-718: a sender with the admin needs control on the machine card; any other sender is an agent key
   * and needs the card in its agent circles, checked again when the job goes out.
   */
  /** K-614: a sender without the admin is an agent, and a machine is one whatever its circles. */
  private isAgentSender(visitor: Visitor) {
    return machineOf(this.state, visitor) !== undefined || !this.hasAdmin(visitor);
  }

  /** K-1776: why an approved job may no longer go out, because the machine that asked lost its access; or null. */
  private approvalGone(approval: OwnerApproval, now: number) {
    const asker = this.state.machines.get(approval.machineId);
    if (!asker) return `${NO_LONGER_ALLOWED} the machine that asked is gone.`;
    if (keyMark(asker) !== approval.key)
      return `${NO_LONGER_ALLOWED} the key of the machine that asked changed.`;
    return machineRightOff(this.state, asker.id, approval.right, now)
      ? `${NO_LONGER_ALLOWED} the owner set the right "${MACHINE_RIGHT_NAMES[approval.right]}" to off.`
      : null;
  }

  /** K-622: why an agent may not update this daemon now, or null. The status is unknown while it is offline. */
  private agentUpdateRefusal(machineId: string) {
    const status = this.liveStatus(machineId);
    return status && !restartsAfterUpdate(status)
      ? noRestartAfterUpdate(this.state.machines.get(machineId)?.name ?? machineId)
      : null;
  }

  private mayRunOn(visitor: Visitor, machineId: string, kind: Command["kind"]) {
    return this.hasAdmin(visitor)
      ? this.canControl(visitor, machineId)
      : agentMayCommand(this.state, visitor, machineId, kind, Date.now());
  }

  /**
   * K-707: the command for the daemon, with the provider's own id of the card, or why kitshn refuses it. The card is
   * a card of that provider on the machine; with none, the command is one of the machine card.
   */
  private providerCommand(
    machine: Machine | null,
    parsed: Extract<Command, { kind: "provider" }>,
  ): Extract<Command, { kind: "provider" }> | string {
    if (!machine) return "A provider command runs on one machine.";
    const card =
      parsed.resource === null
        ? this.state.resources.get(machine.id)
        : this.state.resources.get(parsed.resource);
    if (!card || (card.provider ? card.machine !== machine.id : card.id !== machine.id))
      return `${parsed.resource ?? machine.id} is not a card of ${machine.name}.`;
    const fits = commandsFor(this.providerRegs.get(machine.id) ?? [], card).some(
      (item) => item.provider === parsed.provider && item.command.id === parsed.command,
    );
    if (!fits)
      return `The provider ${parsed.provider} of ${machine.name} has no command ${parsed.command} for ${card.name}.`;
    // K-1625: a row command names a row of a list of the card that offers this command.
    if (
      parsed.row !== undefined &&
      !card.provider?.lists.some((list) =>
        list.rows.some((row) => row.id === parsed.row && (row.commands ?? []).includes(parsed.command)),
      )
    )
      return `${card.name} has no row ${parsed.row} with the command ${parsed.command}.`;
    return { ...parsed, resource: card.provider?.localId ?? null };
  }

  /** K-1623: the Access applications of the account, as Cloudflare lists them. */
  private accessApps(api: Api) {
    return api<ReadonlyArray<AccessAppListing>>(
      "GET",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/apps?per_page=1000`,
    );
  }

  /**
   * K-1623: the owner moves the address of a provider site, which something else serves now, to kitshn. kitshn keeps
   * the one proxied CNAME record of the address, makes its application, then its ingress, and changes the record
   * only after that (`dnsWork`), so the address always has an application and a route. The path applications of the
   * portal keep their own paths (`tunnelConfig`).
   */
  private async takeAddress(caller: Caller, id: string, api: Api) {
    if (!this.isOwner(caller.visitor))
      return Response.json({ error: "Only the owner takes an address over." }, { status: 403 });
    const refused = () => {
      const card = this.state.resources.get(id);
      const site = this.liveSites.get(id);
      return card?.provider && site?.state === "refused" ? { card, site } : null;
    };
    const before = refused();
    if (!before)
      return Response.json(
        { error: "Only a provider card whose address is in use takes it over." },
        { status: 409 },
      );
    // K-1623: kitshn's application answers on the host as soon as it exists, so T3 must get its audience first.
    const socket = this.openSocket(before.site.machineId);
    const attachment = socket ? attachmentOf(socket) : null;
    if (attachment?.kind !== "machine" || !attachment.status?.capabilities?.includes("access"))
      return Response.json(
        {
          error:
            "The machine must be online, with a kitshn daemon that passes Access audiences on (K-1623). Update kitshn there, and T3 to a version with fork #415, then try again.",
        },
        { status: 409 },
      );
    const address = before.site.address;
    let records: Array<{
      id: string;
      type: string;
      content: string;
      proxied: boolean;
      comment?: string | null;
    }>;
    let domains: Array<unknown>;
    let apps: ReadonlyArray<AccessAppListing>;
    try {
      records = await api("GET", `${this.zonePath(address)}/dns_records?name=${encodeURIComponent(address)}`);
      domains = await api(
        "GET",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      apps = await this.accessApps(api);
    } catch (error) {
      return Response.json(
        { error: `kitshn could not read ${address} from Cloudflare: ${String(error)}` },
        { status: 502 },
      );
    }
    const [record] = records;
    if (records.length !== 1 || record?.type !== "CNAME" || !record.proxied || domains.length > 0)
      return Response.json(
        {
          error: `kitshn takes over only an address with one proxied CNAME record and no Worker; ${address} has ${records.length} records and ${domains.length} Workers.`,
        },
        { status: 409 },
      );
    // The reads waited; the card or its site may have changed meanwhile.
    const now = refused();
    if (!now || now.site.address !== address)
      return Response.json(
        { error: "The card or its address changed meanwhile. Try again." },
        { status: 409 },
      );
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE live_sites SET state = 'handover' WHERE id = ?", id);
      this.setHandover(id, {
        recordId: record.id,
        content: record.content,
        comment: record.comment ?? null,
        ingressAt: null,
        switched: false,
        paths: foreignPaths(apps, address),
        pathsAt: Date.now(),
        released: false,
        returning: false,
      });
      this.putResource(withAddressInUse({ ...now.card, addresses: [address] }, false));
      this.insertRevision(caller.actor, `Took over ${address} for ${now.card.name}`, [], null);
      this.startAction(id, { _tag: "takeover" }, "Take the address", TAKE_ADDRESS_STEPS);
    });
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({});
  }

  /**
   * K-1623: the owner gives a taken address back: its record serves what it served before, and kitshn lets go. Only
   * while the portal still holds the exact host, so the host never stays without an application.
   */
  private async giveAddressBack(caller: Caller, id: string, api: Api) {
    if (!this.isOwner(caller.visitor))
      return Response.json({ error: "Only the owner gives an address back." }, { status: 403 });
    const card = this.state.resources.get(id);
    const site = this.liveSites.get(id);
    const handover = this.handoverOf(id);
    if (!card?.provider || !site || !handover || handover.released)
      return Response.json({ error: "kitshn took over no address of this card." }, { status: 409 });
    try {
      if (!foreignHolds(await this.accessApps(api), site.address)) {
        // After the record moved, the portal let go for good, so the action goes; before, the move goes on.
        if (handover.switched) {
          this.setHandover(id, { ...handover, released: true });
          this.broadcast();
        }
        return Response.json(
          { error: `The portal no longer holds ${site.address}, so kitshn keeps it.` },
          { status: 409 },
        );
      }
    } catch (error) {
      return Response.json(
        { error: `kitshn could not give ${site.address} back: ${String(error)}. Try again.` },
        { status: 502 },
      );
    }
    // K-538: the steps run in this request, and the card shows each one as it goes.
    this.startAction(id, { _tag: "give-back" }, "Give the address back", [
      ...(handover.switched
        ? [
            { label: "Tell T3 that kitshn stops serving the address", expectedMs: 500 },
            { label: "Point the DNS record back", expectedMs: 1_500 },
          ]
        : []),
      { label: "Take the address off the card", expectedMs: 500 },
    ]);
    const fail = (error: string, status: number) => {
      this.moveAction(id, (progress) => failProgress(progress, error, Date.now()));
      this.broadcast();
      return Response.json({ error }, { status });
    };
    if (handover.switched) {
      // The provider learns first that kitshn no longer serves the host, so it can start its own route again.
      this.setHandover(id, { ...handover, returning: true });
      this.pushGrants();
      this.moveAction(id, (progress) => reachStep(progress, 1, Date.now()));
      this.broadcast();
      try {
        await api("PUT", `${this.zonePath(site.address)}/dns_records/${handover.recordId}`, {
          type: "CNAME",
          name: site.address,
          content: handover.content,
          proxied: true,
          comment: handover.comment ?? "",
        });
      } catch (error) {
        const current = this.handoverOf(id);
        if (current) this.setHandover(id, { ...current, returning: false });
        return fail(`kitshn could not give ${site.address} back: ${String(error)}. Try again.`, 502);
      }
    }
    this.ctx.storage.transactionSync(() => {
      // The record goes back to what it served; kitshn forgets it and never deletes it.
      this.sql("DELETE FROM dns_objects WHERE address = ?", site.address);
      this.sql("UPDATE live_sites SET state = 'refused' WHERE id = ?", id);
      this.setHandover(id, null);
      this.putResource(withAddressInUse({ ...card, addresses: [] }, true));
      this.insertRevision(caller.actor, `Gave ${site.address} back from ${card.name}`, [], null);
      this.moveAction(id, (progress) => finishProgress(progress, Date.now()));
    });
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({});
  }

  /** K-538: a failed action stays on its card until someone with control dismisses it. */
  private dismissProgress(caller: Caller, id: string) {
    if (!this.canControl(caller.visitor, id))
      return Response.json({ error: "Dismiss needs control on the card." }, { status: 403 });
    if (this.progressRows().get(id)?.progress.outcome.state !== "failed")
      return Response.json({ error: "This card has no failed action." }, { status: 409 });
    this.setProgress(id, null);
    this.broadcast();
    return Response.json({});
  }

  /** K-1623: reads the portal's path applications of each taken address again, at most every `FOREIGN_PATHS_MS`. */
  private async refreshForeignPaths(api: Api, now: number) {
    const due = [...this.liveSites.values()].flatMap((site) => {
      const handover = this.handoverOf(site.id);
      return handover && handover.pathsAt + FOREIGN_PATHS_MS <= now ? [{ site, handover }] : [];
    });
    if (due.length === 0) return 0;
    try {
      const apps = await this.accessApps(api);
      let released = false;
      for (const { site, handover } of due) {
        const done = handover.released || (handover.switched && !foreignHolds(apps, site.address));
        released ||= done !== handover.released;
        this.setHandover(site.id, {
          ...handover,
          paths: foreignPaths(apps, site.address),
          pathsAt: now,
          released: done,
        });
      }
      if (released) this.broadcast();
    } catch (error) {
      console.warn(`kitshn could not read the Access applications of taken addresses: ${String(error)}`);
    }
    return 1;
  }

  /**
   * K-704: "Forget provider" removes the cards of a provider that does not run, with their shares, as one revision
   * with Undo, and its registration. A running provider would bring its cards back at once, so kitshn refuses it.
   */
  private forgetProvider(caller: Caller, machineId: string, name: string, card: string | null) {
    const machine = this.state.machines.get(machineId);
    if (!machine) return Response.json({ error: `No machine "${machineId}" exists.` }, { status: 404 });
    if (!this.canControl(caller.visitor, machineId))
      return Response.json({ error: "Forgetting a provider needs control on its machine." }, { status: 403 });
    // The status that the daemon last reported: an offline machine whose daemon still has the provider brings it back.
    const running = [...this.state.resources.values()].some(
      (card) => card.machine === machineId && card.provider?.name === name && card.status !== "offline",
    );
    // K-705: one card that its provider dropped can go while the provider runs.
    const dropped = card !== null && this.state.resources.get(card)?.provider?.droppedAt !== undefined;
    if (card !== null && !dropped)
      return Response.json({ error: "Only a card that its provider dropped can go alone." }, { status: 409 });
    if (running && !dropped)
      return Response.json(
        {
          error: `${name} runs on ${machine.name}. Stop it, or run kitshn provider forget ${name} on the machine, then forget it here.`,
        },
        { status: 409 },
      );
    try {
      const revision = this.commit(
        caller.actor,
        forgetProviderChanges(this.state, machineId, name, card),
        null,
      );
      // Undo brings the cards back offline; the provider's next report brings its commands back.
      if (card === null) {
        this.sql("DELETE FROM providers WHERE machine_id = ? AND name = ?", machineId, name);
        // The daemon keeps the provider in providers.json; it hears of the forget now, or on its next connection.
        this.sql(
          "INSERT OR REPLACE INTO forgotten_providers (machine_id, name) VALUES (?, ?)",
          machineId,
          name,
        );
        this.sendForgotten(machineId);
      }
      this.load();
      this.broadcast();
      void this.scheduleAlarm();
      return Response.json({ revision });
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  }

  /** K-704: tells a signed connection of the machine about each provider that the owner forgot. */
  private sendForgotten(machineId: string) {
    const socket = this.ctx.getWebSockets(machineId).find((item) => {
      const attachment = attachmentOf(item);
      return attachment?.kind === "machine" && attachment.check === "signed";
    });
    if (!socket) return;
    for (const { name } of this.sql<{ name: string }>(
      "SELECT name FROM forgotten_providers WHERE machine_id = ?",
      machineId,
    ))
      send(socket, { type: "forgetProvider", provider: name } satisfies ServerToDaemon);
  }

  /**
   * K-1601, K-1617: the machines that a device reaches: each provider card with an address that its token opens, with
   * its machine. The shape of the portal's `/client/machines`, plus the card, its kind and the level.
   */
  private deviceMachines(visitor: Visitor) {
    const now = Date.now();
    return {
      machines: [...this.state.resources.values()].flatMap((card) => {
        const address = card.addresses[0];
        const machine = card.machine === null ? undefined : this.state.machines.get(card.machine);
        if (!card.provider || !address || !machine) return [];
        const level = visitorLevel(this.state, card, visitor, now);
        return level === null
          ? []
          : [
              {
                id: machine.id,
                name: machine.name,
                origin: `https://${address}`,
                card: card.id,
                kind: card.kind,
                level: levelName(card, level),
              },
            ];
      }),
    };
  }

  /**
   * K-1612, K-613: cancels a job while it waits in the queue, or says why not. A machine cancels only its own jobs: one
   * that runs on it, or one that it queued. The map needs control on the job's machine. History records the cancel.
   */
  private cancelJob(
    id: number,
    who: { readonly machine: Machine } | { readonly caller: Caller },
    actor: Actor,
  ): string | null {
    const [job] = Number.isSafeInteger(id)
      ? this.sql<{ machine_id: string | null; state: string; actor: string }>(
          "SELECT machine_id, state, actor FROM jobs WHERE id = ?",
          id,
        )
      : [];
    if (!job) return `No job ${id} exists.`;
    if ("machine" in who) {
      // A local user cancels only what its machine queued; a job that someone else queued needs control, on the map.
      const queuedBy = JSON.parse(job.actor) as Actor;
      if (queuedBy._tag !== "machine" || queuedBy.machineId !== who.machine.id)
        return `Job ${id} was not queued by ${who.machine.name}; cancel it on the map, with control on its machine (K-1612).`;
    } else if (job.machine_id !== null && !this.canControl(who.caller.visitor, job.machine_id))
      return "Cancelling a job needs control on its machine.";
    if (job.state !== "queued") return `Job ${id} is ${job.state}, so it cannot be cancelled.`;
    const name = actorName(actor);
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "UPDATE jobs SET state = 'failed', output = ? WHERE id = ? AND state = 'queued'",
        `Cancelled by ${name}.`,
        id,
      );
      this.insertRevision(actor, `Cancelled job #${id}`, [], null);
      this.endStep(id);
    });
    this.load();
    this.broadcast();
    return null;
  }

  /** K-614: the sender of a command needs control on the machine card itself, not only on the admin. */
  /**
   * K-631: "Check now": each online machine that the caller controls checks its providers and links at once, with the
   * progress sticker of K-538 on its card until its report comes.
   */
  private async checkHealthNow(caller: Caller) {
    const now = Date.now();
    const checking: Array<string> = [];
    const skipped: Array<{ readonly machine: string; readonly reason: string }> = [];
    for (const machine of this.state.machines.values()) {
      if (!this.canControl(caller.visitor, machine.id)) continue;
      const socket = this.openSocket(machine.id);
      const attachment = socket ? attachmentOf(socket) : null;
      if (!socket || attachment?.kind !== "machine" || attachment.check !== "signed") {
        skipped.push({ machine: machine.name, reason: "offline or without a key" });
        continue;
      }
      if (!attachment.status?.capabilities?.includes("health")) {
        skipped.push({ machine: machine.name, reason: "its daemon has no health check; update it" });
        continue;
      }
      send(socket, { type: "checkHealth" } satisfies ServerToDaemon);
      this.startAction(
        machine.id,
        { _tag: "health", until: now + HEALTH_CHECK_WAIT_MS },
        "Check now",
        HEALTH_CHECK_STEPS,
        now,
      );
      checking.push(machine.name);
    }
    this.broadcast();
    await this.scheduleAlarm();
    return Response.json({ checking, skipped });
  }

  private canControl(visitor: Visitor, machineId: string) {
    const resource = this.state.resources.get(machineId);
    if (!resource) return false;
    // K-1504, MM-711: the owner keeps the commands they had; the pause takes no tool from them and gives none.
    const state = this.state.paused && this.hasAdmin(visitor) ? { ...this.state, paused: null } : this.state;
    return visitorLevel(state, resource, visitor, Date.now()) === "control";
  }

  /** K-610 to K-614: a job runs on one machine, or on the first online machine with its labels. */
  /**
   * K-1131: shares a server of a machine as a new live site, for the site wizard. It only makes a site: a name whose
   * address a card or a live site has already is refused here, and `kitshn expose --new` refuses a name that the
   * machine shares already, also when two owners add at once. The end time waits for the card with the caller.
   */
  private async addLiveSite(caller: Caller, body: unknown): Promise<Response> {
    const input = isRecord(body) ? body : {};
    const machineId = typeof input["machineId"] === "string" ? input["machineId"] : "";
    const name = typeof input["name"] === "string" ? input["name"] : "";
    const endsAt = input["endsAt"];
    const server = parseSiteInput(typeof input["server"] === "string" ? input["server"] : "");
    const target =
      server.kind === "port" ? String(server.port) : server.kind === "socket" ? server.path : null;
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    if (target === null)
      return fail(
        400,
        server.kind === "invalid"
          ? server.reason
          : "kitshn shares servers of joined machines. Name a port of one, such as 5173.",
      );
    if (!LIVE_LABEL.test(name)) return fail(400, "A name has 1 to 40 lowercase letters, digits and dashes.");
    if (
      RESERVED_SITE_NAMES.has(name) ||
      reservedSiteLinkHost(`${name}.${this.env.KITSHN_ZONE}`, this.env.KITSHN_ZONE)
    )
      return fail(400, `${name} belongs to kitshn itself. Pick another name.`);
    if (endsAt !== null && endsAt !== undefined && !(typeof endsAt === "number" && endsAt > Date.now()))
      return fail(400, "The end time must be in the future, or null for no end.");
    const circle = typeof input["circle"] === "string" ? input["circle"] : null;
    if (circle !== null && !this.state.circles.has(circle))
      return fail(400, "That circle is gone. Pick another.");
    const address = `${name}.${this.env.KITSHN_ZONE}`;
    const card = [...this.state.resources.values()].find((resource) => resource.addresses.includes(address));
    const site = [...this.liveSites.values()].find((each) => each.address === address);
    if (card || site)
      return fail(
        409,
        `${address} is ${card ? `the card ${card.name}` : "a site of another machine"} already. Pick another name; a card's own panel changes that card.`,
      );
    // An older daemon has no $KITSHN; the join script installs the binary in ~/.local/bin.
    // The end time goes with the job, so the site report carries it, as for `kitshn expose --time` (K-212).
    const script = `"\${KITSHN:-$HOME/.local/bin/kitshn}" expose '${target}' --name '${name}' --new${input["dev"] === true ? " --dev" : ""}${typeof endsAt === "number" ? ` --ends-at ${Math.round(endsAt)}` : ""}`;
    const queued = this.addJob(caller, { machineId, command: { kind: "shell", script } });
    const { id } = (await queued.clone().json()) as { id?: number | null };
    if (queued.ok && typeof id === "number" && (typeof endsAt === "number" || circle !== null))
      this.siteAskers.set(id, { siteId: liveSiteId(machineId, name), by: caller.actor, circle, done: false });
    return queued;
  }

  private addJob(caller: Caller, body: unknown, ownerApproved: OwnerApproval | null = null) {
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const parsed = parseCommand(input["command"]);
    if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
    if (parsed.kind === "update" && !isRelease(this.env.KITSHN_VERSION)) {
      return Response.json(
        {
          error: `This kitshn runs the build "${this.env.KITSHN_VERSION}", which has no release to update to.`,
        },
        { status: 409 },
      );
    }
    const labels = parseLabels(input["labels"] ?? []);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const machineId = typeof input["machineId"] === "string" ? input["machineId"] : null;
    const target = machineId === null ? null : this.state.machines.get(machineId);
    if (machineId !== null && !target) {
      return Response.json({ error: `No machine "${machineId}" exists.` }, { status: 404 });
    }
    // K-909: only a volume that the machine reports as orphaned, with the project from that report.
    const orphan =
      parsed.kind === "compose-volume-remove"
        ? (target ? this.machineView(target).orphanVolumes : []).find(
            (volume) => volume.name === parsed.volume,
          )
        : undefined;
    if (parsed.kind === "compose-volume-remove" && !orphan)
      return Response.json(
        { error: `${parsed.volume} is not an orphaned volume of this machine (K-909).` },
        { status: 409 },
      );
    // K-707: a provider command names a command that a provider of this machine has for that card.
    const providerCommand = parsed.kind === "provider" ? this.providerCommand(target ?? null, parsed) : null;
    if (typeof providerCommand === "string")
      return Response.json({ error: providerCommand }, { status: 409 });
    const command: Command =
      parsed.kind === "update"
        ? { kind: "update", version: this.env.KITSHN_VERSION }
        : parsed.kind === "compose-volume-remove" && orphan
          ? { ...parsed, project: orphan.project }
          : (providerCommand ?? parsed);
    if (machineId !== null && !ownerApproved && !this.canControl(caller.visitor, machineId)) {
      return Response.json(
        {
          error:
            "Commands need the control level on the machine. Put its card in a circle that gives you control.",
        },
        { status: 403 },
      );
    }
    if (machineId === null && labels.length === 0) {
      return Response.json({ error: "A job needs a machine or labels." }, { status: 400 });
    }
    const now = Date.now();
    const [row] = this.ctx.storage.transactionSync(() => {
      const inserted = this.sql<{ id: number }>(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, when_idle)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, NULL, '', ?) RETURNING id`,
        machineId,
        JSON.stringify(labels),
        JSON.stringify(command),
        now,
        // K-613: an approval covers what its person saw, for a short time. Limit: a private card that lands within this
        // hour is still in reach of the job. Revisit if owners need longer, then fail the job when the cards changed.
        now + (ownerApproved ? DEPLOY_MS : JOB_EXPIRY_MS),
        JSON.stringify(caller.actor),
        JSON.stringify(ownerApproved ? { ...caller.visitor, ownerApproved } : caller.visitor),
        // K-613: "when online and idle" waits until no provider of the machine reports busy (K-1608).
        input["whenIdle"] === true ? 1 : 0,
      );
      // K-614: the history names the member that sent a shell command.
      if (command.kind === "shell") {
        const where = target ? target.name : `a machine with ${labels.join(", ")}`;
        this.insertRevision(caller.actor, `Ran on ${where}: ${command.script.slice(0, 80)}`, [], null);
      }
      return inserted;
    });
    if (command.kind === "shell") this.load();
    // K-627: "Update daemon" replaces a queued automatic update of the machine, and becomes the step of a machine that
    // holds or stopped the rollout, so its success ends that.
    if (command.kind === "update" && machineId !== null && typeof row?.id === "number") {
      this.sql(
        `UPDATE jobs SET state = 'failed', output = ? WHERE machine_id = ? AND state = 'queued' AND id != ?
         AND json_extract(command, '$.kind') = 'update' AND json_extract(visitor, '$.kitshn') = 1`,
        `${actorName(caller.actor)} sent Update daemon, so kitshn dropped this automatic update.`,
        machineId,
        row.id,
      );
      // K-627: only a person ends a stopped rollout; an agent's job may only take the place of a step that waits.
      if (!this.isAgentSender(caller.visitor) || this.rollout().step !== null)
        this.saveRollout(manualStep(this.rollout(), machineId, row.id));
      this.autoUpdate();
    }
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ id: row?.id ?? null });
  }

  /**
   * Sends each queued job to its machine when that machine is online (K-613 "when online"). A label job
   * goes to the first fitting machine in the order on which its sender has control (K-610, K-614).
   */
  /** Returns the number of jobs sent. A caller that does not broadcast anyway broadcasts when it is over 0 (K-515). */
  private deliverJobs(): number {
    let sent = 0;
    const online = this.jobMachines();
    const queued = this.sql<{
      id: number;
      machine_id: string | null;
      labels: string;
      command: string;
      visitor: string;
      when_idle: number;
    }>(
      "SELECT id, machine_id, labels, command, visitor, when_idle FROM jobs WHERE state = 'queued' AND expires_at > ? ORDER BY id",
      Date.now(),
    );
    for (const job of queued) {
      const visitor = JSON.parse(job.visitor) as Visitor & {
        readonly kitshn?: true;
        readonly ownerApproved?: OwnerApproval | null;
      };
      const queuedCommand = JSON.parse(job.command) as Command;
      // K-1776: an approval holds only while the machine that asked keeps its access.
      const gone = visitor.ownerApproved ? this.approvalGone(visitor.ownerApproved, Date.now()) : null;
      if (gone !== null) {
        this.sql("UPDATE jobs SET state = 'failed', output = ? WHERE id = ?", gone, job.id);
        this.endStep(job.id);
        continue;
      }
      // K-627: an automatic update waits while kitshn is paused, and goes when the owner turned the setting off.
      const automatic = visitor.kitshn === true && queuedCommand.kind === "update";
      if (
        automatic &&
        job.machine_id !== null &&
        this.state.machines.get(job.machine_id)?.autoUpdate === false
      ) {
        this.sql(
          "UPDATE jobs SET state = 'failed', output = ? WHERE id = ?",
          "Update daemon automatically is off on this machine, so kitshn dropped this update (K-626).",
          job.id,
        );
        this.endStep(job.id);
        continue;
      }
      if (automatic && this.state.paused) continue;
      // K-627: a daemon that runs the release already needs no automatic update; the step ends as done.
      const running = automatic && job.machine_id !== null ? this.liveStatus(job.machine_id) : null;
      if (running?.version === this.env.KITSHN_VERSION) {
        this.sql(
          "UPDATE jobs SET state = 'done', output = ? WHERE id = ?",
          `The daemon runs edge-${running.version} already.`,
          job.id,
        );
        continue;
      }
      // K-718: a redeploy that an agent key asked for goes out only while every check of its start still holds.
      if (visitor.kitshn && visitor.clientId !== null) {
        const reason =
          queuedCommand.kind !== "compose-redeploy"
            ? "kitshn makes no other job for an agent."
            : !visitor.ownerApproved &&
                !cardsControlledBy(this.state, visitor, Date.now()).has(queuedCommand.project)
              ? "The key no longer manages the card."
              : (this.redeployRefusal(job.machine_id, queuedCommand.project) ??
                this.repoRefusal(this.repoIdOfCard(queuedCommand.project)));
        if (reason !== null) {
          this.sql("UPDATE jobs SET state = 'failed', output = ? WHERE id = ?", reason, job.id);
          continue;
        }
      }
      // A job that kitshn makes itself (a deploy) needs no member with control (K-614).
      const allowed = new Set(
        visitor.kitshn || visitor.ownerApproved
          ? online
          : [...online].filter((id) => this.mayRunOn(visitor, id, queuedCommand.kind)),
      );
      const machine =
        job.machine_id !== null
          ? allowed.has(job.machine_id)
            ? (this.state.machines.get(job.machine_id) ?? null)
            : null
          : pickMachine(this.state.machines.values(), allowed, JSON.parse(job.labels) as Array<string>);
      if (!machine) continue;
      if (job.when_idle === 1 && this.busy(machine.id)) continue;
      const socket = this.openSocket(machine.id);
      if (!socket) continue;
      let command = JSON.parse(job.command) as Command;
      if (command.kind === "compose-volume-remove" && this.state.resources.has(command.project)) {
        this.sql(
          "UPDATE jobs SET state = 'failed', output = ? WHERE id = ?",
          "The app of this volume has a card again, so the volume is no longer orphaned (K-909).",
          job.id,
        );
        continue;
      }
      if (command.kind === "update") {
        // K-617: the version at delivery, so a job that waited never installs an older release.
        command = { kind: "update", version: this.env.KITSHN_VERSION };
        const status = this.machineView(machine).status;
        // The daemon sends its status just after it connects; the job waits for it.
        if (!status) continue;
        // K-622: the status was unknown while the machine was offline, so an agent's update checks it here too.
        if (!visitor.kitshn && this.isAgentSender(visitor) && !restartsAfterUpdate(status)) {
          this.sql(
            "UPDATE jobs SET state = 'failed', output = ? WHERE id = ?",
            noRestartAfterUpdate(machine.name),
            job.id,
          );
          this.endStep(job.id);
          continue;
        }
        // K-627: the row names the release that it installs, so the update state of that release finds it.
        this.sql("UPDATE jobs SET command = ? WHERE id = ?", JSON.stringify(command), job.id);
        const fail = (output: string) =>
          this.sql("UPDATE jobs SET state = 'failed', output = ? WHERE id = ?", output, job.id);
        if (!isRelease(command.version)) {
          fail(`This kitshn runs the build "${command.version}", which has no release to update to.`);
          continue;
        }
        // A daemon from before the gzipped release files updates with the shell script, which unpacks them.
        if (!status.capabilities?.includes("update-gz")) {
          const script =
            status.version === "dev" ? null : legacyUpdateScript(command.version, status.os, status.arch);
          if (!script) {
            fail(
              "This daemon runs from source, or kitshn does not know its platform. Update it by hand or join the machine again.",
            );
            continue;
          }
          command = { kind: "shell", script };
        }
      }
      // K-1908, K-822: each Compose job of an app gets a new notify token and the current Access values.
      const app =
        command.kind === "compose" ||
        command.kind === "compose-redeploy" ||
        command.kind === "compose-rollback"
          ? {
              notify: {
                url: this.notifyUrl(),
                token: this.mintNotifyToken(command.project, `job:${job.id}`),
              },
              access: this.appAccess(command.project),
            }
          : {};
      send(socket, { type: "job", id: job.id, command, ...app });
      this.sql("UPDATE jobs SET state = 'sent', machine_id = ? WHERE id = ?", machine.id, job.id);
      // K-627: the rollout step follows the release that went out, and only later connections show its outcome.
      if (queuedCommand.kind === "update" && this.rollout().step?.jobId === job.id)
        this.saveRollout(stepSent(this.rollout(), this.env.KITSHN_VERSION, Date.now()));
      sent++;
    }
    return sent;
  }

  /** K-627: the one rollout of daemon updates, kept in `meta` so it survives a deploy and an eviction. */
  private rollout(): Rollout {
    return (this.rolloutCache ??= parseRollout(this.meta("daemon_rollout")));
  }

  private saveRollout(rollout: Rollout) {
    if (deepEqual(rollout, this.rollout())) return;
    this.setMeta("daemon_rollout", JSON.stringify(rollout));
    this.rolloutCache = rollout;
  }

  /** K-627: the job of the rollout step, as `advanceRollout` reads it. */
  private stepJob(jobId: number): StepJob {
    const [row] = this.sql<{ state: string; output: string; expires_at: number }>(
      "SELECT state, output, expires_at FROM jobs WHERE id = ?",
      jobId,
    );
    if (!row || row.state === "expired" || (row.state === "queued" && row.expires_at <= Date.now()))
      return { state: "gone", output: "" };
    if (row.state === "failed")
      return { state: row.output === OFFLINE_OUTPUT ? "closed" : "failed", output: row.output };
    if (row.state === "queued" || row.state === "sent" || row.state === "done")
      return { state: row.state, output: row.output };
    throw new Error(`An update job has the state ${row.state}.`);
  }

  /** The status of a machine while it is online, with the start of its connection, else null. */
  private liveStatus(machineId: string): LiveStatus {
    const socket = this.openSocket(machineId);
    const attachment = socket ? attachmentOf(socket) : null;
    return attachment?.kind === "machine" && attachment.status
      ? { ...attachment.status, connectedAt: attachment.since }
      : null;
  }

  /** K-627: the rollout step is over without a failure: its job was cancelled or dropped. */
  private endStep(jobId: number) {
    const rollout = this.rollout();
    if (rollout.step?.jobId === jobId) this.saveRollout({ ...rollout, step: null });
  }

  /**
   * K-627: moves the rollout on and queues the next automatic update, if one may go. K-628 keeps the notification of a
   * failed update true. Returns whether it queued or sent a job.
   */
  private autoUpdate(): boolean {
    const version = this.env.KITSHN_VERSION;
    // Delivery first: it drops an automatic update of a machine whose setting is off, which ends that step.
    const delivered = this.deliverJobs();
    const stored = this.rollout();
    // A removed machine neither holds the rollout nor stops it.
    const before: Rollout = {
      ...stored,
      step: stored.step && this.state.machines.has(stored.step.machineId) ? stored.step : null,
      failed: stored.failed && this.state.machines.has(stored.failed.machineId) ? stored.failed : null,
    };
    let rollout = advanceRollout(before, before.step ? this.stepJob(before.step.jobId) : null, (id) =>
      this.liveStatus(id),
    );
    // K-627: a step whose job still waits for a busy machine holds no other machine; its job goes, without a failure.
    const held = rollout.step;
    if (held) {
      rollout = releaseBusyStep(rollout, this.stepJob(held.jobId), (id) => this.busy(id));
      if (rollout.step === null)
        this.sql("UPDATE jobs SET state = 'expired' WHERE id = ? AND state = 'queued'", held.jobId);
    }
    const now = Date.now();
    const machines = [...this.state.machines.values()].map((machine) => ({
      id: machine.id,
      order: machine.order,
      autoUpdate: machine.autoUpdate !== false,
      hasKey: machine.key?.kind === "public",
      status: this.liveStatus(machine.id),
      busy: this.busy(machine.id),
    }));
    rollout = withBusyWaits(rollout, version, machines, now);
    const next = nextAutoUpdate(version, this.state.paused !== null, rollout, machines, now);
    if (next !== null) {
      const jobId = this.queueKitshnJob(
        next.machineId,
        { kind: "update", version },
        { _tag: "kitshn", reason: "automatic daemon update (K-627)" },
        now + JOB_EXPIRY_MS,
        // K-1608: an idle machine's update still waits if it turns busy; after the cap it goes while busy.
        next.whenIdle,
      );
      rollout = startStep(rollout, version, next.machineId, jobId, next.whenIdle);
    }
    this.saveRollout(rollout);
    const failed = rollout.version === version ? rollout.failed : null;
    const machine = failed ? this.state.machines.get(failed.machineId) : undefined;
    if (failed && machine)
      this.notify({
        source: "update",
        key: failed.machineId,
        episode: version,
        card: failed.machineId,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: clip(`The daemon of ${machine.name} did not update`, TITLE_MAX),
        text: `${failed.reason} kitshn updates no other daemon to edge-${version} until this one runs it. Update daemon in its panel tries again.`,
        actions: [
          {
            id: "show",
            label: "Show machine",
            kind: "link",
            path: `#map/${encodeURIComponent(failed.machineId)}`,
          },
        ],
      });
    const resolved = [...this.openNotifications.values()].filter(
      (notification) => notification.source === "update" && notification.key !== failed?.machineId,
    );
    for (const notification of resolved) this.setNotificationState("update", notification.key, "closed");
    return delivered + this.deliverJobs() > 0 || next !== null;
  }

  /** K-609: the owner sets the labels and the order of a machine. K-626: and "Update daemon automatically". */
  private updateMachine(caller: Caller, id: string, body: unknown) {
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const before = this.state.machines.get(id);
    if (!before) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    if (input["autoUpdate"] !== undefined) {
      if (typeof input["autoUpdate"] !== "boolean")
        return Response.json({ error: "autoUpdate is true or false." }, { status: 400 });
      const on = before.autoUpdate !== false;
      if (on !== input["autoUpdate"])
        this.commit(caller.actor, [{ _tag: "autoUpdate", id, before: on, after: input["autoUpdate"] }], null);
    }
    const machine = this.state.machines.get(id) ?? before;
    if (input["labels"] === undefined && input["order"] === undefined && input["allow"] === undefined)
      return Response.json(machine);
    const labels = input["labels"] === undefined ? machine.labels : parseLabels(input["labels"]);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const order = input["order"] === undefined ? machine.order : Number(input["order"]);
    if (!Number.isInteger(order) || order < 0 || order > 10_000) {
      return Response.json({ error: "The order is a whole number from 0 to 10,000." }, { status: 400 });
    }
    const allow = input["allow"] === undefined ? (machine.allow ?? []) : parseAllowances(input["allow"]);
    if (typeof allow === "string") return Response.json({ error: allow }, { status: 400 });
    const updated: Machine = { ...machine, labels: [...labels], order, allow };
    if (deepEqual(updated, machine)) return Response.json(updated);
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE machines SET body = ? WHERE id = ?", JSON.stringify(updated), id);
      this.insertRevision(
        caller.actor,
        `Changed machine ${machine.name}: labels ${labels.join(", ") || "none"}, order ${order}, ${allow.length} allowed Compose settings`,
        [],
        null,
      );
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    return Response.json(updated);
  }

  private recentJobs(limit: number, outputLimit = 4000, id: number | null = null): Array<Job> {
    return this.sql<{
      id: number;
      machine_id: string | null;
      labels: string;
      command: string;
      state: Job["state"];
      created_at: number;
      expires_at: number;
      actor: string;
      exit_code: number | null;
      output: string;
    }>(
      "SELECT id, machine_id, labels, command, state, created_at, expires_at, actor, exit_code, output FROM jobs WHERE ? IS NULL OR id = ? ORDER BY id DESC LIMIT ?",
      id,
      id,
      limit,
    ).map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      labels: JSON.parse(row.labels) as Array<string>,
      command: JSON.parse(row.command) as Command,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actor: row.actor,
      exitCode: row.exit_code,
      output: row.output.slice(0, outputLimit),
    }));
  }

  /** K-1107: closes machine sockets that answered no ping for 30 seconds. K-1704: and those without an answer. */
  private checkLiveness(now: number) {
    for (const socket of this.ctx.getWebSockets("machines")) {
      const attachment = attachmentOf(socket);
      if (attachment?.kind !== "machine") continue;
      const machine = this.state.machines.get(attachment.machineId);
      if (machine && attachment.check === "waiting" && now - attachment.since >= CHALLENGE_MS) {
        this.refuseSocket(socket, machine, "No answer to the challenge within 10 seconds.");
        continue;
      }
      const last = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.since;
      if (now - last > PING_TIMEOUT_MS) {
        socket.close(4008, "No ping for 30 seconds.");
        this.socketGone(socket);
      }
    }
  }

  /** Returns how many jobs expired. */
  /** K-1612: a machine that queued a job with an ask hears of its end, so its agent needs no polling. */
  private jobsEnded(ids: ReadonlyArray<number>) {
    for (const id of ids) {
      const [job] = this.sql<{ state: string; exit_code: number | null; output: string; actor: string }>(
        "SELECT state, exit_code, output, actor FROM jobs WHERE id = ?",
        id,
      );
      if (!job || (job.state !== "done" && job.state !== "failed" && job.state !== "expired")) continue;
      const actor = JSON.parse(job.actor) as Actor;
      const socket = actor._tag === "machine" ? this.openSocket(actor.machineId) : null;
      if (socket)
        send(socket, {
          type: "jobEnded",
          jobId: id,
          state: job.state,
          exitCode: job.exit_code,
          output: job.output.slice(-16_000),
        } satisfies ServerToDaemon);
    }
  }

  private expireJobs(now: number) {
    const rows = this.sql<{ id: number }>(
      "UPDATE jobs SET state = 'expired' WHERE state IN ('queued', 'sent') AND expires_at <= ? RETURNING id",
      now,
    );
    this.jobsEnded(rows.map((row) => row.id));
    const expired = rows.length;
    // K-627: an expired step ends without a failure, and the next machine can go.
    if (expired > 0) this.autoUpdate();
    return expired;
  }

  /**
   * K-603: kitshn owns each tunnel's ingress and writes it from the alarm queue. A site gets ingress only
   * once its Access application exists (K-410). A row keeps the ingress that Cloudflare last accepted;
   * a failed write tries again after five minutes.
   */
  private async syncTunnels(api: NonNullable<ReturnType<Kitshn["api"]>>, budget: number) {
    let calls = 0;
    const now = Date.now();
    const rows = new Map(this.tunnelRows().map((row) => [row.machine_id, row]));
    const accessOf = this.ingressAccessOf();
    for (const machine of this.state.machines.values()) {
      const row = rows.get(machine.id);
      if (row?.error && row.retry_at > now) continue;
      const config = tunnelConfig(this.ingressSites(machine.id), accessOf);
      const body = JSON.stringify(config);
      if (row?.applied === body && row.error === null) continue;
      if (calls++ >= budget) return;
      for (const site of this.ingressSites(machine.id)) {
        const access = accessOf(site);
        if (access.kind === "pending")
          console.warn(
            `kitshn writes the ingress of ${site.address} without the Access check: ${access.reason}.`,
          );
      }
      try {
        await api(
          "PUT",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${machine.tunnelId}/configurations`,
          config,
        );
        this.sql(
          "INSERT OR REPLACE INTO tunnel_objects (machine_id, body, applied, error, retry_at) VALUES (?, ?, ?, NULL, 0)",
          machine.id,
          body,
          body,
        );
        for (const site of this.ingressSites(machine.id)) {
          const handover = site.state === "handover" ? this.handoverOf(site.id) : null;
          if (handover?.ingressAt === null) this.setHandover(site.id, { ...handover, ingressAt: now });
        }
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO tunnel_objects (machine_id, body, applied, error, retry_at) VALUES (?, ?, ?, ?, ?)",
          machine.id,
          body,
          row?.applied ?? "",
          String(error),
          now + RETRY_MS,
        );
      }
    }
  }

  private tunnelRows() {
    return this.sql<{
      machine_id: string;
      body: string;
      applied: string;
      error: string | null;
      retry_at: number;
    }>("SELECT machine_id, body, applied, error, retry_at FROM tunnel_objects");
  }

  /**
   * K-006: every address that a route can still reach: tunnel ingress that Cloudflare accepted, a DNS
   * record or an offline route that kitshn made. Its Access application stays until none is left.
   */
  private reachableAddresses() {
    return reachableAddresses({
      ingress: this.tunnelRows().map((row) => row.applied),
      records: this.sql<{ address: string; record_id: string }>("SELECT address, record_id FROM dns_objects"),
      routes: this.sql<{ address: string; route_id: string }>("SELECT address, route_id FROM route_objects"),
    });
  }

  /** True when a site check, a tunnel, a DNS record or an offline route waits for the alarm. */
  /** Work for the tunnel, site check and record steps; a step that waits for its retry (K-406) has none. */
  private tunnelWork() {
    const now = Date.now();
    const ready = (step: AlarmStep) => !this.alarmStepWaits(step, now);
    const tunnels = new Map(this.tunnelRows().map((row) => [row.machine_id, row]));
    const accessOf = this.ingressAccessOf();
    const stale =
      ready("tunnels") &&
      [...this.state.machines.values()].some((machine) => {
        const row = tunnels.get(machine.id);
        if (row?.error && row.retry_at > now) return false;
        return row?.applied !== JSON.stringify(tunnelConfig(this.ingressSites(machine.id), accessOf));
      });
    const checking =
      ready("site checks") &&
      [...this.liveSites.values()].some(
        (site) => site.state === "checking" && (this.checkRetryAt.get(site.id) ?? 0) <= Date.now(),
      );
    return (
      stale ||
      checking ||
      (ready("DNS") && this.dnsWork().length > 0) ||
      (ready("routes") && this.routeWork().length > 0) ||
      (ready("game DNS") && this.gameDnsWork(now))
    );
  }

  /**
   * Deletes a card's rows and takes it out of its stack, inside the caller's transaction (K-522). Returns the
   * mark that the revision of the deletion stores, so an older undo never touches a new card of the same id (K-1506).
   */
  private forgetCard(id: string): Forget {
    for (const table of ["resources", "places", "card_ends"])
      this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
    // K-717: the settings of a card go with it, and so does a taken address of it (K-1623).
    this.sql("DELETE FROM card_settings WHERE card_id = ?", id);
    this.setHandover(id, null);
    this.setProgress(id, null);
    // K-1124: a forgotten card does not come back, so its old addresses go free.
    this.sql("DELETE FROM old_addresses WHERE card_id = ?", id);
    this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${id}/%`);
    const stacks = this.sql<{ id: string; body: string }>("SELECT id, body FROM stacks").map(
      (row) => JSON.parse(row.body) as Stack,
    );
    for (const change of stacksWithout(stacks, id)) {
      if (change.after)
        this.sql("UPDATE stacks SET body = ? WHERE id = ?", JSON.stringify(change.after), change.id);
      else this.sql("DELETE FROM stacks WHERE id = ?", change.id);
    }
    return { _tag: "forget", id, before: null, after: null };
  }

  private sitesOf(machineId: string) {
    return [...this.liveSites.values()].filter((site) => site.machineId === machineId);
  }

  /** K-603: the Access check of each ingress rule, from the Access objects that Cloudflare accepted. */
  private ingressAccessOf() {
    return (site: LiveSite) => ingressAccess(site, this.access, this.env.ACCESS_TEAM_DOMAIN);
  }

  /** Live sites whose address is checked and whose Access application exists in Cloudflare. */
  /**
   * K-2008: the relay host of each game behind NAT, as a live site of the game's machine. So it gets its tunnel
   * ingress, its proxied record and its Access check from the site path; `tcp://` makes cloudflared carry raw TCP.
   */
  private relaySites(): Array<LiveSite> {
    return this.gameRows("relay_id IS NOT NULL").flatMap((row) => {
      const address = this.state.resources.get(row.card_id)?.addresses[1];
      const port = gameOf(row).ports[0];
      if (!address || !port) return [];
      return [
        {
          id: row.card_id,
          machineId: row.machine_id,
          name: `${row.name}-relay`,
          address,
          target: `tcp://localhost:${port.port}`,
          dev: false,
          up: true,
          lastUp: 0,
          state: "ok" as const,
        },
      ];
    });
  }

  /**
   * K-1623: the machine applied the access push that holds the audience of kitshn's application on the site, so its
   * provider accepts kitshn's tokens before the record sends visitors through kitshn.
   */
  private audienceApplied(site: LiveSite) {
    const aud = this.access.get(`app:${site.id}:${site.address}`)?.aud;
    const provider = this.state.resources.get(site.id)?.provider?.name;
    if (!aud || !provider) return false;
    const key = pushKey.access(provider);
    const push = this.pushesOf(site.machineId).find((item) => item.key === key);
    return (
      push?.push.type === "access" &&
      push.push.access.audiences.includes(aud) &&
      this.applied.get(`${site.machineId}/${key}`) === push.hash
    );
  }

  /** K-1623: the ingress of a machine: its protected sites, and an address that it takes over once its application exists. */
  private ingressSites(machineId: string) {
    const taking = [...this.liveSites.values()].filter(
      (site) =>
        site.machineId === machineId &&
        site.state === "handover" &&
        Boolean(this.access.get(`app:${site.id}:${site.address}`)?.cfId),
    );
    return [...this.protectedSites(machineId), ...taking].map((site) => {
      const paths = this.handoverOf(site.id)?.paths ?? [];
      return paths.length > 0 ? { ...site, paths } : site;
    });
  }

  private protectedSites(machineId?: string) {
    return protectedLiveSites(
      [...this.liveSites.values(), ...this.relaySites()].filter(
        (site) => machineId === undefined || site.machineId === machineId,
      ),
      (id) => this.state.resources.get(id),
      // The application exists in Cloudflare; a later failed update of it does not take the site down.
      (site) => Boolean(this.access.get(`app:${site.id}:${site.address}`)?.cfId),
    );
  }

  /**
   * K-1104: takes the full list of live sites of one machine. A new site waits for an address check
   * (K-1111, K-408) before it becomes a card in the tray (K-509).
   */
  private updateLiveSites(machine: Machine, reported: unknown) {
    const { sites, refused } = parseSites(reported);
    const now = Date.now();
    const keep = new Set<string>();
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const report of sites) {
        const address = `${report.name}.${this.env.KITSHN_ZONE}`;
        // K-812: the socket of a Compose app on this machine is the address of its card.
        // K-705: the site of a provider card on this machine is that card, by its name: the card gets the address
        // only after the check below.
        const app = [...this.state.resources.values()].find(
          (resource) =>
            resource.machine === machine.id &&
            (resource.provider
              ? resource.provider.site === report.name && resource.provider.droppedAt === undefined
              : resource.kind === "site.compose" && resource.addresses.includes(address)),
        );
        // K-909: a removed Compose app keeps its row until its compose-down ends, so it never turns into a
        // live site card meanwhile.
        const id =
          app?.id ??
          this.sitesOf(machine.id).find((site) => site.address === address)?.id ??
          liveSiteId(machine.id, report.name);
        // Preserve a site that already held a now-reserved name; never give that name to a new report.
        const previous = this.liveSites.get(id);
        if (
          reservedSiteLinkHost(address, this.env.KITSHN_ZONE) &&
          !(previous?.machineId === machine.id && previous.address === address)
        ) {
          refused.push(`${address} belongs to kitshn itself.`);
          continue;
        }
        const other = [...this.state.resources.values()].find(
          (resource) => resource.id !== id && resource.addresses.includes(address),
        );
        const otherSite = [...this.liveSites.values()].find(
          (site) => site.id !== id && site.address === address,
        );
        if (other || otherSite) {
          refused.push(`${address} belongs to ${other ? `the card ${other.name}` : "another machine"}.`);
          continue;
        }
        // K-212: the end time of `kitshn expose --time` waits for the card that the address check makes.
        if (report.endsAt !== undefined && report.endsAt > now && !this.state.resources.has(id))
          this.pendingEnds.set(id, report.endsAt);
        if (report.circle !== undefined && !this.state.resources.has(id))
          this.pendingCircles.set(id, report.circle);
        keep.add(id);
        const old = this.liveSites.get(id);
        if (old && old.target === report.target && old.dev === report.dev && old.up === report.up) continue;
        changed = true;
        // lastUp records the moment a site was last seen up, so it changes when the site goes down.
        const lastUp = report.up || !old ? now : old.up ? now : old.lastUp;
        this.sql(
          `INSERT OR REPLACE INTO live_sites (id, machine_id, name, address, target, dev, up, last_up, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          machine.id,
          report.name,
          address,
          report.target,
          report.dev ? 1 : 0,
          report.up ? 1 : 0,
          lastUp,
          old?.state ?? "checking",
        );
        const resource = this.state.resources.get(id);
        // K-705: a provider reports the status of its own cards.
        if (resource && !resource.provider)
          this.putResource({ ...resource, status: report.up ? "running" : "stopped" });
      }
      for (const site of this.sitesOf(machine.id)) {
        if (keep.has(site.id)) continue;
        changed = true;
        this.sql("DELETE FROM live_sites WHERE id = ?", site.id);
        this.setHandover(site.id, null);
        // K-705: a provider card stays when its site goes; the provider removes the card itself.
        if (this.state.resources.get(site.id)?.provider) continue;
        // A removed app has its History entry already (K-909).
        const hadCard = this.state.resources.has(site.id);
        const forgotten = this.forgetCard(site.id);
        if (hadCard)
          this.insertRevision(
            { _tag: "kitshn", reason: `live site on ${machine.name}` },
            `${machine.name} stopped exposing ${site.address}`,
            [forgotten],
            null,
          );
      }
    });
    for (const reason of refused) console.warn(`kitshn refused a live site of ${machine.name}: ${reason}`);
    if (!changed) return;
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
  }

  /**
   * K-1111, K-408: a new live site gets its card only when nothing else uses its address: no DNS record
   * and no Worker custom domain. Otherwise kitshn refuses it and makes nothing for it.
   */
  private async checkSites(api: Api, budget: number) {
    let calls = 0;
    let changed = false;
    const ours = new Set(
      this.sql<{ record_id: string }>("SELECT record_id FROM dns_objects").map((row) => row.record_id),
    );
    for (const site of [...this.liveSites.values()].filter((item) => item.state === "checking")) {
      if ((this.checkRetryAt.get(site.id) ?? 0) > Date.now()) continue;
      if (calls + 2 > budget) break;
      calls += 2;
      let used: boolean;
      try {
        const records = await api<Array<{ id: string }>>(
          "GET",
          `/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(site.address)}`,
        );
        const domains = await api<Array<unknown>>(
          "GET",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(site.address)}`,
        );
        // A record that kitshn made itself (for a site that moved) does not count.
        used = records.some((record) => !ours.has(record.id)) || domains.length > 0;
      } catch (error) {
        // Try again in five minutes; the rest of the alarm run goes on.
        this.checkRetryAt.set(site.id, Date.now() + 5 * 60_000);
        console.warn(`kitshn could not check ${site.address}: ${String(error)}`);
        continue;
      }
      this.checkRetryAt.delete(site.id);
      // The site may have changed while the checks waited; act only on the row as it is now.
      const [row] = this.sql<{ state: string }>("SELECT state FROM live_sites WHERE id = ?", site.id);
      if (row?.state !== "checking") continue;
      changed = true;
      if (used) {
        this.sql("UPDATE live_sites SET state = 'refused' WHERE id = ?", site.id);
        console.warn(`kitshn refused ${site.address}: something else already uses the address.`);
        // K-705: a provider card shows at once that something else serves its address.
        const card = this.state.resources.get(site.id);
        if (card?.provider) this.putResource(withAddressInUse(card, true));
        continue;
      }
      const machine = this.state.machines.get(site.machineId);
      let notShared: string | null = null;
      this.ctx.storage.transactionSync(() => {
        this.sql("UPDATE live_sites SET state = 'ok' WHERE id = ?", site.id);
        const card = this.state.resources.get(site.id);
        const endsAt = card ? undefined : this.pendingEnds.get(site.id);
        this.pendingEnds.delete(site.id);
        const circle = card ? undefined : this.pendingCircles.get(site.id);
        this.pendingCircles.delete(site.id);
        // The person whose wizard job made this site, else the machine of `kitshn expose --time`.
        const asked = [...this.siteAskers].find(([, each]) => each.done && each.siteId === site.id);
        if (asked) this.siteAskers.delete(asked[0]);
        const by: Actor = asked?.[1].by ?? {
          _tag: "machine",
          machineId: site.machineId,
          name: machine?.name ?? site.machineId,
        };
        const shown: Resource = card
          ? // K-705: a provider reports the status of its own cards, and its site's address comes on now.
            card.provider
            ? withAddressInUse({ ...card, addresses: [site.address] }, false)
            : { ...card, status: site.up ? "running" : "stopped" }
          : {
              id: site.id,
              kind: "site.live",
              name: site.name,
              addresses: [site.address],
              status: site.up ? "running" : "stopped",
              group: null,
              machine: site.machineId,
            };
        this.putResource(shown);
        // The card is not in `this.state` until this revision ends, and the rules must see it: a share of a card that
        // they cannot see would pass "while paused, access only goes down" (K-1504).
        const withCard: State = {
          ...this.state,
          resources: new Map(this.state.resources).set(site.id, shown),
        };
        // K-212: a card that `kitshn expose --time` made starts with its end time.
        const ends: Array<Change> =
          endsAt !== undefined && endsAt > Date.now()
            ? [{ _tag: "cardEnd", id: site.id, before: null, after: endsAt }]
            : [];
        const wished = card ? null : (asked?.[1].circle ?? null);
        const placed = wished
          ? this.wizardPlace(site.id, wished, withCard)
          : circle !== undefined && machine
            ? this.livePlace(machine, site.id, circle, withCard)
            : [];
        if (wished && placed.length === 0) notShared = wished;
        this.persist([...ends, ...placed]);
        if (ends.length > 0)
          this.sql("UPDATE card_ends SET set_by = ? WHERE id = ?", JSON.stringify(by), site.id);
        const into =
          placed.length > 0
            ? ` in ${this.state.circles.get(wished ?? circle ?? "")?.name ?? wished ?? circle}`
            : "";
        this.insertRevision(
          { _tag: "kitshn", reason: `live site on ${machine?.name ?? site.machineId}` },
          `${machine?.name ?? site.machineId} exposed ${site.address}${into} (K-1104)${ends.length > 0 ? ` until ${endText(endsAt ?? 0)}` : ""}`,
          [...ends, ...placed],
          null,
        );
      });
      if (notShared)
        this.notifyNotShared(
          site.id,
          site.machineId,
          notShared,
          "No spot or a rule of the circle refused it. It waits in the tray, private.",
        );
    }
    if (changed) {
      this.load();
      this.broadcast();
    }
    return calls;
  }

  /**
   * K-1104, K-718: the place of a new live site card in the circle of `kitshn expose --circle`, by the rules of an
   * agent upload: only a circle where the machine has control. A refusal leaves the card in the tray (K-509).
   */
  private livePlace(machine: Machine, id: string, circle: string, base: State): Array<Change> {
    const visitor = { email: null, clientId: machine.clientId, ip: null };
    const spot = agentUploadPlace(this.state, visitor, circle, false, Date.now());
    if (spot === null || typeof spot === "string") {
      console.warn(`kitshn left ${id} in the tray: ${spot ?? "no circle"}`);
      return [];
    }
    const changes: Array<Change> = [{ _tag: "place", id, before: null, after: spot }];
    try {
      this.checked(changes, base);
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      console.warn(`kitshn left ${id} in the tray: ${error.message}`);
      return [];
    }
    return changes;
  }

  /**
   * K-1131: the place of a new live site card in the circle that its wizard named. The owner chose it, so the rules of
   * the map hold, not the rights of the machine. A refusal leaves the card in the tray (K-509).
   */
  private wizardPlace(id: string, circleId: string, base: State): Array<Change> {
    const circle = base.circles.get(circleId);
    // Clear of the cards there, so two sites of one circle do not land on one point.
    const spot = circle
      ? placeInside(base, { x: circle.x, y: circle.y }, new Set([circle.id]), [...base.places.values()])
      : null;
    if (!spot) return [];
    const changes: Array<Change> = [{ _tag: "place", id, before: null, after: spot }];
    try {
      this.checked(changes, base);
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      return [];
    }
    return changes;
  }

  /** K-1131: the wizard said "Share with <circle>", and that did not happen, so the owner hears it. */
  private notifyNotShared(siteId: string, machineId: string, circleId: string, why: string) {
    const circle = this.state.circles.get(circleId)?.name ?? circleId;
    this.notify({
      source: "site",
      key: siteId,
      episode: String(Date.now()),
      card: machineId,
      recipients: { _tag: "owner" },
      level: "warn",
      priority: "normal",
      title: `A live site was not shared with ${circle}`,
      text: why,
      actions: [],
    });
  }

  /**
   * Live site addresses whose DNS record kitshn still has to make, point elsewhere, or delete. A record
   * goes only after the ingress and the offline route of its address are gone (K-410).
   */
  private dnsWork() {
    const now = Date.now();
    const rows = new Map(
      this.sql<{
        address: string;
        record_id: string;
        content: string;
        card_id: string | null;
        error: string | null;
        retry_at: number;
      }>("SELECT * FROM dns_objects").map((row) => [row.address, row]),
    );
    const due = (address: string) => {
      const row = rows.get(address);
      return !row?.error || row.retry_at <= now;
    };
    // K-817, K-901: a Compose deploy gets its records at plan time (wantedRecords).
    const wanted = wantedRecords(
      this.deploys().composeRuns,
      this.protectedSites(),
      (machineId) => this.state.machines.get(machineId)?.tunnelId,
      now,
    );
    // K-1623: a taken address moves its kept record to this tunnel only after an earlier run gave the tunnel its
    // ingress, so cloudflared has the rule before the first visit comes.
    for (const site of this.liveSites.values()) {
      const handover = site.state === "handover" ? this.handoverOf(site.id) : null;
      const tunnel = this.state.machines.get(site.machineId)?.tunnelId;
      if (
        handover?.ingressAt != null &&
        now - handover.ingressAt >= HANDOVER_INGRESS_MS &&
        tunnel !== undefined &&
        this.audienceApplied(site)
      )
        wanted.set(site.address, { content: `${tunnel}.cfargotunnel.com`, cardId: site.id });
    }
    const routed = reachableAddresses({
      ingress: this.tunnelRows().map((row) => row.applied),
      records: [],
      routes: this.sql<{ address: string; route_id: string }>("SELECT address, route_id FROM route_objects"),
    });
    return [
      ...[...wanted]
        .filter(([address, { content, cardId }]) => {
          const row = rows.get(address);
          // An older row without its card gets the card at the next write (K-817).
          return (
            due(address) && (!row || row.error !== null || row.content !== content || row.card_id !== cardId)
          );
        })
        .map(([address, { content, cardId }]) => ({ address, content: content as string | null, cardId })),
      ...[...rows.values()]
        .filter((row) => !wanted.has(row.address) && due(row.address) && !routed.has(row.address))
        .map((row) => ({ address: row.address, content: null, cardId: row.card_id })),
    ];
  }

  /** K-1108: addresses whose offline route kitshn still has to add or remove. */
  private routeWork() {
    const now = Date.now();
    const rows = new Map(
      this.sql<{ address: string; route_id: string; error: string | null; retry_at: number }>(
        "SELECT * FROM route_objects",
      )
        .filter((row) => row.error === null || row.retry_at <= now)
        .map((row) => [row.address, row]),
    );
    const failed = new Set(
      this.sql<{ address: string }>(
        "SELECT address FROM route_objects WHERE error IS NOT NULL AND retry_at > ?",
        now,
      ).map((row) => row.address),
    );
    const wanted = new Set(
      sitesNeedingRoutes(this.protectedSites(), this.onlineMachines()).map((site) => site.address),
    );
    return [
      ...[...wanted]
        .filter((address) => !failed.has(address) && (!rows.has(address) || !rows.get(address)?.route_id))
        .map((address) => ({ address, add: true })),
      ...[...rows.values()]
        .filter((row) => !wanted.has(row.address) && !failed.has(row.address))
        .map((row) => ({ address: row.address, add: false })),
    ];
  }

  /** K-1111, K-817: the API path of the zone of an address. It fails for an address outside every zone. */
  private zonePath(address: string) {
    const zone = zoneOfAddressIn(address, this.env);
    if (!zone) throw new Error(`kitshn does not publish on the zone of ${address} (K-1111).`);
    return `/zones/${zone.id}`;
  }

  /** K-1104: a proxied CNAME per live site to its machine's tunnel. kitshn deletes only records it made. */
  private async syncDns(api: Api, budget: number) {
    let calls = 0;
    for (const work of this.dnsWork()) {
      if (calls >= budget) return;
      calls++;
      const [row] = this.sql<{ record_id: string; card_id: string | null }>(
        "SELECT record_id, card_id FROM dns_objects WHERE address = ?",
        work.address,
      );
      try {
        const zone = `${this.zonePath(work.address)}/dns_records`;
        if (work.content !== null) {
          const body = {
            type: "CNAME",
            name: work.address,
            content: work.content,
            proxied: true,
            comment: "kitshn live site (K-1104)",
          };
          const handover = work.cardId === null ? null : this.handoverOf(work.cardId);
          const site = work.cardId === null ? undefined : this.liveSites.get(work.cardId);
          // K-1623: a taken address changes the record that served it, never makes a second one.
          const recordId = row?.record_id || (site?.state === "handover" ? handover?.recordId : undefined);
          const record = recordId
            ? await api<{ id: string }>("PUT", `${zone}/${recordId}`, body)
            : await api<{ id: string }>("POST", zone, body);
          // A give-back can run during the PUT: the record goes back to what it served, and kitshn keeps nothing.
          const taking = site?.state === "handover" && handover !== null;
          const current = taking ? this.handoverOf(site.id) : null;
          if (taking && (current === null || this.liveSites.get(site.id)?.state !== "handover")) {
            await api("PUT", `${zone}/${record.id}`, {
              type: "CNAME",
              name: work.address,
              content: handover.content,
              proxied: true,
              comment: handover.comment ?? "",
            });
            continue;
          }
          this.ctx.storage.transactionSync(() => {
            this.sql(
              "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at, card_id) VALUES (?, ?, ?, NULL, 0, ?)",
              work.address,
              record.id,
              work.content,
              work.cardId,
            );
            if (taking && current) {
              this.sql("UPDATE live_sites SET state = 'ok' WHERE id = ?", site.id);
              this.setHandover(site.id, { ...current, switched: true });
              this.load();
            }
          });
        } else {
          if (row?.record_id) {
            await api("DELETE", `${zone}/${row.record_id}`).catch((error: unknown) =>
              error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
            );
          }
          this.sql("DELETE FROM dns_objects WHERE address = ?", work.address);
        }
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at, card_id) VALUES (?, ?, ?, ?, ?, ?)",
          work.address,
          row?.record_id ?? "",
          work.content ?? "",
          String(error),
          Date.now() + RETRY_MS,
          row?.card_id ?? work.cardId,
        );
      }
    }
  }

  /** K-1108: a Worker route on a live site only while its origin is down, so healthy visits cost nothing. */
  private async syncRoutes(api: Api, budget: number) {
    let calls = 0;
    // A route that failed to go but is wanted again simply stays; its old error no longer applies.
    for (const site of sitesNeedingRoutes(this.protectedSites(), this.onlineMachines())) {
      this.sql(
        "UPDATE route_objects SET error = NULL, retry_at = 0 WHERE address = ? AND route_id != '' AND error IS NOT NULL",
        site.address,
      );
    }
    for (const work of this.routeWork()) {
      if (calls++ >= budget) return;
      try {
        const routes = `${this.zonePath(work.address)}/workers/routes`;
        if (work.add) {
          const route = await api<{ id: string }>("POST", routes, {
            pattern: `${work.address}/*`,
            script: "kitshn",
          });
          this.sql(
            "INSERT OR REPLACE INTO route_objects (address, route_id, error, retry_at) VALUES (?, ?, NULL, 0)",
            work.address,
            route.id,
          );
        } else {
          const [row] = this.sql<{ route_id: string }>(
            "SELECT route_id FROM route_objects WHERE address = ?",
            work.address,
          );
          if (row?.route_id) {
            await api("DELETE", `${routes}/${row.route_id}`).catch((error: unknown) =>
              error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
            );
          }
          this.sql("DELETE FROM route_objects WHERE address = ?", work.address);
        }
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO route_objects (address, route_id, error, retry_at) VALUES (?, COALESCE((SELECT route_id FROM route_objects WHERE address = ?), ''), ?, ?)",
          work.address,
          work.address,
          String(error),
          Date.now() + RETRY_MS,
        );
      }
    }
  }

  /** K-1110: what the offline page of an address shows. */
  private offlineInfo(address: string) {
    // K-817: an extra address of a Compose app shows the offline page of its site too.
    const site = [...this.liveSites.values()]
      .flatMap((item) => servedSites(item, this.state.resources.get(item.id)))
      .find((item) => item.address === address);
    if (!site) return Response.json({ error: "No live site has this address." }, { status: 404 });
    const machine = this.state.machines.get(site.machineId);
    const online = this.onlineMachines().has(site.machineId);
    const seen = online ? site.lastUp : (this.presence.get(site.machineId)?.lastSeen ?? site.lastUp);
    return Response.json({
      site: site.address,
      machine: machine?.name ?? "the machine",
      reason: offlineReason(machine?.name ?? "the machine", online),
      seen,
    });
  }

  /** K-1118: the public app cards with their main address and icon. The Worker caches the answer. */
  private publicCards() {
    const environmentOf = (id: string) => this.lastDone(id)?.environment ?? null;
    const cards = listedApps(this.state, environmentOf, Date.now()).map((resource) => {
      const [icon] = this.sql<{ type: string; bytes: ArrayBuffer }>(
        "SELECT type, bytes FROM icons WHERE id = ?",
        resource.id,
      );
      if (!icon)
        return { name: resource.name, address: resource.addresses[0], kind: resource.kind, icon: null };
      // A spread of 100 KB into String.fromCharCode passes the argument limit, so one byte at a time.
      let binary = "";
      for (const byte of new Uint8Array(icon.bytes)) binary += String.fromCharCode(byte);
      return {
        name: resource.name,
        address: resource.addresses[0],
        kind: resource.kind,
        icon: `data:${icon.type};base64,${btoa(binary)}`,
      };
    });
    return Response.json({ cards });
  }

  /** K-1119: the badge state of the newest deploy of one repo, app and environment. Skipped deploys do not count. */
  private badge(query: URLSearchParams) {
    const [row] = this.sql<{ resource_id: string; state: string; expires_at: number }>(
      BADGE_DEPLOY_QUERY,
      query.get("repo") ?? "",
      query.get("app") ?? "app",
      query.get("env") ?? "prod",
    );
    const resource = row ? this.state.resources.get(row.resource_id) : undefined;
    const now = Date.now();
    // A run that stopped before it reported leaves its row planned or running after it expired (as deployRuns reads).
    const state =
      row && row.state !== "done" && row.state !== "failed" && row.expires_at <= now ? "failed" : row?.state;
    return Response.json({ state: badgeState(this.state, resource, state ?? null, now) });
  }

  /** K-1302: one alarm for the next due item. Access work, share end dates, and the daily run. */
  private async scheduleAlarm() {
    const now = Date.now();
    // K-406: the pending work of a step that waits for its retry wakes nothing; its retry time below does.
    const waits = (step: AlarmStep) => this.alarmStepWaits(step, now);
    let next = Math.min(waits("daily") ? Infinity : this.dailyAt(), this.backupAt());
    for (const socket of this.ctx.getWebSockets("machines")) {
      const attachment = attachmentOf(socket);
      next = Math.min(next, now + LIVENESS_CHECK_MS);
      // K-1704: a socket without an answer closes after 10 seconds.
      if (attachment?.kind === "machine" && attachment.check === "waiting")
        next = Math.min(next, attachment.since + CHALLENGE_MS);
    }
    if (this.env.CLOUDFLARE_API_TOKEN && this.tunnelWork()) next = now;
    const [job] = this.sql<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM jobs WHERE state IN ('queued', 'sent')",
    );
    if (job?.expires_at && !waits("jobs")) next = Math.min(next, Math.max(job.expires_at, now));
    // K-627: a busy machine gets its update when its wait reaches the cap.
    for (const since of Object.values(this.rollout().busySince ?? {}))
      next = Math.min(next, Math.max(since + BUSY_CAP_MS, now));
    // K-1724: the next proposal that expires.
    const [proposal] = this.sql<{ expires_at: number | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM proposals WHERE state = 'pending'",
    );
    if (proposal?.expires_at && !waits("proposals"))
      next = Math.min(next, Math.max(proposal.expires_at, now));
    // K-1623, K-411: a taken address moves its record as soon as the machine has the audience and the ingress waited.
    // Before the machine applied the audience, the `applied` message wakes the alarm, so no run waits for it.
    for (const site of this.liveSites.values()) {
      const ingressAt = site.state === "handover" ? this.handoverOf(site.id)?.ingressAt : null;
      if (typeof ingressAt === "number" && !waits("DNS") && this.audienceApplied(site))
        next = Math.min(next, Math.max(ingressAt + HANDOVER_INGRESS_MS, now));
    }
    const desired = this.desired(now);
    if (
      this.env.CLOUDFLARE_API_TOKEN &&
      ((!waits("Access") &&
        (hasAccessWork(
          desired,
          this.access,
          this.reachableAddresses(),
          loginHeld(this.meta("login_held") ?? ""),
        ) ||
          this.loginWork())) ||
        (!waits("launcher") && !waits("launcher after Access") && this.launcherWork()) ||
        this.redirectWork())
    )
      next = now;
    // A failed tunnel, DNS or route write tries again after five minutes (K-410). Only a future retry
    // time counts here; a row that is due counts through tunnelWork, and only when there is work for it.
    const [retry] = this.sql<{ at: number | null }>(
      `SELECT MIN(retry_at) AS at FROM (SELECT retry_at FROM tunnel_objects WHERE error IS NOT NULL
       UNION ALL SELECT retry_at FROM dns_objects WHERE error IS NOT NULL
       UNION ALL SELECT retry_at FROM route_objects WHERE error IS NOT NULL) WHERE retry_at > ?`,
      now,
    );
    if (retry?.at) next = Math.min(next, retry.at);
    // K-407, K-408: a failed Access write or delete tries again at its retry time.
    for (const row of this.access.values())
      if (row.error !== null && row.retryAt !== undefined && row.retryAt > now)
        next = Math.min(next, row.retryAt);
    // K-817: an expired Compose deploy gives up the DNS record that its plan made.
    for (const run of this.deploys().composeRuns)
      if (run.expiresAt > now) next = Math.min(next, run.expiresAt);
    // K-1124: the redirect step that waits tries again at its time; a finished step stores 0.
    const redirectRetry = Number(this.meta("redirects_retry_at") ?? 0);
    if (this.env.CLOUDFLARE_API_TOKEN && redirectRetry > now) next = Math.min(next, redirectRetry);
    // K-631: a "Check now" that gets no report fails at its time.
    for (const row of this.progressRows().values())
      if (row.source._tag === "health" && row.progress.outcome.state === "running")
        next = Math.min(next, Math.max(now, row.source.until));
    // K-406: a step of the alarm that threw tries again at its time.
    for (const failure of this.alarmSteps().values())
      if (failure.retryAt > now) next = Math.min(next, failure.retryAt);
    if (this.env.CLOUDFLARE_API_TOKEN && !waits("audiences") && rowsWithoutAud(this.access).length > 0)
      next = Math.min(next, Math.max(this.audRetryAt, now));
    const ends = [
      ...[...this.state.shareSettings.values()].map((setting) => setting.endsAt),
      ...[...this.state.circles.values()].map((circle) => circle.endsAt),
      ...this.state.ends.values(),
    ];
    for (const end of ends) if (end !== null && end > now && end < next) next = end;
    if (
      !waits("share ends") &&
      ends.some((end) => end !== null && end <= now) &&
      (this.expiredShares(now).length > 0 || this.expiredCards(now).length > 0)
    )
      next = now;
    // K-1126: a connected daemon keeps the 2-minute alarm going; without one, uptime wakes at most every 10 minutes.
    if (this.uptimeTargets().length > 0) next = Math.min(next, now + UPTIME_IDLE_MS);
    // K-1907: pushes that wait go out in the next second.
    if (this.pushQueue.length > 0) next = Math.min(next, now + 1000);
    // K-1910: the next machine that reaches 15 minutes offline, and the next hourly check of the limits.
    const offlineAt = this.nextOfflineAt(now);
    if (offlineAt !== null && !waits("offline")) next = Math.min(next, offlineAt);
    if (this.env.CLOUDFLARE_API_TOKEN) next = Math.min(next, Math.max(now, this.limitsCheckAt()));
    const bellEnd = this.nextBellEnd(now);
    if (bellEnd !== null && !waits("bell")) next = Math.min(next, bellEnd);
    // Never move a pending alarm later: frequent wake-ups would otherwise push it away for good.
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= now || next < current) await this.ctx.storage.setAlarm(next);
  }

  private dailyAt() {
    const [row] = this.sql<{ value: string }>("SELECT value FROM meta WHERE key = 'daily_at'");
    if (row) return Number(row.value);
    const at = nextUtcMidnight(Date.now());
    this.sql("INSERT INTO meta (key, value) VALUES ('daily_at', ?)", String(at));
    return at;
  }

  private expiredShares(now: number) {
    return [...this.state.shareSettings.entries()].filter(([id, setting]) => {
      if (setting.endsAt === null || setting.endsAt > now || this.stuckShares.has(id)) return false;
      const [resourceId, circleId] = id.split("/");
      return circlesHolding(this.state, resourceId ?? "").some((circle) => circle.id === circleId);
    });
  }

  /** K-212: the timed cards whose end time passed; a card that could not leave waits in `stuckShares`. */
  private expiredCards(now: number) {
    return [...this.state.ends]
      .filter(([id, end]) => end <= now && !this.stuckShares.has(id))
      .map(([id]) => id);
  }

  /**
   * K-212: the end of a timed card, from the alarm or from "End now": one revision that moves it to the tray, out
   * of every circle and its stack, with no end time left. History names the end.
   */
  private endCard(actor: Actor, id: string): number | null {
    const resource = this.state.resources.get(id);
    if (!resource) throw new RuleError(`No card "${id}" exists.`);
    const changes = resolveEdits(this.state, [
      { _tag: "place", id, after: null },
      { _tag: "cardEnd", id, after: null },
    ]);
    const after = applyChanges(this.state, changes);
    const shares =
      shareDiff(this.state, after).length > 0 ? `: ${summarize(this.state, after, changes)}` : "";
    return this.commit(actor, changes, null, `Time of ${resource.name} ended${shares}`);
  }

  /** K-209: at its end date, a share moves its card out of the circle as a new revision. K-212: a timed card goes to the tray. */
  private endShares(now: number) {
    for (const id of this.expiredCards(now)) {
      const name = this.state.resources.get(id)?.name ?? id;
      // The end runs as the actor who set the time, so that actor can undo it (K-1506).
      const [row] = this.sql<{ set_by: string | null }>("SELECT set_by FROM card_ends WHERE id = ?", id);
      const actor: Actor = row?.set_by
        ? (JSON.parse(row.set_by) as Actor)
        : { _tag: "kitshn", reason: `time of ${name} ended` };
      try {
        this.endCard(actor, id);
      } catch (error) {
        // The card gives no access after its end time already (K-212); only its place stays.
        this.stuckShares.add(id);
        console.warn(`kitshn could not end the time of ${id}: ${String(error)}`);
      }
    }
    for (const [id, setting] of this.expiredShares(now)) {
      const [resourceId = "", circleId = ""] = id.split("/");
      const from = this.state.places.get(resourceId);
      if (!from) continue;
      const keep = new Set(circlesHolding(this.state, resourceId).map((circle) => circle.id));
      keep.delete(circleId);
      const to = placeInside(this.state, from, keep);
      const circle = this.state.circles.get(circleId);
      try {
        if (!to) throw new RuleError("no place outside the circle keeps the other shares");
        this.commit(
          { _tag: "kitshn", reason: `share with ${circle?.name ?? circleId} ended` },
          resolveEdits(this.state, [
            // K-521: the card leaves its stack, so the rest of the stack stays where it is.
            ...stacksWithout(this.state.stacks.values(), resourceId).map((change): Edit => ({
              _tag: "stack",
              ...change,
            })),
            { _tag: "place", id: resourceId, after: to },
            { _tag: "shareSetting", resourceId, circleId, after: { ...setting, endsAt: null } },
          ]),
          null,
        );
      } catch (error) {
        // The share already gives no access after its end date; only the card stays where it is.
        this.stuckShares.add(id);
        console.warn(`kitshn could not move ${resourceId} out of ${circleId}: ${String(error)}`);
      }
    }
  }

  private daily(now: number) {
    this.ctx.storage.transactionSync(() => {
      // K-1127: a handover that no push used goes.
      this.sql("DELETE FROM handovers WHERE expires_at <= ?", now);
      this.sql(
        `DELETE FROM revisions WHERE at < ? OR id <= (SELECT id FROM revisions ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        now - REVISION_DAYS * DAY,
        REVISION_COUNT,
      );
      // K-408: retry what failed once a day.
      this.sql("UPDATE access_objects SET error = NULL WHERE error IS NOT NULL");
      this.sql("DELETE FROM meta WHERE key = 'launcher_failed'");
      this.sql("DELETE FROM meta WHERE key = 'login_failed'");
      this.sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('login_check', 'due')");
      // A refused address may be free now, for example after the other machine let it go.
      this.sql("UPDATE live_sites SET state = 'checking' WHERE state = 'refused'");
      // K-1503 style clean-up: keep the newest 1,000 finished jobs.
      this.sql(
        "DELETE FROM jobs WHERE state NOT IN ('queued', 'sent') AND id <= (SELECT id FROM jobs ORDER BY id DESC LIMIT 1 OFFSET 1000)",
      );
      this.sql("DELETE FROM join_codes WHERE expires_at < ?", now);
      this.sql("DELETE FROM device_invites WHERE expires_at < ?", now);
      // K-722: a run lasts at most 3,600 s and an approval 24 hours, so a row that a restart left with no socket goes.
      this.sql(
        "DELETE FROM exec_runs WHERE (state = 'running' AND started_at < ?) OR started_at < ?",
        now - 70 * 60_000,
        now - 25 * 60 * 60_000,
      );
      // K-1610: link events stay 30 days, at most 2,000.
      this.sql(
        "DELETE FROM link_events WHERE at < ? OR id <= (SELECT id FROM link_events ORDER BY id DESC LIMIT 1 OFFSET 2000)",
        now - 30 * DAY,
      );
      // K-1717: ask events stay 30 days, at most 5,000; a decided proposal stays as long.
      this.sql(
        "DELETE FROM ask_events WHERE at < ? OR id <= (SELECT id FROM ask_events ORDER BY id DESC LIMIT 1 OFFSET ?)",
        now - ASK_EVENT_DAYS * DAY,
        ASK_EVENT_COUNT,
      );
      this.sql(
        "DELETE FROM proposals WHERE state != 'pending' AND decided_at < ?",
        now - ASK_EVENT_DAYS * DAY,
      );
      this.sql("DELETE FROM ask_labels WHERE event_id < (SELECT MIN(id) FROM ask_events)");
      this.sql("DELETE FROM rekey_codes WHERE expires_at < ?", now);
      // K-1901, K-1905: closed notifications stay 30 days and 500 at most; an ended mute goes.
      this.sql(
        `DELETE FROM notifications WHERE closed_at IS NOT NULL AND (closed_at < ? OR id <= (SELECT id FROM notifications
         ORDER BY id DESC LIMIT 1 OFFSET ?))`,
        now - NOTIFICATIONS_KEEP_MS,
        NOTIFICATIONS_MAX,
      );
      this.sql("DELETE FROM notification_mutes WHERE until IS NOT NULL AND until < ?", now);
      // K-1905: an info notification closes itself after a day, so it never waits for a Dismiss.
      for (const notification of this.openNotifications.values())
        if (notification.level === "info" && notification.openedAt < now - INFO_OPEN_MS)
          this.setNotificationState(notification.source, notification.key, "closed", now);
      // K-1908: a removed app card loses its notify tokens here, so a quick Undo keeps them.
      this.sql("DELETE FROM notify_tokens WHERE card_id NOT IN (SELECT id FROM resources)");
      // A token whose deploy or job never reported back goes after a day.
      this.sql("DELETE FROM notify_tokens WHERE pending IS NOT NULL AND created_at < ?", now - DAY);
      this.muteCache = null;
      // K-1113: a removed card keeps its icon until this run, so a quick Undo keeps it; a deploy sends it again.
      for (const { id } of this.sql<{ id: string }>(
        "DELETE FROM icons WHERE id NOT IN (SELECT id FROM resources) RETURNING id",
      )) {
        // The same id can get a card again (K-1114), so memory forgets the icon too.
        this.iconHashes.delete(id);
        this.iconChangedAt.delete(id);
      }
      // K-1126: changes stay 30 days; a removed card loses its uptime here, so a quick Undo keeps it.
      this.sql(
        "DELETE FROM uptime_changes WHERE at < ? OR card_id NOT IN (SELECT id FROM resources)",
        now - UPTIME_KEEP_MS,
      );
      for (const { card_id } of this.sql<{ card_id: string }>(
        "DELETE FROM uptime WHERE card_id NOT IN (SELECT id FROM resources) RETURNING card_id",
      ))
        this.uptimeCache?.delete(card_id);
      this.sql(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('daily_at', ?)",
        String(nextUtcMidnight(now)),
      );
    });
    for (const row of this.access.values()) if (row.error) this.access.set(row.key, { ...row, error: null });
    this.load();
  }

  /** K-110: ends every session of every application that kitshn made. */
  private async signOut(caller: Caller) {
    const busy = this.signOutBusy();
    if (busy) return busy;
    // K-110: the Worker checks pages and files itself, so it refuses every login from before this second.
    this.setMeta("signed_out_at", String(Math.floor(Date.now() / 1000) * 1000));
    // K-1606, K-1907: no browser keeps getting pushes after Sign out everywhere.
    this.sql("DELETE FROM push_subscriptions");
    // K-110: no confirm in the map, so History records the start before any Cloudflare call, and the outcome.
    this.recordRevision(caller.actor, "Sign out everywhere: kitshn refuses older page and file logins");
    return this.finishSignOut(caller, false, async (api) => {
      const apps = await this.listSessionApps(api);
      return "listFailed" in apps ? apps : revokeSessions(api, this.env.CLOUDFLARE_ACCOUNT_ID, apps);
    });
  }

  /** K-110: revokes the sessions that the last sign-out left, or starts over when it could not list them. */
  private async retrySignOut(caller: Caller) {
    const busy = this.signOutBusy();
    if (busy) return busy;
    const left = this.signOutLeft();
    if (!left)
      return Response.json({ error: "Every session of the last sign-out ended already." }, { status: 409 });
    return this.finishSignOut(caller, true, async (api) => {
      const apps = await this.listSessionApps(api);
      if ("listFailed" in apps) return apps;
      return revokeSessions(
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        "listFailed" in left ? apps : retryApps(left.left, apps),
      );
    });
  }

  /** K-110: one sign-out or retry at a time, so a slow run never overwrites the outcome of a newer one. */
  private signOutBusy(): Response | null {
    const since = Number(this.meta("sign_out_running") || 0);
    if (Date.now() - since < SIGN_OUT_RUN_MS)
      return Response.json(
        { error: "A sign-out everywhere runs already. Try again in a minute." },
        { status: 409 },
      );
    return null;
  }

  /** K-110: the applications whose sessions a sign-out ends, or why kitshn could not list them. */
  private async listSessionApps(
    api: Api,
  ): Promise<
    | Array<{ readonly key: string; readonly cfId: string }>
    | { readonly ended: 0; readonly listFailed: string }
  > {
    const logins = new Set(
      ["pages", "files"].flatMap((host) => [
        `${host}.${this.env.KITSHN_ZONE}/login`,
        `${host}.${this.env.KITSHN_ZONE}/login/passkey`,
      ]),
    );
    try {
      const all = await api<Array<{ id: string; name: string; domain: string }>>(
        "GET",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/apps?per_page=1000`,
      );
      const loginApps = all
        .filter((app) => logins.has(app.domain) && app.name.startsWith(ACCESS_NAME_PREFIX))
        .map((app) => ({ key: app.domain, cfId: app.id }));
      return sessionApps(this.accessStore(), loginApps);
    } catch (error) {
      return { ended: 0, listFailed: String(error) };
    }
  }

  /** K-110: stores what is left (the warning with Retry) and records the outcome in History. */
  private async finishSignOut(caller: Caller, retry: boolean, run: (api: Api) => Promise<SignOutOutcome>) {
    const api = this.api();
    this.setMeta("sign_out_running", String(Date.now()));
    let outcome: SignOutOutcome;
    try {
      outcome = api ? await run(api) : { ended: 0, listFailed: "kitshn has no Cloudflare API token here" };
    } finally {
      this.setMeta("sign_out_running", "");
    }
    this.setMeta("sign_out_left", signOutWarning(outcome) ? JSON.stringify(outcome) : "");
    this.recordRevision(caller.actor, signOutSummary(outcome, retry));
    return "listFailed" in outcome
      ? Response.json({ error: signOutWarning(outcome) }, { status: 502 })
      : Response.json({
          ended: outcome.ended,
          failed: outcome.left.map((app) => `${app.key}: ${app.reason}`),
        });
  }

  /** K-110: what the last sign-out left to do, or null when every session ended. */
  private signOutLeft(): SignOutOutcome | null {
    return readSignOutLeft(this.meta("sign_out_left"));
  }

  /**
   * A revision without changes, also into the in-memory History list. It never calls `load()`, which would
   * swap the Access map under a sync that awaits Cloudflare.
   */
  private recordRevision(actor: Actor, summary: string) {
    const id = this.insertRevision(actor, summary, [], null);
    this.showRevision({
      id,
      at: Date.now(),
      actor,
      summary,
      undoes: null,
      undoSource: null,
      undoneBy: null,
      undoable: false,
      ...revisionTargets([]),
    });
  }

  /** Puts a new revision at the top of the in-memory History (K-519), marks what it undoes, and tells everyone. */
  private showRevision(revision: RevisionView) {
    this.revisionCache &&= [
      revision,
      ...this.revisionCache.map((old) =>
        old.id === revision.undoes ? { ...old, undoneBy: revision.id } : old,
      ),
    ].slice(0, RECENT_REVISIONS);
    this.broadcast();
  }

  /** K-1303, K-1305: the free plan use of the account; one read per 5 minutes at most. */
  private async readUsage(): Promise<Response> {
    const now = Date.now();
    if (this.usage && now - this.usage.at < USAGE_CACHE_MS) return Response.json(this.usage);
    const token = this.env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      if (this.env.DEV_DEMO && this.env.KITSHN_HOST === "localhost") return Response.json(demoUsage(now));
      return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    }
    this.usage = await readUsage(token, this.env.CLOUDFLARE_ACCOUNT_ID, zonesOrMain(this.env), now);
    return Response.json(this.usage);
  }

  /** K-106: the Access service tokens of the account, to pick a device member. */
  private async listDevices() {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    try {
      const tokens = await api<Array<{ id: string; name: string; client_id: string }>>(
        "GET",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens?per_page=1000`,
      );
      return Response.json(
        tokens.map((token) => ({ tokenId: token.id, clientId: token.client_id, name: token.name })),
      );
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /** K-106: one new service token per device. The secret shows once and kitshn does not keep it. */
  private async addDevice(body: unknown) {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const name = typeof body === "object" && body !== null && "name" in body ? String(body.name).trim() : "";
    if (!name || name.length > 60)
      return Response.json({ error: "Give the device a name of 1 to 60 characters." }, { status: 400 });
    try {
      const token = await api<{ id: string; client_id: string; client_secret: string }>(
        "POST",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens`,
        { name: `${DEVICE_TOKEN_PREFIX}${name}`, duration: "8760h" },
      );
      return Response.json({
        tokenId: token.id,
        clientId: token.client_id,
        clientSecret: token.client_secret,
        name,
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /**
   * K-1601: invites of phone and desktop apps, for the Owner circle only. An invite makes no secret that kitshn keeps:
   * a new device token drops its secret, and the exchange rotates it. A cancel never touches a token.
   */
  private async inviteRequest(path: string, request: Request, caller: Caller): Promise<Response> {
    if (!this.isOwner(caller.visitor))
      return Response.json(
        { error: "Only the owner makes or cancels a device invite (K-1601)." },
        { status: 403 },
      );
    if (path === "/api/devices/invites" && request.method === "POST")
      return this.addInvite(caller, await request.json().catch(() => null));
    if (path.startsWith("/api/devices/invites/") && request.method === "DELETE") {
      const tokenId = decodeURIComponent(path.slice("/api/devices/invites/".length));
      const [row] = this.sql<{ name: string }>("SELECT name FROM device_invites WHERE token_id = ?", tokenId);
      if (!row) return Response.json({ error: "No invite of this device waits." }, { status: 404 });
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM device_invites WHERE token_id = ?", tokenId);
        this.insertRevision(caller.actor, `Cancelled the invite of ${row.name}`, [], null);
      });
      this.load();
      this.broadcast();
      return Response.json({ ok: true });
    }
    return new Response("Not found.", { status: 404 });
  }

  /** K-1601: a new device token and its invite (`name`), or a new invite of a kitshn device token (`tokenId`). */
  private async addInvite(caller: Caller, body: unknown) {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const fields = isRecord(body) ? body : {};
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens`;
    let token: { id: string; client_id: string; name: string };
    let name: string;
    try {
      if (typeof fields.tokenId === "string" && fields.tokenId !== "") {
        token = await api<{ id: string; client_id: string; name: string }>(
          "GET",
          `${account}/${encodeURIComponent(fields.tokenId)}`,
        );
        // A machine token or a token of someone else never moves to an app.
        if (!token.name.startsWith(DEVICE_TOKEN_PREFIX))
          return Response.json({ error: "This token is no kitshn device token." }, { status: 400 });
        name = token.name.slice(DEVICE_TOKEN_PREFIX.length);
      } else {
        name = typeof fields.name === "string" ? fields.name.trim() : "";
        if (!name || name.length > 60)
          return Response.json({ error: "Give the device a name of 1 to 60 characters." }, { status: 400 });
        // The secret of the new token is dropped here; the exchange rotates it.
        token = await api<{ id: string; client_id: string; name: string }>("POST", account, {
          name: `${DEVICE_TOKEN_PREFIX}${name}`,
          duration: "8760h",
        });
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
    const code = newInviteCode();
    const expiresAt = Date.now() + DEVICE_INVITE_MS;
    const lookup = await joinLookup(code);
    this.ctx.storage.transactionSync(() => {
      // One invite per token: a new one ends the one that waits.
      this.sql("DELETE FROM device_invites WHERE token_id = ?", token.id);
      this.sql(
        "INSERT INTO device_invites (lookup, token_id, client_id, name, expires_at) VALUES (?, ?, ?, ?, ?)",
        lookup,
        token.id,
        token.client_id,
        name,
        expiresAt,
      );
      this.insertRevision(caller.actor, `Invited an app as ${name}`, [], null);
    });
    this.load();
    this.broadcast();
    const { clients, agree } = this.inviteClients();
    return Response.json({
      tokenId: token.id,
      clientId: token.client_id,
      name,
      link: `https://${this.env.KITSHN_HOST}/join/device#code=${code}`,
      expiresAt,
      clients,
      agree,
    });
  }

  /** K-720: the client apps that the providers of all machines declare, each with its machines (`inviteClients`). */
  private inviteClients() {
    const order = (id: string) => this.state.machines.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
    return inviteClients(
      [...this.providerRegs]
        .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
        .flatMap(([machineId, regs]) =>
          regs.map((reg) => ({
            machine: this.state.machines.get(machineId)?.name ?? machineId,
            provider: reg.name,
            clients: reg.clients ?? [],
          })),
        ),
    );
  }

  /**
   * K-1601: trades an invite code, once and within 15 minutes, for a new secret of its device token. The secret is
   * only in this answer. The row goes before the rotate, so two exchanges of one code never both get a secret.
   */
  private async exchangeInvite(request: Request) {
    const body = (await request.json().catch(() => null)) as { code?: unknown; device?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) return Response.json({ error: "Send the invite code." }, { status: 400 });
    const device = typeof body?.device === "string" ? body.device.trim().slice(0, 200) : "";
    const lookup = await joinLookup(code);
    const [row] = this.sql<InviteRow>("SELECT * FROM device_invites WHERE lookup = ?", lookup);
    if (!row)
      return Response.json(
        {
          error:
            "This invite code is used, cancelled or unknown. A code works once, also when its answer got lost. Ask the owner for a new invite.",
        },
        { status: 404 },
      );
    if (row.expires_at < Date.now()) {
      this.sql("DELETE FROM device_invites WHERE lookup = ?", lookup);
      return Response.json({ error: "This invite expired. Ask for a new one." }, { status: 410 });
    }
    if (this.state.paused)
      return Response.json(
        { error: "kitshn is paused. Try the invite again after Resume." },
        { status: 423 },
      );
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    this.sql("DELETE FROM device_invites WHERE lookup = ?", lookup);
    let secret: string;
    try {
      // No grace period: the secret of an older invite of this device ends now.
      secret = (
        await api<{ client_secret: string }>(
          "POST",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens/${encodeURIComponent(row.token_id)}/rotate`,
          {},
        )
      ).client_secret;
    } catch (error) {
      // The code stays good, unless a newer invite of the device took its place meanwhile.
      this.sql(
        "INSERT OR IGNORE INTO device_invites (lookup, token_id, client_id, name, expires_at) VALUES (?, ?, ?, ?, ?)",
        row.lookup,
        row.token_id,
        row.client_id,
        row.name,
        row.expires_at,
      );
      return Response.json({ error: `Cloudflare made no new secret: ${String(error)}` }, { status: 502 });
    }
    // The secret is out, so a failed refresh must not lose it; the token then keeps its old expiry.
    let refreshed = true;
    try {
      // A new invite of an old token gives the app a full year, not what is left of the token's first year.
      await api(
        "POST",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens/${encodeURIComponent(row.token_id)}/refresh`,
      );
    } catch (error) {
      refreshed = false;
      console.error(`K-1601: the refresh of the device token ${row.token_id} failed: ${String(error)}`);
    }
    const actor: Actor = { _tag: "device", clientId: row.client_id, name: row.name };
    // `device` comes from the anonymous caller, so History marks it as the app's own words.
    this.insertRevision(
      actor,
      `${row.name} joined with an invite${device ? ` (the app says: ${device})` : ""}${refreshed ? "" : "; the token expiry did not refresh"}`,
      [],
      null,
    );
    this.load();
    this.broadcast();
    const visitor: Visitor = { email: null, clientId: row.client_id, ip: null };
    return Response.json({
      clientId: row.client_id,
      name: row.name,
      serviceToken: { clientId: row.client_id, clientSecret: secret },
      machines: this.deviceMachines(visitor).machines,
      machinesUrl: `https://${this.env.KITSHN_HOST}/device/machines`,
    });
  }

  /**
   * K-722: the code step of migration 42. Each `t3.agents` share moves to the `t3.app` card of its machine, and an
   * exec share turns on "runs commands" (`migrateAgentShares`), as one History revision that the owner can undo. A
   * share that it cannot move goes to the log and into the revision text, for the owner.
   */
  private migrateAgents() {
    // Its own mark, not the schema version, keeps it to one run: a second run would undo an owner's Undo.
    if (this.meta(AGENTS_MIGRATED) !== null) return;
    this.load();
    const { changes, unmet } = migrateAgentShares(this.state);
    this.setMeta(AGENTS_MIGRATED, String(Date.now()));
    if (changes.length === 0 && unmet.length === 0) return;
    this.persist(changes);
    for (const line of unmet) console.error(`K-722 migration 42: ${line}`);
    this.insertRevision(
      { _tag: "kitshn", reason: "provider protocol 2 (K-722)" },
      `Moved the T3 agents shares to the T3 app cards (K-722)${unmet.length > 0 ? `. ${unmet.join(" ")}` : ""}`,
      changes,
      null,
    );
  }

  /**
   * K-819: part of migration 6. Gives the deploy rows from before the gate their repo id, and allows each
   * repo that finished a deploy then. A row whose card id holds no repo id keeps none; kitshn logs it, and its
   * repo waits for the owner like a new one. A crash here would stop the whole Durable Object over one old row.
   */
  private backfillRepoIds() {
    const rows = this.sql<DeployRow>("SELECT * FROM deploys ORDER BY expires_at");
    const { repoIds, allowed, unknown } = legacyRepos(
      rows.map((row) => ({ ...row, resourceId: row.resource_id })),
    );
    for (const [deployId, repoId] of repoIds)
      this.sql("UPDATE deploys SET repo_id = ? WHERE id = ?", repoId, deployId);
    const now = Date.now();
    for (const [repoId, name] of allowed)
      this.sql(
        "INSERT OR IGNORE INTO repos (repo_id, name, state, first_seen) VALUES (?, ?, 'allowed', ?)",
        repoId,
        name,
        now,
      );
    if (unknown.length > 0)
      console.error(
        `K-819: the card ids of the deploys ${unknown.join(", ")} hold no repo id; their repos wait.`,
      );
  }

  /** K-819: refuses a deploy step of a repo that waits for the owner or that the owner blocked. */
  private repoGate(deployer: Deployer): Response | null {
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", deployer.repoId);
    const gate = row ? repoGateOf(row) : undefined;
    const decision = gateDecision(
      gate,
      {
        repoId: deployer.repoId,
        name: deployer.repo,
        branch: deployer.eventName === "push" ? deployer.branch : null,
        workflow: deployer.workflow,
      },
      Date.now(),
      gate !== undefined && this.keyRemoved(gate),
    );
    const record = decision.record;
    // K-819: a deploy step proves that the repo exists on GitHub.
    if (row && row.gone_at !== null && !record) {
      this.sql("UPDATE repos SET gone_at = NULL WHERE repo_id = ?", row.repo_id);
      this.broadcast();
    }
    if (record) {
      this.ctx.storage.transactionSync(() => {
        this.sql(
          `INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen, branch, workflow, allowed_by_client,
             allowed_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          record.repoId,
          record.name,
          record.state,
          record.firstSeen,
          record.branch,
          record.workflow,
          record.allowedBy?.clientId ?? null,
          record.allowedBy?.name ?? null,
        );
        if (!row)
          this.insertRevision(
            { _tag: "kitshn", reason: "repo gate" },
            `${record.name} waits to deploy (K-819)`,
            [],
            null,
          );
      });
      this.load();
      this.broadcast();
    }
    return decision.allow ? null : Response.json({ error: decision.error }, { status: 403 });
  }

  /** K-819: the cards on the map that each repo deployed. */
  private repoCards(): Map<string, Array<string>> {
    const cards = new Map<string, Array<string>>();
    for (const { repo_id, resource_id } of this.deploys().repoCards)
      if (this.state.resources.has(resource_id))
        cards.set(repo_id, [...(cards.get(repo_id) ?? []), resource_id]);
    return cards;
  }

  /** K-819: each repo with its cards on the map, for the card panel. */
  private repoViews(): Array<RepoView> {
    const cards = this.repoCards();
    return this.sql<RepoRow>("SELECT * FROM repos ORDER BY first_seen DESC").map((row) => {
      const gate = repoGateOf(row);
      const removed = this.keyRemoved(gate);
      // K-819: the repo of a removed key shows as waiting, so the owner sees it and takes it over.
      return {
        ...gate,
        state: removed ? "waiting" : gate.state,
        keyRemoved: removed,
        goneOnGitHub: row.gone_at !== null,
        resourceIds: cards.get(row.repo_id) ?? [],
      };
    });
  }

  /** K-819: the agent key that allowed this repo has no agent circle anymore (keyRemoved). */
  private keyRemoved(gate: RepoGate) {
    return keyRemoved(
      gate,
      (clientId) => circlesOf(this.state, { email: null, clientId, ip: null }, Date.now()).size > 0,
    );
  }

  /** K-819: the repo id of a card that a deploy made, or null when kitshn does not know it. */
  private repoIdOfCard(resourceId: string): string | null {
    const [row] = this.sql<{ repo_id: string }>(
      "SELECT repo_id FROM deploys WHERE resource_id = ? AND repo_id IS NOT NULL AND kind = 'deploy' LIMIT 1",
      resourceId,
    );
    return row?.repo_id ?? null;
  }

  /** K-819: the agent key that allowed this repo, or null when the owner allowed it. */
  private allowingAgent(repoId: string | null): AllowingAgent | null {
    const [row] = repoId === null ? [] : this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    return row ? repoGateOf(row).allowedBy : null;
  }

  /** K-819: why kitshn may not deploy this repo now, or null. A repo without a known id or a row waits. */
  private repoRefusal(repoId: string | null): string | null {
    if (repoId === null) return "kitshn does not know the repo of this deploy. Deploy it once from GitHub.";
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    if (row?.state === "allowed" && !this.keyRemoved(repoGateOf(row))) return null;
    return row?.state === "blocked"
      ? `The owner blocked deploys of ${row.name} on the kitshn map.`
      : `The repo ${row?.name ?? repoId} waits for the owner on the kitshn map.`;
  }

  /**
   * K-819: the owner allows, blocks or forgets one repo. Allow starts the first refused push through the
   * GitHub App, except during the pause. Block fails the repo's deploys and jobs that have not finished.
   * An agent key with "adds apps" allows a waiting repo too (K-718); `allowedBy` then names it.
   */
  private async setRepoState(
    caller: Caller,
    repoId: string,
    body: unknown,
    allowedBy: AllowingAgent | null = null,
  ) {
    const state = isRecord(body) ? body["state"] : null;
    if (state !== "allowed" && state !== "blocked" && state !== "forget")
      return Response.json({ error: 'Send {"state": "allowed" | "blocked" | "forget"}.' }, { status: 400 });
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    if (!row) return Response.json({ error: `kitshn knows no repo ${repoId}.` }, { status: 404 });
    const forgetError =
      state === "forget"
        ? forgetRefusal(
            {
              name: row.name,
              state: row.state,
              goneOnGitHub: row.gone_at !== null,
              keyRemoved: this.keyRemoved(repoGateOf(row)),
            },
            (this.repoCards().get(repoId) ?? []).length,
          )
        : null;
    if (forgetError) return Response.json({ error: forgetError }, { status: 409 });
    const stopped = this.ctx.storage.transactionSync(() => {
      // K-819: Forget stops what the repo has under way as Block does, then drops the row; the repo waits again.
      if (state === "forget") {
        this.sql("DELETE FROM repos WHERE repo_id = ?", repoId);
        this.insertRevision(caller.actor, `Forgot ${row.name} (K-819)`, [], null);
        return this.stopRepoDeploys(repoId, `The owner forgot ${row.name} (K-819).`);
      }
      // K-819: the owner's Allow takes over a repo that an agent key allowed, and clears the key.
      const takeOver = state === "allowed" && allowedBy === null && row.allowed_by_client !== null;
      if (row.state === state && !takeOver) return [];
      if (state === "allowed")
        this.sql(
          "UPDATE repos SET state = 'allowed', allowed_by_client = ?, allowed_by_name = ? WHERE repo_id = ?",
          allowedBy?.clientId ?? null,
          allowedBy?.name ?? null,
          repoId,
        );
      if (state === "blocked")
        this.sql(
          "UPDATE repos SET state = 'blocked', branch = NULL, workflow = NULL, allowed_by_client = NULL, allowed_by_name = NULL WHERE repo_id = ?",
          repoId,
        );
      this.insertRevision(
        caller.actor,
        takeOver && row.state === "allowed"
          ? `Took over deploys of ${row.name} from ${row.allowed_by_name ?? "an agent"} (K-819)`
          : `${state === "allowed" ? "Allowed" : "Blocked"} deploys of ${row.name} (K-819)`,
        [],
        null,
      );
      if (state === "allowed") return [];
      return this.stopRepoDeploys(repoId, `The owner blocked deploys of ${row.name} (K-819).`);
    });
    const files = stopped
      .filter(({ app }) => app === "compose")
      .flatMap(({ id }) => [deployObject(id, "source.tgz"), deployObject(id, "params.env")]);
    if (files.length > 0 && this.env.BUCKET) void this.env.BUCKET.delete(files);
    this.load();
    this.broadcast();
    if (state !== "allowed" || row.branch === null) return Response.json({ repoId, state });
    if (this.state.paused) return Response.json({ repoId, state, paused: row.branch });
    // The branch is the lock of the start: a second tab finds none and starts nothing.
    const branch = row.branch;
    const [claimed] = this.sql<{ repo_id: string }>(
      "UPDATE repos SET branch = NULL WHERE repo_id = ? AND branch = ? RETURNING repo_id",
      repoId,
      branch,
    );
    if (!claimed) return Response.json({ repoId, state });
    this.broadcast();
    const started = await this.agentBuild(caller, repoId, branch, row.workflow ?? AGENT_WORKFLOW);
    if (started.ok) return Response.json({ repoId, state, dispatched: branch });
    // A failed start gives the branch back, unless the owner blocked or forgot the repo meanwhile.
    this.sql(
      "UPDATE repos SET branch = ? WHERE repo_id = ? AND branch IS NULL AND state = 'allowed'",
      branch,
      repoId,
    );
    this.broadcast();
    return Response.json({
      repoId,
      state,
      dispatchError: ((await started.json()) as { error: string }).error,
    });
  }

  /** K-819: fails the deploys and jobs of a repo that have not finished. A teardown still runs. */
  private stopRepoDeploys(repoId: string, output: string) {
    // A daemon that already has the source can still finish its build.
    this.sql(
      `UPDATE jobs SET state = 'failed', output = ? WHERE state IN ('queued', 'sent')
       AND json_extract(command, '$.kind') != 'compose-down'
       AND json_extract(command, '$.project') IN (SELECT resource_id FROM deploys WHERE repo_id = ?)`,
      output,
      repoId,
    );
    const stopped = this.sql<{ id: string; app: string }>(
      `UPDATE deploys SET state = 'failed' WHERE repo_id = ? AND kind = 'deploy' AND state IN ('planned', 'running')
       RETURNING id, app`,
      repoId,
    );
    for (const { id } of stopped) this.settleDeployAction(id);
    return stopped;
  }

  /**
   * K-819: marks the repos that GitHub reports as deleted, and clears the mark of a repo that exists. The repo
   * list asks for it when it opens. Each repo gets at most one answer a day, and only an answer writes a row.
   */
  private async checkReposOnGitHub(): Promise<Response> {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key || this.checkingRepos) return Response.json({ checked: 0 });
    const now = Date.now();
    const due = this.sql<RepoRow>(
      "SELECT * FROM repos WHERE checked_at IS NULL OR checked_at <= ? ORDER BY coalesce(checked_at, 0)",
      now - DAY_MS,
    );
    if (due.length === 0) return Response.json({ checked: 0 });
    this.checkingRepos = true;
    let found: Map<string, RepoOnGitHub>;
    try {
      found = await reposOnGitHub(
        { id: appId, key },
        due.map((row) => ({ repoId: row.repo_id, name: row.name })),
        GITHUB_CALLS_PER_CHECK,
      );
    } finally {
      this.checkingRepos = false;
    }
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const row of due) {
        const answer = found.get(row.repo_id);
        // A skipped repo (the call budget ran out) waits for the next check; every answer counts as a check,
        // so an unknown repo never sorts first again and starves the others.
        if (answer === undefined) continue;
        const goneAt = answer === "gone" ? (row.gone_at ?? now) : answer === "unknown" ? row.gone_at : null;
        // A deploy step or Forget can change the row while GitHub answers; it then keeps what they wrote.
        const [updated] = this.sql<{ repo_id: string }>(
          "UPDATE repos SET checked_at = ?, gone_at = ? WHERE repo_id = ? AND gone_at IS ? RETURNING repo_id",
          now,
          goneAt,
          row.repo_id,
          row.gone_at,
        );
        if (!updated || goneAt === row.gone_at) continue;
        changed = true;
        this.insertRevision(
          { _tag: "kitshn", reason: "GitHub" },
          goneAt === null ? `GitHub reports ${row.name} again (K-819)` : `GitHub deleted ${row.name} (K-819)`,
          [],
          null,
        );
      }
    });
    if (changed) {
      this.load();
      this.broadcast();
    }
    return Response.json({ checked: [...found.values()].filter((answer) => answer !== "unknown").length });
  }

  /** K-803 to K-807, K-901 to K-904: the steps of a static site deploy from GitHub Actions. */
  private async deployStep(path: string, deployer: Deployer, body: unknown): Promise<Response> {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    try {
      if (path === "/deploy/plan") return await this.planDeploy(api, deployer, input);
      if (path === "/deploy/status") return this.composeStatus(deployer, String(input["deployId"] ?? ""));
      const [row] = this.sql<DeployRow>(
        "SELECT * FROM deploys WHERE id = ?",
        String(input["deployId"] ?? ""),
      );
      if (!row || row.repo_id !== deployer.repoId)
        return fail(404, "kitshn knows no such deploy of this repo.");
      // K-820: the CLI records why a deploy failed, so its card shows it; a deploy that already ended keeps its state.
      if (path === "/deploy/fail") {
        const reason =
          typeof input["reason"] === "string" ? input["reason"].slice(0, 500) : "The deploy failed.";
        // A running Compose deploy keeps running: its machine job decides the result and still lands, and the deploy
        // still holds off a second deploy and a removal (deployRuns). The give-up of the CLI stays as its reason.
        this.sql(
          `UPDATE deploys SET state = CASE WHEN state = 'running' THEN 'running' ELSE 'failed' END, reason = ?
           WHERE id = ? AND state IN ('planned', 'running', 'failed')`,
          reason,
          row.id,
        );
        this.settleDeployAction(row.id);
        this.broadcast();
        // K-817: a failed Compose deploy gives up the DNS record that its plan made.
        if (row.app === "compose") void this.scheduleAlarm();
        return Response.json({ ok: true });
      }
      if (row.expires_at < Date.now() || row.state !== "planned")
        return fail(410, "This deploy expired or ended. Run it again.");
      // A blocked repo still tears down what it made (K-819).
      const gate = row.kind === "teardown" ? null : this.repoGate(deployer);
      if (gate) return gate;
      if (path === "/deploy/assets" && row.kind === "deploy")
        return await this.deployCall(row, DEPLOY_STEP.upload, () =>
          this.deployAssets(api, row, input["manifest"]),
        );
      if (row.app === "worker" && row.kind === "deploy") {
        if (path === "/deploy/storage")
          return await this.deployCall(row, DEPLOY_STEP.storage, () => this.workerStorage(api, row));
        if (path === "/deploy/finish")
          return await this.deployCall(row, DEPLOY_STEP.live, () =>
            this.finishWorker(api, row, deployer, input),
          );
      }
      if (path === "/deploy/finish" && row.kind === "deploy")
        return await this.deployCall(row, DEPLOY_STEP.live, () =>
          this.finishDeploy(
            api,
            row,
            deployer,
            input["jwt"],
            input["icon"],
            input["headers"],
            input["redirects"],
          ),
        );
      if (row.app === "compose") {
        if (path === "/deploy/start" && row.kind === "deploy")
          return await this.startCompose(api, row, deployer);
        if (path === "/deploy/teardown" && row.kind === "teardown")
          return this.teardownCompose(row, deployer);
        return fail(400, `${path} does not fit a Compose deploy.`);
      }
      if (path === "/deploy/teardown" && row.kind === "teardown")
        return await this.teardown(api, row, deployer);
      return fail(400, `${path} does not fit this deploy.`);
    } catch (error) {
      if (error instanceof RuleError) return fail(400, error.message);
      return fail(502, `kitshn could not finish the step: ${String(error)}`);
    }
  }

  /**
   * K-817, K-408: why a card may not take these addresses, or null. With `onCloudflare`, it also refuses a
   * hostname that another Worker, a foreign Access application or a DNS record that kitshn did not make holds.
   */
  /**
   * Why another card holds `address`, or null: it is another card's address, a folder site plan holds it (K-1123), or
   * it sends visitors on to another card (K-1124). Deploys and provider cards (K-705) check the same rules.
   */
  private addressTaken(address: string, resourceId: string): string | null {
    // An existing site or redirect keeps a name that predates this reservation. A new card cannot take it.
    const ownAddress = this.state.resources.get(resourceId)?.addresses.includes(address) === true;
    const ownSite = this.liveSites.get(resourceId)?.address === address;
    const ownRedirect = this.oldAddresses().some(
      (item) => item.address === address && item.cardId === resourceId,
    );
    if (reservedSiteLinkHost(address, this.env.KITSHN_ZONE) && !ownAddress && !ownSite && !ownRedirect)
      return `${address} is reserved for a kitshn machine link.`;
    const other = [...this.state.resources.values()].find(
      (resource) => resource.id !== resourceId && resource.addresses.includes(address),
    );
    if (other) return `${address} belongs to the card ${other.name}.`;
    // K-1123: a folder site plan holds its address until its files arrive or the plan expires.
    if (
      this.heldSiteAddresses(Date.now()).some((row) => row.address === address && row.card_id !== resourceId)
    )
      return `${address} is held by a folder site that is being published (K-1123).`;
    // K-1124: an old address of another card sends its visitors on to that card until it goes free (K-1122).
    const sends = this.oldAddresses().find((item) => item.address === address && item.cardId !== resourceId);
    const sendsFor = sends ? this.state.resources.get(sends.cardId) : undefined;
    if (sendsFor) return `${address} sends visitors on to the card ${sendsFor.name} (K-1124).`;
    return null;
  }

  private async addressRefusal(
    api: Api,
    addresses: ReadonlyArray<string>,
    resourceId: string,
    script: string,
    existing: Resource | undefined,
    onCloudflare: boolean,
  ): Promise<Response | null> {
    const zones = zonesOf(this.env);
    for (const address of addresses) {
      const refusal = this.addressTaken(address, resourceId);
      if (refusal) return Response.json({ error: refusal }, { status: 409 });
    }
    if (!onCloudflare) return null;
    // Never take over a hostname that another Worker serves, or that a foreign Access app covers (K-408).
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const apps = await api<Array<{ name: string; domain?: string }>>(
      "GET",
      `${account}/access/apps?per_page=1000`,
    );
    for (const address of addresses) {
      const domains = await api<Array<{ service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      // An old address of this same card that comes back: the deploy takes it off the redirect Worker.
      const [own] = this.sql(
        "SELECT 1 FROM old_addresses WHERE address = ? AND card_id = ?",
        address,
        resourceId,
      );
      const foreign = domains.find(
        (domain) => domain.service !== script && !(own && domain.service === REDIRECT_SCRIPT),
      );
      if (foreign) {
        return Response.json(
          { error: `${address} already serves the Worker ${foreign.service}.` },
          { status: 409 },
        );
      }
      const foreignApp = apps.find((app) => app.domain === address && !app.name.startsWith("kitshn "));
      if (foreignApp) {
        return Response.json(
          {
            error: `The Access application "${foreignApp.name}" covers ${address}; kitshn does not change it.`,
          },
          { status: 409 },
        );
      }
      // Only an address that nothing uses yet: kitshn never takes over a record that it did not make (K-817).
      // A record that kitshn made for this same card (an address that comes back before its record went) is fine.
      if (existing?.addresses.includes(address)) continue;
      const [kitshnRow] = this.sql<{ card_id: string | null }>(
        "SELECT card_id FROM dns_objects WHERE address = ? AND record_id != ''",
        address,
      );
      if (kitshnRow?.card_id === resourceId) continue;
      const zone = zoneFor(address, zones);
      if (!zone)
        return Response.json(
          { error: `kitshn does not publish on the zone of ${address} (K-1111).` },
          { status: 409 },
        );
      const records = await api<Array<{ type: string }>>(
        "GET",
        `/zones/${zone.id}/dns_records?name=${encodeURIComponent(address)}`,
      );
      const refusal = dnsRecordRefusal(address, addressRecords(records), kitshnRow, resourceId);
      if (refusal) return Response.json({ error: refusal }, { status: 409 });
    }
    return null;
  }

  private async planDeploy(api: Api, deployer: Deployer, input: Record<string, unknown>) {
    let recipe: Recipe;
    try {
      recipe = decodeRecipe(input["recipe"]);
    } catch (error) {
      return Response.json(
        { error: `The recipe does not match the schema (K-803): ${String(error)}` },
        { status: 400 },
      );
    }
    const event = eventOf(deployer, input["event"]);
    if (typeof event === "string") return Response.json({ error: event }, { status: 400 });
    // K-1767: a push or a pull request of the kitshn App never deploys by itself. A push waits for a deploy ask, which
    // builds by workflow_dispatch; a pull request waits for the owner's Deploy of its run's commit.
    const bot =
      deployer.actor.endsWith("[bot]") && deployer.eventName !== "workflow_dispatch"
        ? await this.appBot()
        : null;
    // Fails closed: with an App but no known bot name, any bot push or pull request waits.
    if (bot === "unknown")
      return Response.json(
        {
          error: "kitshn cannot read the bot name of its App, so a bot run waits. Try again later (K-1767).",
        },
        { status: 409 },
      );
    if (bot !== null && deployer.actor === bot) {
      if (deployer.eventName === "pull_request" && deployer.pr !== null) {
        const [run] = this.sql<{ approved: number }>(
          "SELECT approved FROM bot_runs WHERE repo_id = ? AND pr = ? AND sha = ?",
          deployer.repoId,
          deployer.pr,
          deployer.sha,
        );
        if (run?.approved !== 1) {
          this.sql(
            `INSERT OR REPLACE INTO bot_runs (repo_id, repo, pr, sha, run_id, at, approved) VALUES (?, ?, ?, ?, ?, ?, 0)`,
            deployer.repoId,
            deployer.repo,
            deployer.pr,
            deployer.sha,
            deployer.runId,
            Date.now(),
          );
          this.broadcast();
          return Response.json(
            {
              error: `This pull request of the kitshn App waits for a deploy click: Deploy in the map panel (K-1767).`,
            },
            { status: 409 },
          );
        }
      } else
        return Response.json(
          {
            error: `This push of the kitshn App waits for a deploy ask: kitshn agent deploy <card> --body '{"mode":"build"}' (K-1767).`,
          },
          { status: 409 },
        );
    }
    // K-804: a CLI from before several apps sends no key; its one app is the app `app`.
    const key = input["key"] ?? DEFAULT_APP;
    if (!Schema.is(AppKey)(key))
      return Response.json(
        { error: "The app key is a lowercase letter, then up to 19 letters or digits (K-804)." },
        { status: 400 },
      );
    const skip = input["skip"];
    if (skip !== undefined && (typeof skip !== "string" || skip === "" || skip.length > 500))
      return Response.json(
        { error: "A skip reason is text of at most 500 characters (K-820)." },
        { status: 400 },
      );
    const zones = zonesOrMain(this.env);
    const result = plan(
      recipe,
      deployer.repo,
      event,
      this.env.KITSHN_ZONE,
      zones.slice(1).map((zone) => zone.name),
      key,
    );
    if (result.kind === "error") return Response.json({ error: result.reason }, { status: 400 });
    if (result.kind === "skip") return Response.json({ deployId: null, plan: result });
    // K-1504: no new deploy while paused; a teardown still runs, because it only lowers access.
    if (result.kind === "deploy" && this.state.paused)
      return Response.json(
        { error: "kitshn is paused (Emergency pause). Deploys wait until the owner resumes." },
        { status: 423 },
      );
    // A blocked repo still tears down what it made (K-819).
    // K-1127: the first push event of a handed-over repo, which kitshn does not know yet, takes the card. Only a push
    // event counts, never a dispatch (K-1767). Nothing changes until the plan passes every check below.
    const handover =
      result.kind === "deploy" &&
      deployer.eventName === "push" &&
      !result.ephemeral &&
      this.sql("SELECT 1 FROM repos WHERE repo_id = ?", deployer.repoId).length === 0
        ? this.usableHandover(deployer)
        : null;
    const gate = result.kind === "teardown" || handover ? null : this.repoGate(deployer);
    if (gate) return gate;
    const [mapped] = this.sql<{ card_id: string }>(
      "SELECT card_id FROM repo_cards WHERE repo_id = ? AND app_key = ? AND environment = ?",
      deployer.repoId,
      key,
      result.environment,
    );
    let { resourceId, script } = mapped
      ? { resourceId: mapped.card_id, script: `kitshn-${mapped.card_id}` }
      : environmentNames(deployer.repoId, deployer.repo, result.environment, key);
    if (!mapped && handover) {
      resourceId = handover.card_id;
      script = `kitshn-${handover.card_id}`;
    }
    // K-804: a card belongs to one app of its repo; two apps whose long ids hash alike never share it.
    const [owner] = this.sql<{ app_key: string; repo_id: string | null }>(
      "SELECT app_key, repo_id FROM deploys WHERE resource_id = ? ORDER BY rowid DESC LIMIT 1",
      resourceId,
    );
    if (owner && (owner.app_key !== key || (owner.repo_id !== null && owner.repo_id !== deployer.repoId)))
      return Response.json(
        {
          error: `The card ${resourceId} belongs to another app (${owner.app_key}); give this app another key.`,
        },
        { status: 409 },
      );
    // A handed-over page plans as the static site that it becomes.
    const found = this.state.resources.get(resourceId);
    const existing =
      handover && found?.kind === "page"
        ? { ...found, kind: "site.static" as const, addresses: handover.addresses }
        : found;
    if (this.deletingStorage.has(resourceId))
      return Response.json(
        { error: `kitshn deletes the storage of ${resourceId} now. Deploy again after it finishes (K-909).` },
        { status: 409 },
      );
    // K-804: a card keeps its kind, because its removal and its teardown follow the kind. A deploy of another kind
    // would leave the old app running behind a card that cannot take it down.
    const kind = "compose" in recipe ? "site.compose" : "worker" in recipe ? "site.worker" : "site.static";
    if (existing && existing.kind !== kind)
      return Response.json(
        {
          error: `${existing.name} is a ${existing.kind} card, and the recipe makes a ${kind}. Remove the app on the map first (K-909).`,
        },
        { status: 409 },
      );
    // K-811: a number that only the request names may close a preview, and only the one that this head
    // branch deployed itself.
    if ("claimed" in event && event.claimed) {
      const [own] = this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND branch = ? LIMIT 1",
        resourceId,
        event.branch,
      );
      // GitHub gives no token to pull requests from forks, so the head branch names a branch of this repo.
      if (result.kind !== "teardown" || !own || event.branch === "") {
        return Response.json({
          deployId: null,
          plan: {
            kind: "skip",
            reason: `The token names no pull request, and ${event.branch || "this run"} deployed no preview pr-${event.pr}; remove it on the map.`,
          },
        });
      }
    }
    // K-820: an app whose needed app did not deploy records why, so its card shows it, and changes nothing.
    if (typeof skip === "string" && result.kind === "deploy") {
      this.sql(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, addresses, app_key, reason, run_id, run_attempt, needs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deploy', ?, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        deployer.repo,
        deployer.repoId,
        result.environment,
        resourceId,
        result.address,
        script,
        result.startsIn,
        deployer.sha,
        Date.now() + DEPLOY_MS,
        event.branch,
        "compose" in recipe ? "compose" : "worker" in recipe ? "worker" : "static",
        JSON.stringify(result.addresses),
        key,
        skip,
        deployer.runId,
        deployer.runAttempt,
        JSON.stringify(recipe.needs?.apps ?? []),
      );
      this.broadcast();
      return Response.json({ deployId: null, plan: { kind: "skip", reason: skip } });
    }
    const compose = "compose" in recipe ? recipe.compose : null;
    // K-819: the Compose apps of a repo that an agent key allowed run only where that key may run jobs.
    const allowedBy = this.allowingAgent(deployer.repoId);
    const agentLimit = allowedBy
      ? ` The agent ${allowedBy.name} allowed this repo, so it deploys only to a machine whose card, and every card on it, that agent manages (K-819).`
      : "";
    // K-610, K-611: a new Compose app goes to the first online machine with all labels; a running one stays.
    let machineId: string | null = null;
    if (compose) {
      if (existing?.machine) {
        // K-611: a running app stays on its machine, but only while the owner still offers it (K-610).
        if (!this.state.machines.get(existing.machine)?.labels.includes("deploy")) {
          return Response.json(
            {
              error: `${existing.name} runs on a machine without the label "deploy". Label it again, or remove the card to deploy elsewhere.`,
            },
            { status: 409 },
          );
        }
        // A teardown skips the agent machine check (K-819); the label and address checks still apply.
        if (
          result.kind === "deploy" &&
          !mayDeployOn(this.state, allowedBy?.clientId ?? null, existing.machine, Date.now())
        )
          return Response.json(
            { error: `${existing.name} runs on a machine that it may no longer use.${agentLimit}` },
            { status: 409 },
          );
        machineId = existing.machine;
        const running = this.state.machines.get(existing.machine);
        if (
          result.kind === "deploy" &&
          running &&
          !this.machineView(running).status?.capabilities?.includes("compose-guard")
        )
          return Response.json(
            {
              error: missingFeature(
                this.machineView(running).status,
                running.name,
                "Compose apps",
                `Update the daemon on ${running.name} first: it does not check Compose settings yet (K-818).`,
              ),
            },
            { status: 409 },
          );
      } else if (result.kind === "deploy") {
        const labels = compose.runsOn ?? [];
        // K-1708: a machine without a key is online for status only and gets no job.
        const ready = this.jobMachines();
        const pick = [...this.state.machines.values()]
          // Only a machine that the owner labels "deploy" runs the apps of repos (K-610).
          .filter((machine) => ["deploy", ...labels].every((label) => machine.labels.includes(label)))
          // K-818: only a daemon that checks Compose settings runs the apps of repos.
          .filter((machine) => this.machineView(machine).status?.capabilities?.includes("compose-guard"))
          .filter((machine) => mayDeployOn(this.state, allowedBy?.clientId ?? null, machine.id, Date.now()))
          .sort((a, b) => a.order - b.order)
          .find((machine) => ready.has(machine.id));
        if (!pick) {
          return Response.json(
            {
              error: `No online machine with a Compose-ready daemon has the labels ${["deploy", ...labels].join(", ")}. Label a machine "deploy", update its daemon, start it, or give it a key (K-1708).${agentLimit}`,
            },
            { status: 409 },
          );
        }
        machineId = pick.id;
      }
    }
    // K-1124: a static site or a Worker app moves, and its old address sends visitors on. A Compose app keeps its main
    // address, because its machine serves it under that name (K-1104).
    if (existing?.kind === "site.compose" && existing.addresses[0] !== result.address) {
      return Response.json(
        {
          error: `${result.environment} lives at ${existing.addresses[0]}. A Compose app keeps its main address; to move it, remove its card on the map first.`,
        },
        { status: 409 },
      );
    }
    // K-817, K-1209: the plan refuses kitshn's own names; the admin hosts can have other names, the main address too.
    const adminHost = result.addresses.find((address) => adminHosts(this.env).includes(address));
    if (adminHost)
      return Response.json({ error: `${adminHost} is the kitshn admin host (K-817).` }, { status: 409 });
    const addressRefused = await this.addressRefusal(
      api,
      result.addresses,
      resourceId,
      script,
      existing,
      result.kind === "deploy",
    );
    if (addressRefused) return addressRefused;
    if (result.kind === "deploy" && !existing) {
      if (result.ephemeral && !compose) {
        const scripts = await api<Array<unknown>>(
          "GET",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
        );
        if (scripts.length >= SCRIPT_LIMIT) {
          return Response.json(
            {
              error: `The account has ${scripts.length} Worker scripts; kitshn opens no preview at ${SCRIPT_LIMIT} (K-903).`,
            },
            { status: 409 },
          );
        }
      }
    }
    // K-807: a push environment stays with the branch that made it, so another branch cannot deploy over prod.
    if (event.name === "push") {
      const [first] = this.sql<{ branch: string }>(
        "SELECT branch FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' AND branch != '' ORDER BY expires_at LIMIT 1",
        resourceId,
      );
      if (first && first.branch !== event.branch) {
        return Response.json(
          {
            error: `${result.environment} deploys only from the branch ${first.branch}, not ${event.branch}.`,
          },
          { status: 403 },
        );
      }
    }
    const deployId = crypto.randomUUID();
    // K-1127: the takeover and the deploy row in one step, after every check; the use is checked again at that point.
    if (handover && !this.usableHandover(deployer))
      return Response.json(
        {
          error:
            "The handover of this repo ended while it planned (K-1127). Publish and hand the card over again.",
        },
        { status: 409 },
      );
    this.ctx.storage.transactionSync(() => {
      if (handover) this.takeOver(handover, deployer, key, result.environment);
      this.sql(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file, addresses, worker, app_key, run_id, run_attempt, needs, workflow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deployId,
        deployer.repo,
        deployer.repoId,
        result.environment,
        resourceId,
        result.address,
        script,
        result.startsIn,
        result.kind,
        deployer.sha,
        Date.now() + DEPLOY_MS,
        // A push binds its environment to the branch (K-807); a preview records its head branch for its close.
        event.branch,
        compose ? "compose" : "worker" in recipe ? "worker" : "static",
        machineId,
        compose?.file ?? null,
        JSON.stringify(result.addresses),
        "worker" in recipe ? JSON.stringify(recipe.worker) : null,
        key,
        deployer.runId,
        deployer.runAttempt,
        JSON.stringify(recipe.needs?.apps ?? []),
        deployer.workflow,
      );
    });
    if (handover) this.load();
    // K-817, K-901: the alarm makes the DNS records of a Compose deploy now, before its build (dnsWork).
    if (compose && result.kind === "deploy") void this.scheduleAlarm();
    if (!compose && result.kind === "deploy")
      this.startDeployAction(deployId, {
        app: "worker" in recipe ? "worker" : "static",
        worker: "worker" in recipe ? JSON.stringify(recipe.worker) : null,
        repo_id: deployer.repoId,
        resource_id: resourceId,
      });
    return Response.json({ deployId, plan: result });
  }

  private async deployAssets(api: Api, row: DeployRow, value: unknown) {
    const manifest = parseManifest(value);
    if (typeof manifest === "string") return Response.json({ error: manifest }, { status: 400 });
    const session = await api<{ jwt: string; buckets?: Array<Array<string>> }>(
      "POST",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${row.script}/assets-upload-session`,
      { manifest },
    );
    // The upload token can only upload these files; Actions sends them straight to Cloudflare.
    return Response.json({
      jwt: session.jwt,
      buckets: session.buckets ?? [],
      uploadUrl: `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/assets/upload?base64=true`,
    });
  }

  /**
   * The card of a deployed environment: new cards start in the `startsIn` circle (K-807) or wait in the tray
   * (K-509); an existing card keeps its place. Returns a line for the deploy log.
   */
  private ensureCard(
    row: DeployRow,
    deployer: Deployer,
    kind: "site.static" | "site.worker" | "site.compose",
    machine: string | null,
  ) {
    const actor: Actor = { _tag: "kitshn", reason: `deploy of ${row.repo} ${deployer.sha.slice(0, 7)}` };
    const addresses = rowAddresses(row);
    const existing = this.state.resources.get(row.resource_id);
    if (existing) {
      // K-817, K-410: a Compose card takes the new list at once; the tunnel sync drops an old address in order. A
      // static card keeps its old addresses until finishDeploy has taken their custom domains off.
      const next = nextCardAddresses(kind, addresses, existing.addresses);
      // K-1124: a Compose address leaves the card at once; the tunnel sync takes its route and DNS record off, and
      // then the redirect Worker takes it over.
      if (kind === "site.compose")
        this.rememberOld(
          existing.id,
          existing.addresses.filter((address) => !next.includes(address)),
          next,
        );
      if (JSON.stringify(next) !== JSON.stringify(existing.addresses)) {
        this.putResource({ ...existing, addresses: next });
        this.load();
      }
      return "The card keeps its place; the map decides who opens it (K-807).";
    }
    const slug = repoSlug(row.repo);
    // K-909: the row of a removed app with this id would take the new card with it (dropLiveSite).
    if (kind === "site.compose") dropLiveSite(this.query, row.resource_id);
    this.putResource({
      id: row.resource_id,
      kind,
      // K-804: an app other than `app` has its key in the name, as in its default address.
      name: `${row.app_key === DEFAULT_APP ? slug : `${slug}-${row.app_key}`}${row.environment === "prod" ? "" : ` ${row.environment}`}`,
      addresses,
      status: "deploying",
      group: slug,
      machine,
    });
    this.load();
    // K-819: the card of a repo that an agent key allowed starts in that key's circle, never in `startsIn`.
    const allowedBy = this.allowingAgent(row.repo_id);
    const circle = allowedBy
      ? agentHomeCircle(this.state, allowedBy.clientId, Date.now())
      : row.starts_in
        ? [...this.state.circles.values()].find((item) =>
            [item.id, item.name.toLowerCase()].includes(row.starts_in!.toLowerCase()),
          )
        : undefined;
    const place = circle ? placeInside(this.state, { x: circle.x, y: circle.y }, new Set([circle.id])) : null;
    // K-1504: a deploy that was running when the pause started finishes with its card in the tray.
    if (circle && place && !this.state.paused) {
      this.commit(
        actor,
        resolveEdits(this.state, [{ _tag: "place", id: row.resource_id, after: place }]),
        null,
      );
      return allowedBy
        ? `The card starts in ${circle.name}, a circle of the agent ${allowedBy.name} that allowed the repo (K-819).`
        : `The card starts in ${circle.name} (K-807).`;
    }
    this.insertRevision(actor, `Deployed ${row.repo} ${row.environment}`, [], null);
    this.load();
    return "The card waits in the tray, so the site is private until you share it on the map (K-509).";
  }

  /**
   * K-819: a step checks this after each wait on the network, because Block ends the repo's planned deploys
   * meanwhile. Null while the deploy is still planned.
   */
  private endedRefusal(deployId: string): Response | null {
    const [row] = this.sql<{ state: string }>("SELECT state FROM deploys WHERE id = ?", deployId);
    if (row?.state === "planned") return null;
    return Response.json(
      { error: "This deploy ended during the step, for example because the owner blocked the repo (K-819)." },
      { status: 409 },
    );
  }

  /** K-812: the source archive and the params of a Compose deploy go to R2 until the job ends. */
  private async deployFile(path: string, deployer: Deployer, request: Request) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const gate = this.repoGate(deployer);
    if (gate) return gate;
    const [row] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE id = ?",
      request.headers.get("x-kitshn-deploy") ?? "",
    );
    if (!row || row.repo_id !== deployer.repoId || row.app !== "compose" || row.kind !== "deploy")
      return fail(404, "kitshn knows no such Compose deploy of this repo.");
    if (row.state !== "planned" || row.expires_at < Date.now())
      return fail(410, "This deploy expired or started.");
    const bucket = this.env.BUCKET;
    if (!bucket || !request.body) return fail(503, "R2 is off, or the request has no body.");
    const limit = path === "/deploy/archive" ? 95 * 1024 * 1024 : 256 * 1024;
    const size = Number(request.headers.get("content-length"));
    if (!Number.isInteger(size) || size < 0) return fail(411, "Send a Content-Length.");
    if (size > limit) return fail(413, `${path} takes at most ${limit} bytes.`);
    const { readable, writable } = new FixedLengthStream(size);
    const piped = request.body.pipeTo(writable);
    const object = deployObject(row.id, path === "/deploy/archive" ? "source.tgz" : "params.env");
    try {
      await bucket.put(object, readable);
      await piped;
    } catch (error) {
      await piped.catch(() => undefined);
      return fail(502, `The upload did not reach R2: ${String(error)}`);
    }
    // Block deletes the files of the deploys it ends; a file that lands after that goes too (K-819).
    const ended = this.endedRefusal(row.id);
    if (ended) await bucket.delete(object);
    return ended ?? Response.json({ ok: true });
  }

  /** K-812: a daemon reads the files of a deploy only while it runs that deploy's job. */
  private async deploySource(path: string, caller: Caller) {
    const [deployId = "", file = ""] = path.slice("/connect/deploys/".length).split("/");
    const machine = [...this.state.machines.values()].find(
      (item) => item.clientId === caller.visitor.clientId,
    );
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    const [job] = row?.job_id
      ? this.sql<{ state: string; machine_id: string }>(
          "SELECT state, machine_id FROM jobs WHERE id = ?",
          row.job_id,
        )
      : [];
    if (
      !machine ||
      !row ||
      job?.machine_id !== machine.id ||
      job.state !== "sent" ||
      !["source.tgz", "params.env"].includes(file)
    )
      return new Response("This machine runs no such deploy now.", { status: 404 });
    const refusal = this.repoRefusal(row.repo_id);
    if (refusal) return new Response(refusal, { status: 403 });
    const object = await this.env.BUCKET?.get(deployObject(deployId, file));
    if (!object) return new Response("The file of this deploy is gone.", { status: 404 });
    return new Response(object.body);
  }

  /** K-812: makes the card and its Access application, then sends the Compose job to the chosen machine. */
  private async startCompose(api: Api, row: DeployRow, deployer: Deployer) {
    const machine = row.machine_id ? this.state.machines.get(row.machine_id) : undefined;
    if (!machine) return Response.json({ error: "The machine of this deploy is gone." }, { status: 409 });
    // K-819: the plan checked the machine; the key can lose it before the start. Check before the card exists.
    const allowedBy = this.allowingAgent(row.repo_id);
    if (!mayDeployOn(this.state, allowedBy?.clientId ?? null, machine.id, Date.now()))
      return Response.json(
        {
          error: `The agent ${allowedBy?.name} that allowed this repo no longer manages ${machine.name} (K-819).`,
        },
        { status: 409 },
      );
    const card = this.ensureCard(row, deployer, "site.compose", machine.id);
    // Fail closed: the Access application exists before the tunnel sends the address to the app (K-410, K-817).
    await this.syncAccessLocked(api, 20);
    const notReady = this.accessNotReady(row);
    if (notReady) return notReady;
    const ended = this.endedRefusal(row.id);
    if (ended) return ended;
    const command: Command = {
      kind: "compose",
      deployId: row.id,
      allowed: allowedFor(machine, row.repo),
      project: row.resource_id,
      name: row.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
      environment: row.environment,
      repo: row.repo,
      file: row.compose_file,
    };
    this.ctx.storage.transactionSync(() => {
      const jobId = this.queueKitshnJob(
        machine.id,
        command,
        { _tag: "kitshn", reason: `deploy of ${row.repo}` },
        Date.now() + DEPLOY_MS,
      );
      this.sql("UPDATE deploys SET state = 'running', job_id = ? WHERE id = ?", jobId, row.id);
    });
    this.deliverJobs();
    this.broadcast();
    return Response.json({ machine: machine.name, card });
  }

  /** K-813: the state and output of a Compose deploy, for the Actions step that waits on it. */
  private composeStatus(deployer: Deployer, deployId: string) {
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    if (!row || row.repo_id !== deployer.repoId || row.job_id === null)
      return Response.json({ error: "kitshn knows no such running deploy of this repo." }, { status: 404 });
    const [job] = this.sql<{ state: string; output: string; exit_code: number | null; expires_at: number }>(
      "SELECT state, output, exit_code, expires_at FROM jobs WHERE id = ?",
      row.job_id,
    );
    // A dropped connection fails the job only for now: kitshn still takes its real result (OFFLINE_OUTPUT),
    // until the job would have expired; a daemon that restarted never sends it.
    const waiting = job?.state === "failed" && job.output === OFFLINE_OUTPUT && job.expires_at > Date.now();
    const state =
      job?.state === "done"
        ? "done"
        : (job?.state === "failed" && !waiting) || job?.state === "expired"
          ? job.state
          : "running";
    if (state !== "running" && row.state === "running")
      this.sql("UPDATE deploys SET state = ? WHERE id = ?", state === "done" ? "done" : "failed", row.id);
    return Response.json({
      state,
      output: waiting ? "" : (job?.output ?? ""),
      exitCode: job?.exit_code ?? null,
    });
  }

  /** K-904: a closed pull request stops its Compose preview; its card goes once the machine stops exposing it. */
  private teardownCompose(row: DeployRow, deployer: Deployer) {
    const resource = this.state.resources.get(row.resource_id);
    const machineId = resource?.machine ?? row.machine_id;
    // The name comes from the card, not from the recipe of this request, so a close stops only its own app.
    const address = resource?.addresses[0] ?? row.address;
    const name = address.slice(0, -this.env.KITSHN_ZONE.length - 1);
    this.ctx.storage.transactionSync(() => {
      if (machineId)
        this.queueKitshnJob(
          machineId,
          { kind: "compose-down", project: row.resource_id, name, removeData: true },
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          Date.now() + JOB_EXPIRY_MS,
        );
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      // A preview that never came up has no live site to take its card away.
      if (resource && ![...this.liveSites.values()].some((site) => site.id === row.resource_id))
        this.insertRevision(
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          `Removed ${resource.name}, its preview closed (K-904)`,
          [this.forgetCard(row.resource_id)],
          null,
        );
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  /** K-410, K-817: a 503 while the Access application of an address of the deploy is not made yet. */
  private accessNotReady(row: DeployRow) {
    for (const address of rowAddresses(row)) {
      const app = this.access.get(`app:${row.resource_id}:${address}`);
      if (!app?.cfId || app.error)
        return Response.json(
          {
            error: `The Access application of ${address} is not ready: ${app?.error ?? "pending"}. Run the deploy again.`,
          },
          { status: 503 },
        );
    }
    return null;
  }

  private async finishDeploy(
    api: Api,
    row: DeployRow,
    deployer: Deployer,
    jwt: unknown,
    iconValue: unknown,
    headersValue: unknown,
    redirectsValue: unknown,
  ) {
    if (typeof jwt !== "string" || !jwt)
      return Response.json({ error: "The deploy needs the upload completion token." }, { status: 400 });
    const headers = parseConfigFile("_headers", headersValue);
    if (typeof headers === "object" && headers !== null)
      return Response.json({ error: headers.error }, { status: 400 });
    const redirects = parseConfigFile("_redirects", redirectsValue);
    if (typeof redirects === "object" && redirects !== null)
      return Response.json({ error: redirects.error }, { status: 400 });
    const icon = parseSiteIcon(iconValue);
    if (typeof icon === "string") return Response.json({ error: icon }, { status: 400 });
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-10-20",
      assets: {
        jwt,
        config: {
          not_found_handling: "404-page",
          html_handling: "auto-trailing-slash",
          ...(headers ? { _headers: headers } : {}),
          ...(redirects ? { _redirects: redirects } : {}),
        },
      },
      bindings: [{ type: "assets", name: "ASSETS" }],
    };
    return this.publish(api, row, deployer, "site.static", icon, async () => ({
      metadata,
      module: STATIC_WORKER,
    }));
  }

  /**
   * K-806: the deploy of a Worker app. The bindings come from the recipe that the plan stored, the KV ids from the
   * storage step, the classes and their migration from what the script has now (classMigration).
   */
  private async finishWorker(api: Api, row: DeployRow, deployer: Deployer, input: Record<string, unknown>) {
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    const app = workerOf(row);
    const module = parseWorkerModule(input["module"]);
    if (typeof module !== "string") return fail(module.error);
    const secrets = parseWorkerSecrets(input["secrets"]);
    if ("error" in secrets) return fail(secrets.error);
    const headers = parseConfigFile("_headers", input["headers"]);
    if (typeof headers === "object" && headers !== null) return fail(headers.error);
    const redirects = parseConfigFile("_redirects", input["redirects"]);
    if (typeof redirects === "object" && redirects !== null) return fail(redirects.error);
    const icon = parseSiteIcon(input["icon"]);
    if (typeof icon === "string") return fail(icon);
    const jwt = input["jwt"];
    if (app.assets !== undefined && (typeof jwt !== "string" || !jwt))
      return fail("The deploy needs the upload completion token of the assets.");
    const kv = new Map(
      this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        row.resource_id,
      ).map((item) => [item.name, item.cf_id]),
    );
    const ephemeral = isPreview(row.environment);
    const crons = ephemeral ? [] : (app.crons ?? []);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    if (this.deletingStorage.has(row.resource_id))
      return fail(
        `kitshn deletes the storage of ${row.resource_id} now. Deploy again after it finishes (K-909).`,
      );
    // K-1908: only a deploy that went live keeps its notify token; a failure or a throw drops it.
    let response: Response | undefined;
    try {
      response = await this.publish(
        api,
        row,
        deployer,
        "site.worker",
        icon,
        async () => {
          const metadata = workerMetadata(app, {
            kv,
            // K-1908: the app gets a new notify token with each deploy.
            secrets: {
              ...secrets.secrets,
              KITSHN_NOTIFY_URL: this.notifyUrl(),
              KITSHN_NOTIFY_TOKEN: this.mintNotifyToken(row.resource_id, `deploy:${row.id}`),
            },
            // K-822: after the Access sync of this deploy, so the audiences are current.
            access: this.appAccess(row.resource_id),
            assets:
              app.assets === undefined
                ? null
                : {
                    jwt: jwt as string,
                    headers: headers as string | null,
                    redirects: redirects as string | null,
                  },
          });
          if ("error" in metadata) throw new RuleError(metadata.error);
          return { metadata: metadata.metadata, module };
        },
        // K-806: the schedules belong to the script, so they change after the upload, but before the addresses and
        // before the card says that the deploy is live. A preview runs no crons, so it never runs them twice.
        async () => {
          if (!ephemeral)
            await api(
              "PUT",
              `${account}/workers/scripts/${row.script}/schedules`,
              crons.map((cron) => ({ cron })),
            );
        },
      );
    } finally {
      this.settleNotifyToken(`deploy:${row.id}`, response?.ok === true);
    }
    if (!response.ok) return response;
    // A deploy brings a removed Worker app back, so its kept script is no longer orphaned (K-909).
    this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", row.resource_id);
    const notes: Array<string> = [];
    if (crons.length > 0) notes.push(`crons: ${crons.join(", ")}`);
    if (ephemeral && (app.crons ?? []).length > 0) notes.push("a preview runs no crons (K-806).");
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...body, notes });
  }

  /**
   * K-805, K-806: uploads the Worker of a deploy and publishes it at its addresses. `build` gives the upload metadata
   * and the one module; `afterUpload` runs before the addresses go live.
   * K-406: at most 43 of the 50 subrequests of the Free plan, with 5 addresses (K-817): the Access sync 20, the script
   * list 1, the upload 1, its version 1 (K-820), workers.dev 1, the schedules 1, a lookup and an attach per address 10,
   * the stale domains 2 lists and up to 5 deletes, and the route check 1. Keep it at most 45 when a step joins.
   */
  private async publish(
    api: Api,
    row: DeployRow,
    deployer: Deployer,
    kind: "site.static" | "site.worker",
    icon: { readonly bytes: Uint8Array; readonly type: string } | null | undefined,
    build: () => Promise<{ readonly metadata: Record<string, unknown>; readonly module: string }>,
    afterUpload: () => Promise<void> = async () => undefined,
  ) {
    const card = this.ensureCard(row, deployer, kind, null);
    // Fail closed: the Access application of each address exists before the address does (K-817).
    await this.syncAccessLocked(api, 20);
    const notReady = this.accessNotReady(row);
    if (notReady) return notReady;
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const scripts = await api<Array<{ id: string }>>("GET", `${account}/workers/scripts`);
    const isNew = !scripts.some((item) => item.id === row.script);
    const { metadata, module } = await build();
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([module], { type: "application/javascript+module" }), "worker.js");
    // An existing site goes live with this upload, so Block must win right before it.
    const endedBeforeUpload = this.endedRefusal(row.id);
    if (endedBeforeUpload) return endedBeforeUpload;
    const upload = await fetch(
      `https://api.cloudflare.com/client/v4${account}/workers/scripts/${row.script}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
        body: form,
      },
    );
    const uploaded = (await upload.json()) as { success: boolean; errors?: unknown };
    if (!uploaded.success) throw new Error(`the Worker upload failed: ${JSON.stringify(uploaded.errors)}`);
    // K-820: the version that this upload made, for a later rollback to it (K-821). The script is live already, so a
    // failed read only takes the rollback to this deploy away; it logs a warning and stores null.
    const versionId = await api<{ deployments: Array<{ versions: Array<{ version_id: string }> }> }>(
      "GET",
      `${account}/workers/scripts/${row.script}/deployments`,
    ).then(
      (result) => result.deployments[0]?.versions[0]?.version_id ?? null,
      (error: unknown) => {
        console.warn(`kitshn: the version of ${row.script} is unknown: ${String(error)}`);
        return null;
      },
    );
    if (versionId === null)
      console.warn(`kitshn: no version of ${row.script} after the upload; no rollback to it.`);
    this.sql("UPDATE deploys SET version_id = ? WHERE id = ?", versionId, row.id);
    // The workers.dev address would skip Access. If it cannot be turned off, a new script goes away again.
    try {
      await api("POST", `${account}/workers/scripts/${row.script}/subdomain`, {
        enabled: false,
        previews_enabled: false,
      });
    } catch (error) {
      if (isNew)
        await api("DELETE", `${account}/workers/scripts/${row.script}?force=true`).catch(() => undefined);
      throw error;
    }
    await afterUpload();
    const addresses = rowAddresses(row);
    for (const address of addresses) {
      const domains = await api<Array<{ id: string; service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      const attached = domains.find((domain) => domain.service === row.script);
      const endedBeforeAddress = this.endedRefusal(row.id);
      if (endedBeforeAddress) return endedBeforeAddress;
      if (attached) continue;
      // K-1124: an old address of this card that comes back leaves the redirect Worker first.
      const [own] = this.sql(
        "SELECT 1 FROM old_addresses WHERE address = ? AND card_id = ?",
        address,
        row.resource_id,
      );
      for (const domain of domains)
        if (own && domain.service === REDIRECT_SCRIPT)
          await api("DELETE", `${account}/workers/domains/${domain.id}`);
      if (domains.some((domain) => domain.service !== REDIRECT_SCRIPT || !own))
        throw new Error(`${address} already serves another Worker.`);
      const zone = zoneOfAddressIn(address, this.env);
      if (!zone) throw new Error(`kitshn does not publish on the zone of ${address} (K-1111).`);
      await api("PUT", `${account}/workers/domains`, {
        hostname: address,
        service: row.script,
        zone_id: zone.id,
        environment: "production",
      });
    }
    // K-817, K-410: an address that left the recipe loses its custom domain first, and its card address (with its
    // Access application) only after Cloudflare confirms that.
    await removeStaleDomains(api, account, row.script, addresses);
    // K-814: the route check records what a visitor without a login gets.
    const check = await fetch(`https://${row.address}/`, { redirect: "manual" }).catch(() => null);
    const resource = this.state.resources.get(row.resource_id);
    // K-1124: an address that the recipe dropped sends its visitors on to the main address from now.
    if (resource)
      this.rememberOld(
        resource.id,
        resource.addresses.filter((address) => !addresses.includes(address)),
        addresses,
      );
    if (resource) this.putResource({ ...resource, addresses, status: "running" });
    this.sql("UPDATE deploys SET state = 'done' WHERE id = ? AND state = 'planned'", row.id);
    await this.exclusive(row.resource_id, async () => {
      await this.retireLibraryItem(row.resource_id);
      return new Response(null);
    });
    if (icon !== undefined) await this.setIcon(row.resource_id, icon);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ address: row.address, status: check?.status ?? 0, card });
  }

  /**
   * K-806: the crons that the other Workers of the account run, from one script list and the schedules of each
   * script with a scheduled handler. It runs in the storage step, before the upload, so the limit never fails a live
   * deploy. K-406: that step makes at most 11 calls for 10 KV bindings (one list and one create each), so this reads
   * at most 24 schedules and keeps the step at most 36 subrequests; with more such Workers, the deploy fails and says
   * so.
   */
  private async cronsOfOtherWorkers(api: Api, script: string): Promise<number> {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const scheduled = (
      await api<Array<{ id: string; handlers?: ReadonlyArray<string> }>>("GET", `${account}/workers/scripts`)
    ).filter((item) => item.id !== script && (item.handlers ?? []).includes("scheduled"));
    if (scheduled.length > 24)
      throw new RuleError(
        `${scheduled.length} Workers of the account have a scheduled handler; kitshn reads the crons of at most 24 in one deploy step (K-406).`,
      );
    let used = 0;
    for (const item of scheduled)
      used += (
        await api<{ schedules: ReadonlyArray<unknown> }>(
          "GET",
          `${account}/workers/scripts/${item.id}/schedules`,
        )
      ).schedules.length;
    return used;
  }

  /**
   * K-806: makes the KV namespace of each binding of the recipe that this environment does not have yet. A
   * namespace stays with the card across deploys, so its data stays too.
   */
  private async workerStorage(api: Api, row: DeployRow) {
    const app = workerOf(row);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    if (this.deletingStorage.has(row.resource_id))
      return Response.json(
        {
          error: `kitshn deletes the storage of ${row.resource_id} now. Deploy again after it finishes (K-909).`,
        },
        { status: 409 },
      );
    const crons = isPreview(row.environment) ? [] : (app.crons ?? []);
    if (crons.length > 0) {
      const used = await this.cronsOfOtherWorkers(api, row.script);
      if (used + crons.length > CRON_LIMIT)
        return Response.json(
          {
            error: `Other Workers of the account run ${used} crons, and ${crons.length} more pass the limit of ${CRON_LIMIT} of the Free plan (K-806).`,
          },
          { status: 409 },
        );
    }
    const have = new Map(
      this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        row.resource_id,
      ).map((item) => [item.name, item.cf_id]),
    );
    const bindings = app.kv ?? [];
    // One list of the namespaces: it shows a row whose namespace is gone (a delete that a restart cut off, or one
    // outside kitshn), and the namespace that an earlier run made before kitshn wrote its row. Known limit: it reads
    // the first 100 namespaces of the account only, and with a full page it trusts every row; revisit when the
    // account has more.
    const list =
      bindings.length === 0
        ? []
        : await api<Array<{ id: string; title: string }>>(
            "GET",
            `${account}/storage/kv/namespaces?per_page=100`,
          );
    const complete = list.length < 100;
    const created: Array<string> = [];
    for (const binding of bindings) {
      const known = have.get(binding);
      if (known !== undefined && (!complete || list.some((item) => item.id === known))) continue;
      const title = `kitshn-${row.resource_id}-${binding}`;
      const found = list.find((item) => item.title === title);
      const id = found
        ? found.id
        : (await api<{ id: string }>("POST", `${account}/storage/kv/namespaces`, { title })).id;
      this.sql(
        "INSERT OR REPLACE INTO worker_storage (card_id, kind, name, cf_id) VALUES (?, 'kv', ?, ?)",
        row.resource_id,
        binding,
        id,
      );
      created.push(binding);
    }
    return Response.json({ created });
  }

  /**
   * K-1113: one icon per card, written only when its bytes change (K-1302). With `hourly`, a stored icon changes
   * at most once an hour (K-1114). Returns whether the stored icon changed.
   */
  private async setIcon(
    id: string,
    icon: { readonly bytes: Uint8Array; readonly type: string } | null,
    hourly = false,
  ): Promise<boolean> {
    const now = Date.now();
    const hash = icon === null ? null : await iconHash(icon.bytes);
    if ((this.iconHashes.get(id) ?? null) === hash) return false;
    const changedAt = this.iconChangedAt.get(id);
    if (hourly && changedAt !== undefined && now - changedAt < ICON_CHANGE_MS) return false;
    if (icon === null || hash === null) {
      this.sql("DELETE FROM icons WHERE id = ?", id);
      this.iconHashes.delete(id);
      // A removal counts toward the hour too; its time lives in memory only, so a restart forgets it.
      this.iconChangedAt.set(id, now);
      return true;
    }
    this.sql(
      "INSERT OR REPLACE INTO icons (id, type, hash, bytes, changed_at) VALUES (?, ?, ?, ?, ?)",
      id,
      icon.type,
      hash,
      icon.bytes.slice().buffer,
      now,
    );
    this.iconHashes.set(id, hash);
    this.iconChangedAt.set(id, now);
    return true;
  }

  /** K-1114: the icon that a daemon read from one of its own sites. */
  private async liveIcon(machine: Machine, name: unknown, value: unknown) {
    const site = this.sitesOf(machine.id).find((item) => item.name === name);
    const icon = parseSiteIcon(value);
    if (!site || icon === undefined || typeof icon === "string") return;
    if (await this.setIcon(site.id, icon, true)) this.broadcast();
  }

  /** K-1113: the stored icon of a card. Its route sits behind the map's own check (K-104, K-208). */
  private icon(encodedId: string) {
    let id: string;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      return Response.json({ error: "The icon address is not valid." }, { status: 404 });
    }
    const [row] = this.sql<{ type: string; bytes: ArrayBuffer }>(
      "SELECT type, bytes FROM icons WHERE id = ?",
      id,
    );
    if (!row) return Response.json({ error: `kitshn has no icon for ${id}.` }, { status: 404 });
    return new Response(row.bytes, {
      headers: {
        "content-type": row.type,
        // The map asks with the hash in the address, so a new icon gets a new address.
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        // An SVG that someone opens on its own runs no script on the admin host.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  /** K-904: a closed pull request removes its preview: the address, the Worker, the card and its Access app. */
  private async teardown(api: Api, row: DeployRow, deployer: Deployer) {
    await this.removeWorker(api, rowAddresses(row), row.script);
    // K-904, K-806: a closed preview takes its KV data with it; the script delete took its Durable Objects.
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const { name, cf_id } of this.sql<{ name: string; cf_id: string }>(
      "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
      row.resource_id,
    )) {
      await api("DELETE", `${account}/storage/kv/namespaces/${cf_id}`).catch((error: unknown) =>
        error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
      );
      this.sql(
        "DELETE FROM worker_storage WHERE card_id = ? AND kind = 'kv' AND name = ?",
        row.resource_id,
        name,
      );
    }
    const resource = this.state.resources.get(row.resource_id);
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM worker_storage WHERE card_id = ?", row.resource_id);
      const forgotten = this.forgetCard(row.resource_id);
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      if (resource)
        this.insertRevision(
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          `Removed ${resource?.name ?? row.environment}, its preview closed (K-904)`,
          [forgotten],
          null,
        );
    });
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  /** K-904, K-909: takes a Worker site's addresses off, confirms it, then deletes the Worker script. */
  private async removeWorker(api: Api, addresses: ReadonlyArray<string>, script: string) {
    await this.removeDomains(api, addresses, script);
    await api(
      "DELETE",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}?force=true`,
    ).catch((error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
    );
  }

  /** K-909: takes the custom domains of a Worker off and confirms that each is gone. */
  private async removeDomains(api: Api, addresses: ReadonlyArray<string>, script: string) {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const address of addresses) {
      const domains = await api<Array<{ id: string; service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      for (const domain of domains.filter((item) => item.service === script)) {
        await api("DELETE", `${account}/workers/domains/${domain.id}`);
      }
      // K-006: the card, and with it the Access application, goes only after each address is confirmed gone.
      const left = await api<Array<{ service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      if (left.some((item) => item.service === script)) {
        throw new Error(`${address} still serves ${script}; run the teardown again.`);
      }
    }
  }

  /**
   * K-909: the undo of "Remove app" for a Worker app puts its addresses back on the script that the removal kept,
   * after their Access applications exist again (K-410). Its Durable Objects and KV kept their data.
   */
  private async reattachWorker(card: AppCard): Promise<string> {
    const back = `${card.name} is back on the map`;
    const done = this.lastDone(card.id);
    const refusal = this.state.paused
      ? "kitshn is paused, so it starts nothing until Resume."
      : this.closedPreview(card.id)
        ? "its pull request is closed, so the preview does not come back."
        : done && !this.isFolderSite(card.id)
          ? this.repoRefusal(done.repo_id)
          : null;
    if (refusal) return `${back}, but kitshn did not put its addresses back: ${refusal}`;
    const api = this.api();
    if (!api) return `${back}, but kitshn has no Cloudflare API token here.`;
    const script = `kitshn-${card.id}`;
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    await this.syncAccessLocked(api, 20);
    for (const address of card.addresses) {
      const app = this.access.get(`app:${card.id}:${address}`);
      if (!app?.cfId || app.error)
        return `${back}, but the Access application of ${address} is not ready, so its addresses stay off. Deploy it again.`;
    }
    try {
      for (const address of card.addresses) {
        const domains = await api<Array<{ service: string }>>(
          "GET",
          `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
        );
        if (domains.some((domain) => domain.service === script)) continue;
        if (domains.length > 0) return `${back}, but ${address} now serves another Worker.`;
        const zone = zoneOfAddressIn(address, this.env);
        if (!zone) return `${back}, but kitshn does not publish on the zone of ${address} (K-1111).`;
        await api("PUT", `${account}/workers/domains`, {
          hostname: address,
          service: script,
          zone_id: zone.id,
          environment: "production",
        });
      }
    } catch (error) {
      return `${back}, but its addresses did not come back: ${error instanceof Error ? error.message : String(error)}. Deploy it again.`;
    }
    // The crons of the last deploy come back, as the removal took them off; a preview never had any.
    const crons = done?.app === "worker" && !isPreview(done.environment) ? (workerOf(done).crons ?? []) : [];
    try {
      if (crons.length > 0)
        await api(
          "PUT",
          `${account}/workers/scripts/${script}/schedules`,
          crons.map((cron) => ({ cron })),
        );
    } catch (error) {
      return `${back} at ${card.addresses.join(", ")}, but its crons did not come back: ${error instanceof Error ? error.message : String(error)}. Deploy it again.`;
    }
    this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", card.id);
    return `${back} at ${card.addresses.join(", ")}, with its data${crons.length > 0 ? " and its crons" : ""}.`;
  }

  /** A job that kitshn makes itself, so it needs no member with control (K-614). Returns the job id. */
  private queueKitshnJob(
    machineId: string,
    command: Command,
    actor: Actor,
    expiresAt: number,
    whenIdle = false,
  ) {
    const now = Date.now();
    if (
      command.kind === "compose" ||
      command.kind === "compose-redeploy" ||
      command.kind === "compose-rollback"
    )
      failQueuedDowns(this.query, command.project, REPLACED);
    const [row] = this.sql<{ id: number }>(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, when_idle)
       VALUES (?, '[]', ?, 'queued', ?, ?, ?, '${KITSHN_JOB}', NULL, '', ?) RETURNING id`,
      machineId,
      JSON.stringify(command),
      now,
      expiresAt,
      JSON.stringify(actor),
      whenIdle ? 1 : 0,
    );
    if (!row) throw new Error("The job insert returned no id.");
    return row.id;
  }

  /**
   * K-718: an agent key sees the cards that it manages and the circles that it is in (no members), moves
   * those cards between those circles, and runs jobs on the machines that it controls (K-614).
   */
  /**
   * K-718: the agent paths. K-1710: a machine runs them too, through its asks; `approved` is the right that its
   * approver circle gave for this one ask (K-1723).
   */
  /**
   * K-1714: a call of a machine's token over HTTP comes only from its daemon, which forwards one call of a local agent
   * and signs it with the machine key. kitshn checks the signature, the right of the path with its mode and
   * conditions, the pause, and writes one ask event.
   */
  private async forwardedRequest(path: string, request: Request, caller: Caller, machine: Machine) {
    const now = Date.now();
    const url = new URL(request.url);
    const call = { method: request.method, path: `${url.pathname}${url.search}` };
    const header = (name: string) => request.headers.get(name) ?? "";
    const at = Number(header(FORWARD_HEADERS.at));
    const nonce = header(FORWARD_HEADERS.nonce);
    const labelsText = header(FORWARD_HEADERS.labels) || "{}";
    // A refusal drops the body that it does not read, so the connection does not wait on it.
    const refuse = async (status: number, error: string, need?: MachineRight) => {
      if (!request.bodyUsed) await request.body?.cancel().catch(() => undefined);
      return Response.json({ error, ...(need ? { need } : {}) }, { status });
    };
    const pathProblem = forwardPathProblem(url.pathname);
    if (pathProblem !== null || forwardRight(url.pathname, request.method) === undefined)
      return refuse(403, `A machine forwards no call to ${request.method} ${url.pathname} (K-1714).`);
    if (machine.key?.kind !== "public")
      return refuse(403, "This machine has no key, so it cannot forward a call (K-1714).");
    if (
      !Number.isFinite(at) ||
      Math.abs(now - at) > FORWARD_WINDOW_MS ||
      nonce.length < 16 ||
      nonce.length > 64
    )
      return refuse(403, "The forwarded call is too old, or its nonce is not one (K-1714).");
    const labelsHash = await sha256Hex(labelsText);
    const valid = await verifyForHosts(
      machine.key.publicKey,
      adminHosts(this.env),
      (host) => forwardText(host, machine.id, { ...call, at, nonce, labelsHash }),
      header(FORWARD_HEADERS.signature),
    );
    if (!valid)
      return refuse(403, "The signature of the forwarded call does not fit the machine key (K-1714).");
    // K-1714: one use per nonce, also after a restart; a nonce older than the window fails the time check above.
    this.sql("DELETE FROM forward_nonces WHERE at < ?", now - FORWARD_WINDOW_MS);
    const [fresh] = this.sql<{ nonce: string }>(
      "INSERT OR IGNORE INTO forward_nonces (nonce, at) VALUES (?, ?) RETURNING nonce",
      nonce,
      at,
    );
    if (!fresh) return refuse(403, "The nonce of this forwarded call was used (K-1714).");
    const prefixes = this.labelPrefixesOf(machine.id);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(labelsText);
    } catch {
      parsed = null;
    }
    const labels = Object.fromEntries(
      Object.entries(isRecord(parsed) ? parsed : {}).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && prefixes.some((prefix) => entry[0].startsWith(prefix)),
      ),
    );
    const target = `${call.method} ${call.path}`.slice(0, 512);
    let waiting: string | null = null;
    const answer = await (async (): Promise<Response> => {
      if (this.state.paused) return refuse(409, "kitshn is paused, so machines wait until Resume (K-1504).");
      const right = forwardRight(path, request.method);
      if (right === undefined)
        return refuse(403, `A machine forwards no call to ${request.method} ${path} (K-1714).`);
      // K-1776: the body is read once; an approval binds the hash of what its approver read, so only this call runs.
      // A copy, so the call itself still streams its own body (a rebuilt body stalls the R2 upload in workerd).
      const bytes =
        request.method === "GET" ? new Uint8Array() : new Uint8Array(await request.clone().arrayBuffer());
      const input: unknown = path.startsWith("/agent/sites/")
        ? (() => {
            try {
              return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
            } catch {
              return null;
            }
          })()
        : null;
      // `finish` lands the site with the `public` of its plan, so it checks the labels again (K-1123).
      const plannedPublic = () =>
        this.sql<{ public: number }>(
          `SELECT agent_sites.public FROM deploys JOIN agent_sites ON agent_sites.card_id = deploys.resource_id
           AND agent_sites.client_id = ? WHERE deploys.id = ?`,
          machine.clientId,
          isRecord(input) ? String(input["deployId"] ?? "") : "",
        )[0]?.public === 1;
      // A page or a folder site into Everyone also needs "publishes", as `apply` does (K-1754).
      const publishes =
        (path === "/agent/library" && request.headers.get("x-kitshn-public") === "true") ||
        (path === "/agent/sites/plan" && isRecord(input) && input["public"] === true) ||
        (path === "/agent/sites/finish" && plannedPublic());
      // K-1776: the files and the finish of a folder site count the rights that the approval of their plan gave, so one
      // approval covers the whole publish.
      const planned =
        path === "/agent/sites/assets" || path === "/agent/sites/finish"
          ? approvedRights(
              this.sql<{ approved: string }>(
                `SELECT deploys.approved FROM deploys JOIN agent_sites ON agent_sites.card_id = deploys.resource_id
                 AND agent_sites.client_id = ? WHERE deploys.id = ? AND deploys.state = 'planned'`,
                machine.clientId,
                isRecord(input) ? String(input["deployId"] ?? "") : "",
              )[0]?.approved ?? "[]",
            )
          : [];
      // A new folder site also needs "adds apps" (K-1123); its finish uses what the plan was approved for.
      const newSite =
        path === "/agent/sites/plan" &&
        isRecord(input) &&
        !this.folderSiteKnown(machine.clientId, String(input["folder"] ?? "").trim(), now);
      const game =
        request.method === "DELETE" &&
        path.startsWith("/agent/cards/") &&
        this.gameRows("card_id = ?", decodeURIComponent(path.slice("/agent/cards/".length))).length > 0;
      const needed = [
        ...new Set<MachineRight>([
          ...(right === null ? [] : [right]),
          ...(game ? (["addsApps"] as const) : []),
          ...(newSite ? (["addsApps"] as const) : []),
          ...(publishes ? (["publishes"] as const) : []),
        ]),
      ];
      const { shown, body: shownBody } = await forwardShown(target, request.headers, bytes);
      const hash = await shownHash(shown);
      const approved: Array<MachineRight> = [];
      // K-1714: an approval binds the machine and the thread that asked (an attested label), and runs one call.
      const thread = labels["t3.thread.id"] ?? null;
      const used = new Set<string>();
      let wait: { readonly right: MachineRight; readonly circleId: string } | null = null;
      for (const need of needed) {
        const mode = machineRightMode(this.state, machine.id, need, now);
        if (mode === null && machineRightOff(this.state, machine.id, need, now))
          return refuse(
            403,
            `The right "${MACHINE_RIGHT_NAMES[need]}" is off for this machine (K-1720). Ask the owner to turn it on.`,
            need,
          );
        const failed = conditionProblem(mode?.conditions, labels, prefixes);
        if (failed) return refuse(403, failed);
        if (mode?.mode === "automatic") continue;
        if (planned.includes(need)) {
          approved.push(need);
          continue;
        }
        // K-1776: an unset right asks the Owner; "ask <circle>" asks that circle.
        const circleId = mode?.circleId ?? OWNER_CIRCLE_ID;
        const approval = this.forwardApproval(machine.id, hash, circleId, thread, now);
        if (approval === null) wait ??= { right: need, circleId };
        else {
          approved.push(need);
          used.add(approval);
        }
      }
      // An approval of a call that cannot run would only cost the approver a click.
      if (wait !== null && circlesOf(this.state, caller.visitor, now).size === 0)
        return refuse(403, "This agent is in no agent circle, so it manages nothing (K-718).");
      if (wait !== null) {
        const proposal = await this.forwardProposal(
          machine,
          target,
          shownBody,
          labels,
          wait,
          hash,
          thread,
          now,
        );
        if (proposal.outcome === "refused") return refuse(409, proposal.reason);
        waiting = proposal.proposalId;
        return Response.json(
          {
            error: proposal.line,
            outcome: "waiting",
            proposalId: proposal.proposalId,
            circle: proposal.circle,
            expiresAt: proposal.expiresAt,
          },
          { status: 409 },
        );
      }
      // No await since the approvals were read, so no other call can use them in between.
      for (const id of used)
        this.sql("UPDATE proposals SET used_at = ? WHERE id = ? AND used_at IS NULL", now, id);
      return this.agentRequest(
        path,
        request,
        { ...caller, actor: { _tag: "machine", machineId: machine.id, name: machine.name } },
        approved,
      );
    })();
    const detail = answer.ok
      ? null
      : await answer
          .clone()
          .json()
          .then((body) => (isRecord(body) && typeof body["error"] === "string" ? body["error"] : null))
          .catch(() => null);
    this.askEvent(
      now,
      machine,
      "forward",
      target,
      null,
      labels,
      answer.ok
        ? { outcome: "done", result: null }
        : waiting !== null
          ? { outcome: "waiting", proposalId: waiting }
          : { outcome: "refused", reason: detail ?? `answered ${answer.status}` },
    );
    return answer;
  }

  /** K-1123: true when this agent has a live folder site of this folder, so a plan updates it. */
  private folderSiteKnown(clientId: string, folder: string, now: number) {
    const [stored] = this.sql<AgentSiteRow>(
      "SELECT * FROM agent_sites WHERE client_id = ? AND folder = ?",
      clientId,
      folder,
    );
    return stored !== undefined && this.siteLive(stored, now);
  }

  /**
   * K-1714, K-1776: the unused approval of exactly this forwarded call (its shown hash) of this machine and thread, from
   * this circle, within the hour; null when there is none.
   */
  private forwardApproval(
    machineId: string,
    hash: string,
    circleId: string,
    thread: string | null,
    now: number,
  ): string | null {
    const [row] = this.sql<{ id: string }>(
      `SELECT id FROM proposals WHERE machine_id = ? AND action = 'forward' AND shown_hash = ? AND circle_id = ?
       AND state = 'approved' AND used_at IS NULL AND decided_at > ? AND json_extract(labels, '$."t3.thread.id"') IS ?
       LIMIT 1`,
      machineId,
      hash,
      circleId,
      now - APPROVED_WINDOW_MS,
      thread,
    );
    return row?.id ?? null;
  }

  /**
   * K-1776: the proposal of a forwarded call that waits. The same call again gets the open proposal, not a new one,
   * so an agent that runs its command again does not fill the Inbox.
   */
  private async forwardProposal(
    machine: Machine,
    target: string,
    body: unknown,
    labels: Readonly<Record<string, string>>,
    wait: { readonly right: MachineRight; readonly circleId: string },
    hash: string,
    thread: string | null,
    now: number,
  ): Promise<
    | { readonly outcome: "refused"; readonly reason: string }
    | {
        readonly outcome: "waiting";
        readonly proposalId: string;
        readonly circle: string;
        readonly expiresAt: number;
        readonly line: string;
      }
  > {
    const [open] = this.sql<{ id: string; expires_at: number }>(
      `SELECT id, expires_at FROM proposals WHERE machine_id = ? AND action = 'forward' AND shown_hash = ? AND circle_id = ?
       AND state = 'pending' AND expires_at > ? AND json_extract(labels, '$."t3.thread.id"') IS ? LIMIT 1`,
      machine.id,
      hash,
      wait.circleId,
      now,
      thread,
    );
    const made = open
      ? { outcome: "waiting" as const, proposalId: open.id }
      : await this.propose(machine, "forward", target, body, null, labels, wait.right, wait.circleId, now);
    if (made.outcome !== "waiting")
      return {
        outcome: "refused",
        reason: made.outcome === "refused" ? made.reason : "kitshn made no proposal.",
      };
    const expiresAt = open?.expires_at ?? now + PROPOSAL_MS;
    const circle = this.state.circles.get(wait.circleId)?.name ?? wait.circleId;
    const hours = Math.max(1, Math.round((expiresAt - now) / HOUR_MS));
    return {
      outcome: "waiting",
      proposalId: made.proposalId,
      circle,
      expiresAt,
      line: `waiting: ${circle} must approve this call (right "${MACHINE_RIGHT_NAMES[wait.right]}", proposal ${made.proposalId}, expires in ${hours} h). After the approval, run the same command once more within 1 hour, from the same thread; a changed call asks again (K-1776).`,
    };
  }

  private async agentRequest(
    path: string,
    request: Request,
    caller: Caller,
    approved: ReadonlyArray<MachineRight> = [],
    /** K-1776: a person of the Owner circle approved this one job or deploy, so K-718 does not refuse it. */
    ownerApproved: OwnerApproval | null = null,
  ) {
    const now = Date.now();
    // K-1714: a machine's token over HTTP is a call that its daemon forwarded and signed; asks use the connection.
    const machine = machineOf(this.state, caller.visitor);
    if (machine && caller.actor._tag !== "machine")
      return this.forwardedRequest(path, request, caller, machine);
    // K-1712: a machine's job and deploy need their right now: automatic, or the approval of this ask.
    const machineMay = (right: MachineRight) => {
      if (!machine) return true;
      // An approval of this call (K-1723, K-1776) counts also when the right is off.
      return (
        approved.includes(right) || machineRightMode(this.state, machine.id, right, now)?.mode === "automatic"
      );
    };
    const machinePaths = ["/agent/state", "/agent/apply", "/agent/organize", "/agent/jobs", "/agent/deploy"];
    if (
      machine &&
      !machinePaths.includes(path) &&
      !path.startsWith("/agent/jobs/") &&
      !path.startsWith("/agent/repos/") &&
      forwardRight(path, request.method) === undefined
    )
      return Response.json({ error: `A machine has no ask for ${path} yet (K-1711).` }, { status: 403 });
    const own = circlesOf(this.state, caller.visitor, now);
    // A machine in the tray reads its own approved job.
    if (own.size === 0 && !ownerApproved && !(machine && path.startsWith("/agent/jobs/")))
      return Response.json(
        { error: "This agent is in no agent circle, so it manages nothing (K-718)." },
        { status: 403 },
      );
    const managed = cardsControlledBy(this.state, caller.visitor, now);
    // K-614: the history names the device by its member name in its agent circle, not by its token id.
    const device = [...own]
      .flatMap((id) => this.state.circles.get(id)?.members ?? [])
      .find((member) => member._tag === "device" && member.clientId === caller.visitor.clientId);
    // K-1730: a machine acts under its own name.
    const agentName =
      device?._tag === "device" ? device.name : caller.actor._tag === "machine" ? caller.actor.name : null;
    const agent: Caller =
      caller.actor._tag === "device" && device?._tag === "device"
        ? { ...caller, actor: { ...caller.actor, name: device.name } }
        : caller;
    const rights = AGENT_RIGHTS.filter((right) => agentHas(this.state, caller.visitor, right, now, approved));
    // A key that publishes also sees the Everyone circle, where its published cards sit.
    const visible = (id: string) => {
      const circle = this.state.circles.get(id);
      return (
        own.has(id) || (rights.includes("publishes") && circle !== undefined && isEveryoneCircle(circle))
      );
    };
    // K-718: the cards of repos that this key allowed (K-819); only these may become public.
    const added = new Set(
      this.sql<{ resource_id: string }>(
        `SELECT DISTINCT deploys.resource_id FROM deploys JOIN repos ON repos.repo_id = deploys.repo_id AND deploys.kind = 'deploy'
         WHERE repos.allowed_by_client = ?
         UNION SELECT id FROM library WHERE added_by = ?`,
        caller.visitor.clientId,
        caller.visitor.clientId,
      ).map((row) => row.resource_id),
    );
    const move = (edits: ReadonlyArray<Edit>, named: string | null = null) => {
      try {
        const changes = resolveEdits(this.state, edits);
        const refusal = agentRefusal(
          this.state,
          applyChanges(this.state, changes),
          caller.visitor,
          changes,
          now,
          added,
          approved,
        );
        if (refusal) return Response.json({ error: refusal }, { status: 403 });
        return Response.json({ revision: this.commit(agent.actor, changes, null, named) });
      } catch (error) {
        if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
        throw error;
      }
    };
    if (path === "/agent/state" && request.method === "GET") {
      const deploys = this.deploys();
      const checked = new Set(this.uptimeTargets().map((card) => card.id));
      // K-1726: a machine sees the open asks of the circles that it is a member of, so its agent can answer them.
      const answerable = machine ? this.answerableProposals(caller.visitor) : [];
      // The servers and the link events are most of the answer, so they come only with `?all=1`.
      const all = new URL(request.url).searchParams.get("all") === "1";
      const circleRef = (id: string) => ({ id, name: this.state.circles.get(id)?.name ?? id });
      return Response.json({
        // The names of the map, with the mode of each right (K-1720) for a machine, and its circle for "ask".
        rights: machine
          ? // "reads code" and "writes code" hold per repo (K-1733), so they are not one mode of the machine.
            MACHINE_RIGHTS.filter((right) => right !== "readsCode" && right !== "writesCode").map((right) => {
              const mode = machineRightMode(this.state, machine.id, right, now);
              const base = { id: right, name: MACHINE_RIGHT_NAMES[right] };
              if (mode?.mode === "automatic") return { ...base, mode: "automatic" as const };
              // K-1776: a right that no circle sets asks the Owner; only "off" refuses.
              if (mode === null && machineRightOff(this.state, machine.id, right, now))
                return { ...base, mode: "off" as const };
              return { ...base, mode: "ask" as const, circle: circleRef(mode?.circleId ?? OWNER_CIRCLE_ID) };
            })
          : AGENT_RIGHTS.map((right) => ({
              id: right,
              name: AGENT_RIGHT_NAMES[right],
              mode: rights.includes(right) ? "automatic" : "off",
            })),
        ...(machine ? { proposals: answerable } : {}),
        // K-619: a machine sees its own listening ports, the list of the site wizard.
        ...(machine && all ? { servers: this.machineView(machine).servers } : {}),
        // K-1610: the newest 50 calls from or to this machine.
        ...(machine && all ? { linkEvents: this.recentLinkEvents(machine.id) } : {}),
        // K-631: the health cells from and to this machine, from the reports in the socket attachments.
        ...(machine ? { health: this.healthOf(machine.id) } : {}),
        // K-819: with "may add apps", the waiting repos that the key may allow.
        repos: rights.includes("addsApps")
          ? this.sql<RepoRow>(
              "SELECT * FROM repos WHERE state = 'waiting' AND gone_at IS NULL ORDER BY first_seen DESC",
            ).map((row) => ({
              repoId: row.repo_id,
              name: row.name,
              branch: row.branch,
            }))
          : [],
        circles: [...this.state.circles.values()]
          .filter((circle) => visible(circle.id))
          .map(({ id, name, level, x, y, r }) => ({ id, name, level, x, y, r })),
        cards: [...managed].flatMap((id) => {
          const resource = this.state.resources.get(id);
          if (!resource) return [];
          const { kind, name, addresses } = resource;
          // A machine card has no status of its own; its connection is the live one.
          const known = kind === "machine" ? this.state.machines.get(id) : undefined;
          const status = known ? (this.openSocket(known.id) ? "online" : "offline") : resource.status;
          const backup = this.latestBackups().get(id);
          const uptime = checked.has(id) ? (this.uptime.get(id) ?? UP) : null;
          return [
            {
              id,
              kind,
              name,
              addresses,
              status,
              place: this.state.places.get(id) ?? null,
              // K-212: when the card leaves every circle for the tray, or null.
              endsAt: this.state.ends.get(id) ?? null,
              added: added.has(id),
              circles: circlesHolding(this.state, id)
                .filter((circle) => visible(circle.id))
                .map((circle) => ({ id: circle.id, name: circle.name })),
              // K-718: what the owner snapshot shows of the card, so an agent needs no owner read.
              deploy: deploys.newest.get(id) ?? null,
              backup: backup ? { at: backup.at, state: backup.state, error: backup.error } : null,
              uptime: uptime ? { up: uptime.up, since: uptime.since } : null,
            },
          ];
        }),
      });
    }
    if (path === "/agent/apply" && request.method === "POST") {
      let edits: ReadonlyArray<Edit>;
      try {
        const message = decodeClientMessage({
          ...((await request.json()) as object),
          type: "apply",
          requestId: "agent",
        });
        if (message.type !== "apply") throw new Error("Send edits.");
        edits = message.edits;
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      return move(edits);
    }
    // K-532: Organize of the cards that this agent may move, with the sizes of the last map Organize, and the checks
    // of a move. A card that a circle outside the agent's own holds stays put, so it does not refuse the others.
    if (path === "/agent/organize" && request.method === "POST") {
      const mayMove = (id: string) => {
        const place = this.state.places.get(id);
        if (!managed.has(id) || !place) return false;
        const probe: Change = { _tag: "place", id, before: place, after: place };
        // A separate after state, so a published card in Everyone needs "publishes" now, as the real move does.
        const after = applyChanges(this.state, [probe]);
        return agentRefusal(this.state, after, caller.visitor, [probe], now, added) === null;
      };
      const plan = organize(this.state, this.drawn ?? NO_SIZES, mayMove);
      if ("refused" in plan) return Response.json({ error: plan.refused }, { status: 409 });
      if (plan.edits.length === 0) return Response.json({ revision: null });
      return move(plan.edits, organizeSummary(plan.moved));
    }
    // K-1123: an agent key publishes a folder as a static site, in the steps of a repo deploy (K-805).
    if (path.startsWith("/agent/sites/") && request.method === "POST") {
      const input: unknown = await request.json().catch(() => null);
      return this.agentSite(
        agent,
        path.slice("/agent/sites/".length),
        isRecord(input) ? input : {},
        now,
        approved,
      );
    }
    // K-1116: an agent key publishes a page or a file, the same upload as a drop on the map.
    if (path === "/agent/library" && request.method === "POST")
      return this.agentPublish(agent, request, now, approved);
    // K-2006: an agent adds a game on a machine that it controls and closes its doors; it never opens one.
    if (path === "/agent/games" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const machineId = isRecord(body) && typeof body["machine"] === "string" ? body["machine"] : "";
      const relay = isRecord(body) && typeof body["relay"] === "string" ? body["relay"] : "";
      if (!agentHas(this.state, caller.visitor, "addsApps", now, approved))
        return Response.json(
          {
            error: 'The right "adds apps" is off for this agent. Ask the owner to turn it on.',
            need: "addsApps",
          },
          { status: 403 },
        );
      if (!managed.has(machineId) || (relay !== "" && !managed.has(relay)))
        return Response.json(
          { error: "An agent adds a game only on machines that it controls (K-2006)." },
          { status: 403 },
        );
      return this.createGame(agent.actor, body);
    }
    // K-1117, K-1123: an agent takes down a page, a file or a folder site that it published, and needs no right,
    // because that lowers access (K-715). A game card goes on below, with "adds apps".
    const removed =
      path.startsWith("/agent/cards/") && request.method === "DELETE"
        ? decodeURIComponent(path.slice("/agent/cards/".length))
        : null;
    if (removed !== null && !removed.includes("/") && this.gameRows("card_id = ?", removed).length === 0) {
      const card = this.agentCard(agent, removed, now);
      if (card === null)
        return Response.json(
          { error: `This agent removes only what it published; "${removed}" is none of that (K-1117).` },
          { status: 403 },
        );
      return this.isFolderSite(card) ? this.removeApp(agent, card) : this.deleteItem(agent, card);
    }
    // K-1117, K-821: an agent goes back to the previous version of a page, a file or a folder site that it published.
    if (path.startsWith("/agent/cards/") && path.endsWith("/previous") && request.method === "POST") {
      const named = decodeURIComponent(path.slice("/agent/cards/".length, -"/previous".length));
      const card = this.agentCard(agent, named, now);
      if (card === null)
        return Response.json(
          { error: `This agent changes only what it published; "${named}" is none of that (K-1117).` },
          { status: 403 },
        );
      if (!this.isFolderSite(card)) return this.restorePrevious(agent, card, "agent");
      const back = this.rollbackChoices(card).find((choice, index) => index > 0 && choice.why === null);
      if (!back)
        return Response.json(
          { error: "This folder site has no previous version to go back to (K-821)." },
          { status: 409 },
        );
      return this.rollbackResponse(agent, card, back.deployId);
    }
    // K-2006: an agent removes a game card on a machine that it controls, with "adds apps", as it adds one.
    if (
      path.startsWith("/agent/cards/") &&
      request.method === "DELETE" &&
      !path.slice("/agent/cards/".length).includes("/")
    ) {
      const card = path.slice("/agent/cards/".length);
      const [row] = this.gameRows("card_id = ?", card);
      if (!row)
        return Response.json(
          { error: `An agent removes only game cards; ${card} is none.` },
          { status: 404 },
        );
      if (!agentHas(this.state, caller.visitor, "addsApps", now, approved))
        return Response.json(
          {
            error: 'The right "adds apps" is off for this agent. Ask the owner to turn it on.',
            need: "addsApps",
          },
          { status: 403 },
        );
      if (!managed.has(row.machine_id) || (row.relay_id !== null && !managed.has(row.relay_id)))
        return Response.json(
          { error: "An agent removes a game only on machines that it controls (K-2006)." },
          { status: 403 },
        );
      return this.deleteGame(agent.actor, card);
    }
    if (path.startsWith("/agent/cards/") && path.includes("/doors")) {
      const [card = "", address] = path.slice("/agent/cards/".length).split("/doors");
      const [row] = this.gameRows("card_id = ?", card);
      if (!row || !managed.has(doorMachine(gameOf(row))))
        return Response.json(
          { error: "An agent sees the doors only of games on machines that it controls (K-2006)." },
          { status: 403 },
        );
      if (request.method === "GET" && !address) return Response.json(this.gameView(row, now));
      if (request.method === "DELETE" && address?.startsWith("/"))
        return this.closeDoorBy(agent.actor, card, decodeURIComponent(address.slice(1)));
    }
    // K-1127: a key hands a page or a folder site over to a new repo of its user.
    if (path.startsWith("/agent/cards/") && path.endsWith("/handover") && request.method === "POST") {
      const input: unknown = await request.json().catch(() => null);
      return this.handOver(
        agent,
        path.slice("/agent/cards/".length, -"/handover".length),
        isRecord(input) ? input : {},
        now,
        approved,
      );
    }
    if (path.startsWith("/agent/library/") && path.endsWith("/content") && request.method === "GET") {
      const id = path.slice("/agent/library/".length, -"/content".length);
      const refusal = this.agentMayChange(agent, id, now);
      return refusal ? Response.json({ error: refusal }, { status: 403 }) : this.preview(id);
    }
    if (path.startsWith("/agent/cards/") && path.includes("/redirects")) {
      const [card = "", rest = ""] = path.slice("/agent/cards/".length).split("/redirects");
      if (request.method === "POST" && rest === "")
        return this.addRedirect(agent, card, await addressBody(request), true);
      if (request.method === "DELETE" && rest.startsWith("/"))
        return this.removeRedirect(agent, card, decodeURIComponent(rest.slice(1)), true);
    }
    if (path.startsWith("/agent/cards/") && path.endsWith("/time") && request.method === "POST")
      return this.cardTime(
        agent,
        decodeURIComponent(path.slice("/agent/cards/".length, -"/time".length)),
        await request.json().catch(() => null),
        true,
      );
    if (path.startsWith("/agent/cards/") && path.endsWith("/address") && request.method === "POST")
      return this.setAddress(
        agent,
        path.slice("/agent/cards/".length, -"/address".length),
        await addressBody(request),
        true,
      );
    if (path.startsWith("/agent/library/") && path.endsWith("/previous") && request.method === "POST")
      return this.restorePrevious(agent, path.slice("/agent/library/".length, -"/previous".length), "agent");
    if (path === "/agent/jobs" && request.method === "POST") {
      if (!machineMay("runsCommands"))
        return Response.json(
          { error: 'The right "runs commands" is off for this machine (K-1720).' },
          { status: 403 },
        );
      const body: unknown = await request.json().catch(() => null);
      const machineId =
        typeof body === "object" && body !== null && "machineId" in body ? body.machineId : undefined;
      // K-718, K-909: an agent key removes nothing, also no orphaned volume.
      const command = isRecord(body) && isRecord(body["command"]) ? body["command"] : null;
      if (command?.["kind"] === "compose-volume-remove")
        return Response.json({ error: NO_VOLUME_JOBS }, { status: 403 });
      const noUpdate =
        command?.["kind"] === "update" && typeof machineId === "string"
          ? this.agentUpdateRefusal(machineId)
          : null;
      if (noUpdate !== null) return Response.json({ error: noUpdate }, { status: 409 });
      // Only the machines whose cards it manages; a label job could land on any machine.
      const outside = ownerApproved
        ? null
        : this.outsideAgentLimit(caller.visitor, "job", typeof machineId === "string" ? machineId : "", body);
      if (outside !== null) return Response.json({ error: outside }, { status: 403 });
      return this.addJob(agent, body, ownerApproved);
    }
    if (path.startsWith("/agent/jobs/") && request.method === "GET") {
      const id = Number(path.slice("/agent/jobs/".length));
      const [row] = Number.isSafeInteger(id)
        ? this.sql<{ visitor: string }>("SELECT visitor FROM jobs WHERE id = ?", id)
        : [];
      const sender = row ? (JSON.parse(row.visitor) as Visitor).clientId : null;
      const [job] = sender !== null && sender === caller.visitor.clientId ? this.recentJobs(1, 4000, id) : [];
      // Only its own jobs: their state, exit code and output.
      if (!job) return Response.json({ error: `This agent sent no job ${id}.` }, { status: 404 });
      // K-718: an approved deploy of a card that it does not manage shows no machine, repo or Compose output.
      if (job.command.kind === "compose-redeploy" && !managed.has(job.command.project))
        return Response.json({
          state: job.state,
          reason:
            job.state !== "failed"
              ? null
              : job.output.startsWith(NO_LONGER_ALLOWED)
                ? job.output
                : "The job failed. The owner reads why on the map.",
        });
      return Response.json(job);
    }
    if (path.startsWith("/agent/repos/") && request.method === "POST") {
      // K-1504: the pause stops agent keys.
      if (this.state.paused)
        return Response.json(
          { error: "kitshn is paused (Emergency pause). Agent keys wait until Resume." },
          { status: 423 },
        );
      const repoId = decodeURIComponent(path.slice("/agent/repos/".length));
      const body: unknown = await request.json().catch(() => null);
      const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
      const refusal = agentAllowRefusal(
        row ? repoGateOf(row) : undefined,
        isRecord(body) ? body["state"] : null,
        agentHas(this.state, caller.visitor, "addsApps", Date.now(), approved),
        row?.gone_at !== null && row?.gone_at !== undefined,
      );
      if (refusal) return Response.json({ error: refusal.error }, { status: refusal.status });
      // An agent circle names this key or machine, so its member exists.
      if (agentName === null || caller.visitor.clientId === null)
        throw new Error("An agent without its member in an agent circle allowed a repo.");
      return this.setRepoState(
        agent,
        repoId,
        { state: "allowed" },
        { clientId: caller.visitor.clientId, name: agentName },
      );
    }
    // K-1810: a key reads the logs of a card only while it controls the card; the same search as the map.
    if (path === "/agent/logs" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
      if (card === null)
        return Response.json({ error: 'Send {"card": <id>, "tab", "text", "from", "to"}.' }, { status: 400 });
      if (!managed.has(card))
        return Response.json(
          { error: `This agent has no control on the card "${card}" (K-1810).` },
          { status: 403 },
        );
      // K-1810: each key searches at most 30 times a minute, so a loop cannot keep a daemon busy.
      const wait = this.logRateWait(caller.visitor.clientId ?? "", now);
      if (wait > 0)
        return Response.json(
          { error: `This agent searched logs 30 times in the last minute; try again in ${wait} s (K-1810).` },
          { status: 429, headers: { "retry-after": String(wait) } },
        );
      // The query schema of the map ignores the extra `card` key.
      return await this.logsResponse(card, body);
    }
    if (path === "/agent/deploy" && request.method === "POST") {
      if (!machineMay("deploys"))
        return Response.json(
          { error: 'The right "deploys" is off for this machine (K-1720).' },
          { status: 403 },
        );
      const body: unknown = await request.json().catch(() => null);
      const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
      const mode = isRecord(body) ? body["mode"] : null;
      if (card === null || (mode !== "redeploy" && mode !== "build"))
        return Response.json(
          { error: 'Send {"card": <id>, "mode": "redeploy" | "build"}.' },
          { status: 400 },
        );
      const outside = this.outsideAgentLimit(caller.visitor, "deploy", card, null);
      if (outside !== null && !ownerApproved) return Response.json({ error: outside }, { status: 403 });
      const row = this.lastDone(card);
      const machine = row?.machine_id ? this.state.machines.get(row.machine_id) : undefined;
      const plan = agentDeployPlan(
        row ? this.lastDeployOf(row) : null,
        mode,
        machine ? this.redeployFacts(machine, card, row?.repo ?? "") : null,
      );
      if (plan.kind === "refused") return Response.json({ error: plan.error }, { status: plan.status });
      const repoId = row?.repo_id ?? null;
      const refusal = this.repoRefusal(repoId);
      if (refusal !== null || repoId === null)
        return Response.json(
          { error: outside === null ? refusal : "The repo of this card does not take a deploy now (K-819)." },
          { status: 403 },
        );
      if (plan.kind === "build") {
        const started = await this.agentBuild(agent, repoId, plan.branch, row?.workflow ?? AGENT_WORKFLOW);
        // K-718: the repo of a card that it does not manage stays hidden.
        return started.ok && outside !== null ? Response.json({ dispatched: true }) : started;
      }
      if (!machine) return Response.json({ error: "The machine of this app is gone." }, { status: 409 });
      return this.agentRedeploy(agent, machine.id, plan.command, ownerApproved);
    }
    return Response.json({ error: `The agent path has no ${request.method} ${path}.` }, { status: 404 });
  }

  /** K-718: why this sender may not run this job or deploy without a person, or null. `addJob` refuses a bad command. */
  private outsideAgentLimit(visitor: Visitor, action: ProposalAction, target: string, body: unknown) {
    const now = Date.now();
    if (action === "deploy")
      return cardsControlledBy(this.state, visitor, now).has(target)
        ? null
        : `This agent has no control on the card "${target}".`;
    if (action !== "job") return null;
    const command = parseCommand(isRecord(body) ? body["command"] : null);
    return typeof command === "string" || agentMayCommand(this.state, visitor, target, command.kind, now)
      ? null
      : "An agent runs jobs only on a machine whose card, and every card that runs on it, it manages (K-718).";
  }

  /** K-1710: answers one ask of a machine on its own connection. */
  private async answerAsk(socket: WebSocket, machine: Machine, message: Record<string, unknown>) {
    const requestId = typeof message["requestId"] === "string" ? message["requestId"].slice(0, 64) : null;
    if (requestId === null) return;
    const outcome = await this.ask(machine, isRecord(message["ask"]) ? message["ask"] : {});
    send(socket, { type: "askAnswer", requestId, ...outcome });
  }

  /** K-1710 to K-1722: checks one ask, runs it, makes a proposal, or refuses it with the reason. */
  private async ask(
    machine: Machine,
    raw: Record<string, unknown>,
    /** K-722: only `execStart` asks for `exec`, after its own checks. */
    exec = false,
  ): Promise<AskOutcome> {
    const now = Date.now();
    const action = raw["action"];
    if ((action === "exec") !== exec)
      return { outcome: "refused", reason: "An exec starts with the exec request of the daemon (K-722)." };
    const target = typeof raw["target"] === "string" ? raw["target"].slice(0, 512) : "";
    const reason = typeof raw["reason"] === "string" ? raw["reason"].slice(0, 500) : null;
    const problem = labelProblem(raw["labels"]);
    // K-1752, K-1753: labels of a provider prefix count only from the daemon's `attested`; a caller's own are dropped.
    const prefixes = this.labelPrefixesOf(machine.id);
    const reserved = prefixes;
    const claimed = Object.fromEntries(
      Object.entries(
        problem === null && isRecord(raw["labels"]) ? (raw["labels"] as Record<string, string>) : {},
      ).filter(([key]) => !reserved.some((prefix) => key.startsWith(prefix))),
    );
    const attested = Object.fromEntries(
      Object.entries(isRecord(raw["attested"]) ? raw["attested"] : {})
        .filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" &&
            entry[0].length <= 64 &&
            entry[1].length <= 256 &&
            prefixes.some((prefix) => entry[0].startsWith(prefix)),
        )
        .slice(0, 20),
    );
    const labels: Record<string, string> = { ...claimed, ...attested };
    const event = (outcome: AskOutcome) => {
      if (isAskAction(action)) this.askEvent(now, machine, action, target, reason, labels, outcome);
      return outcome;
    };
    if (!isAskAction(action))
      return { outcome: "refused", reason: `kitshn does not know the action ${String(action)}.` };
    if (problem !== null) return event({ outcome: "refused", reason: problem });
    if (this.state.paused)
      return event({
        outcome: "refused",
        reason: "kitshn is paused (Emergency pause). Asks wait until Resume (K-1504).",
      });
    if (action === "approve" || action === "deny") {
      const visitor = { email: null, clientId: machine.clientId, ip: null };
      const decided = await this.decide(target, action === "approve" ? "approved" : "denied", {
        actor: { _tag: "machine", machineId: machine.id, name: machine.name },
        visitor,
        machineId: machine.id,
        reason,
      });
      return event(
        decided.ok
          ? { outcome: "done", result: decided.result ?? null }
          : { outcome: "refused", reason: decided.error },
      );
    }
    if (action === "github-token")
      return event(await this.askGitHubToken(machine, target, raw["body"], reason, labels, now));
    // K-1773: an agent removes an audience that its machine added at once, because that lowers access (K-715).
    if (action === "audience-remove") {
      const [row] = this.sql<{ added_by: string | null }>(
        "SELECT added_by FROM pass_audiences WHERE address = ?",
        target,
      );
      if (row?.added_by !== machine.id)
        return event({
          outcome: "refused",
          reason: "A machine removes only an audience that it added (K-1773).",
        });
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM pass_audiences WHERE address = ?", target);
        this.insertRevision(
          { _tag: "machine", machineId: machine.id, name: machine.name },
          `Removed the pass audience ${target}`,
          [],
          null,
        );
      });
      this.broadcast();
      return event({ outcome: "done", result: { removed: target } });
    }
    // K-1774: passes stay off until the owner turns them on after the host move (K-1209).
    if (action === "pass" && this.meta("passes_on") !== "1")
      return event({
        outcome: "refused",
        reason: 'Passes are off. The owner turns on "Passes" in Settings after the host move (17.7).',
      });
    if (
      action === "pass" &&
      this.sql("SELECT 1 AS one FROM pass_audiences WHERE address = ?", target).length === 0
    )
      return event({ outcome: "refused", reason: `${target} is not in the pass audiences (K-1773).` });
    // K-1756: the ask events of this machine with one label, `target` is key=value; it writes no event itself.
    if (action === "history") {
      const equals = target.indexOf("=");
      if (equals <= 0)
        return { outcome: "refused", reason: "history takes key=value, for example t3.thread.id=abc." };
      return {
        outcome: "done",
        result: this.askEventsWithLabel(target.slice(0, equals), target.slice(equals + 1), machine.id),
      };
    }
    // K-1819, K-1820: a card that the machine does not manage refuses at once, so the Owner gets no ask that cannot run.
    if (
      (action === "backup" || action === "restore") &&
      !cardsControlledBy(this.state, { email: null, clientId: machine.clientId, ip: null }, now).has(target)
    )
      return event({
        outcome: "refused",
        reason: `This machine does not manage the card ${target} (K-718).`,
      });
    // K-718, K-909: a job that no approval can run refuses at once, so the Owner gets no ask that cannot run.
    if (action === "job") {
      const command = parseCommand(isRecord(raw["body"]) ? raw["body"]["command"] : null);
      if (typeof command === "string") return event({ outcome: "refused", reason: command });
      if (command.kind === "compose-volume-remove")
        return event({ outcome: "refused", reason: NO_VOLUME_JOBS });
      const noUpdate = command.kind === "update" ? this.agentUpdateRefusal(target) : null;
      if (noUpdate !== null) return event({ outcome: "refused", reason: noUpdate });
    }
    const needs = ASK_RIGHT[action];
    if (needs === "member")
      throw new Error(`The action ${action} needs membership, and only approve and deny do.`);
    if (needs !== "none" && needs !== "apply") {
      const mode = machineRightMode(this.state, machine.id, needs, now);
      // K-1776: a right that no circle sets asks the Owner for this one call; a right set to "off" refuses.
      if (mode === null) {
        if (machineRightOff(this.state, machine.id, needs, now)) return event(offRight(needs));
        const owned =
          WINDOW_ACTIONS.has(action) &&
          this.inApprovedWindow(machine.id, action, target, needs, OWNER_CIRCLE_ID, now);
        if (!owned)
          return event(
            await this.propose(
              machine,
              action,
              target,
              raw["body"],
              reason,
              labels,
              needs,
              OWNER_CIRCLE_ID,
              now,
            ),
          );
        return event(await this.runAsk(machine, action, target, raw["body"], [needs], labels));
      }
      const failed = conditionProblem(mode.conditions, labels, prefixes);
      if (failed) return event({ outcome: "refused", reason: failed });
      // K-718: a call outside the limit of the machine asks the Owner, whatever the mode of its right.
      const visitor = { email: null, clientId: machine.clientId, ip: null };
      if (this.outsideAgentLimit(visitor, action, target, raw["body"]) !== null)
        return event(
          await this.propose(
            machine,
            action,
            target,
            raw["body"],
            reason,
            labels,
            needs,
            OWNER_CIRCLE_ID,
            now,
          ),
        );
      if (
        mode.mode === "ask" &&
        !(
          WINDOW_ACTIONS.has(action) &&
          this.inApprovedWindow(machine.id, action, target, needs, mode.circleId, now)
        )
      )
        return event(
          await this.propose(machine, action, target, raw["body"], reason, labels, needs, mode.circleId, now),
        );
    }
    // K-532: Organize keeps every share, so it never moves a card into Everyone and needs no "publishes".
    if (needs === "apply" && action !== "organize") {
      const edits = this.askEdits(machine, action, target, raw["body"], now, []);
      if (typeof edits === "string") {
        // K-1720: a move into Everyone needs "publishes"; with "ask <circle>" it waits for an approval.
        const mode = machineRightMode(this.state, machine.id, "publishes", now);
        const failed = conditionProblem(mode?.conditions, labels, prefixes);
        if (failed) return event({ outcome: "refused", reason: failed });
        const withApproval = this.askEdits(machine, action, target, raw["body"], now, ["publishes"]);
        if (mode?.mode === "ask" && typeof withApproval !== "string")
          return event(
            await this.propose(
              machine,
              action,
              target,
              raw["body"],
              reason,
              labels,
              "publishes",
              mode.circleId,
              now,
            ),
          );
        // K-1776: only "publishes" stands in the way, and no circle sets it.
        if (mode === null && typeof withApproval !== "string")
          return event(
            !machineRightOff(this.state, machine.id, "publishes", now)
              ? await this.propose(
                  machine,
                  action,
                  target,
                  raw["body"],
                  reason,
                  labels,
                  "publishes",
                  OWNER_CIRCLE_ID,
                  now,
                )
              : offRight("publishes"),
          );
        return event({ outcome: "refused", reason: edits });
      }
    }
    return event(await this.runAsk(machine, action, target, raw["body"], [], labels));
  }

  /**
   * K-1711: the edits of `apply`, or of `publish` (a move into or out of Everyone), checked by the rules of K-718 as
   * the machine; a string names why not.
   */
  private askEdits(
    machine: Machine,
    action: AskAction,
    target: string,
    body: unknown,
    now: number,
    approved: ReadonlyArray<MachineRight>,
  ): ReadonlyArray<Edit> | string {
    const visitor = { email: null, clientId: machine.clientId, ip: null };
    let edits: ReadonlyArray<Edit>;
    if (action === "publish") {
      const wantsPublic = !(isRecord(body) && body["public"] === false);
      // A move out of Everyone stays in an agent circle that holds the card, not in the tray.
      const holding = circlesHolding(this.state, target);
      const home = wantsPublic
        ? null
        : (agentHomeCircle(this.state, machine.clientId, now, holding)?.id ?? null);
      const to = agentUploadPlace(this.state, visitor, home, wantsPublic, now, approved);
      if (to === null || typeof to === "string")
        return to ?? "This machine has no agent circle with control (K-718).";
      edits = [{ _tag: "place", id: target, after: to }];
    } else {
      try {
        const message = decodeClientMessage({
          edits: isRecord(body) ? body["edits"] : undefined,
          type: "apply",
          requestId: "ask",
        });
        if (message.type !== "apply") return "Send edits.";
        edits = message.edits;
      } catch (error) {
        return `The edits do not decode: ${String(error)}`;
      }
    }
    try {
      const changes = resolveEdits(this.state, edits);
      const refusal = agentRefusal(
        this.state,
        applyChanges(this.state, changes),
        visitor,
        changes,
        now,
        this.agentAdded(machine.clientId),
        approved,
      );
      return refusal ?? edits;
    } catch (error) {
      if (error instanceof RuleError) return error.message;
      throw error;
    }
  }

  /** K-718: the cards of repos that this agent allowed (K-819), and the pages and files that it published. */
  private agentAdded(clientId: string | null) {
    return new Set(
      this.sql<{ resource_id: string }>(
        `SELECT DISTINCT deploys.resource_id FROM deploys JOIN repos ON repos.repo_id = deploys.repo_id AND deploys.kind = 'deploy'
         WHERE repos.allowed_by_client = ?
         UNION SELECT id FROM library WHERE added_by = ?`,
        clientId,
        clientId,
      ).map((row) => row.resource_id),
    );
  }

  /** K-1710: runs an ask through the agent path of its action, as the machine. */
  private async runAsk(
    machine: Machine,
    action: AskAction,
    target: string,
    body: unknown,
    approved: ReadonlyArray<MachineRight>,
    labels: Readonly<Record<string, string>> = {},
    ownerApproved: OwnerApproval | null = null,
  ): Promise<AskOutcome> {
    if (action === "pass") return this.issuePass(machine, target, labels);
    if (action === "exec") return this.startExecRun(machine, target, body);
    // K-1819, K-1820: a backup now or a restore of a Compose card that the machine manages.
    if (action === "backup" || action === "restore") {
      const visitor = { email: null, clientId: machine.clientId, ip: null };
      if (!cardsControlledBy(this.state, visitor, Date.now()).has(target))
        return { outcome: "refused", reason: `This machine does not manage the card ${target} (K-718).` };
      const actor: Actor = { _tag: "machine", machineId: machine.id, name: machine.name };
      const run = isRecord(body) && typeof body["run"] === "string" ? body["run"] : "";
      const response =
        action === "backup" ? this.backUpNow(actor, target) : this.restoreBackup(actor, target, run);
      const answer: unknown = await response.json();
      return response.ok
        ? { outcome: "done", result: answer }
        : {
            outcome: "refused",
            reason:
              isRecord(answer) && typeof answer["error"] === "string"
                ? answer["error"]
                : `answered ${response.status}`,
          };
    }
    if (action === "audience-add")
      return this.addAudience(target, { machineId: machine.id, name: machine.name });
    if (action === "github-token") {
      const permission = isRecord(body) && body["permission"] === "write" ? "write" : "read";
      return this.mintToken(machine, target, permission);
    }
    let mapped = askRequest(action, target, body);
    if (action === "publish") {
      const edits = this.askEdits(machine, action, target, body, Date.now(), approved);
      if (typeof edits === "string") return { outcome: "refused", reason: edits };
      mapped = { method: "POST", path: "/agent/apply", body: { edits } };
    }
    if (typeof mapped === "string")
      return { outcome: "refused", reason: `${action} comes with a later part of section 17.` };
    const caller: Caller = {
      visitor: { email: null, clientId: machine.clientId, ip: null },
      actor: { _tag: "machine", machineId: machine.id, name: machine.name },
    };
    const url = new URL(mapped.path, "https://kitshn.internal");
    const request = new Request(url, {
      method: mapped.method,
      headers: { "content-type": "application/json" },
      ...(mapped.method === "POST" ? { body: JSON.stringify(mapped.body) } : {}),
    });
    const response = await this.agentRequest(url.pathname, request, caller, approved, ownerApproved);
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) return { outcome: "done", result: json };
    return {
      outcome: "refused",
      reason:
        isRecord(json) && typeof json["error"] === "string"
          ? json["error"]
          : `kitshn answered ${response.status}.`,
    };
  }

  /** K-1733: a new repo group card, in the tray. */
  private addRepoGroup(caller: Caller, body: unknown) {
    const match = isRecord(body) && typeof body["match"] === "string" ? body["match"].trim() : "";
    const problem = matchProblem(match);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const id = repoGroupId(match);
    if (id === null)
      return Response.json({ error: "This match is too long for a card id." }, { status: 400 });
    if (this.state.resources.has(id))
      return Response.json({ error: `The repo group ${match} exists already.` }, { status: 409 });
    const resource: Resource = {
      id,
      kind: "repo.group",
      name: match,
      addresses: [],
      status: "unknown",
      group: null,
      machine: null,
      match,
    };
    this.ctx.storage.transactionSync(() => {
      this.putResource(resource);
      this.insertRevision(caller.actor, `Added the repo group ${match}`, [], null);
    });
    this.load();
    this.broadcast();
    return Response.json({ id });
  }

  /** K-1733, K-1760: sets the GitHub way of an owner group, or deletes a repo group with its place. */
  private changeRepoGroup(caller: Caller, id: string, body: unknown) {
    const group = this.state.resources.get(id);
    if (group?.kind !== "repo.group")
      return Response.json({ error: `No repo group "${id}" exists.` }, { status: 404 });
    if (body === null) {
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM resources WHERE id = ?", id);
        this.sql("DELETE FROM places WHERE id = ?", id);
        this.insertRevision(caller.actor, `Deleted the repo group ${group.name}`, [], null);
      });
      this.load();
      this.broadcast();
      return Response.json({ deleted: id });
    }
    const way = isRecord(body) ? body["githubWay"] : null;
    if (!GITHUB_WAYS.includes(way as GitHubWay))
      return Response.json({ error: 'Send {"githubWay": "app" | "not-kitshn"}.' }, { status: 400 });
    if (group.match?.includes("/"))
      return Response.json({ error: "Only an owner group has a GitHub way (K-1760)." }, { status: 409 });
    this.ctx.storage.transactionSync(() => {
      this.putResource({ ...group, githubWay: way as GitHubWay });
      this.insertRevision(
        caller.actor,
        `Set the GitHub way of ${group.name} to ${way === "app" ? "kitshn App token" : "not kitshn"}`,
        [],
        null,
      );
    });
    this.load();
    this.broadcast();
    return Response.json({ githubWay: way });
  }

  /**
   * K-1767: the bot login of the kitshn App, asked once and kept. Null without the App, because then no bot run is
   * kitshn's; "unknown" when GitHub does not answer.
   */
  private async appBot(): Promise<string | null> {
    const kept = this.meta("github_app_bot");
    if (kept) return kept;
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY) return null;
    const login = await appBotLogin({ id: this.env.GITHUB_APP_ID, key: this.env.GITHUB_APP_KEY }).catch(
      () => null,
    );
    if (login) this.setMeta("github_app_bot", login);
    return login ?? "unknown";
  }

  /**
   * K-1752, K-1753: the label prefix of each provider of the machine and `t3.`; only the daemon sets labels of these,
   * from the attestation of that provider.
   */
  private labelPrefixesOf(machineId: string): Array<string> {
    return [...new Set(["t3.", ...(this.providerRegs.get(machineId) ?? []).map((reg) => `${reg.name}.`)])];
  }

  /** K-1771: the pass keys, newest first; the first is current. One read of a small table. */
  private passKeys(): Array<PassKey> {
    return this.sql<{
      kid: string;
      private_jwk: string;
      public_jwk: string;
      created_at: number;
      retired_at: number | null;
    }>("SELECT * FROM pass_keys ORDER BY created_at DESC").map((row) => ({
      kid: row.kid,
      privateJwk: JSON.parse(row.private_jwk) as PassKey["privateJwk"],
      publicJwk: JSON.parse(row.public_jwk) as PassKey["publicJwk"],
      createdAt: row.created_at,
      retiredAt: row.retired_at,
    }));
  }

  /**
   * K-1771, K-1822: "Rotate pass key", and the last step of kitshn's own restore to a time. A new key becomes current;
   * the old one stays in the JWKS for 6 minutes, and keys past that, or past 5, go.
   */
  private async rotatePassKey(actor: Actor): Promise<void> {
    const now = Date.now();
    const key = await newPassKey(now);
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE pass_keys SET retired_at = ? WHERE retired_at IS NULL", now);
      this.sql("DELETE FROM pass_keys WHERE retired_at IS NOT NULL AND retired_at < ?", now - RETIRED_MS);
      this.sql(
        "INSERT INTO pass_keys (kid, private_jwk, public_jwk, created_at, retired_at) VALUES (?, ?, ?, ?, NULL)",
        key.kid,
        JSON.stringify(key.privateJwk),
        JSON.stringify(key.publicJwk),
        now,
      );
      this.sql(
        "DELETE FROM pass_keys WHERE kid NOT IN (SELECT kid FROM pass_keys ORDER BY created_at DESC LIMIT ?)",
        MAX_KEYS,
      );
      this.insertRevision(actor, "Rotated the pass key", [], null);
    });
    // K-1762: a rotation answers a doubt about kitshn's secrets, so the daemons ask again for each token.
    for (const socket of this.ctx.getWebSockets("machines"))
      if (attachmentOf(socket)?.kind === "machine") send(socket, { type: "dropTokens", repo: null });
  }

  /** K-1770 to K-1773: what Settings shows of the passes: on or off, the audiences and the public keys. Never a private half. */
  private passSettings() {
    return {
      on: this.meta("passes_on") === "1",
      issuer: `https://${this.env.KITSHN_HOST}`,
      audiences: this.sql<{ address: string; labels: number; added_by: string | null }>(
        "SELECT address, labels, added_by FROM pass_audiences ORDER BY added_at",
      ).map((row) => ({ address: row.address, labels: row.labels === 1, addedBy: row.added_by })),
      keys: this.passKeys().map((key) => ({
        kid: key.kid,
        createdAt: key.createdAt,
        retiredAt: key.retiredAt,
      })),
    };
  }

  /** K-1770, K-1771: the discovery document and the JWKS, with no login; "not found" while passes are off. */
  private async wellKnown(file: string): Promise<Response> {
    if (this.meta("passes_on") !== "1") return Response.json({ error: "Not found." }, { status: 404 });
    const issuer = `https://${this.env.KITSHN_HOST}`;
    const headers = { "cache-control": "public, max-age=300" };
    if (file === "openid-configuration") return Response.json(discovery(issuer), { headers });
    if (this.passKeys().length === 0) await this.rotatePassKey({ _tag: "kitshn", reason: "first pass key" });
    return Response.json(jwks(this.passKeys(), Date.now()), { headers });
  }

  /** K-1772, K-1774: a 5-minute pass for one audience; the attested labels go in only when the audience allows them. */
  private async issuePass(
    machine: Machine,
    audience: string,
    labels: Readonly<Record<string, string>>,
  ): Promise<AskOutcome> {
    const [row] = this.sql<{ labels: number }>(
      "SELECT labels FROM pass_audiences WHERE address = ?",
      audience,
    );
    if (!row) return { outcome: "refused", reason: `${audience} is not in the pass audiences (K-1773).` };
    if (this.passKeys().length === 0) await this.rotatePassKey({ _tag: "kitshn", reason: "first pass key" });
    const [key] = this.passKeys();
    if (!key) throw new Error("kitshn made a pass key and has none.");
    const verified = Object.fromEntries(
      Object.entries(labels).filter(([name]) => this.verifiedKeys(machine.id, labels).includes(name)),
    );
    const signed = await signPass(
      key,
      {
        issuer: `https://${this.env.KITSHN_HOST}`,
        audience,
        machineId: machine.id,
        labels: row.labels === 1 ? verified : null,
      },
      Date.now(),
    );
    return {
      outcome: "done",
      result: { pass: signed.pass, expiresAt: new Date(signed.expiresAt).toISOString() },
    };
  }

  /** K-1773: adds an outside service to the pass audiences; an exact https address, never more than 50. */
  private addAudience(
    address: string,
    by: { readonly machineId: string | null; readonly name: string },
    labels = false,
  ): AskOutcome {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return { outcome: "refused", reason: `${address} is not an address (K-1773).` };
    }
    if (url.protocol !== "https:")
      return { outcome: "refused", reason: "A pass audience is an https address (K-1773)." };
    const [count] = this.sql<{ count: number }>("SELECT COUNT(*) AS count FROM pass_audiences");
    if ((count?.count ?? 0) >= 50)
      return { outcome: "refused", reason: "kitshn keeps at most 50 pass audiences." };
    const actor: Actor = by.machineId
      ? { _tag: "machine", machineId: by.machineId, name: by.name }
      : { _tag: "kitshn", reason: by.name };
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR IGNORE INTO pass_audiences (address, labels, added_by, added_at) VALUES (?, ?, ?, ?)",
        address,
        labels ? 1 : 0,
        by.machineId,
        Date.now(),
      );
      this.insertRevision(actor, `Added the pass audience ${address}`, [], null);
    });
    this.broadcast();
    return { outcome: "done", result: { added: address } };
  }

  /** K-1760: the GitHub way of an owner, from its owner group or the default of Settings. */
  private githubWay(owner: string): GitHubWay {
    return githubWayOf(this.state, owner, this.meta("github_default_way") === "app" ? "app" : "not-kitshn");
  }

  /**
   * K-1762: a token for one repo. The owner's way decides first (K-1760); then "writes code" or "reads code" on a card
   * that covers the repo, with its mode. `permission` "auto" (kitshn gh) asks for write when the machine may write (K-1764).
   */
  private async askGitHubToken(
    machine: Machine,
    fullName: string,
    body: unknown,
    reason: string | null,
    labels: Readonly<Record<string, string>>,
    now: number,
  ): Promise<AskOutcome> {
    const owner = fullName.split("/")[0] ?? "";
    if (matchProblem(fullName) !== null || !fullName.includes("/") || fullName.includes("*"))
      return { outcome: "refused", reason: `${fullName} is not owner/name (K-1762).` };
    if (this.githubWay(owner) !== "app")
      return {
        outcome: "not-kitshn",
        reason: `${owner} is "not kitshn"; the machine uses its own login (K-1760).`,
      };
    const wanted = isRecord(body) ? body["permission"] : "auto";
    // K-1764, K-1776: gh cannot say whether it writes, so "auto" asks for write when the machine may write, when an Owner
    // approval of write is open, and when no code right is set at all (the Owner then approves write).
    const unset =
      codeRightMode(this.state, machine.id, "readsCode", fullName, now) === null &&
      !codeRightOff(this.state, machine.id, "readsCode", fullName, now) &&
      !codeRightOff(this.state, machine.id, "writesCode", fullName, now);
    const write =
      wanted === "write" ||
      (wanted !== "read" &&
        (codeRightMode(this.state, machine.id, "writesCode", fullName, now) !== null ||
          this.inApprovedWindow(machine.id, "github-token", fullName, "writesCode", OWNER_CIRCLE_ID, now) ||
          unset));
    const right: MachineRight = write ? "writesCode" : "readsCode";
    const mode = codeRightMode(this.state, machine.id, right, fullName, now);
    const failed = mode ? conditionProblem(mode.conditions, labels, this.labelPrefixesOf(machine.id)) : null;
    if (failed) return { outcome: "refused", reason: failed };
    // K-1776: a code right that no card sets asks the Owner for this token; one set to "off" refuses.
    if (mode === null) {
      const permission = write ? "write" : "read";
      if (codeRightOff(this.state, machine.id, right, fullName, now))
        return offRight(right, `for ${fullName} (K-1733)`);
      if (this.inApprovedWindow(machine.id, "github-token", fullName, right, OWNER_CIRCLE_ID, now))
        return this.mintToken(machine, fullName, permission);
      return this.propose(
        machine,
        "github-token",
        fullName,
        { permission },
        reason,
        labels,
        right,
        OWNER_CIRCLE_ID,
        now,
      );
    }
    if (
      mode.mode === "ask" &&
      !this.inApprovedWindow(machine.id, "github-token", fullName, right, mode.circleId, now)
    )
      return this.propose(
        machine,
        "github-token",
        fullName,
        { permission: write ? "write" : "read" },
        reason,
        labels,
        right,
        mode.circleId,
        now,
      );
    return this.mintToken(machine, fullName, write ? "write" : "read");
  }

  /**
   * K-1723: the same ask of this machine, approved by the circle that the right asks now, within the last hour. A
   * token never waits in a queue, so the approval opens this window and the next ask gets the token.
   */
  private inApprovedWindow(
    machineId: string,
    action: AskAction,
    target: string,
    right: MachineRight,
    circleId: string,
    now: number,
  ) {
    return (
      this.sql(
        `SELECT 1 AS one FROM proposals WHERE machine_id = ? AND action = ? AND target = ? AND right_name = ?
         AND circle_id = ? AND state = 'approved' AND decided_at > ? LIMIT 1`,
        machineId,
        action,
        target,
        right,
        circleId,
        now - APPROVED_WINDOW_MS,
      ).length > 0
    );
  }

  /** K-1762: makes the token through the App, keeps a sealed copy for revocation (K-1716), and gives it to the daemon. */
  private async mintToken(
    machine: Machine,
    fullName: string,
    permission: "read" | "write",
  ): Promise<AskOutcome> {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key) return { outcome: "refused", reason: NO_GITHUB_APP };
    const owner = (fullName.split("/")[0] ?? "").toLowerCase();
    const [known] = this.sql<{ installation_id: number }>(
      "SELECT installation_id FROM github_installations WHERE owner = ?",
      owner,
    );
    try {
      const minted = await repoToken(
        { id: appId, key },
        fullName,
        permission,
        known?.installation_id ?? null,
        this.sql<{ repo_id: string }>(
          "SELECT repo_id FROM repos WHERE name = ? COLLATE NOCASE AND gone_at IS NULL LIMIT 1",
          fullName,
        )[0]?.repo_id ?? null,
      );
      if (minted.installationId !== known?.installation_id)
        this.sql(
          "INSERT OR REPLACE INTO github_installations (owner, installation_id) VALUES (?, ?)",
          owner,
          minted.installationId,
        );
      this.tokensLive = true;
      this.sql(
        "INSERT INTO github_tokens (id, machine_id, repo, right_name, expires_at, sealed) VALUES (?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        machine.id,
        fullName,
        permission === "write" ? "writesCode" : "readsCode",
        Date.parse(minted.expiresAt),
        await sealToken(key, minted.token),
      );
      return { outcome: "done", result: { token: minted.token, expiresAt: minted.expiresAt, permission } };
    } catch (error) {
      if (error instanceof NotInstalled) return { outcome: "refused", reason: error.message };
      // A stale installation id fails once; the next ask looks it up again.
      if (known) this.sql("DELETE FROM github_installations WHERE owner = ?", owner);
      return { outcome: "refused", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * K-1716: revokes the live GitHub tokens of one machine, or of every machine with null. With `onlyLost`, it keeps
   * the tokens whose right the machine still has, so a right turned off revokes only what it gave.
   */
  private revokeTokens(machineId: string | null, onlyLost: boolean) {
    if (!this.tokensLive) return;
    const now = Date.now();
    this.sql("DELETE FROM github_tokens WHERE expires_at <= ?", now);
    const rows = this.sql<{
      id: string;
      machine_id: string;
      repo: string;
      right_name: string;
      sealed: string;
    }>("SELECT id, machine_id, repo, right_name, sealed FROM github_tokens");
    this.tokensLive = rows.length > 0;
    const key = this.env.GITHUB_APP_KEY;
    for (const row of rows) {
      if (machineId !== null && row.machine_id !== machineId) continue;
      const right = row.right_name === "writesCode" ? "writesCode" : "readsCode";
      if (onlyLost && codeRightMode(this.state, row.machine_id, right, row.repo, now) !== null) continue;
      this.sql("DELETE FROM github_tokens WHERE id = ?", row.id);
      const socket = this.openSocket(row.machine_id);
      if (socket) send(socket, { type: "dropTokens", repo: row.repo });
      if (!key) continue;
      this.ctx.waitUntil(
        openToken(key, row.sealed)
          .then(revokeToken)
          .catch((error: unknown) => console.warn(`kitshn could not revoke a token: ${String(error)}`)),
      );
    }
  }

  /** K-1722: an ask that waits for one member of its approver circle. */
  private async propose(
    machine: Machine,
    action: ProposalAction,
    target: string,
    body: unknown,
    reason: string | null,
    labels: Readonly<Record<string, string>>,
    right: MachineRight,
    circleId: string,
    now: number,
  ): Promise<AskOutcome> {
    // K-1722: a loop of asks cannot fill the Inbox or each snapshot.
    const [open] = this.sql<{ count: number }>(
      "SELECT COUNT(*) AS count FROM proposals WHERE machine_id = ? AND state = 'pending'",
      machine.id,
    );
    if ((open?.count ?? 0) >= MAX_OPEN_PROPOSALS)
      return {
        outcome: "refused",
        reason: `This machine has ${MAX_OPEN_PROPOSALS} open asks already. Wait for their answers (K-1722).`,
      };
    const shown = shownAsk(action, target, body);
    if (shown.length > MAX_SHOWN)
      return {
        outcome: "refused",
        reason: `This ask is too long for an approver to read (${shown.length} characters, at most ${MAX_SHOWN}). Split it (K-1722).`,
      };
    const id = crypto.randomUUID();
    this.sql(
      `INSERT INTO proposals (id, machine_id, action, target, body, reason, labels, right_name, circle_id, shown, shown_hash, state, created_at, expires_at, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      machine.id,
      action,
      target,
      JSON.stringify(body ?? null),
      reason,
      JSON.stringify(labels),
      right,
      circleId,
      shown,
      await shownHash(shown),
      now,
      now + PROPOSAL_MS,
      JSON.stringify(this.verifiedKeys(machine.id, labels)),
    );
    this.broadcast();
    void this.scheduleAlarm();
    return { outcome: "waiting", proposalId: id };
  }

  /**
   * K-1723: one answer to a proposal. Only a member of its approver circle answers; one conditional write decides,
   * and every later answer gets "already decided". An approval runs the ask at once, with every check of K-1712.
   */
  private async decide(
    proposalId: string,
    decision: "approved" | "denied",
    by: {
      readonly actor: Actor;
      readonly visitor: Visitor;
      readonly machineId: string | null;
      readonly reason: string | null;
    },
    /** K-1722: the hash of the text that the approver read; a different one refuses, so nothing else runs. */
    seenHash: string | null = null,
    /** K-1723: the approve path that the person came through; null for a machine. */
    via: "passkey" | "login" | null = null,
  ): Promise<
    { readonly ok: true; readonly result?: unknown } | { readonly ok: false; readonly error: string }
  > {
    const [row] = this.sql<ProposalRow>("SELECT * FROM proposals WHERE id = ?", proposalId);
    if (!row) return { ok: false, error: `kitshn has no proposal ${proposalId}.` };
    const proposal = proposalOf(row);
    const circle = this.state.circles.get(proposal.circleId);
    const refusal = answerRefusal(
      circle,
      proposal.circleId,
      by.visitor,
      this.state.machines,
      by.machineId !== null,
    );
    if (refusal !== null || !circle) return { ok: false, error: refusal ?? "kitshn has no approver circle." };
    // K-1723: a passkey circle approves only through the passkey application, whose token proves a fresh passkey.
    if (decision === "approved" && via === "login" && circle.needsPasskey)
      return {
        ok: false,
        error: `${circle.name} needs a passkey: approve through the passkey check (K-1723).`,
      };
    if (proposal.state !== "pending")
      return { ok: false, error: `This ask is already decided (${proposal.state}).` };
    if (decision === "approved" && seenHash !== null && seenHash !== proposal.shownHash)
      return {
        ok: false,
        error: "The ask changed since you read it. Read it again in the Asks list (K-1722).",
      };
    const now = Date.now();
    // K-1712: an approval checks again that the ask may still run: the right still asks this circle, the circle is in
    // force, and the target is still there. Otherwise the proposal ends "no longer allowed".
    const gone = decision === "approved" ? this.proposalGone(proposal, now) : null;
    if (gone !== null) {
      const [ended] = this.sql<{ id: string }>(
        "UPDATE proposals SET state = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending' RETURNING id",
        now,
        JSON.stringify({ actor: { _tag: "kitshn", reason: "no longer allowed" }, reason: gone }),
        proposalId,
      );
      if (ended) {
        this.sendAskResult(proposal.machineId, {
          proposalId,
          outcome: "denied",
          reason: `no longer allowed: ${gone}`,
        });
        this.broadcast();
      }
      return { ok: false, error: `This ask is no longer allowed: ${gone}` };
    }
    // K-718: only a person lifts the limit of a machine, so the approval of a machine leaves the ask open for a person.
    if (decision === "approved" && by.machineId !== null) {
      const asker = this.state.machines.get(proposal.machineId);
      const outside = this.outsideAgentLimit(
        { email: null, clientId: asker?.clientId ?? null, ip: null },
        proposal.action,
        proposal.target,
        proposal.body,
      );
      if (outside !== null) return { ok: false, error: `Only a person approves this ask: ${outside}` };
    }
    const [won] = this.sql<{ id: string }>(
      "UPDATE proposals SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending' AND expires_at > ? RETURNING id",
      decision,
      now,
      JSON.stringify({ actor: by.actor, reason: by.reason }),
      proposalId,
      now,
    );
    if (!won) return { ok: false, error: `This ask is already decided (${proposal.state}).` };
    const machine = this.state.machines.get(proposal.machineId);
    const what = `${proposal.action} ${proposal.target}`.trim();
    this.insertRevision(
      by.actor,
      `${decision === "approved" ? "Approved" : "Denied"} the ask of ${machine?.name ?? proposal.machineId}: ${what}${by.reason ? ` (${by.reason})` : ""}`,
      [],
      null,
    );
    if (decision === "denied") {
      this.sendAskResult(proposal.machineId, {
        proposalId,
        outcome: "denied",
        ...(by.reason ? { reason: by.reason } : {}),
      });
      this.broadcast();
      return { ok: true };
    }
    // K-1723: the approval of a token opens the window; the daemon asks again and gets the token, so no row holds it.
    // K-1776: a forwarded call works the same way: the daemon or the agent sends the same call again.
    if (proposal.action === "forward" || WINDOW_ACTIONS.has(proposal.action)) {
      this.sendAskResult(proposal.machineId, { proposalId, outcome: "approved" });
      this.broadcast();
      return { ok: true };
    }
    const outcome = machine
      ? await this.runAsk(
          machine,
          proposal.action,
          proposal.target,
          proposal.body,
          [proposal.right],
          proposal.labels,
          proposal.circleId === OWNER_CIRCLE_ID &&
            by.machineId === null &&
            (proposal.action === "job" || proposal.action === "deploy")
            ? { machineId: machine.id, key: keyMark(machine), right: proposal.right }
            : null,
        )
      : ({ outcome: "refused", reason: "The machine that asked is gone." } as const);
    const result = outcome.outcome === "done" ? outcome.result : null;
    this.sql("UPDATE proposals SET result = ? WHERE id = ?", JSON.stringify(outcome), proposalId);
    this.sendAskResult(proposal.machineId, {
      proposalId,
      outcome: outcome.outcome === "refused" ? "denied" : "approved",
      ...(outcome.outcome === "done" ? { result } : {}),
      ...(outcome.outcome === "refused" ? { reason: outcome.reason } : {}),
    });
    this.broadcast();
    return outcome.outcome === "refused" ? { ok: false, error: outcome.reason } : { ok: true, result };
  }

  /** K-1723: an answer of a person to a proposal; an approve carries the hash of the text that its approver read. */
  private async answerProposal(
    id: string,
    decision: "approved" | "denied",
    caller: Caller,
    via: "passkey" | "login" | null,
    body: unknown,
  ) {
    const reason = isRecord(body) && typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : null;
    const seen = isRecord(body) && typeof body["hash"] === "string" ? body["hash"] : null;
    if (decision === "approved" && seen === null)
      return Response.json({ error: "Send the hash of the ask that you read (K-1722)." }, { status: 400 });
    const decided = await this.decide(
      id,
      decision,
      { actor: caller.actor, visitor: caller.visitor, machineId: null, reason },
      seen,
      via,
    );
    return decided.ok
      ? Response.json({ result: decided.result ?? null })
      : Response.json({ error: decided.error }, { status: 409 });
  }

  /** K-1712: why an approved ask may no longer run, or null. */
  private proposalGone(proposal: Proposal, now: number): string | null {
    if (
      proposal.action === "exec" &&
      this.sql("SELECT 1 AS one FROM exec_runs WHERE proposal_id = ? AND state = 'waiting'", proposal.id)
        .length === 0
    )
      return "the caller of this run is gone.";
    const mode =
      proposal.right === "readsCode" || proposal.right === "writesCode"
        ? codeRightMode(this.state, proposal.machineId, proposal.right, proposal.target, now)
        : machineRightMode(this.state, proposal.machineId, proposal.right, now);
    // K-1776: "off" wins also over an Owner ask that waits; an unset right keeps its Owner ask.
    const off =
      proposal.right === "readsCode" || proposal.right === "writesCode"
        ? codeRightOff(this.state, proposal.machineId, proposal.right, proposal.target, now)
        : machineRightOff(this.state, proposal.machineId, proposal.right, now);
    if (off) return `the owner set the right "${MACHINE_RIGHT_NAMES[proposal.right]}" to off.`;
    // K-718: a job or a deploy outside the limit of the machine waits for the Owner, whatever the mode of its right.
    const ownerAsk =
      proposal.circleId === OWNER_CIRCLE_ID &&
      (mode === null || proposal.action === "job" || proposal.action === "deploy");
    if (!ownerAsk && (mode?.mode !== "ask" || mode.circleId !== proposal.circleId))
      return `the right "${MACHINE_RIGHT_NAMES[proposal.right]}" no longer asks this circle.`;
    const failed = conditionProblem(
      mode?.conditions,
      proposal.labels,
      this.labelPrefixesOf(proposal.machineId),
    );
    if (failed) return failed;
    const circle = this.state.circles.get(proposal.circleId);
    if (!circle || (circle.endsAt !== null && circle.endsAt <= now)) return "the approver circle ended.";
    if (!this.state.machines.has(proposal.machineId)) return "the machine that asked is gone.";
    if (
      (proposal.action === "deploy" ||
        proposal.action === "publish" ||
        proposal.action === "backup" ||
        proposal.action === "restore") &&
      !this.state.resources.has(proposal.target)
    )
      return `the card ${proposal.target} is gone.`;
    if (
      (proposal.action === "job" || proposal.action === "exec") &&
      !this.state.machines.has(proposal.target)
    )
      return `the machine ${proposal.target} is gone.`;
    if (
      proposal.action === "allow" &&
      this.sql("SELECT 1 AS one FROM repos WHERE repo_id = ?", proposal.target).length === 0
    )
      return `kitshn no longer knows the repo ${proposal.target}.`;
    // K-718: another circle approves only inside the limit of the machine, so the limit counts at this moment.
    if (proposal.circleId === OWNER_CIRCLE_ID) return null;
    const asker = this.state.machines.get(proposal.machineId);
    return this.outsideAgentLimit(
      { email: null, clientId: asker?.clientId ?? null, ip: null },
      proposal.action,
      proposal.target,
      proposal.body,
    );
  }

  /** K-1722 to K-1724: the answer goes to the machine's open connection; an offline machine misses it. */
  private sendAskResult(machineId: string, result: AskResult) {
    // K-722: an exec run that waited ends with the proposal; the daemon of A ends it for its caller.
    if (result.outcome !== "approved")
      this.sql("DELETE FROM exec_runs WHERE proposal_id = ? AND state = 'waiting'", result.proposalId);
    const socket = this.openSocket(machineId);
    if (socket) send(socket, { type: "askResult", ...result });
  }

  /**
   * K-1716: "Rotate key", "Reset key" and "Remove machine" deny the open proposals of one machine; the pause denies
   * every open proposal.
   */
  private denyOpenProposals(machineId: string | null, why: string) {
    const rows = this.sql<{ id: string; machine_id: string }>(
      machineId === null
        ? "UPDATE proposals SET state = 'denied', decided_at = ?, decided_by = ? WHERE state = 'pending' RETURNING id, machine_id"
        : "UPDATE proposals SET state = 'denied', decided_at = ?, decided_by = ? WHERE state = 'pending' AND machine_id = ? RETURNING id, machine_id",
      Date.now(),
      JSON.stringify({ actor: { _tag: "kitshn", reason: why }, reason: why }),
      ...(machineId === null ? [] : [machineId]),
    );
    for (const row of rows)
      this.sendAskResult(row.machine_id, { proposalId: row.id, outcome: "denied", reason: why });
    this.revokeTokens(machineId, false);
  }

  /** K-1724: a proposal expires 24 hours after its ask, and its agent hears so. */
  private expireProposals(now: number) {
    const rows = this.sql<{ id: string; machine_id: string }>(
      "UPDATE proposals SET state = 'expired', decided_at = ? WHERE state = 'pending' AND expires_at <= ? RETURNING id, machine_id",
      now,
      now,
    );
    for (const row of rows) this.sendAskResult(row.machine_id, { proposalId: row.id, outcome: "expired" });
    if (rows.length > 0) this.broadcast();
  }

  /** K-1717: one event for each ask, not a revision; the daily run keeps 30 days and at most 5,000. */
  private askEvent(
    at: number,
    machine: Machine,
    action: AskAction | "forward",
    target: string,
    reason: string | null,
    labels: Readonly<Record<string, string>>,
    outcome: AskOutcome,
  ) {
    this.sql(
      `INSERT INTO ask_events (at, machine_id, action, target, reason, labels, outcome, detail, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      at,
      machine.id,
      action,
      target,
      reason,
      JSON.stringify(labels),
      outcome.outcome,
      outcome.outcome === "refused"
        ? outcome.reason
        : outcome.outcome === "waiting"
          ? outcome.proposalId
          : "",
      JSON.stringify(this.verifiedKeys(machine.id, labels)),
    );
    // K-1717: at most 5,000 events, trimmed on insert by id, so a burst of asks cannot grow the table within a day.
    const [last] = this.sql<{ id: number }>("SELECT last_insert_rowid() AS id");
    if (!last) return;
    // K-1756: the label index of this event, for the search of History.
    for (const [key, value] of Object.entries(labels))
      this.sql("INSERT INTO ask_labels (event_id, key, value) VALUES (?, ?, ?)", last.id, key, value);
    this.sql("DELETE FROM ask_events WHERE id <= ?", last.id - ASK_EVENT_COUNT);
    this.sql("DELETE FROM ask_labels WHERE event_id <= ?", last.id - ASK_EVENT_COUNT);
  }

  /**
   * K-722: the exec start of machine A. kitshn checks that A controls a card of the target, then the right "runs
   * commands" decides like an ask: the run starts, waits for an approval, or ends at once with an `exit` frame.
   */
  private async execStart(
    socket: WebSocket,
    machine: Machine,
    message: Extract<DaemonMessage, { type: "execStart" }>,
  ) {
    const execId = typeof message.execId === "string" ? message.execId.slice(0, 64) : "";
    const end = (reason: string) =>
      send(socket, {
        type: "execFrame",
        execId,
        frame: { type: "exit", exitCode: null, signal: null, durationMs: 0, reason },
      } satisfies ServerToDaemon);
    if (execId === "") return;
    let run: ExecRun;
    try {
      run = decodeExecRun(message.run);
    } catch (error) {
      return end(`refused: the run does not decode: ${String(error)}`);
    }
    if (run.execId !== execId) return end("refused: the run names another exec id.");
    if (this.sql("SELECT 1 AS one FROM exec_runs WHERE exec_id = ?", execId).length > 0)
      return end("refused: this exec id is in use.");
    const target = typeof message.target === "string" ? message.target : "";
    if (!this.state.machines.has(target)) return end(`refused: kitshn has no machine ${target}.`);
    const targetSocket = this.openSocket(target);
    if (targetSocket === null) return end("the target is offline");
    // A daemon of provider protocol 1 ignores `execRun`, so the caller would wait forever for a run that never starts.
    const targetAttachment = attachmentOf(targetSocket);
    if (
      targetAttachment?.kind !== "machine" ||
      !targetAttachment.status?.capabilities?.includes("protocol-2")
    )
      return end(
        `refused: the daemon of ${this.state.machines.get(target)?.name ?? target} is too old to run commands from other machines; update it (K-722).`,
      );
    const now = Date.now();
    const wanted =
      typeof message.targetProvider === "string" && message.targetProvider.length <= 32
        ? message.targetProvider
        : null;
    const via = execProviderOn(this.state, machine.id, target, now, wanted);
    if ("refused" in via)
      return end(
        via.refused === "no card"
          ? `refused: ${machine.name} controls no card on ${this.state.machines.get(target)?.name ?? target}; share its machine card or a provider card to an agent circle of ${machine.name} at control (K-722).`
          : `refused: ${via.refused}`,
      );
    // B's provider comes from the card that A controls; A's own provider names only the label of its thread.
    const { provider } = via;
    const sourceProvider =
      typeof message.provider === "string" && message.provider.length <= 32 ? message.provider : null;
    const thread = this.execThread(message.attested, sourceProvider);
    // The row stands for the caller until the run ends, so an approval starts only a run whose caller still waits.
    this.sql(
      `INSERT INTO exec_runs (exec_id, source, target, provider, command, cwd, thread, proposal_id, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'waiting', ?)`,
      execId,
      machine.id,
      target,
      provider,
      run.command,
      run.cwd ?? null,
      thread,
      now,
    );
    const outcome = await this.ask(
      machine,
      {
        action: "exec",
        target,
        body: { ...run, provider, thread },
        ...(isRecord(message.attested) ? { attested: message.attested } : {}),
      },
      true,
    );
    if (outcome.outcome === "refused") {
      this.sql("DELETE FROM exec_runs WHERE exec_id = ?", execId);
      return end(`refused: ${outcome.reason}`);
    }
    if (outcome.outcome === "waiting") {
      const kept = this.sql(
        "UPDATE exec_runs SET proposal_id = ? WHERE exec_id = ? RETURNING exec_id",
        outcome.proposalId,
        execId,
      );
      // The caller dropped while kitshn made the proposal: the row is gone, so the proposal closes now.
      if (kept.length === 0)
        return this.closeExecProposal(outcome.proposalId, "the caller of this run is gone");
      return send(socket, {
        type: "execState",
        execId,
        state: "waiting",
        proposalId: outcome.proposalId,
      } satisfies ServerToDaemon);
    }
    // `runAsk` started the run, or ended it at once with its `exit` frame.
    if (outcome.outcome === "done" && isRecord(outcome.result) && outcome.result["state"] === "running")
      send(socket, { type: "execState", execId, state: "running" } satisfies ServerToDaemon);
  }

  /** K-722: the thread of an attested run, for History: the `<provider>.thread.id` label. */
  private execThread(attested: unknown, provider: string | null) {
    const value = provider && isRecord(attested) ? attested[`${provider}.thread.id`] : undefined;
    return typeof value === "string" ? value.slice(0, 200) : null;
  }

  /** K-722: starts a run on its target, now or after its approval; an offline target ends it. */
  private startExecRun(machine: Machine, target: string, body: unknown): AskOutcome {
    let run: ExecRun;
    try {
      run = decodeExecRun(body);
    } catch {
      return { outcome: "refused", reason: "the stored run does not decode." };
    }
    const [row] = this.sql<ExecRow>(
      "SELECT * FROM exec_runs WHERE exec_id = ? AND source = ? AND state = 'waiting'",
      run.execId,
      machine.id,
    );
    const source = this.openSocket(machine.id);
    // A run whose caller gave up, or whose machine went away, never starts, also after an approval.
    if (!row || !source) {
      this.sql("DELETE FROM exec_runs WHERE exec_id = ?", run.execId);
      return { outcome: "refused", reason: "the caller of this run is gone, so it does not start (K-722)." };
    }
    const targetSocket = this.openSocket(target);
    if (!targetSocket) {
      this.sql("DELETE FROM exec_runs WHERE exec_id = ?", run.execId);
      if (source)
        send(source, {
          type: "execFrame",
          execId: run.execId,
          frame: {
            type: "exit",
            exitCode: null,
            signal: null,
            durationMs: 0,
            reason: "the target is offline",
          },
        } satisfies ServerToDaemon);
      return { outcome: "done", result: { execId: run.execId, state: "ended" } };
    }
    this.sql("UPDATE exec_runs SET state = 'running' WHERE exec_id = ?", run.execId);
    send(targetSocket, { type: "execRun", provider: row.provider, run } satisfies ServerToDaemon);
    return { outcome: "done", result: { execId: run.execId, state: "running" } };
  }

  /**
   * K-722: passes one frame to the other machine of its run: from A its credit, stdin and close, from B its output,
   * stdin credit and exit. A frame of an unknown run, or one whose other side is gone, ends it on the sender's side.
   */
  private execRelay(
    socket: WebSocket,
    machine: Machine,
    message: Extract<DaemonMessage, { type: "execFrame" }>,
  ) {
    const execId = typeof message.execId === "string" ? message.execId.slice(0, 64) : "";
    let frame: ExecFrame;
    try {
      frame = decodeExecFrame(message.frame);
    } catch (error) {
      console.warn(`kitshn dropped an exec frame of ${machine.name}: ${String(error)}`);
      return;
    }
    const fromB = frame.type === "output" || frame.type === "stdin-credit" || frame.type === "exit";
    const [row] = this.sql<ExecRow>("SELECT * FROM exec_runs WHERE exec_id = ?", execId);
    const lost = () =>
      send(socket, {
        type: "execFrame",
        execId,
        frame: fromB
          ? { type: "close", what: "kill" }
          : { type: "exit", exitCode: null, signal: null, durationMs: 0, reason: "the relay was lost" },
      } satisfies ServerToDaemon);
    if (!row || (fromB ? row.target : row.source) !== machine.id)
      return frame.type === "exit" ? undefined : lost();
    if (row.state === "waiting") {
      // Only a kill of A means something before the approval: the run ends, and so does its proposal.
      if (frame.type === "close" && frame.what === "kill") {
        this.sql("DELETE FROM exec_runs WHERE exec_id = ?", execId);
        this.closeExecProposal(row.proposal_id, "the caller ended the run before the approval");
        send(socket, {
          type: "execFrame",
          execId,
          frame: {
            type: "exit",
            exitCode: null,
            signal: null,
            durationMs: 0,
            reason: "killed by the caller",
          },
        } satisfies ServerToDaemon);
      }
      return;
    }
    const other = this.openSocket(fromB ? row.source : row.target);
    if (frame.type === "exit") {
      this.sql("DELETE FROM exec_runs WHERE exec_id = ?", execId);
      this.recordExec(row, frame);
    }
    if (!other) {
      if (frame.type !== "exit") lost();
      if (!fromB) this.sql("DELETE FROM exec_runs WHERE exec_id = ?", execId);
      return;
    }
    send(other, { type: "execFrame", execId, frame } satisfies ServerToDaemon);
  }

  /** K-722: a machine's connection closed: each of its runs ends on the other machine. */
  private endExecRuns(machineId: string) {
    const rows = this.sql<ExecRow>(
      "DELETE FROM exec_runs WHERE source = ? OR target = ? RETURNING *",
      machineId,
      machineId,
    );
    for (const row of rows) {
      if (row.state === "waiting")
        this.closeExecProposal(row.proposal_id, "a machine of the run went offline");
      const toSource = row.target === machineId;
      const socket = this.openSocket(toSource ? row.source : row.target);
      if (!socket) continue;
      send(socket, {
        type: "execFrame",
        execId: row.exec_id,
        frame: toSource
          ? { type: "exit", exitCode: null, signal: null, durationMs: 0, reason: "the relay was lost" }
          : { type: "close", what: "kill" },
      } satisfies ServerToDaemon);
      if (toSource && row.state === "running")
        this.recordExec(row, { exitCode: null, reason: "the relay was lost" });
    }
  }

  /**
   * K-722: a run that ends before its approval closes its proposal, so no later approval starts it. The approvers'
   * Inbox drops it with the next map update.
   */
  private closeExecProposal(proposalId: string | null, why: string) {
    if (proposalId === null) return;
    const closed = this.sql(
      "UPDATE proposals SET state = 'denied', decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending' RETURNING id",
      Date.now(),
      JSON.stringify({ actor: { _tag: "kitshn", reason: why }, reason: why }),
      proposalId,
    );
    if (closed.length > 0) this.broadcast();
  }

  /**
   * K-1610: one forwarded tool call of a machine's link proxy (MM-1922), with the tool name only. kitshn records it
   * only for a machine that the caller reaches now, so a machine cannot put calls on another machine's record, and
   * at most LINK_CALLS_PER_MINUTE of one machine a minute.
   */
  private recordLinkCall(machine: Machine, message: Extract<DaemonMessage, { type: "linkCall" }>) {
    const name = typeof message.name === "string" ? message.name.slice(0, 100) : "";
    const target = typeof message.target === "string" ? message.target : "";
    const status = Number.isSafeInteger(message.status) ? message.status : 0;
    if (name === "" || name.includes(" ")) return;
    const now = Date.now();
    const reached = (this.providerRegs.get(machine.id) ?? []).some((reg) =>
      reachOf(this.state, machine.id, reg.name, now).some((card) => card.machineId === target),
    );
    if (!reached)
      return console.warn(`kitshn dropped a link call of ${machine.name}: it reaches no machine ${target}.`);
    const minute = Math.floor(now / 60_000);
    const rate = this.linkRates.get(machine.id);
    const counted = rate?.minute === minute ? rate : { minute, count: 0, dropped: 0 };
    this.linkRates.set(machine.id, counted);
    if (counted.count >= LINK_CALLS_PER_MINUTE) {
      counted.dropped += 1;
      if (counted.dropped === 1)
        console.warn(`kitshn drops link calls of ${machine.name} for the rest of this minute.`);
      return;
    }
    counted.count += 1;
    this.sql(
      `INSERT INTO link_events (at, source, target, kind, thread, name, cwd, outcome, exit_code)
       VALUES (?, ?, ?, 'tool', NULL, ?, NULL, ?, NULL)`,
      now,
      machine.id,
      target,
      name,
      status >= 200 && status < 400 ? "succeeded" : status === 401 || status === 403 ? "refused" : "failed",
    );
    this.sql(
      "DELETE FROM link_events WHERE id <= (SELECT id FROM link_events ORDER BY id DESC LIMIT 1 OFFSET 2000)",
    );
    if (now - this.linkBroadcastAt >= LINK_BROADCAST_MS) {
      this.linkBroadcastAt = now;
      this.broadcast();
    }
  }

  /**
   * K-1610, K-722: History keeps one event per run: the command name, never its arguments or output, the folder, the
   * outcome and the exit code. kitshn writes it at the end of the run, so no machine reports for another one.
   */
  private recordExec(
    row: ExecRow,
    exit: { readonly exitCode: number | null; readonly reason: string | null },
  ) {
    this.sql(
      `INSERT INTO link_events (at, source, target, kind, thread, name, cwd, outcome, exit_code)
       VALUES (?, ?, ?, 'exec', ?, ?, ?, ?, ?)`,
      Date.now(),
      row.source,
      row.target,
      row.thread,
      commandName(row.command),
      row.cwd ? row.cwd.slice(0, 500) : null,
      execOutcome(exit),
      exit.exitCode,
    );
    this.sql(
      "DELETE FROM link_events WHERE id <= (SELECT id FROM link_events ORDER BY id DESC LIMIT 1 OFFSET 2000)",
    );
    // Known limit: the last events of a burst show with the next change of the map; revisit if History must be live.
    if (Date.now() - this.linkBroadcastAt >= LINK_BROADCAST_MS) {
      this.linkBroadcastAt = Date.now();
      this.broadcast();
    }
  }

  /** K-1610: the newest 50 link events, of one machine or of all, with machine names. */
  private recentLinkEvents(machineId: string | null = null): Array<LinkEventView> {
    const name = (id: string) => this.state.machines.get(id)?.name ?? id;
    return this.sql<{
      id: number;
      at: number;
      source: string;
      target: string;
      kind: "exec" | "tool";
      thread: string | null;
      name: string;
      cwd: string | null;
      outcome: LinkEventView["outcome"];
      exit_code: number | null;
    }>(
      machineId === null
        ? "SELECT * FROM link_events ORDER BY id DESC LIMIT 50"
        : "SELECT * FROM link_events WHERE source = ? OR target = ? ORDER BY id DESC LIMIT 50",
      ...(machineId === null ? [] : [machineId, machineId]),
    ).map(({ exit_code, ...row }) => ({
      ...row,
      source: name(row.source),
      target: name(row.target),
      exitCode: exit_code,
    }));
  }

  /** K-1717: the newest 50 ask events, for History; a snapshot reads at most 50 rows for them. */
  private recentAskEvents(): Array<AskEventView> {
    return this.sql<AskEventRow>("SELECT * FROM ask_events ORDER BY id DESC LIMIT 50").map((row) =>
      this.askEventView(row),
    );
  }

  /** K-1756: the newest 50 ask events with one label, of one machine or of all; it reads at most 50 index rows. */
  private askEventsWithLabel(key: string, value: string, machineId: string | null): Array<AskEventView> {
    return this.sql<AskEventRow>(
      `SELECT ask_events.* FROM ask_labels JOIN ask_events ON ask_events.id = ask_labels.event_id
       WHERE ask_labels.key = ? AND ask_labels.value = ?${machineId === null ? "" : " AND ask_events.machine_id = ?"}
       ORDER BY ask_labels.event_id DESC LIMIT 50`,
      key,
      value,
      ...(machineId === null ? [] : [machineId]),
    ).map((row) => this.askEventView(row));
  }

  private askEventView(row: AskEventRow): AskEventView {
    return {
      id: row.id,
      at: row.at,
      machineName: this.state.machines.get(row.machine_id)?.name ?? row.machine_id,
      action: row.action,
      target: row.target,
      reason: row.reason,
      labels: JSON.parse(row.labels) as Record<string, string>,
      outcome: row.outcome as AskEventView["outcome"],
      detail: row.detail,
      verified: JSON.parse(row.verified) as Array<string>,
    };
  }

  /**
   * K-1752: the labels of a provider prefix are attested, because the daemon drops a caller's own of them. Asks store
   * the result, because the providers of a machine change later.
   */
  private verifiedKeys(machineId: string, labels: Readonly<Record<string, string>>): Array<string> {
    const prefixes = this.labelPrefixesOf(machineId);
    return Object.keys(labels).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
  }

  /** K-1722: the open proposals, for the Asks list of the map. */
  /** K-1723, K-1902: the open asks that this visitor may answer, with the answer check of `decide`. */
  private answerableProposals(visitor: Visitor): Array<ProposalView> {
    const machine =
      visitor.clientId !== null &&
      [...this.state.machines.values()].some((item) => item.clientId === visitor.clientId);
    return this.openProposals().filter(
      (proposal) =>
        answerRefusal(
          this.state.circles.get(proposal.circleId),
          proposal.circleId,
          visitor,
          this.state.machines,
          machine,
        ) === null,
    );
  }

  private openProposals(): Array<ProposalView> {
    return this.sql<ProposalRow>("SELECT * FROM proposals WHERE state = 'pending' ORDER BY created_at").map(
      (row) => {
        const proposal = proposalOf(row);
        return {
          ...proposal,
          machineName: this.state.machines.get(proposal.machineId)?.name ?? proposal.machineId,
          verified: JSON.parse(row.verified) as Array<string>,
        };
      },
    );
  }

  /** K-718: why a machine may not start the last good build of a card now, or null. */
  private redeployRefusal(machineId: string | null, card: string) {
    const machine = machineId === null ? undefined : this.state.machines.get(machineId);
    if (!machine || this.state.resources.get(card)?.machine !== machine.id)
      return "This app no longer runs on the machine of its last deploy.";
    return machine.labels.includes("deploy")
      ? null
      : "The machine of this app no longer has the label deploy (K-610).";
  }

  /** K-718: queues the start of the last build that came up; kitshn makes the job, the key reads it. */
  private agentRedeploy(
    caller: Caller,
    machineId: string,
    command: Extract<Command, { kind: "compose-redeploy" }>,
    ownerApproved: OwnerApproval | null,
  ) {
    const now = Date.now();
    const id = this.ctx.storage.transactionSync(() => {
      failQueuedDowns(this.query, command.project, REPLACED);
      const [inserted] = this.sql<{ id: number }>(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
         VALUES (?, '[]', ?, 'queued', ?, ?, ?, ?, NULL, '') RETURNING id`,
        machineId,
        JSON.stringify(command),
        now,
        now + DEPLOY_MS,
        JSON.stringify(caller.actor),
        JSON.stringify({ ...caller.visitor, kitshn: true, ownerApproved }),
      );
      this.insertRevision(caller.actor, `Redeployed the last good build of ${command.name}`, [], null);
      return inserted?.id ?? null;
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ job: id });
  }

  /** K-718, K-812, K-819: a new build runs the kitshn workflow of the repo with this id on one branch. */
  private async agentBuild(caller: Caller, repoId: string, branch: string, workflow = AGENT_WORKFLOW) {
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY)
      return Response.json({ error: NO_GITHUB_APP }, { status: 503 });
    let repo: string;
    try {
      repo = await this.dispatchBuild(repoId, branch, workflow);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
    this.ctx.storage.transactionSync(() =>
      this.insertRevision(caller.actor, `Started a deploy of ${repo} from ${branch}`, [], null),
    );
    this.load();
    this.broadcast();
    return Response.json({ dispatched: { repo, branch, workflow } });
  }

  /** K-718, K-908, K-909: runs the kitshn workflow of a repo on one branch. Returns the repo's current name. */
  private async dispatchBuild(repoId: string, branch: string, workflow = AGENT_WORKFLOW) {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key) throw new Error(NO_GITHUB_APP);
    const repo = await dispatchDeploy({ id: appId, key }, repoId, branch, workflow);
    this.sql("UPDATE repos SET name = ?, gone_at = NULL WHERE repo_id = ?", repo, repoId);
    return repo;
  }

  private libraryItems(): Array<LibraryItem> {
    return this.sql<LibraryRow>("SELECT * FROM library ORDER BY created_at DESC").map(libraryItem);
  }

  /** K-1004: the Worker asks here before it serves a page or a file. */
  private contentDecision({ segment, kind, visitor: sent }: ContentRequest) {
    const visitor = this.freshVisitor(sent);
    // The old cookie still opens the login path, so the Worker drops it, or the login sends the visitor
    // straight back with it.
    const stale = visitor !== sent;
    // K-1120: a name, current or old, or the id of K-1003.
    const id = isLibraryId(segment)
      ? segment
      : (this.sql<{ item_id: string }>(
          "SELECT item_id FROM library_addresses WHERE kind = ? AND name = ?",
          kind,
          segment,
        )[0]?.item_id ?? "");
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    const resource = this.state.resources.get(id);
    // K-1127: a page that became a repo's site sends its old addresses on, after the same share check.
    if (!row && resource?.kind.startsWith("site.")) {
      const decision = contentAccess(this.state, resource, visitor, Date.now());
      return Response.json(
        decision === "allow"
          ? { decision: "moved", address: resource.addresses[0] ?? "", stale }
          : { decision, stale },
      );
    }
    if (!row || !resource) return Response.json({ decision: "missing", stale });
    const decision = contentAccess(this.state, resource, visitor, Date.now());
    return Response.json(
      decision === "allow"
        ? { decision, item: libraryItem(row), address: resource.addresses[0] ?? "", stale }
        : { decision, stale },
    );
  }

  /**
   * K-1101, K-1002: puts a page or a file into R2 and its card into the tray. The metadata comes in
   * URI-encoded headers. An import names a `source`, and a second upload of the same source changes nothing.
   */
  /**
   * K-1101, K-1116: one upload for the map and for agent keys. An agent upload (`agent`) names its title, its source
   * key for an update by name (K-1117) and where it lands; it never reads the drop point of the headers.
   */
  private async upload(
    caller: Caller,
    request: Request,
    kind: "page" | "file",
    agent: AgentUpload | null = null,
  ) {
    const header = (name: string) => {
      const value = request.headers.get(name);
      if (value === null) return null;
      try {
        return decodeURIComponent(value).trim();
      } catch {
        throw new RuleError(`${name} is not URI-encoded.`);
      }
    };
    const refuse = (error: string, status = 400) => Response.json({ error }, { status });
    const bucket = this.env.BUCKET;
    if (!bucket) return refuse("R2 is off for this kitshn. Run the bootstrap again after R2 is on.", 503);
    const size = Number(request.headers.get("content-length"));
    if (!request.body || !Number.isInteger(size) || size <= 0)
      return refuse("Send the bytes with a Content-Length.", 411);
    if (size > MAX_UPLOAD_BYTES) return refuse("A page or a file is at most 100 MB (K-1101).", 413);
    const name = header("x-kitshn-name") ?? "";
    if (kind === "file") {
      const error = fileNameError(name);
      if (error) return refuse(error);
    }
    const title = (agent?.title ?? (kind === "page" ? name : (header("x-kitshn-title") ?? name))).slice(
      0,
      200,
    );
    if (title === "") return refuse("Give the page a title in X-Kitshn-Name.");
    const source = agent?.source ?? header("x-kitshn-source");
    // The agent route looks its source up itself, and a key may publish a name again after the owner deleted it.
    if (source && !agent) {
      const [known] = this.sql<{ id: string }>(
        "SELECT id FROM library WHERE source = ? UNION ALL SELECT '' FROM library_deleted WHERE source = ?",
        source,
        source,
      );
      // An import adds a page once (K-1008), and never again after a delete in the Library.
      if (known) return Response.json(known.id ? { id: known.id, existing: true } : { deleted: true });
    }
    const createdAt = Number(header("x-kitshn-created-at") ?? Date.now());
    if (!Number.isFinite(createdAt) || createdAt <= 0)
      return refuse("X-Kitshn-Created-At is not a time in ms.");
    // A file dropped on the map lands where it was dropped, and so in the circles there (K-204).
    const [x, y] = [header("x-kitshn-x"), header("x-kitshn-y")].map((value) =>
      value === null ? null : value === "" ? Number.NaN : Number(value),
    );
    const place =
      x === null || y === null || x === undefined || y === undefined
        ? null
        : Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e6 && Math.abs(y) < 1e6
          ? { x: Math.round(x), y: Math.round(y) }
          : undefined;
    if (place === undefined) return refuse("X-Kitshn-X and X-Kitshn-Y are not a point on the map.");
    const decided = agent ? agent.place() : place;
    if (typeof decided === "string") return refuse(decided, 403);
    const addressName = this.newAddressName(kind, header("x-kitshn-address") || null);
    if (typeof addressName !== "string") return refuse(addressName.error, addressName.status);
    const item: LibraryItem = {
      id: newLibraryId(),
      kind,
      title,
      fileName: kind === "file" ? name : null,
      thread: header("x-kitshn-thread") || null,
      machine: header("x-kitshn-machine") || null,
      size,
      contentType:
        kind === "page" ? "text/html" : request.headers.get("content-type") || "application/octet-stream",
      createdAt,
      slot: 0,
    };
    // K-1115: a page may hold a data: icon, and a small file may be an image; read their start beside R2.
    const [body, sniffed] =
      kind === "page" || size <= ICON_LIMIT ? request.body.tee() : ([request.body, null] as const);
    // The icon comes first, before any R2 write, so a CPU limit while it decodes leaves no object behind.
    const icon = headIcon(
      kind,
      sniffed ? await readStart(sniffed, kind === "page" ? PAGE_ICON_SCAN : ICON_LIMIT) : null,
    );
    // The stream fails when the body is not exactly Content-Length bytes, so the limit holds.
    const { readable, writable } = new FixedLengthStream(size);
    const piped = body.pipeTo(writable);
    try {
      await bucket.put(objectKey(item), readable, { httpMetadata: { contentType: item.contentType } });
      await piped;
    } catch (error) {
      await piped.catch(() => undefined);
      return refuse(`The upload did not reach R2: ${String(error)}`, 502);
    }
    const resource: Resource = {
      id: item.id,
      kind,
      name: title,
      addresses: [libraryAddress(this.env.KITSHN_ZONE, item, addressName)],
      status: "running",
      group: null,
      machine: null,
    };
    const record = () =>
      this.ctx.storage.transactionSync(() => {
        // K-1116: the state can change while R2 takes the bytes, so the spot of an agent key is decided again.
        const spot = agent ? agent.place() : decided;
        if (typeof spot === "string") throw new RuleError(spot);
        this.sql(
          `INSERT INTO library (id, kind, title, file_name, thread, machine, size, content_type, created_at, source, added_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.id,
          item.kind,
          item.title,
          item.fileName,
          item.thread,
          item.machine,
          item.size,
          item.contentType,
          item.createdAt,
          source,
          agent?.clientId ?? null,
        );
        // Another upload or a rename can take the name while R2 takes these bytes.
        this.claimName(kind, addressName, item.id);
        // K-1117: the key keeps a card that waits in the tray from its publish on; the first change ends that.
        if (agent && !spot) this.sql("UPDATE library SET agent_tray = 1 WHERE id = ?", item.id);
        return this.addCard(caller.actor, resource, spot, `the ${kind} ${title}`);
      });
    let revision: number;
    try {
      revision = record();
    } catch (error) {
      // No card names the object, so it goes too (K-1115).
      await bucket.delete(objectKey(item)).catch(() => undefined);
      if (error instanceof AddressTaken) return refuse(error.message, 409);
      if (error instanceof RuleError) return refuse(error.message, 403);
      throw error;
    }
    if (icon) await this.setIcon(item.id, icon);
    this.load();
    this.broadcast();
    return Response.json({ id: item.id, address: resource.addresses[0], revision }, { status: 201 });
  }

  /**
   * K-1116: `kitshn publish` of an agent key. A name that this key published before updates that card (K-1117);
   * a new name is a new upload, in the tray or in one of its agent circles, and public only with "may publish".
   */
  private async agentPublish(
    agent: Caller,
    request: Request,
    now: number,
    approved: ReadonlyArray<MachineRight> = [],
  ) {
    const clientId = agent.visitor.clientId;
    if (!clientId) return Response.json({ error: "Only an agent publishes here (K-1116)." }, { status: 403 });
    const header = (key: string) => {
      const value = request.headers.get(key);
      try {
        return value === null ? null : decodeURIComponent(value).trim();
      } catch {
        return null;
      }
    };
    const name = header("x-kitshn-name") ?? "";
    const nameError = fileNameError(name);
    if (nameError) return Response.json({ error: nameError }, { status: 400 });
    const source = `agent:${clientId}:${name}`;
    const [known] = this.sql<LibraryRow>(
      "SELECT * FROM library WHERE source = ? AND added_by = ?",
      source,
      clientId,
    );
    const circle = header("x-kitshn-circle") || null;
    const publish = header("x-kitshn-public") === "true";
    if (known) {
      // K-1117: an update changes only the bytes; a move goes through `kitshn apply`, with its checks (K-718).
      if (circle !== null || publish || header("x-kitshn-address"))
        return Response.json(
          {
            error: `${known.title} exists already, and --circle, --public and --address apply only to a first publish. Publish without them; move the card with /agent/apply, and set its address with kitshn address.`,
          },
          { status: 409 },
        );
      const refusal = this.agentMayChange(agent, known.id, now);
      if (refusal) return Response.json({ error: refusal }, { status: 403 });
      return this.updateLibrary(agent, known, request, now);
    }
    const kind = uploadKind(name);
    const dot = name.lastIndexOf(".");
    const title = header("x-kitshn-title") || (kind === "page" && dot > 0 ? name.slice(0, dot) : name);
    const place = () => agentUploadPlace(this.state, agent.visitor, circle, publish, Date.now(), approved);
    return this.upload(agent, request, kind, { clientId, source, title, place });
  }

  /**
   * K-1129: the steps of an owner's folder site: `plan` (a new site at a drop point or in the tray, or a new version
   * of one), `assets` (the upload session), `upload` (one bucket of files, which kitshn passes on to Cloudflare) and
   * `finish`. Each drop makes a new site; an owner site row has its own key, `owner:<card>`.
   */
  private async ownerSite(caller: Caller, step: string, request: Request): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const api = this.api();
    if (!api) return fail(503, "kitshn has no Cloudflare API token here.");
    const now = Date.now();
    if (step === "upload") return await this.ownerUpload(request);
    const input: unknown = await request.json().catch(() => null);
    const body = isRecord(input) ? input : {};
    try {
      if (step === "plan") return await this.ownerSitePlan(api, body, now);
      const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", String(body["deployId"] ?? ""));
      // Any folder site, also one that a key published: the owner owns every card (K-1129).
      const [site] = row
        ? this.sql<AgentSiteRow>("SELECT * FROM agent_sites WHERE card_id = ?", row.resource_id)
        : [];
      if (!row || !site || row.repo_id !== null) return fail(404, "kitshn knows no such folder upload.");
      if (row.expires_at < now || row.state !== "planned")
        return fail(410, "This upload expired or ended. Upload the folder again.");
      if (step === "cancel") {
        this.endOwnerUpload(row, site, "The upload in the browser failed or stopped.");
        this.broadcast();
        return Response.json({ ok: true });
      }
      if (step === "assets") {
        const manifest = parseManifest(body["manifest"]);
        if (typeof manifest === "string") return fail(400, manifest);
        const answer = await this.deployCall(row, DEPLOY_STEP.upload, () =>
          this.deployAssets(api, row, body["manifest"]),
        );
        if (!answer.ok) return answer;
        const session = (await answer.json()) as { jwt: string; buckets: Array<Array<string>> };
        this.folderUploads.set(row.id, {
          jwt: session.jwt,
          hashes: new Set(Object.values(manifest).map((file) => file.hash)),
          done: session.jwt,
        });
        return Response.json({ buckets: session.buckets });
      }
      if (step !== "finish") return fail(404, `kitshn has no folder site step ${step}.`);
      // A repo can take the site over while its files go up (K-1127).
      if (!this.isFolderSite(site.card_id)) {
        this.endOwnerUpload(row, site, "A repo took the site over during the upload.");
        return fail(
          409,
          `A repo deploys ${site.folder} now, so a folder no longer gives it a new version (K-1127).`,
        );
      }
      const upload = this.folderUploads.get(row.id);
      if (!upload) return fail(409, "kitshn lost this upload while it ran; upload the folder again.");
      if (this.deletingStorage.has(site.card_id))
        return fail(409, `kitshn deletes the script of ${site.folder} now; upload again after it finishes.`);
      if (!this.state.resources.has(site.card_id)) {
        this.addFolderCard(caller.actor, site, this.folderDrops.get(site.card_id) ?? null, false);
        this.folderDrops.delete(site.card_id);
      }
      const finished = await this.deployCall(row, DEPLOY_STEP.live, () =>
        this.finishDeploy(
          api,
          row,
          folderDeployer(site.folder),
          upload.done,
          body["icon"],
          body["headers"],
          body["redirects"],
        ),
      );
      if (finished.ok) this.folderUploads.delete(row.id);
      return finished;
    } catch (error) {
      if (error instanceof RuleError) return fail(409, error.message);
      return fail(502, `kitshn could not finish the step: ${String(error)}`);
    }
  }

  /**
   * K-1129: ends an owner upload that will not finish, so its deploy row does not wait until it expires. A new site
   * that has no card yet lets its name go again.
   */
  private endOwnerUpload(row: DeployRow, site: AgentSiteRow, reason: string) {
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE deploys SET state = 'failed', reason = ? WHERE id = ?", reason, row.id);
      if (site.client_id.startsWith("owner:") && !this.state.resources.has(site.card_id))
        this.sql("DELETE FROM agent_sites WHERE card_id = ?", site.card_id);
    });
    this.folderUploads.delete(row.id);
    this.folderDrops.delete(site.card_id);
    this.settleDeployAction(row.id);
  }

  /** K-1129: a new folder site of the owner, at the drop point or in the tray, or a new version of a folder site. */
  private async ownerSitePlan(api: Api, input: Record<string, unknown>, now: number) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const card = typeof input["card"] === "string" ? input["card"] : null;
    if (card !== null) {
      // "Upload a new version": any folder site, also one that a key published (K-1123).
      const [site] = this.sql<AgentSiteRow>("SELECT * FROM agent_sites WHERE card_id = ?", card);
      const resource = this.state.resources.get(card);
      if (!site || !resource || !this.isFolderSite(card))
        return fail(409, "Only a folder site takes a new version from a folder (K-1129).");
      const address = resource.addresses[0] ?? site.address;
      return Response.json({
        deployId: this.planFolderDeploy(site, address, now),
        card,
        address,
        updated: true,
      });
    }
    const folder = typeof input["folder"] === "string" ? input["folder"].trim() : "";
    const folderError = fileNameError(folder);
    if (folderError) return fail(400, folderError);
    const [x, y] = [input["x"], input["y"]];
    const spot =
      typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
        ? { x: Math.round(x), y: Math.round(y) }
        : null;
    const name = this.folderSiteName(null, this.env.KITSHN_ZONE);
    if (typeof name !== "string") return fail(name.status, name.error);
    const cardId = `${FOLDER_SITE_PREFIX}${newLibraryId()}`;
    const planned = await this.planNewFolderSite(
      api,
      {
        card_id: cardId,
        client_id: `owner:${cardId}`,
        folder,
        address: `${name}.${this.env.KITSHN_ZONE}`,
        circle: null,
        public: 0,
        agent_tray: 0,
        created_at: now,
      },
      now,
    );
    if (planned.ok && spot) this.folderDrops.set(cardId, spot);
    return planned;
  }

  /**
   * K-1129: one bucket of an owner's folder upload. It belongs to an open plan of the owner, holds only files of its
   * manifest, and stays under the Worker's body limit; kitshn sends it on to Cloudflare with the session token.
   */
  private async ownerUpload(request: Request): Promise<Response> {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const deployId = request.headers.get("x-kitshn-deploy") ?? "";
    const upload = this.folderUploads.get(deployId);
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ? AND state = 'planned'", deployId);
    if (!upload || !row || row.expires_at < Date.now())
      return fail(404, "kitshn knows no such open folder upload.");
    const size = Number(request.headers.get("content-length"));
    if (!Number.isInteger(size) || size <= 0) return fail(411, "Send the bucket with a Content-Length.");
    if (size > FOLDER_PART_BYTES)
      return fail(413, "One part of a folder upload is at most 40 MB; send fewer files at once.");
    const form = await request.formData();
    const names = [...form.keys()];
    if (names.length === 0 || names.some((name) => !upload.hashes.has(name)))
      return fail(400, "The bucket holds a file that the manifest of this upload does not name.");
    const answer = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/assets/upload?base64=true`,
      { method: "POST", headers: { authorization: `Bearer ${upload.jwt}` }, body: form },
    );
    const result = (await answer.json().catch(() => null)) as {
      success?: boolean;
      result?: { jwt?: string };
      errors?: unknown;
    } | null;
    if (!result?.success)
      return fail(502, `Cloudflare did not take the files: ${JSON.stringify(result?.errors)}`);
    if (result.result?.jwt) upload.done = result.result.jwt;
    return Response.json({ ok: true });
  }

  /**
   * K-1123: the steps of a folder site: `plan` checks the key, the name and the address; `assets` opens the upload
   * session; `finish` makes the card, if it is new, where K-1116 lets it land, and publishes the files.
   */
  private async agentSite(
    agent: Caller,
    step: string,
    input: Record<string, unknown>,
    now: number,
    approved: ReadonlyArray<MachineRight> = [],
  ) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const api = this.api();
    if (!api) return fail(503, "kitshn has no Cloudflare API token here.");
    const clientId = agent.visitor.clientId;
    if (!clientId) return fail(403, "Only an agent publishes a folder site (K-1123).");
    try {
      if (step === "plan") return await this.agentSitePlan(api, agent, clientId, input, now, approved);
      const [row] = this.sql<DeployRow>(
        "SELECT * FROM deploys WHERE id = ?",
        String(input["deployId"] ?? ""),
      );
      const [site] = row
        ? this.sql<AgentSiteRow>(
            "SELECT * FROM agent_sites WHERE card_id = ? AND client_id = ?",
            row.resource_id,
            clientId,
          )
        : [];
      if (!row || !site || row.repo_id !== null)
        return fail(404, "kitshn knows no such folder deploy of this agent.");
      if (row.expires_at < Date.now() || row.state !== "planned")
        return fail(410, "This deploy expired or ended. Publish the folder again.");
      if (step === "assets")
        return await this.deployCall(row, DEPLOY_STEP.upload, () =>
          this.deployAssets(api, row, input["manifest"]),
        );
      if (step !== "finish") return fail(404, `kitshn has no folder site step ${step}.`);
      return await this.deployCall(row, DEPLOY_STEP.live, () =>
        this.finishAgentSite(api, agent, row, site, input, now),
      );
    } catch (error) {
      if (error instanceof RuleError) return fail(403, error.message);
      return fail(502, `kitshn could not finish the step: ${String(error)}`);
    }
  }

  /** K-1123: the files of a folder site arrived; the card lands where K-1116 lets it, and the files go live. */
  private async finishAgentSite(
    api: Api,
    agent: Caller,
    row: DeployRow,
    site: AgentSiteRow,
    input: Record<string, unknown>,
    now: number,
  ) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    // K-909: the owner deletes the kept script of this site now.
    if (this.deletingStorage.has(site.card_id))
      return fail(409, `kitshn deletes the script of ${site.folder} now; publish again after it finishes.`);
    if (this.state.resources.has(site.card_id)) {
      const refusal = this.agentSiteMayChange(agent, site.card_id, now);
      if (refusal) return fail(403, refusal);
    } else {
      // The right can go between the plan and the files; an approval of the plan counts for its finish (K-1776).
      const planned = approvedRights(row.approved);
      if (!agentHas(this.state, agent.visitor, "addsApps", now, planned))
        return fail(403, 'A folder site needs the right "may add apps" (K-718, K-1123).');
      // The rights and the circles can change between the plan and the files, so the spot counts now.
      const spot = agentUploadPlace(this.state, agent.visitor, site.circle, site.public === 1, now, planned);
      if (typeof spot === "string") return fail(403, spot);
      this.addFolderCard(agent.actor, site, spot, !spot);
    }
    return await this.finishDeploy(
      api,
      row,
      folderDeployer(site.folder),
      input["jwt"],
      input["icon"],
      input["headers"],
      input["redirects"],
    );
  }

  private async agentSitePlan(
    api: Api,
    agent: Caller,
    clientId: string,
    input: Record<string, unknown>,
    now: number,
    approved: ReadonlyArray<MachineRight>,
  ) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
    const folder = text("folder");
    const folderError = fileNameError(folder);
    if (folderError) return fail(400, folderError);
    const circle = text("circle") || null;
    const open = input["public"] === true;
    const wanted = text("address") || null;
    const zoneName = text("zone") || this.env.KITSHN_ZONE;
    const [stored] = this.sql<AgentSiteRow>(
      "SELECT * FROM agent_sites WHERE client_id = ? AND folder = ?",
      clientId,
      folder,
    );
    // K-1123: a site whose card went (Remove app, a delete) and whose plan expired counts for nothing; a publish of the
    // same folder is a first publish again.
    const known = stored && this.siteLive(stored, now) ? stored : undefined;
    if (known) {
      // K-1123, as K-1117: a second publish deploys the same card; a move goes through /agent/apply.
      if (circle !== null || open || wanted !== null || text("zone"))
        return fail(
          409,
          `${folder} exists already, and --circle, --public, --address and --zone apply only to a first publish.`,
        );
      if (!this.state.resources.has(known.card_id))
        return fail(409, `A first publish of ${folder} runs now; publish again after it ends.`);
      const refusal = this.agentSiteMayChange(agent, known.card_id, now);
      if (refusal) return fail(403, refusal);
      const address = this.state.resources.get(known.card_id)?.addresses[0] ?? known.address;
      return Response.json({
        deployId: this.planFolderDeploy(known, address, now, approved),
        card: known.card_id,
        address,
        updated: true,
      });
    }
    if (!agentHas(this.state, agent.visitor, "addsApps", now, approved))
      return fail(403, 'A folder site needs the right "may add apps" (K-718, K-1123).');
    const spot = agentUploadPlace(this.state, agent.visitor, circle, open, now, approved);
    if (typeof spot === "string") return fail(403, spot);
    if (!zonesOf(this.env).some((zone) => zone.name === zoneName))
      return fail(409, `kitshn does not publish on ${zoneName} (K-1111).`);
    // The count, the name and the row in one step with no await, so two plans at once cannot both pass.
    const live = this.sql<AgentSiteRow>("SELECT * FROM agent_sites WHERE client_id = ?", clientId).filter(
      (row) => this.siteLive(row, now),
    );
    if (live.length >= FOLDER_SITES_PER_KEY)
      return fail(409, `A key has at most ${FOLDER_SITES_PER_KEY} folder sites (K-1123).`);
    const name = this.folderSiteName(wanted, zoneName);
    if (typeof name !== "string") return fail(name.status, name.error);
    const address = `${name}.${zoneName}`;
    const cardId = `${FOLDER_SITE_PREFIX}${newLibraryId()}`;
    const site: AgentSiteRow = {
      card_id: cardId,
      client_id: clientId,
      folder,
      address,
      circle,
      public: open ? 1 : 0,
      agent_tray: 0,
      created_at: now,
    };
    return await this.planNewFolderSite(api, site, now, stored?.card_id, approved);
  }

  /** K-1123: the deploy row of one upload of a folder site. */
  /** `approved`: the rights that an approval of this plan gave (K-1776); its files and its finish count them. */
  private planFolderDeploy(
    site: Pick<AgentSiteRow, "card_id" | "folder">,
    address: string,
    now: number,
    approved: ReadonlyArray<MachineRight> = [],
  ) {
    const deployId = crypto.randomUUID();
    this.sql(
      `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, addresses, app_key, approved)
       VALUES (?, ?, NULL, 'folder', ?, ?, ?, NULL, 'deploy', 'folder', 'planned', ?, '', 'static', ?, 'app', ?)`,
      deployId,
      `folder ${site.folder}`,
      site.card_id,
      address,
      `kitshn-${site.card_id}`,
      now + DEPLOY_MS,
      JSON.stringify([address]),
      JSON.stringify(approved),
    );
    this.startDeployAction(deployId, {
      app: "static",
      worker: null,
      repo_id: null,
      resource_id: site.card_id,
    });
    return deployId;
  }

  /**
   * K-1123, K-1129: the plan of a new folder site. Call it with no await between the name check and this call, so
   * two plans at once cannot take one name. `replaces` is an old site row of the same folder that counts for nothing.
   */
  private async planNewFolderSite(
    api: Api,
    site: AgentSiteRow,
    now: number,
    replaces?: string,
    approved: ReadonlyArray<MachineRight> = [],
  ) {
    const deployId = this.ctx.storage.transactionSync(() => {
      if (replaces) this.sql("DELETE FROM agent_sites WHERE card_id = ?", replaces);
      this.sql(
        `INSERT INTO agent_sites (card_id, client_id, folder, address, circle, public, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        site.card_id,
        site.client_id,
        site.folder,
        site.address,
        site.circle,
        site.public,
        site.created_at,
      );
      return this.planFolderDeploy(site, site.address, now, approved);
    });
    // The plan holds its address from here; a refusal below lets it go again.
    const release = (response: Response) => {
      this.sql("DELETE FROM agent_sites WHERE card_id = ?", site.card_id);
      this.sql(
        "UPDATE deploys SET state = 'failed', reason = ? WHERE id = ?",
        "The plan was refused.",
        deployId,
      );
      return response;
    };
    const scripts = await api<Array<unknown>>(
      "GET",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
    );
    if (scripts.length >= SCRIPT_LIMIT)
      return release(
        Response.json(
          {
            error: `The account has ${scripts.length} Worker scripts; kitshn makes no new site at ${SCRIPT_LIMIT} (K-903, K-1123).`,
          },
          { status: 409 },
        ),
      );
    const refused = await this.addressRefusal(
      api,
      [site.address],
      site.card_id,
      `kitshn-${site.card_id}`,
      undefined,
      true,
    );
    if (refused) return release(refused);
    return Response.json({ deployId, card: site.card_id, address: site.address, updated: false });
  }

  /** K-1123: the card of a folder site at its first finish; a card that took its address since stops it. */
  private addFolderCard(actor: Actor, site: AgentSiteRow, spot: Point | null, agentTray: boolean) {
    const resource: Resource = {
      id: site.card_id,
      kind: "site.static",
      name: site.folder,
      addresses: [site.address],
      status: "unknown",
      group: null,
      machine: null,
    };
    this.ctx.storage.transactionSync(() => {
      const other = [...this.state.resources.values()].find((card) => card.addresses.includes(site.address));
      if (other) throw new RuleError(`${site.address} belongs to the card ${other.name} now.`);
      if (agentTray) this.sql("UPDATE agent_sites SET agent_tray = 1 WHERE card_id = ?", site.card_id);
      this.addCard(actor, resource, spot, `the folder site ${site.folder}`);
    });
    this.load();
  }

  /**
   * K-1123, K-1124: a folder site moves to `<name>.<zone>` on the zone of its address, and its old address sends
   * visitors on. The Access application of the new address comes first (K-402), then its custom domain, and the old
   * one goes over to the redirect Worker. A second call with the same name finishes what Cloudflare left undone. Known
   * limit: the move has no Undo; a move back does the same. Revisit when a site needs the Undo of K-1506.
   */
  private async renameFolderSite(caller: Caller, resource: Resource, name: string) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const api = this.api();
    if (!api) return fail(503, "kitshn has no Cloudflare API token here.");
    const current = resource.addresses[0] ?? "";
    const zone = current.slice(current.indexOf(".") + 1);
    const after = `${name}.${zone}`;
    const script = `kitshn-${resource.id}`;
    if (after === current)
      return Response.json({ card: resource.id, kind: "folder", address: after, revision: null });
    const free = this.folderSiteName(name, zone);
    if (typeof free !== "string") return fail(free.status, free.error);
    const refused = await this.addressRefusal(api, [after], resource.id, script, resource, true);
    if (refused) return refused;
    // The card takes the address before Cloudflare does, so that the Access sync makes its application first
    // (K-402). Only success writes the revision; anything else puts the card and its old addresses back.
    const oldRows = this.sql<{ address: string; attached: number; pinned: number; going: number }>(
      "SELECT address, attached, pinned, going FROM old_addresses WHERE card_id = ? ORDER BY rowid",
      resource.id,
    );
    const moveTo = (address: string) => {
      this.putResource({ ...resource, addresses: [address] });
      this.sql("UPDATE agent_sites SET address = ? WHERE card_id = ?", address, resource.id);
    };
    this.ctx.storage.transactionSync(() => {
      moveTo(after);
      this.rememberOld(resource.id, [current], [after]);
    });
    this.load();
    const back = (response: Response) => {
      this.ctx.storage.transactionSync(() => {
        moveTo(current);
        this.sql("DELETE FROM old_addresses WHERE card_id = ?", resource.id);
        for (const row of oldRows)
          this.sql(
            "INSERT OR REPLACE INTO old_addresses (address, card_id, attached, pinned, going) VALUES (?, ?, ?, ?, ?)",
            row.address,
            resource.id,
            row.attached,
            row.pinned,
            row.going,
          );
      });
      this.load();
      return response;
    };
    try {
      await this.syncAccessLocked(api, 20);
      const app = this.access.get(`app:${resource.id}:${after}`);
      if (!app?.cfId || app.error)
        return back(
          fail(503, `The Access application of ${after} is not ready; run the same command again.`),
        );
      const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
      const domains = await api<Array<{ id: string; service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(after)}`,
      );
      // K-1124: an old address of this site that it takes back leaves the redirect Worker first, as a deploy does.
      const ownOld = oldRows.some((row) => row.address === after);
      for (const domain of domains)
        if (ownOld && domain.service === REDIRECT_SCRIPT)
          await api("DELETE", `${account}/workers/domains/${domain.id}`);
      const others = domains.filter(
        (domain) => domain.service !== script && !(ownOld && domain.service === REDIRECT_SCRIPT),
      );
      if (others.length > 0) return back(fail(409, `${after} already serves another Worker.`));
      if (!domains.some((domain) => domain.service === script)) {
        const zoneOf = zoneOfAddressIn(after, this.env);
        if (!zoneOf) return back(fail(409, `kitshn does not publish on the zone of ${after} (K-1111).`));
        await api("PUT", `${account}/workers/domains`, {
          hostname: after,
          service: script,
          zone_id: zoneOf.id,
          environment: "production",
        });
      }
      await removeStaleDomains(api, account, script, [after]);
    } catch (error) {
      return back(fail(502, `kitshn could not move ${resource.name}: ${String(error)}`));
    }
    const revision = this.insertRevision(
      caller.actor,
      `Moved the folder site ${resource.name} to ${after}; ${current} sends visitors on (K-1124)`,
      [],
      null,
    );
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ card: resource.id, kind: "folder", address: after, revision });
  }

  /**
   * K-1123: the name of a new folder site on `zone`: the one that the key gives, or a random readable one (K-1120).
   * A name is one label below the zone and not a name of kitshn itself (K-817).
   */
  private folderSiteName(
    wanted: string | null,
    zone: string,
  ): string | { readonly error: string; readonly status: number } {
    const held = this.heldSiteAddresses(Date.now()).map((row) => row.address);
    const used = (name: string) =>
      RESERVED_SITE_NAMES.has(name) ||
      reservedSiteLinkHost(`${name}.${zone}`, this.env.KITSHN_ZONE) ||
      `${name}.${zone}` === this.env.KITSHN_HOST ||
      held.includes(`${name}.${zone}`) ||
      [...this.state.resources.values()].some((resource) => resource.addresses.includes(`${name}.${zone}`));
    if (wanted !== null) {
      const error = addressNameError(wanted);
      if (error) return { error, status: 400 };
      if (used(wanted)) return { error: `${wanted}.${zone} is taken (K-817).`, status: 409 };
      return wanted;
    }
    for (let tries = 0; tries < 20; tries++) {
      const name = randomAddressName();
      if (!used(name)) return name;
    }
    return { error: "kitshn found no free random name; give one with --address.", status: 409 };
  }

  /**
   * K-909, K-1122, K-1123: an Undo brings a removed app back only to addresses that no other card took since, and a
   * folder site only while no new publish of its folder replaced it, so two cards never share a hostname.
   */
  private refuseTakenBack(card: AppCard) {
    const now = Date.now();
    const held = this.heldSiteAddresses(now);
    for (const address of card.addresses) {
      const other = [...this.state.resources.values()].find(
        (resource) => resource.id !== card.id && resource.addresses.includes(address),
      );
      if (other)
        throw new RuleError(
          `${address} is taken by the card ${other.name} now, so this undo no longer fits.`,
        );
      if (held.some((row) => row.address === address && row.card_id !== card.id))
        throw new RuleError(
          `${address} is taken by a folder site that is being published, so this undo no longer fits.`,
        );
    }
    // K-1124: its old addresses come back too, so another card may not hold one of them now.
    for (const { address } of this.sql<{ address: string }>(
      "SELECT address FROM old_addresses WHERE card_id = ?",
      card.id,
    )) {
      const other = [...this.state.resources.values()].find((resource) =>
        resource.addresses.includes(address),
      );
      if (other)
        throw new RuleError(
          `${address} is taken by the card ${other.name} now, so this undo no longer fits.`,
        );
    }
    if (
      this.isFolderSite(card.id) &&
      this.sql("SELECT 1 FROM agent_sites WHERE card_id = ?", card.id).length === 0
    )
      throw new RuleError(
        `A new publish of the folder of ${card.name} replaced it, so this undo no longer fits.`,
      );
  }

  /**
   * K-1127: a key hands a page or a folder site that it may change over to a repo that its user made, by the repo's
   * GitHub id and owner id. For an hour, the first push deploy of that repo takes the card, with its circles and shares.
   */
  private handOver(
    agent: Caller,
    named: string,
    input: Record<string, unknown>,
    now: number,
    approved: ReadonlyArray<MachineRight> = [],
  ) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const repo = typeof input["repo"] === "string" ? input["repo"].trim() : "";
    const repoId = typeof input["repoId"] === "string" ? input["repoId"] : "";
    const ownerId = typeof input["ownerId"] === "string" ? input["ownerId"] : "";
    if (!isRepoName(repo) || !isGitHubId(repoId) || !isGitHubId(ownerId))
      return fail(
        400,
        "Name the repo as owner/name with its GitHub repoId and ownerId, as gh api repos/<repo> gives.",
      );
    const card = this.agentCard(agent, named, now);
    const resource = card ? this.state.resources.get(card) : undefined;
    if (!card || !resource)
      return fail(403, `This agent cannot change the card "${named}" (K-1117, K-1123, K-1127).`);
    const folder = this.isFolderSite(card);
    if (resource.kind !== "page" && !folder)
      return fail(
        409,
        "Only a page or a folder site becomes a repo; put a file into a folder site first (K-1127).",
      );
    if (!agentHas(this.state, agent.visitor, "addsApps", now, approved))
      return fail(403, 'A repo adds an app, so it needs the right "may add apps" (K-718, K-1127).');
    if (this.sql("SELECT 1 FROM repos WHERE repo_id = ?", repoId).length > 0)
      return fail(409, `kitshn knows ${repo} already; a handover is for a new repo (K-1127).`);
    // K-817: a repo's main address is under the kitshn zone. A folder site on another zone keeps that address as
    // an extra one and gets a main one under the kitshn zone.
    const current = resource.addresses[0] ?? "";
    const label = (address: string) =>
      address.includes("/") ? addressSegment(address) : (address.split(".")[0] ?? "");
    const underZone = current.endsWith(`.${this.env.KITSHN_ZONE}`) && !current.includes("/");
    let addresses = [current];
    if (!underZone) {
      const wanted = label(current);
      const name = this.folderSiteName(isLibraryId(wanted) ? null : wanted, this.env.KITSHN_ZONE);
      const free = typeof name === "string" ? name : this.folderSiteName(null, this.env.KITSHN_ZONE);
      if (typeof free !== "string") return fail(free.status, free.error);
      addresses = [`${free}.${this.env.KITSHN_ZONE}`, ...(folder ? [current] : [])];
    }
    const expiresAt = now + HANDOVER_MS;
    const name = agent.actor._tag === "device" ? agent.actor.name : (agent.visitor.clientId ?? "a key");
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM handovers WHERE card_id = ? OR repo_id = ?", card, repoId);
      this.sql(
        `INSERT INTO handovers (repo_id, owner_id, repo, card_id, client_id, client_name, address, expires_at, approved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        repoId,
        ownerId,
        repo,
        card,
        agent.visitor.clientId ?? "",
        name,
        JSON.stringify(addresses),
        expiresAt,
        JSON.stringify(approved),
      );
      this.insertRevision(
        agent.actor,
        `Handed ${resource.name} over to ${repo}; its first push deploys it at ${addresses[0]} within an hour (K-1127)`,
        [],
        null,
      );
    });
    this.broadcast();
    return Response.json({
      card,
      kind: folder ? "folder" : "page",
      address: addresses[0],
      addresses,
      repo,
      expiresAt,
    });
  }

  /** K-1123, K-1127: a folder site is a `folder-` card that no repo took over. */
  private isFolderSite(id: string) {
    return (
      id.startsWith(FOLDER_SITE_PREFIX) &&
      this.sql("SELECT 1 FROM repo_cards WHERE card_id = ?", id).length === 0
    );
  }

  /** K-1120, K-1123: the cards that a name means: a card id, a name of a page or file address, or a folder. */
  private cardCandidates(named: string): Array<string> {
    if (this.state.resources.has(named)) return [named];
    return this.sql<{ id: string }>(
      `SELECT DISTINCT item_id AS id FROM library_addresses WHERE kind IN ('page', 'file') AND name = ?
       UNION SELECT card_id AS id FROM agent_sites WHERE folder = ?`,
      named,
      named,
    ).map((row) => row.id);
  }

  /** K-1117, K-1120, K-1123: the card that a key names by id, address name or folder, if the key may change it. */
  private agentCard(agent: Caller, named: string, now: number): string | null {
    const candidates = this.cardCandidates(named);
    return (
      candidates.find(
        (id) =>
          this.agentMayChange(agent, id, now) === null || this.agentSiteMayChange(agent, id, now) === null,
      ) ?? null
    );
  }

  /**
   * K-1127: the handover of this repo, by its GitHub ids, while it lasts and while it still fits: the card exists and
   * is still a page or a folder site, and the key still may change it and still may add apps. A handover that no
   * longer fits ends unused, and History says why.
   */
  private usableHandover(deployer: Deployer): Handover | null {
    const now = Date.now();
    const [row] = this.sql<HandoverRow>(
      "SELECT * FROM handovers WHERE repo_id = ? AND owner_id = ? AND expires_at > ?",
      deployer.repoId,
      deployer.ownerId,
      now,
    );
    if (!row) return null;
    const key: Caller = {
      visitor: { email: null, clientId: row.client_id, ip: null },
      actor: { _tag: "device", clientId: row.client_id, name: row.client_name },
    };
    const card = this.state.resources.get(row.card_id);
    const fits =
      card !== undefined &&
      (card.kind === "page" || this.isFolderSite(card.id)) &&
      agentHas(this.state, key.visitor, "addsApps", now, approvedRights(row.approved)) &&
      (this.agentMayChange(key, row.card_id, now) === null ||
        this.agentSiteMayChange(key, row.card_id, now) === null);
    if (!fits) {
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM handovers WHERE repo_id = ?", row.repo_id);
        this.insertRevision(
          { _tag: "kitshn", reason: "handover" },
          `The handover of ${card?.name ?? row.card_id} to ${row.repo} ended unused: the card or the key's right changed (K-1127)`,
          [],
          null,
        );
      });
      return null;
    }
    return {
      repo_id: row.repo_id,
      repo: row.repo,
      card_id: row.card_id,
      client_id: row.client_id,
      client_name: row.client_name,
      addresses: JSON.parse(row.address) as Array<string>,
    };
  }

  /**
   * K-1127: the repo takes the handed-over card for this app and environment from now on, and counts as allowed by
   * the key (K-819). A page becomes a static site at the handover's address; a folder site stops being one. It runs in
   * the transaction of the deploy row.
   */
  private takeOver(handover: Handover, deployer: Deployer, key: string, environment: string) {
    const card = this.state.resources.get(handover.card_id);
    if (!card) throw new RuleError("The handed-over card went while the deploy planned (K-1127).");
    this.sql(
      `INSERT INTO repos (repo_id, name, state, first_seen, branch, workflow, allowed_by_client, allowed_by_name)
       VALUES (?, ?, 'allowed', ?, ?, ?, ?, ?)`,
      deployer.repoId,
      deployer.repo,
      Date.now(),
      deployer.branch,
      deployer.workflow,
      handover.client_id,
      handover.client_name,
    );
    this.sql(
      "INSERT INTO repo_cards (repo_id, app_key, environment, card_id) VALUES (?, ?, ?, ?)",
      deployer.repoId,
      key,
      environment,
      card.id,
    );
    this.sql("DELETE FROM handovers WHERE repo_id = ?", handover.repo_id);
    this.sql("DELETE FROM agent_sites WHERE card_id = ?", card.id);
    if (card.kind === "page")
      this.putResource({ ...card, kind: "site.static", addresses: handover.addresses });
    this.insertRevision(
      { _tag: "kitshn", reason: `deploy of ${deployer.repo}` },
      `${deployer.repo} deploys ${card.name} from now on, as ${handover.client_name} handed it over (K-819, K-1127)`,
      [],
      null,
    );
  }

  /** K-1127: after its repo's first deploy, the bytes of a page that became a site go; its old names still redirect. */
  private async retireLibraryItem(cardId: string) {
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", cardId);
    const card = this.state.resources.get(cardId);
    if (!row || !card?.kind.startsWith("site.")) return;
    const item = libraryItem(row);
    await this.env.BUCKET?.delete([slotKey(item, 0), slotKey(item, 1)]);
    this.sql("DELETE FROM library WHERE id = ?", cardId);
  }

  /** K-1123: a folder site row counts while its card exists or a plan of it waits for its files. */
  private siteLive(row: Pick<AgentSiteRow, "card_id">, now: number) {
    if (this.state.resources.has(row.card_id)) return true;
    return (
      this.sql(
        "SELECT 1 FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'planned' AND expires_at > ?",
        row.card_id,
        now,
      ).length > 0
    );
  }

  /** K-1123: the addresses that live folder site rows hold, also while their first files have not arrived. */
  private heldSiteAddresses(now: number): Array<{ readonly address: string; readonly card_id: string }> {
    return [
      ...this.sql<AgentSiteRow>("SELECT * FROM agent_sites").filter((row) => this.siteLive(row, now)),
      // K-1127: a handover holds the address that the repo's first deploy takes.
      ...this.sql<{ address: string; card_id: string }>(
        "SELECT address, card_id FROM handovers WHERE expires_at > ?",
        now,
      ).flatMap((row) =>
        (JSON.parse(row.address) as Array<string>).map((address) => ({ address, card_id: row.card_id })),
      ),
    ];
  }

  /** K-1123: as K-1117 for pages: the key that published the site, while it controls the card or it waits in the tray. */
  private agentSiteMayChange(agent: Caller, id: string, now: number): string | null {
    const [row] = this.sql<{ client_id: string; agent_tray: number }>(
      "SELECT client_id, agent_tray FROM agent_sites WHERE card_id = ?",
      id,
    );
    if (!row || row.client_id !== agent.visitor.clientId)
      return "This agent changes only the folder sites that it published (K-1123).";
    // A plan whose files never arrived has no card yet.
    if (!this.state.resources.has(id) || row.agent_tray === 1) return null;
    if (cardsControlledBy(this.state, agent.visitor, now).has(id)) return null;
    return "This agent no longer controls the site, so it cannot change it (K-1123).";
  }

  /**
   * K-1128: the site card that a redirect address belongs to, if the caller may change it: any site card for the
   * owner, a card that a key controls (K-718) for a key. One refusal for unknown and not its own.
   */
  private redirectCard(caller: Caller, card: string, agent: boolean): Resource | Response {
    const resource = this.state.resources.get(card);
    const mine = resource && (!agent || cardsControlledBy(this.state, caller.visitor, Date.now()).has(card));
    if (!resource || !mine || !resource.kind.startsWith("site."))
      return Response.json(
        {
          error: `${agent ? "This agent cannot change" : "kitshn has no site card"} "${card}" (K-718, K-1128).`,
        },
        { status: agent ? 403 : 404 },
      );
    return resource;
  }

  /**
   * K-1128: adds a hostname that only sends visitors on to the card's main address, through the redirect Worker of
   * K-1124. It counts toward the 5 addresses of K-1122 and gets the checks of K-817.
   */
  private async addRedirect(caller: Caller, card: string, address: string, agent: boolean) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const resource = this.redirectCard(caller, card, agent);
    if (resource instanceof Response) return resource;
    const api = this.api();
    if (!api) return fail(503, "kitshn has no Cloudflare API token here.");
    const name = address.toLowerCase();
    const error = redirectAddressError(name, this.env);
    if (error) return fail(400, error);
    if (resource.addresses.includes(name)) return fail(409, `${name} serves ${resource.name} already.`);
    const [own] = this.sql<{ card_id: string; pinned: number; going: number }>(
      "SELECT card_id, pinned, going FROM old_addresses WHERE address = ?",
      name,
    );
    // Also a row that oldAddresses() skips, such as a removed card's or a going one, holds the hostname.
    if (own && own.card_id !== resource.id) return fail(409, `${name} is taken (K-817).`);
    if (own?.pinned === 1 && own.going === 0)
      return fail(409, `${name} sends visitors on to ${resource.name} already.`);
    const [count] = this.sql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM old_addresses WHERE card_id = ? AND pinned = 1",
      resource.id,
    );
    if ((count?.n ?? 0) >= OLD_NAMES)
      return fail(
        409,
        `A card has at most ${OLD_NAMES} redirect addresses; remove one first (K-1122, K-1128).`,
      );
    const refused = await this.addressRefusal(api, [name], resource.id, REDIRECT_SCRIPT, resource, true);
    if (refused) return refused;
    const revision = this.ctx.storage.transactionSync(() => {
      // A plain old address of this card becomes pinned; the primary key keeps another card's.
      this.sql("DELETE FROM old_addresses WHERE address = ? AND card_id = ?", name, resource.id);
      this.sql("INSERT INTO old_addresses (address, card_id, pinned) VALUES (?, ?, 1)", name, resource.id);
      this.rememberOld(resource.id, [], resource.addresses);
      return this.insertRevision(
        caller.actor,
        `Added ${name} as a redirect address of ${resource.name} (K-1128)`,
        [],
        null,
      );
    });
    this.broadcast();
    // The Access application of the new address comes first (K-402), so the next alarm can attach its domain.
    await this.syncAccessLocked(api, 20);
    void this.scheduleAlarm();
    return Response.json({ card: resource.id, address: name, to: resource.addresses[0] ?? "", revision });
  }

  /** K-1128: the way out of addRedirect: the address stops sending visitors on and goes free once its domain went. */
  private removeRedirect(caller: Caller, card: string, address: string, agent: boolean) {
    const resource = this.redirectCard(caller, card, agent);
    if (resource instanceof Response) return resource;
    const name = address.toLowerCase();
    const [row] = this.sql(
      "SELECT 1 FROM old_addresses WHERE address = ? AND card_id = ? AND pinned = 1",
      name,
      resource.id,
    );
    if (!row)
      return Response.json({ error: `${name} is no redirect address of ${resource.name}.` }, { status: 404 });
    const revision = this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE old_addresses SET going = 1 WHERE address = ?", name);
      return this.insertRevision(
        caller.actor,
        `Removed the redirect address ${name} of ${resource.name} (K-1128)`,
        [],
        null,
      );
    });
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ card: resource.id, address: name, revision });
  }

  /**
   * K-1120, K-1122: gives an item a name in its transaction, or throws when another item holds it. The item keeps
   * its newest old names, up to `OLD_NAMES`; an older one goes free.
   */
  private claimName(kind: "page" | "file", name: string, itemId: string) {
    // A name that the item takes back (a rename to an old name, or Undo) gets a new rowid, so it counts as the newest.
    this.sql("DELETE FROM library_addresses WHERE kind = ? AND name = ? AND item_id = ?", kind, name, itemId);
    this.sql(
      "INSERT INTO library_addresses (kind, name, item_id) VALUES (?, ?, ?) ON CONFLICT (kind, name) DO NOTHING",
      kind,
      name,
      itemId,
    );
    const [owner] = this.sql<{ item_id: string }>(
      "SELECT item_id FROM library_addresses WHERE kind = ? AND name = ?",
      kind,
      name,
    );
    if (owner?.item_id !== itemId) throw new AddressTaken(`The address name "${name}" is taken (K-1120).`);
    // The rowid orders the names by when the item took them; the current name is never an old one.
    this.sql(
      `DELETE FROM library_addresses WHERE item_id = ? AND name != ? AND rowid NOT IN
       (SELECT rowid FROM library_addresses WHERE item_id = ? AND name != ? ORDER BY rowid DESC LIMIT ?)`,
      itemId,
      name,
      itemId,
      name,
      OLD_NAMES,
    );
  }

  /**
   * K-1120: the name of a new page or file: the one that the caller gives, when it is free, or a random readable one.
   * The random name comes from nothing about the item, so the address tells nothing about it.
   */
  private newAddressName(
    kind: "page" | "file",
    wanted: string | null,
  ): string | { readonly error: string; readonly status: number } {
    const taken = (name: string) =>
      this.sql("SELECT 1 FROM library_addresses WHERE kind = ? AND name = ?", kind, name).length > 0;
    if (wanted !== null) {
      const error = addressNameError(wanted);
      if (error) return { error, status: 400 };
      if (taken(wanted)) return { error: `The address name "${wanted}" is taken (K-1120).`, status: 409 };
      return wanted;
    }
    // About 324,000 names; a few tries find a free one long before the map fills them.
    for (let tries = 0; tries < 20; tries++) {
      const name = randomAddressName();
      if (!taken(name)) return name;
    }
    return { error: "kitshn found no free random name; give one with an address.", status: 409 };
  }

  /**
   * K-1120: gives a page or a file card a new address name. The old name stays with the item and sends its
   * visitors on, so no one else takes it; Undo moves the card back.
   */
  /**
   * K-212: sets, moves or removes the end time of a card (`{"endsAt": <ms> | null}`), or ends it now (`{"now": true}`).
   * The map, `/api` and agents share it; an agent changes only a card that it manages (K-718).
   */
  private cardTime(caller: Caller, named: string, body: unknown, agent: boolean): Response {
    const now = Date.now();
    const candidates = this.cardCandidates(named);
    if (candidates.length > 1)
      return Response.json(
        { error: `Several cards have the name "${named}"; name the card by its id.` },
        { status: 409 },
      );
    const id = candidates[0] ?? named;
    // A key learns nothing about cards that it does not manage: one answer for unknown and for not its own.
    if (agent && !cardsControlledBy(this.state, caller.visitor, now).has(id))
      return Response.json(
        { error: `This key does not manage the card "${named}" (K-718).` },
        { status: 403 },
      );
    const resource = this.state.resources.get(id);
    if (!resource) return Response.json({ error: `No card "${named}" exists.` }, { status: 404 });
    const wanted = !isRecord(body)
      ? undefined
      : body["now"] === true
        ? "now"
        : body["endsAt"] === null || (typeof body["endsAt"] === "number" && Number.isFinite(body["endsAt"]))
          ? body["endsAt"]
          : undefined;
    if (wanted === undefined)
      return Response.json(
        { error: 'Send {"endsAt": <time in ms> or null} or {"now": true}.' },
        { status: 400 },
      );
    if (typeof wanted === "number" && wanted <= now)
      return Response.json(
        { error: 'This end time has passed. Send {"now": true} to end the card now.' },
        { status: 400 },
      );
    try {
      if (wanted !== "now") {
        const revision = this.commit(
          caller.actor,
          resolveEdits(this.state, [{ _tag: "cardEnd", id, after: wanted }]),
          null,
        );
        return Response.json({ revision, endsAt: wanted });
      }
      if (!this.state.ends.has(id))
        return Response.json(
          { error: `${resource.name} has no end time. "Move to tray" takes it off the map.` },
          { status: 409 },
        );
      return Response.json({ revision: this.endCard(caller.actor, id), endsAt: null });
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  }

  private async setAddress(caller: Caller, named: string, name: string, agent: boolean) {
    let card: string;
    if (agent) {
      // A key learns nothing about cards that it may not change: one answer for unknown and for not its own.
      const mine = this.agentCard(caller, named, Date.now());
      if (!mine)
        return Response.json(
          { error: `This agent cannot change the address of "${named}" (K-1117, K-1120).` },
          { status: 403 },
        );
      card = mine;
    } else {
      // The card by its id, by a name of its address, or for a folder site by its folder.
      const candidates = this.cardCandidates(named);
      if (candidates.length > 1)
        return Response.json(
          { error: `Several cards have the name "${named}"; name the card by its id.` },
          { status: 409 },
        );
      card = candidates[0] ?? named;
    }
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", card);
    const resource = this.state.resources.get(card);
    if (resource && this.isFolderSite(card)) return await this.renameFolderSite(caller, resource, name);
    if (!row || !resource)
      return Response.json(
        {
          error:
            resource && this.deployedCards(card).includes(card)
              ? `The address of ${resource.name} comes from its repo; set it in kitshn.config.ts (K-1120).`
              : `Only a page or a file has an address that kitshn sets (K-1120).`,
        },
        { status: 409 },
      );
    const error = addressNameError(name);
    if (error) return Response.json({ error }, { status: 400 });
    const item = libraryItem(row);
    const [owner] = this.sql<{ item_id: string }>(
      "SELECT item_id FROM library_addresses WHERE kind = ? AND name = ?",
      item.kind,
      name,
    );
    if (owner && owner.item_id !== card)
      return Response.json({ error: `The address name "${name}" is taken (K-1120).` }, { status: 409 });
    const before = resource.addresses[0] ?? "";
    const after = libraryAddress(this.env.KITSHN_ZONE, item, name);
    if (after === before) return Response.json({ card, kind: item.kind, address: after, revision: null });
    try {
      const revision = this.commit(caller.actor, [{ _tag: "address", id: card, before, after }], null);
      return Response.json({ card, kind: item.kind, address: after, revision });
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  }

  /**
   * K-1117: a key updates or restores a page or a file that it published only while it still controls the card,
   * as K-718 asks for a move, or while the card has waited in the tray since its publish (`agent_tray`).
   */
  private agentMayChange(agent: Caller, id: string, now: number): string | null {
    const [row] = this.sql<{ added_by: string | null; agent_tray: number }>(
      "SELECT added_by, agent_tray FROM library WHERE id = ?",
      id,
    );
    if (!row || row.added_by !== agent.visitor.clientId)
      return "This agent changes only what it published (K-1117).";
    if (row.agent_tray === 1 || cardsControlledBy(this.state, agent.visitor, now).has(id)) return null;
    return "This agent no longer controls the card, so it cannot change it (K-1117).";
  }

  /**
   * K-1117: one update, restore or delete of an item at a time. R2 awaits let other requests in, so without this
   * two of them could mix their slots.
   */
  private async exclusive(id: string, work: () => Promise<Response>): Promise<Response> {
    if (this.busyItems.has(id))
      return Response.json(
        { error: "kitshn changes this item now; try again when it finishes (K-1117)." },
        { status: 409 },
      );
    this.busyItems.add(id);
    try {
      return await work();
    } finally {
      this.busyItems.delete(id);
    }
  }

  /**
   * K-1117: new bytes for a page or a file. They go into the slot that does not serve, which held the previous
   * version; one transaction then makes it current. A failed upload leaves the bytes that serve as they were.
   */
  private updateLibrary(caller: Caller, row: LibraryRow, request: Request, now: number) {
    return this.exclusive(row.id, async () => {
      const taken = this.takenOver(row.id);
      if (taken) return taken;
      const refuse = (error: string, status = 400) => Response.json({ error }, { status });
      const bucket = this.env.BUCKET;
      if (!bucket) return refuse("R2 is off for this kitshn. Run the bootstrap again after R2 is on.", 503);
      const size = Number(request.headers.get("content-length"));
      if (!request.body || !Number.isInteger(size) || size <= 0)
        return refuse("Send the bytes with a Content-Length.", 411);
      if (size > MAX_UPLOAD_BYTES) return refuse("A page or a file is at most 100 MB (K-1101).", 413);
      const item = libraryItem(row);
      const contentType =
        item.kind === "page"
          ? "text/html"
          : request.headers.get("content-type") || "application/octet-stream";
      const [body, sniffed] =
        item.kind === "page" || size <= ICON_LIMIT ? request.body.tee() : ([request.body, null] as const);
      const icon = headIcon(
        item.kind,
        sniffed ? await readStart(sniffed, item.kind === "page" ? PAGE_ICON_SCAN : ICON_LIMIT) : null,
      );
      const next = item.slot === 0 ? 1 : 0;
      const { readable, writable } = new FixedLengthStream(size);
      const piped = body.pipeTo(writable);
      try {
        await bucket.put(slotKey(item, next), readable, { httpMetadata: { contentType } });
        await piped;
      } catch (error) {
        await piped.catch(() => undefined);
        return refuse(`The upload did not reach R2, so ${item.title} keeps its bytes: ${String(error)}`, 502);
      }
      const flip = (): number =>
        this.ctx.storage.transactionSync(() => {
          // The owner can move the card while R2 takes the bytes, so the key's control counts at the flip.
          const refusal = this.agentMayChange(caller, row.id, now);
          if (refusal) throw new RuleError(refusal);
          this.sql(
            `UPDATE library SET current_slot = ?, size = ?, content_type = ?, previous_size = ?, previous_type = ?
             WHERE id = ?`,
            next,
            size,
            contentType,
            row.size,
            row.content_type,
            row.id,
          );
          return this.insertRevision(
            caller.actor,
            `Updated the ${item.kind} ${item.title}; kitshn keeps the previous version (K-1117)`,
            [],
            null,
          );
        });
      let revision: number;
      try {
        revision = flip();
      } catch (error) {
        // The other slot holds the refused bytes now, not the previous version, so that version is gone.
        this.sql("UPDATE library SET previous_size = NULL, previous_type = NULL WHERE id = ?", row.id);
        await bucket.delete(slotKey(item, next)).catch(() => undefined);
        this.broadcast();
        if (error instanceof RuleError) return refuse(error.message, 403);
        throw error;
      }
      await this.setIcon(row.id, icon);
      this.load();
      this.broadcast();
      const address = this.state.resources.get(row.id)?.addresses[0] ?? null;
      return Response.json({ id: row.id, address, revision, updated: true });
    });
  }

  /**
   * K-1117: makes the previous version of a page or a file current, so a second restore swaps them back. It only
   * switches the slot; R2 copies nothing. The owner restores any item; an agent key what K-1117 lets it change.
   */
  private restorePrevious(caller: Caller, id: string, by: "owner" | "agent") {
    return this.exclusive(id, async () => {
      const taken = this.takenOver(id);
      if (taken) return taken;
      const refusal = by === "agent" ? this.agentMayChange(caller, id, Date.now()) : null;
      if (refusal) return Response.json({ error: refusal }, { status: 403 });
      const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
      if (!row) return Response.json({ error: `The library has no item ${id}.` }, { status: 404 });
      if (row.previous_size === null || row.previous_type === null)
        return Response.json({ error: `${row.title} has no previous version.` }, { status: 409 });
      const item = libraryItem(row);
      const previous = item.slot === 0 ? 1 : 0;
      const revision = this.ctx.storage.transactionSync(() => {
        this.sql(
          `UPDATE library SET current_slot = ?, size = ?, content_type = ?, previous_size = ?, previous_type = ?
           WHERE id = ?`,
          previous,
          row.previous_size,
          row.previous_type,
          row.size,
          row.content_type,
          id,
        );
        // K-1117: a change by the owner ends the tray right of the key that published the item.
        if (by === "owner") this.sql("UPDATE library SET agent_tray = 0 WHERE id = ?", id);
        return this.insertRevision(
          caller.actor,
          `Restored the previous version of the ${item.kind} ${item.title} (K-1117)`,
          [],
          null,
        );
      });
      const small = item.kind === "page" || (row.previous_size ?? 0) <= ICON_LIMIT;
      const start =
        small && this.env.BUCKET
          ? await this.env.BUCKET.get(slotKey(item, previous), {
              range: { offset: 0, length: item.kind === "page" ? PAGE_ICON_SCAN : ICON_LIMIT },
            })
          : null;
      await this.setIcon(id, start ? headIcon(item.kind, new Uint8Array(await start.arrayBuffer())) : null);
      this.load();
      this.broadcast();
      return Response.json({ id, revision });
    });
  }

  /**
   * K-1005: the preview of the Library view, for the admin only. The sandbox header gives it an opaque
   * origin, so a page cannot read the admin cookie or call the API.
   */
  private async preview(id: string) {
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    const object = row && (await this.env.BUCKET?.get(objectKey(libraryItem(row))));
    if (!row || !object) return new Response("kitshn has no such item.", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": row.kind === "page" ? "text/html; charset=utf-8" : row.content_type,
        "content-security-policy": contentSecurityPolicy(adminHosts(this.env)),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  }

  /** K-1006: removes the bytes from R2 first, then the card and the index row. */
  private deleteItem(caller: Caller, id: string) {
    return this.exclusive(id, () => this.deleteItemNow(caller, id));
  }

  /**
   * K-1127: a page whose card a repo took is the repo's site now; its bytes wait only for the first finish. No
   * library write changes it: no update by name, no restore, no delete. Remove app takes that card down.
   */
  private takenOver(id: string): Response | null {
    const card = this.state.resources.get(id);
    if (!card || card.kind === "page" || card.kind === "file") return null;
    return Response.json(
      {
        error: `${card.name} is a repo's site now; change it in its repo, or remove the app on the map (K-1127).`,
      },
      { status: 409 },
    );
  }

  private async deleteItemNow(caller: Caller, id: string) {
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    const taken = this.takenOver(id);
    if (taken) return taken;
    if (!row) return Response.json({ error: `The library has no item ${id}.` }, { status: 404 });
    const item = libraryItem(row);
    if (!this.env.BUCKET) return Response.json({ error: "R2 is off for this kitshn." }, { status: 503 });
    await this.env.BUCKET.delete([slotKey(item, 0), slotKey(item, 1)]);
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR IGNORE INTO library_deleted (source) SELECT source FROM library WHERE id = ? AND source IS NOT NULL",
        id,
      );
      this.sql("DELETE FROM library WHERE id = ?", id);
      this.sql("DELETE FROM library_addresses WHERE item_id = ?", id);
      this.insertRevision(
        caller.actor,
        `Deleted the ${item.kind} ${item.title}`,
        [this.forgetCard(id)],
        null,
      );
    });
    this.load();
    this.broadcast();
    return Response.json({ deleted: id });
  }

  /** K-110: a login from before "Sign out everywhere" counts as no login. */
  private freshVisitor(sent: ContentVisitor): ContentVisitor {
    const signedOutAt = Number(this.meta("signed_out_at") ?? 0);
    return (sent.email !== null || sent.clientId !== null) && (sent.issuedAt ?? 0) * 1000 < signedOutAt
      ? { email: null, clientId: null, ip: sent.ip, passkey: false, issuedAt: null }
      : sent;
  }

  private gameRows(where = "1 = 1", ...values: Array<SqlStorageValue>) {
    return this.sql<GameRow>(`SELECT * FROM games WHERE ${where}`, ...values);
  }

  private openDoors(now: number, card?: string) {
    return (
      card === undefined
        ? this.sql<DoorRow>("SELECT * FROM doors WHERE ends_at > ?", now)
        : this.sql<DoorRow>("SELECT * FROM doors WHERE ends_at > ? AND card_id = ?", now, card)
    ).map(doorOf);
  }

  /** K-2002: why a machine cannot hold doors now, or null. */
  private doorsProblem(machineId: string): string | null {
    const machine = this.state.machines.get(machineId);
    if (!machine) return `No machine "${machineId}" exists.`;
    const status = this.machineView(machine).status;
    if (!status) return `${machine.name} is offline; kitshn needs its report first.`;
    if (status.capabilities?.includes("doors")) return null;
    return `${machine.name} cannot hold doors: ${status.doorsProblem ?? "its daemon is too old; update it"}.`;
  }

  /**
   * K-2005: the full door plan of one machine as a job. The plan replaces the whole table, so a newer job makes the
   * queued ones useless; they fail with a note.
   */
  private queueDoors(machineId: string, actor: Actor, now: number) {
    this.sql(
      `UPDATE jobs SET state = 'failed', output = 'A newer door plan replaced this job.'
       WHERE machine_id = ? AND state = 'queued' AND json_extract(command, '$.kind') = 'doors'`,
      machineId,
    );
    this.queueKitshnJob(
      machineId,
      { kind: "doors", plan: this.doorPlanOf(machineId, now) },
      actor,
      now + HOUR_MS,
    );
    this.deliverJobs();
  }

  /** K-2001: a new game card in the tray. The owner or an agent puts it into circles later. */
  private createGame(actor: Actor, body: unknown) {
    const refuse = (error: string, status = 400) => Response.json({ error }, { status });
    if (!isRecord(body)) return refuse("Send a JSON object.");
    const name = typeof body["name"] === "string" ? body["name"].trim().toLowerCase() : "";
    const machineId = typeof body["machine"] === "string" ? body["machine"] : "";
    const texts = Array.isArray(body["ports"]) ? body["ports"] : [];
    const ports = texts.map((text) => (typeof text === "string" ? parsePort(text) : null));
    if (ports.some((port) => port === null)) return refuse("A port is like 25565/tcp or 19132/udp.");
    const hours = body["doorHours"] ?? DEFAULT_DOOR_MS / HOUR_MS;
    const srv = typeof body["srv"] === "string" && body["srv"] !== "" ? body["srv"] : null;
    const relay = typeof body["relay"] === "string" && body["relay"] !== "" ? body["relay"] : null;
    const game = {
      name,
      ports: ports.filter((port) => port !== null),
      doorMs: typeof hours === "number" ? hours * HOUR_MS : Number.NaN,
      srv,
      relay,
    };
    const error = gameError(game);
    if (error) return refuse(error);
    if (!this.state.machines.has(machineId)) return refuse(`No machine "${machineId}" exists.`, 404);
    if (relay === machineId) return refuse("A machine does not relay its own game.");
    const problem = this.doorsProblem(relay ?? machineId);
    if (problem) return refuse(problem, 409);
    // K-2001: a door must not close a port that a kitshn site of the door machine serves.
    const site = [...this.liveSites.values()].find(
      (item) =>
        item.machineId === (relay ?? machineId) &&
        game.ports.some((port) => port.proto === "tcp" && item.target === `http://localhost:${port.port}`),
    );
    if (site)
      return refuse(
        `${site.address} serves from ${site.target} on this machine, so a game card cannot close it.`,
        409,
      );
    // K-2001, K-619: a port that another service of the door machine listens on.
    const busy = busyPort(game.ports, this.machineView(this.state.machines.get(relay ?? machineId)!).servers);
    if (busy)
      return refuse(
        `${busy.port}/tcp on this machine is ${busy.title ? `"${busy.title}"` : (busy.process ?? "another service")}, which is no game, so a game card cannot close it.`,
        409,
      );
    const host = `${name}.${this.env.KITSHN_ZONE}`;
    const addresses = relay ? [host, relayHost(name, this.env.KITSHN_ZONE)] : [host];
    const taken = (address: string) =>
      RESERVED_SITE_NAMES.has(address.split(".")[0] ?? "") ||
      reservedSiteLinkHost(address, this.env.KITSHN_ZONE) ||
      this.gameRows("name = ?", name).length > 0 ||
      [...this.state.resources.values()].some((resource) => resource.addresses.includes(address)) ||
      [...this.liveSites.values()].some((site) => site.address === address) ||
      this.sql("SELECT address FROM dns_objects WHERE address = ?", address).length > 0;
    const clash = addresses.find(taken);
    if (clash) return refuse(`${clash} is taken; pick another name.`, 409);
    const status = this.machineView(this.state.machines.get(relay ?? machineId)!).status;
    const id = newLibraryId();
    const resource: Resource = {
      id,
      kind: "game",
      name,
      addresses,
      status: "unknown",
      group: null,
      machine: machineId,
      ...(relay ? { relay } : {}),
    };
    const revision = this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT INTO games (card_id, machine_id, name, ports, door_ms, srv, relay_id, v4, v6) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        machineId,
        name,
        JSON.stringify(game.ports),
        game.doorMs,
        srv,
        relay,
        status?.publicAddresses?.v4 ?? null,
        status?.publicAddresses?.v6 ?? null,
      );
      return this.addCard(actor, resource, null, `the game server ${name}`);
    });
    this.queueDoors(relay ?? machineId, actor, Date.now());
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json(
      { id, address: host, join: `https://pages.${this.env.KITSHN_ZONE}/join/${name}`, revision },
      { status: 201 },
    );
  }

  /** K-2001: removes a game card, its doors and, through the alarm, its records. */
  private deleteGame(actor: Actor, id: string) {
    const [row] = this.gameRows("card_id = ?", id);
    if (!row) return Response.json({ error: `No game card "${id}" exists.` }, { status: 404 });
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM games WHERE card_id = ?", id);
      this.sql("DELETE FROM doors WHERE card_id = ?", id);
      this.insertRevision(actor, `Removed the game server ${row.name}`, [this.forgetCard(id)], null);
    });
    this.queueDoors(doorMachine(gameOf(row)), actor, Date.now());
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ deleted: id });
  }

  /** K-2004: closes doors in one transaction, each with a History line, then sends the new plans. */
  private closeDoors(actor: Actor, doors: ReadonlyArray<Door>, why: string, now: number) {
    if (doors.length === 0) return;
    const machines = new Set<string>();
    this.ctx.storage.transactionSync(() => {
      for (const door of doors) {
        this.sql(
          "DELETE FROM doors WHERE card_id = ? AND person = ? AND address = ?",
          door.card,
          door.person,
          door.address,
        );
        const [row] = this.gameRows("card_id = ?", door.card);
        if (row) machines.add(doorMachine(gameOf(row)));
        this.insertRevision(
          actor,
          `Closed the door of ${door.person} on ${row?.name ?? door.card} for ${door.address} (${why})`,
          [],
          null,
        );
      }
    });
    for (const machine of machines) this.queueDoors(machine, actor, now);
  }

  private doorPlanOf(machineId: string, now: number) {
    return doorPlan(
      machineId,
      this.gameRows().map(gameOf),
      this.openDoors(now),
      now,
      this.env.KITSHN_ZONE,
      this.openGames(now),
    );
  }

  /** K-2004: the game cards with an active share in Everyone, whose ports are open to every address. */
  private openGames(now: number) {
    return new Set(
      this.gameRows()
        .map((row) => row.card_id)
        .filter((card) => {
          const resource = this.state.resources.get(card);
          return resource !== undefined && openToAll(this.state, resource, now);
        }),
    );
  }

  /** K-2005: a share in Everyone that starts or ends sends new plans, so the ports open or close for all. */
  private syncOpenGames(now: number) {
    const open = [...this.openGames(now)].sort().join(" ");
    if (open === this.openGamesSent) return;
    const restarted = this.openGamesSent === null;
    this.openGamesSent = open;
    const actor: Actor = { _tag: "kitshn", reason: "Everyone share of a game (K-2004)" };
    for (const machine of new Set(this.gameRows().map(gameOf).map(doorMachine))) {
      // After a restart the last change is not known, so a machine gets a plan only when its gated ports differ from
      // its last plan that did not fail.
      if (restarted && JSON.stringify(this.doorPlanOf(machine, now).ports) === this.lastDoorPorts(machine))
        continue;
      this.queueDoors(machine, actor, now);
    }
  }

  private lastDoorPorts(machineId: string) {
    const [last] = this.sql<{ ports: string | null }>(
      `SELECT json_extract(command, '$.plan.ports') AS ports FROM jobs
       WHERE machine_id = ? AND state != 'failed' AND json_extract(command, '$.kind') = 'doors' ORDER BY id DESC LIMIT 1`,
      machineId,
    );
    return last?.ports ?? null;
  }

  /** K-2005: a door whose person lost the card's share closes at once; a door of a removed card goes too. */
  private closeLostDoors(now: number) {
    // The check uses the address that opened the door, so a circle with an address condition keeps it open.
    const lost = this.sql<DoorRow>("SELECT * FROM doors WHERE ends_at > ?", now)
      .filter((row) => {
        const resource = this.state.resources.get(row.card_id);
        if (!resource) return true;
        const visitor = { email: row.person, clientId: null, ip: row.seen_ip, passkey: true, issuedAt: null };
        return contentAccess(this.state, resource, visitor, now) !== "allow";
      })
      .map(doorOf);
    if (lost.length === 0) return false;
    this.closeDoors({ _tag: "kitshn", reason: "share lost (K-2005)" }, lost, "the share ended", now);
    this.load();
    return true;
  }

  /** K-2003: the join page asks here; `open` and `close` change the doors of the visitor alone. */
  private gameDecision(input: GameRequest) {
    const now = Date.now();
    const visitor = this.freshVisitor(input.visitor);
    const stale = visitor !== input.visitor;
    const [row] = this.gameRows("name = ?", input.name);
    const resource = row ? this.state.resources.get(row.card_id) : undefined;
    if (!row || !resource) return Response.json({ decision: "missing", stale });
    // A door belongs to a person, so the join page needs a login, also on a card in Everyone.
    const game = gameOf(row);
    const machine = doorMachine(game);
    const status = this.state.machines.get(machine);
    const gameView = {
      name: game.name,
      address: joinAddress(game, resource.addresses[0] ?? ""),
      ports: game.ports.map(portKey),
      doorHours: game.doorMs / HOUR_MS,
      reachable: row.v4 !== null || row.v6 !== null,
      machineOnline: status ? this.machineView(status).online : false,
      needsIpv4: game.relay !== null,
    };
    // K-2004: a game in Everyone has no doors, so its page needs no login.
    if (openToAll(this.state, resource, now))
      return Response.json({
        decision: "allow",
        stale,
        error: input.action === "view" ? null : "This game is open to everyone, so it needs no door.",
        game: gameView,
        openToAll: true,
        doors: [],
        seen: visitor.ip,
      });
    const decision = visitor.email === null ? "login" : contentAccess(this.state, resource, visitor, now);
    if (decision !== "allow" || visitor.email === null) return Response.json({ decision, stale });
    const person = visitor.email;
    const actor: Actor = { _tag: "person", email: person };
    let error: string | null = null;
    // K-2004: one open or close per person and card in 10 s, so a loop cannot fill History or the machine's jobs.
    // In memory, as the limits of K-1908: a restart of the Durable Object only resets the wait.
    const turn = `${game.card} ${person}`;
    const waiting =
      (input.action === "open" || input.action === "close") && (this.doorTurns.get(turn) ?? 0) > now - 10_000;
    if (waiting) error = "You changed a door a few seconds ago. Wait a moment.";
    const tookTurn = () => {
      this.doorTurns.set(turn, now);
      if (this.doorTurns.size > 1000)
        for (const [key, at] of this.doorTurns) if (at <= now - 10_000) this.doorTurns.delete(key);
    };
    if (input.action === "open" && !waiting) {
      // K-2004: the address that kitshn sees is always a door; the browser adds the other addresses that it found,
      // within the limits of openDoors. Each browser address passes the share check, so an address condition of a
      // circle still holds; a refused one is left out.
      const seen = doorAddress(visitor.ip ?? "");
      const found = (input.addresses ?? [])
        .slice(0, DOOR_LIMITS[4] + DOOR_LIMITS[6])
        .map(String)
        .filter((ip) => contentAccess(this.state, resource, { ...visitor, ip }, now) === "allow")
        .map((address) => doorAddress(address))
        .flatMap((door) => ("error" in door ? [] : [door.address]));
      const addresses = "error" in seen ? [] : [...new Set([seen.address, ...found])];
      error =
        ("error" in seen ? `kitshn sees your address as ${visitor.ip ?? "none"}: ${seen.error}` : null) ??
        // K-2004: a relay listens on IPv4 only, so an IPv6-only open would open nothing that works.
        (game.relay !== null && !addresses.some((address) => doorFamily(address) === 4)
          ? "This server needs IPv4, and no IPv4 address answered."
          : null) ??
        // An offline machine gets the plan when it connects; an online one must hold doors now.
        (this.state.machines.has(machine) && !this.machineView(this.state.machines.get(machine)!).online
          ? null
          : this.doorsProblem(machine));
      if (error === null) {
        const { open, close } = openDoors(this.openDoors(now, game.card), game, person, addresses, now);
        const ends = new Date(now + game.doorMs).toISOString().slice(0, 16).replace("T", " ");
        this.ctx.storage.transactionSync(() => {
          for (const address of close)
            this.sql(
              "DELETE FROM doors WHERE card_id = ? AND person = ? AND address = ?",
              game.card,
              person,
              address,
            );
          for (const door of open)
            this.sql(
              "INSERT OR REPLACE INTO doors (card_id, person, address, opened_at, ends_at, seen_ip) VALUES (?, ?, ?, ?, ?, ?)",
              door.card,
              door.person,
              door.address,
              door.openedAt,
              door.endsAt,
              visitor.ip,
            );
          this.insertRevision(
            actor,
            `${person} opened ${game.name} for ${open.map((door) => door.address).join(", ")} until ${ends} UTC`,
            [],
            null,
          );
        });
        this.queueDoors(machine, actor, now);
        tookTurn();
        this.load();
        this.broadcast();
      }
    }
    if (input.action === "close" && !waiting) {
      // K-2004: End now closes every door of this person on the card.
      const doors = this.openDoors(now, game.card).filter((item) => item.person === person);
      if (doors.length > 0) {
        this.closeDoors(actor, doors, "End now", now);
        tookTurn();
        this.load();
        this.broadcast();
      } else error = "You have no open door on this game.";
    }
    return Response.json({
      decision,
      stale,
      error,
      game: gameView,
      openToAll: false,
      doors: this.openDoors(now, game.card).filter((door) => door.person === person),
      seen: visitor.ip,
    });
  }

  /** K-2006: a game card as the owner and agents see it: its doors, records and what listens. */
  private gameView(row: GameRow, now: number) {
    const game = gameOf(row);
    const machine = this.state.machines.get(doorMachine(game));
    const listening = new Set(machine ? (this.machineView(machine).status?.listening ?? []) : []);
    return {
      ...game,
      join: `https://pages.${this.env.KITSHN_ZONE}/join/${game.name}`,
      address: joinAddress(game, `${game.name}.${this.env.KITSHN_ZONE}`),
      listening: game.ports.map(portKey).filter((port) => listening.has(port)),
      problem: this.doorsProblem(doorMachine(game)),
      doors: this.openDoors(now, game.card),
      records: this.sql<GameRecordRow>("SELECT * FROM game_records WHERE card_id = ?", game.card).map(
        (record) => ({
          type: record.type,
          name: record.name,
          content: record.content,
          error: record.error,
        }),
      ),
    };
  }

  /** K-2006: the owner and agents close any door of a card. */
  private closeDoorBy(actor: Actor, card: string, address: string) {
    const now = Date.now();
    const doors = this.openDoors(now, card).filter((door) => door.address === address);
    if (doors.length === 0)
      return Response.json({ error: `No door for ${address} is open on this card.` }, { status: 404 });
    this.closeDoors(actor, doors, "closed by hand", now);
    this.load();
    this.broadcast();
    return Response.json({ closed: doors.length });
  }

  /** K-2002: a new public address of a machine moves the records of its games. */
  private updateGameAddresses(machineId: string, found: MachineStatus["publicAddresses"]) {
    if (!found) return;
    const moved = this.sql(
      `UPDATE games SET v4 = ?, v6 = ? WHERE COALESCE(relay_id, machine_id) = ?
       AND (v4 IS NOT ? OR v6 IS NOT ?) RETURNING card_id`,
      found.v4,
      found.v6,
      machineId,
      found.v4,
      found.v6,
    );
    if (moved.length > 0) void this.scheduleAlarm();
  }

  /** K-2007: true when a game record waits for the alarm. */
  private gameDnsWork(now: number) {
    const want = new Map(
      gameRecords(this.gameRows(), this.env.KITSHN_ZONE).map((r) => [`${r.type} ${r.name}`, r]),
    );
    const rows = this.sql<GameRecordRow>("SELECT * FROM game_records");
    const keys = new Set(rows.map((row) => `${row.type} ${row.name}`));
    return (
      rows.some(
        (row) =>
          (row.error === null || row.retry_at <= now) &&
          (want.get(`${row.type} ${row.name}`)?.content !== row.content || row.error !== null),
      ) || [...want.keys()].some((key) => !keys.has(key))
    );
  }

  /**
   * K-2007: makes, moves and removes the A, AAAA and SRV records of game cards; returns the Cloudflare calls. A new
   * record first checks that no record of that type and name exists, so kitshn never adds to one it did not make.
   */
  private async syncGameDns(api: Api, budget: number) {
    const now = Date.now();
    let calls = 0;
    const want = new Map(
      gameRecords(this.gameRows(), this.env.KITSHN_ZONE).map((r) => [`${r.type} ${r.name}`, r]),
    );
    // Every game record is on the kitshn zone. zonePath takes one label only, so an SRV name like _x._tcp.<name> fails it.
    const zone = `${this.zonePath(this.env.KITSHN_ZONE)}/dns_records`;
    const rows = this.sql<GameRecordRow>("SELECT * FROM game_records");
    const failed = (
      row: { type: string; name: string; card_id: string; content: string; record_id: string },
      error: unknown,
    ) =>
      this.sql(
        "INSERT OR REPLACE INTO game_records (type, name, card_id, content, record_id, error, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        row.type,
        row.name,
        row.card_id,
        row.content,
        row.record_id,
        String(error),
        now + RETRY_MS,
      );
    for (const row of rows) {
      if (want.has(`${row.type} ${row.name}`) || (row.error !== null && row.retry_at > now)) continue;
      if (calls >= budget) return calls;
      try {
        if (row.record_id) {
          calls++;
          await api("DELETE", `${zone}/${row.record_id}`).catch((error: unknown) =>
            error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
          );
        }
        this.sql("DELETE FROM game_records WHERE type = ? AND name = ?", row.type, row.name);
      } catch (error) {
        failed(row, error);
      }
    }
    const have = new Map(rows.map((row) => [`${row.type} ${row.name}`, row]));
    for (const [key, record] of want) {
      const row = have.get(key);
      if (row && row.content === record.content && row.error === null) continue;
      if (row?.error && row.retry_at > now) continue;
      if (calls + 2 > budget) return calls;
      try {
        let recordId = row?.record_id ?? "";
        if (!recordId) {
          calls++;
          const found = await api<Array<unknown>>(
            "GET",
            `${zone}?type=${record.type}&name=${encodeURIComponent(record.name)}`,
          );
          if (found.length > 0)
            throw new Error(
              `A ${record.type} record for ${record.name} exists that kitshn did not make. Remove it, or give the game another name.`,
            );
        }
        calls++;
        const made = recordId
          ? await api<{ id: string }>("PUT", `${zone}/${recordId}`, recordBody(record))
          : await api<{ id: string }>("POST", zone, recordBody(record));
        recordId = made.id;
        this.sql(
          "INSERT OR REPLACE INTO game_records (type, name, card_id, content, record_id, error, retry_at) VALUES (?, ?, ?, ?, ?, NULL, 0)",
          record.type,
          record.name,
          record.card,
          record.content,
          recordId,
        );
      } catch (error) {
        failed(
          {
            type: record.type,
            name: record.name,
            card_id: record.card,
            content: row?.content ?? "",
            record_id: row?.record_id ?? "",
          },
          error,
        );
      }
    }
    return calls;
  }

  /** K-113: returns the Cloudflare calls it made. */
  private async syncLauncher(api: Api, force: boolean) {
    if (!force && this.meta("launcher_failed") === `failed:${this.launcherWant()}`) return 0;
    try {
      const result = await syncLauncher(
        this.desired(Date.now()),
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.meta("launcher_policy") || null,
        force,
      );
      this.setMeta("launcher_policy", result.attached ?? "");
      this.setMeta("launcher_failed", "none");
      return result.calls;
    } catch (error) {
      // K-408: a failed write waits for the daily retry, so the alarm does not loop on it.
      console.warn(`kitshn could not update the App Launcher: ${String(error)}`);
      this.setMeta("launcher_failed", `failed:${this.launcherWant()}`);
      return 3;
    }
  }

  /** K-113: the enrollment policy id that the App Launcher should have, or "" for none. */
  private launcherWant() {
    return this.desired(Date.now()).policies.has(ENROLLMENT_KEY)
      ? this.access.get(ENROLLMENT_KEY)?.cfId || ""
      : "";
  }

  /** K-113: the App Launcher lacks the wanted policy, and that change did not fail since the daily retry. */
  private launcherWork() {
    const want = this.launcherWant();
    return want !== (this.meta("launcher_policy") ?? "") && this.meta("launcher_failed") !== `failed:${want}`;
  }

  /** K-1004: returns the Cloudflare calls it made. The daily run (K-408) asks it to write everything again. */
  private async syncLogins(api: Api) {
    const desired = this.desired(Date.now());
    const want = loginWant(desired, this.access);
    const force = this.meta("login_check") === "due";
    this.setMeta("login_check", "done");
    try {
      const result = await syncLogins(
        desired,
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.env.KITSHN_ZONE,
        this.meta("login_policies") ?? "",
        force,
      );
      this.setMeta("login_policies", result.attached);
      this.setMeta("login_held", result.attached);
      this.setMeta("login_failed", "none");
      this.setLoginError("");
      return result.calls;
    } catch (error) {
      // K-408: a failed write waits for the daily retry, so the alarm does not loop on it.
      console.warn(String(error));
      this.setMeta("login_failed", `failed:${want}`);
      this.setMeta("login_held", loginHeldAfter(this.meta("login_held") ?? "", want, false));
      this.setLoginError(error instanceof Error ? error.message : String(error));
      return LOGIN_CALLS;
    }
  }

  /** K-1004: the map shows a failed login update next to the other Access warnings. */
  private setLoginError(text: string) {
    if ((this.meta("login_error") ?? "") === text) return;
    this.setMeta("login_error", text);
    this.broadcast();
  }

  /** K-406, K-1004: every Access sync runs here, after the login step, inside one budget. */
  private syncAccessLocked(api: Api, budget: number) {
    return this.withAccessLock(() =>
      syncWithLogins(
        budget,
        this.loginWork(),
        () => this.syncLogins(api),
        (left) =>
          syncAccess(
            this.desired(Date.now()),
            this.accessStore(),
            api,
            this.env.CLOUDFLARE_ACCOUNT_ID,
            left,
            this.reachableAddresses(),
            // Read after the login step, which may have let go of some.
            loginHeld(this.meta("login_held") ?? ""),
          ),
      ),
    );
  }

  /** K-1004: the daily check is due, or the login applications lack the wanted policies and that did not fail. */
  private loginWork() {
    if (this.meta("login_check") === "due") return true;
    const want = loginWant(this.desired(Date.now()), this.access);
    return want !== (this.meta("login_policies") ?? "") && this.meta("login_failed") !== `failed:${want}`;
  }

  private accessLock: Promise<unknown> = Promise.resolve();
  /** K-603: when the alarm reads missing audience tags again. In memory: a restart only reads sooner. */
  private audRetryAt = 0;

  /** K-603: reads missing audience tags before the tunnels use them. Returns the number of calls. */
  private async fillAudiences(api: Api, now: number) {
    if (rowsWithoutAud(this.access).length === 0 || this.audRetryAt > now) return 0;
    try {
      // In the lock, so a deploy's Access sync never writes a row between the read and the put.
      return await this.withAccessLock(() =>
        fillAudiences(this.accessStore(), api, this.env.CLOUDFLARE_ACCOUNT_ID),
      );
    } catch (error) {
      console.warn(`kitshn could not read the audience tags of Access: ${String(error)}`);
      return 1;
    } finally {
      if (rowsWithoutAud(this.access).length > 0) this.audRetryAt = now + RETRY_MS;
    }
  }

  /** Runs one Access sync at a time, so a deploy and the alarm never both create the same object. */
  private withAccessLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.accessLock.then(work, work);
    this.accessLock = run.catch(() => undefined);
    return run;
  }

  private accessStore(): AccessStore {
    return {
      rows: this.access,
      put: (row: AccessRow) => {
        this.access.set(row.key, row);
        this.sql(
          "INSERT OR REPLACE INTO access_objects (key, cf_id, aud, body, tried, error) VALUES (?, ?, ?, ?, ?, ?)",
          row.key,
          row.cfId,
          row.aud,
          row.body,
          row.tried,
          row.error,
        );
      },
      remove: (key: string) => {
        this.access.delete(key);
        this.sql("DELETE FROM access_objects WHERE key = ?", key);
      },
    };
  }

  /** The Cloudflare API with the Worker's token, or a reason when the Worker has none (local development). */
  private api() {
    const token = this.env.CLOUDFLARE_API_TOKEN;
    if (!token) return null;
    return <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
      cloudflare<T>(token, method, path, body);
  }

  /** K-1125: the cards that uptime covers. A daemon site needs no fetch; a static or Worker app needs one per address. */
  private uptimeTargets() {
    return [...this.state.resources.values()].filter(
      (resource) =>
        (resource.kind === "site.compose" || resource.kind === "site.live"
          ? this.liveSites.has(resource.id)
          : resource.kind === "site.static" || resource.kind === "site.worker") &&
        resource.addresses.length > 0,
    );
  }

  /**
   * K-1125, K-1126: one uptime run, once per turn of 2 minutes. `fetchBudget` is the share of the 40 calls of this
   * run (K-406). Writes a row only when a card changes, and keeps rows only for cards that are down or failing.
   */
  private async checkUptime(
    now: number,
    fetchBudget: number,
  ): Promise<{ fetches: number; changed: boolean }> {
    const slot = Math.floor(now / UPTIME_RUN_MS);
    const targets = this.uptimeTargets();
    if (targets.length === 0 || slot === this.uptimeSlot) return { fetches: 0, changed: false };
    this.uptimeSlot = slot;
    const online = this.onlineMachines();
    const probes = new Map<string, { up: boolean; failingFor: number }>();
    for (const card of targets) {
      const site = this.liveSites.get(card.id);
      if (site) probes.set(card.id, { up: site.up && online.has(site.machineId), failingFor: 0 });
    }
    const fetched =
      fetchBudget === 0
        ? []
        : cardsOfRun(
            targets.filter((card) => !this.liveSites.has(card.id)),
            slot,
            Math.min(fetchBudget, UPTIME_FETCHES_PER_RUN),
          );
    const answers = await Promise.all(
      fetched.map(async (card) => {
        const ups = await Promise.all(
          card.addresses.map(async (address) => {
            // A timer that ends with the fetch; AbortSignal.timeout keeps the run open for the full 10 seconds.
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 10_000);
            const response = await fetch(`https://${address}/`, { redirect: "manual", signal: abort.signal })
              .catch(() => null)
              .finally(() => clearTimeout(timer));
            // The status is all that counts; an unread body would hold one of the 6 open connections.
            await response?.body?.cancel();
            return probeUp(response?.status ?? null);
          }),
        );
        return { card: card.id, up: ups.every(Boolean), fetches: card.addresses.length };
      }),
    );
    for (const { card, up } of answers) probes.set(card, { up, failingFor: FAILING_FOR_MS });
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const [card, probe] of probes) {
        const before = this.uptime.get(card) ?? UP;
        const after = nextUptime(before, probe.up, now, probe.failingFor);
        if (after === before) continue;
        if (stored(after)) {
          this.uptime.set(card, after);
          this.sql(
            "INSERT OR REPLACE INTO uptime (card_id, up, failing_since, since) VALUES (?, ?, ?, ?)",
            card,
            after.up ? 1 : 0,
            after.failingSince,
            after.since,
          );
        } else {
          this.uptime.delete(card);
          this.sql("DELETE FROM uptime WHERE card_id = ?", card);
        }
        if (before.up === after.up) continue;
        changed = true;
        this.sql(
          "INSERT OR REPLACE INTO uptime_changes (card_id, at, up) VALUES (?, ?, ?)",
          card,
          now,
          after.up ? 1 : 0,
        );
      }
    });
    return { fetches: answers.reduce((total, answer) => total + answer.fetches, 0), changed };
  }

  /** K-1126: the changes of a card in the last 24 hours, and the one before them, for the strip in its panel. */
  private uptimeChanges(card: string): ReadonlyArray<UptimeChange> {
    const since = Date.now() - 24 * 60 * 60_000;
    return this.sql<{ at: number; up: number }>(
      `SELECT at, up FROM uptime_changes WHERE card_id = ? AND at >= coalesce(
         (SELECT MAX(at) FROM uptime_changes WHERE card_id = ? AND at < ?), ?) ORDER BY at`,
      card,
      card,
      since,
      since,
    ).map((row) => ({ at: row.at, up: row.up === 1 }));
  }

  /** K-1903: opens or changes the notification of a source and key. Writes only when it changes (K-1302). */
  private notify(input: NotificationInput, now = Date.now()) {
    const id = `${input.source}\u0000${input.key}`;
    const before = this.openNotifications.get(id);
    const value = { ...input, title: clip(input.title, TITLE_MAX), text: clip(input.text, TEXT_MAX) };
    if (before && !changed(before, value)) return;
    // K-1905: a dismissed episode stays closed; only a new one opens a notification again.
    if (!before && this.dismissed.get(id) === value.episode) return;
    const columns = [
      value.card,
      JSON.stringify(value.recipients),
      value.level,
      value.priority,
      value.title,
      value.text,
      JSON.stringify(value.actions),
    ] as const;
    if (before) {
      this.sql(
        `UPDATE notifications SET card_id = ?, recipients = ?, level = ?, priority = ?, title = ?, text = ?, actions = ?,
         state = 'open', episode = ? WHERE id = ?`,
        ...columns,
        value.episode,
        before.id,
      );
      this.openNotifications.set(id, { ...before, ...value, state: "open" });
      return;
    }
    const [row] = this.sql<{ id: number }>(
      `INSERT INTO notifications (source, key, card_id, recipients, level, priority, title, text, actions, state, opened_at,
       episode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
      value.source,
      value.key,
      ...columns,
      now,
      value.episode,
    );
    if (!row) throw new Error("kitshn wrote a notification and got no id back.");
    const opened: Notification = {
      ...value,
      id: row.id,
      state: "open",
      openedAt: now,
      closedAt: null,
      snoozedUntil: null,
    };
    this.openNotifications.set(id, opened);
    this.queuePush(opened);
  }

  /** K-1903: sets the state of an open notification; any state but "open" closes it for every recipient. */
  private setNotificationState(source: string, key: string, state: string, now = Date.now()) {
    const id = `${source}\u0000${key}`;
    const before = this.openNotifications.get(id);
    if (!before || before.state === state) return;
    if (state === "open") throw new Error("A notification opens through notify, not through its state.");
    this.sql("UPDATE notifications SET state = ?, closed_at = ? WHERE id = ?", state, now, before.id);
    this.openNotifications.delete(id);
    if (state === "dismissed") this.dismissed.set(id, before.episode);
    // K-1907: a high priority notification also tells its recipients about its answer; dismiss is the owner's own.
    if (before.priority === "high" && state !== "dismissed")
      this.queuePush({ ...before, state, closedAt: now });
  }

  /**
   * K-406: a step of the alarm that throws logs, opens an `alarm` notification (K-1910) and waits for its retry
   * time, and the next steps still run. Until then the step is skipped. `onError` is what a failed step counts,
   * such as its whole budget; `skipped` is what a skipped one counts.
   */
  private async alarmStep<T>(
    step: AlarmStep,
    onError: T,
    run: () => T | Promise<T>,
    skipped: T = onError,
  ): Promise<T> {
    const failing = this.alarmSteps().get(step);
    if (failing && failing.retryAt > Date.now()) return skipped;
    try {
      const result = await run();
      if (failing) this.setAlarmStep(step, null);
      this.setNotificationState("alarm", step, "closed");
      return result;
    } catch (error) {
      const now = Date.now();
      console.error(`kitshn alarm step "${step}" failed: ${String(error)}`);
      const tries = (failing?.tries ?? 0) + 1;
      const retryAt = now + alarmStepBackoff(tries);
      this.setAlarmStep(step, { since: failing?.since ?? now, tries, retryAt });
      const at = new Date(retryAt).toISOString().slice(11, 16);
      this.notify({
        source: "alarm",
        key: step,
        episode: String(failing?.since ?? now),
        card: null,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: clip(`kitshn could not run the alarm step "${step}"`, TITLE_MAX),
        text: clip(`${String(error)} kitshn tries again at ${at} UTC.`, TEXT_MAX),
        actions: [],
      });
      return onError;
    }
  }

  /** K-406: whether a step that failed waits for its retry time, so its pending work does not wake the alarm. */
  private alarmStepWaits(step: AlarmStep, now: number) {
    return (this.alarmSteps().get(step)?.retryAt ?? 0) > now;
  }

  /** K-406: the failing steps, kept in `meta` so a wake keeps their backoff and their episode (K-1910). */
  private alarmStepsCache: Map<AlarmStep, AlarmStepFailure> | null = null;
  private alarmSteps(): ReadonlyMap<AlarmStep, AlarmStepFailure> {
    this.alarmStepsCache ??= new Map(
      Object.entries(JSON.parse(this.meta("alarm_steps") ?? "{}") as Record<string, AlarmStepFailure>).filter(
        (entry): entry is [AlarmStep, AlarmStepFailure] =>
          (ALARM_STEPS as ReadonlyArray<string>).includes(entry[0]),
      ),
    );
    return this.alarmStepsCache;
  }

  private setAlarmStep(step: AlarmStep, failure: AlarmStepFailure | null) {
    const steps = new Map(this.alarmSteps());
    if (failure) steps.set(step, failure);
    else steps.delete(step);
    this.alarmStepsCache = steps;
    this.setMeta("alarm_steps", JSON.stringify(Object.fromEntries(steps)));
  }

  /** The open `alarm` notifications, so the maps hear of a step that failed or works again. */
  private failedAlarmSteps() {
    return [...this.openNotifications.values()]
      .filter((notification) => notification.source === "alarm")
      .map((notification) => `${notification.key}: ${notification.text}`)
      .join("\n");
  }

  /** K-1132: the card whose Access application has this audience tag. */
  private cardOfAudience(kid: string): Resource | null {
    if (kid === "") return null;
    for (const row of this.access.values())
      if (row.key.startsWith("app:") && row.aud === kid)
        return this.state.resources.get(row.key.split(":")[1] ?? "") ?? null;
    return null;
  }

  /**
   * K-1132: the card and the wanted address of a refusal. A refusal on `/ask` itself (a stranger, K-111) carries the
   * refusal of the card inside its own `original_url`.
   */
  private refusedAt(params: URLSearchParams): { readonly card: string | null; readonly original: string } {
    let kid = params.get("kid") ?? "";
    let original = params.get("original_url") ?? "";
    const askAud = this.access.get(ASK_APP)?.aud;
    if (askAud && kid === askAud) {
      const inner = URL.parse(`https://${original}`)?.searchParams;
      kid = inner?.get("kid") ?? "";
      original = inner?.get("original_url") ?? "";
    }
    return { card: this.cardOfAudience(kid)?.name ?? null, original };
  }

  /**
   * K-1132: `/ask`, behind its own application, which only people whom a circle lets in pass. GET shows the refusal with
   * "Ask for access" and the email of the login; POST from that page opens the ask.
   */
  private async askForAccess(request: Request) {
    const url = new URL(request.url);
    const zone = this.env.KITSHN_ZONE;
    const refused = (status: number, text: string) =>
      new Response(askPage({ step: "refused", text, zone }), { status, headers: helpPageHeaders });
    const aud = this.access.get(ASK_APP)?.aud;
    if (!aud) return refused(503, "This kitshn takes no asks yet. Ask the person who sent you the link.");
    if (request.method !== "GET" && request.method !== "POST") return refused(405, "Open the link again.");
    const caller = await approverOf(request, this.env, aud, false, Date.now());
    if (typeof caller === "string" || caller.visitor.email === null)
      return refused(401, "Log in with your email first, then ask again.");
    if (request.method === "POST" && request.headers.get("origin") !== `https://${url.host}`)
      return refused(403, "Send the ask from its own page.");
    const kid =
      request.method === "POST"
        ? String((await request.formData().catch(() => null))?.get("kid") ?? "")
        : (url.searchParams.get("kid") ?? "");
    const card = this.cardOfAudience(kid);
    if (!card) return refused(404, "kitshn does not know this place. Ask the person who sent you the link.");
    if (request.method === "POST") return this.accessAsk(card, caller.visitor.email);
    return new Response(
      askPage({
        step: "confirm",
        zone,
        card: card.name,
        kid,
        email: caller.visitor.email,
        wanted: wantedAddress(url.searchParams.get("original_url") ?? "", zone),
        host: this.env.KITSHN_HOST,
        teamDomain: this.env.ACCESS_TEAM_DOMAIN,
      }),
      { status: 403, headers: helpPageHeaders },
    );
  }

  /**
   * K-1132: a refused visitor asks the owner for access to one card. It opens one Inbox item, with the email that the
   * login proved; the same ask while one is open, or past the limit of open asks, opens nothing.
   */
  private accessAsk(card: Resource, email: string) {
    const zone = this.env.KITSHN_ZONE;
    const answer = (status: number, text: string) =>
      new Response(askPage({ step: status === 200 ? "done" : "refused", text, zone }), {
        status,
        headers: helpPageHeaders,
      });
    const key = `${card.id}:${email.toLowerCase()}`;
    if (this.openNotifications.has(`access\u0000${key}`))
      return answer(200, `You asked for ${card.name} already. The owner sees it in the Inbox.`);
    const open = [...this.openNotifications.values()].filter((each) => each.source === "access").length;
    if (open >= ACCESS_ASKS_OPEN)
      return answer(
        429,
        "The owner has many open asks now. Try again later, or ask the person who sent you the link.",
      );
    const now = Date.now();
    this.notify({
      source: "access",
      key,
      // A dismissed ask opens again only on another day.
      episode: String(Math.floor(now / DAY)),
      card: card.id,
      recipients: { _tag: "owner" },
      level: "warn",
      priority: "normal",
      title: clip(`${email} asks for access to ${card.name}`, TITLE_MAX),
      text: clip(
        `No circle of ${card.name} holds this email, so Access refused it. To let them in, add the email to a circle that shares ${card.name}.`,
        TEXT_MAX,
      ),
      actions: [{ id: "show", label: "Show card", kind: "link", path: `#map/${card.id}` }],
    });
    this.broadcast();
    return answer(200, `The owner sees your ask for ${card.name} in the Inbox.`);
  }

  /** K-1904: the sources that kitshn derives from its own state. */
  /** K-1910: limits at 80% or more of the last hourly read, and machines that stay offline 15 minutes. */
  private reconcileOwnSources(now: number) {
    const full = new Map<string, UsageRow>();
    for (const row of this.limitsUsage?.rows ?? []) {
      const level = usageLevel(row);
      if (level === "warn" || level === "full") full.set(row.label, row);
    }
    for (const [label, row] of full)
      this.notify({
        source: "limits",
        key: label,
        episode: usageLevel(row),
        card: null,
        recipients: { _tag: "owner" },
        level: usageLevel(row) === "full" ? "error" : "warn",
        priority: "normal",
        title: clip(
          `${label} at ${Math.round(((row.used ?? 0) / row.limit) * 100)}% of the free plan`,
          TITLE_MAX,
        ),
        text: "The Usage view shows the value, its limit and when it resets.",
        actions: [{ id: "show", label: "Show usage", kind: "link", path: "#usage" }],
      });
    // Only a value that kitshn read again and found under 80% closes; an unknown value keeps what is open.
    if (this.limitsUsage)
      for (const notification of this.openNotifications.values())
        if (notification.source === "limits" && !full.has(notification.key)) {
          const row = this.limitsUsage.rows.find((each) => each.label === notification.key);
          if (row && row.used !== null) this.setNotificationState("limits", notification.key, "closed");
        }
    const offline = new Map(this.offlineSince().filter(([, since]) => since + MACHINE_OFFLINE_MS <= now));
    for (const [id, since] of offline) {
      const machine = this.state.machines.get(id);
      if (!machine) continue;
      this.notify({
        source: "machine",
        key: id,
        episode: String(since),
        // The machine card on purpose: mute and "Show machine" work by card, and a machine is a card on the map.
        card: id,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: clip(`${machine.name} is offline`, TITLE_MAX),
        text: `No connection since ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
        actions: [{ id: "show", label: "Show machine", kind: "link", path: `#map/${id}` }],
      });
    }
    for (const notification of this.openNotifications.values())
      if (notification.source === "machine" && !offline.has(notification.key)) {
        this.setNotificationState("machine", notification.key, "closed");
        this.offlineNotified.delete(notification.key);
      }
  }

  /** K-704: one `provider` notification per refused provider of the machine; it closes when a registration passes. */
  /** K-631: opens the notification of each check that failed twice in a row, and closes the rest of this machine. */
  private notifyHealth(machine: Machine, report: HealthReport) {
    const others = new Map(
      [...this.state.machines.values()].map((other) => [
        other.id,
        { name: other.name, online: this.openSocket(other.id) !== null },
      ]),
    );
    const keys = new Set<string>();
    for (const input of healthNotices(machine, report, others)) {
      keys.add(input.key);
      this.notify(input);
    }
    for (const notification of this.openNotifications.values())
      if (
        notification.source === "health" &&
        notification.key.startsWith(`${machine.id}:`) &&
        !keys.has(notification.key)
      )
        this.setNotificationState("health", notification.key, "closed");
  }

  private notifyRefusals(machine: Machine, refusals: ReadonlyArray<ProviderRefusal>) {
    const keys = new Set<string>();
    for (const refusal of refusals) {
      const key = `${machine.id}:${refusal.provider}`;
      keys.add(key);
      this.notify({
        source: "provider",
        key,
        episode: String(refusal.at),
        card: machine.id,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: `${machine.name} refused the provider ${refusal.provider}`,
        text: `Its cards do not update while this lasts. ${refusal.reason}`,
        actions: [{ id: "show", label: "Show machine", kind: "link", path: `#map/${machine.id}` }],
      });
    }
    for (const notification of this.openNotifications.values())
      if (
        notification.source === "provider" &&
        notification.key.startsWith(`${machine.id}:`) &&
        !keys.has(notification.key)
      )
        this.setNotificationState("provider", notification.key, "closed");
  }

  /**
   * K-704: a provider without a connection for `PROVIDER_OFFLINE_MS` opens a notification for its machine card, and it
   * closes when the provider registers again. Its key never starts with the machine id, so `notifyRefusals` keeps it.
   */
  private notifyOfflineProviders(machine: Machine, offline: ReadonlyArray<ProviderRefusal>, now: number) {
    const keys = new Set<string>();
    for (const entry of offline) {
      if (now - entry.at < PROVIDER_OFFLINE_MS) continue;
      const key = `offline:${machine.id}:${entry.provider}`;
      keys.add(key);
      this.notify({
        source: "provider",
        key,
        episode: String(entry.at),
        card: machine.id,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: `The provider ${entry.provider} of ${machine.name} is offline`,
        text: `Since ${new Date(entry.at).toISOString()}: ${entry.reason}. Its cards do not update until it registers again.`,
        actions: [{ id: "show", label: "Show machine", kind: "link", path: `#map/${machine.id}` }],
      });
    }
    for (const notification of this.openNotifications.values())
      if (
        notification.source === "provider" &&
        notification.key.startsWith(`offline:${machine.id}:`) &&
        !keys.has(notification.key)
      )
        this.setNotificationState("provider", notification.key, "closed");
  }

  /** K-704: the offline providers of every connected daemon, as the alarm sees them every few minutes. */
  private checkOfflineProviders(now: number) {
    for (const machine of this.state.machines.values()) {
      const socket = this.openSocket(machine.id);
      const attachment = socket ? attachmentOf(socket) : null;
      const offline = attachment?.kind === "machine" ? attachment.status?.offlineProviders : undefined;
      if (offline) this.notifyOfflineProviders(machine, offline, now);
    }
  }

  /** K-1908: the address that an app sends its notifications to. */
  private notifyUrl() {
    return `https://${this.env.KITSHN_HOST}/notify`;
  }

  /**
   * K-1908: a new notify token for a card, pending on the deploy or job `pending`. kitshn keeps only its SHA-256. The
   * app may use it at once, because it starts before its deploy reports back.
   */
  private mintNotifyToken(card: string, pending: string): string {
    const token = randomBytes(32).toString("base64url");
    this.sql(
      "INSERT INTO notify_tokens (hash, card_id, created_at, pending) VALUES (?, ?, ?, ?)",
      createHash("sha256").update(token).digest("hex"),
      card,
      Date.now(),
      pending,
    );
    return token;
  }

  /**
   * K-1908: the token of a deploy or job that went live turns live, and the newest NOTIFY_TOKENS_KEPT live ones per
   * card stay, so a rollback brings back a build whose token still works. A failure drops its token, so failed deploys
   * never push the live build's token out.
   */
  private settleNotifyToken(pending: string, ok: boolean) {
    if (!ok) {
      this.sql("DELETE FROM notify_tokens WHERE pending = ?", pending);
      return;
    }
    for (const { card_id } of this.sql<{ card_id: string }>(
      "UPDATE notify_tokens SET pending = NULL WHERE pending = ? RETURNING card_id",
      pending,
    ))
      this.sql(
        `DELETE FROM notify_tokens WHERE card_id = ? AND pending IS NULL AND hash NOT IN
         (SELECT hash FROM notify_tokens WHERE card_id = ? AND pending IS NULL ORDER BY created_at DESC LIMIT ?)`,
        card_id,
        card_id,
        NOTIFY_TOKENS_KEPT,
      );
  }

  /** K-1908: the hourly windows of app notifications, per card and for all cards together. Memory only. */
  private readonly appWindows = new Map<string, Array<number>>();
  private readonly appWindowAll: Array<number> = [];

  /** K-1908: `POST /notify` from an app; the Worker passes the token on, and only its hash finds the card. */
  private async appNotify(request: Request): Promise<Response> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const [row] =
      token === ""
        ? []
        : this.sql<{ card_id: string }>(
            "SELECT card_id FROM notify_tokens WHERE hash = ?",
            createHash("sha256").update(token).digest("hex"),
          );
    const card = row ? this.state.resources.get(row.card_id) : undefined;
    if (!card)
      return Response.json({ error: "kitshn knows no app with this notify token." }, { status: 401 });
    const body = await request.text();
    if (new TextEncoder().encode(body).length > NOTIFY_BODY_MAX)
      return Response.json({ error: `A notification is at most ${NOTIFY_BODY_MAX} bytes.` }, { status: 413 });
    const event = appEvent(parseJson(body));
    if (typeof event === "string") return Response.json({ error: event }, { status: 400 });
    const now = Date.now();
    const key = `${card.id}:${event.key}`;
    const window = this.appWindows.get(card.id) ?? [];
    this.appWindows.set(card.id, window);
    const refuse = (wait: number, limit: number, whose: string) =>
      Response.json(
        { error: `kitshn takes ${limit} app notifications an hour ${whose}; try again in ${wait} seconds.` },
        { status: 429, headers: { "retry-after": String(wait) } },
      );
    // A resolve counts against the card's window too, so a token cannot flood the maps with broadcasts.
    if (event.resolved) {
      const wait = takeSlot(window, now, NOTIFY_PER_CARD_HOUR);
      if (wait !== null) return refuse(wait, NOTIFY_PER_CARD_HOUR, "for one card");
      const open = this.openNotifications.has(`app\u0000${key}`);
      this.setNotificationState("app", key, "closed", now);
      if (open) this.broadcast();
      return Response.json({ ok: true });
    }
    // Both windows must have room; a refused call takes a slot of neither.
    const cardWait = takeSlot([...window], now, NOTIFY_PER_CARD_HOUR);
    if (cardWait !== null) return refuse(cardWait, NOTIFY_PER_CARD_HOUR, "for one card");
    const allWait = takeSlot([...this.appWindowAll], now, NOTIFY_ALL_HOUR);
    if (allWait !== null) return refuse(allWait, NOTIFY_ALL_HOUR, "for all apps together");
    takeSlot(window, now, NOTIFY_PER_CARD_HOUR);
    takeSlot(this.appWindowAll, now, NOTIFY_ALL_HOUR);
    this.notify(
      {
        source: "app",
        key,
        episode: String(now),
        card: card.id,
        recipients: { _tag: "owner" },
        level: event.level,
        priority: "normal",
        title: event.title,
        text: event.text,
        actions: [{ id: "show", label: "Show card", kind: "link", path: `#map/${card.id}` }],
      },
      now,
    );
    this.broadcast();
    return Response.json({ ok: true });
  }

  /** K-1910: the last use of the account that the hourly check read, kept in memory for the reconcile. */
  private limitsUsage: Usage | null = null;
  /** The next hourly limits check, read once per wake, as the backup time (K-1302). */
  private limitsAtMemory: number | null = null;
  private limitsCheckAt() {
    this.limitsAtMemory ??= Number(this.meta("limits_check_at") ?? 0);
    return this.limitsAtMemory;
  }

  /** K-1910: when the next machine reaches 15 minutes offline, or null. */
  private nextOfflineAt(now: number): number | null {
    const times = this.offlineSince()
      .map(([, since]) => since + MACHINE_OFFLINE_MS)
      .filter((at) => at > now);
    return times.length === 0 ? null : Math.min(...times);
  }

  /** The machines that are offline, with the time each one was last seen. */
  private offlineSince(): Array<[string, number]> {
    return [...this.state.machines.keys()].flatMap((id) => {
      const presence = this.presence.get(id);
      return presence && !presence.online ? [[id, presence.lastSeen] as [string, number]] : [];
    });
  }

  /** K-1910: true once per machine when it reaches 15 minutes offline, in memory; a wake checks again. */
  private offlineNotified = new Set<string>();
  private offlineChanged(now: number) {
    const due = this.offlineSince().filter(
      ([id, since]) => since + MACHINE_OFFLINE_MS <= now && !this.offlineNotified.has(id),
    );
    for (const [id] of due) this.offlineNotified.add(id);
    return due.length > 0;
  }

  private reconcileNotifications(repos: ReadonlyArray<RepoView>) {
    this.reconcileOwnSources(Date.now());
    // K-819: a repo that waits for Allow, with Allow and Block on the notification itself.
    const waiting = new Set<string>();
    for (const repo of repos) {
      if (repo.state !== "waiting" || repo.goneOnGitHub) continue;
      waiting.add(repo.repoId);
      this.notify({
        source: "repo",
        key: repo.repoId,
        episode: String(repo.firstSeen),
        card: null,
        recipients: { _tag: "owner" },
        level: "warn",
        priority: "normal",
        title: clip(`${repo.name} waits for Allow`, TITLE_MAX),
        text: clip(
          `${repo.branch ? `A push to ${repo.branch} waits. ` : ""}Allow lets ${repo.name} deploy; Block stops its deploys (K-819).`,
          TEXT_MAX,
        ),
        actions: [
          { id: "allow", label: "Allow", kind: "run" },
          { id: "block", label: "Block", kind: "run" },
        ],
      });
    }
    for (const notification of this.openNotifications.values())
      if (notification.source === "repo" && !waiting.has(notification.key))
        this.setNotificationState("repo", notification.key, "closed");
    const notes = new Map(
      this.deploys()
        .notes.filter((note) => this.state.resources.has(note.resource_id))
        .map((note) => [note.resource_id, note]),
    );
    for (const [card, note] of notes) {
      const resource = this.state.resources.get(card);
      if (!resource) continue;
      this.notify({
        source: "deploy",
        key: card,
        episode: note.id,
        card,
        recipients: { _tag: "owner" },
        level: note.state === "failed" ? "error" : "warn",
        priority: "normal",
        title:
          note.state === "failed"
            ? `Deploy of ${resource.name} failed`
            : `Deploy of ${resource.name} did not run`,
        text: note.reason ?? "The deploy failed; its workflow run has the log.",
        actions: [{ id: "show", label: "Show card", kind: "link", path: `#map/${card}` }],
      });
    }
    for (const notification of this.openNotifications.values())
      if (notification.source === "deploy" && !notes.has(notification.key))
        this.setNotificationState("deploy", notification.key, "closed");
    // K-1904: a card that is down (K-1125); the uptime rows exist only for cards that are down or failing.
    const down = new Set<string>();
    for (const card of this.uptimeTargets()) {
      const uptime = this.uptime.get(card.id);
      if (!uptime || uptime.up) continue;
      down.add(card.id);
      this.notify({
        source: "uptime",
        key: card.id,
        episode: String(uptime.since),
        card: card.id,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: `${card.name} is down`,
        text: `kitshn gets no good answer from ${card.addresses.join(", ")}.`,
        actions: [{ id: "show", label: "Show card", kind: "link", path: `#map/${card.id}` }],
      });
    }
    for (const notification of this.openNotifications.values())
      if (notification.source === "uptime" && !down.has(notification.key))
        this.setNotificationState("uptime", notification.key, "closed");
    // K-1722: each open ask is a notification for the people of its approver circle; an answer closes it for all.
    const asks = new Set<string>();
    for (const proposal of this.openProposals()) {
      asks.add(proposal.id);
      const kind = this.state.circles.get(proposal.circleId)?.needsPasskey ? "passkey" : "login";
      this.notify({
        source: "kitshn.ask",
        key: proposal.id,
        episode: proposal.id,
        card: null,
        recipients: { _tag: "approvers", circle: proposal.circleId },
        level: "warn",
        priority: "high",
        title: clip(`${proposal.machineName} asks: ${MACHINE_RIGHT_NAMES[proposal.right]}`, TITLE_MAX),
        text: clip(`${proposal.shown}${proposal.reason ? ` · ${proposal.reason}` : ""}`, TEXT_MAX),
        actions: [
          {
            id: "approve",
            label: "Approve",
            kind: "link",
            path: `/api/approve/${kind}/start?approve=${encodeURIComponent(proposal.id)}&hash=${proposal.shownHash}`,
          },
          { id: "deny", label: "Deny", kind: "run" },
        ],
      });
    }
    for (const notification of this.openNotifications.values())
      if (notification.source === "kitshn.ask" && !asks.has(notification.key))
        this.setNotificationState("kitshn.ask", notification.key, "closed");
  }

  /** K-1902: the owner gets every notification; a circle adds its people. */
  private receives(visitor: Visitor, notification: Notification) {
    const now = Date.now();
    const member = (id: string) => {
      const circle = this.state.circles.get(id);
      return (
        circle !== undefined &&
        (circle.endsAt === null || circle.endsAt > now) &&
        circleMatches(circle, visitor, this.state.machines)
      );
    };
    const recipients = notification.recipients;
    if (recipients._tag === "approvers") return member(recipients.circle);
    return member(OWNER_CIRCLE_ID) || (recipients._tag === "circle" && member(recipients.circle));
  }

  /** K-1902: a member of the Owner circle. */
  private isOwner(visitor: Visitor) {
    const owner = this.state.circles.get(OWNER_CIRCLE_ID);
    return owner !== undefined && circleMatches(owner, visitor, this.state.machines);
  }

  /** K-1905: the Notifications view and its ways out, for the owner only in this version (K-1902). */
  private async notificationRequest(path: string, request: Request, caller: Caller): Promise<Response> {
    const now = Date.now();
    if (!this.isOwner(caller.visitor))
      return Response.json(
        { error: "Notifications are for the Owner circle in this version (K-1902)." },
        { status: 403 },
      );
    const body = request.method === "POST" ? ((await request.json().catch(() => null)) as unknown) : null;
    if (path === "/api/notifications" && request.method === "GET") {
      const rows = this.sql<NotificationRow>(
        "SELECT * FROM notifications ORDER BY id DESC LIMIT ?",
        NOTIFICATIONS_MAX,
      );
      return Response.json({
        notifications: rows
          .map(notificationOf)
          .filter((notification) => this.receives(caller.visitor, notification)),
        mutes: this.mutes.filter((mute) => mute.until === null || mute.until > now),
      });
    }
    if (
      (path === "/api/notifications/mute" || path === "/api/notifications/unmute") &&
      request.method === "POST"
    ) {
      if (!isRecord(body) || typeof body["card"] !== "string" || typeof body["source"] !== "string")
        return Response.json({ error: "Name the card and the source." }, { status: 400 });
      const card = body["card"];
      const source = NOTIFICATION_SOURCES.find((each) => each === body["source"]);
      if (path === "/api/notifications/unmute") {
        this.sql("DELETE FROM notification_mutes WHERE card_id = ? AND source = ?", card, body["source"]);
      } else {
        if (!this.state.resources.has(card))
          return Response.json({ error: `kitshn has no card ${card}.` }, { status: 400 });
        if (source === undefined)
          return Response.json(
            { error: `A mute names one of the sources ${NOTIFICATION_SOURCES.join(", ")}.` },
            { status: 400 },
          );
        const until = body["until"];
        if (until !== null && (typeof until !== "number" || until <= now))
          return Response.json({ error: "A mute ends at a future time, or never (null)." }, { status: 400 });
        this.sql(
          "INSERT OR REPLACE INTO notification_mutes (card_id, source, until) VALUES (?, ?, ?)",
          card,
          source,
          until,
        );
      }
      this.muteCache = null;
      this.broadcast();
      void this.scheduleAlarm();
      return Response.json({ ok: true });
    }
    const [id = "", verb = "", action = ""] = path.slice("/api/notifications/".length).split("/");
    const notification = [...this.openNotifications.values()].find((each) => String(each.id) === id);
    if (!notification || !this.receives(caller.visitor, notification))
      return Response.json({ error: "No such open notification for you." }, { status: 404 });
    if (verb === "snooze" && request.method === "POST") {
      const until = isRecord(body) ? body["until"] : undefined;
      if (until !== null && (typeof until !== "number" || until <= now))
        return Response.json({ error: "A snooze ends at a future time, or now (null)." }, { status: 400 });
      this.sql("UPDATE notifications SET snoozed_until = ? WHERE id = ?", until, notification.id);
      this.openNotifications.set(`${notification.source}\u0000${notification.key}`, {
        ...notification,
        snoozedUntil: until,
      });
      this.broadcast();
      void this.scheduleAlarm();
      return Response.json({ ok: true });
    }
    if (verb === "dismiss" && request.method === "POST") {
      this.setNotificationState(notification.source, notification.key, "dismissed", now);
      this.broadcast();
      return Response.json({ ok: true });
    }
    if (verb === "actions" && request.method === "POST") {
      const known = notification.actions.find((each) => each.id === action);
      const handler = this.actionHandlers.get(notification.source);
      if (!known || known.kind !== "run" || !handler)
        return Response.json({ error: `The notification has no action ${action} to run.` }, { status: 400 });
      const error = await handler(notification, action, caller);
      this.broadcast();
      return error === null ? Response.json({ ok: true }) : Response.json({ error }, { status: 409 });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  /** K-1905: the next end of a mute or a snooze, so the alarm can bring the bell count up to date then. */
  private nextBellEnd(now: number): number | null {
    const ends = [
      ...this.mutes.map((mute) => mute.until),
      ...[...this.openNotifications.values()].map((notification) => notification.snoozedUntil),
    ].filter((end): end is number => end !== null && end > now);
    return ends.length === 0 ? null : Math.min(...ends);
  }

  /** K-1905: true when a mute or a snooze ended since the last look, so the bell count changed. */
  private bellEnded(now: number): boolean {
    const since = this.bellCheckedAt;
    this.bellCheckedAt = now;
    return [
      ...this.mutes.map((mute) => mute.until),
      ...[...this.openNotifications.values()].map((notification) => notification.snoozedUntil),
    ].some((end) => end !== null && end > since && end <= now);
  }

  /** K-1907: the VAPID key, made on first use. The private half never leaves `meta` (no snapshot, no export). */
  private vapid: Promise<VapidKey> | null = null;
  private vapidKey(): Promise<VapidKey> {
    this.vapid ??= (async () => {
      let jwk = this.meta(VAPID_META);
      if (jwk === null) {
        jwk = await generateVapidJwk();
        this.setMeta(VAPID_META, jwk);
      }
      const key = await vapidKey(jwk);
      if (!key) throw new Error("kitshn has a push key in meta that it cannot read.");
      return key;
    })();
    return this.vapid;
  }

  /**
   * K-1907: pushes wait until the change commits. Each entry is one notification for every device (`device` null),
   * or one send that waits or failed once. Only the alarm sends, once at its end, so one invocation sends at most
   * PUSH_SENDS_PER_RUN (K-406). Known limit: the queue lives in memory, so a wake drops what waits; the alarm runs
   * within a second while it holds anything. Revisit if pushes get lost.
   */
  private pushQueue: Array<{ notification: Notification; device: number | null; tries: number }> = [];
  private queuePush(notification: Notification) {
    this.pushQueue.push({ notification, device: null, tries: 0 });
    if (this.pushQueue.length === 1) void this.scheduleAlarm();
  }

  /** K-1907: sends at most PUSH_SENDS_PER_RUN pushes; the rest, and a send that failed once, wait for the alarm. */
  private async flushPushes() {
    const queue = this.pushQueue;
    this.pushQueue = [];
    if (queue.length === 0) return;
    const devices = new Map(
      this.sql<PushRow>("SELECT * FROM push_subscriptions").map((row) => [row.id, row]),
    );
    const now = Date.now();
    const sends = queue.flatMap(({ notification, device, tries }) =>
      // A mute holds for every push of its card and source, also a state change of priority high.
      (notification.state === "open" &&
        notification.snoozedUntil !== null &&
        notification.snoozedUntil > now) ||
      muted(notification, this.mutes, now)
        ? []
        : [...devices.values()]
            .filter(
              (row) =>
                (device === null || row.id === device) &&
                this.receives({ email: row.email, clientId: null, ip: null }, notification) &&
                deviceWants(pushDeviceOf(row), notification, now),
            )
            .map((row) => ({ row, notification, tries })),
    );
    const batch = sends.slice(0, PUSH_SENDS_PER_RUN);
    for (const { row, notification, tries } of sends.slice(PUSH_SENDS_PER_RUN))
      this.pushQueue.push({ notification, device: row.id, tries });
    if (batch.length === 0) return;
    const key = await this.vapidKey();
    const results = await Promise.all(
      batch.map(async ({ row, notification, tries }) => {
        const card =
          notification.card === null ? null : (this.state.resources.get(notification.card)?.name ?? null);
        try {
          const result = await sendPush(
            { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
            pushMessage(notification, card),
            key,
            `https://${this.env.KITSHN_HOST}`,
            {
              urgency: notification.level === "error" || notification.priority === "high" ? "high" : "normal",
              topic: await pushTopic(`${notification.source}:${notification.key}`),
            },
          );
          return { row, notification, tries, result };
        } catch (error) {
          console.warn(`kitshn could not push to device ${row.id}: ${String(error).slice(0, 200)}`);
          return { row, notification, tries, result: "failed" as const };
        }
      }),
    );
    for (const { row, notification, tries, result } of results) {
      if (result === "gone") this.sql("DELETE FROM push_subscriptions WHERE id = ?", row.id);
      else if (result === "refused")
        console.warn(
          `The push service refused the key of kitshn for device ${row.id} (401 or 403); Rotate push key.`,
        );
      else if (result === "delivered")
        this.sql("UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?", now, row.id);
      // One retry on the next alarm, then kitshn drops the push; the warning above names the device.
      else if (tries === 0) this.pushQueue.push({ notification, device: row.id, tries: 1 });
    }
    if (this.pushQueue.length > 0) await this.scheduleAlarm();
  }

  /** K-1907: the devices of push, for the Owner circle only in this version (K-1902). */
  private async pushRequest(path: string, request: Request, caller: Caller): Promise<Response> {
    if (!this.isOwner(caller.visitor))
      return Response.json(
        { error: "Push is for the Owner circle in this version (K-1902)." },
        { status: 403 },
      );
    const email = caller.visitor.email;
    if (email === null)
      return Response.json({ error: "Push needs a person, not a service token." }, { status: 403 });
    const now = Date.now();
    const body = request.method === "POST" ? ((await request.json().catch(() => null)) as unknown) : null;
    // The endpoint of this browser goes in the body: a query string would leave it in request logs.
    if (path === "/api/push/devices" && request.method === "POST") {
      const mine = isRecord(body) && typeof body["mine"] === "string" ? body["mine"] : null;
      const rows = this.sql<PushRow>("SELECT * FROM push_subscriptions ORDER BY created_at");
      return Response.json({
        publicKey: (await this.vapidKey()).publicKey,
        devices: rows.map((row) => ({ ...pushDeviceOf(row), mine: row.endpoint === mine })),
        testAt: Number(this.meta("push_test_at") ?? 0),
      });
    }
    if (path === "/api/push/subscribe" && request.method === "POST") {
      const input = pushInput(body);
      if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
      this.sql(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, email, label, levels, quiet_start, quiet_end, time_zone,
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh,
         auth = excluded.auth, email = excluded.email, label = excluded.label, levels = excluded.levels,
         quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, time_zone = excluded.time_zone`,
        input.endpoint,
        input.p256dh,
        input.auth,
        email,
        input.label,
        JSON.stringify(input.levels),
        input.quiet?.start ?? null,
        input.quiet?.end ?? null,
        input.quiet?.timeZone ?? null,
        now,
      );
      return Response.json({ ok: true });
    }
    if (path === "/api/push/unsubscribe" && request.method === "POST") {
      const endpoint = isRecord(body) ? body["endpoint"] : undefined;
      const id = isRecord(body) ? body["id"] : undefined;
      if (typeof endpoint === "string")
        this.sql("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
      else if (typeof id === "number") this.sql("DELETE FROM push_subscriptions WHERE id = ?", id);
      else return Response.json({ error: "Name the device by its endpoint or its id." }, { status: 400 });
      return Response.json({ ok: true });
    }
    if (path === "/api/push/test" && request.method === "POST") {
      const last = Number(this.meta("push_test_at") ?? 0);
      if (now - last < PUSH_TEST_MS)
        return Response.json({ error: "One test a minute; try again shortly." }, { status: 429 });
      this.setMeta("push_test_at", String(now));
      this.queuePush({
        id: 0,
        source: "test",
        key: String(now),
        episode: String(now),
        card: null,
        recipients: { _tag: "owner" },
        level: "error",
        priority: "normal",
        title: "kitshn test push",
        text: "",
        actions: [],
        state: "open",
        openedAt: now,
        closedAt: null,
        snoozedUntil: null,
      });
      return Response.json({ ok: true });
    }
    if (path === "/api/push/rotate" && request.method === "POST") {
      this.ctx.storage.transactionSync(() => {
        this.sql("DELETE FROM meta WHERE key = ?", VAPID_META);
        this.sql("DELETE FROM push_subscriptions");
      });
      this.vapid = null;
      this.recordRevision(caller.actor, "Rotate push key: every browser subscribes again");
      return Response.json({ publicKey: (await this.vapidKey()).publicKey });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  override async alarm() {
    const now = Date.now();
    const failedBefore = this.failedAlarmSteps();
    await this.finishPendingRestore().catch((error: unknown) =>
      console.error(`kitshn could not finish a restore to a time: ${String(error)}`),
    );
    await this.alarmStep("liveness", undefined, () => this.checkLiveness(now));
    // The alarm runs every 2 minutes while a daemon is connected, so it tells the maps only about real changes.
    let changed = (await this.alarmStep("jobs", 0, () => this.expireJobs(now))) > 0;
    // K-627: a busy machine whose wait reached the cap gets its update now.
    if (Object.values(this.rollout().busySince ?? {}).some((since) => since + BUSY_CAP_MS <= now))
      this.autoUpdate();
    if ((await this.alarmStep("rollbacks", 0, () => this.settleRollbacks())) > 0) changed = true;
    await this.alarmStep("proposals", undefined, () => this.expireProposals(now));
    await this.alarmStep("provider offline", undefined, () => this.checkOfflineProviders(now));
    const before = JSON.stringify(accessStates(this.desired(now), this.access));
    await this.alarmStep("share ends", undefined, () => this.endShares(now));
    if (await this.alarmStep("doors", false, () => this.closeLostDoors(now))) changed = true;
    await this.alarmStep("open games", undefined, () => this.syncOpenGames(now));
    // A daily run that threw or waits for its retry is no daily run, so the compare below waits with it.
    const daily =
      this.dailyAt() <= now &&
      (await this.alarmStep("daily", false, () => {
        this.daily(now);
        return true;
      }));
    // K-1126: the uptime fetches count against the 40 calls of this run (K-406). The daily run spends 40 already,
    // so it fetches nothing and keeps 10 subrequests spare.
    const uptimeBudget = daily ? 0 : UPTIME_FETCHES_PER_RUN;
    const uptime = await this.alarmStep(
      "uptime",
      { fetches: uptimeBudget, changed: false },
      () => this.checkUptime(now, uptimeBudget),
      { fetches: 0, changed: false },
    );
    if (uptime.changed) changed = true;
    if (await this.alarmStep("bell", false, () => this.bellEnded(now))) changed = true;
    // K-1910: the use of the account once an hour, never in the daily run; the next reconcile notifies.
    if (!daily && this.env.CLOUDFLARE_API_TOKEN && this.limitsCheckAt() <= now) {
      this.limitsAtMemory = now + HOUR_MS;
      this.setMeta("limits_check_at", String(this.limitsAtMemory));
      this.limitsUsage = await readUsage(
        this.env.CLOUDFLARE_API_TOKEN,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        zonesOrMain(this.env),
        now,
      ).catch((error: unknown) => {
        console.warn(`kitshn could not read the use of the account: ${String(error)}`);
        return this.limitsUsage;
      });
      changed = true;
    }
    // K-1910: a machine that reached 15 minutes offline since the last run.
    if (await this.alarmStep("offline", false, () => this.offlineChanged(now))) changed = true;
    // K-1817: the nightly backups run at 03:00 UTC, a quiet hour, not with the daily run at midnight.
    if (this.backupAt() <= now) {
      this.backupAtMemory = nextBackupAt(now);
      this.setMeta("backup_at", String(this.backupAtMemory));
      await this.dailyBackups(now).catch((error: unknown) =>
        console.error(`kitshn could not run the daily backups: ${String(error)}`),
      );
      // The backups queue and send jobs, so the maps get the new counts (K-515).
      changed = true;
    }
    const api = this.api();
    if (api) {
      const desired = this.desired(now);
      // K-406: the daily compare spends part of the 40 calls of this run.
      let spent = uptime.fetches;
      if (daily) {
        try {
          this.accessWarnings = await verifyAccess(
            desired,
            this.accessStore(),
            api,
            this.env.CLOUDFLARE_ACCOUNT_ID,
          );
          spent += 2;
          spent += await verifyPasskeys(this.accessStore(), api, this.env.CLOUDFLARE_ACCOUNT_ID, 10);
          this.setMeta("access_warnings", JSON.stringify(this.accessWarnings));
        } catch (error) {
          console.warn(`kitshn could not compare Access with the shares: ${String(error)}`);
          spent += 12;
        }
      }
      spent += await this.alarmStep("audiences", 1, () => this.fillAudiences(api, now), 0);
      // Removals first: ingress and DNS go before an Access application does. Additions wait for the next
      // run, because ingress and DNS need the application that the Access sync makes (K-410).
      spent += await this.alarmStep("foreign paths", 1, () => this.refreshForeignPaths(api, now), 0);
      await this.alarmStep("tunnels", undefined, () => this.syncTunnels(api, 6));
      spent += await this.alarmStep("site checks", 6, () => this.checkSites(api, 6), 0);
      await this.alarmStep("DNS", undefined, () => this.syncDns(api, 5));
      spent += await this.alarmStep("game DNS", 4, () => this.syncGameDns(api, 4), 0);
      await this.alarmStep("routes", undefined, () => this.syncRoutes(api, 5));
      // K-1124: after the tunnel and DNS steps, so an old Compose address has lost its record. The daily run spends
      // its calls on the compare; redirectWork asks for the next run at once.
      if (!daily)
        try {
          spent += await this.syncRedirects(api, 5);
        } catch (error) {
          console.warn(`kitshn could not update the redirect Worker: ${String(error)}`);
          this.setMeta("redirects_retry_at", String(Date.now() + RETRY_MS));
          this.setMeta("redirects_wait", this.redirectMap());
          spent += 5;
        }
      // K-113: take an unwanted enrollment policy off the App Launcher before the sync deletes it.
      spent += await this.alarmStep("launcher", 3, () => this.syncLauncher(api, daily), 0);
      // K-406: at most 40 calls. `spent` counts the daily compare (12), the site checks (6), the redirect step (5),
      // the game records (4), the launcher step (3) and the path read of taken addresses (1); the tunnels, DNS records and offline routes above made at most 6 + 5 + 5, and the launcher
      // step after the sync needs 3. The login step and the sync share what is left. A policy that the sync
      // makes goes on the login applications in the next alarm, which runs at once (loginWork).
      await this.alarmStep("Access", 0, () => this.syncAccessLocked(api, CALLS_PER_RUN - spent - 16 - 3));
      // A policy that the sync just made goes on the App Launcher in the same run.
      await this.alarmStep("launcher after Access", 0, () => this.syncLauncher(api, false));
      // K-1623: an application that the sync made or made again changes the audiences of its provider.
      await this.alarmStep("grants", undefined, () => this.pushGrants());

      changed ||= daily || JSON.stringify(accessStates(this.desired(now), this.access)) !== before;
    }
    if (this.failedAlarmSteps() !== failedBefore) changed = true;
    // K-538: the steps that this run did, such as the ingress of a taken address, and deploys that expired.
    if (this.reconcileProgress(Date.now(), false, true)) changed = true;
    if (changed) this.broadcast();
    // K-1907, K-406: the pushes go out once, at the end, after the reconcile of broadcast queued its own.
    await this.flushPushes();
    await this.scheduleAlarm();
  }
}

/** OWNER_DEVICES: a JSON list of `{ tokenId, clientId, name }` that join the Owner circle at setup (K-106). */
function ownerDevices(text: string | undefined): Array<Extract<Member, { _tag: "device" }>> {
  if (!text) return [];
  const list = JSON.parse(text) as unknown;
  if (!Array.isArray(list)) throw new Error("OWNER_DEVICES is not a JSON list.");
  return list.map((item: unknown) => {
    const device = item as Partial<Record<"tokenId" | "clientId" | "name", unknown>>;
    if (
      typeof device.tokenId !== "string" ||
      typeof device.clientId !== "string" ||
      typeof device.name !== "string"
    ) {
      throw new Error("Each OWNER_DEVICES item needs tokenId, clientId and name.");
    }
    return { _tag: "device", tokenId: device.tokenId, clientId: device.clientId, name: device.name };
  });
}

/** The output of a job whose machine went offline; a later real result replaces it. */
export const OFFLINE_OUTPUT =
  "The machine went offline during the job. kitshn takes its result if it comes later.";

interface RepoRow extends Record<string, SqlStorageValue> {
  repo_id: string;
  name: string;
  state: RepoState;
  first_seen: number;
  branch: string | null;
  /** K-1121: the workflow file of the run that waits on `branch`. */
  workflow: string | null;
  allowed_by_client: string | null;
  allowed_by_name: string | null;
  /** K-819: when kitshn last got an answer from GitHub about this repo id. */
  checked_at: number | null;
  /** K-819: since when GitHub answers that the repo id no longer exists; null while it exists. */
  gone_at: number | null;
}

const repoGateOf = (row: RepoRow): RepoGate => ({
  repoId: row.repo_id,
  name: row.name,
  state: row.state,
  firstSeen: row.first_seen,
  branch: row.branch,
  workflow: row.workflow,
  allowedBy:
    row.allowed_by_client === null
      ? null
      : { clientId: row.allowed_by_client, name: row.allowed_by_name ?? "" },
});

/** K-1819 */
/** K-1833: the outcome of an import, which the bootstrap reads. */
type ImportStatus = { readonly state: "done" } | { readonly state: "refused"; readonly code: ImportCode };

const IMPORT_ACTOR: Actor = { _tag: "kitshn", reason: "the import of the bootstrap (K-1833)" };

/** K-1822: what finishes a restore to a time after the restart. */
interface RestoreFinish {
  readonly undo: string;
  readonly label: string;
  readonly jobsAfter: number;
  readonly actor: Actor;
}

/** K-1822: the pending finish lives in R2, because the restore rewinds the storage of the object. */
const RESTORE_PENDING = "state/restore-pending.json";

function restoreFinishOf(value: unknown): RestoreFinish | null {
  if (!isRecord(value)) return null;
  const { undo, label, jobsAfter, actor } = value;
  return typeof undo === "string" &&
    typeof label === "string" &&
    typeof jobsAfter === "number" &&
    isRecord(actor)
    ? { undo, label: label.slice(0, 80), jobsAfter, actor: actor as unknown as Actor }
    : null;
}

interface BackupRow extends Record<string, SqlStorageValue> {
  run: string;
  card: string;
  machine_id: string;
  at: number;
  state: string;
  bytes: number | null;
  added: number | null;
  error: string | null;
  job_id: number | null;
  /** K-1820: the sources of the run, as JSON. */
  sources: string | null;
  pause_ms: number | null;
}

const backupRun = (row: BackupRow): BackupRun => ({
  run: row.run,
  card: row.card,
  machineId: row.machine_id,
  at: row.at,
  state: row.state === "done" || row.state === "failed" ? row.state : "running",
  bytes: row.bytes,
  added: row.added,
  error: row.error,
  pauseMs: row.pause_ms,
});

interface DeployRow extends Record<string, SqlStorageValue> {
  /** K-1776: the rights, as JSON, that an approval of a folder site plan gave; its files and finish count them. */
  approved: string;
  id: string;
  repo: string;
  /** K-819: GitHub's id of the repo; null only for an old row whose card id holds none. */
  repo_id: string | null;
  environment: string;
  resource_id: string;
  address: string;
  script: string;
  starts_in: string | null;
  kind: "deploy" | "teardown";
  sha: string;
  state: string;
  expires_at: number;
  app: "static" | "compose" | "worker";
  machine_id: string | null;
  job_id: number | null;
  compose_file: string | null;
  /** The branch that the deploy came from (K-807). */
  branch: string;
  /** K-817: every address that serves the environment, the main one first, as JSON; null on older rows. */
  addresses: string | null;
  /** K-806: the `worker` part of the recipe as JSON, for a Worker app. */
  worker: string | null;
  /** K-804: the app of the repo; older rows are the app `app`. */
  app_key: string;
  /** K-820: why the deploy failed or did not run. */
  reason: string | null;
  /** K-820: the Cloudflare version of a static or Worker deploy, and the run that deployed it. */
  version_id: string | null;
  run_id: string | null;
  run_attempt: string | null;
  /** K-821: the image ids of a Compose deploy that came up, and the `needs.apps` keys, as JSON. */
  images: string | null;
  needs: string | null;
  /** K-821: the deploy whose build this rollback row repeats; null on a row that a workflow run made. */
  origin: string | null;
  /** K-1121: the workflow file of the run that made the deploy; null starts `kitshn.yml`. */
  workflow: string | null;
}

/** K-821: one finished deploy of a card in the rollback list; `why` says why a rollback cannot go there. */
interface RollbackChoice {
  readonly deployId: string;
  readonly sha: string;
  readonly at: number;
  readonly run: string | null;
  readonly note: string | null;
  readonly why: string | null;
}

/** K-821: one card of a run rollback and the deploy that it goes back to. */
interface RunRollbackStep {
  readonly card: string;
  readonly name: string;
  readonly deployId: string | null;
  readonly sha: string | null;
  readonly why: string | null;
}

/** K-806: the crons of the Free plan per account. */
const CRON_LIMIT = 5;

/** K-806: the Worker part of the recipe that the plan of a Worker deploy stored. */
function workerOf(row: DeployRow): typeof WorkerApp.Type {
  if (row.app !== "worker" || row.worker === null)
    throw new Error(`The deploy ${row.id} is not a Worker deploy.`);
  return decodeWorkerApp(JSON.parse(row.worker));
}

const decodeWorkerApp = Schema.decodeUnknownSync(WorkerApp);

/** K-817: the addresses of a deploy row, the main one first. */
function rowAddresses(row: Pick<DeployRow, "address" | "addresses">): Array<string> {
  if (!row.addresses) return [row.address];
  const parsed: unknown = JSON.parse(row.addresses);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string"))
    throw new Error(`The addresses of the deploy of ${row.address} are not a list of names.`);
  return parsed;
}

/** A failed tunnel, DNS or route write tries again after this time. */
const RETRY_MS = 5 * 60_000;
/** K-704: a provider without a connection this long opens a notification. */
const PROVIDER_OFFLINE_MS = 5 * 60_000;

/** K-406: the steps of the alarm that run on their own, so one that throws stops no other. */
const ALARM_STEPS = [
  "liveness",
  "jobs",
  "rollbacks",
  "proposals",
  "provider offline",
  "share ends",
  "doors",
  "open games",
  "daily",
  "uptime",
  "bell",
  "offline",
  "audiences",
  "foreign paths",
  "tunnels",
  "site checks",
  "DNS",
  "game DNS",
  "routes",
  "launcher",
  "Access",
  "launcher after Access",
  "grants",
] as const;
type AlarmStep = (typeof ALARM_STEPS)[number];

interface AlarmStepFailure {
  readonly since: number;
  readonly tries: number;
  readonly retryAt: number;
}

/** K-406: 5 minutes after the first failure, then twice as long each time, at most an hour. */
const alarmStepBackoff = (tries: number) => Math.min(RETRY_MS * 2 ** Math.max(0, tries - 1), HOUR_MS);
/**
 * K-1623, K-411: a taken address moves its record this long after the tunnel got its ingress. cloudflared takes an
 * ingress within seconds, and a new Access application answered after about 10 seconds in the test of 2026-10-29.
 */
const HANDOVER_INGRESS_MS = 15_000;

/** K-538: the reason of an action that a restart of kitshn cut off; Dismiss takes it off the card. */
const INTERRUPTED = "Interrupted: kitshn restarted during this action.";

/** K-538: the meta key prefix of the last action of a card. */
const PROGRESS_META = "progress:";

/**
 * K-538: an action and what drives its steps: a job, the handover of the address, a give-back that runs at once, the
 * calls of a static or Worker deploy, a run rollback, or kitshn's own restore to a time (on the admin card).
 */
interface StoredProgress {
  readonly source:
    | { readonly _tag: "job"; readonly jobId: number }
    | { readonly _tag: "takeover" }
    | { readonly _tag: "give-back" }
    | { readonly _tag: "deploy"; readonly deployId: string }
    | { readonly _tag: "rollback"; readonly id: string }
    | { readonly _tag: "restore" }
    /** K-631: "Check now" waits for the daemon's report until `until`. */
    | { readonly _tag: "health"; readonly until: number };
  readonly progress: ActionProgress;
}

/** K-538: the steps of a static or Worker deploy, which the CLI runs in GitHub Actions; each of its calls moves on. */
const DEPLOY_STEP = {
  build: "Build in GitHub Actions",
  storage: "Make the KV namespaces",
  upload: "Upload the files to Cloudflare",
  live: "Make the new version live",
} as const;

/** K-538: the plan of a static or Worker deploy; a folder site (K-1123) has no build in Actions. */
function deployPlan(row: Pick<DeployRow, "app" | "worker" | "repo_id">): ReadonlyArray<PlannedStep> {
  const build = row.repo_id === null ? [] : [{ label: DEPLOY_STEP.build, expectedMs: 30_000 }];
  const upload = { label: DEPLOY_STEP.upload, expectedMs: 10_000 };
  if (row.app !== "worker") return [...build, upload, { label: DEPLOY_STEP.live, expectedMs: 5_000 }];
  const assets = row.worker !== null && decodeWorkerApp(JSON.parse(row.worker)).assets !== undefined;
  return [
    ...build,
    { label: DEPLOY_STEP.storage, expectedMs: 2_000 },
    ...(assets ? [upload] : []),
    { label: DEPLOY_STEP.live, expectedMs: 8_000 },
  ];
}

/** K-538, K-1822: the steps of "Restore kitshn to a time"; the restart cuts the storage off between steps 2 and 3. */
const RESTORE_ACTION = "Restore kitshn to a time";
const RESTORE_STEPS: ReadonlyArray<PlannedStep> = [
  { label: "Find the restore point", expectedMs: 1_000 },
  { label: "Restart kitshn on the restored storage", expectedMs: 3_000 },
  { label: "Record the restore in History and set the job ids", expectedMs: 500 },
  { label: "Rotate the pass key", expectedMs: 1_000 },
];

/** K-631: a "Check now" fails when no report comes in this time; a link check gives up after 10 seconds (K-630). */
const HEALTH_CHECK_WAIT_MS = 60_000;
const HEALTH_CHECK_STEPS: ReadonlyArray<PlannedStep> = [
  { label: "Check the providers and the links", expectedMs: 3_000 },
];

const TAKE_ADDRESS_STEPS: ReadonlyArray<PlannedStep> = [
  { label: "Make kitshn's Access application", expectedMs: 4_000 },
  { label: "Add the route to the machine's tunnel", expectedMs: 3_000 },
  { label: "Wait until T3 has kitshn's audience", expectedMs: 2_000 },
  { label: "Wait until Access answers on the address", expectedMs: HANDOVER_INGRESS_MS },
  { label: "Move the DNS record to the tunnel", expectedMs: 2_000 },
];

/** K-538: the card of a Compose job's action. */
const actionCard = (command: Command) =>
  command.kind === "compose" || command.kind === "compose-redeploy" || command.kind === "compose-rollback"
    ? command.project
    : null;

/** K-538: the action and the steps of a job that a card shows, or null for a job without one. */
function jobAction(
  command: Command,
  machine: string | null,
): { readonly action: string; readonly plan: ReadonlyArray<PlannedStep> } | null {
  const on = machine ?? "a machine";
  const wait = { label: `Wait until ${on} takes the job`, expectedMs: 2_000 };
  switch (command.kind) {
    case "update":
      return {
        action: "Update daemon",
        plan: [
          { label: `Wait until ${on} is online and idle`, expectedMs: 2_000 },
          { label: "Download and check the new daemon", expectedMs: 20_000 },
          { label: "Restart on the new release", expectedMs: 15_000 },
          { label: "Keep the new connection up for 3 minutes", expectedMs: 180_000 },
        ],
      };
    case "compose":
      return { action: "Deploy", plan: [wait, { label: `Build and start on ${on}`, expectedMs: 60_000 }] };
    case "compose-redeploy":
      return {
        action: "Redeploy",
        plan: [wait, { label: `Start the last build again on ${on}`, expectedMs: 20_000 }],
      };
    case "compose-rollback":
      return {
        action: "Roll back",
        plan: [wait, { label: `Start the kept build on ${on}`, expectedMs: 20_000 }],
      };
    default:
      return null;
  }
}
/** K-705: the sticker of a provider card whose address something else serves. */
const ADDRESS_IN_USE = "address in use";

/** K-1623: the record of a taken address as it was, for "Give the address back". */
interface AddressHandover {
  readonly recordId: string;
  readonly content: string;
  readonly comment: string | null;
  /** When the tunnel first got the address's ingress; the record moves `HANDOVER_INGRESS_MS` after. */
  readonly ingressAt: number | null;
  /** The record serves kitshn's tunnel now. */
  readonly switched: boolean;
  /** The path applications of the portal on the address, as kitshn last read them, and when. */
  readonly paths: ReadonlyArray<ForeignPath>;
  readonly pathsAt: number;
  /** A give-back runs: the host left `served` before the record moves back (K-1623). */
  readonly returning: boolean;
  /** The record moved and the portal no longer holds the exact host, so the address stays with kitshn for good. */
  readonly released: boolean;
}

/** K-1623: how often kitshn reads the path applications of a taken address again. */
const FOREIGN_PATHS_MS = 10 * 60_000;

/** K-705: a provider card with or without the sticker of an address that something else serves. */
function withAddressInUse(card: Resource, inUse: boolean): Resource {
  const provider = card.provider!;
  const stickers = provider.stickers.filter((sticker) => sticker.text !== ADDRESS_IN_USE);
  return {
    ...card,
    provider: {
      ...provider,
      stickers: inUse ? [{ text: ADDRESS_IN_USE, tone: "warn" as const }, ...stickers].slice(0, 8) : stickers,
    },
  };
}

const DAY_MS = 24 * 3_600_000;

/** K-819: GitHub calls of one repo check; a Free plan request may make 50 subrequests. */
const GITHUB_CALLS_PER_CHECK = 40;

/** K-106: the Cloudflare name of each device token that kitshn makes. */
const DEVICE_TOKEN_PREFIX = "kitshn device ";

/** K-1601: a waiting device invite. */
type InviteRow = {
  lookup: string;
  token_id: string;
  client_id: string;
  name: string;
  expires_at: number;
};

/** A machine as the actor of what its daemon does, such as a key rotation (K-1705). */
const deviceActor = (machine: Machine): Actor => ({
  _tag: "device",
  clientId: machine.clientId,
  name: machine.name,
});

/**
 * K-624: why a machine lacks a feature. A Windows daemon has no Compose, logs or backups in the first version, so an
 * update does not help there; elsewhere the daemon is too old.
 */
const missingFeature = (
  status: MachineStatus | null | undefined,
  name: string,
  feature: string,
  update: string,
) =>
  status?.os.startsWith("win32")
    ? `${name} runs Windows, where kitshn has no ${feature} yet (K-624).`
    : update;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A socket that is closing still shows in `getWebSockets` until its close is handled, and a send to it throws. It
 * gets nothing: its close handler does the clean-up (K-1805).
 */
const send = (socket: WebSocket, message: ServerMessage | ServerToDaemon) => {
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return;
  socket.send(JSON.stringify(message));
};

/** K-2003: a request of the join page. */
interface GameRequest {
  readonly name: string;
  readonly visitor: ContentVisitor;
  readonly action: "view" | "open" | "close";
  /** `open`: the addresses that the browser found (K-2004). */
  readonly addresses?: ReadonlyArray<unknown>;
}

interface ContentRequest {
  /** The first path segment: a name of K-1120 or an id. */
  readonly segment: string;
  readonly kind: "page" | "file";
  readonly visitor: ContentVisitor;
}

interface LibraryRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  title: string;
  file_name: string | null;
  thread: string | null;
  machine: string | null;
  size: number;
  content_type: string;
  created_at: number;
  /** K-1116: the client id of the agent key that published it, or null. */
  added_by: string | null;
  /** K-1117: the R2 slot that serves (`slotKey`). */
  current_slot: number;
  /** K-1117: the size and the type of the one previous version, or null. */
  previous_size: number | null;
  previous_type: string | null;
}

const libraryItem = (row: LibraryRow): LibraryItem => ({
  id: row.id,
  kind: row.kind === "file" ? "file" : "page",
  title: row.title,
  fileName: row.file_name,
  thread: row.thread,
  machine: row.machine,
  size: row.size,
  contentType: row.content_type,
  createdAt: row.created_at,
  slot: row.current_slot === 1 ? 1 : 0,
});

/** The R2 key of a file of a Compose deploy (K-812). */
const deployObject = (deployId: string, file: string) => `deploys/${deployId}/${file}`;

/** The requester of a job that kitshn makes itself, such as a deploy (K-614). */

/** K-1504: who paused and when, from the meta rows that a pause writes. */
function parsePausedBy(
  actor: string | null,
  at: string | null,
): { readonly actor: Actor; readonly at: number } | null {
  if (!actor || !at) return null;
  return { actor: JSON.parse(actor) as Actor, at: Number(at) };
}

const NO_VOLUME_JOBS = "An agent does not delete volumes (K-718, K-909).";

/** K-1776: the approval of a person in the Owner circle for one job or deploy, stored on the job. */
interface OwnerApproval {
  readonly machineId: string;
  /** The key of the machine that asked at the approval, so a reset or a rotation ends the approval. */
  readonly key: string | null;
  readonly right: MachineRight;
}

const NO_LONGER_ALLOWED = "no longer allowed:";

const keyMark = (machine: Machine) =>
  machine.key?.kind === "public" ? `${machine.key.fingerprint} ${machine.key.since}` : null;

const actorName = (actor: Actor) =>
  actor._tag === "person" ? actor.email : actor._tag === "kitshn" ? "kitshn" : actor.name;

const noRestartAfterUpdate = (machine: string) =>
  `This Windows daemon cannot start its task again after an update, so an agent does not update it (K-622). The owner sends Update daemon in the panel of ${machine}, then runs schtasks /run /tn \\kitshn\\daemon on the PC.`;

const KITSHN_JOB = JSON.stringify({ email: null, clientId: null, ip: null, kitshn: true });

/** K-718: the workflow file that an agent key starts in an app repo, the one that the map's recipe shows. */
const AGENT_WORKFLOW = "kitshn.yml";
/** K-909: the expiry of a job that waits for its machine however long. */
const NEVER = Number.MAX_SAFE_INTEGER;
const NO_GITHUB_APP =
  "This kitshn has no GitHub App. Run the bootstrap with KITSHN_GITHUB_APP_ID and KITSHN_GITHUB_APP_KEY.";

/** K-1114: a daemon changes the stored icon of a site at most once in this time. */
const ICON_CHANGE_MS = 60 * 60_000;

/** K-1113: the short hash of icon bytes, which versions the icon address. */
async function iconHash(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** K-1115: how much of a page kitshn reads for a data: icon; a 100 KB icon is about 137 KB as base64. */
const PAGE_ICON_SCAN = 256 * 1024;

/** K-1115: the icon of a page (a `data:` link) or of a small image file, from the start of its bytes. */
function headIcon(kind: "page" | "file", head: Uint8Array | null) {
  const bytes = head === null ? null : kind === "page" ? pageDataIcon(new TextDecoder().decode(head)) : head;
  const type = bytes !== null && bytes.length <= ICON_LIMIT ? iconType(bytes) : null;
  return bytes !== null && type !== null ? { bytes, type } : null;
}

/**
 * K-1123: the folder sites of one key. Known limit: a fixed number, so a key cannot fill the account (Free plan: 100
 * Worker scripts, and kitshn stops at SCRIPT_LIMIT); revisit when one agent needs more sites.
 */
const FOLDER_SITES_PER_KEY = 10;

interface AgentSiteRow extends Record<string, SqlStorageValue> {
  card_id: string;
  client_id: string;
  folder: string;
  address: string;
  circle: string | null;
  public: number;
  agent_tray: number;
  created_at: number;
}

/** K-1776: the rights that a stored approval gave; anything else in the column counts for nothing. */
const approvedRights = (text: string): ReadonlyArray<MachineRight> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter(
          (right): right is MachineRight => typeof right === "string" && right in MACHINE_RIGHT_NAMES,
        )
      : [];
  } catch {
    return [];
  }
};

/** K-1132: at most this many open asks for access, so strangers with an email cannot fill the Inbox. */
const ACCESS_ASKS_OPEN = 20;

/** K-1123: a folder site has no repo; this deployer only names it in the deploy log of `ensureCard`. */
const folderDeployer = (folder: string): Deployer => ({
  repo: `folder ${folder}`,
  repoId: "",
  ownerId: "",
  sha: "folder",
  eventName: "folder",
  branch: "",
  pr: null,
  runId: "",
  runAttempt: "",
  workflow: null,
  actor: "",
});

/** K-1127: how long a handover waits for the first push of its repo. */
const HANDOVER_MS = 60 * 60_000;

/** K-1127: a handover that still fits, with its addresses read. */
interface Handover {
  readonly repo_id: string;
  readonly repo: string;
  readonly card_id: string;
  readonly client_id: string;
  readonly client_name: string;
  readonly addresses: ReadonlyArray<string>;
}

interface HandoverRow extends Record<string, SqlStorageValue> {
  /** GitHub's ids of the repo and its owner, which the deploy token proves; the name only reads well. */
  repo_id: string;
  owner_id: string;
  repo: string;
  card_id: string;
  client_id: string;
  client_name: string;
  /** The addresses that the repo's card gets, the main one first, as JSON. */
  address: string;
  expires_at: number;
  /** K-1776: the rights, as JSON, that an approval of the handover gave; the repo's first deploy counts them. */
  approved: string;
}

/** K-1127: a GitHub numeric id, as the API and the deploy token give it. */
const isGitHubId = (id: string) =>
  id.length >= 1 && id.length <= 20 && [...id].every((c) => c >= "0" && c <= "9");

/** K-1127: `owner/name` as GitHub allows it: letters, digits and dashes in the owner; also dots and underscores after. */
function isRepoName(repo: string): boolean {
  const [owner = "", name = "", ...rest] = repo.split("/");
  const plain = (c: string) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "-";
  const okOwner = owner.length >= 1 && owner.length <= 39 && [...owner].every(plain);
  const okName =
    name.length >= 1 &&
    name.length <= 100 &&
    name !== "." &&
    name !== ".." &&
    [...name].every((c) => plain(c) || c === "." || c === "_");
  return rest.length === 0 && okOwner && okName;
}

/**
 * K-1128, K-817: why a hostname cannot be a redirect address, or null: one name under a zone of K-1111, or the apex of
 * a zone other than the kitshn zone, and none of kitshn's own names.
 */
function redirectAddressError(address: string, env: Env): string | null {
  const zone = zoneOfAddressIn(address, env);
  if (!zone) return `kitshn does not publish on the zone of ${address} (K-1111).`;
  const label = address === zone.name ? "" : address.slice(0, -zone.name.length - 1);
  const plain = [...label].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-");
  if (label === "" && zone.name === env.KITSHN_ZONE)
    return `The apex of ${zone.name} is kitshn's own (K-817).`;
  if (label.includes(".") || !plain || label.startsWith("-") || label.endsWith("-") || label.length > 63)
    return `A redirect address is one name of letters, digits and inner dashes under a zone (K-817).`;
  if (address === env.KITSHN_HOST || (zone.name === env.KITSHN_ZONE && RESERVED_SITE_NAMES.has(label)))
    return `${address} is a name of kitshn itself (K-817).`;
  return null;
}

/** K-1122: the old names that an item keeps; each sends visitors on, and no other item takes it. */
const OLD_NAMES = 5;

/** K-1120: a name that another item holds; the routes answer 409. */
class AddressTaken extends RuleError {}

/** K-1120: the `address` of a JSON body, or "" for anything else, which the name check refuses. */
async function addressBody(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => null);
  return isRecord(body) && typeof body["address"] === "string" ? body["address"].trim() : "";
}

/** K-1116: what the agent route decides for an upload before `upload` writes anything. */
interface AgentUpload {
  readonly clientId: string;
  readonly source: string;
  readonly title: string;
  /** The spot of K-1116 against the current state; `upload` asks before and again after the R2 write. */
  readonly place: () => Point | null | string;
}

/** The first `limit` bytes of a stream, or all of a shorter one; it stops reading after that. */
async function readStart(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes.subarray(0, limit);
}

/** K-1722: a row of the proposals table. */
/**
 * K-1714: the right that a call forwarded by a daemon needs: a machine right, null for a call that needs only a card
 * that the machine manages (K-718 checks it), or undefined for a path that a machine never forwards.
 */
export function forwardRight(path: string, method: string): MachineRight | null | undefined {
  const card = path.startsWith("/agent/cards/") ? path.slice("/agent/cards/".length) : null;
  if (path === "/agent/library" && method === "POST") return "addsPages";
  if (path.startsWith("/agent/library/") && path.endsWith("/previous") && method === "POST")
    return "addsPages";
  if (path.startsWith("/agent/library/") && path.endsWith("/content") && method === "GET") return null;
  if (path.startsWith("/agent/sites/") && method === "POST") return "addsPages";
  if (card !== null && card.endsWith("/address") && method === "POST") return "addsPages";
  // K-212: the time of a card needs only a card that the machine manages.
  if (card !== null && card.endsWith("/time") && method === "POST") return null;
  if (card !== null && card.includes("/redirects") && (method === "POST" || method === "DELETE"))
    return "addsPages";
  if (card !== null && card.endsWith("/handover") && method === "POST") return "addsApps";
  if (path === "/agent/games" && method === "POST") return "addsApps";
  // A removal lowers access (K-715), so it needs only a card that the machine manages; a game also "adds apps".
  if (card !== null && !card.includes("/") && method === "DELETE") return null;
  if (card !== null && card.endsWith("/previous") && method === "POST") return "addsPages";
  if (card !== null && card.includes("/doors") && (method === "GET" || method === "DELETE")) return null;
  if (path === "/agent/logs" && method === "POST") return null;
  return undefined;
}

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** K-1776: the refusal of a right that is off: one line that names the right, and the right for the CLI's offer. */
const offRight = (right: MachineRight, scope = "for this machine (K-1720)"): AskOutcome => ({
  outcome: "refused",
  reason: `The right "${MACHINE_RIGHT_NAMES[right]}" is off ${scope}. Ask the owner to turn it on.`,
  need: right,
});

interface ProposalRow extends Record<string, SqlStorageValue> {
  readonly id: string;
  readonly machine_id: string;
  readonly action: string;
  readonly target: string;
  readonly body: string;
  readonly reason: string | null;
  readonly labels: string;
  readonly right_name: string;
  readonly circle_id: string;
  readonly shown: string;
  readonly shown_hash: string;
  readonly state: string;
  readonly created_at: number;
  readonly expires_at: number;
  /** K-1752: the label keys that a provider of the machine vouched for, as JSON, fixed at ask time. */
  readonly verified: string;
}

const proposalOf = (row: ProposalRow): Proposal => ({
  id: row.id,
  machineId: row.machine_id,
  action: row.action as AskAction,
  target: row.target,
  body: JSON.parse(row.body) as unknown,
  reason: row.reason,
  labels: JSON.parse(row.labels) as Record<string, string>,
  right: row.right_name as MachineRight,
  circleId: row.circle_id,
  shown: row.shown,
  shownHash: row.shown_hash,
  state: row.state as Proposal["state"],
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** K-1717: a row of the ask events table. */
interface AskEventRow extends Record<string, SqlStorageValue> {
  readonly id: number;
  readonly at: number;
  readonly machine_id: string;
  readonly action: string;
  readonly target: string;
  readonly reason: string | null;
  readonly labels: string;
  readonly outcome: string;
  readonly detail: string;
  /** K-1752: the label keys that a provider of the machine vouched for, as JSON, fixed at ask time. */
  readonly verified: string;
}
