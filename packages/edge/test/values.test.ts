import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { setup } from "./machine-http.ts";

/** The parts of the Durable Object that this test calls. */
interface Instance {
  readonly state: { readonly machines: ReadonlyMap<string, Machine> };
  jobValuesAnswer(
    machine: Machine,
    jobId: unknown,
  ): Promise<{ values: Record<string, string> } | { error: string }>;
  setValue(caller: unknown, ref: string, name: string, body: unknown): Promise<Response>;
  load(): void;
}

const OWNER = {
  visitor: { email: "owner@example.com", clientId: null },
  actor: { _tag: "person", email: "owner@example.com" },
};

it("gives the values of a Compose job only to the machine that runs it, of an allowed repo, outside the pause (K-833)", async () => {
  await setup({});
  const stub = env.KITSHN.getByName("kitshn");
  const answers = await runInDurableObject(stub, async (object, state) => {
    const instance = object as unknown as Instance;
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen) VALUES ('3001', 'acme/api', 'allowed', 1)",
    );
    sql.exec(
      "INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, kind, sha, state, expires_at, branch, app, app_key) VALUES ('d1', 'acme/api', '3001', 'prod', 'app-api', 'api.example.com', 'kitshn-app-api', 'deploy', 'abc', 'done', 0, 'main', 'compose', 'app')",
    );
    instance.load();
    const set = await instance.setValue(OWNER, "3001:app:prod", "API_KEY", {
      kind: "secret",
      value: "s3cret",
    });
    expect(set.status, await set.clone().text()).toBe(200);
    const used = JSON.stringify([{ name: "API_KEY", kind: "secret", source: "kitshn", version: null }]);
    const command = JSON.stringify({ kind: "compose", project: "app-api", deployId: "d1" });
    const job = (state: string, machine: string) =>
      sql
        .exec<{ id: number }>(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, values_used, values_set)
           VALUES (?, '[]', ?, ?, 0, 9999999999999, '{}', '{}', NULL, '', ?, '3001:app:prod') RETURNING id`,
          machine,
          command,
          state,
          used,
        )
        .one().id;
    const vps = instance.state.machines.get("vps");
    if (!vps) throw new Error("setup made no machine vps");
    const other: Machine = { ...vps, id: "other" };
    const running = job("sent", "vps");
    const queued = job("queued", "vps");
    const result = {
      running: await instance.jobValuesAnswer(vps, running),
      queued: await instance.jobValuesAnswer(vps, queued),
      other: await instance.jobValuesAnswer(other, running),
      blocked: null as unknown,
    };
    sql.exec("UPDATE repos SET state = 'blocked' WHERE repo_id = '3001'");
    result.blocked = await instance.jobValuesAnswer(vps, running);
    return result;
  });
  expect(answers.running).toEqual({ values: { API_KEY: "s3cret" } });
  expect(answers.queued).toMatchObject({ error: expect.any(String) });
  expect(answers.other).toMatchObject({ error: expect.any(String) });
  expect(answers.blocked).toMatchObject({ error: expect.stringContaining("blocked") });
});
