import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../../convex/_generated/api";
import {
  clearGitHubIdentityLinkSecret,
  readGitHubIdentityLinkSecret,
} from "../../lib/identityLink";

export const Route = createFileRoute("/auth/github-link")({ component: GitHubIdentityLink });

function GitHubIdentityLink() {
  const { signIn, signOut } = useAuthActions();
  const redeemGitHubLink = useMutation(api.identityAuth.redeemGitHubLink);
  const [message, setMessage] = useState("Linking GitHub identity…");

  useEffect(() => {
    const secret = readGitHubIdentityLinkSecret();
    if (!secret) {
      setMessage("This identity-link request has expired. Start again from your verified account.");
      return;
    }

    void redeemGitHubLink({ secret })
      .then(async ({ redirectTo }) => {
        clearGitHubIdentityLinkSecret();
        await signOut().catch(() => undefined);
        await signIn("github", { redirectTo });
      })
      .catch(() => {
        clearGitHubIdentityLinkSecret();
        setMessage("GitHub could not be linked. Start again from your verified account.");
      });
  }, [redeemGitHubLink, signIn, signOut]);

  return (
    <main className="section">
      <p role="status">{message}</p>
    </main>
  );
}
