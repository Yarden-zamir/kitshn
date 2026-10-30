import {
  type Actor,
  type Change,
  type Edit,
  type StoredRevision,
  RuleError,
  applyChanges,
  invert,
  mergeMoves,
  mergedSummary,
  prepareUndo,
  refuseRaiseWhilePaused,
  refuseResume,
  resolveEdits,
  revisionTargets,
  ruleViolation,
  summarize,
  targetOf,
  undoAnswer,
  undoTarget,
} from "../../core/changes.ts";
import { demoUsage } from "../../core/demo.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  EVERYONE_CIRCLE_ID,
  type Member,
  OWNER_CIRCLE_ID,
  type Resource,
  type State,
} from "../../core/model.ts";
import { ORGANIZE_SUMMARY, drawnSizes, organize, organizeSummary } from "../../core/organize.ts";
import type { RevisionView, ServerMessage, Snapshot } from "../../core/protocol.ts";

/**
 * The kitshn of the site demo: the map of a made-up owner, kept in this page only. It answers the map's messages
 * with the rules of the real Worker (changes.ts, organize.ts), so a drag, a refusal, Undo and History behave as on
 * a real map; nothing reaches Cloudflare, and a reload starts again.
 */

export const ME = { _tag: "person", email: "you@example.com" } as const satisfies Actor;

const card = (id: string, kind: Resource["kind"], name: string): Resource => ({
  id,
  kind,
  name,
  addresses: kind === "kitshn.admin" ? ["kit.example.com"] : [`${id}.example.com`],
  status: "running",
  group: null,
  machine: null,
});

const circle = (
  fields: Pick<Circle, "id" | "name" | "color" | "level" | "members" | "x" | "y" | "r"> & Partial<Circle>,
): Circle => ({ match: "any", needsPasskey: false, endsAt: null, ...fields });

/** The two maps of the demo: the home page shows a person's map, /enterprise/ (`?map=company`) a company's. */
export type DemoMap = "personal" | "company";

interface MapText {
  /** The Owner circle (K-104), the circle that the hint fills, the circle with a card, and their members. */
  readonly owner: string;
  readonly empty: { readonly id: string; readonly name: string; readonly members: ReadonlyArray<Member> };
  readonly held: { readonly id: string; readonly name: string; readonly members: ReadonlyArray<Member> };
  /** The card in Everyone, the card in `held`, and the card in no circle, which the hint drags into `empty`. */
  readonly cards: readonly [
    readonly [string, Resource["kind"], string],
    readonly [string, Resource["kind"], string],
    readonly [string, Resource["kind"], string],
  ];
}

const email = (address: string): Member => ({ _tag: "email", email: address });

/**
 * The person: someone who builds with Claude Code on weekends, with a personal site that anyone can open, a trip
 * planner for the family, and a habit tracker that no one can open yet. The company: a status page for everyone,
 * internal docs for Engineering, and a sales report that no one can open yet.
 */
const MAPS: Record<DemoMap, MapText> = {
  personal: {
    owner: "Me",
    empty: { id: "friends", name: "Friends", members: [email("maya@gmail.com"), email("sam@gmail.com")] },
    held: { id: "family", name: "Family", members: [email("mom@gmail.com"), email("dad@gmail.com")] },
    cards: [
      ["me", "site.static", "My site"],
      ["trip", "site.static", "Trip planner"],
      ["habits", "site.worker", "Habit tracker"],
    ],
  },
  company: {
    owner: "IT",
    empty: { id: "sales", name: "Sales", members: [email("dana@acme.com"), email("omer@acme.com")] },
    held: {
      id: "engineering",
      name: "Engineering",
      members: [
        { _tag: "domain", domain: "acme.com" },
        { _tag: "ip", range: "10.0.0.0/8" },
      ],
    },
    cards: [
      ["status", "site.static", "Status page"],
      ["docs", "site.static", "Internal docs"],
      ["report", "site.compose", "Sales report"],
    ],
  },
};

/** What the first-drag hint (feel.ts) drags, and into which circle. */
export const hintOf = (map: DemoMap) => ({ card: MAPS[map].cards[2][0], circle: MAPS[map].empty.id });

/**
 * The map that each visit starts with. The Owner circle holds the admin card, which the rules need (K-104). The map
 * is small and about square, so it fits the frame beside the headline, and a phone, with whole cards.
 */
