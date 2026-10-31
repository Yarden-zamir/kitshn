import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReachedCard } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { SiteReach, forwardBody, linkPeerAdmitted, linkTarget, serveLinks } from "./link.ts";

const platform = process.platform === "darwin" ? "darwin" : "linux";
const own = process.getuid!();

const card = (address: string | null): ReachedCard => ({
  machineId: "b",
  machineName: "B",
  kind: "t3.app",
  id: "app",
  address,
  level: "standard",
});

describe("the link proxy (K-1609)", () => {
  it("forgets site reach on disconnect and refuses stale updates or closes after a reconnect", () => {
    const reach = new SiteReach();
    const first = {};
    const next = {};
    const cards = [{ id: "live-b-proxy", address: "kitshn-link-b.example.com" }];
    expect(reach.apply(first, cards)).toBe(false);
    reach.connect(first);
    expect(reach.apply(first, cards)).toBe(true);
    expect(reach.current()).toEqual(cards);
    reach.connect(next);
    expect(reach.current()).toEqual([]);
    expect(reach.apply(first, cards)).toBe(false);
    expect(reach.apply(next, cards)).toBe(true);
    for (const malformed of [
      null,
      [{ ...cards[0], address: "proxy.example.com" }],
      [{ ...cards[0], address: "kitshn-link-b.example.com:8443" }],
      [cards[0], cards[0]],
      [{ ...cards[0], id: "../unsafe" }],
    ]) {
      expect(reach.apply(next, malformed)).toBe(false);
      expect(reach.current()).toEqual([]);
      expect(reach.apply(next, cards)).toBe(true);
    }
    // A stale connection cannot clear the current one's reach.
    expect(reach.apply(first, null)).toBe(false);
    reach.disconnect(first);
    expect(reach.current()).toEqual(cards);
    reach.disconnect(next);
    expect(reach.current()).toEqual([]);
  });

  it("admits the daemon user and the users of kitshn local-users, and no other user (K-701)", async () => {
    expect(linkPeerAdmitted(1000, 1000, [])).toBe(true);
    expect(linkPeerAdmitted(1001, 1000, [1001])).toBe(true);
    expect(linkPeerAdmitted(1002, 1000, [1001])).toBe(false);
    // A list that cannot be read admits no local user.
    expect(linkPeerAdmitted(1001, 1000, null)).toBe(false);
    // The proxy drops a peer that the check refuses, before it reads a request.
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-link-")), "link.sock");
    const links = await serveLinks(path, {
      reachOf: () => [],
      token: () => null,
      log: () => {},
      peers: { platform, access: "shared", admits: (uid) => linkPeerAdmitted(uid, own + 1, []) },
    });
    try {
      await expect(fetch("http://link/t3/b/x", { unix: path } as RequestInit)).rejects.toThrow();
      await expect(fetch("http://link/site/live-b-proxy/x", { unix: path } as RequestInit)).rejects.toThrow();
    } finally {
      links.stop();
    }
  });

  it("reaches only the address of the card of the provider that the path names, on a machine in reach, and a path never changes the host", () => {
    const other: ReachedCard = { ...card("other-b.example.com"), kind: "other.app" };
    const reachOf = (provider: string) =>
      provider === "t3" ? [card(null), card("t3-b.example.com")] : provider === "other" ? [other] : [];
    expect(linkTarget(reachOf, new URL("http://link/t3/b/api/x?y=1"))).toEqual({
      target: new URL("https://t3-b.example.com/api/x?y=1"),
    });
    expect(linkTarget(reachOf, new URL("http://link/other/b/api"))).toMatchObject({
      target: { host: "other-b.example.com" },
    });
    expect(linkTarget(reachOf, new URL("http://link/t3/c/api"))).toMatchObject({ status: 403 });
    expect(linkTarget(reachOf, new URL("http://link/nobody/b/api"))).toMatchObject({ status: 403 });
    expect(linkTarget(reachOf, new URL("http://link/t3/b//evil.example.com/x"))).toMatchObject({
      target: { host: "t3-b.example.com" },
    });
    const sites = [{ id: "live-b-proxy", address: "proxy.example.com" }];
    expect(
      linkTarget(reachOf, new URL("http://link/site/live-b-proxy/v1/messages?stream=1"), "https", sites),
    ).toEqual({ target: new URL("https://proxy.example.com/site/live-b-proxy/v1/messages?stream=1") });
    expect(linkTarget(reachOf, new URL("http://link/site/evil.example.com/x"), "https", sites)).toMatchObject(
      {
        status: 403,
      },
    );
    expect(
      linkTarget(reachOf, new URL("http://link/site/live-b-proxy//evil.example.com/x"), "https", sites),
    ).toMatchObject({ target: { host: "proxy.example.com" } });
  });

  it("adds the machine token, drops the caller's Access headers, and streams HTTP and WebSocket both ways", async () => {
    const seen: Array<Headers> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        seen.push(request.headers);
        if (server.upgrade(request)) return undefined;
        const answer = new Response(`${request.method} ${new URL(request.url).pathname}`);
        answer.headers.append("set-cookie", "CF_Authorization=b-session; Path=/");
        answer.headers.append("set-cookie", "theme=dark; Path=/");
        return answer;
      },
      websocket: {
        message: (socket, message) => {
          socket.send(`echo ${String(message)}`);
        },
      },
    });
    const folder = mkdtempSync(join(tmpdir(), "kitshn-link-"));
    const path = join(folder, "link.sock");
    const calls: Array<object> = [];
    let sites = [{ id: "live-b-proxy", address: `127.0.0.1:${upstream.port}` }];
    const links = await serveLinks(path, {
      reachOf: (provider) => (provider === "t3" ? [card(`127.0.0.1:${upstream.port}`)] : []),
      siteReach: () => sites,
      token: () => ({ clientId: "a.access", clientSecret: "secret" }),
      log: () => {},
      audit: (call) => calls.push(call),
      scheme: "http",
      peers: { platform, access: "private", admits: (uid) => linkPeerAdmitted(uid, own, []) },
    });
    try {
      const answer = await fetch("http://link/t3/b/api/thing", {
        unix: path,
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "forged",
          "x-keep": "1",
          "Kitshn-Audit-Name": "read_file",
          cookie: "CF_Authorization=person; lang=he",
        },
        body: "x".repeat(200_000),
      } as RequestInit);
      expect(await answer.text()).toBe("POST /api/thing");
      expect(seen[0]?.get("cf-access-client-id")).toBe("a.access");
      expect(seen[0]?.get("cf-access-client-secret")).toBe("secret");
      expect(seen[0]?.get("x-keep")).toBe("1");
      // K-1610: the tool name goes to History, never to B.
      expect(seen[0]?.has("kitshn-audit-name")).toBe(false);
      expect(calls).toEqual([{ provider: "t3", machineId: "b", name: "read_file", status: 200 }]);
      // An Access session never crosses the proxy, in either direction.
      expect(seen[0]?.get("cookie")).toBe("lang=he");
      expect(answer.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
      // A call without the header still goes to History, under its method and path without the query.
      await (await fetch("http://link/t3/b/api/thing?token=x", { unix: path } as RequestInit)).text();
      expect(calls.at(-1)).toEqual({ provider: "t3", machineId: "b", name: "GET:/api/thing", status: 200 });
      const refused = await fetch("http://link/t3/other/api", { unix: path } as RequestInit);
      expect(refused.status).toBe(403);

      expect(await webSocketEcho(path, "/t3/b/ws", "hi")).toBe("echo hi");
      const beforeSite = calls.length;
      const siteAnswer = await fetch("http://link/site/live-b-proxy/v1/messages?key=private", {
        unix: path,
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "forged",
          "CF-Access-Client-Secret": "forged",
          "Kitshn-Audit-Name": "private",
          cookie: "CF_Authorization=person; lang=he",
        },
        body: "request body",
      } as RequestInit);
      expect(await siteAnswer.text()).toBe("POST /site/live-b-proxy/v1/messages");
      const siteHeaders = seen.at(-1)!;
      expect(siteHeaders.get("cf-access-client-id")).toBe("a.access");
      expect(siteHeaders.get("cf-access-client-secret")).toBe("secret");
      expect(siteHeaders.get("cookie")).toBe("lang=he");
      expect(siteHeaders.has("kitshn-audit-name")).toBe(false);
      expect(siteAnswer.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
      expect(await webSocketEcho(path, "/site/live-b-proxy/ws", "site")).toBe("echo site");
      expect(calls).toHaveLength(beforeSite);
      sites = [];
      expect(
        (await fetch("http://link/site/live-b-proxy/v1/messages", { unix: path } as RequestInit)).status,
      ).toBe(403);
    } finally {
      links.stop();
      void upstream.stop(true);
    }
  });
  it("does not send a credential after a site share is removed during DNS resolution", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-link-race-")), "link.sock");
    const resolving = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let sites = [{ id: "live-b-proxy", address: "kitshn-link-b.example.com" }];
    const links = await serveLinks(path, {
      reachOf: () => [],
      siteReach: () => sites,
      pinSite: async (target) => {
        resolving.resolve();
        await resume.promise;
        return { dial: new URL("https://104.16.1.2/"), serverName: target.hostname };
      },
      token: () => ({ clientId: "a.access", clientSecret: "secret" }),
      log: () => {},
    });
    try {
      const answer = fetch("http://link/site/live-b-proxy/v1/messages", { unix: path } as RequestInit);
      await resolving.promise;
      sites = [];
      resume.resolve();
      expect((await answer).status).toBe(403);
    } finally {
      resume.resolve();
      links.stop();
    }
  });

  it("stops reading upstream while a slow client has filled its buffer", async () => {
    const slow = new PassThrough({ highWaterMark: 1 });
    const abort = new AbortController();
    let pulled = 0;
    async function* source() {
      pulled++;
      yield new Uint8Array([1]);
      pulled++;
      yield new Uint8Array([2]);
    }
    const forwarding = forwardBody(source(), slow, abort.signal);
    // Let the first write settle. The second chunk must wait for the client to drain the first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pulled).toBe(1);
    slow.resume();
    await forwarding;
    expect(pulled).toBe(2);
  });

  it("cancels an upstream stream when its local client disconnects", async () => {
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
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-cancel-")), "link.sock");
    const links = await serveLinks(path, {
      reachOf: () => [],
      siteReach: () => [{ id: "live-b-proxy", address: `127.0.0.1:${upstream.port}` }],
      token: () => ({ clientId: "a.access", clientSecret: "secret" }),
      log: () => {},
      scheme: "http",
      peers: { platform, access: "private", admits: (uid) => linkPeerAdmitted(uid, own, []) },
    });
    const client = new AbortController();
    try {
      const answer = await fetch("http://link/site/live-b-proxy/v1/messages", {
        unix: path,
        signal: client.signal,
      } as RequestInit);
      const reader = answer.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
      client.abort();
      await Promise.race([
        cancelled.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("upstream stayed open")), 3000)),
      ]);
    } finally {
      client.abort();
      links.stop();
      void upstream.stop(true);
    }
  });

  it("delivers a live-site response incrementally and forwards its request body", async () => {
    const release = Promise.withResolvers<void>();
    let body = "";
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        body = await request.text();
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
    const path = join(mkdtempSync(join(tmpdir(), "kitshn-site-stream-")), "link.sock");
    const links = await serveLinks(path, {
      reachOf: () => [],
      siteReach: () => [{ id: "live-b-proxy", address: `127.0.0.1:${upstream.port}` }],
      token: () => ({ clientId: "a.access", clientSecret: "secret" }),
      log: () => {},
      scheme: "http",
      peers: { platform, access: "private", admits: (uid) => linkPeerAdmitted(uid, own, []) },
    });
    try {
      const answer = await fetch("http://link/site/live-b-proxy/v1/messages", {
        unix: path,
        method: "POST",
        body: "request body",
      } as RequestInit);
      const reader = answer.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("first\n");
      expect(body).toBe("request body");
      release.resolve();
      const second = await reader.read();
      expect(new TextDecoder().decode(second.value)).toBe("second\n");
      expect((await reader.read()).done).toBe(true);
    } finally {
      release.resolve();
      links.stop();
      void upstream.stop(true);
    }
  });
});

/**
 * One text message through a WebSocket on a Unix socket, with the handshake by hand: Bun's WebSocket client has no
 * Unix socket option. A client frame is masked; the server's answer frame is not.
 */
function webSocketEcho(path: string, target: string, text: string): Promise<string> {
  const answer = Promise.withResolvers<string>();
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  void Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        socket.write(
          [
            `GET ${target} HTTP/1.1`,
            "Host: link",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
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
            answer.reject(new Error(buffer.subarray(0, end).toString()));
            socket.end();
            return;
          }
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          const payload = Buffer.from(text);
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = payload.map((byte, index) => byte ^ mask[index % 4]!);
          socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
        }
        if (buffer.length >= 2 && buffer.length >= 2 + (buffer[1]! & 0x7f)) {
          answer.resolve(buffer.subarray(2, 2 + (buffer[1]! & 0x7f)).toString());
          socket.end();
        }
      },
    },
  });
  return answer.promise;
}
