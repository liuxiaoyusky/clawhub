# Auth Identity Invariants

ClawHub uses Convex Auth with GitHub OAuth for production user sessions.

## M2 local employee directory

When the M2 employee-identity gate is enabled, the local employee directory is
the only source of truth for an employee's normalized email, `valid` state, and
platform role. `users._id` is the canonical technical record linked to that
directory entry; a GitHub account id or Feishu account id is only a login
credential for the same user.

Every new session must resolve its canonical user to an active directory entry
before it is created. A disabled or missing entry must reject both Feishu and
GitHub sign-in without creating a user, account, or session. Existing sessions
keep their normal expiry behavior; M2 does not claim real-time revocation.

Feishu may provide an email solely to look up a pre-provisioned employee entry.
GitHub OAuth email, login, display name, and avatar are never employee keys and
must not create or merge an employee entry. GitHub can only sign in after an
explicit binding to a canonical user. The directory role is the authorization
source; `users.role` is only a synchronized compatibility projection while the
legacy application completes its replacement.

The protected `AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL` setting may establish only
the designated first administrator after a matching Feishu identity lookup. It
is a provisioning constraint, not an OAuth role claim; real values never enter
source, test fixtures, browser storage, or traces. Once a directory row exists,
its `role` remains the authorization source and the local control operation may
only preserve or assign `admin` to that same configured employee email.
The local `dev-persona` credential is unavailable while the M2 gate is enabled;
it must never become an alternate administrator or session-creation path.

GitHub linking starts from an authenticated active employee session, stores only
a hashed one-time OAuth state server-side, and sends the browser to a dedicated
server callback. The server exchanges the code and binds the numeric GitHub
provider id directly to the target `users._id`. It must not create a temporary
user/session, transfer an `authAccounts` row from another user, or retain an
OAuth code, token, profile email, or link proof in browser storage.

## OAuth completion query parameter

The app-level OAuth code handler consumes `?code=` on every route, so `code` is
reserved for Convex Auth OAuth completion. Other flows must use a different query
parameter; CLI device login uses `user_code`. As defense in depth, the handler
explicitly ignores device-shaped codes (`XXXX-XXXX`).

Security invariant: a GitHub OAuth account may link to a ClawHub user only through
the auth-managed GitHub `providerAccountId`, which is the immutable GitHub
numeric account id stored in `authAccounts`. Mutable GitHub usernames and OAuth
profile email values are profile data, not account-linking keys.

The GitHub provider must keep `allowDangerousEmailAccountLinking: false`. This
prevents a fresh GitHub OAuth account whose profile exposes the same email as an
existing user from being attached to that user's ClawHub account. The visible
failure mode is a session whose GitHub login/avatar/handle belongs to one person
while persisted profile fields such as display name, bio, ownership, or API
tokens belong to another user.

The GitHub provider must also fail closed when the OAuth profile does not expose
a valid numeric `id`. Missing or malformed provider ids must never be coerced
into strings such as `"undefined"` and used as `authAccounts.providerAccountId`.
Malformed GitHub API responses during provider outages are authentication
failures, not anonymous or linkable GitHub identities.

When reading GitHub auth accounts for authorization-sensitive checks, duplicate
`authAccounts` rows for the same ClawHub user may only be treated as recoverable
when every row in a bounded reconciliation window has the same GitHub
`providerAccountId`. Any disagreement or overflow beyond that bounded window
means the account binding is ambiguous and must fail closed with
operator-visible diagnostics instead of choosing by creation time or any other
arbitrary tie breaker.

`users.me`, protected mutations, ownership checks, and API token issuance must
derive the actor server-side from Convex Auth (`getAuthUserId` via
`requireUser`/`getOptionalActiveAuthUserId`). They must not accept client-supplied
user ids, usernames, handles, or emails for authorization.

## Organization GitHub profile verification

Organization publisher GitHub links are profile metadata, not ClawHub account
identity or artifact provenance. GitHub OAuth requests `read:org` and uses the
access token only during the OAuth callback to fetch the signed-in user's active
organization memberships. ClawHub stores the resulting immutable GitHub
organization ids and current logins, but never stores the provider access token.

Changing an organization publisher's GitHub link requires both ClawHub
owner/admin access and a fresh server-side GitHub membership snapshot for the
selected immutable organization id. The stored login may determine the public
profile URL, but it must not grant publishing authority, Official status,
trusted-publishing authority, or source/artifact provenance.

Staff recovery for a personal publisher whose GitHub principal is no longer
accessible must not rewrite or merge Convex Auth `authAccounts` rows. The only
supported permanent recovery path is an admin-only personal publisher recovery
operation that requires both immutable GitHub `providerAccountId` values, verifies
that each maps unambiguously to exactly one ClawHub user, confirms staff identity
continuity verification, moves the previous user's handle/personal-publisher
pointer out of the way, links the publisher to the verified replacement user,
updates every bounded legacy `ownerUserId` row that remains authoritative for the
recovered publisher's direct-owner workflows, and writes an audit log. Recovery
must also transfer any active protected-handle reservation for the recovered
handle to the replacement user so subsequent profile synchronization cannot
reassert the former user's authority over that handle. Recovery
must fail closed if the replacement user's current personal publisher has content
or GitHub source state that would be orphaned by the handoff. It must also fail
closed if recovered publisher resources are already attributed to a third user,
or if the affected primary resource rows exceed the bounded single-transaction
limit; those cases require an explicit resumable migration before recovery.

## Docs auth token destination

The `/auth/docs` broker (Ask Molty) POSTs the signed-in user's ClawHub auth
token to a `return_to` origin. That origin is a bearer-token destination, so its
allowlist is a security boundary, not a convenience.

Permitted destinations (`src/lib/docsAuth.ts`):

- The fixed production docs origins: `https://clawhub.ai`,
  `https://documentation.openclaw.ai`, `https://docs.openclaw.ai`.
- A loopback origin (`http://localhost` / `http://127.0.0.1`) only when the app
  is itself served from a loopback origin. The allowance is coupled to the
  current app origin, not to a runtime env flag, so a public staging, preview,
  or misconfigured deployment can never POST the token to a localhost listener.

The deployed Content-Security-Policy `form-action`
(`src/lib/securityHeaders.ts`) must stay aligned with this allowlist: it lists
`'self'` plus the cross-origin docs hosts and must not include loopback origins
in production. The CSP is the browser-side backstop if the application allowlist
ever regresses.

The production script CSP is emitted per request by the TanStack Start server
entry so framework/runtime inline scripts can be nonce-tagged without reopening
global inline execution. Do not reintroduce a static global Vercel CSP with
script `'unsafe-inline'`. First-paint theme state is represented with a
server-readable preference cookie plus CSS media queries, not a pre-hydration
theme bootstrap script.
