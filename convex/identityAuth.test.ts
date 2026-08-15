import { describe, expect, it, vi } from "vitest";

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

import { completeFeishuIdentityInternal } from "./identityAuth";

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
