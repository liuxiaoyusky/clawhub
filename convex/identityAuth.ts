import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, mutation, query } from "./functions";
import {
  createAuthTraceId,
  logAuthTrace,
  type AuthTraceEvent,
  type AuthTraceId,
  type AuthTraceReasonCode,
} from "./lib/authTrace";
import {
  buildFeishuAuthorizationUrl,
  buildFrontendFeishuCallbackUrl,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  getFeishuAuthRuntimeConfig,
  isConfiguredFeishuAdmin,
  isFeishuAuthEnabled,
} from "./lib/m2AuthConfig";
import { ensurePersonalPublisherForUser } from "./lib/publishers";
import { hashToken } from "./lib/tokens";

const AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
const AUTH_TICKET_TTL_MS = 2 * 60 * 1_000;
const GITHUB_LINK_TTL_MS = 10 * 60 * 1_000;
const AUTH_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OPAQUE_SECRET_PATTERN = /^[a-f0-9]{64}$/i;

type ActiveUser = Doc<"users">;

function generateOpaqueSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeOpaqueSecret(value: string) {
  const normalized = value.trim();
  if (!OPAQUE_SECRET_PATTERN.test(normalized)) {
    throw new ConvexError("Sign in failed. Please try again.");
  }
  return normalized;
}

function normalizeRedirectTo(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || !normalized.startsWith("/") || normalized.startsWith("//")) return "/";
  return normalized.slice(0, 2_000);
}

function isActiveUser(user: ActiveUser | null): user is ActiveUser {
  return Boolean(user && !user.deletedAt && !user.deactivatedAt);
}

async function getRawAuthenticatedUserId(ctx: MutationCtx | QueryCtx) {
  try {
    return (await getAuthUserId(ctx)) as Id<"users"> | null;
  } catch {
    return null;
  }
}

async function requireRawActiveUser(ctx: MutationCtx) {
  const userId = await getRawAuthenticatedUserId(ctx);
  if (!userId) throw new ConvexError("Unauthorized");
  const user = await ctx.db.get(userId);
  if (!isActiveUser(user)) throw new ConvexError("Unauthorized");
  return user;
}

async function recordAuthTrace(ctx: Pick<MutationCtx, "db">, event: AuthTraceEvent) {
  logAuthTrace(console, event);
  await ctx.db.insert("authTraceEvents", {
    ...event,
    expiresAt: event.occurredAt + AUTH_TRACE_RETENTION_MS,
  });
}

async function recordRejectedAttempt(
  ctx: Pick<MutationCtx, "db">,
  args: { traceId: AuthTraceId; reasonCode: AuthTraceReasonCode; occurredAt: number },
) {
  await recordAuthTrace(ctx, {
    traceId: args.traceId,
    provider: "feishu",
    stage: "rejected",
    outcome: "rejected",
    occurredAt: args.occurredAt,
    reasonCode: args.reasonCode,
  });
}

async function findFeishuAccount(ctx: Pick<MutationCtx, "db">, providerAccountId: string) {
  return await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "feishu").eq("providerAccountId", providerAccountId),
    )
    .unique();
}

function resolveRole(providerAccountId: string) {
  if (isConfiguredFeishuAdmin(providerAccountId)) return "admin" as const;
  return "user" as const;
}

async function revokeUserSessions(ctx: Pick<MutationCtx, "db">, userId: Id<"users">) {
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const refreshTokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const refreshToken of refreshTokens) await ctx.db.delete(refreshToken._id);
    await ctx.db.delete(session._id);
  }
}

export const getIdentityStatus = query({
  args: {},
  handler: async (ctx) => {
    const feishuEnabled = isFeishuAuthEnabled();
    const userId = await getRawAuthenticatedUserId(ctx);
    if (!userId) return { feishuEnabled, status: "signed_out" as const };
    const user = await ctx.db.get(userId);
    if (!isActiveUser(user)) return { feishuEnabled, status: "signed_out" as const };
    if (!feishuEnabled || user.enterpriseIdentityVerifiedAt) {
      return { feishuEnabled, status: "active" as const };
    }
    return { feishuEnabled, status: "needs_feishu_link" as const };
  },
});

