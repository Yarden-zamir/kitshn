import { CliError, errorText } from "./cli-error.ts";

/**
 * K-812: sends one file of a deploy, and once more after a network error or a 5xx answer. A second send of the same
 * deploy file overwrites the same R2 object while the deploy is planned, so it changes nothing else. Answers the last
 * response; a second network error throws.
 */
export async function sendOnceMore(path: string, send: () => Promise<Response>): Promise<Response> {
  try {
    const response = await send();
    if (response.status < 500) return response;
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    const why = data?.error ? `: ${data.error}` : "";
    console.error(`kitshn: ${path} answered ${response.status}${why}; kitshn sends it once more.`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    console.error(`kitshn: ${path} failed (${errorText(error)}); kitshn sends it once more.`);
  }
  return send();
}
