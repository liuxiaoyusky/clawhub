const FEISHU_AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";

export const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const FEISHU_USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";

export type FeishuAuthRuntimeConfig = Readonly<{
  appId: string;
  appSecret: string;
  callbackUrl: string;
  frontendUrl: string;
  adminOpenId?: string;
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
    adminOpenId: readEnv(env, "AUTH_FEISHU_ADMIN_OPEN_ID"),
  };
}

export function isFeishuAuthEnabled(env: Env = process.env) {
  return getFeishuAuthRuntimeConfig(env) !== null;
}

export function isConfiguredFeishuAdmin(providerAccountId: string, env: Env = process.env) {
  const adminOpenId = getFeishuAuthRuntimeConfig(env)?.adminOpenId;
  return Boolean(adminOpenId && providerAccountId === adminOpenId);
}

export function buildFeishuAuthorizationUrl(config: FeishuAuthRuntimeConfig, state: string) {
  const url = new URL(FEISHU_AUTHORIZE_URL);
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
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

export const __test = { normalizeHttpUrl };