export const beginFeishuAuthorization = mutation({
  args: {
    intent: v.union(v.literal("sign_in"), v.literal("link_existing_user")),
    redirectTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const config = getFeishuAuthRuntimeConfig();
    if (!config) throw new ConvexError("Sign in is not available. Please try again later.");

    const targetUser =
      args.intent === "link_existing_user" ? await requireRawActiveUser(ctx) : null;
    const now = Date.now();
    const state = generateOpaqueSecret();
    const stateHash = await hashToken(state);
    const traceId = createAuthTraceId();
    await ctx.db.insert("identityAuthAttempts", {
      stateHash,
      traceId,
      purpose: args.intent,
      targetUserId: targetUser?._id,
      redirectTo: normalizeRedirectTo(args.redirectTo),
      status: "pending",
      createdAt: now,
      expiresAt: now + AUTH_ATTEMPT_TTL_MS,
    });
    await recordAuthTrace(ctx, {
      traceId,
      provider: "feishu",
      stage: "oauth_started",
      outcome: "started",
      occurredAt: now,
    });

    return { authorizationUrl: buildFeishuAuthorizationUrl(config, state) };
  },
});

export const claimFeishuCallbackInternal = internalMutation({
  args: {
    stateHash: v.string(),
    fallbackTraceId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const attempt = await ctx.db
      .query("identityAuthAttempts")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    const fallbackTraceId = args.fallbackTraceId as AuthTraceId;
    if (!attempt) {
      await recordRejectedAttempt(ctx, {
        traceId: fallbackTraceId,
        reasonCode: "oauth_state_invalid",
        occurredAt: now,
      });
      return { ok: false as const, traceId: fallbackTraceId, redirectTo: "/" };
    }
    if (attempt.expiresAt <= now) {
      await ctx.db.patch(attempt._id, { status: "expired" });
      await recordRejectedAttempt(ctx, {
        traceId: attempt.traceId as AuthTraceId,
        reasonCode: "oauth_state_invalid",
        occurredAt: now,
      });
      return { ok: false as const, traceId: attempt.traceId, redirectTo: attempt.redirectTo };
    }
    if (attempt.status !== "pending") {
      await recordRejectedAttempt(ctx, {
        traceId: attempt.traceId as AuthTraceId,
        reasonCode: "oauth_callback_invalid",
        occurredAt: now,
      });
      return { ok: false as const, traceId: attempt.traceId, redirectTo: attempt.redirectTo };
    }

    await ctx.db.patch(attempt._id, { status: "processing", callbackReceivedAt: now });
    await recordAuthTrace(ctx, {
      traceId: attempt.traceId as AuthTraceId,
      provider: "feishu",
      stage: "oauth_callback_received",
      outcome: "success",
      occurredAt: now,
    });
    return {
      ok: true as const,
      traceId: attempt.traceId,
      redirectTo: attempt.redirectTo,
    };
  },
});

