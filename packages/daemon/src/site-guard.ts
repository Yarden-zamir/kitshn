// K-1609: checks the assertion of a reserved machine-link path before any request reaches a local site.
import { chmodSync, rmSync } from "node:fs";
import {
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from "node:http";
import { createServer as createListener } from "node:net";
import type { Duplex } from "node:stream";
import type { SiteGuardClient, SiteGuardGrant } from "@kitshn/edge/machine";
import type { JWTVerifyGetKey } from "jose";
import { jwtVerify } from "jose";
import { withoutAccessCookie } from "./link.ts";
import { isSocketFile } from "./sites.ts";

/** The link host's Access audience is unique to this card's path, not the audience of its normal site. */
export interface GuardSite {
  readonly audience: string;
  /** Current machine grants from the signed Kitshn connection. A finite grant expires even if that push is old. */
  readonly clients: ReadonlyArray<SiteGuardClient>;
  /** An address read from the daemon's own site registry, never from a request. */
  readonly target: string;
  readonly host: string;
}

export interface GuardContext {
  readonly teamDomain: string | null;
  readonly site: (cardId: string) => GuardSite | null;
  readonly keys: (teamDomain: string) => JWTVerifyGetKey;
  readonly now?: () => number;
}

/** Only a signed, current connection owns these grants. The origin always comes from this daemon's registry. */
export class SiteGuardReach {
  private owner: object | null = null;
  private team: string | null = null;
  private grants = new Map<string, SiteGuardGrant>();

  constructor(
    private readonly local: (name: string) => { readonly target: string; readonly dev: boolean } | null,
  ) {}

  connect(owner: object) {
    this.owner = owner;
    this.clear();
  }

  apply(owner: object, team: unknown, grants: unknown): boolean {
    if (this.owner !== owner) return false;
    this.clear();
    if (
      typeof team !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(team) ||
      !Array.isArray(grants) ||
      grants.length > 512 ||
      !grants.every(validGrant)
    )
      return false;
    const records = grants as Array<SiteGuardGrant>;
    if (new Set(records.map((grant) => grant.id)).size !== records.length) return false;
    this.team = team;
    this.grants = new Map(records.map((grant) => [grant.id, grant]));
    return true;
  }

  disconnect(owner: object) {
    if (this.owner !== owner) return;
    this.owner = null;
    this.clear();
  }

  teamDomain() {
    return this.team;
  }

  site(id: string): GuardSite | null {
    const grant = this.grants.get(id);
    const local = grant ? this.local(grant.name) : null;
    return grant && local
      ? {
          audience: grant.audience,
          clients: grant.clients,
          target: local.target,
          host: local.dev ? "localhost" : grant.host,
        }
      : null;
  }

  private clear() {
    this.team = null;
    this.grants.clear();
  }
}

const validGrant = (value: unknown): value is SiteGuardGrant => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  if (
    typeof grant["id"] !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(grant["id"]) ||
    typeof grant["name"] !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(grant["name"]) ||
    typeof grant["host"] !== "string" ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(grant["host"]) ||
    typeof grant["audience"] !== "string" ||
    grant["audience"].length === 0 ||
    grant["audience"].length > 512 ||
    !Array.isArray(grant["clients"]) ||
    grant["clients"].length > 4096
  )
    return false;
  return grant["clients"].every((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const client = item as Record<string, unknown>;
    return (
      typeof client["clientId"] === "string" &&
      client["clientId"].length > 0 &&
      client["clientId"].length <= 512 &&
      (client["until"] === null || (typeof client["until"] === "number" && Number.isFinite(client["until"])))
    );
  });
};

/** Parse the reserved route without ever allowing the path to select an upstream host. */
export function guardRoute(rawUrl: string): { readonly cardId: string; readonly path: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://link-guard");
  } catch {
    return null;
  }
  if (url.origin !== "http://link-guard") return null;
  const parts = url.pathname.split("/");
  const cardId = parts[2];
  if (parts[1] !== "site" || !cardId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(cardId)) return null;
  return { cardId, path: `/${parts.slice(3).join("/")}${url.search}` };
}