function start(map: DemoMap): State {
  const text = MAPS[map];
  const circles = [
    circle({
      id: OWNER_CIRCLE_ID,
      name: text.owner,
      color: "#6C5CE7",
      level: "control",
      members: [email(ME.email)],
      needsPasskey: true,
      x: -200,
      y: -130,
      r: 85,
    }),
    circle({ ...text.empty, color: "#FF9FB2", level: "view", x: 40, y: -150, r: 115 }),
    circle({
      ...text.held,
      color: "#5CC8FF",
      level: "view",
      // A company circle asks for the domain and the office network together (K-203).
      match: map === "company" ? "all" : "any",
      x: -60,
      y: 110,
      r: 125,
    }),
    circle({
      id: EVERYONE_CIRCLE_ID,
      name: "Everyone",
      color: "#6EE7A0",
      level: "view",
      members: [{ _tag: "everyone" }],
      x: 230,
      y: 80,
      r: 115,
    }),
  ];
  const [open, held, free] = text.cards;
  const resources = [
    card(ADMIN_RESOURCE_ID, "kitshn.admin", "kitshn admin"),
    ...text.cards.map((each) => card(...each)),
  ];
  const places = {
    [ADMIN_RESOURCE_ID]: { x: -200, y: -120 },
    [open[0]]: { x: 230, y: 90 },
    [held[0]]: { x: -60, y: 110 },
    [free[0]]: { x: 280, y: -180 },
  };
  return {
    circles: new Map(circles.map((each) => [each.id, each])),
    resources: new Map(resources.map((each) => [each.id, each])),
    places: new Map(Object.entries(places)),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

/** The demo deletes no card outside an edit, so it stores no Forget (K-1506), and its revisions fit `mergeMoves`. */
interface Stored extends StoredRevision {
  readonly at: number;
  readonly changes: ReadonlyArray<Change>;
}

export class DemoServer {
  private state: State;
  private readonly history: Array<Stored> = [];
  private lastId = 0;
  private readonly listeners = new Set<(message: ServerMessage) => void>();

  constructor(map: DemoMap = "personal") {
    this.state = start(map);
  }

  /** A map that opens; it gets the snapshot at once, as from the Worker. */
  open(listener: (message: ServerMessage) => void) {
    this.listeners.add(listener);
    listener({ type: "snapshot", snapshot: this.snapshot() });
    return () => void this.listeners.delete(listener);
  }

  /** A message of the map: the answer goes to `reply`, and a change goes as a snapshot to every map first. */
  receive(raw: string, reply: (message: ServerMessage) => void) {
    const message = JSON.parse(raw) as { type: string; requestId: string } & Record<string, unknown>;
    if (message.type === "tail") {
      reply({
        type: "tail",
        requestId: message.requestId,
        answer: { kind: "error", error: "This is the demo map on kitshn.com; it has no running apps." },
      });
      return;
    }
    if (message.type === "tailStop") return;
    try {
      const { revision, summary } = this.handle(message);
      this.broadcast();
      reply({ type: "result", requestId: message.requestId, ok: true, revision, notes: [], summary });
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      reply({ type: "result", requestId: message.requestId, ok: false, error: error.message });
    }
  }

  /** The HTTP calls that the map makes with `callApi`; the rest say that the demo does not do them. */
  request(method: string, url: URL): { status: number; body: unknown } {
    const query = url.searchParams;
    if (method === "GET" && url.pathname === "/api/undo")
      return ok(
        undoAnswer(this.state, this.history, ME, { revision: Number(query.get("revision")) }, Date.now()),
      );
    if (method === "GET" && url.pathname === "/api/undo-item") {
      const kind = query.get("kind") === "circle" ? "circle" : "card";
      return ok(
        undoAnswer(this.state, this.history, ME, { item: { kind, id: query.get("id") ?? "" } }, Date.now()),
      );
    }
    if (method === "GET" && url.pathname === "/api/usage") return ok(demoUsage(Date.now()));
    if (method === "GET" && url.pathname === "/api/state") return ok(this.snapshot());
    if (
      method === "GET" &&
      ["/api/library", "/api/devices", "/api/uptime"].some((path) => url.pathname.startsWith(path))
    )
      return ok([]);
    return {
      status: 501,
      body: { error: "This is the demo map on kitshn.com. Install kitshn to do this on your own map." },
    };
  }

  private handle(message: Record<string, unknown>): { revision: number | null; summary: string | null } {
    switch (message["type"]) {
      case "apply":
        return {
          revision: this.commit(refuseResume(resolveEdits(this.state, message["edits"] as Array<Edit>))),
          summary: null,
        };
      case "organize": {
        const kinds = (message["hiddenKinds"] ?? []) as Array<string>;
        const plan = organize(
          this.state,
          drawnSizes(message as unknown as Parameters<typeof drawnSizes>[0]),
          (id) => {
            const kind = this.state.resources.get(id)?.kind;
            return kind !== undefined && !kinds.includes(kind);
          },
        );
        if ("refused" in plan) throw new RuleError(plan.refused);
        if (plan.edits.length === 0) return { revision: null, summary: "Every card is in order already" };
        const summary = organizeSummary(plan.moved);
        return { revision: this.commit(resolveEdits(this.state, plan.edits), { named: summary }), summary };
      }
      case "undo": {
        const target = undoTarget(this.state, this.history, ME, { revision: Number(message["revision"]) });
        const changes = prepareUndo(this.state, target.changes, Date.now());
        const before = this.state;
        const revision = this.commit(changes, { undoes: target.revision });
        return { revision, summary: summarize(before, this.state, changes) };
      }
      case "undoItem": {
        const item = message["item"] as { kind: "card" | "circle"; id: string };
        const target = undoTarget(this.state, this.history, ME, { item });
        const changes = prepareUndo(this.state, target.changes, Date.now());
        const name =
          item.kind === "card"
            ? (this.state.resources.get(item.id)?.name ?? item.id)
            : `the circle ${this.state.circles.get(item.id)?.name ?? item.id}`;
        const before = this.state;
        const revision = this.commit(changes, { label: `Undo #${target.revision} for ${name}: ` });
        return { revision, summary: summarize(before, this.state, changes) };
      }
      default:
        throw new RuleError("The demo map does not know this message.");
    }
  }

  /** One write, as the Worker's commit: the rules (K-105), one revision (K-1501), moves that join (K-1505). */
  private commit(
    changes: ReadonlyArray<Change>,
    how: { readonly named?: string; readonly undoes?: number; readonly label?: string } = {},
  ): number | null {
    if (changes.length === 0) return null;
    const before = this.state;
    const after = applyChanges(before, changes);
    const violation = ruleViolation(after);
    if (violation) throw new RuleError(violation);
    refuseRaiseWhilePaused(before, after);
    const now = Date.now();
    this.state = after;
    const last = this.history.at(-1);
    const plain = how.named === undefined && how.undoes === undefined && how.label === undefined;
    const merged =
      plain && last && !last.summary.startsWith(`${ORGANIZE_SUMMARY}:`) && !last.summary.startsWith("Undo #")
        ? mergeMoves(last, ME, now, changes)
        : null;
    if (last && merged) {
      const summary = mergedSummary(
        last.summary,
        applyChanges(before, invert(last.changes)),
        before,
        after,
        merged,
      );
      this.history[this.history.length - 1] = { ...last, at: now, summary, changes: merged };
      return last.id;
    }
    const summary =
      how.named ??
      (how.undoes === undefined ? (how.label ?? "") : `Undo #${how.undoes}: `) +
        summarize(before, after, changes);
    this.history.push({
      id: ++this.lastId,
      at: now,
      actor: ME,
      summary,
      changes,
      undoes: how.undoes ?? null,
    });
    return this.lastId;
  }

  private broadcast() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener({ type: "snapshot", snapshot });
  }

  private revisions(): Array<RevisionView> {
    const undone = new Map(
      this.history.flatMap((row) => (row.undoes === null ? [] : [[row.undoes, row.id] as const])),
    );
    return this.history
      .map((row) => ({
        id: row.id,
        at: row.at,
        actor: row.actor,
        summary: row.summary,
        undoes: row.undoes,
        undoSource: null,
        undoneBy: undone.get(row.id) ?? null,
        undoable: row.changes.length > 0,
        ...revisionTargets(row.changes.map(targetOf)),
      }))
      .reverse();
  }

  snapshot(): Snapshot {
    const { state } = this;
    return {
      circles: [...state.circles.values()],
      resources: [...state.resources.values()],
      places: Object.fromEntries(state.places),
      shareSettings: Object.fromEntries(state.shareSettings),
      ends: Object.fromEntries(state.ends),
      stacks: [...state.stacks.values()],
      revisions: this.revisions(),
      access: {},
      accessWarnings: [],
      signOutWarning: null,
      paused: state.paused,
      repos: [],
      deployedCards: [],
      previewCards: [],
      pullRequests: {},
      orphanWorkers: [],
      deployNotes: {},
      uptime: {},
      bell: 0,
      icons: {},
      previousVersions: [],
      handoverCards: [],
      addressHolds: {},
      folderSites: [],
      redirects: {},
      pausedBy: null,
      machines: [],
      cardSettings: {},
      providerCommands: {},
      proposals: [],
      botRuns: [],
      githubDefaultWay: "not-kitshn",
      askEvents: [],
      linkEvents: [],
      jobs: [],
      queuedJobs: {},
      backups: {},
      r2Bucket: null,
      backupsOff: false,
      restoreUndo: null,
      version: "demo",
      accessTeam: "example.cloudflareaccess.com",
      zone: "example.com",
      me: ME,
      revision: this.lastId,
    };
  }
}

const ok = (body: unknown) => ({ status: 200, body });