export const recordAuthTraceInternal = internalMutation({
  args: {
    traceId: v.string(),
    provider: v.union(v.literal("feishu"), v.literal("github")),
    stage: v.union(
      v.literal("oauth_started"),
      v.literal("oauth_callback_received"),
      v.literal("token_exchange_finished"),
      v.literal("profile_validated"),
      v.literal("identity_bound"),
      v.literal("session_created"),
      v.literal("rejected"),
    ),
    outcome: v.union(
      v.literal("started"),
      v.literal("success"),
      v.literal("failure"),
      v.literal("rejected"),
    ),
    reasonCode: v.optional(
      v.union(
        v.literal("oauth_state_invalid"),
        v.literal("oauth_callback_invalid"),
        v.literal("oauth_access_denied"),
        v.literal("token_exchange_failed"),
        v.literal("profile_validation_failed"),
        v.literal("identity_binding_failed"),
        v.literal("identity_conflict"),
        v.literal("session_creation_failed"),
        v.literal("provider_unavailable"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await recordAuthTrace(ctx, {
      ...args,
      traceId: args.traceId as AuthTraceId,
      occurredAt: Date.now(),
    });
  },
});

export const rejectFeishuCallbackInternal = internalMutation({
  args: {
    stateHash: v.string(),
    traceId: v.string(),
    reasonCode: v.union(
      v.literal("oauth_state_invalid"),
      v.literal("oauth_callback_invalid"),
      v.literal("oauth_access_denied"),
      v.literal("token_exchange_failed"),
      v.literal("profile_validation_failed"),
      v.literal("identity_binding_failed"),
      v.literal("identity_conflict"),
      v.literal("session_creation_failed"),
      v.literal("provider_unavailable"),
    ),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db
      .query("identityAuthAttempts")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    const now = Date.now();
    if (attempt?.status === "processing") await ctx.db.patch(attempt._id, { status: "rejected" });
    await recordRejectedAttempt(ctx, {
      traceId: args.traceId as AuthTraceId,
      reasonCode: args.reasonCode,
      occurredAt: now,
    });
  },
});

export const completeFeishuIdentityInternal = internalMutation({
  args: {
    stateHash: v.string(),
    providerAccountId: v.string(),
    ticketHash: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const attempt = await ctx.db
      .query("identityAuthAttempts")
      .withIndex("by_state_hash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!attempt || attempt.status !== "processing" || attempt.expiresAt <= now) {
      const traceId = attempt?.traceId ?? createAuthTraceId();
      await recordRejectedAttempt(ctx, {
        traceId: traceId as AuthTraceId,
        reasonCode: "identity_binding_failed",
        occurredAt: now,
      });
      return {
        ok: false as const,
        traceId,
        redirectTo: attempt?.redirectTo ?? "/",
        reasonCode: "identity_binding_failed" as const,
      };
    }

    const existingAccount = await findFeishuAccount(ctx, args.providerAccountId);
    let user: ActiveUser | null = null;
    let isNewUser = false;
    if (attempt.targetUserId) {
      const targetUser = await ctx.db.get(attempt.targetUserId);
      if (
        !isActiveUser(targetUser) ||
        (existingAccount && existingAccount.userId !== targetUser._id)
      ) {
        await ctx.db.patch(attempt._id, { status: "rejected" });
        await recordRejectedAttempt(ctx, {
          traceId: attempt.traceId as AuthTraceId,
          reasonCode: existingAccount ? "identity_conflict" : "identity_binding_failed",
          occurredAt: now,
        });
        return {
          ok: false as const,
          traceId: attempt.traceId,
          redirectTo: attempt.redirectTo,
          reasonCode: existingAccount
            ? ("identity_conflict" as const)
            : ("identity_binding_failed" as const),
        };
      }
      user = targetUser;
      if (!existingAccount) {
        await ctx.db.insert("authAccounts", {
          userId: user._id,
          provider: "feishu",
          providerAccountId: args.providerAccountId,
        });
      }
    } else if (existingAccount) {
      const existingUser = await ctx.db.get(existingAccount.userId);
      if (!isActiveUser(existingUser)) {
        await ctx.db.patch(attempt._id, { status: "rejected" });
        await recordRejectedAttempt(ctx, {
          traceId: attempt.traceId as AuthTraceId,
          reasonCode: "identity_binding_failed",
          occurredAt: now,
        });
        return {
          ok: false as const,
          traceId: attempt.traceId,
          redirectTo: attempt.redirectTo,
          reasonCode: "identity_binding_failed" as const,
        };
      }
      user = existingUser;
    } else {
      const role = isConfiguredFeishuAdmin(args.providerAccountId) ? "admin" : "user";
      const userId = await ctx.db.insert("users", {
        role,
        enterpriseIdentityVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "feishu",
        providerAccountId: args.providerAccountId,
      });
      user = await ctx.db.get(userId);
      isNewUser = true;
    }

    if (!isActiveUser(user)) {
      await ctx.db.patch(attempt._id, { status: "rejected" });
      await recordRejectedAttempt(ctx, {
        traceId: attempt.traceId as AuthTraceId,
        reasonCode: "identity_binding_failed",
        occurredAt: now,
      });
      return {
        ok: false as const,
        traceId: attempt.traceId,
        redirectTo: attempt.redirectTo,
        reasonCode: "identity_binding_failed" as const,
      };
    }

    const role = resolveRole(args.providerAccountId);
    await ctx.db.patch(user._id, {
      enterpriseIdentityVerifiedAt: now,
      role,
      updatedAt: now,
    });
    const canonicalUser = (await ctx.db.get(user._id)) ?? user;
    if (isNewUser) {
      await ensurePersonalPublisherForUser(ctx, canonicalUser, {
        actorUserId: canonicalUser._id,
        source: "auth.feishu.create",
      });
    }
    await ctx.db.patch(attempt._id, { status: "completed", completedAt: now });
    await ctx.db.insert("identityAuthTickets", {
      ticketHash: args.ticketHash,
      userId: canonicalUser._id,
      traceId: attempt.traceId,
      createdAt: now,
      expiresAt: now + AUTH_TICKET_TTL_MS,
    });
    await ctx.db.insert("auditLogs", {
      actorUserId: canonicalUser._id,
      action: isNewUser ? "auth.identity.feishu.created" : "auth.identity.feishu.bound",
      targetType: "user",
      targetId: canonicalUser._id,
      metadata: { provider: "feishu", traceId: attempt.traceId },
      createdAt: now,
    });
    await recordAuthTrace(ctx, {
      traceId: attempt.traceId as AuthTraceId,
      provider: "feishu",
      stage: "identity_bound",
      outcome: "success",
      occurredAt: now,
    });
    return { ok: true as const, traceId: attempt.traceId, redirectTo: attempt.redirectTo };
  },
});

export const redeemFeishuSessionTicketInternal = internalMutation({
  args: { ticketHash: v.string() },
  handler: async (ctx, args) => {
    const ticket = await ctx.db
      .query("identityAuthTickets")
      .withIndex("by_ticket_hash", (q) => q.eq("ticketHash", args.ticketHash))
      .unique();
    const now = Date.now();
    if (!ticket || ticket.usedAt || ticket.expiresAt <= now) {
      throw new ConvexError("Sign in failed. Please try again.");
    }
    const user = await ctx.db.get(ticket.userId);
    if (!isActiveUser(user) || !user.enterpriseIdentityVerifiedAt) {
      throw new ConvexError("Sign in failed. Please try again.");
    }
    await ctx.db.patch(ticket._id, { usedAt: now });
    await recordAuthTrace(ctx, {
      traceId: ticket.traceId as AuthTraceId,
      provider: "feishu",
      stage: "session_created",
      outcome: "success",
      occurredAt: now,
    });
    return user._id;
  },
});

export const beginGitHubLink = mutation({
  args: {},
  handler: async (ctx) => {
    if (!isFeishuAuthEnabled()) throw new ConvexError("Identity linking is not available.");
    const targetUser = await requireRawActiveUser(ctx);
    if (!targetUser.enterpriseIdentityVerifiedAt) {
      throw new ConvexError("Verify your Feishu identity before linking GitHub.");
    }
    const secret = generateOpaqueSecret();
    const now = Date.now();
    const traceId = createAuthTraceId();
    await ctx.db.insert("identityAuthLinks", {
      secretHash: await hashToken(secret),
      targetUserId: targetUser._id,
      provider: "github",
      traceId,
      createdAt: now,
      expiresAt: now + GITHUB_LINK_TTL_MS,
    });
    await recordAuthTrace(ctx, {
      traceId,
      provider: "github",
      stage: "oauth_started",
      outcome: "started",
      occurredAt: now,
    });
    return { secret, traceId };
  },
});

export const redeemGitHubLink = mutation({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    const sourceUser = await requireRawActiveUser(ctx);
    const secretHash = await hashToken(normalizeOpaqueSecret(args.secret));
    const link = await ctx.db
      .query("identityAuthLinks")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", secretHash))
      .unique();
    const now = Date.now();
    if (!link || link.usedAt || link.expiresAt <= now) {
      throw new ConvexError(
        "Identity link is no longer valid. Start again from your verified account.",
      );
    }
    const targetUser = await ctx.db.get(link.targetUserId);
    const githubAccount = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", sourceUser._id).eq("provider", "github"),
      )
      .unique();
    const targetGithubAccount = isActiveUser(targetUser)
      ? await ctx.db
          .query("authAccounts")
          .withIndex("userIdAndProvider", (q) =>
            q.eq("userId", targetUser._id).eq("provider", "github"),
          )
          .unique()
      : null;
    if (
      !isActiveUser(targetUser) ||
      !githubAccount ||
      (targetGithubAccount && sourceUser._id !== targetUser._id)
    ) {
      await recordAuthTrace(ctx, {
        traceId: link.traceId as AuthTraceId,
        provider: "github",
        stage: "rejected",
        outcome: "rejected",
        occurredAt: now,
        reasonCode: targetGithubAccount ? "identity_conflict" : "identity_binding_failed",
      });
      throw new ConvexError(
        "Unable to link this GitHub identity. Start again from your verified account.",
      );
    }

    if (sourceUser._id !== targetUser._id) {
      await ctx.db.patch(githubAccount._id, { userId: targetUser._id });
      await revokeUserSessions(ctx, sourceUser._id);
    }
    await ctx.db.patch(link._id, { usedAt: now });
    await ctx.db.insert("auditLogs", {
      actorUserId: targetUser._id,
      action: "auth.identity.github.bound",
      targetType: "user",
      targetId: targetUser._id,
      metadata: { provider: "github", traceId: link.traceId },
      createdAt: now,
    });
    await recordAuthTrace(ctx, {
      traceId: link.traceId as AuthTraceId,
      provider: "github",
      stage: "identity_bound",
      outcome: "success",
      occurredAt: now,
    });
    return { redirectTo: "/dashboard" };
  },
});

async function exchangeFeishuCode(args: {
  appId: string;
  appSecret: string;
  callbackUrl: string;
  code: string;
}) {
  const tokenResponse = await fetch(FEISHU_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: args.appId,
      client_secret: args.appSecret,
      code: args.code,
      redirect_uri: args.callbackUrl,
    }),
  });
  if (!tokenResponse.ok) return null;
  const tokenPayload = (await tokenResponse.json().catch(() => null)) as {
    data?: { access_token?: unknown };
  } | null;
  const accessToken = tokenPayload?.data?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) return null;
  return accessToken;
}

