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
import { normalizeEmployeeEmail } from "./lib/employeeDirectory";
import { normalizeGitHubProviderAccountId } from "./lib/githubIdentity";
import {
  buildFeishuAuthorizationUrl,
  buildFrontendFeishuCallbackUrl,
  buildFrontendGitHubLinkCallbackUrl,
  buildGitHubIdentityLinkAuthorizationUrl,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  getEmployeeDirectoryBootstrapAdminEmail,
  getFeishuAuthRuntimeConfig,
  getGitHubIdentityLinkRuntimeConfig,
  isEmployeeDirectoryEnabled,
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
type EmployeeDirectoryEntry = Doc<"employeeDirectory">;

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

async function findGitHubAccount(ctx: Pick<MutationCtx, "db">, providerAccountId: string) {
  return await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "github").eq("providerAccountId", providerAccountId),
    )
    .unique();
}

async function findEmployeeByEmail(
  ctx: Pick<MutationCtx | QueryCtx, "db">,
  email: string,
): Promise<EmployeeDirectoryEntry | null> {
  return await ctx.db
    .query("employeeDirectory")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
}

async function findEmployeeForUser(
  ctx: Pick<MutationCtx | QueryCtx, "db">,
  userId: Id<"users">,
): Promise<EmployeeDirectoryEntry | null> {
  return await ctx.db
    .query("employeeDirectory")
    .withIndex("by_user_id", (q) => q.eq("userId", userId))
    .unique();
}

