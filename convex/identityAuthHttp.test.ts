import { describe, expect, it, vi } from "vitest";

const { completeCallbackRef, rejectCallbackRef } = vi.hoisted(() => ({
  completeCallbackRef: Symbol("completeFeishuOAuthCallbackInternal"),
  rejectCallbackRef: Symbol("rejectFeishuOAuthCallbackInternal"),
}));

vi.mock("./_generated/api", () => ({
  internal: {
    identityAuth: {
      completeFeishuOAuthCallbackInternal: completeCallbackRef,
      rejectFeishuOAuthCallbackInternal: rejectCallbackRef,
    },
  },
}));

vi.mock("./functions", () => ({
  httpAction: (handler: unknown) => ({ _handler: handler }),
}));

import { feishuOAuthCallbackHttp } from "./identityAuthHttp";

type CallbackHandler = {
  _handler: (ctx: { runAction: ReturnType<typeof vi.fn> }, request: Request) => Promise<Response>;
};

const handler = (feishuOAuthCallbackHttp as unknown as CallbackHandler)._handler;

describe("M2 Feishu HTTP callback", () => {
  it("rejects a callback without state before it invokes the backend", async () => {
    const ctx = { runAction: vi.fn() };

    const response = await handler(
      ctx,
      new Request("https://convex.example.test/api/m2-auth/feishu/callback"),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid sign-in callback.");
    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("sends a denied callback to the terminal rejection action", async () => {
    const ctx = {
      runAction: vi.fn().mockResolvedValue({
        completionUrl: "https://skillhub.example.test/auth/feishu#status=failed",
      }),
    };

    const response = await handler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/feishu/callback?state=state-fixture&error=access_denied",
      ),
    );

    expect(ctx.runAction).toHaveBeenCalledWith(rejectCallbackRef, {
      state: "state-fixture",
      reasonCode: "oauth_access_denied",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://skillhub.example.test/auth/feishu#status=failed",
    );
  });

  it("passes an authorization code only to the server-side completion action", async () => {
    const ctx = {
      runAction: vi.fn().mockResolvedValue({
        completionUrl: "https://skillhub.example.test/auth/feishu#ticket=opaque-ticket",
      }),
    };

    const response = await handler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/feishu/callback?state=state-fixture&code=code-fixture",
      ),
    );

    expect(ctx.runAction).toHaveBeenCalledWith(completeCallbackRef, {
      state: "state-fixture",
      code: "code-fixture",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toContain("code-fixture");
  });

  it("fails closed when the backend reports Feishu is unavailable", async () => {
    const ctx = { runAction: vi.fn().mockResolvedValue({ completionUrl: null }) };

    const response = await handler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/feishu/callback?state=state-fixture&code=code-fixture",
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Sign in is not available.");
  });
});