async function fetchFeishuProviderAccountId(accessToken: string) {
  const profileResponse = await fetch(FEISHU_USER_INFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!profileResponse.ok) return null;
  const profilePayload = (await profileResponse.json().catch(() => null)) as {
    data?: { open_id?: unknown };
  } | null;
  const openId = profilePayload?.data?.open_id;
  return typeof openId === "string" && openId.trim() ? openId.trim() : null;
}

export const completeFeishuOAuthCallbackInternal = internalAction({
  args: { state: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const config = getFeishuAuthRuntimeConfig();
    if (!config) return { completionUrl: null };
    const fallbackTraceId = createAuthTraceId();
    let stateHash: string;
    try {
      stateHash = await hashToken(normalizeOpaqueSecret(args.state));
    } catch {
      await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
        traceId: fallbackTraceId,
        provider: "feishu",
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "oauth_state_invalid",
      });
      const completionUrl = buildFrontendFeishuCallbackUrl({
        config,
        traceId: fallbackTraceId,
        redirectTo: "/",
      });
      return { completionUrl };
    }
    const claimed = (await ctx.runMutation(internal.identityAuth.claimFeishuCallbackInternal, {
      stateHash,
      fallbackTraceId,
    })) as
      | { ok: true; traceId: string; redirectTo: string }
      | { ok: false; traceId: string; redirectTo: string };
    if (!claimed.ok) {
      return {
        completionUrl: buildFrontendFeishuCallbackUrl({
          config,
          traceId: claimed.traceId,
          redirectTo: claimed.redirectTo,
        }),
      };
    }

    const traceId = claimed.traceId;
    const reject = async (reasonCode: AuthTraceReasonCode) => {
      await ctx.runMutation(internal.identityAuth.rejectFeishuCallbackInternal, {
        stateHash,
        traceId,
        reasonCode,
      });
      return {
        completionUrl: buildFrontendFeishuCallbackUrl({
          config,
          traceId,
          redirectTo: claimed.redirectTo,
        }),
      };
    };

    let accessToken: string | null = null;
    try {
      accessToken = await exchangeFeishuCode({ ...config, code: args.code });
    } catch {
      return await reject("token_exchange_failed");
    }
    if (!accessToken) return await reject("token_exchange_failed");
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId,
      provider: "feishu",
      stage: "token_exchange_finished",
      outcome: "success",
    });

    let providerAccountId: string | null = null;
    try {
      providerAccountId = await fetchFeishuProviderAccountId(accessToken);
    } catch {
      return await reject("profile_validation_failed");
    }
    if (!providerAccountId) return await reject("profile_validation_failed");
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId,
      provider: "feishu",
      stage: "profile_validated",
      outcome: "success",
    });

    const ticket = generateOpaqueSecret();
    const completed = (await ctx.runMutation(internal.identityAuth.completeFeishuIdentityInternal, {
      stateHash,
      providerAccountId,
      ticketHash: await hashToken(ticket),
    })) as
      | { ok: true; traceId: string; redirectTo: string }
      | { ok: false; traceId: string; redirectTo: string; reasonCode: AuthTraceReasonCode };
    // completeFeishuIdentityInternal records its own terminal trace. Recording
    // again here would turn one rejected attempt into two indistinguishable events.
    if (!completed.ok) {
      return {
        completionUrl: buildFrontendFeishuCallbackUrl({
          config,
          traceId: completed.traceId,
          redirectTo: completed.redirectTo,
        }),
      };
    }
    return {
      completionUrl: buildFrontendFeishuCallbackUrl({
        config,
        traceId: completed.traceId,
        redirectTo: completed.redirectTo,
        ticket,
      }),
    };
  },
});

