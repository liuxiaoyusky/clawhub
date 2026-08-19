/// <reference types="vite/client" />
/* @vitest-environment node */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { hashToken } from "./lib/tokens";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const PROVIDER_ACCOUNT_ID = "ou_provider_fixture";
const EMPLOYEE_EMAIL = "employee@example.test";
const OTHER_EMPLOYEE_EMAIL = "other-employee@example.test";

beforeEach(() => {
  vi.stubEnv("AUTH_FEISHU_ENABLED", "1");
  vi.stubEnv("AUTH_FEISHU_APP_ID", "cli_fixture");
  vi.stubEnv("AUTH_FEISHU_APP_SECRET", "fixture-secret");
  vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
  vi.stubEnv("AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://convex.example.test");
  vi.stubEnv("SITE_URL", "https://skillhub.example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("M2 Feishu OAuth controlled success path", () => {
  it("creates and consumes a one-time session ticket after the provider and profile succeed", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, access_token: "access-token-fixture" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { open_id: PROVIDER_ACCOUNT_ID, email: EMPLOYEE_EMAIL },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await t.run(async (ctx) => {
      await ctx.db.insert("employeeDirectory", {
        email: EMPLOYEE_EMAIL,
        valid: true,
        role: "user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const started = await t.mutation(api.identityAuth.beginFeishuAuthorization, {
      intent: "sign_in",
      redirectTo: "/dashboard",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Test setup did not receive an OAuth state");

    const completed = await t.action(internal.identityAuth.completeFeishuOAuthCallbackInternal, {
      state,
      code: "authorization-code-fixture",
    });
    if (!completed.completionUrl) throw new Error("Test setup did not receive a completion URL");

    const completionUrl = new URL(completed.completionUrl);
    const fragment = new URLSearchParams(completionUrl.hash.slice(1));
    const ticket = fragment.get("ticket");
    if (!ticket) throw new Error("Test setup did not receive a session ticket");
    const stateHash = await hashToken(state);
    const ticketHash = await hashToken(ticket);

    const userId = await t.mutation(internal.identityAuth.redeemFeishuSessionTicketInternal, {
      ticketHash,
    });
    const persisted = await t.run(async (ctx) => {
      const attempt = await ctx.db
        .query("identityAuthAttempts")
        .withIndex("by_state_hash", (q) => q.eq("stateHash", stateHash))
        .unique();
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "feishu").eq("providerAccountId", PROVIDER_ACCOUNT_ID),
        )
        .unique();
      const ticketRecord = await ctx.db
        .query("identityAuthTickets")
        .withIndex("by_ticket_hash", (q) => q.eq("ticketHash", ticketHash))
        .unique();
      const employee = await ctx.db
        .query("employeeDirectory")
        .withIndex("by_email", (q) => q.eq("email", EMPLOYEE_EMAIL))
        .unique();
      const traces = await ctx.db
        .query("authTraceEvents")
        .withIndex("by_trace_id", (q) => q.eq("traceId", attempt?.traceId ?? ""))
        .collect();
      return { attempt, account, ticketRecord, traces, employee, user: await ctx.db.get(userId) };
    });

    expect(completionUrl.pathname).toBe("/auth/feishu");
    expect(fragment.get("next")).toBe("/dashboard");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(persisted.attempt?.status).toBe("completed");
    expect(persisted.account).toMatchObject({ userId, provider: "feishu" });
    expect(persisted.user).toMatchObject({
      email: EMPLOYEE_EMAIL,
      role: "user",
      enterpriseIdentityVerifiedAt: expect.any(Number),
    });
    expect(persisted.employee).toMatchObject({ userId, valid: true, role: "user" });
    expect(persisted.ticketRecord?.usedAt).toEqual(expect.any(Number));
    expect(persisted.traces.map((trace) => trace.stage)).toEqual([
      "oauth_started",
      "oauth_callback_received",
      "token_exchange_finished",
      "profile_validated",
      "identity_bound",
      "session_created",
    ]);
    expect(JSON.stringify(persisted.traces)).not.toContain(ticket);
    expect(JSON.stringify(persisted.traces)).not.toContain(PROVIDER_ACCOUNT_ID);
  });

  it("fails closed for a disabled employee without creating a user, account, or ticket", async () => {
    const t = convexTest(schema, modules);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, access_token: "access-token-fixture" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { open_id: PROVIDER_ACCOUNT_ID, email: EMPLOYEE_EMAIL },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await t.run(async (ctx) => {
      await ctx.db.insert("employeeDirectory", {
        email: EMPLOYEE_EMAIL,
        valid: false,
        role: "user",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const started = await t.mutation(api.identityAuth.beginFeishuAuthorization, {
      intent: "sign_in",
      redirectTo: "/dashboard",
    });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) throw new Error("Test setup did not receive an OAuth state");
    const completed = await t.action(internal.identityAuth.completeFeishuOAuthCallbackInternal, {
      state,
      code: "authorization-code-fixture",
    });
    if (!completed.completionUrl) throw new Error("Test setup did not receive a completion URL");
    const fragment = new URLSearchParams(new URL(completed.completionUrl).hash.slice(1));
    const stateHash = await hashToken(state);

    const persisted = await t.run(async (ctx) => {
      const attempt = await ctx.db
        .query("identityAuthAttempts")
        .withIndex("by_state_hash", (q) => q.eq("stateHash", stateHash))
        .unique();
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "feishu").eq("providerAccountId", PROVIDER_ACCOUNT_ID),
        )
        .unique();
      const tickets = await ctx.db.query("identityAuthTickets").collect();
      const users = await ctx.db.query("users").collect();
      return { attempt, account, tickets, users };
    });

    expect(fragment.get("ticket")).toBeNull();
    expect(fragment.get("status")).toBe("failed");
    expect(persisted.attempt?.status).toBe("rejected");
    expect(persisted.account).toBeNull();
    expect(persisted.tickets).toEqual([]);
    expect(persisted.users).toEqual([]);
  });

  it("does not let an existing Feishu credential attach a second employee record to one user", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const stateHash = "state-hash";

    const setup = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: OTHER_EMPLOYEE_EMAIL,
        role: "user",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("employeeDirectory", {
        email: OTHER_EMPLOYEE_EMAIL,
        valid: true,
        role: "user",
        userId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("employeeDirectory", {
        email: EMPLOYEE_EMAIL,
        valid: true,
        role: "user",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("authAccounts", {
        userId,
        provider: "feishu",
        providerAccountId: PROVIDER_ACCOUNT_ID,
      });
      await ctx.db.insert("identityAuthAttempts", {
        stateHash,
        traceId: "auth_123e4567-e89b-42d3-a456-426614174000",
        purpose: "sign_in",
        redirectTo: "/dashboard",
        status: "processing",
        createdAt: now,
        expiresAt: now + 60_000,
      });
      return { userId };
    });

    await expect(
      t.mutation(internal.identityAuth.completeFeishuIdentityInternal, {
        stateHash,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        employeeEmail: EMPLOYEE_EMAIL,
        ticketHash: "ticket-hash",
      }),
    ).resolves.toMatchObject({
      ok: false,
      redirectTo: "/dashboard",
      reasonCode: "identity_conflict",
    });

    const persisted = await t.run(async (ctx) => {
      const employee = await ctx.db
        .query("employeeDirectory")
        .withIndex("by_email", (q) => q.eq("email", EMPLOYEE_EMAIL))
        .unique();
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "feishu").eq("providerAccountId", PROVIDER_ACCOUNT_ID),
        )
        .unique();
      const attempt = await ctx.db
        .query("identityAuthAttempts")
        .withIndex("by_state_hash", (q) => q.eq("stateHash", stateHash))
        .unique();
      return {
        account,
        attempt,
        employee,
        tickets: await ctx.db.query("identityAuthTickets").collect(),
      };
    });

    expect(persisted.employee?.userId).toBeUndefined();
    expect(persisted.account?.userId).toBe(setup.userId);
    expect(persisted.attempt?.status).toBe("rejected");
    expect(persisted.tickets).toEqual([]);
  });
});
