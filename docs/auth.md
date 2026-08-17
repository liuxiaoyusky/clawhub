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

## Internal M2 Feishu web sign-in

This section applies only to the internal SkillHub migration fork. The default
upstream GitHub sign-in stays available; Feishu is disabled until every
deployment value below is present. When enabled, a successful Feishu OAuth
login creates or verifies one canonical local user. The backend stores only the
Feishu `open_id` as an external account key; it does not use an email, name, or
GitHub profile to merge accounts.

### Configure a non-production test environment

1. In the Feishu developer console, configure the callback URL derived from the
   Convex-managed site origin under **Development configuration → Security
   settings → Redirect URL**:

   ```text
   <CONVEX_SITE_URL>/api/m2-auth/feishu/callback
   ```

   `CONVEX_SITE_URL` is injected by Convex; do not set or override it. For the
   current local test deployment, the callback is
   `http://127.0.0.1:3211/api/m2-auth/feishu/callback`. Use the same value in
   the authorization request and token exchange. For a shared test, prefer a
   dedicated HTTPS test deployment. A local test is only viable when Feishu
   accepts the loopback callback and the browser, frontend, and Convex HTTP
   site run on the same machine; use `127.0.0.1`, not the browser-only `[::1]`
   address.

2. Publish the self-built app's configuration and request only the permissions
   required by the app. This flow calls the user-info endpoint solely to obtain
   `open_id`; it does not request email, phone, directory, or offline-access
   permissions. See Feishu's [browser web integration guide](https://open.feishu.cn/document/sso/web-application-end-user-consent/guide).

3. Set the backend deployment variables through the Convex environment store,
   never in committed files:

   ```bash
   bunx convex env set AUTH_FEISHU_ENABLED 1
   bunx convex env set AUTH_FEISHU_APP_ID <feishu-app-id>
   bunx convex env set AUTH_FEISHU_APP_SECRET <feishu-app-secret>
   bunx convex env set SITE_URL <frontend-origin>
   ```

   Never run `bunx convex env set CONVEX_SITE_URL`: it is a reserved Convex
   runtime variable and Convex rejects overrides. `SITE_URL` is the browser app
   origin that receives the final fragment-only ticket and must exactly match
   the test frontend. Set
   `AUTH_FEISHU_ADMIN_OPEN_ID` only in that same protected environment after an
   authorized operator has obtained the designated administrator's stable
   `open_id`; never substitute an email address or put the value in a log,
   test, or chat.

### Test the flow

Run the automated gate before asking a person to exercise Feishu. It uses a
controlled provider response and proves the local state, token/profile
contract, canonical identity binding, and one-time ticket consumption without
requiring a real Feishu account:

```bash
bunx vitest run \
  convex/identityAuth.test.ts \
  convex/identityAuth.runtime.test.ts \
  convex/identityAuthHttp.test.ts \
  convex/lib/authTrace.test.ts \
  convex/lib/m2AuthConfig.test.ts
```

After that gate passes, a valid Feishu test employee is still needed once to
verify the external provider boundary. Do not ask for repeated blind retries:
inspect the safe trace reference first, then act on its classified reason.

1. Start with `AUTH_FEISHU_ADMIN_OPEN_ID` unset and sign in with a valid test
   employee. The result must be a new or existing local user with role `user`.
2. Configure the designated administrator's `open_id`, sign in again, and
   verify the canonical user has role `admin`. A GitHub sign-in must still
   resolve only to that same explicitly linked local user.
3. Cancel the Feishu consent page or use an invalid callback: no local session
   may be created, and the browser URL must not retain a code or ticket.
4. Set `AUTH_FEISHU_ENABLED=0` to exercise rollback. This restores the existing
   GitHub path without deleting users, mappings, or audit data.

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
