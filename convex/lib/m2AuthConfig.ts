import { normalizeEmployeeEmail } from "./employeeDirectory";

const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

export type FeishuAuthRuntimeConfig = Readonly<{
  appId: string;
  appSecret: string;
  callbackUrl: string;
  frontendUrl: string;
}>;

export type GitHubIdentityLinkRuntimeConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  frontendUrl: string;
}>;

type Env = Record<string, string | undefined>;

function readEnv(env: Env, name: string) {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function normalizeHttpUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function getFeishuAuthRuntimeConfig(env: Env = process.env): FeishuAuthRuntimeConfig | null {
  if (readEnv(env, "AUTH_FEISHU_ENABLED") !== "1") return null;

  const appId = readEnv(env, "AUTH_FEISHU_APP_ID");
  const appSecret = readEnv(env, "AUTH_FEISHU_APP_SECRET");
  const convexSiteUrl = normalizeHttpUrl(readEnv(env, "CONVEX_SITE_URL"));
  const frontendUrl = normalizeHttpUrl(readEnv(env, "SITE_URL"));
  if (!appId || !appSecret || !convexSiteUrl || !frontendUrl) return null;

  return {
    appId,
    appSecret,
    callbackUrl: new URL("/api/m2-auth/feishu/callback", convexSiteUrl).toString(),
    frontendUrl,
  };
}

export function isFeishuAuthEnabled(env: Env = process.env) {
  return isEmployeeDirectoryEnabled(env) && getFeishuAuthRuntimeConfig(env) !== null;
}

export function isEmployeeDirectoryEnabled(env: Env = process.env) {
  return readEnv(env, "AUTH_EMPLOYEE_DIRECTORY_ENABLED") === "1";
}

export function getEmployeeDirectoryBootstrapAdminEmail(env: Env = process.env) {
  const configured = readEnv(env, "AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL");
  return configured ? normalizeEmployeeEmail(configured) : null;
}

export function getGitHubIdentityLinkRuntimeConfig(
  env: Env = process.env,
): GitHubIdentityLinkRuntimeConfig | null {
  if (!isEmployeeDirectoryEnabled(env)) return null;

  const clientId = readEnv(env, "AUTH_GITHUB_ID");
  const clientSecret = readEnv(env, "AUTH_GITHUB_SECRET");
  const convexSiteUrl = normalizeHttpUrl(readEnv(env, "CONVEX_SITE_URL"));
  const frontendUrl = normalizeHttpUrl(readEnv(env, "SITE_URL"));
  if (!clientId || !clientSecret || !convexSiteUrl || !frontendUrl) return null;

  return {
    clientId,
    clientSecret,
    callbackUrl: new URL("/api/m2-auth/github/callback", convexSiteUrl).toString(),
    frontendUrl,
  };
}

export function buildFeishuAuthorizationUrl(config: FeishuAuthRuntimeConfig, state: string) {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildGitHubIdentityLinkAuthorizationUrl(
  config: GitHubIdentityLinkRuntimeConfig,
  state: string,
) {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

export function buildFrontendFeishuCallbackUrl(args: {
  config: FeishuAuthRuntimeConfig;
  traceId: string;
  redirectTo: string;
  ticket?: string;
}) {
  const url = new URL("/auth/feishu", args.config.frontendUrl);
  const fragment = new URLSearchParams({ trace: args.traceId, next: args.redirectTo });
  if (args.ticket) fragment.set("ticket", args.ticket);
  else fragment.set("status", "failed");
  url.hash = fragment.toString();
  return url.toString();
}

export function buildFrontendGitHubLinkCallbackUrl(args: {
  config: GitHubIdentityLinkRuntimeConfig;
  traceId: string;
  success: boolean;
}) {
  const url = new URL("/auth/github-link", args.config.frontendUrl);
  url.hash = new URLSearchParams({
    trace: args.traceId,
    next: "/dashboard",
    status: args.success ? "success" : "failed",
  }).toString();
  return url.toString();
}

export const __test = { normalizeHttpUrl };
