import { describe, expect, it } from "vitest";
import { decodeApps, decodeRecipe } from "./recipe.ts";
import { doorService, pickApp, workerConfig } from "./try.ts";

const deploy = [{ on: "push", name: "prod" }];

describe("kitshn try (K-815)", () => {
  it("gives the Worker the bindings of its deploy, with one SQLite migration per class", () => {
    const recipe = decodeRecipe({
      worker: {
        main: "src/index.ts",
        compatibilityDate: "2026-10-01",
        kv: ["CACHE"],
        durableObjects: { ROOMS: "Room", LOBBY: "Room", USERS: "User" },
        vars: { GREETING: "hi" },
        assets: { folder: "public", runWorkerFirst: ["/api/*"] },
      },
      deploy,
    });
    if (!("worker" in recipe)) throw new Error("a Worker recipe");
    const config = workerConfig(recipe.worker, { module: "/t/worker.js", assets: "/repo/public" });
    expect(config).toMatchObject({
      main: "/t/worker.js",
      no_bundle: true,
      kv_namespaces: [{ binding: "CACHE" }],
      migrations: [{ new_sqlite_classes: ["Room", "User"] }],
      vars: { GREETING: "hi" },
      assets: { binding: "ASSETS", html_handling: "auto-trailing-slash", run_worker_first: ["/api/*"] },
    });
    expect(config.durable_objects.bindings).toHaveLength(3);
  });

  it("publishes the socket of a Compose app on this machine only", () => {
    expect(doorService("/t/s", 4000).services["kitshn-try-door"].ports).toEqual(["127.0.0.1:4000:8080"]);
  });

  it("needs --app when the file has several apps", () => {
    const apps = decodeApps({
      one: { static: { output: "a" }, deploy },
      two: { static: { output: "a" }, deploy },
    });
    expect(() => pickApp(apps, null)).toThrow("--app");
    expect(() => pickApp(apps, "three")).toThrow("no app three");
    expect(pickApp(apps, "two").key).toBe("two");
  });
});