/** A link path accepts only a current service-token assertion for that exact card's Access application. */
export async function guardSite(
  request: Pick<IncomingMessage, "headers">,
  cardId: string,
  context: GuardContext,
): Promise<GuardSite | null> {
  const site = context.site(cardId);
  const team = context.teamDomain;
  const assertion = request.headers["cf-access-jwt-assertion"];
  if (!site || !team || typeof assertion !== "string" || assertion === "" || !site.audience) return null;
  try {
    const { payload } = await jwtVerify(assertion, context.keys(team), {
      issuer: `https://${team}`,
      audience: site.audience,
      requiredClaims: ["exp"],
      currentDate: new Date(context.now?.() ?? Date.now()),
    });
    const client = payload["common_name"];
    const allowed = (candidate: GuardSite) =>
      candidate.clients.some(
        (entry) =>
          entry.clientId === client &&
          (entry.until === null ||
            (Number.isFinite(entry.until) && entry.until > (context.now?.() ?? Date.now()))),
      );
    if (typeof client !== "string" || !allowed(site)) return null;
    // A removal or audience change while verification was in flight must not use the old result.
    const current = context.site(cardId);
    if (
      context.teamDomain !== team ||
      !current ||
      current.audience !== site.audience ||
      !allowed(current) ||
      current.target !== site.target ||
      current.host !== site.host
    )
      return null;
    return current;
  } catch {
    return null;
  }
}

const HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "forwarded",
  "x-real-ip",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Strip link credentials and untrusted forwarding headers before passing an application request to its origin. */
export function guardHeaders(rawHeaders: ReadonlyArray<string>, host: string): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const connectionTokens = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "connection")
      for (const token of rawHeaders[i + 1]!.split(",")) connectionTokens.add(token.trim().toLowerCase());
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    const lower = name.toLowerCase();
    if (
      HOP.has(lower) ||
      connectionTokens.has(lower) ||
      lower.startsWith("cf-") ||
      lower.startsWith("x-forwarded-")
    )
      continue;
    if (lower === "cookie") {
      const kept = withoutAccessCookie(value);
      if (kept) headers.push([name, kept]);
    } else headers.push([name, value]);
  }
  headers.push(["host", host], ["x-forwarded-host", host], ["x-forwarded-proto", "https"]);
  return headers;
}

/** Only locally registered Unix sockets and loopback HTTP ports may be an origin. */
function localTarget(target: string): { socketPath: string } | { hostname: string; port: number } | null {
  if (target.startsWith("unix:/") && !/[\r\n]/.test(target)) {
    const socketPath = target.slice(5);
    return isSocketFile(socketPath) ? { socketPath } : null;
  }
  const match = /^http:\/\/localhost:(\d{1,5})$/.exec(target);
  const port = Number(match?.[1]);
  return match && port >= 1 && port <= 65535 ? { hostname: "localhost", port } : null;
}

/** A site's response cannot set a Cloudflare Access session on the reserved link host. */
function responseHeaders(rawHeaders: ReadonlyArray<string>): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const connectionTokens = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "connection")
      for (const token of rawHeaders[i + 1]!.split(",")) connectionTokens.add(token.trim().toLowerCase());
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!;
    const value = rawHeaders[i + 1]!;
    const lower = name.toLowerCase();
    if (HOP.has(lower) || connectionTokens.has(lower) || lower.startsWith("cf-access-")) continue;
    if (lower === "set-cookie" && value.trimStart().startsWith("CF_Authorization=")) continue;
    headers.push([name, value]);
  }
  return headers;
}

/**
 * The destination daemon serves its reserved link host on a private Unix socket. Cloudflared and the daemon run as
 * the same user. The source request names only a card; its audience, local target and Host come from the daemon.
 */
