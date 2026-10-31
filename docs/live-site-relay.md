# Proposed machine-to-machine live-site relay

Status: draft design and authorization/flow-control primitives only. No relay opens yet. The earlier guarded-host
prototype remains in this branch's history; it must not be enabled. The relay implementation and the rollout tests
below are still required.

## Goal

A program on machine A can use a `site.live` card on machine B when A is a member of a circle that holds the card.
The existing signed daemon connections identify both machines; the caller needs no new VPN, manually copied service
token, public hostname, Access application, DNS record or per-pair pairing step. This is a Kitshn capability for HTTP
services, not a Claude-specific feature.

For the motivating case, A is a VPS and B is a Mac that runs an account-switching proxy. The source daemon offers its
existing local link socket (a named pipe on Windows), and an adapter exposes a loopback HTTP address for software that
cannot use a Unix socket. The local `status` answer names the current link socket for that caller; an adapter that uses
it must verify the server on each actual link connection before sending credentials, including after a daemon restart. A local router chooses the Mac link when it is available and its own local proxy otherwise.
The proxy is a private card in the map; the VPS machines join the circle that holds it. A site's `view` level grants
access to the HTTP service, including its POST endpoints; it does **not** make those endpoints read-only. The service
owner must protect management endpoints separately.

```text
Claude Code / T3 Code
       |
       v
local router -----> local fallback proxy
       |
       v
source daemon ==== signed Kitshn connection ==== Kitshn Worker / Durable Object
                                                      ||
                   destination daemon ================||
                          |
                          v
                  registered local service
```

## Boundary and connection

1. A local caller selects `/site/<card-id>/<path>` on A's link proxy. It cannot provide a destination address or a
   target machine. Local access follows the existing private/shared socket peer checks.
2. A asks Kitshn to open the card over its current signed connection. Kitshn looks up the card and current source
   membership, applies its current circle and expiry rules, checks pause, and obtains B from the card. Both machines'
   current signed connections and a compatible capability are required. A token-only connection cannot open or
   receive one. A request by card ID never falls through to an arbitrary host or to command execution.
3. Kitshn binds an unguessable stream ID to the card, source, destination and exact connections. It tells B the local
   site identifier from Kitshn's registry, never an address supplied by A. B resolves the live site through its own
   current local registry and refuses stale or missing registrations. Restrict the first version to HTTP endpoints
   Kitshn already permits for live sites; do not provide an arbitrary TCP dialer.
4. Stream the HTTP request and response as bounded frames. Do not add the machine's Access service token to either
   endpoint. Remove forwarding and hop-by-hop headers as appropriate, preserve the intended path and query, and handle
   cancellation and half-close. No request, response, prompt or secret belongs in Kitshn History or persistent state.
5. Recheck the grant and the original destination on every frame and whenever Kitshn changes shares, machine identity,
   local registration, or pause. Close both sides when the grant ends, the card moves or changes destination, a machine
   disconnects or changes key, or a timer expires. A reconnect is a new connection, not a continuation of an old stream.

The relay transports application data through the Kitshn Durable Object. Cloudflare and the Kitshn Worker can see that
data: this design does not claim end-to-end encryption between the machines. In the motivating setup the proxy's local
API key and request contents cross the relay; the proxy's Claude OAuth credentials stay on the machine running that
proxy. Avoid logging these values. TLS protects each daemon's connection to Cloudflare.

## Bounds and lifecycle

Each direction starts with a 64 KiB credit window and frames of at most 16 KiB. Credit returns only after the receiving
local consumer drains the corresponding bytes. A sender stops reading when it has no credit. The Worker checks the
credit and frame limits rather than relying on both daemons to behave; invalid frames end the stream. Bound concurrent
streams per machine, a stream's lifetime, header size and the local connection queue; make the chosen limits visible in
errors. Preserve just the session metadata and credit needed through Durable Object hibernation, with no traffic bodies
or bearer credentials. End stale sessions after a restart and when either socket is replaced. Stress tests must show
that slow readers and disconnected machines cannot cause unbounded buffering.

Kitshn's map and the relay share a Durable Object. Its WebSocket events and database writes add load and cost, and the
latency includes the object's location. Batch small frames where possible and measure real request volume, latency,
CPU, storage writes and Cloudflare billing before calling the cost negligible. Heavy traffic may call for a separate
relay object or a direct data path later.

Cloudflare's documented deferred code updates try to wait up to 300 seconds by default, and hibernating WebSockets can
survive an update. Deferral is best effort, not a guarantee: forced resets, long streams and other failures can still
cut a connection. Test an actual long stream during a deployment on the intended account. Check K-627's assumption
that a deploy causes daemon reconnects: surviving sockets must not prevent the daemon rollout. This deployment test
must not be used as a substitute for disconnect, revocation, expiry and hibernation tests.

## Fallback

A router can prefer the remote service and select its local proxy when a **new** request cannot establish that path. It
can return to the Mac when the path recovers. Do not automatically replay a request once it might have reached the Mac:
a POST could run twice. An interrupted streaming response cannot be resumed by the router. The caller must receive an
error and decide whether to retry; a local fallback does not recover an in-flight stream. Test connection failure before
request transmission separately from failure after transmission, response headers and partial streaming output.

## Rollout and validation

- The provider-protocol dependency (#224) is merged. Ship the relay behind capability negotiation and fail closed with
  mixed daemon versions. Enable only after implementation review and daemon updates; no changes to the user's active
  proxy routes are part of this draft.
- Test the signed connection checks, source membership, all-of and public-circle semantics, share/card expiry, pause,
  revoke, local registry removal, destination changes, replacement and stale sockets, and untrusted paths and headers.
- Exercise request and response streaming, backpressure, cancellation, slow consumers, size and concurrency limits,
  half-close, hibernation, disconnect and bounded cleanup on both Linux/macOS and Windows.
- Test against the real Cloudflare account, including the deployment/rollout behavior and usage cost above. Then test
  the VPS router's primary, local fallback, recovery and non-replay behavior with a harmless HTTP service before using
  any real proxy credentials.

A guarded hostname through Cloudflare Tunnel remains a possible data-path optimization if relay load or deployment
interruptions warrant it. It needs a separate solution for proving that the destination still routes to the intended
guard before sending any reusable machine credential; checking that DNS points at a Cloudflare IP is insufficient.
