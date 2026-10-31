import { mkdtempSync, symlinkSync } from "node:fs";
import { type IncomingMessage, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  type GuardContext,
  SiteGuardReach,
  guardHeaders,
  guardRoute,
  guardSite,
  serveSiteGuard,
} from "./site-guard.ts";

const TEAM = "team.cloudflareaccess.com";
const NOW = 1_800_000_000_000;
const pair = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
const token = (audience: string, more: { exp?: number; issuer?: string; commonName?: string } = {}) =>
  new SignJWT({ common_name: more.commonName ?? "mac.access" })
    .setProtectedHeader({ alg: "RS256", kid: "k" })
    .setIssuer(more.issuer ?? `https://${TEAM}`)
    .setAudience(audience)
    .setExpirationTime(more.exp ?? Math.floor(NOW / 1000) + 3600)
    .sign(pair.privateKey);
const site = {
  audience: "aud-a",
  clients: [{ clientId: "mac.access", until: null }],
  target: "http://localhost:8317",
  host: "app.example.com",
};
const context: GuardContext = {
  teamDomain: TEAM,
  site: (id) => (id === "live-mac-a" ? site : id === "live-mac-b" ? { ...site, audience: "aud-b" } : null),
  keys: () => keys,
  now: () => NOW,
};
const unixIt = process.platform === "win32" ? it.skip : it;
const request = (assertion?: string): Pick<IncomingMessage, "headers"> => ({
  headers: assertion === undefined ? {} : { "cf-access-jwt-assertion": assertion },
});

