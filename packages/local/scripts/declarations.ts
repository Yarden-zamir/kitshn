// The declarations keep the `.ts` imports of the source; a consumer of the packed files reads `.js` (K-723).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
for (const name of readdirSync(dist).filter((file) => file.endsWith(".d.ts"))) {
  const file = new URL(name, dist);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll('.ts";', '.js";'));
}