async function getOrCreateBootstrapEmployee(
  ctx: Pick<MutationCtx, "db">,
  email: string,
  now: number,
) {
  const existing = await findEmployeeByEmail(ctx, email);
  if (existing) return existing;
  if (getEmployeeDirectoryBootstrapAdminEmail() !== email) return null;

  const employeeId = await ctx.db.insert("employeeDirectory", {
    email,
    valid: true,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
  return await ctx.db.get(employeeId);
}

function isActiveEmployee(
  employee: EmployeeDirectoryEntry | null,
): employee is EmployeeDirectoryEntry {
  return Boolean(employee?.valid);
}

async function rejectFeishuIdentityBinding(
  ctx: Pick<MutationCtx, "db">,
  args: {
    attempt: Doc<"identityAuthAttempts">;
    reasonCode: AuthTraceReasonCode;
    occurredAt: number;
  },
) {
  await ctx.db.patch(args.attempt._id, { status: "rejected" });
  await recordRejectedAttempt(ctx, {
    traceId: args.attempt.traceId as AuthTraceId,
    reasonCode: args.reasonCode,
    occurredAt: args.occurredAt,
  });
  return {
    ok: false as const,
    traceId: args.attempt.traceId,
    redirectTo: args.attempt.redirectTo,
    reasonCode: args.reasonCode,
  };
}

async function recordRejectedGitHubLink(
  ctx: Pick<MutationCtx, "db">,
  args: { traceId: AuthTraceId; reasonCode: AuthTraceReasonCode; occurredAt: number },
) {
  await recordAuthTrace(ctx, {
    traceId: args.traceId,
    provider: "github",
    stage: "rejected",
    outcome: "rejected",
    occurredAt: args.occurredAt,
    reasonCode: args.reasonCode,
  });
}

export const getIdentityStatus = query({
  args: {},
  handler: async (ctx) => {
    const feishuEnabled = isFeishuAuthEnabled();
    const userId = await getRawAuthenticatedUserId(ctx);
    if (!userId) return { feishuEnabled, status: "signed_out" as const };
    const user = await ctx.db.get(userId);
    if (!isActiveUser(user)) return { feishuEnabled, status: "signed_out" as const };
    if (!feishuEnabled || !isEmployeeDirectoryEnabled()) {
      return { feishuEnabled, status: "active" as const };
    }
    const employee = await findEmployeeForUser(ctx, user._id);
    return employee
      ? { feishuEnabled, status: "active" as const }
      : { feishuEnabled, status: "needs_feishu_link" as const };
  },
});

export const beginFeishuAuthorization = mutation({
  args: {
    intent: v.union(v.literal("sign_in"), v.literal("link_existing_user")),
    redirectTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const config = getFeishuAuthRuntimeConfig();
    if (!config || !isFeishuAuthEnabled()) {
      throw new ConvexError("Sign in is not available. Please try again later.");
    }

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
        v.literal("token_exchange_client_secret_invalid"),
        v.literal("token_exchange_authorization_code_invalid"),
        v.literal("token_exchange_user_not_authorized"),
        v.literal("token_exchange_redirect_uri_mismatch"),
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
      v.literal("token_exchange_client_secret_invalid"),
      v.literal("token_exchange_authorization_code_invalid"),
      v.literal("token_exchange_user_not_authorized"),
      v.literal("token_exchange_redirect_uri_mismatch"),
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
    employeeEmail: v.string(),
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

    if (!isEmployeeDirectoryEnabled()) {
      return await rejectFeishuIdentityBinding(ctx, {
        attempt,
        reasonCode: "provider_unavailable",
        occurredAt: now,
      });
    }
    const employeeEmail = normalizeEmployeeEmail(args.employeeEmail);
    if (!employeeEmail) {
      return await rejectFeishuIdentityBinding(ctx, {
        attempt,
        reasonCode: "profile_validation_failed",
        occurredAt: now,
      });
    }
    const employee = await getOrCreateBootstrapEmployee(ctx, employeeEmail, now);
    if (!isActiveEmployee(employee)) {
      return await rejectFeishuIdentityBinding(ctx, {
        attempt,
        reasonCode: "identity_binding_failed",
        occurredAt: now,
      });
    }

    const existingAccount = await findFeishuAccount(ctx, args.providerAccountId);
    let user: ActiveUser | null = null;
    let isNewUser = false;
    if (attempt.targetUserId) {
      const targetUser = await ctx.db.get(attempt.targetUserId);
      if (
        !isActiveUser(targetUser) ||
        (employee.userId && employee.userId !== targetUser._id) ||
        (existingAccount && existingAccount.userId !== targetUser._id)
      ) {
        return await rejectFeishuIdentityBinding(ctx, {
          attempt,
          reasonCode:
            employee.userId || existingAccount ? "identity_conflict" : "identity_binding_failed",
          occurredAt: now,
        });
      }
      user = targetUser;
    } else if (employee.userId) {
      const existingUser = await ctx.db.get(employee.userId);
      if (!isActiveUser(existingUser)) {
        return await rejectFeishuIdentityBinding(ctx, {
          attempt,
          reasonCode: "identity_binding_failed",
          occurredAt: now,
        });
      }
      if (existingAccount && existingAccount.userId !== existingUser._id) {
        return await rejectFeishuIdentityBinding(ctx, {
          attempt,
          reasonCode: "identity_conflict",
          occurredAt: now,
        });
      }
      user = existingUser;
    } else if (existingAccount) {
      const existingUser = await ctx.db.get(existingAccount.userId);
      if (!isActiveUser(existingUser)) {
        return await rejectFeishuIdentityBinding(ctx, {
          attempt,
          reasonCode: "identity_binding_failed",
          occurredAt: now,
        });
      }
      user = existingUser;
    } else {
      const userId = await ctx.db.insert("users", {
        email: employee.email,
        role: employee.role,
        enterpriseIdentityVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      user = await ctx.db.get(userId);
      isNewUser = true;
    }

    if (!isActiveUser(user)) {
      return await rejectFeishuIdentityBinding(ctx, {
        attempt,
        reasonCode: "identity_binding_failed",
        occurredAt: now,
      });
    }

    // A canonical local user can represent only one employee-email record.
    // Without this check, an existing Feishu credential could attach a second
    // directory row to the same user during a later sign-in.
    const employeeForUser = await findEmployeeForUser(ctx, user._id);
    if (employeeForUser && employeeForUser._id !== employee._id) {
      return await rejectFeishuIdentityBinding(ctx, {
        attempt,
        reasonCode: "identity_conflict",
        occurredAt: now,
      });
    }

    if (!employee.userId) {
      await ctx.db.patch(employee._id, { userId: user._id, updatedAt: now });
    }
    if (!existingAccount) {
      await ctx.db.insert("authAccounts", {
        userId: user._id,
        provider: "feishu",
        providerAccountId: args.providerAccountId,
      });
    }
    await ctx.db.patch(user._id, {
      email: employee.email,
      emailVerificationTime: undefined,
      enterpriseIdentityVerifiedAt: now,
      role: employee.role,
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
    const employee = isActiveUser(user) ? await findEmployeeForUser(ctx, user._id) : null;
    if (!isActiveUser(user) || !isActiveEmployee(employee)) {
      throw new ConvexError("Sign in failed. Please try again.");
    }
    await ctx.db.patch(user._id, {
      email: employee.email,
      emailVerificationTime: undefined,
      role: employee.role,
      updatedAt: now,
    });
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
    const config = getGitHubIdentityLinkRuntimeConfig();
    if (!config) throw new ConvexError("Identity linking is not available.");
    const targetUser = await requireRawActiveUser(ctx);
    const employee = await findEmployeeForUser(ctx, targetUser._id);
    if (!isActiveEmployee(employee)) {
      throw new ConvexError("Verify your employee identity before linking GitHub.");
    }
    await ctx.db.patch(targetUser._id, {
      email: employee.email,
      emailVerificationTime: undefined,
      role: employee.role,
      updatedAt: Date.now(),
    });
    const state = generateOpaqueSecret();
    const now = Date.now();
    const traceId = createAuthTraceId();
    await ctx.db.insert("identityAuthLinks", {
      secretHash: await hashToken(state),
      targetUserId: targetUser._id,
      provider: "github",
      traceId,
      createdAt: now,
      expiresAt: now + GITHUB_LINK_TTL_MS,
      status: "pending",
    });
    await recordAuthTrace(ctx, {
      traceId,
      provider: "github",
      stage: "oauth_started",
      outcome: "started",
      occurredAt: now,
    });
    return { authorizationUrl: buildGitHubIdentityLinkAuthorizationUrl(config, state) };
  },
});

export const claimGitHubLinkCallbackInternal = internalMutation({
  args: {
    stateHash: v.string(),
    fallbackTraceId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await ctx.db
      .query("identityAuthLinks")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.stateHash))
      .unique();
    const fallbackTraceId = args.fallbackTraceId as AuthTraceId;
    if (!link) {
      await recordRejectedGitHubLink(ctx, {
        traceId: fallbackTraceId,
        reasonCode: "oauth_state_invalid",
        occurredAt: now,
      });
      return { ok: false as const, traceId: fallbackTraceId };
    }
    if (link.expiresAt <= now || link.usedAt || (link.status && link.status !== "pending")) {
      if (!link.usedAt && (!link.status || link.status === "pending")) {
        await ctx.db.patch(link._id, { status: "rejected", usedAt: now });
      }
      await recordRejectedGitHubLink(ctx, {
        traceId: link.traceId as AuthTraceId,
        reasonCode: link.expiresAt <= now ? "oauth_state_invalid" : "oauth_callback_invalid",
        occurredAt: now,
      });
      return { ok: false as const, traceId: link.traceId };
    }

    await ctx.db.patch(link._id, { status: "processing", callbackReceivedAt: now });
    await recordAuthTrace(ctx, {
      traceId: link.traceId as AuthTraceId,
      provider: "github",
      stage: "oauth_callback_received",
      outcome: "success",
      occurredAt: now,
    });
    return { ok: true as const, traceId: link.traceId };
  },
});

export const rejectGitHubLinkCallbackInternal = internalMutation({
  args: {
    stateHash: v.string(),
    fallbackTraceId: v.string(),
    reasonCode: v.union(
      v.literal("oauth_state_invalid"),
      v.literal("oauth_callback_invalid"),
      v.literal("oauth_access_denied"),
      v.literal("token_exchange_failed"),
      v.literal("token_exchange_client_secret_invalid"),
      v.literal("token_exchange_authorization_code_invalid"),
      v.literal("token_exchange_user_not_authorized"),
      v.literal("token_exchange_redirect_uri_mismatch"),
      v.literal("profile_validation_failed"),
      v.literal("identity_binding_failed"),
      v.literal("identity_conflict"),
      v.literal("session_creation_failed"),
      v.literal("provider_unavailable"),
    ),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("identityAuthLinks")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.stateHash))
      .unique();
    const now = Date.now();
    const traceId = (link?.traceId ?? args.fallbackTraceId) as AuthTraceId;
    if (
      link &&
      !link.usedAt &&
      link.expiresAt > now &&
      (!link.status || link.status === "pending" || link.status === "processing")
    ) {
      await ctx.db.patch(link._id, { status: "rejected", usedAt: now });
    }
    await recordRejectedGitHubLink(ctx, { traceId, reasonCode: args.reasonCode, occurredAt: now });
    return { traceId };
  },
});

export const completeGitHubLinkIdentityInternal = internalMutation({
  args: {
    stateHash: v.string(),
    providerAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await ctx.db
      .query("identityAuthLinks")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.stateHash))
      .unique();
    if (!link || link.status !== "processing" || link.expiresAt <= now) {
      const traceId = link?.traceId ?? createAuthTraceId();
      await recordRejectedGitHubLink(ctx, {
        traceId: traceId as AuthTraceId,
        reasonCode: "identity_binding_failed",
        occurredAt: now,
      });
      return { ok: false as const, traceId };
    }

    const reject = async (reasonCode: AuthTraceReasonCode) => {
      await ctx.db.patch(link._id, { status: "rejected", usedAt: now });
      await recordRejectedGitHubLink(ctx, {
        traceId: link.traceId as AuthTraceId,
        reasonCode,
        occurredAt: now,
      });
      return { ok: false as const, traceId: link.traceId, reasonCode };
    };

    const targetUser = await ctx.db.get(link.targetUserId);
    const employee = isActiveUser(targetUser)
      ? await findEmployeeForUser(ctx, targetUser._id)
      : null;
    if (!isActiveUser(targetUser) || !isActiveEmployee(employee)) {
      return await reject("identity_binding_failed");
    }
    const githubAccount = await findGitHubAccount(ctx, args.providerAccountId);
    const targetGithubAccount = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) =>
        q.eq("userId", targetUser._id).eq("provider", "github"),
      )
      .unique();
    if (
      (githubAccount && githubAccount.userId !== targetUser._id) ||
      (targetGithubAccount && targetGithubAccount.providerAccountId !== args.providerAccountId)
    ) {
      return await reject("identity_conflict");
    }
    if (!githubAccount) {
      await ctx.db.insert("authAccounts", {
        userId: targetUser._id,
        provider: "github",
        providerAccountId: args.providerAccountId,
      });
    }
    await ctx.db.patch(targetUser._id, {
      email: employee.email,
      emailVerificationTime: undefined,
      role: employee.role,
      updatedAt: now,
    });
    await ctx.db.patch(link._id, { status: "completed", usedAt: now });
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
    return { ok: true as const, traceId: link.traceId };
  },
});

