/* @vitest-environment node */

import { describe, expect, it } from "vitest";
import {
  buildFeishuAuthorizationUrl,
  buildFrontendFeishuCallbackUrl,
  buildFrontendGitHubLinkCallbackUrl,
  buildGitHubIdentityLinkAuthorizationUrl,
  getEmployeeDirectoryBootstrapAdminEmail,
  getFeishuAuthRuntimeConfig,
  getGitHubIdentityLinkRuntimeConfig,
  isEmployeeDirectoryEnabled,
  isFeishuAuthEnabled,
} from "./m2AuthConfig";

const ENV = {
  AUTH_FEISHU_ENABLED: "1",
  AUTH_FEISHU_APP_ID: "cli_fixture",
  AUTH_FEISHU_APP_SECRET: "fixture-secret",
  AUTH_EMPLOYEE_DIRECTORY_ENABLED: "1",
  AUTH_EMPLOYEE_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
  AUTH_GITHUB_ID: "github-fixture",
  AUTH_GITHUB_SECRET: "github-fixture-secret",
  CONVEX_SITE_URL: "https://convex.example.test",
  SITE_URL: "https://skillhub.example.test",
};

describe("M2 Feishu auth configuration", () => {
  it("fails closed until every required value is present and valid", () => {
    expect(getFeishuAuthRuntimeConfig({ ...ENV, AUTH_FEISHU_ENABLED: "0" })).toBeNull();
    expect(getFeishuAuthRuntimeConfig({ ...ENV, AUTH_FEISHU_APP_SECRET: "" })).toBeNull();
    expect(
      getFeishuAuthRuntimeConfig({ ...ENV, CONVEX_SITE_URL: "javascript:alert(1)" }),
    ).toBeNull();
    expect(getFeishuAuthRuntimeConfig({ ...ENV, SITE_URL: "not-a-url" })).toBeNull();
  });

  it("derives fixed callback endpoints from the configured sites", () => {
    expect(getFeishuAuthRuntimeConfig(ENV)).toMatchObject({
      appId: "cli_fixture",
      callbackUrl: "https://convex.example.test/api/m2-auth/feishu/callback",
      frontendUrl: "https://skillhub.example.test/",
    });
    expect(isEmployeeDirectoryEnabled(ENV)).toBe(true);
    expect(isFeishuAuthEnabled(ENV)).toBe(true);
    expect(getEmployeeDirectoryBootstrapAdminEmail(ENV)).toBe("admin@example.test");
    expect(getGitHubIdentityLinkRuntimeConfig(ENV)).toMatchObject({
      clientId: "github-fixture",
      callbackUrl: "https://convex.example.test/api/m2-auth/github/callback",
      frontendUrl: "https://skillhub.example.test/",
    });
  });

  it("requires the employee directory gate before exposing Feishu or GitHub linking", () => {
    const disabled = { ...ENV, AUTH_EMPLOYEE_DIRECTORY_ENABLED: "0" };
    expect(isFeishuAuthEnabled(disabled)).toBe(false);
    expect(getGitHubIdentityLinkRuntimeConfig(disabled)).toBeNull();
  });

  it("keeps credentials out of browser redirects and uses a fragment for the ticket", () => {
    const config = getFeishuAuthRuntimeConfig(ENV);
    if (!config) throw new Error("Expected fixture configuration");

    const authorizationUrl = new URL(buildFeishuAuthorizationUrl(config, "a".repeat(64)));
    expect(authorizationUrl.origin).toBe("https://accounts.feishu.cn");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("cli_fixture");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(authorizationUrl.toString()).not.toContain("fixture-secret");

    const completionUrl = new URL(
      buildFrontendFeishuCallbackUrl({
        config,
        traceId: "auth_123e4567-e89b-42d3-a456-426614174000",
        redirectTo: "/skills?q=padel",
        ticket: "b".repeat(64),
      }),
    );
    expect(completionUrl.search).toBe("");
    const fragment = new URLSearchParams(completionUrl.hash.slice(1));
    expect(fragment.get("ticket")).toBe("b".repeat(64));
    expect(fragment.get("trace")).toMatch(/^auth_/);
    expect(fragment.get("next")).toBe("/skills?q=padel");
    expect(completionUrl.toString()).not.toContain("fixture-secret");
  });

  it("uses the dedicated server callback for GitHub binding and a fragment-only result", () => {
    const config = getGitHubIdentityLinkRuntimeConfig(ENV);
    if (!config) throw new Error("Expected fixture configuration");

    const authorizationUrl = new URL(
      buildGitHubIdentityLinkAuthorizationUrl(config, "c".repeat(64)),
    );
    expect(authorizationUrl.origin).toBe("https://github.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(config.callbackUrl);
    expect(authorizationUrl.searchParams.get("scope")).toBe("read:user");
    expect(authorizationUrl.toString()).not.toContain("github-fixture-secret");

    const completionUrl = new URL(
      buildFrontendGitHubLinkCallbackUrl({
        config,
        traceId: "auth_123e4567-e89b-42d3-a456-426614174000",
        success: true,
      }),
    );
    expect(completionUrl.search).toBe("");
    const fragment = new URLSearchParams(completionUrl.hash.slice(1));
    expect(fragment.get("status")).toBe("success");
    expect(fragment.get("next")).toBe("/dashboard");
    expect(completionUrl.toString()).not.toContain("github-fixture-secret");
  });
});
