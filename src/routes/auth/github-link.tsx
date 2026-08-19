import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/auth/github-link")({ component: GitHubIdentityLink });

export function GitHubIdentityLink() {
  const [status, setStatus] = useState<"pending" | "success" | "failed">("pending");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const result = fragment.get("status");

    window.history.replaceState(null, "", window.location.pathname);
    setStatus(result === "success" ? "success" : "failed");
  }, []);

  const message =
    status === "pending"
      ? "Completing GitHub identity link…"
      : status === "success"
        ? "GitHub identity linked successfully."
        : "GitHub identity could not be linked. Please start again from your verified account.";

  return (
    <main className="section">
      <p role="status">{message}</p>
      {status === "success" ? <Link to="/dashboard">Return to Dashboard</Link> : null}
    </main>
  );
}
