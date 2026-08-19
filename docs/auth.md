---
summary: "ClawHub sign-in, API tokens, CLI login, token storage, and revocation."
read_when:
  - Signing in to ClawHub
  - Using the ClawHub CLI
  - Debugging 401s
---

# Auth

ClawHub uses GitHub for web sign-in. The CLI uses ClawHub API tokens created
through that signed-in account.

## Web sign-in

Use GitHub to sign in at [clawhub.ai](https://clawhub.ai).

Deleted, banned, or disabled accounts cannot complete normal ClawHub sign-in.
If sign-in returns you to a logged-out state, your account may not be in good
standing. If your account was banned or disabled, use the
[ClawHub appeal form](https://appeals.openclaw.ai/) if you believe this is a
mistake.

## Internal M2 employee sign-in

This section applies only to the internal SkillHub migration fork. The default
upstream GitHub sign-in stays available while M2 is disabled. When both M2
feature flags below are enabled, the local employee directory is the only
source of truth for an employee's normalized email, `valid` state, and role.
Feishu and GitHub are explicit credentials attached to the same canonical local
user. Neither provider decides a role, and no ordinary provider sign-in can
create an employee record.

Feishu supplies an email only to match a pre-provisioned local directory entry.
It is not automatic authorization, registration, account merge, or a role
claim. GitHub profile email, name, handle, and avatar are never employee keys.

### How local maintenance works

Each directory entry stores `email`, `valid`, `role`, and an optional canonical
`users._id` link. The first designated administrator may be bootstrapped only
by the protected `AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL` setting after a matching
Feishu sign-in. Thereafter, the auth-guarded `employeeDirectory.upsert` control
operation maintains entries and synchronizes the legacy `users.role` projection.
M2 intentionally does not include an end-user directory-management UI; do not
edit `users.role` directly while the employee-directory gate is enabled.
Local dev-persona authentication is also explicitly rejected while that gate is
enabled, so it cannot provide a second local administrator path.

### Configure a non-production test environment

1. In the Feishu developer console, configure the callback URL derived from the
   Convex-managed site origin under **Development configuration → Security
   settings → Redirect URL**:

   ```text
   <CONVEX_SITE_URL>/api/m2-auth/feishu/callback
   ```

   `CONVEX_SITE_URL` is injected by Convex; do not set or override it. Use the
   callback derived from the current local deployment, not an old saved port.
   For a shared test, prefer a dedicated HTTPS test deployment. A local test is
   only viable when Feishu accepts the loopback callback and the browser,
   frontend, and Convex HTTP site run on the same machine; use `127.0.0.1`, not
   the browser-only `[::1]` address.

2. Publish the self-built app's configuration and grant the user-email field
   permission required by Feishu's user-info endpoint. The response must carry
   both `open_id` and `email`; the backend uses the latter only to look up a
   pre-provisioned local entry. Feishu documents that contact fields may not be
   real-time verified, which is why the local directory—not the response
   itself—decides eligibility. See Feishu's [browser web integration guide](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide) and [user-info response fields](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get).

3. Set the backend deployment variables through the Convex environment store,
   never in committed files:

   ```bash
   bunx convex env set AUTH_EMPLOYEE_DIRECTORY_ENABLED 1
   bunx convex env set AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL <designated-admin-employee-email>
   bunx convex env set AUTH_FEISHU_ENABLED 1
   bunx convex env set AUTH_FEISHU_APP_ID <feishu-app-id>
   bunx convex env set AUTH_FEISHU_APP_SECRET <feishu-app-secret>
   bunx convex env set SITE_URL <frontend-origin>
   ```

   Never run `bunx convex env set CONVEX_SITE_URL`: it is a reserved Convex
   runtime variable and Convex rejects overrides. `SITE_URL` is the browser app
   origin that receives the final fragment-only result and must exactly match
   the test frontend. Keep the designated administrator email in the protected
   deployment environment only; never place a real employee email in Git,
   fixtures, logs, or chat.

4. Keep the existing GitHub OAuth callback registered, and add this dedicated
   callback to the same GitHub OAuth App for explicit employee-account binding:

   ```text
   <CONVEX_SITE_URL>/api/m2-auth/github/callback
   ```

   The binding callback exchanges the code server-side, reads only the numeric
   GitHub account id, and attaches it directly to the already authenticated
   employee user. It never creates a temporary GitHub user or writes a
   one-time proof into browser storage.

### Test the flow

Run the automated gate before asking a person to exercise Feishu. It uses a
controlled provider response and proves the local state, token/profile
contract, canonical identity binding, and one-time ticket consumption without
requiring a real Feishu account:

```bash
bunx vitest run \
  convex/auth.callbacks.test.ts \
  convex/employeeDirectory.test.ts \
  convex/identityAuth.test.ts \
  convex/identityAuth.runtime.test.ts \
  convex/identityAuthHttp.test.ts \
  convex/http.test.ts \
  convex/lib/authTrace.test.ts \
  convex/lib/m2AuthConfig.test.ts
```

After that gate passes, a valid Feishu test employee is still needed once to
verify the external provider boundary. Do not ask for repeated blind retries:
inspect the safe trace reference first, then act on its classified reason.

1. Configure the protected bootstrap-admin email, then complete Feishu sign-in
   as that designated test employee. It creates the first active directory row
   with role `admin` and its canonical local user.
2. As that directory administrator, pre-provision a distinct test employee with
   `valid=true` and role `user` through the local directory control operation.
   The ordinary employee can then complete Feishu sign-in; a missing or disabled
   record must produce no user, provider-account mapping, ticket, or session.
3. While signed in as the valid employee, use **Link GitHub identity** and
   approve the GitHub consent page. The custom callback must return to
   `/auth/github-link` without an OAuth code in the browser URL, and a later
   GitHub sign-in must resolve to the same canonical user and directory role.
4. Cancel either provider consent page or use an invalid callback: no local
   session may be created, and the browser URL must not retain a code or ticket.
5. Set an employee record to `valid=false` and verify that both Feishu and
   GitHub refuse new sessions while a previously issued session is allowed to
   expire normally.
6. To exercise the complete M1 fallback, set both
   `AUTH_FEISHU_ENABLED=0` and `AUTH_EMPLOYEE_DIRECTORY_ENABLED=0`. This
   restores the legacy GitHub path without deleting users, mappings, directory
   records, audit data, or historical content. Leaving the directory gate on is
   intentionally fail-closed: only already bound valid employees can use GitHub.

The application records only a random `auth_trace_id`, provider, stage, and
non-sensitive outcome for seven days. OAuth codes, access tokens, secrets, and
real Feishu identifiers must not be copied into a trace or issue report.

## CLI login

The default CLI login flow opens your browser:

```bash
clawhub login
clawhub whoami
```

What happens:

1. The CLI starts a temporary callback server on `127.0.0.1`.
2. Your browser opens the ClawHub sign-in page.
3. After GitHub sign-in, ClawHub creates an API token.
4. The browser redirects back to the local callback.
5. The CLI stores the token in your ClawHub config file.

If your browser cannot reach the local callback because of firewall, VPN, or
proxy rules, use the headless token flow.

## Headless login

Create a token in the ClawHub web UI, then pass it to the CLI:

```bash
clawhub login --token clh_...
```

Use this flow for servers, CI jobs, or terminal-only environments.

For remote shells where you can open a browser elsewhere, run:

```bash
clawhub login --device
```

The CLI prints a one-time code and waits while you authorize it at
`https://clawhub.ai/cli/device`.

## Token storage

Default config paths:

- macOS: `~/Library/Application Support/clawhub/config.json`
- Linux/XDG: `$XDG_CONFIG_HOME/clawhub/config.json` or `~/.config/clawhub/config.json`
- Windows: `%APPDATA%\\clawhub\\config.json`

Override the path with:

```bash
export CLAWHUB_CONFIG_PATH=/path/to/config.json
```

Print the stored token for CI setup with:

```bash
clawhub token
```

## Revocation

You can revoke API tokens in the ClawHub web UI.

Revoked, invalid, or missing tokens return `401 Unauthorized`. Sign in again
with `clawhub login` or provide a fresh token with `clawhub login --token`.

Deleted, banned, or disabled accounts cannot continue using existing API tokens.
If your account was banned or disabled, use the
[ClawHub appeal form](https://appeals.openclaw.ai/) if you believe this is a
mistake.
