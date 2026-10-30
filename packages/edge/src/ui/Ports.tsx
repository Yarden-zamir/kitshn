import { useEffect, useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import type { Resource } from "../core/model.ts";
import {
  type Door,
  type PortCard,
  type ServicePort,
  HOUR_MS,
  busyPort,
  portCardError,
  parsePort,
  portKey,
} from "../core/port.ts";
import type { ServerReport } from "../core/sites.ts";
import { Radio } from "./controls.tsx";
import { callApi, useStore } from "./store.ts";
import { untilText } from "./actions.ts";

/** K-534: a port card as `GET /api/ports` gives it (K-2001 to K-2009). */
export type PortView = PortCard & {
  readonly connect: string;
  readonly address: string;
  /** K-2007: null on a relayed card, whose relay listener says nothing about the service. */
  readonly listening: ReadonlyArray<string> | null;
  /** K-2010: the route as the players' packets take it, the problems of its machines, and shares it cannot check. */
  readonly route: string;
  readonly problems: ReadonlyArray<string>;
  readonly unchecked: ReadonlyArray<string>;
  readonly doors: ReadonlyArray<Door>;
};

export const isPortCard = (resource: Resource) => resource.kind === "port";

/** K-534: the machines that can hold port cards: online, with the daemon capability `doors` (K-2003). */
export const doorMachines = (machines: ReadonlyArray<MachineView>) =>
  machines.filter((view) => view.online && (view.status?.capabilities ?? []).includes("doors"));

/**
 * K-534: the ports of the Ports step ("25565, 19132/udp"), or the reason kitshn refuses them, in the words of K-2001:
 * the rules of `portCardError` and another service of the machine that `busyPort` finds in its running servers (K-619).
 * The server checks all of it again, also the ports of a kitshn site of the machine.
 */
export function servicePorts(
  input: {
    readonly ports: string;
    readonly name: string;
    readonly hours: number;
    readonly srv: string;
    readonly relay?: boolean;
  },
  servers: ReadonlyArray<ServerReport>,
): { readonly ports: ReadonlyArray<ServicePort> } | { readonly problem: string } {
  const parts = input.ports
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const ports: Array<ServicePort> = [];
  for (const part of parts) {
    const port = parsePort(part);
    if (!port) return { problem: `${part}: a port is like 25565/tcp or 19132/udp.` };
    ports.push(port);
  }
  const error = portCardError({
    name: input.name,
    ports,
    doorMs: input.hours * HOUR_MS,
    srv: input.srv.trim() || null,
    // The rule of a relay (one TCP port) only, so any machine id stands for it.
    relay: input.relay ? "relay" : null,
  });
  if (error) return { problem: error };
  const busy = busyPort(ports, servers);
  if (busy)
    return {
      problem: `${busy.port}/tcp on a machine of this route is ${busy.title ? `"${busy.title}"` : (busy.process ?? "another service")}, which is not the service, so a port card cannot close it.`,
    };
  return { ports };
}

const HOURS = [1, 12, 24, 72, 168] as const;
const hoursLabel = (hours: number) => (hours < 24 ? `${hours} h` : `${hours / 24} d`);

/** K-534: the "Ports" step of the site wizard; it posts `POST /api/ports`. */
export function PortForm(props: {
  zone: string;
  machines: ReadonlyArray<MachineView>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  // K-2002: any online machine runs the service; direct needs its doors, a relay needs the relay machine's doors.
  const online = props.machines.filter((view) => view.online);
  const doors = doorMachines(props.machines);
  const [picked, setPicked] = useState("");
  const machine = online.find((view) => view.machine.id === picked) ?? doors[0] ?? online[0] ?? null;
  const direct = machine !== null && doors.includes(machine);
  const relays = doors.filter((view) => view.machine.id !== machine?.machine.id);
  const [wantRelay, setWantRelay] = useState(false);
  const route: "direct" | "relay" | null =
    direct && (!wantRelay || relays.length === 0) ? "direct" : relays.length > 0 ? "relay" : null;
  const [pickedRelay, setPickedRelay] = useState("");
  const relay =
    route === "relay" ? (relays.find((view) => view.machine.id === pickedRelay) ?? relays[0] ?? null) : null;
  const able = machine !== null && route !== null;
  const [ports, setPorts] = useState("");
  const [name, setName] = useState("");
  const [hours, setHours] = useState<number>(12);
  const [srv, setSrv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // K-2001: the same machines as the server checks, so the wizard says what the server would refuse.
  const routeServers = [...(machine?.servers ?? []), ...(relay?.servers ?? [])];
  const checked = servicePorts({ ports, name, hours, srv, relay: route === "relay" }, routeServers);
  // The ports alone, while the owner types them, so a missing name does not show as a port problem.
  const portsAlone = servicePorts({ ports, name: "port", hours, srv: "" }, routeServers);
  // The running servers that a port card may take: another service of the machine is not the service of the card (K-2001).
  const offered = (machine?.servers ?? []).filter(
    (server) => busyPort([{ port: server.port, proto: "tcp" }], [server]) === null,
  );
  const add = async () => {
    if (!machine || route === null)
      return setError(
        "No machine holds doors: a direct card needs them on its machine, a relayed one on the relay machine (kitshn doors install).",
      );
    if ("problem" in checked) return setError(checked.problem);
    setBusy(true);
    const result = await callApi<{ address: string; connect: string }>("POST", "/api/ports", {
      machine: machine.machine.id,
      name,
      ports: checked.ports.map(portKey),
      doorHours: hours,
      ...(srv.trim() ? { srv: srv.trim() } : {}),
      ...(relay ? { relay: relay.machine.id } : {}),
    });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onDone(`${name} is at ${result.address}. People open their door at ${result.connect}.`);
    props.onClose();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <p class="help">
        A service on a machine, such as a game server. Its ports stay closed; each player of the card's
        circles opens them for their own address on the connect page.
      </p>
      <div class="field-row">
        <span class="label" data-tip="Machine: the online machine where the service listens.">
          Machine
        </span>
        <div>
          {online.length === 0 ? (
            <span class="help">No machine is online.</span>
          ) : (
            <div class="choices" role="radiogroup" aria-label="Machine">
              {online.map((view) => (
                <Radio
                  key={view.machine.id}
                  name="port-machine"
                  checked={view.machine.id === machine?.machine.id}
                  label={view.machine.name}
                  tip={`The service listens on ${view.machine.name}.`}
                  onSelect={() => setPicked(view.machine.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Route: how players reach the ports (K-2002).">
          Route
        </span>
        <div>
          <div class="choices" role="radiogroup" aria-label="Route">
            <Radio
              name="port-route"
              checked={route === "direct"}
              disabled={!direct}
              label="Direct"
              tip={
                direct
                  ? `Players connect to ${machine?.machine.name ?? "the machine"} itself.`
                  : `${machine?.machine.name ?? "This machine"} cannot hold doors: ${machine?.status?.doorsProblem ?? "no doors yet"}.`
              }
              onSelect={() => setWantRelay(false)}
            />
            <Radio
              name="port-route"
              checked={route === "relay"}
              disabled={relays.length === 0}
              label="Relay"
              tip="Players connect to a relay machine, which reaches this machine through its tunnel. One TCP port."
              onSelect={() => setWantRelay(true)}
            />
          </div>
          {route === "relay" ? (
            <div class="choices" role="radiogroup" aria-label="Relay machine">
              {relays.map((view) => (
                <Radio
                  key={view.machine.id}
                  name="port-relay"
                  checked={view.machine.id === relay?.machine.id}
                  label={view.machine.name}
                  tip={`Relay through ${view.machine.name}. Pick one near the players and near ${machine?.status?.tunnelLocations ?? "the tunnel's data centers"}.`}
                  onSelect={() => setPickedRelay(view.machine.id)}
                />
              ))}
            </div>
          ) : null}
          {route === null ? (
            <p class="help">
              No machine holds doors. Run <code>kitshn doors install --user &lt;user&gt;</code> as root on a
              Linux machine with a public address.
            </p>
          ) : null}
          {machine?.status?.tunnelLocations && route === "relay" ? (
            <p class="help">Its tunnel lands in {machine.status.tunnelLocations}.</p>
          ) : null}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Ports: 1 to 4 ports of the port card, TCP unless you add /udp.">
          Ports
        </span>
        <div>
          <input
            class="field"
            value={ports}
            aria-label="Ports"
            data-tip="1 to 4 ports, comma separated, such as 25565 or 19132/udp."
            placeholder="25565, 19132/udp"
            onInput={(event) => {
              setPorts(event.currentTarget.value);
              setError(null);
            }}
          />
          {offered.length > 0 ? (
            <div class="pills">
              {offered.map((server) => (
                <button
                  key={server.port}
                  type="button"
                  data-tip={`Add port ${server.port} (${server.process ?? "a process of another user"}).`}
                  onClick={() =>
                    setPorts((now) => (now.trim() ? `${now}, ${server.port}` : String(server.port)))
                  }
                >
                  {server.port} · {server.process ?? "?"}
                </button>
              ))}
            </div>
          ) : null}
          {ports.trim() !== "" && "problem" in portsAlone ? <p class="error">{portsAlone.problem}</p> : null}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Name: the first part of the port card address and of the connect page.">
          Name
        </span>
        <div>
          <input
            class="field"
            value={name}
            aria-label="Name"
            data-tip="The name of the port card: lowercase letters, digits and dashes."
            placeholder="minecraft"
            onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
          />
          <p class="help">
            Address <code>{(name || "name") + "." + props.zone}</code>
          </p>
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Doors: how long a door stays open after a player opens it.">
          Doors
        </span>
        <div class="choices" role="radiogroup" aria-label="Door time">
          {HOURS.map((each) => (
            <Radio
              key={each}
              name="port-door-time"
              checked={hours === each}
              label={hoursLabel(each)}
              tip={`A door stays open ${hoursLabel(each)}, then the player opens it again.`}
              onSelect={() => setHours(each)}
            />
          ))}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="SRV: the service name of an SRV record, such as minecraft. Optional.">
          SRV
        </span>
        <input
          class="field"
          value={srv}
          aria-label="SRV service"
          data-tip="The service of an SRV record, such as minecraft, so players type no port. Leave it empty for none."
          placeholder="minecraft (optional)"
          onInput={(event) => setSrv(event.currentTarget.value)}
        />
      </div>
      {error ? <p class="error">{error}</p> : null}
      <div class="row">
        <button
          class="btn primary"
          disabled={busy || !able}
          data-tip="Make the port card. It waits in the tray; players of its circles open doors on the connect page."
        >
          Add the port card
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
  );
}

/** K-534: the open doors of a port card in its panel, each with Close; the owner's view of K-2007. */
export function PortDoors(props: { resource: Resource; onRemove: () => void }) {
  const [portCard, setPortCard] = useState<PortView | null | "error">(null);
  const [error, setError] = useState<string | null>(null);
  /** The door whose Close waits for "Yes", and whether its call runs. */
  const [asking, setAsking] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  // K-2005: each door that opens or closes is a revision, so a new revision reads the doors again.
  const revision = useStore().snapshot?.revision ?? 0;
  const load = async () => {
    const result = await callApi<ReadonlyArray<PortView>>("GET", "/api/ports");
    if ("error" in result) return setPortCard("error");
    setPortCard(result.find((each) => each.card === props.resource.id) ?? "error");
  };
  useEffect(() => void load(), [props.resource.id, revision]);
  if (portCard === null) return <p class="help">Loading the doors…</p>;
  if (portCard === "error") return <p class="help">kitshn could not read the doors of this port card.</p>;
  const close = async (door: Door) => {
    setClosing(true);
    const result = await callApi<object>(
      "DELETE",
      `/api/ports/${encodeURIComponent(portCard.card)}/doors/${encodeURIComponent(door.address)}`,
    );
    setClosing(false);
    setAsking(null);
    if ("error" in result) return setError(result.error);
    setError(null);
    await load();
  };
  // A door that ended is shut already; the alarm removes it soon.
  const now = Date.now();
  const doors = portCard.doors.filter((door) => door.endsAt > now);
  return (
    <div>
      <div class="label" data-tip="Route: how the players' packets reach the service (K-2010).">
        Route
      </div>
      <p class="help">{portCard.route}</p>
      {portCard.problems.map((problem) => (
        <p key={problem} class="error">
          {problem}
        </p>
      ))}
      {portCard.unchecked.map((note) => (
        <p key={note} class="help">
          {note}
        </p>
      ))}
      <p class="help">
        A cloud firewall (an Oracle security list, an AWS security group) must allow the ports too; kitshn
        cannot see it.
      </p>
      <p class="help">
        Connect page <code>{portCard.connect}</code>
        {portCard.listening === null
          ? null
          : ` · listening ${portCard.listening.length > 0 ? portCard.listening.join(", ") : "nothing"}`}
      </p>
      <div class="label" data-tip="Doors: the addresses that may reach the gated ports now (K-2005).">
        Doors
      </div>
      {doors.length === 0 ? (
        <p class="help">No door is open. A player opens one on the connect page.</p>
      ) : (
        <ul class="opens">
          {doors.map((door) => (
            <li key={`${door.person}/${door.address}`} class="row">
              <span class="grow">
                {door.person} · <code>{door.address}</code> · {untilText(door.endsAt)}
              </span>
              {asking === door.address ? (
                <>
                  <span>Close for everyone on this address?</span>
                  <button
                    type="button"
                    class="btn danger"
                    disabled={closing}
                    data-tip={`Close ${door.address} now for everyone on this address; their connections end. There is no Undo.`}
                    onClick={() => void close(door)}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    class="btn"
                    disabled={closing}
                    data-tip="Keep the door open."
                    onClick={() => setAsking(null)}
                  >
                    No
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  class="btn"
                  disabled={closing}
                  data-tip={`Close ${door.address} for everyone on this address. kitshn asks first.`}
                  onClick={() => setAsking(door.address)}
                >
                  Close…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error ? <p class="error">{error}</p> : null}
      <div class="row">
        <button
          type="button"
          class="btn danger"
          data-tip={`Remove ${props.resource.name}: its doors close for everyone and its records go. kitshn asks first.`}
          onClick={props.onRemove}
        >
          Remove ports…
        </button>
      </div>
    </div>
  );
}
