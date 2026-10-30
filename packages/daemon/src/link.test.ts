import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReachedCard } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { linkPeerAdmitted, linkTarget, serveLinks } from "./link.ts";

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
    const links = await serveLinks(path, {
      reachOf: (provider) => (provider === "t3" ? [card(`127.0.0.1:${upstream.port}`)] : []),
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
    } finally {
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
