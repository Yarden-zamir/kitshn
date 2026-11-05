/**
 * K-1202: every permission group that the kitshn API token needs. The token link of the bootstrap and each
 * message about a missing permission come from this list. The ids are the stable Cloudflare permission group
 * ids (`GET /accounts/{id}/tokens/permission_groups`); an account token link takes them for any group, also
 * for groups without a short key, such as Config Rules. The label is the row of the token form.
 */
export const TOKEN_PERMISSIONS = {
  workersScripts: { id: "e086da7e2179491d91ee5f35b3ca210a", label: "Account > Workers Scripts > Edit" },
  workersKv: { id: "f7f0eda5697f475c90846e879bab8666", label: "Account > Workers KV Storage > Edit" },
  workersR2: { id: "bf7481a1826f439697cb59a20b22293e", label: "Account > Workers R2 Storage > Edit" },
  workersObservability: {
    id: "82c075da3f4647a2a03becd0fe240f8a",
    label: "Account > Workers Observability > Edit",
  },
  accessApps: { id: "1e13c5124ca64b72b1969a67e8829049", label: "Account > Access: Apps and Policies > Edit" },
  accessOrganizations: {
    id: "bfe0d8686a584fa680f4c53b5eb0de6d",
    label: "Account > Access: Organizations, Identity Providers, and Groups > Edit",
  },
  accessServiceTokens: {
    id: "a1c0fec57cf94af79479a6d827fa518c",
    label: "Account > Access: Service Tokens > Edit",
  },
  accessCustomPages: {
    id: "4e5fd8ac327b4a358e48c66fcbeb856d",
    label: "Account > Access: Custom Pages > Edit",
  },
  accessAuditLogs: { id: "b05b28e839c54467a7d6cba5d3abb5a3", label: "Account > Access: Audit Logs > Read" },
  tunnel: { id: "c07321b023e944ff818fec44d8203567", label: "Account > Cloudflare Tunnel > Edit" },
  accountAnalytics: { id: "b89a480218d04ceb98b4fe57ca29dc1f", label: "Account > Account Analytics > Read" },
  zone: { id: "c8fed203ed3043cba015a93ad1616f1f", label: "Zone > Zone > Read" },
  dns: { id: "4755a26eedb94da69e1066d98aa820be", label: "Zone > DNS > Edit" },
  workersRoutes: { id: "28f4b596e7d643029c524985477ae49a", label: "Zone > Workers Routes > Edit" },
  configRules: { id: "06f0526e6e464647bd61b63c54935235", label: "Zone > Config Rules > Edit" },
} as const;

export type TokenPermission = (typeof TOKEN_PERMISSIONS)[keyof typeof TOKEN_PERMISSIONS];

/**
 * K-1202: the form of a new account API token with every permission of `TOKEN_PERMISSIONS` filled in. Cloudflare
 * ignores the type of an entry with an id, so each entry has the type of its label for a reader of the link.
 */
export const TOKEN_LINK = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
  JSON.stringify(
    Object.values(TOKEN_PERMISSIONS).map(({ id, label }) => ({
      key: id,
      type: label.endsWith("> Read") ? "read" : "edit",
    })),
  ),
)}&name=kitshn`;

/** Where the owner edits the token. Installs from before the account token link keep their user token. */
export const TOKEN_PLACE =
  "Manage account > Account API tokens in the Cloudflare dashboard (My Profile > API Tokens for a user token)";

/** The step that adds a missing permission to the token. */
export const addPermission = (permission: TokenPermission) =>
  `Add "${permission.label}" to the API token at ${TOKEN_PLACE}.`;
