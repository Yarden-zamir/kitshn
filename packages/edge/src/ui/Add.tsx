import { deployWorkflow } from "kitshn/templates";
import { useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import { RESERVED_SITE_NAMES } from "../core/library.ts";
import type { Resource } from "../core/model.ts";
import { type ServerReport, type SiteInput, parseSiteInput } from "../core/sites.ts";
import { Radio, Switch } from "./controls.tsx";
import { PortForm } from "./Ports.tsx";
import { LiveFrame } from "./Peek.tsx";
import { callApi } from "./store.ts";

const isName = (name: string) =>
  name.length > 0 &&
  name.length <= 40 &&
  !name.startsWith("-") &&
  !name.endsWith("-") &&
  [...name].every((c) => c === "-" || (c >= "a" && c <= "z") || (c >= "0" && c <= "9"));

const RECIPE = `import { defineApp } from "kitshn";

export default defineApp({
  // The build runs in GitHub Actions; leave it out when the repo has the site files already.
  static: { build: "npm ci && npm run build", output: "dist" },
  deploy: [
    { on: "push", branch: "main", name: "prod" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});`;

function Snippet(props: { file: string; text: string }) {
  return (
    <div>
      <div class="row">
        <code>{props.file}</code>
        <button
          type="button"
          class="btn"
          data-tip={`Copy ${props.file} to the clipboard.`}
          onClick={() => void navigator.clipboard.writeText(props.text)}
        >
          Copy
        </button>
      </div>
      <pre class="command">{props.text}</pre>
    </div>
  );
}

/** K-1131: a name for the site from the page title or the process: lowercase letters, digits and dashes. */
const nameFrom = (text: string) =>
  [...text.toLowerCase()]
    .map((c) => ((c >= "a" && c <= "z") || (c >= "0" && c <= "9") ? c : "-"))
    .join("")
    .split("-")
    .filter((part) => part !== "")
    .join("-")
    .slice(0, 40);

/** K-1131, K-212: the end choices of a new site; a local preview starts with 1 h. */
const HOUR = 60 * 60 * 1000;
const SITE_TIMES = [
  { label: "1 h", flag: "1h", ms: HOUR },
  { label: "4 h", flag: "4h", ms: 4 * HOUR },
  { label: "1 day", flag: "1d", ms: 24 * HOUR },
  { label: "Until I stop it", flag: null, ms: null },
] as const;

/** K-805, K-1104, K-1131, K-619: a static site from a repo, or a live site from a running server of a machine. */
export function AddSite(props: {
  zone: string;
  machines: ReadonlyArray<MachineView>;
  /** K-1131: the address or port that a drop on the map brought, or "". */
  initial: string;
  /** K-1131: the card whose address an https URL names, if any. */
  cardOf: (host: string) => Resource | null;
  onShowCard: (card: Resource) => void;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [kind, setKind] = useState<"live" | "static" | "port">("live");
  const online = props.machines.filter((view) => view.online);
  const [text, setText] = useState(props.initial);
  const input = parseSiteInput(text);
  const port = input.kind === "port" ? input.port : null;
  const [picked, setPicked] = useState("");
  // The machine that the owner picked while it is online; else the one where the port listens; else the first.
  const machineId = online.some((view) => view.machine.id === picked)
    ? picked
    : (online.find((view) => view.servers.some((server) => server.port === port))?.machine.id ??
      online[0]?.machine.id ??
      "");
  const machine = online.find((view) => view.machine.id === machineId) ?? null;
  const server = machine?.servers.find((each) => each.port === port) ?? null;
  const [name, setName] = useState("");
  const shownName = name || nameFrom(server?.title ?? server?.process ?? "");
  const [dev, setDev] = useState(false);
  const [time, setTime] = useState<(typeof SITE_TIMES)[number]["flag"]>("1h");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remote = input.kind === "remote" ? props.cardOf(input.host) : null;
  const taken = props.cardOf(`${shownName}.${props.zone}`);
  const share = async () => {
    const problem = !machineId
      ? "Pick a machine that is online."
      : input.kind !== "port" && input.kind !== "socket"
        ? input.kind === "invalid"
          ? input.reason
          : "kitshn shares servers of joined machines. Type a port of one, such as 5173."
        : !isName(shownName)
          ? "A name has 1 to 40 lowercase letters, digits and dashes."
          : RESERVED_SITE_NAMES.has(shownName)
            ? `${shownName}.${props.zone} belongs to kitshn itself. Pick another name.`
            : taken
              ? `${shownName}.${props.zone} is the card ${taken.name} already. Pick another name.`
              : null;
    if (problem) return setError(problem);
    setBusy(true);
    const after = SITE_TIMES.find((each) => each.flag === time)?.ms ?? null;
    const result = await callApi<{ id: number }>("POST", "/api/sites/live", {
      machineId,
      server: text,
      name: shownName,
      dev,
      endsAt: after === null ? null : Date.now() + after,
    });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onDone(
      `The machine shares ${shownName}.${props.zone} when its daemon picks it up. The card waits in the tray${after === null ? "" : `, and leaves every circle after ${SITE_TIMES.find((each) => each.flag === time)?.label ?? ""}`}.`,
    );
    props.onClose();
  };
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Add a site">
        <h2>Add a site</h2>
        <div class="seg">
          <button
            type="button"
            aria-pressed={kind === "live"}
            data-tip="Live: a local server of a machine, through its tunnel, while the machine is on."
            onClick={() => setKind("live")}
          >
            Live, from a machine
          </button>
          <button
            type="button"
            aria-pressed={kind === "static"}
            data-tip="Static: GitHub Actions builds the repo and kitshn serves the files."
            onClick={() => setKind("static")}
          >
            Static, from a repo
          </button>
          <button
            type="button"
            aria-pressed={kind === "port"}
            data-tip="Ports: a service on a machine, such as a game server, with ports that each player opens for their own address (K-2001)."
            onClick={() => setKind("port")}
          >
            Ports
          </button>
        </div>
        {kind === "port" ? (
          <PortForm
            zone={props.zone}
            machines={props.machines}
            onClose={props.onClose}
            onDone={props.onDone}
          />
        ) : kind === "live" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void share();
            }}
          >
            <p class="help">
              A local server of a machine, through its tunnel. It is live only while the machine is on.
            </p>
            <div class="field-row">
              <span
                class="label"
                data-tip="Server: a port, an address such as localhost:5173, or a socket path."
              >
                Server
              </span>
              <div>
                <input
                  class="field"
                  value={text}
                  aria-label="Server"
                  data-tip="A port, an address such as localhost:5173 or http://127.0.0.1:5173/, or a socket path."
                  placeholder="5173, localhost:5173 or /run/app.sock"
                  onInput={(event) => {
                    setText(event.currentTarget.value);
                    setError(null);
                  }}
                />
                <SiteUnderstood
                  input={input}
                  machine={machine?.machine.name ?? null}
                  remote={remote}
                  onShowCard={props.onShowCard}
                />
              </div>
            </div>
            <RunningServers
              machines={online}
              port={port}
              machineId={machineId}
              onPick={(view, picked) => {
                setText(String(picked.port));
                setPicked(view.machine.id);
                setError(null);
              }}
            />
            <div class="field-row">
              <span class="label" data-tip="Machine: the online machine that runs the local server.">
                Machine
              </span>
              {online.length === 0 ? (
                <span class="help">No machine is online. Start a daemon first.</span>
              ) : (
                <div class="choices" role="radiogroup" aria-label="Machine">
                  {online.map((view) => (
                    <Radio
                      key={view.machine.id}
                      name="site-machine"
                      checked={view.machine.id === machineId}
                      label={view.machine.name}
                      tip={`Share a server of ${view.machine.name}.`}
                      onSelect={() => setPicked(view.machine.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            {port !== null && machine ? <SitePreview port={port} machine={machine} server={server} /> : null}
            <div class="field-row">
              <span class="label" data-tip="Name: the first part of the address of the site.">
                Name
              </span>
              <div>
                <input
                  class="field"
                  value={shownName}
                  aria-label="Name"
                  data-tip="The name of the site: 1 to 40 lowercase letters, digits and dashes. It is the first part of the address."
                  placeholder="my-app"
                  onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
                />
                <p class="help">
                  At <code>{(shownName || "name") + "." + props.zone}</code>
                </p>
              </div>
            </div>
            <div class="field-row">
              <span
                class="label"
                data-tip="Time: at the end, the card leaves every circle for the tray (K-212)."
              >
                Time
              </span>
              <div class="pills" role="radiogroup" aria-label="Time">
                {SITE_TIMES.map((each) => (
                  <button
                    key={each.label}
                    type="button"
                    aria-pressed={time === each.flag}
                    data-tip={
                      each.flag
                        ? `${each.label}: after ${each.label}, the card leaves every circle for the tray.`
                        : "Until I stop it: no end time."
                    }
                    onClick={() => setTime(each.flag)}
                  >
                    {each.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="field-row">
              <span class="label" data-tip="Dev: whether the server is a dev server such as Vite.">
                Dev
              </span>
              <div>
                <Switch
                  checked={dev}
                  label="A dev server"
                  tip="A dev server: kitshn sends Host: localhost, because Vite and similar servers refuse other hosts."
                  onChange={setDev}
                />
                <p class="help">
                  Vite and similar servers refuse other hosts, so kitshn sends <code>Host: localhost</code>.
                </p>
              </div>
            </div>
            {error ? <p class="error">{error}</p> : null}
            <div class="row">
              <button
                class="btn primary"
                disabled={busy || online.length === 0}
                data-tip="Send the machine a job that shares the server. The card then waits in the tray, private."
              >
                Share it
              </button>
              <button
                type="button"
                class="btn"
                data-tip="Close this dialog; nothing changes."
                onClick={props.onClose}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p class="help">
              Add these two files to the repo and push to main. GitHub Actions deploys it, and its card lands
              in the tray, private, until you place it in a circle.
            </p>
            <Snippet file="kitshn.config.ts" text={RECIPE} />
            <Snippet file=".github/workflows/kitshn.yml" text={deployWorkflow(location.origin)} />
            <div class="row">
              <button type="button" class="btn" data-tip="Close this dialog." onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** K-1131: what kitshn understood from the Server field, in words, with what it left out. */
function SiteUnderstood(props: {
  input: SiteInput;
  machine: string | null;
  remote: Resource | null;
  onShowCard: (card: Resource) => void;
}) {
  const { input } = props;
  if (input.kind === "invalid") return <p class="help">{input.reason}</p>;
  if (input.kind === "socket") return <p class="help">The Unix socket {input.path}.</p>;
  if (input.kind === "remote")
    return props.remote ? (
      <p class="help">
        {input.host} is the card {props.remote.name}.{" "}
        <button
          type="button"
          class="btn"
          data-tip={`Close this dialog and show ${props.remote.name} on the map.`}
          onClick={() => props.remote && props.onShowCard(props.remote)}
        >
          Show it
        </button>
      </p>
    ) : (
      <p class="error">
        {input.host} is another host. kitshn shares servers of joined machines, such as localhost:5173.
      </p>
    );
  return (
    <p class="help">
      Port {input.port}
      {props.machine ? ` on ${props.machine}` : ""}. {input.notes.join(" ")}
    </p>
  );
}

/** K-619: the servers that listen on each online machine, by its last scan; a click picks one. */
function RunningServers(props: {
  machines: ReadonlyArray<MachineView>;
  port: number | null;
  machineId: string;
  onPick: (view: MachineView, server: ServerReport) => void;
}) {
  const withServers = props.machines.filter((view) => view.servers.length > 0);
  if (withServers.length === 0)
    return (
      <p class="help">
        No running servers to pick from: the daemons report none, or they are older than this list.
      </p>
    );
  return (
    <div class="field-row">
      <span class="label" data-tip="Running: the servers that listen on each machine, from its daemon.">
        Running
      </span>
      <div>
        {withServers.map((view) => (
          <div key={view.machine.id}>
            <div class="help">{view.machine.name}</div>
            <div class="pills">
              {view.servers.map((server) => (
                <button
                  key={server.port}
                  type="button"
                  aria-pressed={view.machine.id === props.machineId && server.port === props.port}
                  data-tip={`Share port ${server.port} of ${view.machine.name}: ${server.process ?? "a process of another user"}${server.status === null ? ", no web answer" : `, answers ${server.status}`}.`}
                  onClick={() => props.onPick(view, server)}
                >
                  {server.port} · {server.title ?? server.process ?? "?"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * K-1131: before the save, what the daemon saw on the port, and a K-520 frame of it. The frame loads the port in
 * this browser, so it shows the server only when the browser runs on that machine.
 */
function SitePreview(props: { port: number; machine: MachineView; server: ServerReport | null }) {
  const url = `http://localhost:${props.port}/`;
  const { server } = props;
  return (
    <div class="field-row">
      <span class="label" data-tip="Preview: the page on the port, before kitshn shares it.">
        Preview
      </span>
      <div>
        <p class="help">
          {server
            ? `${props.machine.machine.name} answers ${server.status ?? "with no web page"}${server.title ? `: ${server.title}` : ""}.`
            : `Nothing listens on port ${props.port} of ${props.machine.machine.name} at its last scan.`}
        </p>
        <div class="preview-frame site-preview">
          <div class="thumb">
            <LiveFrame
              key={url}
              url={url}
              label={`Preview of port ${props.port}`}
              sandbox="allow-scripts"
              interact={false}
            />
          </div>
        </div>
        <p class="help">
          This frame shows the server only when this browser runs on {props.machine.machine.name}.
        </p>
      </div>
    </div>
  );
}
