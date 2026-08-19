import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { requireUser } from "./lib/access";
import { normalizeEmployeeEmail } from "./lib/employeeDirectory";
import {
  getEmployeeDirectoryBootstrapAdminEmail,
  isEmployeeDirectoryEnabled,
} from "./lib/m2AuthConfig";

const employeeRoleValidator = v.union(v.literal("admin"), v.literal("user"));

async function requireEmployeeDirectoryAdmin(ctx: Parameters<typeof requireUser>[0]) {
  if (!isEmployeeDirectoryEnabled()) {
    throw new ConvexError("Employee directory management is not enabled.");
  }
  const { user } = await requireUser(ctx);
  const employee = await ctx.db
    .query("employeeDirectory")
    .withIndex("by_user_id", (q) => q.eq("userId", user._id))
    .unique();
  if (!employee?.valid || employee.role !== "admin") {
    throw new ConvexError("Forbidden");
  }
  return { user, employee };
}

function requireEmployeeEmail(value: string) {
  const email = normalizeEmployeeEmail(value);
  if (!email) throw new ConvexError("A valid employee email is required.");
  return email;
}

function assertAllowedEmployeeRole(email: string, role: "admin" | "user") {
  if (role !== "admin") return;
  const bootstrapAdminEmail = getEmployeeDirectoryBootstrapAdminEmail();
  if (!bootstrapAdminEmail || bootstrapAdminEmail !== email) {
    throw new ConvexError("Only the configured employee admin may have the admin role.");
  }
}

/**
 * Local M2 control plane. An admin records the employee before that person can
 * establish an SSO-backed session. The linked users.role remains a projection
 * for legacy authorization call sites, never an independent source of truth.
 */
export const upsert = mutation({
  args: {
    email: v.string(),
    valid: v.boolean(),
    role: employeeRoleValidator,
  },
  handler: async (ctx, args) => {
    const { user: actor } = await requireEmployeeDirectoryAdmin(ctx);
    const email = requireEmployeeEmail(args.email);
    assertAllowedEmployeeRole(email, args.role);
    const now = Date.now();
    const existing = await ctx.db
      .query("employeeDirectory")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    const employeeId = existing
      ? existing._id
      : await ctx.db.insert("employeeDirectory", {
          email,
          valid: args.valid,
          role: args.role,
          createdAt: now,
          updatedAt: now,
        });
    if (existing) {
      await ctx.db.patch(existing._id, {
        valid: args.valid,
        role: args.role,
        updatedAt: now,
      });
    }

    const linkedUserId = existing?.userId;
    if (linkedUserId) {
      const linkedUser = await ctx.db.get(linkedUserId);
      if (linkedUser) {
        await ctx.db.patch(linkedUserId, {
          email,
          role: args.role,
          updatedAt: now,
        });
      }
    }

    await ctx.db.insert("auditLogs", {
      actorUserId: actor._id,
      action: "auth.employee_directory.updated",
      targetType: "employee_directory",
      targetId: employeeId,
      metadata: { role: args.role, valid: args.valid, linkedUser: Boolean(linkedUserId) },
      createdAt: now,
    });
    return { employeeId, valid: args.valid, role: args.role };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireEmployeeDirectoryAdmin(ctx);
    return await ctx.db
      .query("employeeDirectory")
      .withIndex("by_email", (q) => q)
      .take(500);
  },
});
