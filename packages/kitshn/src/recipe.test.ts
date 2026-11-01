import { describe, expect, it } from "vitest";
import { readApps } from "./parse.ts";
import { decodeApps, decodeRecipe, deployOrder, missingNeeds, plan } from "./recipe.ts";

/** The recipe of a `defineApp` file: the app `app` (K-804). */
const readRecipe = (source: string) => (readApps(source) as { readonly app: unknown }).app;

const source = `import { defineApp } from "kitshn";

export default defineApp({
  static: { output: "site" },
  deploy: [
    { on: "push", branch: "main", name: "prod", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});
`;

describe("recipe reader (K-802, K-803)", () => {
  it("reads a literal recipe without running it", () => {
    expect(decodeRecipe(readRecipe(source)).deploy[0]).toEqual({
      on: "push",
      branch: "main",
      name: "prod",
      startsIn: "Everyone",
    });
  });

  it("refuses code that computes, other imports and unknown keys", () => {
    expect(() => readRecipe(source.replace('output: "site"', "output: process.env.OUT"))).toThrow(/computes/);
    expect(() => readRecipe(source.replace('"site"', "`${1}`"))).toThrow(/computes/);
    expect(() => readRecipe(`import fs from "node:fs";\n${source}`)).toThrow(/imports only/);
    expect(() => readRecipe(`${source}\nconsole.log(1);`)).toThrow(/not allowed/);
    expect(() =>
      decodeRecipe(readRecipe(source.replace('output: "site"', 'output: "site", extra: 1'))),
    ).toThrow();
    const compose = (file: string) => ({ compose: { file }, deploy: [{ on: "push", name: "prod" }] });
    expect(decodeRecipe(compose("deploy/compose.yml"))).toMatchObject(compose("deploy/compose.yml"));
    expect(() => decodeRecipe(compose("/etc/compose.yml"))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(compose("../other/compose.yml"))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(compose(""))).toThrow(/inside the repo/);
  });
});

describe("plan (K-807, K-901, K-904)", () => {
  const recipe = decodeRecipe(readRecipe(source));
  const zone = "example.com";

  it("deploys main to the repo address and a pull request one level under the zone", () => {
    expect(
      plan(recipe, "me/Hello_App", { name: "push", branch: "main", pr: null, action: null }, zone),
    ).toMatchObject({
      kind: "deploy",
      environment: "prod",
      address: "hello-app.example.com",
      startsIn: "Everyone",
    });
    expect(
      plan(recipe, "me/hello", { name: "pull_request", branch: "x", pr: 1, action: "opened" }, zone),
    ).toMatchObject({
      kind: "deploy",
      address: "hello-pr-1.example.com",
      ephemeral: true,
    });
  });

  it("tears an ephemeral environment down when its pull request closes, and skips other branches", () => {
    expect(
      plan(recipe, "me/hello", { name: "pull_request", branch: "x", pr: 1, action: "closed" }, zone).kind,
    ).toBe("teardown");
    expect(plan(recipe, "me/hello", { name: "push", branch: "dev", pr: null, action: null }, zone).kind).toBe(
      "skip",
    );
  });

  it("refuses an address outside the zone or two levels deep", () => {
    const deep = decodeRecipe({
      static: { output: "." },
      deploy: [{ on: "push", name: "prod", address: "a.b.example.com" }],
    });
    expect(plan(deep, "me/x", { name: "push", branch: "main", pr: null, action: null }, zone)).toMatchObject({
      kind: "error",
    });
    const outside = decodeRecipe({
      static: { output: "." },
      deploy: [{ on: "push", name: "prod", address: "x.other.com" }],
    });
    expect(
      plan(outside, "me/x", { name: "push", branch: "main", pr: null, action: null }, zone),
    ).toMatchObject({ kind: "error" });
  });

  it("names a pull request environment only after the token's number", () => {
    const sneaky = decodeRecipe({
      static: { output: "site" },
      deploy: [{ on: "pull_request", name: "prod", ephemeral: true }],
    });
    expect(
      plan(sneaky, "me/x", { name: "pull_request", branch: "x", pr: 3, action: "closed" }, "example.com"),
    ).toMatchObject({
      kind: "error",
    });
  });
});

