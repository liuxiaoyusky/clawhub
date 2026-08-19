/* @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: (path: string) => (config: { component: unknown }) => ({
    ...config,
    path,
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const { GitHubIdentityLink, Route } = await import("./github-link");

describe("GitHubIdentityLink", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/auth/github-link");
  });

  it("clears the callback fragment and offers Dashboard after success", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth/github-link#status=success&trace=trace-123&next=%2Fdashboard",
    );

    render(<GitHubIdentityLink />);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("GitHub identity linked successfully.");
    });

    expect(window.location.hash).toBe("");
    expect(screen.getByRole("link", { name: "Return to Dashboard" }).getAttribute("href")).toBe(
      "/dashboard",
    );
  });

  it("clears the callback fragment and gives a generic retry prompt after failure", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth/github-link#status=failed&trace=trace-456&next=%2Fdashboard",
    );

    render(<GitHubIdentityLink />);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(
        "GitHub identity could not be linked. Please start again from your verified account.",
      );
    });

    expect(window.location.hash).toBe("");
    expect(screen.queryByRole("link", { name: "Return to Dashboard" })).toBeNull();
  });

  it("keeps the callback route stable", () => {
    expect(Route.path).toBe("/auth/github-link");
  });
});
