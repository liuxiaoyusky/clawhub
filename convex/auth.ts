import GitHub from "@auth/core/providers/github";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth } from "@convex-dev/auth/server";
import type { GenericMutationCtx } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import {
  createAuthTraceId,
  logAuthTrace,
  type AuthTraceEvent,
  type AuthTraceOutcome,
  type AuthTraceReasonCode,
  type AuthTraceStage,
} from "./lib/authTrace";
import { isLocalDevAuthEnabled } from "./lib/devAuth";
import { normalizeGitHubProviderAccountId } from "./lib/githubIdentity";
import {
  GITHUB_ORG_MEMBERSHIP_SYNC_PROFILE_KEY,
  fetchActiveGitHubOrgMemberships,
  readGitHubOrgMembershipSync,
  replaceGitHubOrgMemberships,
} from "./lib/githubOrgMemberships";
import { shouldScheduleGitHubProfileSync } from "./lib/githubProfileSync";
import { isEmployeeDirectoryEnabled, isFeishuAuthEnabled } from "./lib/m2AuthConfig";
import { hashToken } from "./lib/tokens";

export const BANNED_REAUTH_MESSAGE =
  "This account has been banned and cannot sign in. If you believe this is a mistake, appeal this decision: https://appeals.openclaw.ai/.";
export const DELETED_ACCOUNT_REAUTH_MESSAGE =
  "This account has been permanently deleted and cannot be restored.";

const REAUTH_BLOCKING_BAN_ACTIONS = new Set([
  "user.ban",
  "user.autoban.malware",
  "user.autoban.publisher_abuse",
]);
const DEV_PERSONAS = new Set(["owner", "user", "admin", "officialOrgMember", "abusePublisher"]);
const FEISHU_TICKET_PATTERN = /^[a-f0-9]{64}$/i;
const AUTH_TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function normalizeGitHubProfileId(profileId: unknown) {
  return normalizeGitHubProviderAccountId(profileId);
}

