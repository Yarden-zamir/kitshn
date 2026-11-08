import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { SWAP, UNSWAP, backupSummary, keptRuns, oldWaysBack, startProxy } from "./backup.ts";

describe("restic output (K-1817)", () => {
  it("reads the summary line of restic backup --json, and fails on output without one", () => {
    const stdout = [
      '{"message_type":"status","percent_done":0.5}',
      '{"message_type":"summary","snapshot_id":"abc","total_bytes_processed":2000,"data_added":300}',
    ].join("\n");
    expect(backupSummary(stdout)).toEqual({ snapshot: "abc", bytes: 2000, added: 300 });
    expect(() => backupSummary('{"message_type":"status"}')).toThrow(/no summary/);
  });
});

describe("backup helpers (K-1813, K-1817)", () => {
  it("lists the runs that a repository keeps from restic snapshots --json", () => {
    const stdout = JSON.stringify([
      { tags: ["run-a"] },
      { tags: ["run-b", "before-restore"] },
      { tags: ["live-c"] },
      {},
    ]);
    expect(keptRuns(stdout)).toEqual(["a", "b"]);
  });

  it("refuses a request to the proxy without the secret path of its job", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kitshn-proxy-"));
    const proxy = startProxy(
      { server: "https://kit.example.invalid", clientId: "id", clientSecret: "s", data: folder },
      "app-x",
      folder,
    );
    try {
      const response = await fetch("http://localhost/config", { unix: proxy.socket });
      expect(response.status).toBe(403);
      expect(proxy.repository).toMatch(/^rest:http\+unix:\/\/\/run\/kitshn\/proxy\.sock:\/[0-9a-f-]{36}\/$/);
    } finally {
      proxy.stop();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("passes a range answer to restic with its length and range, and not compressed", async () => {
    const asked: Array<string | null> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        asked.push(request.headers.get("accept-encoding"));
        // The second chunk comes later, as from R2, so only the header gives the length.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("23"));
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode("45"));
              controller.close();
            }, 1);
          },
        });
        const headers = { "content-length": "4", "content-range": "bytes 2-5/10" };
        return new Response(request.method === "HEAD" ? null : body, { status: 206, headers });
      },
    });
    const folder = mkdtempSync(join(tmpdir(), "kitshn-proxy-"));
    const proxy = startProxy(
      { server: `http://127.0.0.1:${upstream.port}`, clientId: "id", clientSecret: "s", data: folder },
      "app-x",
      folder,
    );
    const secret = proxy.repository.split(":").at(-1) ?? "";
    try {
      // Raw HTTP, as restic reads it: a fetch client could fill in a length that the wire does not carry.
      const raw = await rawRequest(proxy.socket, `GET ${secret}data/${"a".repeat(64)} HTTP/1.1`);
      const [head = "", body] = raw.split("\r\n\r\n");
      const lines = head.toLowerCase().split("\r\n");
      expect(lines[0]).toBe("http/1.1 206 partial content");
      expect(lines).toContain("content-length: 4");
      expect(lines).toContain("content-range: bytes 2-5/10");
      expect(
        lines.some((line) => line.startsWith("transfer-encoding") || line.startsWith("content-encoding")),
      ).toBe(false);
      expect(body).toBe("2345");
      expect(asked).toEqual(["identity"]);
    } finally {
      proxy.stop();
      void upstream.stop(true);
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

/** One HTTP/1.1 request on a Unix socket; the whole answer as text, after the server closes. */
function rawRequest(socket: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = "";
    const client = connect(socket, () => {
      client.write(`${line}\r\nHost: localhost\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n`);
    });
    client.on("data", (chunk: Buffer) => (answer += chunk.toString("utf8")));
    client.on("end", () => resolve(answer));
    client.on("error", reject);
  });
}

describe("the swap of a restore (K-1820)", () => {
  /** The scripts run with `/s` at a temporary folder, as the helper container runs them. */
  const sh = (script: string, folder: string) =>
    spawnSync("sh", ["-c", script.replace("cd /s", `cd '${folder}'`)], { encoding: "utf8" });
  const tree = (folder: string) => readdirSync(folder).sort();

  function source() {
    const folder = mkdtempSync(join(tmpdir(), "kitshn-swap-"));
    writeFileSync(join(folder, "db"), "now");
    writeFileSync(join(folder, ".hidden"), "now");
    mkdirSync(join(folder, ".kitshn-restore"));
    writeFileSync(join(folder, ".kitshn-restore", "db"), "then");
    writeFileSync(join(folder, ".kitshn-restore", ".env"), "then");
    return folder;
  }

  it("moves the files of now aside and the restored files in, and the way back undoes exactly that", () => {
    const folder = source();
    try {
      expect(sh(SWAP, folder).status).toBe(0);
      expect(readFileSync(join(folder, "db"), "utf8")).toBe("then");
      expect(tree(join(folder, ".kitshn-before"))).toEqual([".hidden", "db"]);
      expect(
        readFileSync(join(folder, ".kitshn-moved-in"), "utf8").split("\n").filter(Boolean).sort(),
      ).toEqual([".env", "db"]);
      expect(sh(UNSWAP, folder).status).toBe(0);
      expect(tree(folder)).toEqual([".hidden", "db"]);
      expect(readFileSync(join(folder, "db"), "utf8")).toBe("now");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("stops at the first mv that fails, and the way back keeps every file of now", () => {
    const folder = source();
    // A folder that refuses changes: no restored entry can move out of it.
    chmodSync(join(folder, ".kitshn-restore"), 0o555);
    try {
      expect(sh(SWAP, folder).status).not.toBe(0);
      expect(sh(UNSWAP, folder).status).toBe(0);
      expect(tree(folder)).toEqual([".hidden", ".kitshn-restore", "db"]);
      expect(readFileSync(join(folder, "db"), "utf8")).toBe("now");
    } finally {
      chmodSync(join(folder, ".kitshn-restore"), 0o755);
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("forgets runs from before a restore by their own time", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const stdout = JSON.stringify([
      { id: "old", time: "2026-10-20T12:00:00Z" },
      { id: "new", time: "2026-10-27T12:00:00Z" },
    ]);
    expect(oldWaysBack(stdout, now)).toEqual(["old"]);
  });
});
