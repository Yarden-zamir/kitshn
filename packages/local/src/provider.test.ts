import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  GrantTables,
  type ProviderProblem,
  type ProviderReport,
  decodeClients,
  decodeResources,
  screenResources,
  desiredProblem,
  readAnswer,
  readRequest,
  reportProblem,
} from "./index.ts";

const t3 = (resources: ProviderReport["resources"], extra: Partial<ProviderReport> = {}): ProviderReport => ({
  name: "t3",
  online: true,
  kinds: [
    { id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } },
    { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
    { id: "t3.settings", name: "settings", levels: {} },
  ],
  commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
  resources,
  ...extra,
});
const app = { id: "app", kind: "t3.app", name: "T3 on vps", status: "running" } as const;

describe("provider reports (K-704, K-705)", () => {
  it("takes kinds with the provider prefix, known parents and free site names", () => {
    const thread = { id: "th-1", kind: "t3.thread", name: "Fix", status: "running", parent: "app" } as const;
    expect(
      reportProblem(t3([{ ...app, site: { name: "t3-vps", port: 3773 } }, thread]), [], new Set(), new Set()),
    ).toBeNull();
  });

  it.each([
    [
      "a kind of another prefix",
      t3([], { kinds: [{ id: "other.app", name: "x", levels: { view: "view" } }] }),
    ],
    [
      "a command of an unknown kind",
      t3([], { commands: [{ id: "x", title: "X", kinds: ["t3.nope"], confirm: false }] }),
    ],
    ["a resource of an unknown kind", t3([{ ...app, kind: "t3.nope" }])],
    ["a card of a kind without levels (K-709)", t3([{ ...app, kind: "t3.settings" }])],
    ["an unknown parent", t3([{ ...app, parent: "gone" }])],
    ["two resources with one id", t3([app, app])],
    [
      "a card setting whose default is not one of its values (K-717)",
      t3([], {
        kinds: [
          {
            id: "t3.app",
            name: "T3 app",
            levels: { view: "view" },
            settings: [
              {
                id: "updateChannel",
                title: "Update channel",
                values: ["nightly", "daily"],
                default: "weekly",
              },
            ],
          },
        ],
      }),
    ],
    [
      "a list cell that is no column of its list (K-1625)",
      t3([
        {
          ...app,
          lists: [
            {
              id: "tasks",
              title: "Tasks",
              columns: [{ id: "name", title: "Name" }],
              rows: [{ id: "r1", cells: { name: "x", other: "y" } }],
            },
          ],
        },
      ]),
    ],
    [
      "a resource over 64 KB (K-1625)",
      t3([
        {
          ...app,
          facts: Array.from({ length: 20 }, (_, index) => ({ label: `f${index}`, value: "é".repeat(200) })),
          stickers: [],
          lists: [
            {
              id: "big",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
            {
              id: "big2",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
            {
              id: "big3",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
          ],
        },
      ]),
    ],
    [
      "a list row with a command that its kind does not have (K-1625)",
      t3([
        {
          ...app,
          kind: "t3.thread",
          lists: [
            {
              id: "tasks",
              title: "Tasks",
              columns: [{ id: "name", title: "Name" }],
              rows: [{ id: "r1", cells: {}, commands: ["restart"] }],
            },
          ],
        },
      ]),
    ],
  ])("refuses %s", (_, report) => {
    expect(reportProblem(report, [], new Set(), new Set())).not.toBeNull();
  });

  it("refuses a site name that kitshn, sites.json or another provider holds", () => {
    const withSite = t3([{ ...app, site: { name: "shared", port: 3773 } }]);
    expect(reportProblem(withSite, [], new Set(["shared"]), new Set())).toMatch(/in use/);
    // K-817: a name of kitshn itself would put a second Access app on that host.
    expect(reportProblem(withSite, [], new Set(), new Set(["shared"]))).toMatch(/name of kitshn itself/);
    const other = { ...withSite, name: "other", kinds: [], commands: [] };
    expect(reportProblem(withSite, [other], new Set(), new Set())).toMatch(/belongs to the provider other/);
  });

  it("refuses more than 500 cards on one machine", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ ...app, id: `a${index}` }));
    expect(reportProblem(t3(many), [{ ...t3(many), name: "other" }], new Set(), new Set())).toMatch(
      /more than 500/,
    );
  });

  it("decodes a register line and refuses a provider name that kitshn's kinds use (K-302)", () => {
    const line = (provider: string) =>
      JSON.stringify({ id: "1", type: "register", provider, kinds: [], commands: [], resources: [] });
    expect(readRequest(line("t3"))).toMatchObject({
      ok: true,
      request: { type: "register", provider: "t3" },
    });
    expect(readRequest(line("site"))).toMatchObject({ ok: false, answer: { id: "1", type: "error" } });
  });

  it("keeps client apps with an open link of an app scheme, and drops each other one with a problem (K-720)", () => {
    const keep = (clients: Array<unknown>) => {
      const problems: Array<ProviderProblem> = [];
      return { kept: decodeClients(clients, problems).map((client) => client.id), problems };
    };
    const client = (open: string, id = "t3code-fork") => ({ id, name: "T3 Code (fork)", open, install: [] });
    expect(keep([client("t3code-preview://connections/new?inviteUrl={inviteUrl}")]).kept).toEqual([
      "t3code-fork",
    ]);
    expect(keep([client("T3code+x.y://new?u={inviteUrl}")]).kept).toEqual(["t3code-fork"]);
    const install = (url: string) => ({
      id: "t3code",
      name: "T3 Code",
      open: "t3code://x?u={inviteUrl}",
      install: [{ label: "Get", url }],
    });
    expect(keep([install("https://play.google.com/store")]).kept).toEqual(["t3code"]);
    for (const url of ["http://play.google.com/", "https://evil/?u={inviteUrl}", "market://details"])
      expect(keep([install(url)]), url).toMatchObject({ kept: [], problems: [{ path: "clients[0]" }] });
    const many = Array.from({ length: 5 }, (_, index) => client("t3code://x?u={inviteUrl}", `c${index}`));
    expect(keep(many)).toMatchObject({ kept: ["c0", "c1", "c2", "c3"], problems: [{ path: "clients[4]" }] });
    for (const open of [
      "javascript:alert(1)//{inviteUrl}",
      "https://example.com/add?u={inviteUrl}",
      "intent://x#Intent;S.browser_fallback_url=https%3A%2F%2Fevil%2F%3Fu%3D{inviteUrl};end",
      "x-safari-https://evil/?u={inviteUrl}",
      "googlechromes://evil/?u={inviteUrl}",
      "microsoft-edge:https://evil/?u={inviteUrl}",
      "market://details?u={inviteUrl}",
      "wss://evil/{inviteUrl}",
      "1app://x/{inviteUrl}",
      "data:text/html,{inviteUrl}",
      "http://example.com/{inviteUrl}",
      "t3code://connections/new",
      "{inviteUrl}",
      "t3code:// bad host/{inviteUrl}",
    ])
      expect(keep([client(open)]).kept, open).toEqual([]);
  });

  it("keeps a grant table whole when a rule has a type that this reader does not know (K-706)", () => {
    const grant = {
      circle: {
        id: "her",
        name: "Her",
        match: "all",
        needsPasskey: false,
        rules: [{ email: "a@b.c" }, { future: 1 }],
      },
      level: "send",
      endsAt: null,
    };
    expect(Schema.decodeUnknownSync(GrantTables)({ a: [grant] })).toMatchObject({
      a: [{ circle: { rules: [{ email: "a@b.c" }, { unknown: "future" }] } }],
    });
  });

  it("takes a desired state part only for a kind with state, and at most 64 KB (K-709)", () => {
    const kinds = [{ id: "t3.settings", name: "settings", levels: {}, state: {} }, t3([]).kinds[0]!];
    expect(desiredProblem(kinds, "t3.settings", { theme: "dark" })).toBeNull();
    expect(desiredProblem(kinds, "t3.app", {})).toMatch(/no desired state/);
    expect(desiredProblem(kinds, "t3.settings", "x".repeat(70_000))).toMatch(/at most/);
  });

  it("drops only the bad row, fact or resource of a register, and names each by its path (protocol 2)", () => {
    const row = (id: string) => ({ id, cells: { name: "x" } });
    const raw = [
      {
        id: "app",
        kind: "t3.app",
        name: "T3",
        status: "running",
        facts: [
          { label: "ok", value: "1" },
          { label: "", value: "1" },
        ],
        lists: [
          {
            id: "tasks",
            title: "Tasks",
            columns: [{ id: "name", title: "Name" }],
            rows: [row("a".repeat(150)), row("b".repeat(250))],
          },
        ],
      },
      { id: "bad id!", kind: "t3.app", name: "x", status: "running" },
    ];
    const { resources, problems } = decodeResources(raw);
    expect(resources.map((item) => [item.id, item.facts?.length, item.lists?.[0]?.rows.length])).toEqual([
      ["app", 1, 1],
    ]);
    expect(problems.map((problem) => problem.path)).toEqual([
      "resources[0].facts[1]",
      "resources[0].lists[0].rows[1]",
      "resources[1]",
    ]);
    expect(problems.every((problem) => problem.reason.endsWith("dropped"))).toBe(true);
  });

  it("screens a resource with an unknown kind or parent, and a row with an unknown command, out of a report (protocol 2)", () => {
    const report = t3([
      {
        id: "app",
        kind: "t3.app",
        name: "T3",
        status: "running",
        lists: [
          {
            id: "l",
            title: "L",
            columns: [{ id: "c", title: "C" }],
            rows: [{ id: "r", cells: { c: "x" }, commands: ["nope"] }],
          },
        ],
      },
      { id: "x", kind: "t3.unknown", name: "x", status: "running" },
      { id: "child", kind: "t3.thread", name: "child", status: "running", parent: "x" },
    ]);
    const screened = screenResources(report, [], new Set(), new Set());
    expect(screened.report.resources.map((item) => [item.id, item.lists?.[0]?.rows.length])).toEqual([
      ["app", 0],
    ]);
    expect(screened.problems.map((problem) => problem.reason)).toEqual([
      expect.stringContaining("command nope"),
      expect.stringContaining("kind t3.unknown is unknown"),
      expect.stringContaining("parent x is unknown"),
    ]);
    // kitshn checks a daemon's report with the same rules, so a screened report passes.
    expect(reportProblem(screened.report, [], new Set(), new Set())).toBeNull();
  });

  it("skips an event of a type that it does not know, and throws for a known type that does not match (protocol 2)", () => {
    expect(readAnswer(JSON.stringify({ type: "something-new", x: 1 }))).toBeNull();
    expect(readAnswer(JSON.stringify({ type: "ping", at: 1 }))).toEqual({ type: "ping", at: 1 });
    expect(() => readAnswer(JSON.stringify({ type: "ping" }))).toThrow();
    expect(readRequest(JSON.stringify({ type: "pong" }))).toMatchObject({ ok: true });
  });
});
