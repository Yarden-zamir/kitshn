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
  readonly result_info?: {
    readonly count?: number;
    readonly page?: number;
    readonly per_page?: number;
    readonly total_count?: number;
    readonly total_pages?: number;
  };
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

/**
 * A complete paginated list, bounded so hostname inspection cannot consume an entire alarm budget. A partial or
 * ambiguous answer is an error: reserved link hosts must not send credentials to an address held by an unseen object.
 */
export async function cloudflareCompleteList<T>(token: string, path: string): Promise<Array<T>> {
  const result: Array<T> = [];
  let pages: number | undefined;
  let count: number | undefined;
  let perPage: number | undefined;
  for (let page = 1; page <= (pages ?? 1); page++) {
    const query = `${path}${path.includes("?") ? "&" : "?"}per_page=1000&page=${page}`;
    const answer = await envelope<Array<T>>(token, "GET", query);
    const info = answer.result_info;
    if (
      !Array.isArray(answer.result) ||
      !info ||
      info.page !== page ||
      info.count !== answer.result.length ||
      typeof info.per_page !== "number" ||
      !Number.isInteger(info.per_page) ||
      info.per_page <= 0 ||
      info.per_page < answer.result.length ||
      typeof info.total_pages !== "number" ||
      !Number.isInteger(info.total_pages) ||
      info.total_pages < 0 ||
      info.total_pages > 4 ||
      (info.total_pages === 0 && (page !== 1 || answer.result.length !== 0)) ||
      (info.total_pages !== 0 && info.total_pages < page) ||
      (pages !== undefined && info.total_pages !== pages) ||
      (perPage !== undefined && info.per_page !== perPage) ||
      (info.total_count !== undefined &&
        (!Number.isSafeInteger(info.total_count) ||
          info.total_count < 0 ||
          Math.ceil(info.total_count / info.per_page) !== info.total_pages)) ||
      (page > 1 && info.total_count !== count)
    )
      throw new CloudflareError(200, `GET ${path} did not prove that the listing is complete.`);
    pages = info.total_pages;
    count = info.total_count;
    perPage = info.per_page;
    result.push(...answer.result);
  }
  if (count !== undefined && result.length !== count)
    throw new CloudflareError(200, `GET ${path} did not prove that the listing is complete.`);
  // Pagination through an inventory changing under us can repeat a record and omit a different one.
  const identities = result.map((item) => {
    if (typeof item === "object" && item !== null) {
      const value = item as Record<string, unknown>;
      if (typeof value["id"] === "string") return `id:${value["id"]}`;
      if (typeof value["hostname"] === "string") return `hostname:${value["hostname"]}`;
      if (typeof value["pattern"] === "string") return `pattern:${value["pattern"]}`;
    }
    return JSON.stringify(item);
  });
  if (new Set(identities).size !== identities.length)
    throw new CloudflareError(200, `GET ${path} did not prove that the listing is complete.`);
  return result;
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