describe("Compose recipes (K-804, K-812)", () => {
  const deploy = [{ on: "push", branch: "main", name: "prod" }];
  it("takes a Compose app with labels", () => {
    expect(decodeRecipe({ compose: { runsOn: ["docker"] }, deploy })).toEqual({
      compose: { runsOn: ["docker"] },
      deploy,
    });
  });
  it("refuses a recipe with two kinds or none", () => {
    expect(() => decodeRecipe({ compose: {}, static: { output: "dist" }, deploy })).toThrow();
    expect(() => decodeRecipe({ deploy })).toThrow();
  });
  it("takes a placement and refuses a bad one at parse time (K-823)", () => {
    const placed = (placement: unknown) => ({ compose: { placement }, deploy });
    for (const placement of ["one", "every", { spread: 1 }, { spread: 10 }])
      expect(decodeRecipe(placed(placement))).toEqual(placed(placement));
    expect(() => decodeRecipe(placed("all"))).toThrow();
    expect(() => decodeRecipe(placed({ spread: 0 }))).toThrow(/from 1 to 10/);
    expect(() => decodeRecipe(placed({ spread: 11 }))).toThrow(/from 1 to 10/);
    expect(() => decodeRecipe(placed({ spread: 1.5 }))).toThrow();
    expect(() => decodeRecipe(placed({ spread: 2, balance: true }))).toThrow();
  });
});

