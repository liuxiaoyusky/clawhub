import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";

const { convexAuthMock, credentialsProviderMock } = vi.hoisted(() => ({
  convexAuthMock: vi.fn(() => ({
    auth: {},
    signIn: {},
    signOut: {},
    store: {},
    isAuthenticated: {},
  })),
  credentialsProviderMock: vi.fn((options: unknown) => options),
}));

vi.mock("@convex-dev/auth/server", async () => {
  const actual =
    await vi.importActual<typeof import("@convex-dev/auth/server")>("@convex-dev/auth/server");
  return {
    ...actual,
    convexAuth: convexAuthMock,
  };
});

vi.mock("@convex-dev/auth/providers/ConvexCredentials", () => ({
  ConvexCredentials: credentialsProviderMock,
}));

type CapturedCredentialsProvider = {
  id: string;
  authorize?: (credentials: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
};

type CapturedAuthConfig = {
  providers?: CapturedCredentialsProvider[];
  callbacks?: {
    createOrUpdateUser?: (
      ctx: unknown,
      args: {
        existingUserId: Id<"users"> | null;
        provider: {
          id?: string;
          type: string;
          allowDangerousEmailAccountLinking?: boolean;
        };
        profile: Record<string, unknown> & {
          email?: string;
          phone?: string;
          emailVerified?: boolean;
          phoneVerified?: boolean;
        };
      },
    ) => Promise<Id<"users">>;
    beforeSessionCreation?: (ctx: unknown, args: { userId: Id<"users"> }) => Promise<void> | void;
  };
};

function getCapturedAuthConfig() {
  const calls = convexAuthMock.mock.calls as unknown as Array<[CapturedAuthConfig]>;
  const config = calls[0]?.[0];
  if (!config) throw new Error("convexAuth was not called");
  return config;
}

function getCredentialsAuthorize(config: CapturedAuthConfig, id: string) {
  const provider = config.providers?.find((candidate) => candidate.id === id);
  if (!provider?.authorize) throw new Error(`Missing ${id} credentials provider`);
  return provider.authorize;
}

function makeAuthCtx(
  user: { _id: Id<"users">; deletedAt?: number; deactivatedAt?: number },
  employee?: { email: string; valid: boolean; role: "admin" | "user" } | null,
) {
  const userId = user._id;
  const collect = vi.fn().mockResolvedValue([{ action: "user.ban" }]);
  const ctx = {
    db: {
      get: vi.fn().mockResolvedValue(user),
      patch: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue(userId),
      query: vi.fn((table: string) => {
        if (table === "employeeDirectory") {
          return {
            withIndex: vi.fn().mockReturnValue({ unique: vi.fn().mockResolvedValue(employee) }),
          };
        }
        return { withIndex: vi.fn().mockReturnValue({ collect }) };
      }),
    },
    scheduler: {
      runAfter: vi.fn().mockResolvedValue(null),
    },
  };
  return { ctx, userId };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth callbacks", () => {
  it("defers banned account rejection until session creation", async () => {
    await import("./auth");
    const config = getCapturedAuthConfig();
    const { ctx, userId } = makeAuthCtx({ _id: "users:banned" as Id<"users">, deletedAt: 123 });

    await expect(
      config.callbacks?.createOrUpdateUser?.(ctx, {
        existingUserId: userId,
        provider: { type: "oauth", allowDangerousEmailAccountLinking: false },
        profile: {
          id: "123",
          name: "renamed-banned-user",
          email: "banned@example.com",
          image: "https://example.com/avatar.png",
        },
      }),
    ).resolves.toBe(userId);

    await expect(config.callbacks?.beforeSessionCreation?.(ctx, { userId })).rejects.toThrow(
      /account has been banned/i,
    );

    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(ctx.db.insert).not.toHaveBeenCalled();
  });

  it("updates active existing users and schedules post-update side effects", async () => {
    await import("./auth");
    const config = getCapturedAuthConfig();
    const { ctx, userId } = makeAuthCtx({ _id: "users:active" as Id<"users"> });

    await expect(
      config.callbacks?.createOrUpdateUser?.(ctx, {
        existingUserId: userId,
        provider: { type: "oauth", allowDangerousEmailAccountLinking: false },
        profile: {
          id: "123",
          name: "active-user",
          email: "active@example.com",
          image: "https://example.com/avatar.png",
        },
      }),
    ).resolves.toBe(userId);

    expect(ctx.db.patch).toHaveBeenCalledWith(userId, {
      id: "123",
      name: "active-user",
      email: "active@example.com",
      image: "https://example.com/avatar.png",
    });
    expect(ctx.scheduler.runAfter).toHaveBeenCalled();
  });

  it("rejects an unbound GitHub account before it can create a local user in M2", async () => {
    vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
    await import("./auth");
    const config = getCapturedAuthConfig();
    const { ctx } = makeAuthCtx({ _id: "users:unused" as Id<"users"> });

    await expect(
      config.callbacks?.createOrUpdateUser?.(ctx, {
        existingUserId: null,
        provider: { id: "github", type: "oauth", allowDangerousEmailAccountLinking: false },
        profile: { id: "123", name: "unbound-user", email: "untrusted@example.com" },
      }),
    ).rejects.toThrow("Sign in failed. Please try again.");

    expect(ctx.db.insert).not.toHaveBeenCalledWith("users", expect.anything());
    expect(ctx.db.patch).not.toHaveBeenCalled();
    expect(ctx.db.insert).toHaveBeenCalledWith(
      "authTraceEvents",
      expect.objectContaining({
        provider: "github",
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "identity_binding_failed",
      }),
    );
    const traceCall = ctx.db.insert.mock.calls.find(([table]) => table === "authTraceEvents");
    const trace = traceCall?.[1] as Record<string, unknown> | undefined;
    expect(trace).toBeDefined();
    expect(trace?.traceId).toMatch(
      /^auth_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(trace?.expiresAt).toBe((trace?.occurredAt as number) + 7 * 24 * 60 * 60 * 1_000);
    expect(Object.keys(trace ?? {}).sort()).toEqual(
      ["expiresAt", "occurredAt", "outcome", "provider", "reasonCode", "stage", "traceId"].sort(),
    );
    expect(JSON.stringify(trace)).not.toContain("untrusted@example.com");
    expect(JSON.stringify(trace)).not.toContain("unbound-user");
    expect(trace).not.toHaveProperty("email");
    expect(trace).not.toHaveProperty("name");
    expect(trace).not.toHaveProperty("id");
    expect(trace).not.toHaveProperty("code");
    expect(trace).not.toHaveProperty("token");
    expect(trace).not.toHaveProperty("url");
    expect(trace).not.toHaveProperty("providerAccountId");
  });

  it("uses the active employee record to project role and email for an explicitly bound GitHub account", async () => {
    vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
    await import("./auth");
    const config = getCapturedAuthConfig();
    const { ctx, userId } = makeAuthCtx(
      { _id: "users:active" as Id<"users"> },
      { email: "employee@example.test", valid: true, role: "user" },
    );

    await expect(
      config.callbacks?.createOrUpdateUser?.(ctx, {
        existingUserId: userId,
        provider: { id: "github", type: "oauth", allowDangerousEmailAccountLinking: false },
        profile: {
          id: "123",
          name: "github-display-name",
          email: "untrusted@example.com",
          image: "https://example.com/avatar.png",
        },
      }),
    ).resolves.toBe(userId);

    expect(ctx.db.patch).toHaveBeenCalledWith(userId, {
      id: "123",
      name: "github-display-name",
      image: "https://example.com/avatar.png",
      email: "employee@example.test",
      emailVerificationTime: undefined,
      role: "user",
      updatedAt: expect.any(Number),
    });
    expect(ctx.db.insert).toHaveBeenCalledWith(
      "authTraceEvents",
      expect.objectContaining({
        provider: "github",
        stage: "profile_validated",
        outcome: "success",
      }),
    );
    const traceCall = ctx.db.insert.mock.calls.find(([table]) => table === "authTraceEvents");
    const trace = traceCall?.[1] as Record<string, unknown> | undefined;
    expect(trace).toBeDefined();
    expect(trace?.traceId).toMatch(
      /^auth_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(trace?.expiresAt).toBe((trace?.occurredAt as number) + 7 * 24 * 60 * 60 * 1_000);
    expect(Object.keys(trace ?? {}).sort()).toEqual(
      ["expiresAt", "occurredAt", "outcome", "provider", "stage", "traceId"].sort(),
    );
    const serializedTrace = JSON.stringify(trace);
    expect(serializedTrace).not.toContain("untrusted@example.com");
    expect(serializedTrace).not.toContain("github-display-name");
    expect(serializedTrace).not.toContain("https://example.com/avatar.png");
    expect(trace).not.toHaveProperty("email");
    expect(trace).not.toHaveProperty("name");
    expect(trace).not.toHaveProperty("image");
    expect(trace).not.toHaveProperty("id");
    expect(trace).not.toHaveProperty("code");
    expect(trace).not.toHaveProperty("token");
    expect(trace).not.toHaveProperty("url");
    expect(trace).not.toHaveProperty("providerAccountId");
  });

  it("blocks new sessions for a disabled employee without revoking an already-created session", async () => {
    vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
    await import("./auth");
    const config = getCapturedAuthConfig();
    const { ctx, userId } = makeAuthCtx(
      { _id: "users:disabled" as Id<"users"> },
      { email: "disabled@example.test", valid: false, role: "user" },
    );

    await expect(config.callbacks?.beforeSessionCreation?.(ctx, { userId })).rejects.toThrow(
      "Sign in failed. Please try again.",
    );
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });

  it("does not allow a local dev persona to create an M2 session", async () => {
    vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
    vi.stubEnv("DEV_AUTH_ENABLED", "1");
    vi.stubEnv("CONVEX_DEPLOYMENT", "local:clawhub");
    vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3210");
    await import("./auth");
    const authorize = getCredentialsAuthorize(getCapturedAuthConfig(), "dev-persona");
    const ctx = { runMutation: vi.fn() };

    await expect(authorize({ persona: "admin" }, ctx)).rejects.toThrow(
      "Dev auth is unavailable while M2 employee identity is enabled",
    );
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
});
