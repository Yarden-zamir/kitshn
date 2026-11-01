import { useEffect, useState } from "preact/hooks";
import { RIGHT_NAMES } from "../core/model.ts";
import type { AskEventView, LinkEventView, ProposalView } from "../core/protocol.ts";
import { callApi } from "./store.ts";
import { whenText } from "./time.ts";

/**
 * K-1722: the asks that wait for an approver circle. The Inbox of the Notifications view shows it (K-1607), and
 * the proposals of the snapshot stay the source of truth.
 */
export function AskList(props: {
  readonly proposals: ReadonlyArray<ProposalView>;
  readonly circleName: (id: string) => string;
  /** K-1723: an approver circle that needs a passkey approves through the passkey path. */
  readonly needsPasskey: (id: string) => boolean;
  readonly onToast: (text: string, error: boolean) => void;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // The age and the expiry of each row read the clock when it renders, so a quiet Inbox renders once a minute.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((each) => each + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (props.proposals.length === 0) return null;
  const deny = async (proposal: ProposalView) => {
    setBusy((ids) => new Set(ids).add(proposal.id));
    try {
      const result = await callApi<{ result: unknown }>(
        "POST",
        `/api/proposals/${encodeURIComponent(proposal.id)}/deny`,
        {},
      );
      props.onToast(
        "error" in result ? result.error : `Denied the ask of ${proposal.machineName}.`,
        "error" in result,
      );
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(proposal.id);
        return next;
      });
    }
  };
  return (
    <>
      <div
        class="label"
        data-tip="Asks: agents on machines wait for one member of the approver circle (K-1722)."
      >
        Asks
      </div>
      <ul class="repo-list">
        {props.proposals.map((proposal) => (
          <AskRow
            key={proposal.id}
            proposal={proposal}
            circleName={props.circleName}
            busy={busy.has(proposal.id)}
            onApprove={() =>
              location.assign(
                `/api/approve/${props.needsPasskey(proposal.circleId) ? "passkey" : "login"}/start?approve=${encodeURIComponent(proposal.id)}&hash=${proposal.shownHash}`,
              )
            }
            onDeny={() => void deny(proposal)}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * K-1723: the id of an approval that the fresh passkey check sent back, and the hash of the text that the approver
 * read (K-1722), from `#approve/<id>/<hash>`.
 */
export function approveFromHash(hash: string): { readonly id: string; readonly seen: string } | null {
  if (!hash.startsWith("#approve/")) return null;
  const [id, seen] = hash.slice("#approve/".length).split("/");
  return id && seen ? { id: decodeURIComponent(id), seen } : null;
}

const OUTCOME_TEXT: Record<AskEventView["outcome"], string> = {
  done: "ran",
  waiting: "waits",
  refused: "refused",
  "not-kitshn": "not kitshn",
};

/** K-1717: the asks of agents as History events, newest first; they have no Undo. K-1756: a search by one label. */
export function AskEvents(props: { readonly events: ReadonlyArray<AskEventView> }) {
  const [label, setLabel] = useState("");
  const [found, setFound] = useState<ReadonlyArray<AskEventView> | null>(null);
  const search = async () => {
    if (!label.includes("=")) return setFound(null);
    const result = await callApi<{ events: ReadonlyArray<AskEventView> }>(
      "GET",
      `/api/ask-events?label=${encodeURIComponent(label)}`,
    );
    setFound("error" in result ? [] : result.events);
  };
  const events = found ?? props.events;
  if (props.events.length === 0) return null;
  return (
    <section class="ask-events">
      <h3
        class="label"
        data-tip="Asks of agents on machines: events, not changes, so they have no Undo (K-1717)."
      >
        Asks of agents
      </h3>
      <input
        class="field"
        aria-label="Search asks by label"
        placeholder="t3.thread.id=…"
        value={label}
        data-tip="A label as key=value, for example t3.thread.id=abc: the asks with it, newest first, at most 50."
        onInput={(event) => setLabel(event.currentTarget.value)}
        onKeyDown={(event) => event.key === "Enter" && void search()}
      />
      <ul class="repo-list">
        {events.map((event) => (
          <li key={event.id}>
            <span class="muted">
              {new Date(event.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span class="name">
              {event.machineName}: <code>{`${event.action} ${event.target}`.trim()}</code>{" "}
              {OUTCOME_TEXT[event.outcome]}
              {event.outcome === "refused" ? <span class="muted"> · {event.detail}</span> : null}
              {event.reason ? <span class="muted"> · {event.reason}</span> : null}
              {Object.entries(event.labels).map(([key, value]) => (
                <span
                  key={key}
                  class="muted"
                  data-tip={
                    event.verified.includes(key)
                      ? "Verified: a provider of the machine vouched for this label (K-1752)."
                      : "Claimed: the agent wrote this label; no provider checked it (K-1750)."
                  }
                >
                  {" "}
                  · {key}={value} ({event.verified.includes(key) ? "verified" : "claimed"})
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** K-1767: pull requests of the kitshn App whose run waits for the owner's Deploy of that exact commit. */
export function BotRuns(props: {
  readonly runs: ReadonlyArray<{
    readonly repoId: string;
    readonly repo: string;
    readonly pr: number;
    readonly sha: string;
  }>;
  readonly onToast: (text: string, error: boolean) => void;
}) {
  if (props.runs.length === 0) return null;
  const deploy = async (run: (typeof props.runs)[number]) => {
    const result = await callApi<{ deployed: number }>("POST", "/api/bot-runs/deploy", {
      repoId: run.repoId,
      pr: run.pr,
      sha: run.sha,
    });
    props.onToast(
      "error" in result ? result.error : `Deploying pull request #${run.pr} of ${run.repo}.`,
      "error" in result,
    );
  };
  return (
    <>
      <div
        class="label"
        data-tip="Agent pull requests: the kitshn App opened them, so their preview deploys only after your Deploy of that commit (K-1767). A new push waits again."
      >
        Agent pull requests
      </div>
      <ul class="repo-list">
        {props.runs.map((run) => (
          <li key={`${run.repoId}-${run.pr}-${run.sha}`}>
            <a href={`https://github.com/${run.repo}/pull/${run.pr}`} target="_blank" rel="noreferrer">
              {run.repo} #{run.pr}
            </a>
            <code>{run.sha.slice(0, 7)}</code>
            <button
              type="button"
              class="btn"
              data-tip="Deploy: kitshn runs the pull request's workflow again for this commit, and its preview deploys."
              onClick={() => void deploy(run)}
            >
              Deploy
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** K-1722: one ask in the Inbox: the right it asks for, the machine and command, its labels, Approve and Deny. */
export function AskRow(props: {
  readonly proposal: ProposalView;
  readonly circleName: (id: string) => string;
  /** An answer runs now, so both buttons wait. */
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}) {
  return (
    <li>
      <span class="sticker wait" data-tip={`It waits for ${props.circleName(props.proposal.circleId)}.`}>
        {RIGHT_NAMES[props.proposal.right]}
      </span>
      <span class="name">
        {props.proposal.machineName}: <code class="shown">{props.proposal.shown}</code>
        {props.proposal.reason ? <span class="muted"> · {props.proposal.reason}</span> : null}
        <span class="muted">
          {" "}
          · asked {whenText(props.proposal.createdAt)} · expires {whenText(props.proposal.expiresAt)}
        </span>
        {Object.entries(props.proposal.labels).map(([key, value]) => (
          <span
            key={key}
            class="muted"
            data-tip={
              props.proposal.verified.includes(key)
                ? "Verified: a provider of the machine vouched for this label (K-1752)."
                : "Claimed: the agent wrote this label; no provider checked it (K-1750)."
            }
          >
            {" "}
            · {key}={value} ({props.proposal.verified.includes(key) ? "verified" : "claimed"})
          </span>
        ))}
      </span>
      <button
        type="button"
        class="btn primary"
        disabled={props.busy}
        data-tip="Approve: the login of the approver circle (a fresh passkey when it needs one), then you read the ask once more, then kitshn runs it."
        onClick={props.onApprove}
      >
        Approve
      </button>
      <button
        type="button"
        class="btn"
        disabled={props.busy}
        data-tip="Deny: the agent hears that you denied it."
        onClick={props.onDeny}
      >
        Deny
      </button>
    </li>
  );
}

/** K-1610: exec runs and forwarded tool calls between machines, as the source machines report them. */
export function LinkEvents(props: { readonly events: ReadonlyArray<LinkEventView> }) {
  if (props.events.length === 0) return null;
  return (
    <section class="ask-events">
      <h3
        class="label"
        data-tip="Work of agents on other machines: events, not changes, so they have no Undo. Never with arguments or output (K-1610)."
      >
        Cross-machine work
      </h3>
      <ul class="repo-list">
        {props.events.map((event) => (
          <li key={event.id}>
            <span class="muted">
              {new Date(event.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span class="name">
              {event.source} → {event.target}: {event.kind === "exec" ? "ran" : "called"}{" "}
              <code>{event.name}</code> {event.outcome}
              {event.exitCode !== null ? <span class="muted"> · exit {event.exitCode}</span> : null}
              {event.cwd ? <span class="muted"> · in {event.cwd}</span> : null}
              {event.thread ? <span class="muted"> · thread {event.thread}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
