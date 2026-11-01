// K-724: the one kitshn protocol version. The Worker, the daemon, the CLI and providers check it on each boundary.

/**
 * K-724: the version of the wire of kitshn. Major: a breaking change (a removed or narrowed request, answer, event or
 * field). Minor: an additive change (a new optional field, request, event or capability). Patch: no wire change.
 * `protocol.test.ts` compares the wire schema with `protocol.lock.json`, so a change without the right bump fails.
 */
export const KITSHN_PROTOCOL = "2.1.0";

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const part = (text: string) => {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === text ? value : null;
};

/** `<major>.<minor>.<patch>` with no leading zeros and nothing else, or null. */
export function parseProtocol(text: string): ProtocolVersion | null {
  const parts = text.split(".");
  if (parts.length !== 3) return null;
  const [major, minor, patch] = parts.map(part);
  if (major == null || minor == null || patch == null) return null;
  return { major, minor, patch };
}

/** K-724: the version of a peer from before K-724, which names only its major. */
export const legacyProtocol = (major: number) => `${major}.0.0`;

/** One side of a boundary: its name in messages, its version, and how a person updates it. */
export interface ProtocolSide {
  readonly name: string;
  readonly version: string;
  readonly update: string;
}

export type ProtocolMatch =
  /** The same major and minor: no message. */
  | { readonly outcome: "same" }
  /** The same major, another minor: both sides go on and log `warning`; the older side ignores what it does not know. */
  | { readonly outcome: "tolerate"; readonly warning: string }
  /** Another major, or no version: the side that checks refuses the other with `reason`. */
  | { readonly outcome: "refuse"; readonly reason: string };

/**
 * K-724: how `ours` treats `theirs`. Both messages name both versions and how to update the older side. Our own
 * version is a constant of this release, so a bad one throws.
 */
export function matchProtocol(ours: ProtocolSide, theirs: ProtocolSide): ProtocolMatch {
  const own = parseProtocol(ours.version);
  if (own === null) throw new Error(`${ours.name} has the bad kitshn protocol version "${ours.version}".`);
  const other = parseProtocol(theirs.version);
  if (other === null)
    return {
      outcome: "refuse",
      reason: `${theirs.name} names the kitshn protocol "${theirs.version.slice(0, 40)}", which is no version; ${ours.name} speaks ${ours.version}. Update ${theirs.name}: ${theirs.update} (K-724).`,
    };
  if (own.major === other.major && own.minor === other.minor) return { outcome: "same" };
  const oursOlder = own.major === other.major ? own.minor < other.minor : own.major < other.major;
  const older = oursOlder ? ours : theirs;
  const pair = `${ours.name} speaks kitshn protocol ${ours.version} and ${theirs.name} speaks ${theirs.version}`;
  if (own.major !== other.major)
    return {
      outcome: "refuse",
      reason: `${pair}: the major versions differ, so ${ours.name} refuses ${theirs.name}. Update ${older.name}: ${older.update} (K-724).`,
    };
  return {
    outcome: "tolerate",
    warning: `${pair}: ${older.name} ignores what it does not know. Update ${older.name}: ${older.update} (K-724).`,
  };
}

/** K-636: how a person updates the Worker and every daemon to one release. */
export const ROLLOUT_FIX = "run kitshn rollout <version> (K-636)";
