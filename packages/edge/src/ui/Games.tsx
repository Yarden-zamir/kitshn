import { useEffect, useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import type { Resource } from "../core/model.ts";
import {
  type Door,
  type Game,
  type GamePort,
  HOUR_MS,
  busyPort,
  gameError,
  parsePort,
  portKey,
} from "../core/game.ts";
import type { ServerReport } from "../core/sites.ts";
import { Radio } from "./controls.tsx";
import { callApi, useStore } from "./store.ts";

/** K-534: a game card as `GET /api/games` gives it (K-2001 to K-2008). */
export type GameView = Game & {
  readonly join: string;
  readonly address: string;
  readonly listening: ReadonlyArray<string>;
  readonly problem: string | null;
  readonly doors: ReadonlyArray<Door>;
};

export const isGameCard = (resource: Resource) => resource.kind === "game";

/** K-534: the machines that can hold game cards: online, with the daemon capability `doors` (K-2002). */
export const doorMachines = (machines: ReadonlyArray<MachineView>) =>
  machines.filter((view) => view.online && (view.status?.capabilities ?? []).includes("doors"));

/**
 * K-534: the ports of the Game step ("25565, 19132/udp"), or the reason kitshn refuses them, in the words of K-2001:
 * the rules of `gameError` and another service of the machine that `busyPort` finds in its running servers (K-619).
 * The server checks all of it again, also the ports of a kitshn site of the machine.
 */
export function gamePorts(
  input: { readonly ports: string; readonly name: string; readonly hours: number; readonly srv: string },
  servers: ReadonlyArray<ServerReport>,
): { readonly ports: ReadonlyArray<GamePort> } | { readonly problem: string } {
  const parts = input.ports
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const ports: Array<GamePort> = [];
  for (const part of parts) {
    const port = parsePort(part);
    if (!port) return { problem: `${part}: a port is like 25565/tcp or 19132/udp.` };
    ports.push(port);
  }
  const error = gameError({
    name: input.name,
    ports,
    doorMs: input.hours * HOUR_MS,
    srv: input.srv.trim() || null,
    relay: null,
  });
  if (error) return { problem: error };
  const busy = busyPort(ports, servers);
  if (busy)
    return {
      problem: `${busy.port}/tcp on this machine is ${busy.title ? `"${busy.title}"` : (busy.process ?? "another service")}, which is no game, so a game card cannot close it.`,
    };
  return { ports };
}

const HOURS = [1, 12, 24, 72, 168] as const;
const hoursLabel = (hours: number) => (hours < 24 ? `${hours} h` : `${hours / 24} d`);

/** K-534: the "Game, from a machine" step of the site wizard; it posts `POST /api/games`. */
export function GameForm(props: {
  zone: string;
  machines: ReadonlyArray<MachineView>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const able = doorMachines(props.machines);
  const [picked, setPicked] = useState("");
  const machine = able.find((view) => view.machine.id === picked) ?? able[0] ?? null;
  const [ports, setPorts] = useState("");
  const [name, setName] = useState("");
  const [hours, setHours] = useState<number>(12);
  const [srv, setSrv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = gamePorts({ ports, name, hours, srv }, machine?.servers ?? []);
  // The ports alone, while the owner types them, so a missing name does not show as a port problem.
  const portsAlone = gamePorts({ ports, name: "game", hours, srv: "" }, machine?.servers ?? []);
  const without = props.machines.filter((view) => view.online && !able.includes(view));
  // The running servers that a game card may take: another service of the machine is no game (K-2001).
  const offered = (machine?.servers ?? []).filter(
    (server) => busyPort([{ port: server.port, proto: "tcp" }], [server]) === null,
  );
  const add = async () => {
    if (!machine)
      return setError("No online machine can hold a game: install its doors first (kitshn doors install).");
    if ("problem" in checked) return setError(checked.problem);
    setBusy(true);
    const result = await callApi<{ address: string; join: string }>("POST", "/api/games", {
      machine: machine.machine.id,
      name,
      ports: checked.ports.map(portKey),
      doorHours: hours,
      ...(srv.trim() ? { srv: srv.trim() } : {}),
    });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onDone(`${name} plays at ${result.address}. Players open their door at ${result.join}.`);
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
        A game server of a machine. Its ports stay closed; each player of the card's circles opens them for
        their own address on the join page.
      </p>
      <div class="field-row">
        <span class="label" data-tip="Machine: an online machine whose daemon holds game doors.">
          Machine
        </span>
        <div>
          {able.length === 0 ? (
            <span class="help">
              No online machine holds game doors. Run <code>kitshn doors install --user &lt;user&gt;</code> on
              one as root, or <code>kitshn doors install</code> on a Windows PC in an administrator
              PowerShell.
            </span>
          ) : (
            <div class="choices" role="radiogroup" aria-label="Machine">
              {able.map((view) => (
                <Radio
                  key={view.machine.id}
                  name="game-machine"
                  checked={view.machine.id === machine?.machine.id}
                  label={view.machine.name}
                  tip={`Run the game on ${view.machine.name}.`}
                  onSelect={() => setPicked(view.machine.id)}
                />
              ))}
            </div>
          )}
          {without.length > 0 ? (
            <p class="help">
              {without
                .map((view) => `${view.machine.name}: ${view.status?.doorsProblem ?? "no game doors yet"}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
      <div class="field-row">
        <span class="label" data-tip="Ports: 1 to 4 ports of the game, TCP unless you add /udp.">
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
        <span class="label" data-tip="Name: the first part of the game address and of the join page.">
          Name
        </span>
        <div>
          <input
            class="field"
            value={name}
            aria-label="Name"
            data-tip="The name of the game: lowercase letters, digits and dashes."
            placeholder="minecraft"
            onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
          />
          <p class="help">
            Plays at <code>{(name || "name") + "." + props.zone}</code>
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
              name="game-door-time"
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
          disabled={busy || able.length === 0}
          data-tip="Make the game card. It waits in the tray; players of its circles open doors on the join page."
        >
          Add the game
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

/** K-534: the open doors of a game card in its panel, each with Close; the owner's view of K-2003. */
export function GameDoors(props: { resource: Resource; onRemove: () => void }) {
  const [game, setGame] = useState<GameView | null | "error">(null);
  const [error, setError] = useState<string | null>(null);
  /** The door whose Close waits for "Yes", and whether its call runs. */
  const [asking, setAsking] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  // K-2004: each door that opens or closes is a revision, so a new revision reads the doors again.
  const revision = useStore().snapshot?.revision ?? 0;
  const load = async () => {
    const result = await callApi<ReadonlyArray<GameView>>("GET", "/api/games");
    if ("error" in result) return setGame("error");
    setGame(result.find((each) => each.card === props.resource.id) ?? "error");
  };
  useEffect(() => void load(), [props.resource.id, revision]);
  if (game === null) return <p class="help">Loading the doors…</p>;
  if (game === "error") return <p class="help">kitshn could not read the doors of this game.</p>;
  const close = async (door: Door) => {
    setClosing(true);
    const result = await callApi<object>(
      "DELETE",
      `/api/games/${encodeURIComponent(game.card)}/doors/${encodeURIComponent(door.address)}`,
    );
    setClosing(false);
    setAsking(null);
    if ("error" in result) return setError(result.error);
    setError(null);
    await load();
  };
  // A door that ended is shut already; the alarm removes it soon.
  const now = Date.now();
  const doors = game.doors.filter((door) => door.endsAt > now);
  return (
    <div>
      <div class="label" data-tip="Doors: the addresses that may reach the game ports now (K-2003).">
        Doors
      </div>
      {game.problem ? <p class="error">{game.problem}</p> : null}
      <p class="help">
        Join page <code>{game.join}</code> · listening{" "}
        {game.listening.length > 0 ? game.listening.join(", ") : "nothing"}
      </p>
      {doors.length === 0 ? (
        <p class="help">No door is open. A player opens one on the join page.</p>
      ) : (
        <ul class="opens">
          {doors.map((door) => (
            <li key={`${door.person}/${door.address}`} class="row">
              <span class="grow">
                {door.person} · <code>{door.address}</code> · until {new Date(door.endsAt).toLocaleString()}
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
          Remove game…
        </button>
      </div>
    </div>
  );
}
