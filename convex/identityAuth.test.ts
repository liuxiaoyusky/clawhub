import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensurePersonalPublisherForUserMock } = vi.hoisted(() => ({
  ensurePersonalPublisherForUserMock: vi.fn(),
}));

vi.mock("./lib/publishers", () => ({
  ensurePersonalPublisherForUser: ensurePersonalPublisherForUserMock,
}));

vi.mock("./functions", () => ({
  internalAction: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
  internalMutation: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
  mutation: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
  query: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
}));

import {
  __test as identityAuthTest,
  completeFeishuIdentityInternal,
  completeGitHubLinkIdentityInternal,
} from "./identityAuth";

const TRACE_ID = "auth_123e4567-e89b-42d3-a456-426614174000";
const PROVIDER_ACCOUNT_ID = "ou_provider_fixture";
const EMPLOYEE_EMAIL = "employee@example.test";

type Insert = { table: string; value: Record<string, unknown> };

function makeContext(args: {
  attempt: Record<string, unknown>;
  employee: Record<string, unknown> | null;
  existingAccount: Record<string, unknown> | null;
  targetUser: Record<string, unknown>;
}) {
  const inserts: Insert[] = [];
  const db = {
    query: vi.fn((table: string) => ({
      withIndex: vi.fn(() => ({
        unique: vi.fn(async () => {
          if (table === "identityAuthAttempts") return args.attempt;
          if (table === "employeeDirectory") return args.employee;
          if (table === "authAccounts") return args.existingAccount;
          throw new Error(`Unexpected query table: ${table}`);
        }),
      })),
    })),
    get: vi.fn(async () => args.targetUser),
    insert: vi.fn(async (table: string, value: Record<string, unknown>) => {
      inserts.push({ table, value });
      return `${table}:fixture`;
    }),
    patch: vi.fn(async () => undefined),
  };

  return { ctx: { db }, db, inserts };
}

type CompleteHandler = {
  _handler: (
    ctx: unknown,
    args: {
      stateHash: string;
      providerAccountId: string;
      employeeEmail: string;
      ticketHash: string;
    },
  ) => Promise<Record<string, unknown>>;
};

const completeHandler = (completeFeishuIdentityInternal as unknown as CompleteHandler)._handler;

type CompleteGitHubLinkHandler = {
  _handler: (
    ctx: unknown,
    args: { stateHash: string; providerAccountId: string },
  ) => Promise<Record<string, unknown>>;
};

const completeGitHubLinkHandler = (
  completeGitHubLinkIdentityInternal as unknown as CompleteGitHubLinkHandler
)._handler;

function makeGitHubLinkContext() {
  const inserts: Insert[] = [];
  const targetUser = {
    _id: "users:canonical",
    role: "user",
    createdAt: 1,
    updatedAt: 1,
  };
  const link = {
    _id: "identityAuthLinks:1",
    targetUserId: targetUser._id,
    traceId: TRACE_ID,
    status: "processing",
    expiresAt: Date.now() + 60_000,
  };
  const db = {
    query: vi.fn((table: string) => ({
      withIndex: vi.fn(() => ({
        unique: vi.fn(async () => {
          if (table === "identityAuthLinks") return link;
          if (table === "employeeDirectory") {
            return { email: EMPLOYEE_EMAIL, valid: true, role: "user", userId: targetUser._id };
          }
          if (table === "authAccounts") return null;
          throw new Error(`Unexpected query table: ${table}`);
        }),
      })),
    })),
    get: vi.fn(async () => targetUser),
    insert: vi.fn(async (table: string, value: Record<string, unknown>) => {
      inserts.push({ table, value });
      return `${table}:fixture`;
    }),
    patch: vi.fn(async () => undefined),
  };
  return { ctx: { db }, db, inserts };
}

