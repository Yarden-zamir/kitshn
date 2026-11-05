// K-1763, K-1764: the git credential helper protocol and the repo of a gh call. Pure, for tests.
import type { Answer } from "@kitshn/local";

/** The `key=value` lines that git sends to a credential helper, up to the first empty line. */
export function readCredentialInput(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") break;
    const equals = line.indexOf("=");
    if (equals > 0) fields[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return fields;
}

/** K-1763: the `owner/name` of a GitHub repo from the helper input, or null for another host or no path. */
export function repoOfCredential(fields: Readonly<Record<string, string>>): string | null {
  if (fields["protocol"] !== "https" || fields["host"] !== "github.com") return null;
  return repoOfPath(fields["path"] ?? "");
}

/** `owner/name` from a GitHub path such as `owner/name.git`, or null. */
function repoOfPath(path: string): string | null {
  const trimmed = path.endsWith(".git") ? path.slice(0, -".git".length) : path;
  const parts = trimmed.split("/").filter((part) => part !== "");
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
}

/** K-1764: `owner/name` of a git remote URL on github.com (https or ssh), or null. */
export function repoOfRemote(url: string): string | null {
  const text = url.trim();
  for (const prefix of ["https://github.com/", "git@github.com:", "ssh://git@github.com/"])
    if (text.startsWith(prefix)) return repoOfPath(text.slice(prefix.length));
  return null;
}

/** K-1763: `kitshn setup-git` marks each push to github.com with this user name, because git never tells a helper push from fetch. */
export const PUSH_USER = "kitshn-push";

/** K-1763: the git config key of the push mark that `kitshn setup-git` writes. */
export const PUSH_MARK_KEY = `url.https://${PUSH_USER}@github.com/.pushInsteadOf`;

/** K-1763: gh answers a marked push with the empty user name of kitshn; helpers that look up a user name do not. */
export const answersMarkedPush = (helper: string) => helper.includes("gh auth git-credential");

/** K-1763: a marked push asks for write; every other request asks for read. */
export const permissionOfCredential = (fields: Readonly<Record<string, string>>): "read" | "write" =>
  fields["username"] === PUSH_USER ? "write" : "read";

/** K-1763: the answer of the helper for a token, with its expiry, so a helper that stores it drops it in time. */
export const credentialAnswer = (token: string, expiresAt: string) =>
  `username=x-access-token\npassword=${token}\npassword_expiry_utc=${Math.floor(Date.parse(expiresAt) / 1000)}\n`;

/**
 * K-1763, K-1752: what `kitshn git-credential get` prints for kitshn's answer. A token answers git. A refusal or a
 * waiting ask of a kitshn owner, also a thread that its provider could not check, prints `quit=1`, so git never falls
 * back to the machine's own login. A daemon that cannot help (no daemon, no connection, another owner) prints nothing,
 * so git tries its next helper. On a marked push it clears the user name first, because gh refuses a request for
 * another user.
 */
export function credentialReply(
  answer: Answer | null,
  push = false,
): {
  readonly stdout: string;
  readonly stderr: string | null;
} {
  if (answer === null || answer.type !== "ask" || answer.outcome === "not-kitshn")
    return { stdout: push ? "username=\n" : "", stderr: null };
  if (answer.outcome === "done" && typeof answer.result === "object" && answer.result !== null) {
    const { token, expiresAt } = answer.result as { token?: unknown; expiresAt?: unknown };
    if (typeof token === "string" && typeof expiresAt === "string")
      return { stdout: credentialAnswer(token, expiresAt), stderr: null };
  }
  const why =
    answer.outcome === "refused"
      ? answer.reason
      : answer.outcome === "waiting"
        ? `the token waits for an approval (proposal ${answer.proposalId}); push again after it`
        : "kitshn gave no token";
  return { stdout: "quit=1\n", stderr: `kitshn: ${why}` };
}