async function exchangeFeishuCode(args: {
  appId: string;
  appSecret: string;
  callbackUrl: string;
  code: string;
}): Promise<{ ok: true; accessToken: string } | { ok: false; reasonCode: AuthTraceReasonCode }> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(FEISHU_TOKEN_URL, {
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
  } catch {
    return { ok: false, reasonCode: "provider_unavailable" };
  }
  const tokenPayload = (await tokenResponse.json().catch(() => null)) as {
    code?: unknown;
    access_token?: unknown;
  } | null;
  const reasonCode = classifyFeishuTokenExchangeFailure(tokenPayload?.code, tokenResponse.ok);
  if (reasonCode) return { ok: false, reasonCode };
  const accessToken = tokenPayload?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { ok: false, reasonCode: "token_exchange_failed" };
  }
  return { ok: true, accessToken };
}

function classifyFeishuTokenExchangeFailure(code: unknown, responseOk: boolean) {
  if (code === 0 && responseOk) return null;
  if (code === 20002) return "token_exchange_client_secret_invalid" as const;
  if (code === 20003 || code === 20004 || code === 20024 || code === 20065) {
    return "token_exchange_authorization_code_invalid" as const;
  }
  if (code === 20010) return "token_exchange_user_not_authorized" as const;
  if (code === 20071) return "token_exchange_redirect_uri_mismatch" as const;
  if (code === 20050 || code === 20072) return "provider_unavailable" as const;
  return "token_exchange_failed" as const;
}

