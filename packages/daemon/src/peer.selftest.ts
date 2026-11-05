// CI only (edge.yml): a compiled binary reads the peer user id through the daemon's own code (K-701). It fails
// when a Bun upgrade drops the undocumented `socket.fd` or breaks `bun:ffi`. The shipped daemon never includes it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askLocal, listenLocal } from "./local.ts";
import { peerDecision } from "./peer.ts";

const own = process.getuid!();
const platform = process.platform === "darwin" ? "darwin" : "linux";
const path = join(mkdtempSync(join(tmpdir(), "kitshn-selftest-")), "kitshn", "kitshn.sock");
let seen: number | null = null;
const server = await listenLocal(path, {
  platform,
  decide: (peer) => {
    seen = peer;
    return peerDecision(peer, own, []);
  },
  handle: () => Promise.resolve({ id: "selftest", type: "reconnect" }),
  log: console.log,
  access: "private",
});
// The client side reads the peer user id too, before it sends (K-701).
const outcome = await askLocal(path, { id: "selftest", type: "reconnect" }, 5000, {
  platform,
  daemonUid: own,
}).catch((error: unknown) => {
  console.error(`kitshn self-test: ${String(error)}`);
  return null;
});
server.stop();
if (seen !== own || outcome?.kind !== "answer") {
  console.error(
    `kitshn self-test failed: peer user id ${String(seen)}, own ${own}, outcome ${JSON.stringify(outcome)}`,
  );
  process.exit(1);
}
console.log(
  `kitshn self-test: the compiled binary read the peer user id ${seen} (${process.platform} ${process.arch}).`,
);