export function serveSiteGuard(path: string, context: GuardContext): Promise<{ readonly stop: () => void }> {
  const server = createServer((request, response) => {
    void forward(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else refuse(response, 502);
    });
  });
  const refuse = (response: ServerResponse, code: number) => {
    if (!response.destroyed) {
      response.writeHead(code, { "content-type": "text/plain" });
      response.end(code === 403 ? "Forbidden" : "Bad gateway");
    }
  };
  const forward = async (request: IncomingMessage, response: ServerResponse) => {
    const route = guardRoute(request.url ?? "/");
    const site = route ? await guardSite(request, route.cardId, context) : null;
    if (!route || !site) return refuse(response, 403);
    if (response.destroyed) return;
    const target = localTarget(site.target);
    if (!target) return refuse(response, 502);
    let upstreamResponse: IncomingMessage | null = null;
    let upstream: ClientRequest;
    try {
      upstream = httpRequest({
        ...target,
        method: request.method,
        path: route.path,
        headers: guardHeaders(request.rawHeaders, site.host).flat(),
      });
    } catch {
      return refuse(response, 502);
    }
    const close = () => {
      if (!response.writableFinished) {
        upstream.destroy();
        upstreamResponse?.destroy();
      }
    };
    response.once("close", close);
    upstream.once("response", (answer) => {
      upstreamResponse = answer;
      response.writeHead(answer.statusCode ?? 502, responseHeaders(answer.rawHeaders).flat());
      answer.once("error", () => response.destroy());
      answer.pipe(response);
    });
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else refuse(response, 502);
    });
    request.once("error", () => upstream.destroy());
    request.pipe(upstream);
  };
  server.on("upgrade", (request, client, head) => {
    // An error before authorization finishes must not crash the daemon.
    client.once("error", () => client.destroy());
    void upgrade(request, client, head).catch(() => client.destroy());
  });
  const upgrade = async (request: IncomingMessage, client: Duplex, head: Buffer) => {
    const deny = (code: number) => {
      if (!client.destroyed) client.end(`HTTP/1.1 ${code} Refused\r\nConnection: close\r\n\r\n`);
    };
    const route = guardRoute(request.url ?? "/");
    const site = route ? await guardSite(request, route.cardId, context) : null;
    if (!route || !site) return deny(403);
    if (client.destroyed) return;
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") return deny(400);
    const target = localTarget(site.target);
    if (!target) return deny(502);
    let upstream: ClientRequest;
    try {
      upstream = httpRequest({
        ...target,
        method: "GET",
        path: route.path,
        headers: [
          ...guardHeaders(request.rawHeaders, site.host),
          ["Connection", "Upgrade"],
          ["Upgrade", "websocket"],
        ].flat(),
      });
    } catch {
      return deny(502);
    }
    upstream.once("upgrade", (answer, socket, first) => {
      const lines = [
        `HTTP/1.1 ${answer.statusCode ?? 101} Switching Protocols`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        ...responseHeaders(answer.rawHeaders).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      client.write(lines.join("\r\n"));
      if (first.length) client.write(first);
      if (head.length) socket.write(head);
      client.pipe(socket);
      socket.pipe(client);
      socket.once("error", () => client.destroy());
      client.once("error", () => socket.destroy());
      client.once("close", () => socket.destroy());
      socket.once("close", () => client.destroy());
    });
    upstream.once("response", (answer) => {
      if (!client.destroyed) {
        const lines = [
          `HTTP/1.1 ${answer.statusCode ?? 502} Refused`,
          "Connection: close",
          ...responseHeaders(answer.rawHeaders).map(([name, value]) => `${name}: ${value}`),
          "",
          "",
        ];
        client.write(lines.join("\r\n"));
        answer.pipe(client);
      }
    });
    upstream.once("error", () => deny(502));
    client.once("close", () => upstream.destroy());
    upstream.end();
  };
  try {
    rmSync(path, { force: true });
  } catch {
    // The listener reports a useful error if the old socket cannot be removed.
  }
  const listener = createListener((socket) => {
    // Like the link socket, a silent connection cannot hold one of the limited slots indefinitely (K-621).
    const quiet = setTimeout(() => socket.destroy(), 30_000);
    socket.once("data", () => clearTimeout(quiet));
    socket.once("close", () => clearTimeout(quiet));
    socket.once("error", () => socket.destroy());
    server.emit("connection", socket);
  });
  listener.maxConnections = 64;
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(path, () => {
      try {
        chmodSync(path, 0o600);
        resolve({
          stop: () => {
            listener.close();
            server.close();
            rmSync(path, { force: true });
          },
        });
      } catch (error) {
        listener.close();
        reject(error);
      }
    });
  });
}
