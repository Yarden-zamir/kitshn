// K-723: the reference provider, the smallest one that keeps the contract: it starts `kitshn provider`, registers
// with protocol 2, answers each ping, drops a daemon that sent nothing for the grace time, and starts again.
import { spawn } from "node:child_process";

function connect() {
  const bridge = spawn("kitshn", ["provider"], { stdio: ["pipe", "pipe", "inherit"] });
  let graceMs = 45_000;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  // Any line from the daemon counts as alive; none for the grace time means a stopped daemon.
  const alive = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => bridge.kill("SIGTERM"), graceMs);
  };
  const send = (line: object) => bridge.stdin.write(`${JSON.stringify(line)}\n`);
  let buffer = "";
  bridge.stdout.on("data", (chunk: Buffer) => {
    buffer += String(chunk);
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const event = JSON.parse(buffer.slice(0, end)) as { type: string; graceMs?: number };
      buffer = buffer.slice(end + 1);
      alive();
      if (event.type === "register" && typeof event.graceMs === "number") graceMs = event.graceMs;
      // Every other event type, also an unknown one, is skipped.
      if (event.type === "ping") send({ type: "pong" });
    }
  });
  bridge.on("exit", () => {
    if (quiet) clearTimeout(quiet);
    setTimeout(connect, 100);
  });
  send({
    id: "1",
    type: "register",
    protocol: 2,
    provider: "ref",
    instance: "reference",
    kinds: [{ id: "ref.app", name: "app", levels: { view: "view", use: "use", control: "control" } }],
    commands: [],
    resources: [{ id: "app", kind: "ref.app", name: "Reference", status: "running" }],
  });
  alive();
}

connect();