export function createGitHubAuthProvider() {
  return GitHub({
    clientId: process.env.AUTH_GITHUB_ID ?? "",
    clientSecret: process.env.AUTH_GITHUB_SECRET ?? "",
    authorization: {
      params: { scope: "read:user user:email read:org" },
    },
    // GitHub's OAuth email must not be treated as a ClawHub account key. The
    // immutable GitHub provider account id is the only account-linking key.
    allowDangerousEmailAccountLinking: false,
    async profile(profile, tokens) {
      let githubOrgMembershipSync;
      const accessToken = tokens.access_token?.trim();
      if (accessToken) {
        try {
          githubOrgMembershipSync = await fetchActiveGitHubOrgMemberships(accessToken);
        } catch (error) {
          console.warn(
            `[auth] GitHub organization membership sync failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return {
        id: normalizeGitHubProfileId(profile.id),
        name: profile.login,
        email: profile.email ?? undefined,
        image: profile.avatar_url,
        ...(githubOrgMembershipSync
          ? { [GITHUB_ORG_MEMBERSHIP_SYNC_PROFILE_KEY]: githubOrgMembershipSync }
          : {}),
      };
    },
  });
}

function getBannedReauthMessage(_reason: string | undefined) {
  return BANNED_REAUTH_MESSAGE;
}

export async function handleDeletedUserSignIn(
  ctx: GenericMutationCtx<DataModel>,
  args: { userId: Id<"users">; existingUserId: Id<"users"> | null },
  userOverride?: {
    deletedAt?: number;
    deactivatedAt?: number;
    purgedAt?: number;
    banReason?: string;
  } | null,
) {
  const user = userOverride !== undefined ? userOverride : await ctx.db.get(args.userId);
  if (!user?.deletedAt && !user?.deactivatedAt) return;

  // Verify that the incoming identity matches the existing account to prevent bypass.
  if (args.existingUserId && args.existingUserId !== args.userId) {
    return;
  }

  if (user.deactivatedAt) {
    throw new ConvexError(DELETED_ACCOUNT_REAUTH_MESSAGE);
  }

  const userId = args.userId;
  const deletedAt = user.deletedAt ?? Date.now();
  const banRecords = await ctx.db
    .query("auditLogs")
    .withIndex("by_target", (q) => q.eq("targetType", "user").eq("targetId", userId.toString()))
    .collect();

  const hasBlockingBan = banRecords.some((record) =>
    REAUTH_BLOCKING_BAN_ACTIONS.has(record.action),
  );

  if (hasBlockingBan) {
    throw new ConvexError(getBannedReauthMessage(user.banReason));
  }

  // Migrate legacy self-deleted accounts (stored in deletedAt) to the new
  // irreversible state and reject sign-in.
  await ctx.db.patch(userId, {
    deletedAt: undefined,
    deactivatedAt: deletedAt,
    purgedAt: user.purgedAt ?? deletedAt,
    updatedAt: Date.now(),
  });

  throw new ConvexError(DELETED_ACCOUNT_REAUTH_MESSAGE);
}

type AuthProfile = Record<string, unknown> & {
  email?: string;
  phone?: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
};

function userDataFromAuthProfile(args: {
  provider: { type: string; allowDangerousEmailAccountLinking?: boolean };
  profile: AuthProfile;
}) {
  const {
    emailVerified: profileEmailVerified,
    phoneVerified: profilePhoneVerified,
    [GITHUB_ORG_MEMBERSHIP_SYNC_PROFILE_KEY]: _githubOrgMembershipSync,
    ...profile
  } = args.profile;
  const emailVerified =
    profileEmailVerified ??
    ((args.provider.type === "oauth" || args.provider.type === "oidc") &&
      args.provider.allowDangerousEmailAccountLinking !== false);
  const phoneVerified = profilePhoneVerified ?? false;

  return {
    ...(emailVerified ? { emailVerificationTime: Date.now() } : null),
    ...(phoneVerified ? { phoneVerificationTime: Date.now() } : null),
    ...profile,
  };
}

async function schedulePostUserCreatedOrUpdated(
  ctx: GenericMutationCtx<DataModel>,
  userId: Id<"users">,
  user: Parameters<typeof shouldScheduleGitHubProfileSync>[0],
) {
  await ctx.scheduler.runAfter(0, internal.publishers.ensurePersonalPublisherInternal, {
    userId,
  });

  // Schedule GitHub profile sync to handle username renames (fixes #303).
  // This runs as a background action so it doesn't block sign-in.
  const now = Date.now();
  if (shouldScheduleGitHubProfileSync(user, now)) {
    await ctx.scheduler.runAfter(0, internal.users.syncGitHubProfileAction, {
      userId,
    });
  }
}

async function requireActiveEmployeeDirectoryUser(
  ctx: GenericMutationCtx<DataModel>,
  userId: Id<"users">,
) {
  const employee = await ctx.db
    .query("employeeDirectory")
    .withIndex("by_user_id", (q) => q.eq("userId", userId))
    .unique();
  if (!employee?.valid) {
    throw new ConvexError("Sign in failed. Please try again.");
  }
  return employee;
}

function employeeDirectoryUserPatch(
  userData: ReturnType<typeof userDataFromAuthProfile>,
  employee: { email: string; role: "admin" | "user" },
) {
  // GitHub profile email is display data only in M2. The employee directory
  // owns the email stored on the canonical local user.
  const {
    email: _githubEmail,
    emailVerificationTime: _githubEmailVerificationTime,
    ...profile
  } = userData;
  return {
    ...profile,
    email: employee.email,
    emailVerificationTime: undefined,
    role: employee.role,
    updatedAt: Date.now(),
  };
}

function isDirectGitHubOAuth(args: { provider: { id?: string } }) {
  return args.provider.id === "github";
}

async function recordDirectGitHubAuthTrace(
  ctx: Pick<GenericMutationCtx<DataModel>, "db">,
  stage: AuthTraceStage,
  outcome: AuthTraceOutcome,
  reasonCode?: AuthTraceReasonCode,
) {
  const occurredAt = Date.now();
  const event: AuthTraceEvent = {
    traceId: createAuthTraceId(),
    provider: "github",
    stage,
    outcome,
    occurredAt,
    ...(reasonCode ? { reasonCode } : {}),
  };
  logAuthTrace(console, event);
  await ctx.db.insert("authTraceEvents", {
    ...event,
    expiresAt: occurredAt + AUTH_TRACE_RETENTION_MS,
  });
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    createGitHubAuthProvider(),
    ConvexCredentials({
      id: "feishu",
      authorize: async (credentials, ctx) => {
        if (!isFeishuAuthEnabled()) throw new Error("Feishu sign-in is unavailable");
        const ticket = typeof credentials.ticket === "string" ? credentials.ticket.trim() : "";
        if (!FEISHU_TICKET_PATTERN.test(ticket)) throw new Error("Invalid Feishu sign-in ticket");
        const userId = (await ctx.runMutation(
          internal.identityAuth.redeemFeishuSessionTicketInternal,
          { ticketHash: await hashToken(ticket) },
        )) as Id<"users">;
        return { userId };
      },
    }),
    ConvexCredentials({
      id: "dev-persona",
      authorize: async (credentials, ctx) => {
        if (isEmployeeDirectoryEnabled()) {
          throw new Error("Dev auth is unavailable while M2 employee identity is enabled");
        }
        const devAuthSecret =
          typeof credentials.devAuthSecret === "string" ? credentials.devAuthSecret : undefined;
        if (!isLocalDevAuthEnabled(process.env, devAuthSecret)) {
          throw new Error("Dev auth is disabled");
        }
        const persona = typeof credentials.persona === "string" ? credentials.persona : "";
        if (!DEV_PERSONAS.has(persona)) throw new Error("Unknown dev persona");
        const userId: Id<"users"> = await ctx.runMutation(internal.users.upsertDevPersonaInternal, {
          persona: persona as "owner" | "user" | "admin" | "officialOrgMember" | "abusePublisher",
          devAuthSecret,
        });
        return { userId };
      },
    }),
  ],
  callbacks: {
    /**
     * Create/update users and sync GitHub profile.
     *
     * Banned/deleted users keep the OAuth callback non-mutating so code
     * redemption can fail in beforeSessionCreation and render /account-banned.
     *
     * The GitHub profile sync is scheduled as a background action to handle
     * the case where a user renames their GitHub account (fixes #303).
     */
    async createOrUpdateUser(ctx, args) {
      const userData = userDataFromAuthProfile(args);
      const githubOrgMembershipSync = readGitHubOrgMembershipSync(args.profile);
      const employeeDirectoryEnabled = isEmployeeDirectoryEnabled();
      if (args.existingUserId !== null) {
        const userId = args.existingUserId as Id<"users">;
        const existingUser = await ctx.db.get(userId);
        if (existingUser?.deletedAt || existingUser?.deactivatedAt) {
          if (employeeDirectoryEnabled && isDirectGitHubOAuth(args)) {
            await recordDirectGitHubAuthTrace(
              ctx,
              "rejected",
              "rejected",
              "session_creation_failed",
            );
          }
          return userId;
        }
        let employee = null;
        if (employeeDirectoryEnabled) {
          try {
            employee = await requireActiveEmployeeDirectoryUser(ctx, userId);
          } catch (error) {
            if (isDirectGitHubOAuth(args)) {
              await recordDirectGitHubAuthTrace(
                ctx,
                "rejected",
                "rejected",
                "identity_binding_failed",
              );
            }
            throw error;
          }
        }
        await ctx.db.patch(
          userId,
          employee ? employeeDirectoryUserPatch(userData, employee) : userData,
        );
        if (githubOrgMembershipSync) {
          await replaceGitHubOrgMemberships(ctx, userId, githubOrgMembershipSync);
        }
        await schedulePostUserCreatedOrUpdated(ctx, userId, existingUser);
        if (employeeDirectoryEnabled && isDirectGitHubOAuth(args)) {
          await recordDirectGitHubAuthTrace(ctx, "profile_validated", "success");
        }
        return userId;
      }

      // M2 intentionally permits no GitHub-driven registration or account
      // merge. A GitHub credential has to be explicitly bound first.
      if (employeeDirectoryEnabled) {
        if (isDirectGitHubOAuth(args)) {
          await recordDirectGitHubAuthTrace(ctx, "rejected", "rejected", "identity_binding_failed");
        }
        throw new ConvexError("Sign in failed. Please try again.");
      }

      const userId = await ctx.db.insert("users", userData);
      if (githubOrgMembershipSync) {
        await replaceGitHubOrgMemberships(ctx, userId, githubOrgMembershipSync);
      }
      const user = await ctx.db.get(userId);
      await schedulePostUserCreatedOrUpdated(ctx, userId, user);
      return userId;
    },
    async beforeSessionCreation(ctx, args) {
      await handleDeletedUserSignIn(ctx, {
        userId: args.userId,
        existingUserId: args.userId,
      });
      if (isEmployeeDirectoryEnabled()) {
        const employee = await requireActiveEmployeeDirectoryUser(ctx, args.userId as Id<"users">);
        await ctx.db.patch(args.userId, {
          email: employee.email,
          emailVerificationTime: undefined,
          role: employee.role,
          updatedAt: Date.now(),
        });
      }
    },
  },
});