type FeishuIdentityProfile = Readonly<{
  providerAccountId: string;
  employeeEmail: string;
}>;

async function fetchFeishuIdentityProfile(
  accessToken: string,
): Promise<FeishuIdentityProfile | null> {
  const profileResponse = await fetch(FEISHU_USER_INFO_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
  });
  if (!profileResponse.ok) return null;
  const profilePayload = (await profileResponse.json().catch(() => null)) as {
    code?: unknown;
    data?: { open_id?: unknown; email?: unknown };
  } | null;
  if (profilePayload?.code !== 0) return null;
  const openId = profilePayload?.data?.open_id;
  const email = profilePayload?.data?.email;
  if (typeof openId !== "string" || !openId.trim() || typeof email !== "string") return null;
  const employeeEmail = normalizeEmployeeEmail(email);
  return employeeEmail ? { providerAccountId: openId.trim(), employeeEmail } : null;
}

async function fetchFeishuProviderAccountId(accessToken: string) {
  const profile = await fetchFeishuIdentityProfile(accessToken);
  return profile?.providerAccountId ?? null;
}

export const completeFeishuOAuthCallbackInternal = internalAction({
  args: { state: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const config = getFeishuAuthRuntimeConfig();
    if (!config || !isFeishuAuthEnabled()) return { completionUrl: null };
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

    const tokenExchange = await exchangeFeishuCode({ ...config, code: args.code });
    if (!tokenExchange.ok) return await reject(tokenExchange.reasonCode);
    const accessToken = tokenExchange.accessToken;
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId,
      provider: "feishu",
      stage: "token_exchange_finished",
      outcome: "success",
    });

    let profile: FeishuIdentityProfile | null = null;
    try {
      profile = await fetchFeishuIdentityProfile(accessToken);
    } catch {
      return await reject("profile_validation_failed");
    }
    if (!profile) return await reject("profile_validation_failed");
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId,
      provider: "feishu",
      stage: "profile_validated",
      outcome: "success",
    });

    const ticket = generateOpaqueSecret();
    const completed = (await ctx.runMutation(internal.identityAuth.completeFeishuIdentityInternal, {
      stateHash,
      providerAccountId: profile.providerAccountId,
      employeeEmail: profile.employeeEmail,
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
    if (!config || !isFeishuAuthEnabled()) return { completionUrl: null };
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

async function exchangeGitHubLinkCode(args: {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  code: string;
}): Promise<{ ok: true; accessToken: string } | { ok: false; reasonCode: AuthTraceReasonCode }> {
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: args.callbackUrl,
      }),
    });
  } catch {
    return { ok: false, reasonCode: "provider_unavailable" };
  }
  const tokenPayload = (await tokenResponse.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  if (!tokenResponse.ok || typeof tokenPayload?.error === "string") {
    if (tokenPayload?.error === "incorrect_client_credentials") {
      return { ok: false, reasonCode: "token_exchange_client_secret_invalid" };
    }
    if (tokenPayload?.error === "bad_verification_code") {
      return { ok: false, reasonCode: "token_exchange_authorization_code_invalid" };
    }
    if (tokenPayload?.error === "redirect_uri_mismatch") {
      return { ok: false, reasonCode: "token_exchange_redirect_uri_mismatch" };
    }
    return { ok: false, reasonCode: "token_exchange_failed" };
  }
  const accessToken = tokenPayload?.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { ok: false, reasonCode: "token_exchange_failed" };
  }
  return { ok: true, accessToken };
}

