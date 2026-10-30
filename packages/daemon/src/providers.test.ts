import type { ProviderRequest } from "@kitshn/local";
import { pushKey } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { NEVER_CONNECTED, type ProviderCaller, Providers, type SavedFile, parseSaved } from "./providers.ts";

const kinds = [
  { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
  { id: "t3.app", name: "app", levels: { view: "view", use: "use", control: "control" } },
] as const;
const thread = (id: string, more: object = {}) => ({
  id,
  kind: "t3.thread",
  name: id,
  status: "running",
  ...more,
});
const register = (
  resources: ReadonlyArray<unknown>,
  extra: Partial<Extract<ProviderRequest, { type: "register" }>> = {},
): Extract<ProviderRequest, { type: "register" }> => ({
  id: "1",
  type: "register",
  protocol: 2,
  provider: "t3",
  instance: "env-1",
  kinds: [...kinds],
  commands: [],
  resources: [...resources],
  ...extra,
});
const caller = (connection: number, more: Partial<ProviderCaller> = {}): ProviderCaller => ({
  connection,
  uid: 1000,
  privileged: true,
  takenSites: new Set(),
  machineName: "vps",
  ...more,
});

function providers(startedAt?: number, saved: Partial<SavedFile> = {}) {
  const files: Array<SavedFile> = [];
  let statusChanges = 0;
  const registry = new Providers(
    parseSaved({ providers: [], pushed: {}, ...saved }).saved,
    (file) => files.push(file),
    () => statusChanges++,
    startedAt,
  );
  return { registry, files, statusChanges: () => statusChanges };
}

describe("the providers of a machine (K-704, K-705)", () => {
  it("is online while a connection holds it, keeps no online flag in its file, and says since when one is offline", () => {
    const { registry, files } = providers();
    expect(registry.offline()).toEqual([]);
    registry.register(register([thread("a")]), caller(1, { now: 100 }));
    expect(registry.states()).toMatchObject([{ name: "t3", instance: "env-1", online: true, since: 100 }]);
    expect(files.at(-1)?.providers[0]).not.toHaveProperty("online");
    registry.disconnect(1, 500);
    expect(registry.offline()).toEqual([{ provider: "t3", reason: "the connection closed", at: 500 }]);
    // After a daemon start, a kept provider is offline until it registers, and says that it never connected.
    const restarted = providers(700, files.at(-1)).registry;
    expect(restarted.offline()).toEqual([{ provider: "t3", reason: NEVER_CONNECTED, at: 700 }]);
    expect(restarted.states()).toMatchObject([{ online: false, since: null }]);
  });

  it("refuses another protocol with a reason that names both, and a register without an instance (C-2)", () => {
    const { registry } = providers();
    expect(registry.register(register([], { protocol: 3 }), caller(1))).toMatchObject({
      ok: false,
      error: /protocol 2; this register says 3/,
    });
    const { instance: _instance, ...noInstance } = register([]);
    expect(registry.register(noInstance, caller(1))).toMatchObject({
      ok: false,
      error: /names its instance/,
    });
    expect(registry.refused()[0]?.reason).toMatch(/instance/);
  });

  it("takes a register with one bad row or resource, drops only those, and names each path (C-3)", () => {
    const { registry } = providers();
    const list = (rows: Array<object>) => ({
      id: "tasks",
      title: "Tasks",
      columns: [{ id: "n", title: "N" }],
      rows,
    });
    const outcome = registry.register(
      register([
        thread("a", {
          lists: [
            list([
              { id: "ok", cells: { n: "1" } },
              { id: "x".repeat(201), cells: { n: "2" } },
            ]),
          ],
        }),
        thread("b", { parent: "gone" }),
        { id: "bad id!", kind: "t3.thread", name: "x", status: "running" },
      ]),
      caller(1),
    );
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok && outcome.problems.map((problem) => problem.path)).toEqual([
      "resources[0].lists[0].rows[1]",
      "resources[2]",
      "resources[1]",
    ]);
    expect(
      registry.reportOf("t3")?.resources.map((resource) => [resource.id, resource.lists?.[0]?.rows.length]),
    ).toEqual([["a", 1]]);
    expect(registry.states()[0]?.problems).toHaveLength(3);
    // An upsert drops its bad resource the same way and keeps the rest.
    expect(
      registry.change(
        {
          id: "2",
          type: "upsert",
          provider: "t3",
          resources: [thread("c", { parent: "nope" }), thread("d")],
        },
        caller(1),
      ),
    ).toMatchObject({
      ok: true,
      problems: [{ path: "resources[id=c]", reason: expect.stringContaining("parent nope") }],
    });
    expect(registry.reportOf("t3")?.resources.map((resource) => resource.id)).toEqual(["a", "d"]);
  });

  it("refuses a second instance while the first holds the provider, and lets the same instance take over (C-4, C-5)", () => {
    const { registry } = providers();
    registry.register(register([thread("a")]), caller(1));
    expect(registry.register(register([thread("a")], { instance: "env-2" }), caller(2))).toMatchObject({
      ok: false,
      error: /connected as the instance env-1/,
    });
    // The first keeps working, and its status names the try; no "provider refused" for the running one.
    expect(registry.connectionOf("t3")).toBe(1);
    // One connection holds one provider.
    expect(registry.register(register([], { provider: "grok", kinds: [] }), caller(1))).toMatchObject({
      ok: false,
      error: /holds the provider t3/,
    });
    expect(registry.refused()).toEqual([]);
    expect(registry.states()[0]?.refusal).toMatch(/env-2 tried to register/);
    expect(registry.register(register([thread("a")]), caller(3))).toMatchObject({ ok: true, replaced: 1 });
    expect([registry.connectionOf("t3"), registry.providerOf(3), registry.providerOf(1)]).toEqual([
      3,
      "t3",
      null,
    ]);
    expect(registry.change({ id: "2", type: "remove", provider: "t3", ids: ["a"] }, caller(1))).toMatchObject(
      {
        ok: false,
        error: /register t3/,
      },
    );
  });

  it("refuses a whole register only for a broken shape, and keeps the refusal until one is accepted (K-704)", () => {
    const { registry, statusChanges } = providers();
    const bad = register([thread("a"), thread("a")]);
    expect(registry.register(bad, caller(1))).toMatchObject({ ok: false });
    const [first] = registry.refused();
    expect(first).toMatchObject({ provider: "t3", reason: "t3: two resources have the same id." });
    registry.register(bad, caller(1));
    expect(registry.refused()).toEqual([first]);
    expect(statusChanges()).toBe(1);
    expect(registry.register(register([thread("a")]), caller(1))).toMatchObject({ ok: true });
    expect(registry.refused()).toEqual([]);
  });

  it("binds a provider name to the user that registered it, refuses another user, and moves it with rebind (K-704)", () => {
    const { registry, files } = providers();
    const cards = register([thread("a"), thread("b")]);
    expect(registry.register(cards, caller(1, { uid: 0 }))).toMatchObject({ ok: true });
    expect(registry.register(cards, caller(2, { uid: 1002, privileged: false }))).toMatchObject({
      ok: false,
      error: /belongs to the user id 0.*providers rebind t3 --to-user/,
    });
    expect(registry.rebind("t3", 1002)).toBeNull();
    expect(registry.register(cards, caller(3, { uid: 0 }))).toMatchObject({
      ok: false,
      error: /belongs to the user id 1002/,
    });
    expect(registry.register(cards, caller(4, { uid: 1002, privileged: false }))).toMatchObject({ ok: true });
    expect(registry.reportOf("t3")?.resources.map((item) => item.id)).toEqual(["a", "b"]);
    expect(providers(0, files.at(-1)).registry.ownerOf("t3")).toBe(1002);
    expect(registry.rebind("other", 1002)).toMatch(/no provider other/);
    expect(registry.refused()).toEqual([]);
  });

  it("lets only root or the daemon user claim a provider saved before providers had users (K-704)", () => {
    const { registry: old } = providers(0, {
      providers: [{ name: "t3", kinds: [...kinds], commands: [], resources: [thread("a") as never] }],
    });
    expect(old.register(register([thread("a")]), caller(1, { uid: 1002, privileged: false }))).toMatchObject({
      ok: false,
      error: /saved before providers had users/,
    });
    expect(old.register(register([thread("a")]), caller(2, { uid: 0 }))).toMatchObject({ ok: true });
    expect(old.ownerOf("t3")).toBe(0);
  });

  it("names a site that the provider sends without a name, and keeps that name (K-705)", () => {
    const { registry } = providers();
    const app = (id: string) => ({ id, kind: "t3.app", name: id, status: "running", site: { port: 3773 } });
    registry.register(register([app("app")]), caller(1, { machineName: "Oracle VPS" }));
    expect(registry.sites()).toEqual([
      { name: "t3-oracle-vps", target: "http://localhost:3773", dev: false },
    ]);
    // A second site gets its own name; the first keeps its name, also when the machine is renamed.
    registry.register(register([app("app"), app("dev")]), caller(1, { machineName: "renamed" }));
    expect(registry.sites().map((site) => site.name)).toEqual(["t3-oracle-vps", "t3-renamed"]);
  });

  it("gives the saved desired state with its rev source, the reach and the served hosts to a register (K-709, K-1623)", () => {
    const { registry } = providers();
    registry.setPushed(pushKey.desired("t3", "t3.settings"), {
      state: { shared: { theme: "dark" }, machine: null },
      rev: "r1",
    });
    registry.setPushed(pushKey.access("t3"), {
      teamDomain: "team",
      audiences: ["aud"],
      served: ["t3-vps.example.com"],
    });
    expect(registry.savedFor("t3")).toEqual({
      desired: { "t3.settings": { shared: { theme: "dark" }, machine: null } },
      settings: {},
      reach: [],
      served: ["t3-vps.example.com"],
    });
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(true);
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(false);
    expect(registry.grantsOf("t3")).toEqual({ a: [] });
  });

  it("runs exec as the user that registered the provider, unless the owner set another (K-722)", () => {
    const { registry } = providers();
    registry.register(register([]), caller(1, { uid: 1002, privileged: false }));
    expect([registry.execUserOf("t3"), [...registry.providerUsers()]]).toEqual([1002, [1002]]);
    expect(registry.setExecUser("t3", 1003)).toBeNull();
    expect(registry.states()[0]?.execUser).toBe(1003);
    expect(registry.setExecUser("other", 1003)).toMatch(/no provider other/);
  });

  it("forgets only a provider that no connection holds, and starts empty from a broken file (K-704, K-006)", () => {
    const { registry, files } = providers();
    registry.register(register([thread("a")]), caller(1));
    expect(registry.forget("t3")).toMatch(/connected/);
    registry.disconnect(1);
    expect(registry.forget("t3")).toBeNull();
    expect(files.at(-1)?.providers).toEqual([]);
  });

  it("drops only the items of the file that do not decode, and names each (K-006)", () => {
    // The file of a Windows daemon from before the Windows rule: its owner -1 drops, and the good provider loads.
    const windows = parseSaved({
      providers: [{ name: "t3", kinds: [...kinds], commands: [], resources: [thread("a")] }, { name: "site" }],
      pushed: { "grants:t3": {} },
      owners: { t3: -1, grok: 1001 },
      execUsers: { t3: "t3" },
    });
    expect(windows.saved.providers.map((report) => [report.name, report.online])).toEqual([["t3", false]]);
    expect(windows.saved.owners).toEqual({ grok: 1001 });
    expect(windows.saved.execUsers).toEqual({});
    expect(windows.saved.pushed).toEqual({ "grants:t3": {} });
    expect(windows.problems).toEqual([
      expect.stringMatching(/^providers\[1\] dropped/),
      "the owner of t3 dropped: -1 is no user id",
      'the exec user of t3 dropped: "t3" is no user id',
    ]);
    expect(parseSaved("not an object").problems).toEqual(["the file holds no object, so no provider loads"]);
    expect(parseSaved(null)).toEqual({ saved: { providers: [], pushed: {} }, problems: [] });
  });

  it("binds no user on Windows, which has no user ids, and its saved file loads again whole (K-621, K-704)", () => {
    const { registry, files } = providers();
    // A Windows daemon is its own caller with the user id -1 (WINDOWS_UID).
    expect(registry.register(register([thread("a")]), caller(1, { uid: -1 }))).toMatchObject({ ok: true });
    expect(files.at(-1)?.owners).toEqual({});
    const restarted = parseSaved(JSON.parse(JSON.stringify(files.at(-1))));
    expect(restarted.problems).toEqual([]);
    expect(restarted.saved.providers.map((report) => report.name)).toEqual(["t3"]);
    // The next start registers it again with no bind in the way.
    const again = providers(0, files.at(-1)).registry;
    expect(again.register(register([thread("a")]), caller(2, { uid: -1 }))).toMatchObject({ ok: true });
  });
});