beforeEach(() => {
  vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("M2 Feishu identity binding", () => {
  it("binds the provider to the existing canonical user, resets a legacy role, and writes a safe trace", async () => {
    const { ctx, db, inserts } = makeContext({
      attempt: {
        _id: "identityAuthAttempts:1",
        traceId: TRACE_ID,
        purpose: "link_existing_user",
        targetUserId: "users:canonical",
        redirectTo: "/dashboard",
        status: "processing",
        expiresAt: Date.now() + 60_000,
      },
      employee: {
        _id: "employeeDirectory:1",
        email: EMPLOYEE_EMAIL,
        valid: true,
        role: "user",
      },
      existingAccount: null,
      targetUser: {
        _id: "users:canonical",
        role: "admin",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      completeHandler(ctx, {
        stateHash: "state-hash",
        providerAccountId: PROVIDER_ACCOUNT_ID,
        employeeEmail: EMPLOYEE_EMAIL,
        ticketHash: "ticket-hash",
      }),
    ).resolves.toEqual({ ok: true, traceId: TRACE_ID, redirectTo: "/dashboard" });

    expect(db.insert).toHaveBeenCalledWith("authAccounts", {
      userId: "users:canonical",
      provider: "feishu",
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    expect(db.patch).toHaveBeenCalledWith("users:canonical", {
      email: EMPLOYEE_EMAIL,
      emailVerificationTime: undefined,
      enterpriseIdentityVerifiedAt: expect.any(Number),
      role: "user",
      updatedAt: expect.any(Number),
    });
    expect(db.patch).toHaveBeenCalledWith("employeeDirectory:1", {
      userId: "users:canonical",
      updatedAt: expect.any(Number),
    });
    expect(ensurePersonalPublisherForUserMock).not.toHaveBeenCalled();

    const trace = inserts.find((insert) => insert.table === "authTraceEvents")?.value;
    expect(trace).toMatchObject({
      traceId: TRACE_ID,
      provider: "feishu",
      stage: "identity_bound",
      outcome: "success",
    });
    expect(trace).not.toHaveProperty("providerAccountId");
    expect(JSON.stringify(trace)).not.toContain(PROVIDER_ACCOUNT_ID);
  });

  it("rejects a conflicting provider account with one non-sensitive trace", async () => {
    const { ctx, db, inserts } = makeContext({
      attempt: {
        _id: "identityAuthAttempts:1",
        traceId: TRACE_ID,
        purpose: "link_existing_user",
        targetUserId: "users:canonical",
        redirectTo: "/dashboard",
        status: "processing",
        expiresAt: Date.now() + 60_000,
      },
      employee: {
        _id: "employeeDirectory:1",
        email: EMPLOYEE_EMAIL,
        valid: true,
        role: "user",
      },
      existingAccount: { _id: "authAccounts:existing", userId: "users:someone-else" },
      targetUser: {
        _id: "users:canonical",
        role: "user",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      completeHandler(ctx, {
        stateHash: "state-hash",
        providerAccountId: PROVIDER_ACCOUNT_ID,
        employeeEmail: EMPLOYEE_EMAIL,
        ticketHash: "ticket-hash",
      }),
    ).resolves.toEqual({
      ok: false,
      traceId: TRACE_ID,
      redirectTo: "/dashboard",
      reasonCode: "identity_conflict",
    });

    expect(db.patch).toHaveBeenCalledWith("identityAuthAttempts:1", { status: "rejected" });
    expect(db.insert).not.toHaveBeenCalledWith(
      "authAccounts",
      expect.objectContaining({ providerAccountId: PROVIDER_ACCOUNT_ID }),
    );
    const traces = inserts
      .filter((insert) => insert.table === "authTraceEvents")
      .map(({ value }) => value);
    expect(traces).toEqual([
      expect.objectContaining({
        traceId: TRACE_ID,
        stage: "rejected",
        outcome: "rejected",
        reasonCode: "identity_conflict",
      }),
    ]);
    expect(JSON.stringify(traces)).not.toContain(PROVIDER_ACCOUNT_ID);
  });

  it("rejects an inactive employee before it can bind an account or issue a ticket", async () => {
    const { ctx, db, inserts } = makeContext({
      attempt: {
        _id: "identityAuthAttempts:1",
        traceId: TRACE_ID,
        redirectTo: "/dashboard",
        status: "processing",
        expiresAt: Date.now() + 60_000,
      },
      employee: {
        _id: "employeeDirectory:1",
        email: EMPLOYEE_EMAIL,
        valid: false,
        role: "user",
      },
      existingAccount: null,
      targetUser: {
        _id: "users:canonical",
        role: "user",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(
      completeHandler(ctx, {
        stateHash: "state-hash",
        providerAccountId: PROVIDER_ACCOUNT_ID,
        employeeEmail: EMPLOYEE_EMAIL,
        ticketHash: "ticket-hash",
      }),
    ).resolves.toEqual({
      ok: false,
      traceId: TRACE_ID,
      redirectTo: "/dashboard",
      reasonCode: "identity_binding_failed",
    });

    expect(db.insert).not.toHaveBeenCalledWith(
      "authAccounts",
      expect.objectContaining({ providerAccountId: PROVIDER_ACCOUNT_ID }),
    );
    expect(db.insert).not.toHaveBeenCalledWith("identityAuthTickets", expect.anything());
    expect(inserts).toEqual([
      expect.objectContaining({
        table: "authTraceEvents",
        value: expect.objectContaining({ reasonCode: "identity_binding_failed" }),
      }),
    ]);
  });
});

describe("M2 Feishu OAuth provider contract", () => {
  it("uses the documented token request and accepts a successful business response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, access_token: "access-token-fixture" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      identityAuthTest.exchangeFeishuCode({
        appId: "cli_fixture",
        appSecret: "fixture-secret",
        callbackUrl: "https://convex.example.test/api/m2-auth/feishu/callback",
        code: "authorization-code-fixture",
      }),
    ).resolves.toEqual({ ok: true, accessToken: "access-token-fixture" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: "cli_fixture",
          client_secret: "fixture-secret",
          code: "authorization-code-fixture",
          redirect_uri: "https://convex.example.test/api/m2-auth/feishu/callback",
        }),
      },
    );
  });

  it.each([
    [20002, "token_exchange_client_secret_invalid"],
    [20003, "token_exchange_authorization_code_invalid"],
    [20010, "token_exchange_user_not_authorized"],
    [20071, "token_exchange_redirect_uri_mismatch"],
    [20072, "provider_unavailable"],
  ] as const)("maps Feishu token failure %s to the safe reason %s", async (code, reasonCode) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code }), { status: code === 20072 ? 503 : 400 }),
        ),
    );

    await expect(
      identityAuthTest.exchangeFeishuCode({
        appId: "cli_fixture",
        appSecret: "fixture-secret",
        callbackUrl: "https://convex.example.test/api/m2-auth/feishu/callback",
        code: "authorization-code-fixture",
      }),
    ).resolves.toEqual({ ok: false, reasonCode });
  });

  it("records an unavailable provider without exposing the thrown error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(
      identityAuthTest.exchangeFeishuCode({
        appId: "cli_fixture",
        appSecret: "fixture-secret",
        callbackUrl: "https://convex.example.test/api/m2-auth/feishu/callback",
        code: "authorization-code-fixture",
      }),
    ).resolves.toEqual({ ok: false, reasonCode: "provider_unavailable" });
  });

  it("uses the user token only for user info and requires the directory-matching email", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            data: { open_id: "ou_provider_fixture", email: EMPLOYEE_EMAIL },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991679, msg: "Unauthorized" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      identityAuthTest.fetchFeishuIdentityProfile("access-token-fixture"),
    ).resolves.toEqual({
      providerAccountId: "ou_provider_fixture",
      employeeEmail: EMPLOYEE_EMAIL,
    });
    await expect(
      identityAuthTest.fetchFeishuProviderAccountId("access-token-fixture"),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: {
          authorization: "Bearer access-token-fixture",
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  });
});

