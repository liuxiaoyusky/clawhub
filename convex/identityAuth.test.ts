import { afterEach, describe, expect, it, vi } from "vitest";

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

import { __test as identityAuthTest, completeFeishuIdentityInternal } from "./identityAuth";

const TRACE_ID = "auth_123e4567-e89b-42d3-a456-426614174000";
const PROVIDER_ACCOUNT_ID = "ou_provider_fixture";

type Insert = { table: string; value: Record<string, unknown> };

function makeContext(args: {
  attempt: Record<string, unknown>;
  existingAccount: Record<string, unknown> | null;
  targetUser: Record<string, unknown>;
}) {
  const inserts: Insert[] = [];
  const db = {
    query: vi.fn((table: string) => ({
      withIndex: vi.fn(() => ({
        unique: vi.fn(async () => {
          if (table === "identityAuthAttempts") return args.attempt;
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
    args: { stateHash: string; providerAccountId: string; ticketHash: string },
  ) => Promise<Record<string, unknown>>;
};

const completeHandler = (completeFeishuIdentityInternal as unknown as CompleteHandler)._handler;

afterEach(() => {
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
        ticketHash: "ticket-hash",
      }),
    ).resolves.toEqual({ ok: true, traceId: TRACE_ID, redirectTo: "/dashboard" });

    expect(db.insert).toHaveBeenCalledWith("authAccounts", {
      userId: "users:canonical",
      provider: "feishu",
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    expect(db.patch).toHaveBeenCalledWith("users:canonical", {
      enterpriseIdentityVerifiedAt: expect.any(Number),
      role: "user",
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

  it("uses the user token only for user info and rejects a nonzero business code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, data: { open_id: "ou_provider_fixture" } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991679, msg: "Unauthorized" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      identityAuthTest.fetchFeishuProviderAccountId("access-token-fixture"),
    ).resolves.toBe("ou_provider_fixture");
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