async function fetchGitHubProviderAccountId(accessToken: string) {
  let profileResponse: Response;
  try {
    profileResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    return null;
  }
  if (!profileResponse.ok) return null;
  const profile = (await profileResponse.json().catch(() => null)) as { id?: unknown } | null;
  try {
    return normalizeGitHubProviderAccountId(profile?.id);
  } catch {
    return null;
  }
}

export const completeGitHubLinkOAuthCallbackInternal = internalAction({
  args: { state: v.string(), code: v.string() },
  handler: async (ctx, args) => {
    const config = getGitHubIdentityLinkRuntimeConfig();
    if (!config) return { completionUrl: null };
    const fallbackTraceId = createAuthTraceId();
    let stateHash: string;
    try {
      stateHash = await hashToken(normalizeOpaqueSecret(args.state));
    } catch {
      await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
        traceId: fallbackTraceId,
        provider: "github",
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "oauth_state_invalid",
      });
      return {
        completionUrl: buildFrontendGitHubLinkCallbackUrl({
          config,
          traceId: fallbackTraceId,
          success: false,
        }),
      };
    }

    const claimed = (await ctx.runMutation(internal.identityAuth.claimGitHubLinkCallbackInternal, {
      stateHash,
      fallbackTraceId,
    })) as { ok: true; traceId: string } | { ok: false; traceId: string };
    if (!claimed.ok) {
      return {
        completionUrl: buildFrontendGitHubLinkCallbackUrl({
          config,
          traceId: claimed.traceId,
          success: false,
        }),
      };
    }

    const reject = async (reasonCode: AuthTraceReasonCode) => {
      const rejected = (await ctx.runMutation(
        internal.identityAuth.rejectGitHubLinkCallbackInternal,
        {
          stateHash,
          fallbackTraceId,
          reasonCode,
        },
      )) as { traceId: string };
      return {
        completionUrl: buildFrontendGitHubLinkCallbackUrl({
          config,
          traceId: rejected.traceId,
          success: false,
        }),
      };
    };

    const tokenExchange = await exchangeGitHubLinkCode({ ...config, code: args.code });
    if (!tokenExchange.ok) return await reject(tokenExchange.reasonCode);
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId: claimed.traceId,
      provider: "github",
      stage: "token_exchange_finished",
      outcome: "success",
    });

    const providerAccountId = await fetchGitHubProviderAccountId(tokenExchange.accessToken);
    if (!providerAccountId) return await reject("profile_validation_failed");
    await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
      traceId: claimed.traceId,
      provider: "github",
      stage: "profile_validated",
      outcome: "success",
    });

    const completed = (await ctx.runMutation(
      internal.identityAuth.completeGitHubLinkIdentityInternal,
      {
        stateHash,
        providerAccountId,
      },
    )) as { ok: true; traceId: string } | { ok: false; traceId: string };
    return {
      completionUrl: buildFrontendGitHubLinkCallbackUrl({
        config,
        traceId: completed.traceId,
        success: completed.ok,
      }),
    };
  },
});

