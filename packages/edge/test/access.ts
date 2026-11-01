import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { vi } from "vitest";
import worker from "../src/worker/index.ts";

const TEAM = "https://team.example.com";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };

/** A second key pair that the team does not publish. */
export const strangerKeys = await generateKeyPair("RS256");

/**
 * An Access token signed by the test team key, as Access sends it in `Cf-Access-Jwt-Assertion`. `changes` makes a
 * token that the Worker must refuse.
 */
export const accessToken = (
  audience: string,
  claims: { email: string } | { common_name: string },
  changes: { key?: CryptoKey; issuer?: string; expiresAt?: number; issuedAt?: number } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(changes.issuer ?? TEAM)
    .setAudience(audience)
    .setIssuedAt(changes.issuedAt)
    .setExpirationTime(changes.expiresAt ?? "5m")
    .sign(changes.key ?? keys.privateKey);

/** The Worker fetches only the team keys; any other outbound request fails the test. */
export function stubAccessCerts() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

/** One request to the Worker on the admin host, as Cloudflare sends it. */
export async function send(path: string, init: RequestInit<IncomingRequestCfProperties> = {}) {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://kit.example.com${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  // Read the whole body here: an unread body keeps the request to the Durable Object open, so a later eviction waits.
  const body = [101, 204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, response);
}