describe("the reserved site-link guard (K-1609)", () => {
  it("accepts grants only from the current connection and reads targets from the local registry", () => {
    let local = { target: "http://localhost:8317", dev: false };
    const reach = new SiteGuardReach((name) => (name === "proxy" ? local : null));
    const first = {};
    const second = {};
    const grant = { id: "live-mac-a", name: "proxy", ...site };
    expect(reach.apply(first, TEAM, [grant])).toBe(false);
    reach.connect(first);
    expect(reach.apply(first, TEAM, [grant])).toBe(true);
    expect(reach.teamDomain()).toBe(TEAM);
    expect(reach.site("live-mac-a")).toEqual(site);
    // A pushed target cannot direct traffic: only the registry's target is used.
    local = { target: "http://localhost:9999", dev: true };
    expect(reach.site("live-mac-a")).toMatchObject({ target: "http://localhost:9999", host: "localhost" });
    reach.connect(second);
    expect(reach.site("live-mac-a")).toBeNull();
    expect(reach.apply(first, TEAM, [grant])).toBe(false);
    expect(reach.apply(second, TEAM, [grant])).toBe(true);
    reach.disconnect(first);
    expect(reach.site("live-mac-a")).not.toBeNull();
    // Malformed updates fail closed instead of leaving an older grant active.
    expect(reach.apply(second, TEAM, [{ ...grant, clients: "invalid" }])).toBe(false);
    expect(reach.site("live-mac-a")).toBeNull();
    expect(reach.apply(second, TEAM, [grant])).toBe(true);
    reach.disconnect(second);
    expect(reach.teamDomain()).toBeNull();
    expect(reach.site("live-mac-a")).toBeNull();
  });

  it("takes the card from its reserved path and never takes a host from the caller", () => {
    expect(guardRoute("/site/live-mac-a/v1/messages?stream=1")).toEqual({
      cardId: "live-mac-a",
      path: "/v1/messages?stream=1",
    });
    expect(guardRoute("/site/live-mac-a//evil.example/x")).toEqual({
      cardId: "live-mac-a",
      path: "//evil.example/x",
    });
    for (const path of ["/", "/site/", "/site/other%2fhost/", "//evil.example/site/live-mac-a/x"])
      expect(guardRoute(path)).toBeNull();
  });

  it("requires a current assertion for this card's own path app", async () => {
    const a = await token("aud-a");
    expect(await guardSite(request(a), "live-mac-a", context)).toEqual(site);
    expect(await guardSite(request(a), "live-mac-b", context)).toBeNull();
    expect(await guardSite(request(), "live-mac-a", context)).toBeNull();
    expect(await guardSite(request("forged"), "live-mac-a", context)).toBeNull();
    expect(
      await guardSite(request(await token("aud-a", { exp: NOW / 1000 - 1 })), "live-mac-a", context),
    ).toBeNull();
    expect(
      await guardSite(
        request(await token("aud-a", { issuer: "https://evil.example" })),
        "live-mac-a",
        context,
      ),
    ).toBeNull();
    expect(
      await guardSite(request(await token("aud-a", { commonName: "" })), "live-mac-a", context),
    ).toBeNull();
    // A stale Access policy must not admit a machine that the current Kitshn grants removed.
    expect(
      await guardSite(request(await token("aud-a", { commonName: "removed.access" })), "live-mac-a", context),
    ).toBeNull();
    expect(await guardSite(request(a), "other", context)).toBeNull();
  });

  it("checks the current grants again after asynchronous signature verification", async () => {
    let current: typeof site | null = site;
    const beforeVerification = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const changing: GuardContext = {
      ...context,
      site: () => current,
      keys:
        () =>
        async (...args) => {
          beforeVerification.resolve();
          await resume.promise;
          return keys(...args);
        },
    };
    const checking = guardSite(request(await token("aud-a")), "live-mac-a", changing);
    await beforeVerification.promise;
    current = { ...site, clients: [] };
    resume.resolve();
    expect(await checking).toBeNull();
  });

  it("rejects a token if the trusted Access team changes during verification", async () => {
    let team: string | null = TEAM;
    const beforeVerification = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const changing: GuardContext = {
      ...context,
      get teamDomain() {
        return team;
      },
      keys:
        () =>
        async (...args) => {
          beforeVerification.resolve();
          await resume.promise;
          return keys(...args);
        },
    };
    const checking = guardSite(request(await token("aud-a")), "live-mac-a", changing);
    await beforeVerification.promise;
    team = "other.cloudflareaccess.com";
    resume.resolve();
    expect(await checking).toBeNull();
  });

  it("does not extend a machine's grant past its own expiry", async () => {
    const a = await token("aud-a");
    const expiring: GuardContext = {
      ...context,
      site: () => ({ ...site, clients: [{ clientId: "mac.access", until: NOW }] }),
    };
    expect(await guardSite(request(a), "live-mac-a", expiring)).toBeNull();
    expect(
      await guardSite(request(a), "live-mac-a", {
        ...expiring,
        site: () => ({ ...site, clients: [{ clientId: "mac.access", until: NOW + 1 }] }),
      }),
    ).not.toBeNull();
  });

  unixIt("serves only the authorized local site and strips identity in both directions", async () => {
    let seen: Request | null = null;
    let body = "";
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen = request;
        body = await request.text();
        return new Response(`${request.method} ${new URL(request.url).pathname}`, {
          headers: [
            ["Set-Cookie", "CF_Authorization=upstream; Path=/"],
            ["Set-Cookie", "theme=dark; Path=/"],
          ],
        });
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-guard-")), "guard.sock");
    let target = `http://localhost:${upstream.port}`;
    const live: GuardContext = {
      ...context,
      site: (id) => (id === "live-mac-a" ? { ...site, target } : null),
    };
    const guard = await serveSiteGuard(path, live);
    try {
      expect(
        (await fetch("http://guard/site/live-mac-a/v1/messages", { unix: path } as RequestInit)).status,
      ).toBe(403);
      const a = await token("aud-a");
      const answer = await fetch("http://guard/site/live-mac-a/v1/messages?stream=1", {
        unix: path,
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": a,
          "cf-access-client-secret": "do-not-forward",
          "x-forwarded-host": "evil.example",
          cookie: "CF_Authorization=private; lang=he",
          authorization: "Bearer local-key",
        },
        body: "hello",
      } as RequestInit);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("POST /v1/messages");
      expect(body).toBe("hello");
      const headers = (seen as Request | null)?.headers;
      expect(headers?.get("authorization")).toBe("Bearer local-key");
      expect(headers?.get("host")).toBe("app.example.com");
      expect(headers?.get("x-forwarded-host")).toBe("app.example.com");
      expect(headers?.get("cookie")).toBe("lang=he");
      expect(headers?.has("cf-access-jwt-assertion")).toBe(false);
      expect(headers?.has("cf-access-client-secret")).toBe(false);
      expect(answer.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
      target = "http://192.0.2.1:80";
      expect(
        (
          await fetch("http://guard/site/live-mac-a/v1/messages", {
            unix: path,
            headers: { "cf-access-jwt-assertion": a },
          } as RequestInit)
        ).status,
      ).toBe(502);
    } finally {
      guard.stop();
      void upstream.stop(true);
    }
  });

  unixIt("reaches a registered Unix socket and refuses a symlink to one", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kitshn-site-origin-"));
    const originPath = join(folder, "origin.sock");
    const linkPath = join(folder, "origin-link.sock");
    const upstream = createServer((_request, response) => response.end("local socket"));
    await new Promise<void>((resolve) => upstream.listen(originPath, resolve));
    symlinkSync(originPath, linkPath);
    let target = `unix:${originPath}`;
    const guardPath = join(folder, "guard.sock");
    const guard = await serveSiteGuard(guardPath, {
      ...context,
      site: (id) => (id === "live-mac-a" ? { ...site, target } : null),
    });
    try {
      const options = {
        unix: guardPath,
        headers: { "cf-access-jwt-assertion": await token("aud-a") },
      } as RequestInit;
      expect(await (await fetch("http://guard/site/live-mac-a/", options)).text()).toBe("local socket");
      target = `unix:${linkPath}`;
      expect((await fetch("http://guard/site/live-mac-a/", options)).status).toBe(502);
    } finally {
      guard.stop();
      upstream.close();
    }
  });

  unixIt("forwards incremental responses without waiting for the origin to finish", async () => {
    const release = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
              await release.promise;
              controller.enqueue(new TextEncoder().encode("second\n"));
              controller.close();
            },
          }),
        );
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-guard-stream-")), "guard.sock");
    const guard = await serveSiteGuard(path, {
      ...context,
      site: (id) => (id === "live-mac-a" ? { ...site, target: `http://localhost:${upstream.port}` } : null),
    });
    try {
      const answer = await fetch("http://guard/site/live-mac-a/v1/messages", {
        unix: path,
        headers: { "cf-access-jwt-assertion": await token("aud-a") },
      } as RequestInit);
      const reader = answer.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
      release.resolve();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("second\n");
      expect((await reader.read()).done).toBe(true);
    } finally {
      release.resolve();
      guard.stop();
      void upstream.stop(true);
    }
  });

  unixIt("upgrades WebSockets only after checking and stripping the assertion", async () => {
    let seen: Headers | null = null;
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        seen = request.headers;
        if (server.upgrade(request)) return undefined;
        return new Response("not upgraded", { status: 400 });
      },
      websocket: {
        message: (socket, message) => {
          socket.send(`echo ${String(message)}`);
        },
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-guard-ws-")), "guard.sock");
    const guard = await serveSiteGuard(path, {
      ...context,
      site: (id) => (id === "live-mac-a" ? { ...site, target: `http://localhost:${upstream.port}` } : null),
    });
    try {
      expect(await webSocketEcho(path, await token("aud-a"))).toBe("echo hello");
      expect((seen as Headers | null)?.has("cf-access-jwt-assertion")).toBe(false);
      expect((seen as Headers | null)?.has("cf-access-client-secret")).toBe(false);
    } finally {
      guard.stop();
      void upstream.stop(true);
    }
  });

  unixIt("cancels the origin when a streaming client disconnects", async () => {
    const cancelled = Promise.withResolvers<void>();
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        request.signal.addEventListener("abort", () => cancelled.resolve());
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        );
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-guard-cancel-")), "guard.sock");
    const guard = await serveSiteGuard(path, {
      ...context,
      site: (id) => (id === "live-mac-a" ? { ...site, target: `http://localhost:${upstream.port}` } : null),
    });
    const client = new AbortController();
    try {
      const answer = await fetch("http://guard/site/live-mac-a/v1/messages", {
        unix: path,
        headers: { "cf-access-jwt-assertion": await token("aud-a") },
        signal: client.signal,
      } as RequestInit);
      expect(new TextDecoder().decode((await answer.body!.getReader().read()).value)).toBe("first\n");
      client.abort();
      await Promise.race([
        cancelled.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("origin stayed open")), 3000)),
      ]);
    } finally {
      client.abort();
      guard.stop();
      void upstream.stop(true);
    }
  });

  it("strips Cloudflare credentials, Access cookies, spoofed forwarding and connection-nominated headers", () => {
    expect(
      guardHeaders(
        [
          "Authorization",
          "Bearer local-key",
          "CF-Access-Jwt-Assertion",
          "assertion",
          "CF-Access-Client-Secret",
          "credential",
          "CF-Connecting-IP",
          "127.0.0.1",
          "Cookie",
          "lang=he; CF_Authorization=session",
          "X-Forwarded-Host",
          "evil.example",
          "Forwarded",
          "for=evil.example",
          "X-Real-IP",
          "evil.example",
          "Connection",
          "X-Remove, keep-alive",
          "X-Remove",
          "not-end-to-end",
          "Content-Type",
          "application/json",
        ],
        "app.example.com",
      ),
    ).toEqual([
      ["Authorization", "Bearer local-key"],
      ["Cookie", "lang=he"],
      ["Content-Type", "application/json"],
      ["host", "app.example.com"],
      ["x-forwarded-host", "app.example.com"],
      ["x-forwarded-proto", "https"],
    ]);
  });
});

/** Bun's WebSocket client has no Unix socket option, so the test makes its handshake and one masked frame. */
function webSocketEcho(path: string, assertion: string): Promise<string> {
  const result = Promise.withResolvers<string>();
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  void Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        socket.write(
          [
            "GET /site/live-mac-a/ws HTTP/1.1",
            "Host: link",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            `CF-Access-Jwt-Assertion: ${assertion}`,
            "CF-Access-Client-Secret: should-not-reach-origin",
            "",
            "",
          ].join("\r\n"),
        );
      },
      data(socket, chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 101")) {
            result.reject(new Error(buffer.subarray(0, end).toString()));
            socket.end();
            return;
          }
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          const payload = Buffer.from("hello");
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = payload.map((byte, index) => byte ^ mask[index % 4]!);
          socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
        }
        if (buffer.length >= 2 && buffer.length >= 2 + (buffer[1]! & 0x7f)) {
          result.resolve(buffer.subarray(2, 2 + (buffer[1]! & 0x7f)).toString());
          socket.end();
        }
      },
      error(_socket, error) {
        result.reject(error);
      },
    },
  });
  return result.promise;
}
