# Know who opens your app

Tunnel ingress checks the Access JWT (K-603), so a request reaches an app only through Access. That check does not tell the app who the user is. Access also sends `Cf-Access-Authenticated-User-Email`, but that header is not signed, and anything on the machine that reaches the socket can set it.

An app that needs the user identity verifies the `Cf-Access-Jwt-Assertion` header itself ([validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)):

1. Get the signing keys from `https://$KITSHN_ACCESS_TEAM_DOMAIN/cdn-cgi/access/certs`.
2. Check the signature and the expiry of the token.
3. Check that `iss` is `https://$KITSHN_ACCESS_TEAM_DOMAIN`.
4. Check that `aud` contains one of the tags in `KITSHN_ACCESS_AUDIENCES`, a comma list. An empty list accepts no token.
5. Read the identity from the verified token: `email`, or `common_name` for a service token.

kitshn sets both variables for each service of a Compose app at each deploy, redeploy and rollback, and as plain vars of a Worker app at each deploy from the repo (K-822). A value that the app sets itself wins. A tag changes when kitshn makes the Access application again. A running app gets the new tag only with its next redeploy.

A site in Everyone has a Bypass policy (K-403), and Access sends no JWT for Bypass. On such a site, do not require the token. Treat a request without a token as a visitor with no identity.