export const rejectFeishuOAuthCallbackInternal = internalAction({
  args: {
    state: v.string(),
    reasonCode: v.union(v.literal("oauth_access_denied"), v.literal("oauth_callback_invalid")),
  },
  handler: async (ctx, args) => {
    const config = getFeishuAuthRuntimeConfig();
    if (!config) return { completionUrl: null };
    const fallbackTraceId = createAuthTraceId();
    let stateHash: string;
    try {
      stateHash = await hashToken(normalizeOpaqueSecret(args.state));
    } catch {
      await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
        traceId: fallbackTraceId,
        provider: "feishu",
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "oauth_state_invalid",
      });
      return {
        completionUrl: buildFrontendFeishuCallbackUrl({
          config,
          traceId: fallbackTraceId,
          redirectTo: "/",
        }),
      };
    }
    const claimed = (await ctx.runMutation(internal.identityAuth.claimFeishuCallbackInternal, {
      stateHash,
      fallbackTraceId,
    })) as
      | { ok: true; traceId: string; redirectTo: string }
      | { ok: false; traceId: string; redirectTo: string };
    if (claimed.ok) {
      await ctx.runMutation(internal.identityAuth.rejectFeishuCallbackInternal, {
        stateHash,
        traceId: claimed.traceId,
        reasonCode: args.reasonCode,
      });
    }
    return {
      completionUrl: buildFrontendFeishuCallbackUrl({
        config,
        traceId: claimed.traceId,
        redirectTo: claimed.redirectTo,
      }),
    };
  },
});
