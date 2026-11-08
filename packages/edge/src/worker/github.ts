import { SignJWT, importPKCS8 } from "jose";
import { aesKey } from "./seal.ts";

/** The kitshn GitHub App (K-908): its id and its private key, in the PKCS #1 PEM that GitHub gives, or PKCS #8. */
export interface GitHubApp {
  readonly id: string;
  readonly key: string;
}

const derLength = (length: number) =>
  length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : [0x82, length >> 8, length & 0xff];

/** Wraps a PKCS #1 RSA key in PKCS #8, so WebCrypto takes it; the bootstrap has no openssl (K-1203). */
export function pkcs8Pem(pem: string): string {
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return pem;
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const rsa = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  // version 0, then AlgorithmIdentifier rsaEncryption with NULL parameters.
  const head = [
    0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
    0x00,
  ];
  const octet = [0x04, ...derLength(rsa.length)];
  const inner = head.length + octet.length + rsa.length;
  const der = new Uint8Array([0x30, ...derLength(inner), ...head, ...octet, ...rsa]);
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PRIVATE KEY-----`;
}

const API = "https://api.github.com";

/** A GitHub answer that is not 2xx, with its status, so a caller can tell a refusal from a fault. */
class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(token: string, method: string, path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "kitshn",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    if (path.endsWith("/dispatches") && response.status === 422 && text.includes("workflow_dispatch"))
      throw new GitHubError(422, "Add workflow_dispatch to the repo's kitshn.yml.");
    throw new GitHubError(
      response.status,
      `GitHub answered ${response.status} for ${method} ${path}: ${text}`,
    );
  }
  return response.status === 204 ? null : await response.json();
}

const repositoryId = (repoId: string) => {
  const id = Number(repoId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${repoId} is not a GitHub repository id.`);
  return id;
};

async function appJwt(app: GitHubApp) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(app.id)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(await importPKCS8(pkcs8Pem(app.key), "RS256"));
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("GitHub sent an answer that kitshn does not know.");
  return value as Record<string, unknown>;
};

/**
 * K-718, K-819: runs the repo's kitshn workflow on one branch through the App (`workflow_dispatch`). kitshn
 * names the repo by its id, never by a name that a rename or a new repo can take over: the token covers only
 * that repo id and only Actions, and the current name comes from that token. Returns the current full name.
 */
