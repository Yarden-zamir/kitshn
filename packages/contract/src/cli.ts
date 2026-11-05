#!/usr/bin/env node
// K-723: `kitshn-contract --daemon <command> [--provider <command>]` runs the contract scenarios against a real
// daemon. Without --provider the reference provider runs C-1 to C-18; with it, the scenarios of a provider under
// test. It exits 0 when every scenario passes.
import { daemon } from "./daemon.ts";
import { providerScenarios } from "./provider.ts";
import { ELSEWHERE, SCENARIOS, type Scenario } from "./scenarios.ts";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const command = value("--daemon");
if (!command) {
  console.error('usage: kitshn-contract --daemon "<command that runs the daemon>" [--provider "<command>"]');
  process.exit(2);
}
const providerCommand = value("--provider");
const only = value("--only");
const scenarios: ReadonlyArray<Scenario> = (
  providerCommand ? providerScenarios(providerCommand) : SCENARIOS
).filter((scenario) => only === undefined || scenario.id === only);

let failed = 0;
for (const scenario of scenarios) {
  // Each scenario gets a new daemon in a new home, so no state leaks between them.
  const instance = await daemon(command);
  const started = Date.now();
  try {
    await instance.start();
    await scenario.run(instance);
    console.log(`ok   ${scenario.id} ${scenario.title} (${Date.now() - started} ms)`);
  } catch (error) {
    failed++;
    console.log(
      `FAIL ${scenario.id} ${scenario.title}\n     ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await instance.stop();
  }
}
if (!providerCommand)
  for (const [id, where] of Object.entries(ELSEWHERE)) console.log(`elsewhere ${id}: ${where}`);
console.log(
  failed === 0 ? `${scenarios.length} scenarios passed` : `${failed} of ${scenarios.length} failed`,
);
process.exit(failed === 0 ? 0 : 1);