describe("several addresses (K-817)", () => {
  const push = { name: "push", branch: "main", pr: null, action: null } as const;
  const withAddress = (address: string | ReadonlyArray<string>, on: "push" | "pull_request" = "push") =>
    decodeRecipe({ compose: {}, deploy: [{ on, name: on === "push" ? "prod" : "pr-{pr}", address }] });
  const zones = ["onion-climbers.com"];

  it("serves every listed address, the first under the kitshn zone as the main one", () => {
    const recipe = withAddress(["onion-climbers.com", "climbing.example.com", "www.onion-climbers.com"]);
    expect(plan(recipe, "me/climbing", push, "example.com", zones)).toMatchObject({
      kind: "deploy",
      address: "climbing.example.com",
      addresses: ["climbing.example.com", "onion-climbers.com", "www.onion-climbers.com"],
    });
    expect(plan(withAddress("climbing.example.com"), "me/climbing", push, "example.com")).toMatchObject({
      addresses: ["climbing.example.com"],
    });
  });

  it("refuses a list without the kitshn zone, a zone kitshn does not publish on, a deep name and a repeat", () => {
    const refused = (address: ReadonlyArray<string>) =>
      plan(withAddress(address), "me/x", push, "example.com", zones);
    expect(refused(["onion-climbers.com"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("One address must be"),
    });
    expect(refused(["x.example.com", "other.org"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("other.org"),
    });
    expect(refused(["x.example.com", "a.b.onion-climbers.com"])).toMatchObject({ kind: "error" });
    expect(refused(["x.example.com", "x.example.com"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("twice"),
    });
  });

  it("keeps one address for a pull request (K-901)", () => {
    const recipe = withAddress(["a.example.com", "b.example.com"], "pull_request");
    expect(
      plan(recipe, "me/x", { name: "pull_request", branch: "x", pr: 1, action: "opened" }, "example.com"),
    ).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("Only a push entry"),
    });
  });
});

describe("address limit (K-817)", () => {
  it("takes at most 5 addresses, under the API calls of one deploy request", () => {
    const deploy = (count: number) => [
      {
        on: "push",
        name: "prod",
        address: Array.from({ length: count }, (_, index) => `a${index}.example.com`),
      },
    ];
    expect(() => decodeRecipe({ compose: {}, deploy: deploy(5) })).not.toThrow();
    expect(() => decodeRecipe({ compose: {}, deploy: deploy(6) })).toThrow();
  });
});

describe("kitshn's own names (K-817)", () => {
  const push = { name: "push", branch: "main", pr: null, action: null } as const;
  const planOf = (address: ReadonlyArray<string>) =>
    plan(
      decodeRecipe({ compose: {}, deploy: [{ on: "push", name: "prod", address }] }),
      "me/x",
      push,
      "example.com",
    );

  it("refuses the zone apex and kitshn's names as extra addresses", () => {
    for (const extra of [
      "example.com",
      "kit.example.com",
      "pages.example.com",
      "files.example.com",
      "www.example.com",
    ])
      expect(planOf(["x.example.com", extra])).toMatchObject({
        kind: "error",
        reason: expect.stringContaining("keeps for itself"),
      });
    expect(planOf(["x.example.com", "y.example.com"])).toMatchObject({ kind: "deploy" });
  });

  it("refuses kitshn's names as the main address too", () => {
    for (const main of ["kit.example.com", "pages.example.com"])
      expect(planOf([main])).toMatchObject({
        kind: "error",
        reason: expect.stringContaining("keeps for itself"),
      });
  });
});

describe("Worker recipes (K-806)", () => {
  const worker = (app: Record<string, unknown>) => ({
    worker: { main: "worker/index.js", compatibilityDate: "2026-10-01", ...app },
    deploy: [{ on: "push", name: "prod" }],
  });

  it("takes a Worker with assets, KV, Durable Objects, crons and vars", () => {
    const recipe = worker({
      assets: { folder: "site", runWorkerFirst: ["/api/*"] },
      kv: ["STATS"],
      durableObjects: { ROOMS: "Room" },
      crons: ["*/30 * * * *"],
      vars: { MODE: "live" },
    });
    expect(decodeRecipe(recipe)).toEqual(recipe);
  });

  it("refuses place fields, paths outside the repo and a binding name used twice", () => {
    expect(() => decodeRecipe(worker({ name: "github-stats" }))).toThrow();
    expect(() => decodeRecipe(worker({ routes: ["x.example.com"] }))).toThrow();
    expect(() => decodeRecipe(worker({ main: "../other/index.js" }))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(worker({ assets: { folder: "/srv" } }))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(worker({ kv: ["DATA"], vars: { DATA: "x" } }))).toThrow(/DATA is used twice/);
    expect(() => decodeRecipe(worker({ assets: { folder: "site" }, kv: ["ASSETS"] }))).toThrow(/twice/);
    expect(() => decodeRecipe(worker({ kv: ["not-an-identifier"] }))).toThrow();
    expect(() => decodeRecipe(worker({ crons: ["daily"] }))).toThrow();
    expect(() => decodeRecipe(worker({ compatibilityDate: "October" }))).toThrow();
  });

  it("refuses a recipe with a Worker and another kind", () => {
    expect(() => decodeRecipe({ ...worker({}), static: { output: "site" } })).toThrow();
  });
});

describe("several apps per repo (K-804, K-820)", () => {
  const app = (needs?: ReadonlyArray<string>) => ({
    static: { output: "site" },
    deploy: [{ on: "push", name: "prod" }],
    ...(needs ? { needs: { apps: needs } } : {}),
  });

  it("reads defineApps by key, and defineApp as the app `app`", () => {
    const source = `import { defineApps } from "kitshn";
export default defineApps({ app: { static: { output: "public" }, deploy: [{ on: "push", name: "prod" }] }, cv: { static: { output: "cv" }, deploy: [{ on: "push", name: "prod" }], needs: { apps: ["app"] } } });
`;
    expect(Object.keys(decodeApps(readApps(source)))).toEqual(["app", "cv"]);
    expect(
      Object.keys(
        readApps(
          `import { defineApp } from "kitshn";\nexport default defineApp(${JSON.stringify(app())});`,
        ) as object,
      ),
    ).toEqual(["app"]);
  });

  it("deploys each app after the apps it needs, ties by key", () => {
    expect(deployOrder({ web: app(["api"]), api: app(["db"]), db: app(), docs: app() })).toEqual({
      order: ["db", "api", "docs", "web"],
    });
  });

  it("refuses an unknown key, an app that names itself and a cycle when the recipe loads", () => {
    expect(() => decodeApps({ web: app(["api"]) })).toThrow(/no app has that key/);
    expect(() => decodeApps({ web: app(["web"]) })).toThrow(/needs itself/);
    expect(() => decodeApps({ a: app(["b"]), b: app(["a"]) })).toThrow(/cycle/);
    expect(() => decodeApps({ "my-app": app() })).toThrow();
    expect(() => decodeApps({})).toThrow();
    // K-808: `vars` and `secrets` join `needs` later; until then the schema refuses them.
    expect(() => decodeApps({ web: { ...app(), needs: { vars: ["TOKEN"] } } })).toThrow();
  });

  it("skips an app when an app it needs failed or was skipped, and counts nothing to do as deployed", () => {
    const results = new Map([
      ["db", "done"],
      ["api", "failed"],
      ["queue", "skipped"],
    ] as const);
    expect(missingNeeds(app(["db"]), results)).toEqual([]);
    expect(missingNeeds(app(["db", "api", "queue"]), results)).toEqual(["api", "queue"]);
    expect(missingNeeds(app(), results)).toEqual([]);
  });

  it("puts the key in the default address of every app but `app`", () => {
    const event = { name: "pull_request", branch: "x", pr: 31, action: "opened" } as const;
    const preview = {
      static: { output: "cv" },
      deploy: [{ on: "pull_request", name: "pr-{pr}", ephemeral: true }],
    } as const;
    expect(plan(preview, "Yarden-zamir/me", event, "yarden-zamir.com", [], "cv")).toMatchObject({
      address: "me-cv-pr-31.yarden-zamir.com",
    });
    expect(plan(preview, "Yarden-zamir/me", event, "yarden-zamir.com")).toMatchObject({
      address: "me-pr-31.yarden-zamir.com",
    });
  });
});
