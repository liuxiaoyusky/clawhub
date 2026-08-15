import { internal } from "./_generated/api";
import { httpAction } from "./functions";

function redirect(url: string | null) {
  return url
    ? Response.redirect(url, 302)
    : new Response("Sign in is not available.", { status: 503 });
}

export const feishuOAuthCallbackHttp = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const state = params.get("state")?.trim();
  if (!state) return new Response("Invalid sign-in callback.", { status: 400 });

  const code = params.get("code")?.trim();
  if (!code) {
    const result = (await ctx.runAction(internal.identityAuth.rejectFeishuOAuthCallbackInternal, {
      state,
      reasonCode: params.get("error") ? "oauth_access_denied" : "oauth_callback_invalid",
    })) as { completionUrl: string | null };
    return redirect(result.completionUrl);
  }

  const result = (await ctx.runAction(internal.identityAuth.completeFeishuOAuthCallbackInternal, {
    state,
    code,
  })) as { completionUrl: string | null };
  return redirect(result.completionUrl);
});
