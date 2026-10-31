export class CloudflareError extends Error {
  override readonly name = "CloudflareError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly result_info?: { readonly total_count?: number };
  readonly errors?: ReadonlyArray<{ readonly code: number; readonly message: string }>;
}

/** One Cloudflare API call. Each call is one subrequest (K-406). */
export async function cloudflare<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return (await envelope<T>(token, method, path, body)).result;
}

/** K-1303: the number of items of a list, from one call with one item per page. */
export async function cloudflareCount(token: string, path: string): Promise<number> {
  const answer = await envelope<unknown>(token, "GET", `${path}${path.includes("?") ? "&" : "?"}per_page=1`);
  const total = answer.result_info?.total_count;
  if (typeof total !== "number") throw new CloudflareError(200, `GET ${path} answered no total_count.`);
  return total;
}

/**
 * One GraphQL Analytics query. Its answer has `data` and `errors`, not the envelope of the REST API. A refused field
 * is null in `data` and has an error with its alias in `path`, so the caller keeps the other fields.
 */
export async function cloudflareGraphql<T>(
  token: string,
  query: string,
  variables: object,
): Promise<{ readonly data: T; readonly errors: Readonly<Record<string, string>> }> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const answer = (await response.json().catch(() => null)) as {
    data?: T | null;
    errors?: ReadonlyArray<{ message: string; path?: ReadonlyArray<string | number> }> | null;
  } | null;
  if (!response.ok || !answer?.data)
    throw new CloudflareError(
      response.status,
      `GraphQL failed (${response.status}): ${answer?.errors?.map((error) => error.message).join("; ") ?? "no data"}`,
    );
  const errors: Record<string, string> = {};
  for (const error of answer.errors ?? []) {
    const alias = error.path?.at(-1);
    if (typeof alias === "string") errors[alias] = error.message;
  }
  return { data: answer.data, errors };
}

async function envelope<T>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Envelope<T>> {
  // K-408: no answer at all is status 0, so a caller tells it apart from a refusal and from a bug of its own.
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error: unknown) => {
    throw new CloudflareError(0, `${method} ${path}: no answer from Cloudflare: ${String(error)}`);
  });
  const text = await response.text();
  // Some DELETE calls (for example of a Worker custom domain) answer 200 with no body at all.
  if (method === "DELETE" && response.ok && text.trim() === "")
    return { success: true, result: undefined as T };
  let envelope: Envelope<T> | null = null;
  try {
    envelope = JSON.parse(text) as Envelope<T>;
  } catch {
    // Not JSON: report the status and the start of the text.
  }
  if (!response.ok || !envelope?.success) {
    const reason = envelope?.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new CloudflareError(
      response.status,
      `${method} ${path} failed (${response.status}): ${reason ?? text.slice(0, 200)}`,
    );
  }
  return envelope;
}
