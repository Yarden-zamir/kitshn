# kitshn passes

A pass proves to an outside service that a request comes from an agent on a joined machine of one kitshn (K-1770 to K-1775). kitshn's own actions do not use passes.

## Trust kitshn

- Passes work only while the owner has "Passes" on in Settings; until then the two addresses below answer "not found".
- Issuer: `https://kitshn.<zone>`, the exact value of `iss`.
- Discovery: `https://kitshn.<zone>/.well-known/openid-configuration`.
- Keys: `https://kitshn.<zone>/.well-known/jwks.json`.
- Algorithm: `ES256`.
- Audience: the exact address that the kitshn owner adds to the audience list. Each service checks its own audience.

Each kitshn owner has their own issuer, so a service needs no extra rule to keep owners apart.

## Claims

This list is a contract. kitshn only adds claims. It never renames or removes one.

| Claim | Always | Value |
| --- | --- | --- |
| `iss` | yes | `https://kitshn.<zone>` |
| `aud` | yes | one audience address |
| `sub` | yes | `machine:<machine id>`. An id, never a name |
| `iat` | yes | issue time, seconds |
| `exp` | yes | `iat` plus 300 seconds |
| `jti` | yes | 128 random bits |
| `act` | only when the audience allows labels | `{"sub": "t3:<thread id>"}`, from an attested thread |
| `kitshn_labels` | only when the audience allows labels | the attested labels, for example `t3.project.name` |

Match trust rules on `sub` and, when present, `act.sub`. Never match on a thread title or a project name: they change.

## Limits

- A pass is a bearer token for 5 minutes. kitshn cannot revoke it.
- kitshn does not track used passes. A service that needs single use must keep the `jti` itself.