describe("M2 GitHub identity binding", () => {
  it("binds the OAuth account directly to the existing employee user without a temporary user", async () => {
    const { ctx, db, inserts } = makeGitHubLinkContext();

    await expect(
      completeGitHubLinkHandler(ctx, {
        stateHash: "state-hash",
        providerAccountId: "123456",
      }),
    ).resolves.toEqual({ ok: true, traceId: TRACE_ID });

    expect(db.insert).toHaveBeenCalledWith("authAccounts", {
      userId: "users:canonical",
      provider: "github",
      providerAccountId: "123456",
    });
    expect(db.insert).not.toHaveBeenCalledWith("users", expect.anything());
    expect(db.patch).toHaveBeenCalledWith("users:canonical", {
      email: EMPLOYEE_EMAIL,
      emailVerificationTime: undefined,
      role: "user",
      updatedAt: expect.any(Number),
    });
    expect(db.patch).toHaveBeenCalledWith("identityAuthLinks:1", {
      status: "completed",
      usedAt: expect.any(Number),
    });
    const traces = inserts
      .filter((insert) => insert.table === "authTraceEvents")
      .map((insert) => insert.value);
    expect(JSON.stringify(traces)).not.toContain("123456");
  });

  it("uses the GitHub token only to retrieve a numeric provider id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 123456, login: "ignored-display-name" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      identityAuthTest.fetchGitHubProviderAccountId("access-token-fixture"),
    ).resolves.toBe("123456");

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer access-token-fixture",
      },
    });
  });
});
