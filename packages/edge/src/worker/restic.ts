// K-1813: the restic REST protocol (v1 and v2) over the R2 binding, below `backups/<card>/`.
import { resticObject } from "../core/backups.ts";

const V2 = "application/vnd.x.restic.rest.v2";

/** `bytes=<start>-<end>` or `bytes=<start>-`; null for any other form, which restic does not send. */
export function parseRange(header: string): { offset: number; length?: number } | null {
  if (!header.startsWith("bytes=")) return null;
  const [start = "", end = ""] = header.slice("bytes=".length).split("-");
  const offset = Number(start);
  if (start === "" || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (end === "") return { offset };
  const last = Number(end);
  if (!Number.isSafeInteger(last) || last < offset) return null;
  return { offset, length: last - offset + 1 };
}

/** K-1813: one restic request. `path` is the part after `/connect/backups/<card>`. */
export async function serveRestic(bucket: R2Bucket, card: string, path: string, request: Request) {
  const method = request.method;
  // `restic init` asks the server to make the repository; R2 needs no folders.
  if ((path === "" || path === "/") && method === "POST") return new Response(null, { status: 200 });
  const target = resticObject(card, path);
  if (!target) return new Response("Not a restic path.", { status: 404 });
  if ("list" in target) {
    if (method !== "GET") return new Response("Use GET.", { status: 405 });
    const files: Array<{ name: string; size: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: target.list, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects)
        files.push({ name: object.key.slice(target.list.length), size: object.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return request.headers.get("accept")?.includes(V2)
      ? Response.json(files, { headers: { "content-type": V2 } })
      : Response.json(files.map((file) => file.name));
  }
  if (method === "HEAD") {
    const head = await bucket.head(target.key);
    return head
      ? new Response(null, { headers: { "content-length": String(head.size) } })
      : new Response(null, { status: 404 });
  }
  if (method === "GET") {
    const header = request.headers.get("range");
    const range = header === null ? null : parseRange(header);
    if (header !== null && range === null)
      return new Response("kitshn reads only bytes=<start>-<end>.", { status: 416 });
    const object = await bucket.get(target.key, range ? { range } : {});
    if (!object) return new Response("Not found.", { status: 404 });
    // restic refuses a range answer whose Content-Length is not the asked length. no-transform keeps the
    // Cloudflare edge from compressing the body, which would drop the length.
    const headers = new Headers({ "cache-control": "no-transform" });
    if (!range) {
      headers.set("content-length", String(object.size));
      return new Response(object.body, { status: 200, headers });
    }
    if (range.offset >= object.size) {
      headers.set("content-range", `bytes */${object.size}`);
      return new Response("The range starts after the end of the file.", { status: 416, headers });
    }
    const length = Math.min(range.length ?? object.size, object.size - range.offset);
    headers.set("content-length", String(length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + length - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  if (method === "POST") {
    const header = request.headers.get("content-length");
    const size = Number(header);
    if (header === null || !request.body || !Number.isSafeInteger(size) || size < 0)
      return new Response("Send a Content-Length.", { status: 411 });
    // A fixed length stream lets R2 take the body as it comes, so the Worker holds no pack in memory.
    const { readable, writable } = new FixedLengthStream(size);
    const piped = request.body.pipeTo(writable);
    try {
      await Promise.all([bucket.put(target.key, readable), piped]);
    } catch (error) {
      return new Response(`The body did not reach R2: ${String(error)}`, { status: 400 });
    }
    return new Response(null, { status: 200 });
  }
  if (method === "DELETE") {
    await bucket.delete(target.key);
    return new Response(null, { status: 200 });
  }
  return new Response("Not a restic method.", { status: 405 });
}

/** K-1815: the repository password of a card, HMAC-SHA-256 of its id under `KITSHN_BACKUP_KEY`, as hex. */
export async function backupPassword(secret: string, card: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(card)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