export const rejectGitHubLinkOAuthCallbackInternal = internalAction({
  args: {
    state: v.string(),
    reasonCode: v.union(v.literal("oauth_access_denied"), v.literal("oauth_callback_invalid")),
  },
  handler: async (ctx, args) => {
    const config = getGitHubIdentityLinkRuntimeConfig();
    if (!config) return { completionUrl: null };
    const fallbackTraceId = createAuthTraceId();
    let stateHash: string;
    try {
      stateHash = await hashToken(normalizeOpaqueSecret(args.state));
    } catch {
      await ctx.runMutation(internal.identityAuth.recordAuthTraceInternal, {
        traceId: fallbackTraceId,
        provider: "github",
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "oauth_state_invalid",
      });
      return {
        completionUrl: buildFrontendGitHubLinkCallbackUrl({
          config,
          traceId: fallbackTraceId,
          success: false,
        }),
      };
    }
    const rejected = (await ctx.runMutation(
      internal.identityAuth.rejectGitHubLinkCallbackInternal,
      {
        stateHash,
        fallbackTraceId,
        reasonCode: args.reasonCode,
      },
    )) as { traceId: string };
    return {
      completionUrl: buildFrontendGitHubLinkCallbackUrl({
        config,
        traceId: rejected.traceId,
        success: false,
      }),
    };
  },
});

export const __test = {
  exchangeFeishuCode,
  exchangeGitHubLinkCode,
  fetchFeishuIdentityProfile,
  fetchFeishuProviderAccountId,
  fetchGitHubProviderAccountId,
};
