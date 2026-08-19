import { describe, expect, it, vi } from "vitest";

const {
  completeCallbackRef,
  completeGitHubCallbackRef,
  rejectCallbackRef,
  rejectGitHubCallbackRef,
} = vi.hoisted(() => ({
  completeCallbackRef: Symbol("completeFeishuOAuthCallbackInternal"),
  completeGitHubCallbackRef: Symbol("completeGitHubLinkOAuthCallbackInternal"),
  rejectCallbackRef: Symbol("rejectFeishuOAuthCallbackInternal"),
  rejectGitHubCallbackRef: Symbol("rejectGitHubLinkOAuthCallbackInternal"),
}));

vi.mock("./_generated/api", () => ({
  internal: {
    identityAuth: {
      completeFeishuOAuthCallbackInternal: completeCallbackRef,
      completeGitHubLinkOAuthCallbackInternal: completeGitHubCallbackRef,
      rejectFeishuOAuthCallbackInternal: rejectCallbackRef,
      rejectGitHubLinkOAuthCallbackInternal: rejectGitHubCallbackRef,
    },
  },
}));

vi.mock("./functions", () => ({
  httpAction: (handler: unknown) => ({ _handler: handler }),
}));

import { feishuOAuthCallbackHttp, githubOAuthLinkCallbackHttp } from "./identityAuthHttp";

type CallbackHandler = {
  _handler: (ctx: { runAction: ReturnType<typeof vi.fn> }, request: Request) => Promise<Response>;
};

const handler = (feishuOAuthCallbackHttp as unknown as CallbackHandler)._handler;
const githubHandler = (githubOAuthLinkCallbackHttp as unknown as CallbackHandler)._handler;

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

describe("M2 GitHub link HTTP callback", () => {
  it("rejects a callback without state before it invokes the backend", async () => {
    const ctx = { runAction: vi.fn() };

    const response = await githubHandler(
      ctx,
      new Request("https://convex.example.test/api/m2-auth/github/callback"),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid sign-in callback.");
    expect(ctx.runAction).not.toHaveBeenCalled();
  });

  it("sends a denied callback to the terminal rejection action", async () => {
    const ctx = {
      runAction: vi.fn().mockResolvedValue({
        completionUrl: "https://skillhub.example.test/auth/github-link#status=failed",
      }),
    };

    const response = await githubHandler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/github/callback?state=state-fixture&error=access_denied",
      ),
    );

    expect(ctx.runAction).toHaveBeenCalledWith(rejectGitHubCallbackRef, {
      state: "state-fixture",
      reasonCode: "oauth_access_denied",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://skillhub.example.test/auth/github-link#status=failed",
    );
  });

  it("passes a GitHub code only to the server-side completion action", async () => {
    const ctx = {
      runAction: vi.fn().mockResolvedValue({
        completionUrl: "https://skillhub.example.test/auth/github-link#status=success",
      }),
    };

    const response = await githubHandler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/github/callback?state=state-fixture&code=code-fixture",
      ),
    );

    expect(ctx.runAction).toHaveBeenCalledWith(completeGitHubCallbackRef, {
      state: "state-fixture",
      code: "code-fixture",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).not.toContain("code-fixture");
  });

  it("fails closed when the GitHub-link backend is unavailable", async () => {
    const ctx = { runAction: vi.fn().mockResolvedValue({ completionUrl: null }) };

    const response = await githubHandler(
      ctx,
      new Request(
        "https://convex.example.test/api/m2-auth/github/callback?state=state-fixture&code=code-fixture",
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Sign in is not available.");
  });
});
