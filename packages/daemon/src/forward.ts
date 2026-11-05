// K-1714: the pure parts of a call that the daemon forwards to `/agent` or `/op` for a local agent.
import { FORWARD_HEADERS, forwardUrl } from "@kitshn/edge/machine";

/** At most this many forwarded calls run at once, so allowed local users cannot fill the daemon's memory. */
export const MAX_FORWARDS = 4;

/** The URL of the call, or why the daemon refuses it: it must stay on the server and below `/agent/` or `/op/` (K-1714, K-1777). */
export const forwardTarget = (server: string, path: string): URL | string => forwardUrl(server, path);

const OWN_HEADERS: ReadonlySet<string> = new Set(Object.values(FORWARD_HEADERS));

/** The caller's headers that pass: `x-kitshn-*` and the content type, never the daemon's own signature headers. */
export const passedHeaders = (headers: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return (lower.startsWith("x-kitshn-") && !OWN_HEADERS.has(lower)) || lower === "content-type";
    }),
  );

/** The body of an answer, read only up to `max` bytes; a longer answer throws while it is read. */
export async function readBounded(response: Response, max: number): Promise<Buffer> {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error(`kitshn answered more than ${max} bytes, the limit of a forwarded call (K-1714).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
