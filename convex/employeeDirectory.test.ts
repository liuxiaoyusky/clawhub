import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(),
}));

vi.mock("./functions", () => ({
  mutation: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
  query: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
}));

vi.mock("./lib/access", () => ({
  requireUser: requireUserMock,
}));

import { upsert } from "./employeeDirectory";

type UpsertHandler = {
  _handler: (
    ctx: unknown,
    args: { email: string; valid: boolean; role: "admin" | "user" },
  ) => Promise<Record<string, unknown>>;
};

const upsertHandler = (upsert as unknown as UpsertHandler)._handler;

function makeContext(args: {
  actorEmployee: Record<string, unknown> | null;
  targetEmployee: Record<string, unknown> | null;
  linkedUser?: Record<string, unknown> | null;
}) {
  let employeeLookup = 0;
  const db = {
    query: vi.fn((table: string) => {
      if (table !== "employeeDirectory") throw new Error(`Unexpected query table: ${table}`);
      const result = employeeLookup++ === 0 ? args.actorEmployee : args.targetEmployee;
      return { withIndex: vi.fn().mockReturnValue({ unique: vi.fn().mockResolvedValue(result) }) };
    }),
    get: vi.fn().mockResolvedValue(args.linkedUser ?? null),
    insert: vi.fn().mockResolvedValue("employeeDirectory:new"),
    patch: vi.fn().mockResolvedValue(null),
  };
  return { ctx: { db }, db };
}

beforeEach(() => {
  vi.stubEnv("AUTH_EMPLOYEE_DIRECTORY_ENABLED", "1");
  vi.stubEnv("AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL", "admin@example.test");
  requireUserMock.mockResolvedValue({ user: { _id: "users:admin" } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  requireUserMock.mockReset();
});

describe("employee directory control plane", () => {
  it("updates local validity and synchronizes the legacy user projection", async () => {
    const { ctx, db } = makeContext({
      actorEmployee: {
        _id: "employeeDirectory:admin",
        userId: "users:admin",
        valid: true,
        role: "admin",
      },
      targetEmployee: {
        _id: "employeeDirectory:target",
        userId: "users:target",
        email: "member@example.test",
        valid: true,
        role: "user",
      },
      linkedUser: { _id: "users:target" },
    });

    await expect(
      upsertHandler(ctx, { email: " Member@Example.Test ", valid: false, role: "user" }),
    ).resolves.toEqual({ employeeId: "employeeDirectory:target", valid: false, role: "user" });

    expect(db.patch).toHaveBeenCalledWith("employeeDirectory:target", {
      valid: false,
      role: "user",
      updatedAt: expect.any(Number),
    });
    expect(db.patch).toHaveBeenCalledWith("users:target", {
      email: "member@example.test",
      role: "user",
      updatedAt: expect.any(Number),
    });
  });

  it("does not let a local administrator promote any email other than the configured admin", async () => {
    const { ctx, db } = makeContext({
      actorEmployee: {
        _id: "employeeDirectory:admin",
        userId: "users:admin",
        valid: true,
        role: "admin",
      },
      targetEmployee: null,
    });

    await expect(
      upsertHandler(ctx, { email: "member@example.test", valid: true, role: "admin" }),
    ).rejects.toThrow("Only the configured employee admin may have the admin role.");

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.patch).not.toHaveBeenCalled();
  });

  it("requires the caller to be an active directory administrator", async () => {
    const { ctx } = makeContext({
      actorEmployee: {
        _id: "employeeDirectory:user",
        userId: "users:admin",
        valid: true,
        role: "user",
      },
      targetEmployee: null,
    });

    await expect(
      upsertHandler(ctx, { email: "member@example.test", valid: true, role: "user" }),
    ).rejects.toThrow("Forbidden");
  });
});