export async function dispatchDeploy(app: GitHubApp, repoId: string, branch: string, workflow: string) {
  const { token, name } = await actionsToken(app, repoId);
  // A full branch ref, so a tag with the same name never runs.
  await call(token, "POST", `/repos/${name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    ref: `refs/heads/${branch}`,
  });
  return name;
}

/** K-1767: runs a workflow run of the repo with this id again, for an approved preview of a pull request of the App. */
export async function rerunWorkflowRun(app: GitHubApp, repoId: string, runId: string) {
  if (runId === "" || ![...runId].every((char) => char >= "0" && char <= "9"))
    throw new Error(`${runId} is not a workflow run id.`);
  const { token, name } = await actionsToken(app, repoId);
  await call(token, "POST", `/repos/${name}/actions/runs/${runId}/rerun`);
  return name;
}

/**
 * K-718, K-819: a token for the repo with this id and only Actions, and the repo's current full name from that token.
 * kitshn names the repo by its id, never by a name that a rename or a new repo can take over.
 */
async function actionsToken(app: GitHubApp, repoId: string) {
  const id = repositoryId(repoId);
  const jwt = await appJwt(app);
  // GitHub looks up an installation only by a repo name, so kitshn asks each installation for a token of
  // this id. Only the first 100 installations count; the App has one per owner account (K-811).
  const installations = await call(jwt, "GET", "/app/installations?per_page=100");
  if (!Array.isArray(installations)) throw new Error("GitHub sent no list of installations.");
  let token: string | null = null;
  for (const installation of installations) {
    const installationId = record(installation)["id"];
    if (typeof installationId !== "number") throw new Error("GitHub sent an installation without an id.");
    if (record(installation)["suspended_at"]) continue;
    try {
      const access = record(
        await call(jwt, "POST", `/app/installations/${installationId}/access_tokens`, {
          repository_ids: [id],
          permissions: { actions: "write" },
        }),
      );
      if (typeof access["token"] !== "string") throw new Error("GitHub sent no installation token.");
      token = access["token"];
      break;
    } catch (error) {
      // This installation does not hold the repo, lacks Actions: write (422), or GitHub refuses it (403, 404).
      if (error instanceof GitHubError && [403, 404, 422].includes(error.status)) continue;
      throw error;
    }
  }
  if (token === null)
    throw new Error(
      "The kitshn GitHub App has no installation with this repo and the permission Actions: write. Install it on the repo and accept the permission.",
    );
  const repositories = record(await call(token, "GET", "/installation/repositories"))["repositories"];
  const repo = (Array.isArray(repositories) ? repositories : [])
    .map(record)
    .find((item) => item["id"] === id);
  const name = repo?.["full_name"];
  if (typeof name !== "string") throw new Error(`The installation token does not reach the repo ${repoId}.`);
  return { token, name };
}

/** K-819: what GitHub says about one repo id. "unknown" never changes what kitshn shows. */
export type RepoOnGitHub = "exists" | "gone" | "unknown";

/**
 * K-819: asks GitHub with each installation of the App whether these repo ids still exist
 * (`GET /repositories/<id>`). A repo is gone only when every installation answers 404 and one of them holds
 * all repos of the repo's owner. Any other answer, a failed token or a network fault leaves it unknown.
 * Returns only the repos that it asked about within `maxCalls`, so the rest wait for the next check.
 * Known limit: a private repo that moved to an account without the App also reads as gone. Revisit this
 * when kitshn stores the owner id of each repo.
 */
export async function reposOnGitHub(
  app: GitHubApp,
  repos: ReadonlyArray<{ readonly repoId: string; readonly name: string }>,
  maxCalls: number,
): Promise<Map<string, RepoOnGitHub>> {
  const found = new Map<string, RepoOnGitHub>();
  let calls = 0;
  const installations: Array<{
    readonly owner: string;
    readonly all: boolean;
    readonly token: string | null;
  }> = [];
  try {
    const jwt = await appJwt(app);
    calls++;
    const list = await call(jwt, "GET", "/app/installations?per_page=100");
    if (!Array.isArray(list)) return found;
    for (const item of list.map(record)) {
      if (item["suspended_at"]) continue;
      if (calls >= maxCalls) return found;
      const account = item["account"];
      const owner =
        typeof account === "object" && account !== null
          ? (account as Record<string, unknown>)["login"]
          : null;
      calls++;
      const token = await call(jwt, "POST", `/app/installations/${String(item["id"])}/access_tokens`, {
        permissions: { metadata: "read" },
      })
        .then((access) => record(access)["token"])
        .catch(() => null);
      installations.push({
        owner: typeof owner === "string" ? owner.toLowerCase() : "",
        all: item["repository_selection"] === "all",
        token: typeof token === "string" ? token : null,
      });
    }
  } catch {
    return found;
  }
  for (const repo of repos) {
    if (calls + installations.length > maxCalls) break;
    // A stored id that is not a GitHub repository id is unknown, so one bad row never stops the check.
    const id = Number(repo.repoId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      found.set(repo.repoId, "unknown");
      continue;
    }
    const owner = repo.name.split("/")[0]?.toLowerCase() ?? "";
    let answer: RepoOnGitHub = installations.some((each) => each.all && each.owner === owner)
      ? "gone"
      : "unknown";
    for (const { token } of installations) {
      if (token === null) {
        answer = "unknown";
        continue;
      }
      calls++;
      const status = await call(token, "GET", `/repositories/${id}`)
        .then(() => 200)
        .catch((error: unknown) => (error instanceof GitHubError ? error.status : null));
      if (status === 200) {
        answer = "exists";
        break;
      }
      if (status !== 404) answer = "unknown";
    }
    found.set(repo.repoId, answer);
  }
  return found;
}

/** K-1761: the permissions of a repo token; read is Contents and Metadata, write adds Pull requests. */
const TOKEN_PERMISSIONS = {
  read: { contents: "read", metadata: "read" },
  write: { contents: "write", pull_requests: "write", metadata: "read" },
} as const;

/** K-1766: the App has no installation that holds the repo. */
export class NotInstalled extends Error {}

/**
 * K-1762: an installation token for one repo with the permissions of one right. `installationId` is the one that kitshn
 * keeps for the owner, or null to look it up (one call). GitHub fixes the life of the token at one hour.
 */
export async function repoToken(
  app: GitHubApp,
  fullName: string,
  permission: "read" | "write",
  installationId: number | null,
  /** The repo id when kitshn knows it, so a rename or a new repo with the old name gets no token (K-819). */
  repoId: string | null,
): Promise<{ readonly token: string; readonly expiresAt: string; readonly installationId: number }> {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error(`${fullName} is not owner/name.`);
  const jwt = await appJwt(app);
  let id = installationId;
  if (id === null) {
    try {
      const found = record(await call(jwt, "GET", `/repos/${owner}/${name}/installation`))["id"];
      if (typeof found !== "number") throw new Error("GitHub sent an installation without an id.");
      id = found;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404)
        throw new NotInstalled(`The kitshn App is not installed on ${owner} (K-1766).`);
      throw error;
    }
  }
  const access = record(
    await call(jwt, "POST", `/app/installations/${id}/access_tokens`, {
      ...(repoId === null ? { repositories: [name] } : { repository_ids: [repositoryId(repoId)] }),
      permissions: TOKEN_PERMISSIONS[permission],
    }),
  );
  if (typeof access["token"] !== "string" || typeof access["expires_at"] !== "string")
    throw new Error("GitHub sent no installation token.");
  return { token: access["token"], expiresAt: access["expires_at"], installationId: id };
}

/**
 * K-1716: a token sealed with AES-GCM under a key that HKDF derives from the App private key, a Worker secret. Revoking
 * needs the token itself, so `github_tokens` keeps this sealed copy; backups leave the table out (K-1831).
 */
const tokenKey = (appKey: string) => aesKey(appKey, "kitshn github_tokens");

export async function sealToken(appKey: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await tokenKey(appKey),
      new TextEncoder().encode(token),
    ),
  );
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...sealed))}`;
}

export async function openToken(appKey: string, sealed: string): Promise<string> {
  const [iv, data] = sealed
    .split(".")
    .map((part) => Uint8Array.from(atob(part), (char) => char.charCodeAt(0)));
  if (!iv || !data) throw new Error("A sealed token is not iv.data.");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await tokenKey(appKey), data),
  );
}

/** K-1716: ends an installation token before its hour; a token that is gone already counts as ended. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await call(token, "DELETE", "/installation/token");
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) return;
    throw error;
  }
}

/** K-1767: the bot login of the App (`<slug>[bot]`), which GitHub writes as the `actor` of its pushes. */
export async function appBotLogin(app: GitHubApp): Promise<string> {
  const slug = record(await call(await appJwt(app), "GET", "/app"))["slug"];
  if (typeof slug !== "string") throw new Error("GitHub sent no App slug.");
  return `${slug}[bot]`;
}
