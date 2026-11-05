// K-724: records the wire schema with KITSHN_PROTOCOL in protocol.lock.json, after `protocol.test.ts` failed for a
// wire change. It refuses a version that is too small a bump for the change.
//   pnpm --filter @kitshn/local run protocol-lock
import { readFileSync, writeFileSync } from "node:fs";
import { KITSHN_PROTOCOL } from "../src/protocol.ts";
import { bumpProblem, wireChange, wireSchema } from "../src/wire.ts";

const file = new URL("../protocol.lock.json", import.meta.url);
const lock = JSON.parse(readFileSync(file, "utf8")) as { version: string; wire: unknown };
const wire = wireSchema();
const problem = bumpProblem(lock.version, KITSHN_PROTOCOL, wireChange(lock.wire, wire));
if (problem !== null) {
  console.error(`protocol-lock: ${problem}. Set KITSHN_PROTOCOL in packages/local/src/protocol.ts (K-724).`);
  process.exit(1);
}
writeFileSync(file, `${JSON.stringify({ version: KITSHN_PROTOCOL, wire }, null, 2)}\n`);
console.log(`protocol-lock: ${lock.version} -> ${KITSHN_PROTOCOL}`);
